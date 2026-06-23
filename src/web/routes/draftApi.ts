import { Database } from "bun:sqlite";
import type { ParserProvider } from "../../domain/parserTypes";
import type { AppConfig } from "../../config";
import { openDatabase } from "../../db/client";
import { initSlipsTable, getSlipById, updateSlipParseStatus } from "../../db/slips";
import { initDraftsTable, getDraft, getDraftBySlipId, insertDraft, updateDraftField } from "../../db/drafts";
import { parseSlipToDraftAsync, markDraftReady } from "../../domain/draftService";
import { ReviewState, SyncState } from "../../domain/types";
import { validateAmount, validateDate, isValidCurrency } from "../../domain/parserValidator";

/**
 * Fields that the user is allowed to edit via PATCH.
 * Status/risk/uncertainty/system fields are NOT allowed.
 */
const USER_EDITABLE_FIELDS = new Set([
  "date",
  "amount",
  "currency",
  "merchant",
  "source_account_name",
  "category",
]);

/**
 * POST /candidates/:id/parse
 *
 * Trigger AI parse for a discovered slip candidate.
 * Uses the injected ParserProvider. Returns JSON with result.
 */
export function parseSlipHandler(config: AppConfig, parserProvider: ParserProvider) {
  return async (context: { params: { id: string } }): Promise<Response> => {
    const slipId = Number.parseInt(context.params.id, 10);
    if (Number.isNaN(slipId) || slipId <= 0) {
      return json({ ok: false, message: "Invalid slip ID" }, 400);
    }

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initSlipsTable(db);
      initDraftsTable(db);

      const slip = getSlipById(db, slipId);
      if (!slip) {
        return json({ ok: false, message: `Slip #${slipId} not found` }, 404);
      }

      const result = await parseSlipToDraftAsync(
        db,
        slip.id,
        slip.sourcePath,
        slip.contentHash,
        parserProvider,
      );

      // Update slip parse_status and lifecycle_status
      if (result.draft) {
        updateSlipParseStatus(db, slipId, "success", "parsed");
      } else {
        updateSlipParseStatus(db, slipId, result.isMeaningful ? "partial" : "failed", "parse_failed");
      }

      if (result.draft) {
        return json({
          ok: true,
          draftId: result.draft.id,
          slipId: result.draft.slipId,
          reviewState: result.draft.reviewState,
          duplicateRisk: result.draft.duplicateRisk,
          preserved: result.preserved,
          message: result.message,
          parserRunId: result.parserRunId,
        });
      }

      return json({
        ok: true,
        draft: null,
        message: result.message,
        parserRunId: result.parserRunId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, message: `Parse error: ${msg}` }, 500);
    } finally {
      db?.close();
    }
  };
}

/**
 * POST /candidates/:id/create-draft
 *
 * Create a manual (blank) draft for a slip that failed to parse
 * or where the user wants to skip auto-parse.
 */
export function createManualDraftHandler(config: AppConfig) {
  return async (context: { params: { id: string } }): Promise<Response> => {
    const slipId = Number.parseInt(context.params.id, 10);
    if (Number.isNaN(slipId) || slipId <= 0) {
      return json({ ok: false, message: "Invalid slip ID" }, 400);
    }

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initSlipsTable(db);
      initDraftsTable(db);

      const slip = getSlipById(db, slipId);
      if (!slip) {
        return json({ ok: false, message: `Slip #${slipId} not found` }, 404);
      }

      const existing = getDraftBySlipId(db, slipId);
      if (existing) {
        return json({
          ok: false,
          message: `Draft already exists for slip #${slipId}`,
          draftId: existing.id,
        }, 409);
      }

      const draft = insertDraft(db, {
        slipId,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: null,
        amount: null,
        currency: null,
        parsedCurrency: null,
        merchant: null,
        parsedMerchant: null,
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: null,
        sourceAccountName: null,
        category: null,
        reviewState: ReviewState.NeedsReview,
        syncState: SyncState.Unsynced,
        duplicateRisk: slip.duplicateRisk,
        hasUncertainty: false,
        userEditedAt: new Date().toISOString(),
      });

      return json({
        ok: true,
        draftId: draft.id,
        slipId: draft.slipId,
        reviewState: ReviewState.NeedsReview,
        message: "Manual draft created",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed")) {
        return json({ ok: false, message: `Draft already exists for slip #${slipId}` }, 409);
      }
      return json({ ok: false, message: `Draft creation error: ${msg}` }, 500);
    } finally {
      db?.close();
    }
  };
}

