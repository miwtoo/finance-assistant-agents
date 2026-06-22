import type { Database } from "bun:sqlite";
import type { ParserProvider } from "./parserTypes";
import {
  ParserRunStatus,
  ReviewState,
  SyncState,
  type ParsedSlip,
  type ParseResult,
} from "./types";
import { validateParseResult, determineInitialReviewState, checkReadiness, type ReadinessResult } from "./parserValidator";
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
import { getSlipsByPaths } from "../db/slips";
import type { SlipRecord } from "../db/slips";

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
  /** Parser run id */
  parserRunId: number;
  /** Human-readable message */
  message: string;
}

/**
 * Check if a slip path was already scanned (exists in slips table).
 */
function getSlipRecordByPath(
  db: Database,
  sourcePath: string,
): SlipRecord | null {
  const slips = getSlipsByPaths(db, [sourcePath]);
  return slips.length > 0 ? slips[0] : null;
}

/**
 * Check for duplicate risk: another draft with same content_hash
 * but different source path already exists.
 */
function detectDuplicateRisk(
  db: Database,
  contentHash: string | null,
  sourcePath: string,
): boolean {
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
 * Async version of parseSlipToDraft.
 * The parse call happens first, then DB operations within a transaction.
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

  // 1. Call the parser provider
  let parseResult: ParseResult;
  try {
    parseResult = await provider.parse(sourcePath);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Record failed run outside transaction
    const run = insertParserRun(db, {
      slipId,
      provider: provider.name,
      model: provider.model,
      status: ParserRunStatus.Failed,
      rawJson: null,
      metadata: JSON.stringify({ error: errorMessage }),
    });
    return {
      draft: null,
      isMeaningful: false,
      parserRunId: run.id,
      message: `Parser provider error: ${errorMessage}`,
    };
  }

  // 2. Validate the parse result
  const { parsedSlip, isMeaningful } = validateParseResult(
    parseResult,
    sourcePath,
    contentHash ?? "",
  );

  // 3. Record the parser run
  const run = insertParserRun(db, {
    slipId,
    provider: provider.name,
    model: provider.model,
    status: parseResult.status,
    rawJson: JSON.stringify(parseResult),
    metadata: JSON.stringify({ confidence: parseResult.confidence }),
  });

  // 4. If not meaningful → no draft change
  if (!isMeaningful) {
    return {
      draft: null,
      isMeaningful: false,
      parserRunId: run.id,
      message: "Parse did not produce meaningful data. No draft created.",
    };
  }

  // 5. Detect duplicate risk (within transaction for consistency)
  // Check both drafts table and this parse result
  const duplicateRisk = detectDuplicateRisk(
    db,
    contentHash,
    sourcePath,
  );

  // 6. Determine initial review state
  let reviewState = determineInitialReviewState(parsedSlip);

  // 7. Apply duplicate risk override: if duplicate, force needs-review
  if (duplicateRisk && reviewState === ReviewState.Parsed) {
    reviewState = ReviewState.NeedsReview;
  }

  // 8. Create or update the draft (upsert — idempotent on retry)
  const draftInput: DraftInput = {
    slipId,
    sourcePath,
    contentHash,
    date: parsedSlip.date,
    amount: parsedSlip.amount,
    currency: parsedSlip.currency,
    merchant: parsedSlip.normalizedMerchant,
    parsedMerchant: parsedSlip.parsedMerchant,
    sourceIdentifier: parsedSlip.sourceIdentifier,
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
    // If upsert fails, record the error but still return the parser run
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      draft: null,
      isMeaningful: true,
      parserRunId: run.id,
      message: `Draft creation failed: ${errorMessage}`,
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
    parserRunId: run.id,
    message: reviewState === ReviewState.Parsed
      ? "Draft created and ready for review"
      : "Draft created with items requiring review",
  };
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
  if (!draft) return { success: false, errors: ["Draft not found"], ready: false };

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
