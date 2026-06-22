import type { Database } from "bun:sqlite";
import type { ParserProvider } from "./parserTypes";
import {
  ParserRunStatus,
  ReviewState,
  SyncState,
  type ParseResult,
} from "./types";
import {
  validateParseResult,
  determineInitialReviewState,
  checkReadiness,
  type ReadinessResult,
} from "./parserValidator";
import {
  initDraftsTable,
  upsertDraft,
  getDraftBySlipId,
  getDraft,
  updateDraftField,
  deleteDraftBySlipId,
  type DraftInput,
} from "../db/drafts";
import {
  initParserRunsTable,
  insertParserRun,
} from "../db/parserRuns";

/**
 * Result of a parse operation.
 */
export interface ParseDraftResult {
  /** The created/updated draft, or null if total failure */
  draft: {
    id: number;
    slipId: number;
    reviewState: ReviewState;
    duplicateRisk: boolean;
    hasUncertainty: boolean;
  } | null;
  /** Whether this was a meaningful parse that produced a draft */
  isMeaningful: boolean;
  /** Whether an existing draft was preserved (not overwritten) */
  preserved: boolean;
  /** Parser run id */
  parserRunId: number;
  /** Human-readable message */
  message: string;
}

/** States where a draft is considered "user-owned" — parser retry
 * must never overwrite these.
 * Only Parsed (auto-parsed, never touched by human) is parser-owned.
 */
const USER_OWNED_STATES = new Set([
  ReviewState.NeedsReview,
  ReviewState.Ready,
  ReviewState.Approved,
]);

/**
 * Check for duplicate risk:
 * 1. From the slips table (scan-level duplicate detection)
 * 2. From another draft with same content_hash but different source path
 */
function detectDuplicateRisk(
  db: Database,
  slipId: number,
  contentHash: string | null,
  sourcePath: string,
): boolean {
  // 1. Check slip-level duplicate risk
  const slipRow = db
    .query("SELECT duplicate_risk FROM slips WHERE id = ?")
    .get(slipId) as { duplicate_risk: number } | undefined;
  if (slipRow && slipRow.duplicate_risk === 1) return true;

  // 2. Check draft-level duplicate risk (same hash, different path)
  if (!contentHash) return false;
  const existing = db
    .query(
      `SELECT source_path FROM drafts
       WHERE content_hash = ? AND source_path != ?`,
    )
    .all(contentHash, sourcePath) as { source_path: string }[];
  return existing.length > 0;
}

/**
 * Parse a slip and create/update a draft.
 *
 * The parse call (async) happens first. DB writes are wrapped in a
 * SQLite transaction for atomicity.
 *
 * Re-parse policy:
 * - If no draft exists → create one on meaningful parse
 * - If draft exists AND reviewState is still Parsed (parser-owned) → overwrite
 * - If draft exists AND reviewState is user-owned (NeedsReview/Ready/Approved)
 *   → record parser run but preserve existing draft
 * - Total failure → never creates/overwrites draft
 */
