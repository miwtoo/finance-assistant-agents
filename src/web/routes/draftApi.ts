import { Database } from "bun:sqlite";
import type { ParserProvider } from "../../domain/parserTypes";
import type { AppConfig } from "../../config";
import { openDatabase } from "../../db/client";
import { initSlipsTable, getSlipById } from "../../db/slips";
import { initDraftsTable, getDraft, getDraftBySlipId, updateDraftField } from "../../db/drafts";
import { parseSlipToDraftAsync, markDraftReady } from "../../domain/draftService";
import { ReviewState, type ParseResult } from "../../domain/types";
import { safeParseResult } from "../../domain/parserValidator";

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

      // Create a blank draft via upsert with needs_review and userEditedAt set
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
 * PATCH /drafts/:id
 *
 * Save a single field edit. Body: { field: string, value: string|null }.
 * Sets user_edited_at timestamp on any manual edit.
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

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initDraftsTable(db);

      const draft = getDraft(db, draftId);
      if (!draft) {
        return json({ ok: false, message: `Draft #${draftId} not found` }, 404);
      }

      // Update the requested field
      const updated = updateDraftField(db, draftId, field, value ?? null);

      // Set user_edited_at on any manual edit
      updateDraftField(db, draftId, "user_edited_at", new Date().toISOString());

      // Re-read after both updates
      const { getDraft: getDraftFn } = await import("../../db/drafts");
      const final = getDraftFn(db, draftId);

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
 * POST /drafts/:id/mark-ready
 *
 * Attempt to mark a draft as ready for sync.
 * Returns validation errors if not ready.
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

      const result = markDraftReady(db, draftId);

      if (result.success) {
        const draft = getDraft(db, draftId);
        return json({
          ok: true,
          message: "Draft marked as ready",
          draft: draft
            ? {
                id: draft.id,
                reviewState: draft.reviewState,
                duplicateRisk: draft.duplicateRisk === 1,
              }
            : null,
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
