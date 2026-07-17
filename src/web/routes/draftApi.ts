import { Database } from "bun:sqlite";
import type { ParserProvider } from "../../domain/parserTypes";
import type { AppConfig } from "../../config";
import { openDatabase } from "../../db/client";
import { initSlipsTable, getSlipById, updateSlipParseStatus } from "../../db/slips";
import {
  initDraftsTable,
  getDraft,
  getDraftBySlipId,
  updateDraftField,
  updateDraftSourceAccount,
  getOrCreateInstallationId,
  buildExternalId,
  claimDraftForSync,
  acquirePendingSyncRecoveryLease,
  completeDraftSync,
  failDraftSync,
  markSyncOutcomeUnknown,
  resetSyncFailedDraft,
} from "../../db/drafts";
import { parseSlipToDraftAsync, markDraftReady } from "../../domain/draftService";
import { ReviewState, SyncState } from "../../domain/types";
import { validateAmount, validateDate, isValidCurrency } from "../../domain/parserValidator";
import {
  createFireflyClient,
  type FireflyClientConfig,
  type FireflyAccount,
  type FireflyWithdrawalRequest,
} from "../../infra/firefly/client";

/**
 * Fields that the user is allowed to edit via PATCH.
 * Status/risk/uncertainty/system fields are NOT allowed.
 */
const USER_EDITABLE_FIELDS = new Set([
  "date",
  "amount",
  "currency",
  "merchant",
  "category",
]);

// ─── POST /candidates/:id/parse ──────────────────────────────

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
      return json({ ok: false, message: "Parse failed due to an internal error" }, 500);
    } finally {
      db?.close();
    }
  };
}

// ─── POST /candidates/:id/create-draft ───────────────────────

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
        sourceAccountId: null,
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
      return json({ ok: false, message: "Draft creation failed due to an internal error" }, 500);
    } finally {
      db?.close();
    }
  };
}

// ─── PATCH /drafts/:id ───────────────────────────────────────

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
 * - Increments revision (P1.4)
 * - All writes are wrapped in a SQLite transaction
 * - NOTE: does NOT clear has_uncertainty — use POST /drafts/:id/resolve-uncertainty
 *
 * Blocks edits on pending_sync/synced drafts.
 * P1.5: Allows edits on sync_failed drafts (retryable ones reset to unsynced).
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

      // Block edits on pending_sync or synced drafts
      if (draft.syncState === "pending_sync" || draft.syncState === "synced") {
        return json(
          { ok: false, message: `Cannot edit a ${draft.syncState} draft` },
          409,
        );
      }

      // P1.5: For sync_failed with retryable error, reset to unsynced first
      const isRetryableSyncFailed =
        draft.syncState === "sync_failed" &&
        draft.fireflyErrorCode &&
        resetSyncFailedDraft(db, draftId) !== null;

      // Re-read draft state after potential reset
      const currentDraft = getDraft(db, draftId)!;

      // Wrap updates in a transaction: field update + user_edited_at + state demotion
      const safeDb = db;
      const tx = safeDb.transaction(() => {
        // 1. Update the requested field
        updateDraftField(safeDb, draftId, field, value ?? null);

        // 2. Always set user_edited_at on manual edit
        updateDraftField(safeDb, draftId, "user_edited_at", new Date().toISOString());

        // 3. Demote review_state to needs_review (user edit invalidates ready/parsed)
        if (currentDraft.reviewState === ReviewState.Parsed || currentDraft.reviewState === ReviewState.Ready) {
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
      return json({ ok: false, message: "Save failed due to an internal error" }, 500);
    } finally {
      db?.close();
    }
  };
}

// ─── POST /drafts/:id/resolve-uncertainty ─────────────────────