export async function parseSlipToDraftAsync(
  db: Database,
  slipId: number,
  sourcePath: string,
  contentHash: string | null,
  provider: ParserProvider,
): Promise<ParseDraftResult> {
  // Ensure tables exist
  initDraftsTable(db);
  initParserRunsTable(db);

  // 1. Call the parser provider (outside transaction — async I/O)
  let parseResult: ParseResult;
  let providerError: string | undefined;
  try {
    parseResult = await provider.parse(sourcePath);
  } catch (err) {
    providerError = err instanceof Error ? err.message : String(err);
    // Record failed run outside transaction (single write, no consistency risk)
    const run = insertParserRun(db, {
      slipId,
      provider: provider.name,
      model: provider.model,
      status: ParserRunStatus.Failed,
      rawJson: null,
      metadata: JSON.stringify({ error: providerError }),
    });
    return {
      draft: null,
      isMeaningful: false,
      preserved: false,
      parserRunId: run.id,
      message: `Parser provider error: ${providerError}`,
    };
  }

  // 2. Validate the parse result (pure, no mutation of input)
  const { parsedSlip, isMeaningful, uncertainties } = validateParseResult(
    parseResult,
    sourcePath,
    contentHash ?? "",
  );

  // 3. Determine duplicate risk (reads DB but we need it before transaction too for the check)
  const duplicateRisk = detectDuplicateRisk(
    db,
    slipId,
    contentHash,
    sourcePath,
  );

  // 4. Determine initial review state
  let reviewState = determineInitialReviewState(parsedSlip);
  if (duplicateRisk && reviewState === ReviewState.Parsed) {
    reviewState = ReviewState.NeedsReview;
  }

  // 5. Use a SQLite transaction for all DB writes
  const tx = db.transaction(() => {
    // 5a. Insert parser run (includes raw, immutable provider payload)
    const run = insertParserRun(db, {
      slipId,
      provider: provider.name,
      model: provider.model,
      status: parseResult.status,
      rawJson: JSON.stringify(parseResult),
      metadata: JSON.stringify({
        confidence: parseResult.confidence,
        uncertainties,
      }),
    });

    // 5b. If not meaningful → no draft write
    if (!isMeaningful) {
      return {
        draft: null,
        isMeaningful: false,
        preserved: false,
        parserRunId: run.id,
        message: "Parse did not produce meaningful data. No draft created.",
        _runId: run.id,
      };
    }

    // 5c. Check existing draft (inside transaction to avoid races)
    const existingDraft = getDraftBySlipId(db, slipId);

    // 5d. If draft exists and is user-owned → preserve it
    if (existingDraft) {
      const existingReviewState = existingDraft.reviewState as ReviewState;
      if (USER_OWNED_STATES.has(existingReviewState)) {
        return {
          draft: {
            id: existingDraft.id,
            slipId: existingDraft.slipId,
            reviewState: existingReviewState,
            duplicateRisk: existingDraft.duplicateRisk === 1,
            hasUncertainty: existingDraft.hasUncertainty === 1,
          },
          isMeaningful: true,
          preserved: true,
          parserRunId: run.id,
          message: `Existing draft preserved (state: ${existingReviewState}). New parse recorded as run #${run.id}.`,
          _runId: run.id,
        };
      }
    }

    // 5e. Create or update the draft
    const draftInput: DraftInput = {
      slipId,
      sourcePath,
      contentHash,
      date: parsedSlip.date,
      amount: parsedSlip.amount,
      currency: parsedSlip.currency,
      parsedCurrency: parsedSlip.parsedCurrency,
      merchant: parsedSlip.normalizedMerchant,
      parsedMerchant: parsedSlip.parsedMerchant,
      parsedCategory: parsedSlip.parsedCategory,
      sourceIdentifier: parsedSlip.sourceIdentifier,
      sourceAccountHints: JSON.stringify(parsedSlip.sourceAccountHints),
      sourceAccountName: null,
      category: null,
      reviewState,
      syncState: SyncState.Unsynced,
      duplicateRisk,
      hasUncertainty: parsedSlip.hasUncertainty,
    };

    let draftRecord;
    try {
      draftRecord = upsertDraft(db, draftInput);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        draft: null,
        isMeaningful: true,
        preserved: false,
        parserRunId: run.id,
        message: `Draft creation failed: ${errorMessage}`,
        _runId: run.id,
      };
    }

    return {
      draft: {
        id: draftRecord.id,
        slipId: draftRecord.slipId,
        reviewState: reviewState as ReviewState,
        duplicateRisk: draftRecord.duplicateRisk === 1,
        hasUncertainty: draftRecord.hasUncertainty === 1,
      },
      isMeaningful: true,
      preserved: false,
      parserRunId: run.id,
      message:
        reviewState === ReviewState.Parsed
          ? "Draft created and ready for review"
          : "Draft created with items requiring review",
      _runId: run.id,
    };
  });

  // Execute the transaction
  const result = tx() as ReturnType<typeof tx>;

  // Return result without internal _runId
  const { _runId, ...publicResult } = result;
  return publicResult;
}

/**
 * Attempt to mark a draft as ready.
 * Returns the result of the readiness check.
 */
export function markDraftReady(
  db: Database,
  draftId: number,
): ReadinessResult & { success: boolean } {
  const draft = getDraft(db, draftId);
  if (!draft)
    return { success: false, errors: ["Draft not found"], ready: false };

  const result = checkReadiness({
    date: draft.date,
    amount: draft.amount,
    currency: draft.currency,
    merchant: draft.merchant,
    sourceAccountName: draft.sourceAccountName,
    duplicateRisk: draft.duplicateRisk === 1,
    hasUncertainty: draft.hasUncertainty === 1,
  });

  if (result.ready) {
    updateDraftField(db, draftId, "review_state", ReviewState.Ready);
  }

  return { ...result, success: result.ready };
}

/**
 * Skip a slip — delete the draft if one exists.
 */
export function skipDraft(db: Database, slipId: number): boolean {
  return deleteDraftBySlipId(db, slipId);
}