/**
 * PATCH /drafts/:id
 *
 * Save a single user-editable field. Body: { field: string, value: string|null }.
 *
 * Only allows fields in USER_EDITABLE_FIELDS. Rejects status/risk/uncertainty/system
 * field edits with 400.
 *
 * On successful save:
 * - Sets user_edited_at timestamp
 * - All writes are wrapped in a SQLite transaction
 * - NOTE: does NOT clear has_uncertainty — use POST /drafts/:id/resolve-uncertainty
 */
export function saveDraftFieldHandler(config: AppConfig) {
  return async (context: any): Promise<Response> => {
    const draftId = Number.parseInt(context.params.id, 10);
    if (Number.isNaN(draftId) || draftId <= 0) {
      return json({ ok: false, message: "Invalid draft ID" }, 400);
    }

    const { field, value } = context.body ?? {};
    if (!field) {
      return json({ ok: false, message: "Field name is required" }, 400);
    }

    // Check field is in the user-editable allowlist
    if (!USER_EDITABLE_FIELDS.has(field)) {
      return json({ ok: false, message: `Field "${field}" is not allowed for manual edit` }, 400);
    }

    // Reject non-string/non-null values
    if (value !== null && typeof value !== "string") {
      return json({ ok: false, message: "Value must be a string or null" }, 400);
    }

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initDraftsTable(db);

      const draft = getDraft(db, draftId);
      if (!draft) {
        return json({ ok: false, message: `Draft #${draftId} not found` }, 404);
      }

      // Reject edits on synced drafts
      if (draft.syncState === "synced") {
        return json({ ok: false, message: "Cannot edit a synced draft" }, 409);
      }

      // Wrap updates in a transaction: field update + user_edited_at + state demotion
      const safeDb = db;
      const tx = safeDb.transaction(() => {
        // 1. Update the requested field
        updateDraftField(safeDb, draftId, field, value ?? null);

        // 2. Always set user_edited_at on manual edit
        updateDraftField(safeDb, draftId, "user_edited_at", new Date().toISOString());

        // 3. Demote review_state to needs_review (user edit invalidates ready/parsed)
        if (draft.reviewState === ReviewState.Parsed || draft.reviewState === ReviewState.Ready) {
          updateDraftField(safeDb, draftId, "review_state", ReviewState.NeedsReview);
        }

        // Re-read final state
        return getDraft(safeDb, draftId);
      });

      const final = tx() as ReturnType<typeof tx>;

      return json({
        ok: true,
        draft: final
          ? {
              id: final.id,
              slipId: final.slipId,
              date: final.date,
              amount: final.amount,
              currency: final.currency,
              merchant: final.merchant,
              parsedMerchant: final.parsedMerchant,
              sourceAccountName: final.sourceAccountName,
              category: final.category,
              reviewState: final.reviewState,
              duplicateRisk: final.duplicateRisk === 1,
              hasUncertainty: final.hasUncertainty === 1,
              userEditedAt: final.userEditedAt,
            }
          : null,
        message: `Field "${field}" updated`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Invalid field")) {
        return json({ ok: false, message: msg }, 400);
      }
      return json({ ok: false, message: `Save error: ${msg}` }, 500);
    } finally {
      db?.close();
    }
  };
}

/**
 * POST /drafts/:id/resolve-uncertainty
 *
 * Explicit endpoint to clear uncertainty after user review.
 * Validates all readiness-relevant fields (amount, date, currency, merchant,
 * sourceAccountName) are present and valid. Clears has_uncertainty if
 * everything checks out (wrapped in a transaction with user_edited_at set).
 * Returns validation errors if not.
 *
 * This is the ONLY way to clear has_uncertainty — PATCH never touches it.
 */