/**
 * POST /drafts/:id/resolve-uncertainty
 *
 * Explicit endpoint to clear uncertainty after user review.
 * Validates all readiness-relevant fields (amount, date, currency, merchant,
 * sourceAccountId) are present and valid. Clears has_uncertainty if
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

      // Reject edits on pending_sync/synced drafts
      if (draft.syncState === "pending_sync" || draft.syncState === "synced") {
        return json(
          { ok: false, message: `Cannot resolve uncertainty on a ${draft.syncState} draft` },
          409,
        );
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
      if (!draft.sourceAccountId) {
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
      return json({ ok: false, message: "Resolve failed due to an internal error" }, 500);
    } finally {
      db?.close();
    }
  };
}

// ─── POST /drafts/:id/mark-ready ─────────────────────────────

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

      // Reject mark-ready on pending_sync/synced drafts
      if (draft.syncState === "pending_sync" || draft.syncState === "synced") {
        return json(
          { ok: false, message: `Cannot mark a ${draft.syncState} draft as ready` },
          409,
        );
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
      return json({ ok: false, message: "Mark-ready failed due to an internal error" }, 500);
    } finally {
      db?.close();
    }
  };
}

// ─── Sync: validation helpers ────────────────────────────────

/**
 * Validate and normalize a draft for sync.
 * Enforces required fields, normalizes amount/currency.
 * Returns normalized values or errors.
 */
function validateForSync(draft: {
  date: string | null;
  amount: string | null;
  currency: string | null;
  merchant: string | null;
  sourceAccountId: string | null;
  category: string | null;
}): { ok: true; normalized: { date: string; amount: string; currency: string; merchant: string } } | { ok: false; status: number; errors: string[] } {
  const errors: string[] = [];

  // Merchant required
  if (!draft.merchant || !draft.merchant.trim()) {
    errors.push("Merchant is required for sync");
  }

  // Date required and valid
  const normalizedDate = draft.date ? validateDate(draft.date) : null;
  if (!normalizedDate) {
    errors.push(`Date "${draft.date}" is not valid (required YYYY-MM-DD)`);
  }

  // Source account required
  if (!draft.sourceAccountId || !draft.sourceAccountId.trim()) {
    errors.push("Source account is required for sync");
  }

  // Amount: must be present, valid format, positive, finite
  const normalizedAmount = draft.amount ? validateAmount(draft.amount) : null;
  if (!normalizedAmount) {
    errors.push(`Amount "${draft.amount}" is not a valid decimal format`);
  } else {
    const num = Number.parseFloat(normalizedAmount);
    if (!Number.isFinite(num) || num <= 0) {
      errors.push(`Amount must be positive and finite, got "${normalizedAmount}"`);
    }
  }

  // Currency: must be valid, uppercase
  if (!draft.currency) {
    errors.push("Currency is required for sync");
  } else if (!isValidCurrency(draft.currency)) {
    errors.push(`Currency "${draft.currency}" is not a recognized code`);
  }

  if (errors.length > 0) {
    const status = errors.some((e) => e.includes("not a valid") || e.includes("not a recognized")) ? 422 : 400;
    return { ok: false, status, errors };
  }

  return {
    ok: true,
    normalized: {
      date: normalizedDate!,
      amount: normalizedAmount!,
      currency: draft.currency!.toUpperCase(),
      merchant: draft.merchant!.trim(),
    },
  };
}

/**
 * Sanitize a Firefly error for safe client exposure.
 * Never exposes raw upstream body (P1.7).
 * P1.7: Duplicate check must come BEFORE generic 400/422 to produce
 * distinct error code. Ordering: duplicate → validation → auth → rate limit → server → unknown.
 */
function sanitizeFireflyError(status: number, message: string): { code: string; message: string } {
  // P1.7: Check duplicate FIRST (before generic 400/422)
  if ((status === 400 || status === 422) && message.toLowerCase().includes("duplicate")) {
    return { code: "FIREFLY_DUPLICATE", message: "Duplicate transaction detected by Firefly" };
  }
  // Validation errors
  if (status === 400 || status === 422) {
    return { code: "FIREFLY_VALIDATION_ERROR", message: "Transaction rejected by Firefly (validation)" };
  }
  // Auth / contract
  if (status === 401 || status === 403) {
    return { code: "FIREFLY_AUTH_ERROR", message: "Authentication or authorization failed" };
  }
  // Rate limit
  if (status === 429) {
    return { code: "FIREFLY_RATE_LIMIT", message: "Rate limited by Firefly" };
  }
  // Server error
  if (status >= 500) {
    return { code: "FIREFLY_SERVER_ERROR", message: "Firefly server error" };
  }
  // Unknown
  return { code: "FIREFLY_UNKNOWN_ERROR", message: "Unexpected Firefly response" };
}

