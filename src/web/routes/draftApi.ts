import { Database } from "bun:sqlite";
import type { ParserProvider } from "../../domain/parserTypes";
import type { AppConfig } from "../../config";
import { openDatabase } from "../../db/client";
import { initSlipsTable, getSlipById } from "../../db/slips";
import { initDraftsTable, getDraft, getDraftBySlipId, updateDraftField } from "../../db/drafts";
import { parseSlipToDraftAsync, markDraftReady } from "../../domain/draftService";
import { ReviewState } from "../../domain/types";
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

      const { upsertDraft } = await import("../../db/drafts");
      const draft = upsertDraft(db, {
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
        syncState: "unsynced" as any,
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
      return json({ ok: false, message: `Draft creation error: ${msg}` }, 500);
    } finally {
      db?.close();
    }
  };
}

/**
 * Check whether a set of draft fields indicates resolved uncertainty.
 * Returns true if amount+date+merchant are present and have valid format.
 */
function checkFieldsResolveUncertainty(fields: {
  amount: string | null;
  date: string | null;
  merchant: string | null;
}): boolean {
  if (!fields.amount || !fields.date || !fields.merchant) return false;
  if (!validateAmount(fields.amount)) return false;
  if (!validateDate(fields.date)) return false;
  return true;
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
 * - Automatically sets user_edited_at timestamp
 * - Recomputes has_uncertainty: cleared when amount+date+merchant are all valid
 * - All writes are wrapped in a SQLite transaction
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

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initDraftsTable(db);

      const draft = getDraft(db, draftId);
      if (!draft) {
        return json({ ok: false, message: `Draft #${draftId} not found` }, 404);
      }

      // Wrap updates in a transaction: field update + user_edited_at + uncertainty recompute
      const safeDb = db; // non-null at this point
      const tx = safeDb.transaction(() => {
        // 1. Update the requested field
        updateDraftField(safeDb, draftId, field, value ?? null);

        // 2. Always set user_edited_at on manual edit
        updateDraftField(safeDb, draftId, "user_edited_at", new Date().toISOString());

        // 3. Recompute has_uncertainty
        const updated = getDraft(safeDb, draftId);
        if (updated) {
          const resolved = checkFieldsResolveUncertainty({
            amount: updated.amount,
            date: updated.date,
            merchant: updated.merchant,
          });
          if (resolved && updated.hasUncertainty === 1) {
            updateDraftField(safeDb, draftId, "has_uncertainty", "0");
          }
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
 * everything checks out. Returns validation errors if not.
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

      // Clear uncertainty
      updateDraftField(db, draftId, "has_uncertainty", "0");

      return json({
        ok: true,
        message: "Uncertainty resolved",
        uncertaintyResolved: true,
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