export function resolveUncertaintyHandler(config: AppConfig) {
  return async (context: { params: { id: string } }): Promise<Response> => {
    const draftId = Number.parseInt(context.params.id, 10);
    if (Number.isNaN(draftId) || draftId <= 0) {
      return json({ ok: false, message: "Invalid draft ID" }, 400);
    }

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initDraftsTable(db);

      const draft = getDraft(db, draftId);
      if (!draft) {
        return json({ ok: false, message: `Draft #${draftId} not found` }, 404);
      }

      // Reject edits on synced drafts
      if (draft.syncState === "synced") {
        return json({ ok: false, message: "Cannot resolve uncertainty on a synced draft" }, 409);
      }

      const errors: string[] = [];

      if (!draft.amount || !validateAmount(draft.amount)) {
        errors.push("Amount must be present and valid");
      }
      if (!draft.date || !validateDate(draft.date)) {
        errors.push("Date must be present and valid (YYYY-MM-DD)");
      }
      if (!draft.merchant) {
        errors.push("Merchant is required");
      }
      if (!draft.currency || !isValidCurrency(draft.currency)) {
        errors.push("Currency must be a recognized code");
      }
      if (!draft.sourceAccountName) {
        errors.push("Source account is required");
      }

      if (errors.length > 0) {
        return json({
          ok: false,
          message: "Cannot resolve uncertainty — fields with issues",
          errors,
        }, 422);
      }

      // Clear uncertainty + set user_edited_at (user made review decision)
      const safeDb = db;
      const tx = safeDb.transaction(() => {
        updateDraftField(safeDb, draftId, "has_uncertainty", "0");
        updateDraftField(safeDb, draftId, "user_edited_at", new Date().toISOString());
        return getDraft(safeDb, draftId);
      });
      const updated = tx();

      return json({
        ok: true,
        message: "Uncertainty resolved",
        uncertaintyResolved: true,
        draft: updated
          ? {
              id: updated.id,
              slipId: updated.slipId,
              date: updated.date,
              amount: updated.amount,
              currency: updated.currency,
              merchant: updated.merchant,
              parsedMerchant: updated.parsedMerchant,
              sourceAccountName: updated.sourceAccountName,
              category: updated.category,
              reviewState: updated.reviewState,
              duplicateRisk: updated.duplicateRisk === 1,
              hasUncertainty: updated.hasUncertainty === 1,
              userEditedAt: updated.userEditedAt,
            }
          : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, message: `Resolve error: ${msg}` }, 500);
    } finally {
      db?.close();
    }
  };
}

/**
 * POST /drafts/:id/mark-ready
 *
 * Attempt to mark a draft as ready for sync.
 * Returns 404 if draft not found.
 * Returns 422 with validation errors if not ready.
 */
export function markDraftReadyHandler(config: AppConfig) {
  return async (context: { params: { id: string } }): Promise<Response> => {
    const draftId = Number.parseInt(context.params.id, 10);
    if (Number.isNaN(draftId) || draftId <= 0) {
      return json({ ok: false, message: "Invalid draft ID" }, 400);
    }

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initDraftsTable(db);

      // Check draft exists before calling service
      const draft = getDraft(db, draftId);
      if (!draft) {
        return json({ ok: false, message: `Draft #${draftId} not found` }, 404);
      }

      // Reject mark-ready on synced drafts
      if (draft.syncState === "synced") {
        return json({ ok: false, message: "Cannot mark a synced draft as ready" }, 409);
      }

      const result = markDraftReady(db, draftId);

      if (result.success) {
        return json({
          ok: true,
          message: "Draft marked as ready",
          draft: {
            id: draft.id,
            reviewState: "ready",
            duplicateRisk: draft.duplicateRisk === 1,
          },
        });
      }

      return json({
        ok: false,
        message: "Draft is not ready",
        errors: result.errors,
      }, 422);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, message: `Mark-ready error: ${msg}` }, 500);
    } finally {
      db?.close();
    }
  };
}

// ─── Helpers ──────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