/**
 * Map Firefly error to sync outcome + HTTP status.
 * For definite rejections: sync_failed + local error.
 * For unknowns: pending_sync + 202.
 */
function mapFireflyErrorToSyncResult(
  status: number,
  message: string,
): { httpStatus: number; errorCode: string; errorMessage: string; outcome: "reject" | "unknown" } {
  const sanitized = sanitizeFireflyError(status, message);

  // Network error (status 0)
  if (status === 0) {
    return { httpStatus: 202, errorCode: "FIREFLY_NETWORK_ERROR", errorMessage: "Could not reach Firefly", outcome: "unknown" };
  }

  // P1.7: Check duplicate FIRST (before generic 400/422)
  if ((status === 400 || status === 422) && message.toLowerCase().includes("duplicate")) {
    return { httpStatus: 409, errorCode: "FIREFLY_DUPLICATE", errorMessage: sanitized.message, outcome: "reject" };
  }

  // Definite rejections
  if (status === 400 || status === 422) {
    return { httpStatus: status === 400 ? 400 : 422, errorCode: sanitized.code, errorMessage: sanitized.message, outcome: "reject" };
  }
  if (status === 401 || status === 403) {
    return { httpStatus: 503, errorCode: sanitized.code, errorMessage: sanitized.message, outcome: "reject" };
  }
  if (status === 429) {
    return { httpStatus: 503, errorCode: sanitized.code, errorMessage: sanitized.message, outcome: "reject" };
  }

  // 5xx or other → unknown outcome, stay pending
  return { httpStatus: 202, errorCode: "FIREFLY_OUTCOME_UNKNOWN", errorMessage: "Could not determine transaction outcome", outcome: "unknown" };
}

// ─── Sync: account validation ────────────────────────────────

/**
 * Validate source and destination accounts against Firefly.
 * Returns matched source account ID or errors.
 * Never returns raw upstream response data.
 */
async function validateSyncAccounts(
  config: AppConfig,
  sourceAccountId: string,
  destinationAccountId: string,
): Promise<
  | { ok: true; sourceAccountId: string }
  | { ok: false; status: number; message: string; errors?: string[] }
> {
  const fireflyCfg: FireflyClientConfig = {
    baseUrl: config.fireflyBaseUrl,
    token: config.fireflyToken,
  };
  const client = createFireflyClient(fireflyCfg);

  const [assetRes, expenseRes] = await Promise.all([
    client.getAssetAccounts(),
    client.getExpenseAccounts(),
  ]);

  if (!assetRes.ok) {
    return { ok: false, status: 502, message: "Failed to fetch Firefly asset accounts" };
  }
  if (!expenseRes.ok) {
    return { ok: false, status: 502, message: "Failed to fetch Firefly expense accounts" };
  }

  const sourceAccount = assetRes.data.find((account) => account.id === sourceAccountId);
  if (!sourceAccount) {
    return {
      ok: false,
      status: 422,
      message: "Selected source account no longer exists in Firefly",
      errors: ["Select a current Firefly asset account before syncing"],
    };
  }

  const destAccount = expenseRes.data.find((a) => a.id === destinationAccountId);
  if (!destAccount) {
    return {
      ok: false,
      status: 422,
      message: `Expense account #${destinationAccountId} not found in Firefly`,
      errors: [`Invalid destinationAccountId: ${destinationAccountId}`],
    };
  }

  return { ok: true, sourceAccountId: sourceAccount.id };
}

// ─── GET /drafts/:id/sync-options ─────────────────────────────

/**
 * GET /drafts/:id/sync-options
 *
 * Load a ready/eligible draft, validate its selected source account ID against
 * Firefly asset accounts, then return that account and expense-account choices.
 *
 * Response: { sourceAccount: {id,name}, destinationAccounts: [{id,name}] }
 */
export function syncOptionsHandler(config: AppConfig) {
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

      // Only ready drafts are eligible
      if (draft.reviewState !== ReviewState.Ready) {
        return json(
          {
            ok: false,
            message: `Draft #${draftId} is not ready for sync (state: ${draft.reviewState})`,
          },
          422,
        );
      }

      // Already synced/pending → reject
      if (draft.syncState === SyncState.Synced || draft.syncState === SyncState.PendingSync) {
        return json(
          { ok: false, message: `Draft #${draftId} is already ${draft.syncState}` },
          409,
        );
      }

      // Duplicate-risk drafts blocked
      if (draft.duplicateRisk === 1) {
        return json(
          { ok: false, message: `Draft #${draftId} has duplicate risk` },
          422,
        );
      }

      if (!draft.sourceAccountId) {
        return json(
          {
            ok: false,
            message: "Draft has no selected source account",
            errors: ["sourceAccountId is required"],
          },
          422,
        );
      }

      // Fetch Firefly accounts
      const fireflyCfg: FireflyClientConfig = {
        baseUrl: config.fireflyBaseUrl,
        token: config.fireflyToken,
      };
      const client = createFireflyClient(fireflyCfg);

      const [assetRes, expenseRes] = await Promise.all([
        client.getAssetAccounts(),
        client.getExpenseAccounts(),
      ]);

      if (!assetRes.ok) {
        return json(
          { ok: false, message: "Failed to fetch Firefly asset accounts" },
          502,
        );
      }
      if (!expenseRes.ok) {
        return json(
          { ok: false, message: "Failed to fetch Firefly expense accounts" },
          502,
        );
      }

      const selectedAsset = assetRes.data.find((account) => account.id === draft.sourceAccountId);
      if (!selectedAsset) {
        return json(
          {
            ok: false,
            message: "Selected source account no longer exists in Firefly",
            errors: ["Select a current Firefly asset account before syncing"],
          },
          422,
        );
      }

      return json({
        ok: true,
        sourceAccount: { id: selectedAsset.id, name: selectedAsset.name },
        destinationAccounts: expenseRes.data.map((a) => ({
          id: a.id,
          name: a.name,
        })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, message: "Sync-options failed due to an internal error" }, 500);
    } finally {
      db?.close();
    }
  };
}

// ─── GET /drafts/:id/source-accounts ──────────────────────────

/**
 * GET /drafts/:id/source-accounts
 *
 * Fetch Firefly asset accounts for a given draft, returning the full
 * list of available source accounts. The caller can use this to
 * populate a source-account picker.
 *
 * Response: { accounts: [{ id: string, name: string, type: string }] }
 */
export function getDraftSourceAccountsHandler(config: AppConfig) {
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

      // Fetch Firefly asset accounts using the established client pattern
      const fireflyCfg: FireflyClientConfig = {
        baseUrl: config.fireflyBaseUrl,
        token: config.fireflyToken,
      };
      const client = createFireflyClient(fireflyCfg);

      const assetRes = await client.getAssetAccounts();
      if (!assetRes.ok) {
        return json(
          { ok: false, message: "Failed to fetch Firefly asset accounts" },
          502,
        );
      }

      return json({
        ok: true,
        accounts: assetRes.data.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
        })),
      });
    } catch (err) {
      return json(
        { ok: false, message: "Failed to fetch source accounts due to an internal error" },
        500,
      );
    } finally {
      db?.close();
    }
  };
}

// ─── POST /drafts/:id/source-account ───────────────────────────

/**
 * Select a Firefly asset account for a draft. The ID is validated against
 * Firefly before the ID and its display name are persisted together.
 */
export function selectDraftSourceAccountHandler(config: AppConfig) {
  return async (context: { params: { id: string }; body: unknown }): Promise<Response> => {
    const draftId = Number.parseInt(context.params.id, 10);
    const body = context.body as { sourceAccountId?: unknown } | undefined;
    const sourceAccountId = body?.sourceAccountId;
    if (Number.isNaN(draftId) || draftId <= 0) {
      return json({ ok: false, message: "Invalid draft ID" }, 400);
    }
    if (typeof sourceAccountId !== "string" || !sourceAccountId.trim()) {
      return json({ ok: false, message: "sourceAccountId is required (string)" }, 400);
    }

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initDraftsTable(db);
      const draft = getDraft(db, draftId);
      if (!draft) return json({ ok: false, message: `Draft #${draftId} not found` }, 404);
      if (draft.syncState === SyncState.PendingSync || draft.syncState === SyncState.Synced) {
        return json({ ok: false, message: `Cannot edit a ${draft.syncState} draft` }, 409);
      }

      const client = createFireflyClient({ baseUrl: config.fireflyBaseUrl, token: config.fireflyToken });
      const accounts = await client.getAssetAccounts();
      if (!accounts.ok) {
        return json({ ok: false, message: "Failed to fetch Firefly asset accounts" }, 502);
      }
      const selected = accounts.data.find((account) => account.id === sourceAccountId);
      if (!selected) {
        return json({ ok: false, message: "Selected source account no longer exists in Firefly" }, 422);
      }

      const safeDb = db;
      const updated = safeDb.transaction(() => {
        const result = updateDraftSourceAccount(safeDb, draftId, selected);
        if (draft.reviewState === ReviewState.Parsed || draft.reviewState === ReviewState.Ready) {
          return updateDraftField(safeDb, draftId, "review_state", ReviewState.NeedsReview);
        }
        return result;
      })();

      return json({
        ok: true,
        draft: {
          id: updated.id,
          sourceAccountId: updated.sourceAccountId,
          sourceAccountName: updated.sourceAccountName,
          reviewState: updated.reviewState,
        },
      });
    } catch {
      return json({ ok: false, message: "Could not save source account" }, 500);
    } finally {
      db?.close();
    }
  };
}

// ─── POST /drafts/:id/sync ───────────────────────────────────

/**
 * POST /drafts/:id/sync
 *
 * Body: { destinationAccountId: string }
 *
 * Flow:
 * 1. Validate draft eligibility (ready, unsynced, no duplicate-risk)
 * 2. Validate required fields (merchant, date, amount, source, destination)
 * 3. Normalize amount/currency
 * 4. Validate source/destination against Firefly accounts
 * 5. Re-read draft + build payload inside CAS transaction (P1.4)
 * 6. Atomic CAS claim → pending_sync (with lease token + expected revision)
 * 7. Search external_id (idempotent check before POST)
 * 8. If found → complete sync atomically (with lease token)
 * 9. If zero → POST persisted payload
 * 10. If >1 → conflict
 * 11. If malformed → remain pending, no POST (P0.2)
 * 12. If search fails → remain pending
 */
export function syncDraftHandler(config: AppConfig) {
  return async (context: { params: { id: string }; body?: any }): Promise<Response> => {
    const draftId = Number.parseInt(context.params.id, 10);
    if (Number.isNaN(draftId) || draftId <= 0) {
      return json({ ok: false, message: "Invalid draft ID" }, 400);
    }

    const { destinationAccountId } = context.body ?? {};
    if (!destinationAccountId || typeof destinationAccountId !== "string") {
      return json(
        { ok: false, message: "destinationAccountId is required (string)" },
        400,
      );
    }

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initDraftsTable(db);

      const draft = getDraft(db, draftId);
      if (!draft) {
        return json({ ok: false, message: `Draft #${draftId} not found` }, 404);
      }

      // Only accept unsynced input
      if (draft.syncState !== SyncState.Unsynced) {
        return json(
          { ok: false, message: `Draft #${draftId} is not unsynced (state: ${draft.syncState})` },
          422,
        );
      }

      // Eligibility gates
      if (draft.reviewState !== ReviewState.Ready) {
        return json(
          { ok: false, message: `Draft #${draftId} is not ready for sync (state: ${draft.reviewState})` },
          422,
        );
      }
      if (draft.duplicateRisk === 1) {
        return json(
          { ok: false, message: `Draft #${draftId} has duplicate risk` },
          422,
        );
      }

      // Validate and normalize fields
      const validation = validateForSync(draft);
      if (!validation.ok) {
        return json(
          { ok: false, message: "Draft validation failed", errors: validation.errors },
          validation.status,
        );
      }
      const { normalized } = validation;

      // Validate source/destination against Firefly
      const accountValidation = await validateSyncAccounts(
        config,
        draft.sourceAccountId!,
        destinationAccountId,
      );
      if (!accountValidation.ok) {
        return json(
          { ok: false, message: accountValidation.message, errors: accountValidation.errors },
          accountValidation.status,
        );
      }
      const sourceAccountId = accountValidation.sourceAccountId;

      // P1.4: Re-read draft inside claim transaction + build payload from snapshot
      // This prevents stale payload ABA: the CAS checks revision, and the payload
      // is built from the same snapshot that passed the revision check.
      const installationId = getOrCreateInstallationId(db);
      const currentRevision = draft.revision;

      // Build canonical outbound withdrawal payload (P0.3: error_if_duplicate_hash at top level)
      const outboundPayload: FireflyWithdrawalRequest = {
        error_if_duplicate_hash: true as const,
        transactions: [
          {
            type: "withdrawal",
            date: `${normalized.date}T00:00:00+07:00`,
            amount: normalized.amount,
            description: normalized.merchant,
            source_id: sourceAccountId,
            destination_id: destinationAccountId,
            currency_code: normalized.currency,
            external_id: buildExternalId(installationId, draftId),
          },
        ],
      };

      // Atomic CAS claim → pending_sync (with lease token + revision check)
      const claimed = claimDraftForSync(
        db,
        draftId,
        installationId,
        JSON.stringify(outboundPayload),
        currentRevision,
      );
      if (!claimed) {
        return json(
          { ok: false, message: `Draft #${draftId} could not be claimed for sync (concurrent claim or wrong state)` },
          409,
        );
      }

      const leaseToken = claimed.fireflyLeaseToken!;
      const externalId = claimed.fireflyExternalId!;

      // Firefly client
      const fireflyCfg: FireflyClientConfig = {
        baseUrl: config.fireflyBaseUrl,
        token: config.fireflyToken,
      };
      const client = createFireflyClient(fireflyCfg);

      // Search before POST — idempotent check
      const searchRes = await client.searchByExternalId(externalId);
      if (!searchRes.ok) {
        // Search failure → remain pending, no POST
        markSyncOutcomeUnknown(db, draftId, "FIREFLY_SEARCH_ERROR", searchRes.message, leaseToken);
        return json(
          {
            ok: false,
            message: "Could not verify Firefly state — draft remains pending for recovery",
            outcome: "FIREFLY_OUTCOME_UNKNOWN",
            draft: { id: draftId, syncState: "pending_sync" },
          },
          202,
        );
      }

      if (searchRes.data.found && searchRes.data.count > 1) {
        // Ambiguous — >1 match
        failDraftSync(db, draftId, "FIREFLY_AMBIGUOUS_MATCH", "Multiple Firefly transactions match this external ID", leaseToken);
        return json(
          {
            ok: false,
            message: "Multiple Firefly transactions match this draft — manual resolution required",
            outcome: "FIREFLY_AMBIGUOUS_MATCH",
            draft: { id: draftId, syncState: "sync_failed" },
          },
          409,
        );
      }

      // P0.2: Malformed — found but no usable IDs → remain pending, must NOT POST
      if (searchRes.data.found && searchRes.data.malformed) {
        markSyncOutcomeUnknown(db, draftId, "FIREFLY_MALFORMED_RESPONSE", "Search returned result but IDs could not be extracted", leaseToken);
        return json(
          {
            ok: false,
            message: "Firefly returned malformed search result — draft remains pending for recovery",
            outcome: "FIREFLY_OUTCOME_UNKNOWN",
            draft: { id: draftId, syncState: "pending_sync" },
          },
          202,
        );
      }

      if (searchRes.data.found && searchRes.data.count === 1 && searchRes.data.groupId && searchRes.data.journalId) {
        // Already synced — complete atomically with lease token
        const completed = completeDraftSync(db, draftId, searchRes.data.groupId, searchRes.data.journalId, leaseToken);
        if (!completed) {
          return json(
            { ok: false, message: `Draft #${draftId} could not be completed (lease expired or concurrent)` },
            409,
          );
        }
        return json({
          ok: true,
          message: "Draft already synced to Firefly (found via search)",
          firefly: {
            groupId: searchRes.data.groupId,
            journalId: searchRes.data.journalId,
            externalId,
          },
          draft: {
            id: completed.id,
            reviewState: completed.reviewState,
            syncState: completed.syncState,
          },
        });
      }

      // Zero matches → POST the persisted payload
      const txRes = await client.createWithdrawal(outboundPayload as FireflyWithdrawalRequest);
      if (!txRes.ok) {
        const mapped = mapFireflyErrorToSyncResult(txRes.status, txRes.message);

        if (mapped.outcome === "reject") {
          // Definite rejection → sync_failed with lease token
          const failed = failDraftSync(db, draftId, mapped.errorCode, mapped.errorMessage, leaseToken);
          if (!failed) {
            return json(
              { ok: false, message: `Draft #${draftId} could not be updated (lease expired)` },
              409,
            );
          }
          return json(
            {
              ok: false,
              message: mapped.errorMessage,
              outcome: mapped.errorCode,
              draft: { id: draftId, syncState: "sync_failed" },
            },
            mapped.httpStatus,
          );
        } else {
          // Unknown outcome → stay pending for recovery with lease token
          markSyncOutcomeUnknown(db, draftId, mapped.errorCode, mapped.errorMessage, leaseToken);
          return json(
            {
              ok: false,
              message: "Could not determine transaction outcome — draft remains pending for recovery",
              outcome: "FIREFLY_OUTCOME_UNKNOWN",
              draft: { id: draftId, syncState: "pending_sync" },
            },
            202,
          );
        }
      }

      // Success — complete sync with lease token
      const completed = completeDraftSync(db, draftId, txRes.data.groupId, txRes.data.journalId, leaseToken);
      if (!completed) {
        return json(
          { ok: false, message: `Draft #${draftId} could not be completed (lease expired)` },
          409,
        );
      }
      return json({
        ok: true,
        message: "Draft synced to Firefly",
        firefly: {
          groupId: txRes.data.groupId,
          journalId: txRes.data.journalId,
          externalId,
          syncedAt: completed.fireflySyncedAt,
        },
        draft: {
          id: completed.id,
          reviewState: completed.reviewState,
          syncState: completed.syncState,
        },
      });
    } catch (err) {
      return json({ ok: false, message: "Sync failed due to an internal error" }, 500);
    } finally {
      db?.close();
    }
  };
}

// ─── POST /drafts/:id/sync/recover ───────────────────────────

/**
 * POST /drafts/:id/sync/recover
 *
 * Recovery endpoint for pending_sync drafts.
 * Must never accept changed destination/payload.
 *
 * Lease acquisition (P0.1): Before any Firefly calls, atomically acquire
 * an exclusive recovery lease via acquirePendingSyncRecoveryLease. Only the
 * winner (CAS succeeds) proceeds to search/POST. Losers get 422 "lease held".
 * This prevents concurrent /recover calls from both making Firefly POSTs.
 *
 * P0.2: Malformed search → remain pending, no POST.
 *
 * Flow:
 * 1. Load draft — must be pending_sync
 * 2. Atomically acquire exclusive recovery lease (CAS: pending + no lease)
 * 3. If CAS fails → another caller holds lease → 422
 * 4. Search external_id in Firefly
 * 5. One match with usable IDs → complete synced (with new lease)
 * 6. Malformed → remain pending, no POST, release lease (P0.2)
 * 7. Zero → resend immutable persisted payload (with new lease)
 * 8. >1 → conflict
 * 9. Search failure → remain pending, release lease
 * 10. POST failure → map per error rules, release lease on unknown
 */
export function syncRecoverHandler(config: AppConfig) {
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

      // Only pending_sync drafts are eligible for recovery
      if (draft.syncState !== SyncState.PendingSync) {
        return json(
          { ok: false, message: `Draft #${draftId} is not pending_sync (state: ${draft.syncState})` },
          422,
        );
      }

      // Must have persisted outbound payload
      if (!draft.fireflyOutboundPayload || !draft.fireflyExternalId) {
        return json(
          { ok: false, message: `Draft #${draftId} has no persisted outbound payload — cannot recover` },
          422,
        );
      }

      // P0.1: Atomically acquire exclusive recovery lease BEFORE any Firefly calls.
      // Only the winner (CAS succeeds) proceeds. Losers get 422.
      const lease = acquirePendingSyncRecoveryLease(db, draftId);
      if (!lease) {
        return json(
          { ok: false, message: `Draft #${draftId} recovery lease is held by another caller` },
          422,
        );
      }

      const { outboundPayload, externalId, leaseToken } = lease;

      // Firefly client
      const fireflyCfg: FireflyClientConfig = {
        baseUrl: config.fireflyBaseUrl,
        token: config.fireflyToken,
      };
      const client = createFireflyClient(fireflyCfg);

      // Search first
      const searchRes = await client.searchByExternalId(externalId);
      if (!searchRes.ok) {
        // Search failure → remain pending, release lease, no POST
        markSyncOutcomeUnknown(db, draftId, "FIREFLY_SEARCH_ERROR", searchRes.message, leaseToken);
        return json(
          {
            ok: false,
            message: "Could not verify Firefly state — draft remains pending",
            outcome: "FIREFLY_OUTCOME_UNKNOWN",
            draft: { id: draftId, syncState: "pending_sync" },
          },
          202,
        );
      }

      if (searchRes.data.found && searchRes.data.count > 1) {
        failDraftSync(db, draftId, "FIREFLY_AMBIGUOUS_MATCH", "Multiple Firefly transactions match this external ID", leaseToken);
        return json(
          {
            ok: false,
            message: "Multiple Firefly transactions match this draft — manual resolution required",
            outcome: "FIREFLY_AMBIGUOUS_MATCH",
            draft: { id: draftId, syncState: "sync_failed" },
          },
          409,
        );
      }

      // P0.2: Malformed — found but no usable IDs → remain pending, release lease, must NOT POST
      if (searchRes.data.found && searchRes.data.malformed) {
        markSyncOutcomeUnknown(db, draftId, "FIREFLY_MALFORMED_RESPONSE", "Search returned result but IDs could not be extracted", leaseToken);
        return json(
          {
            ok: false,
            message: "Firefly returned malformed search result — draft remains pending for recovery",
            outcome: "FIREFLY_OUTCOME_UNKNOWN",
            draft: { id: draftId, syncState: "pending_sync" },
          },
          202,
        );
      }

      if (searchRes.data.found && searchRes.data.count === 1 && searchRes.data.groupId && searchRes.data.journalId) {
        const completed = completeDraftSync(db, draftId, searchRes.data.groupId, searchRes.data.journalId, leaseToken);
        if (!completed) {
          return json(
            { ok: false, message: `Draft #${draftId} could not be completed (lease expired or concurrent)` },
            409,
          );
        }
        return json({
          ok: true,
          message: "Draft synced to Firefly (found via recovery search)",
          firefly: {
            groupId: searchRes.data.groupId,
            journalId: searchRes.data.journalId,
            externalId,
          },
          draft: {
            id: completed.id,
            reviewState: completed.reviewState,
            syncState: completed.syncState,
          },
        });
      }

      // Zero matches → resend the immutable persisted payload (with exclusive lease)
      const txRes = await client.createWithdrawal(JSON.parse(outboundPayload));
      if (!txRes.ok) {
        const mapped = mapFireflyErrorToSyncResult(txRes.status, txRes.message);

        if (mapped.outcome === "reject") {
          const failed = failDraftSync(db, draftId, mapped.errorCode, mapped.errorMessage, leaseToken);
          if (!failed) {
            return json(
              { ok: false, message: `Draft #${draftId} could not be updated (lease expired)` },
              409,
            );
          }
          return json(
            {
              ok: false,
              message: mapped.errorMessage,
              outcome: mapped.errorCode,
              draft: { id: draftId, syncState: "sync_failed" },
            },
            mapped.httpStatus,
          );
        } else {
          markSyncOutcomeUnknown(db, draftId, mapped.errorCode, mapped.errorMessage, leaseToken);
          return json(
            {
              ok: false,
              message: "Could not determine transaction outcome — draft remains pending",
              outcome: "FIREFLY_OUTCOME_UNKNOWN",
              draft: { id: draftId, syncState: "pending_sync" },
            },
            202,
          );
        }
      }

      // Success with exclusive lease
      const completed = completeDraftSync(db, draftId, txRes.data.groupId, txRes.data.journalId, leaseToken);
      if (!completed) {
        return json(
          { ok: false, message: `Draft #${draftId} could not be completed (lease expired)` },
          409,
        );
      }
      return json({
        ok: true,
        message: "Draft synced to Firefly (recovery resend succeeded)",
        firefly: {
          groupId: txRes.data.groupId,
          journalId: txRes.data.journalId,
          externalId,
          syncedAt: completed.fireflySyncedAt,
        },
        draft: {
          id: completed.id,
          reviewState: completed.reviewState,
          syncState: completed.syncState,
        },
      });
    } catch (err) {
      // P2: Never expose raw error details to client
      return json({ ok: false, message: "Recovery failed due to an internal error" }, 500);
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
