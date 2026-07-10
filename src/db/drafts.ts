import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { ReviewState, SyncState } from "../domain/types";

// ─── Firefly link persistence ─────────────────────────────────
export interface FireflyLink {
  fireflyJournalId: string | null;
  fireflyGroupId: string | null;
  fireflySyncedAt: string | null;
  fireflyExternalId: string | null;
}

/** Schema for the `drafts` table. */
export interface DraftRecord {
  id: number;
  slipId: number;
  sourcePath: string;
  contentHash: string | null;
  date: string | null;
  amount: string | null;
  currency: string | null;
  parsedCurrency: string | null;
  merchant: string | null;
  parsedMerchant: string | null;
  parsedCategory: string | null;
  sourceIdentifier: string | null;
  sourceAccountHints: string | null;
  sourceAccountName: string | null;
  category: string | null;
  reviewState: string;
  syncState: string;
  duplicateRisk: number;
  hasUncertainty: number;
  userEditedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Firefly link persistence (nullable — added via migration)
  fireflyTransactionId: string | null; // legacy column, kept for backward compat but not written to
  fireflyJournalId: string | null;
  fireflyGroupId: string | null;
  fireflySyncedAt: string | null;
  fireflyExternalId: string | null;
  // Outbound persistence (added via migration)
  fireflyOutboundPayload: string | null;
  fireflyStartedAt: string | null;
  fireflyErrorCode: string | null;
  fireflyErrorMessage: string | null;
  fireflyOutcome: string | null;
  // Recovery lease + revision (added via migration)
  fireflyLeaseToken: string | null;
  fireflyLeaseAcquiredAt: string | null;
  fireflyLeaseExpiresAt: string | null;
  revision: number;
}

// ─── Lease TTL constants ───────────────────────────────────
//
// Invariant: LEASE_TTL_MS ≥ 3 × FIREFLY_REQUEST_TIMEOUT_MS.
//
// A leased workflow (sync or recovery) makes at most two outbound Firefly
// calls — search + POST (or search + complete-from-search) — each bounded
// by FIREFLY_REQUEST_TIMEOUT_MS.  The 3× ratio gives:
//   - 1× for the worst-case two-call workflow
//   - 1× margin for scheduling/processing overhead
//   - 1× grace so that a lease acquired late in the window still covers
//     the full workflow before expiry
//
// Any change to either constant must preserve: TTL ≥ 3 × timeout.

/** Request timeout for Firefly HTTP calls. */
export const FIREFLY_REQUEST_TIMEOUT_MS = 20_000;

/** Lease TTL in ms. Must be ≥ 3 × FIREFLY_REQUEST_TIMEOUT_MS. */
export const LEASE_TTL_MS = 60_000;

/** Input for creating or updating a draft. */
export interface DraftInput {
  slipId: number;
  sourcePath: string;
  contentHash: string | null;
  date: string | null;
  amount: string | null;
  currency: string | null;
  parsedCurrency: string | null;
  merchant: string | null;
  parsedMerchant: string | null;
  parsedCategory: string | null;
  sourceIdentifier: string | null;
  sourceAccountHints: string | null;
  sourceAccountName: string | null;
  category: string | null;
  reviewState: ReviewState;
  syncState: SyncState;
  duplicateRisk: boolean;
  hasUncertainty: boolean;
  userEditedAt?: string | null;
}

// ─── Installation ID ─────────────────────────────────────────

/**
 * Get or create the persistent installation ID.
 * Stored in the `app_metadata` singleton table.
 * Uses INSERT OR IGNORE + reread for concurrent init safety.
 */
export function getOrCreateInstallationId(db: Database): string {
  db.run(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Try read first (fast path)
  const row = db
    .query("SELECT value FROM app_metadata WHERE key = ?")
    .get("installation_id") as { value: string } | undefined;
  if (row) return row.value;
  // INSERT OR IGNORE handles concurrent init: one wins, others ignore
  const id = randomUUID();
  db.run(
    "INSERT OR IGNORE INTO app_metadata (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ["installation_id", id],
  );
  // Reread to get the value that actually won
  const winner = db
    .query("SELECT value FROM app_metadata WHERE key = ?")
    .get("installation_id") as { value: string };
  return winner.value;
}

/**
 * Build the stable namespaced external ID for a draft.
 * Format: finance-assistant:<installationId>:draft:<draftId>
 */
export function buildExternalId(
  installationId: string,
  draftId: number,
): string {
  return `finance-assistant:${installationId}:draft:${draftId}`;
}

// ─── Table init + migrations ─────────────────────────────────

/**
 * Create the `drafts` table if it does not exist.
 * Strictly additive migrations: preflight PRAGMA table_info, only add missing columns.
 *
 * Migration concurrency: ALTER TABLE ADD COLUMN is idempotent under SQLite —
 * if the column already exists, SQLite raises "duplicate column name" which we
 * tolerate. CREATE TABLE IF NOT EXISTS is inherently safe. This makes
 * concurrent app initialization safe without explicit transaction wrapping.
 */
export function initDraftsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slip_id INTEGER NOT NULL UNIQUE,
      source_path TEXT NOT NULL,
      content_hash TEXT,
      date TEXT,
      amount TEXT,
      currency TEXT,
      parsed_currency TEXT,
      merchant TEXT,
      parsed_merchant TEXT,
      parsed_category TEXT,
      source_identifier TEXT,
      source_account_hints TEXT,
      source_account_name TEXT,
      category TEXT,
      review_state TEXT NOT NULL DEFAULT 'parsed',
      sync_state TEXT NOT NULL DEFAULT 'unsynced',
      duplicate_risk INTEGER NOT NULL DEFAULT 0,
      has_uncertainty INTEGER NOT NULL DEFAULT 0,
      user_edited_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (slip_id) REFERENCES slips(id) ON DELETE CASCADE
    );
  `);
  // Strictly additive migrations — check PRAGMA table_info first
  const existingColumns = getColumnNames(db, "drafts");
  const migrations: Array<[string, string]> = [
    ["firefly_transaction_id", "TEXT"],       // legacy column, kept for backward compat
    ["firefly_journal_id", "TEXT"],
    ["firefly_group_id", "TEXT"],
    ["firefly_synced_at", "TEXT"],
    ["firefly_external_id", "TEXT"],
    ["firefly_outbound_payload", "TEXT"],
    ["firefly_started_at", "TEXT"],
    ["firefly_error_code", "TEXT"],
    ["firefly_error_message", "TEXT"],
    ["firefly_outcome", "TEXT"],
    ["firefly_lease_token", "TEXT"],
    ["firefly_lease_acquired_at", "TEXT"],
    ["firefly_lease_expires_at", "TEXT"],
    ["revision", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [col, type] of migrations) {
    if (!existingColumns.has(col)) {
      try {
        db.run(`ALTER TABLE drafts ADD COLUMN ${col} ${type}`);
      } catch (e: any) {
        // Tolerate "duplicate column name" from concurrent migration
        if (!e?.message?.includes("duplicate column")) throw e;
      }
    }
  }
}

/**
 * Get column names for a table via PRAGMA table_info.
 */
function getColumnNames(db: Database, table: string): Set<string> {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

// ─── Standard CRUD ───────────────────────────────────────────

/**
 * Insert a new draft record. Returns the inserted DraftRecord.
 * Throws if a draft for this slip_id already exists.
 */
export function insertDraft(db: Database, input: DraftInput): DraftRecord {
  db.run(
    `INSERT INTO drafts
      (slip_id, source_path, content_hash, date, amount, currency,
       parsed_currency, merchant, parsed_merchant, parsed_category,
       source_identifier, source_account_hints, source_account_name,
       category, review_state, sync_state, duplicate_risk, has_uncertainty,
       user_edited_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      input.slipId,
      input.sourcePath,
      input.contentHash,
      input.date,
      input.amount,
      input.currency,
      input.parsedCurrency,
      input.merchant,
      input.parsedMerchant,
      input.parsedCategory,
      input.sourceIdentifier,
      input.sourceAccountHints,
      input.sourceAccountName,
      input.category,
      input.reviewState,
      input.syncState,
      input.duplicateRisk ? 1 : 0,
      input.hasUncertainty ? 1 : 0,
      input.userEditedAt ?? null,
    ],
  );
  const row = db
    .query("SELECT * FROM drafts WHERE slip_id = ?")
    .get(input.slipId) as Record<string, unknown>;
  return mapRow(row);
}

/**
 * Upsert a draft record: insert or replace existing draft for this slip_id.
 * Returns the upserted DraftRecord.
 */
export function upsertDraft(db: Database, input: DraftInput): DraftRecord {
  db.run(
    `INSERT INTO drafts
      (slip_id, source_path, content_hash, date, amount, currency,
       parsed_currency, merchant, parsed_merchant, parsed_category,
       source_identifier, source_account_hints, source_account_name,
       category, review_state, sync_state, duplicate_risk, has_uncertainty,
       user_edited_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(slip_id) DO UPDATE SET
       source_path = excluded.source_path,
       content_hash = excluded.content_hash,
       date = excluded.date,
       amount = excluded.amount,
       currency = excluded.currency,
       parsed_currency = excluded.parsed_currency,
       merchant = excluded.merchant,
       parsed_merchant = excluded.parsed_merchant,
       parsed_category = excluded.parsed_category,
       source_identifier = excluded.source_identifier,
       source_account_hints = excluded.source_account_hints,
       source_account_name = excluded.source_account_name,
       category = excluded.category,
       review_state = excluded.review_state,
       sync_state = excluded.sync_state,
       duplicate_risk = excluded.duplicate_risk,
       has_uncertainty = excluded.has_uncertainty,
       user_edited_at = excluded.user_edited_at,
       updated_at = datetime('now')`,
    [
      input.slipId,
      input.sourcePath,
      input.contentHash,
      input.date,
      input.amount,
      input.currency,
      input.parsedCurrency,
      input.merchant,
      input.parsedMerchant,
      input.parsedCategory,
      input.sourceIdentifier,
      input.sourceAccountHints,
      input.sourceAccountName,
      input.category,
      input.reviewState,
      input.syncState,
      input.duplicateRisk ? 1 : 0,
      input.hasUncertainty ? 1 : 0,
      input.userEditedAt ?? null,
    ],
  );
  const row = db
    .query("SELECT * FROM drafts WHERE slip_id = ?")
    .get(input.slipId) as Record<string, unknown>;
  return mapRow(row);
}

/** Get a draft by its id. Returns null if not found. */
export function getDraft(db: Database, id: number): DraftRecord | null {
  const row = db
    .query("SELECT * FROM drafts WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/** Get a draft by slip_id. Returns null if not found. */
export function getDraftBySlipId(
  db: Database,
  slipId: number,
): DraftRecord | null {
  const row = db
    .query("SELECT * FROM drafts WHERE slip_id = ?")
    .get(slipId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/** Get all drafts, ordered by newest first. */
export function getAllDrafts(db: Database): DraftRecord[] {
  const rows = db
    .query("SELECT * FROM drafts ORDER BY id DESC")
    .all() as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** Get drafts matching a specific review state. */
export function getDraftsByReviewState(
  db: Database,
  state: string,
): DraftRecord[] {
  const rows = db
    .query("SELECT * FROM drafts WHERE review_state = ? ORDER BY id DESC")
    .all(state) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Update a single field on a draft by id. Returns the updated record.
 * Increments revision on every write (P1.4 invariant: every user edit or
 * state-changing modification increments revision).
 */
export function updateDraftField(
  db: Database,
  id: number,
  field: string,
  value: string | number | null,
): DraftRecord {
  const allowedFields = new Set([
    "date",
    "amount",
    "currency",
    "merchant",
    "parsed_merchant",
    "parsed_category",
    "source_identifier",
    "source_account_hints",
    "source_account_name",
    "category",
    "review_state",
    "sync_state",
    "duplicate_risk",
    "has_uncertainty",
    "user_edited_at",
  ]);
  const colMap: Record<string, string> = {
    parsedMerchant: "parsed_merchant",
    parsedCategory: "parsed_category",
    sourceIdentifier: "source_identifier",
    sourceAccountHints: "source_account_hints",
    sourceAccountName: "source_account_name",
    reviewState: "review_state",
    syncState: "sync_state",
    duplicateRisk: "duplicate_risk",
    hasUncertainty: "has_uncertainty",
    userEditedAt: "user_edited_at",
  };
  const col = colMap[field] ?? field;
  if (!allowedFields.has(col)) {
    throw new Error(`Invalid field: ${field}`);
  }
  // Increment revision on every write (P1.4)
  db.run(
    `UPDATE drafts SET ${col} = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = ?`,
    [value, id],
  );
  const row = db
    .query("SELECT * FROM drafts WHERE id = ?")
    .get(id) as Record<string, unknown>;
  return mapRow(row);
}

/** Delete draft by slip_id. Returns true if a row was deleted. */
export function deleteDraftBySlipId(
  db: Database,
  slipId: number,
): boolean {
  const result = db.run("DELETE FROM drafts WHERE slip_id = ?", [slipId]);
  return (result.changes ?? 0) > 0;
}

// ─── Sync state management ───────────────────────────────────

/**
 * Block edits on drafts that are pending_sync or synced.
 * Returns true if the draft is in a mutable state, false if blocked.
 */
export function isDraftMutable(db: Database, id: number): boolean {
  const draft = getDraft(db, id);
  if (!draft) return false;
  return draft.syncState !== "pending_sync" && draft.syncState !== "synced";
}

/**
 * Atomic CAS claim: transition from ready+unsynced+not-duplicate-risk
 * to pending_sync. Writes outbound payload + started timestamp + external ID
 * + lease token. Includes expected revision to prevent stale payload ABA.
 *
 * P1.4 Invariant: After account fetch, the caller MUST re-read the draft
 * inside this claim transaction and build the payload from the snapshot.
 * The payload passed here is built from the same snapshot that passed the
 * revision check, preventing stale payload ABA where an edit races with sync.
 *
 * Returns the updated draft if claim succeeded, null if CAS failed
 * (draft not in expected state or revision mismatch).
 */
export function claimDraftForSync(
  db: Database,
  id: number,
  installationId: string,
  outboundPayload: string,
  expectedRevision: number,
): DraftRecord | null {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  const externalId = buildExternalId(installationId, id);
  const leaseToken = randomUUID();

  // CAS: only claim if ready + unsynced + no duplicate risk + revision matches
  const result = db.run(
    `UPDATE drafts SET
      sync_state = 'pending_sync',
      firefly_outbound_payload = ?,
      firefly_started_at = ?,
      firefly_external_id = ?,
      firefly_lease_token = ?,
      firefly_lease_acquired_at = ?,
      firefly_lease_expires_at = ?,
      updated_at = datetime('now')
    WHERE id = ?
      AND review_state = 'ready'
      AND sync_state = 'unsynced'
      AND duplicate_risk = 0
      AND revision = ?`,
    [outboundPayload, now, externalId, leaseToken, now, expiresAt, id, expectedRevision],
  );

  if ((result.changes ?? 0) === 0) return null;
  return getDraft(db, id)!;
}

/**
 * Atomically acquire an exclusive recovery lease on a pending_sync draft.
 *
 * CAS: succeeds when firefly_lease_token IS NULL (no holder) OR
 * firefly_lease_expires_at < now (expired/stale from crashed process).
 * Assigns a new random lease token with fresh expiry.
 *
 * Returns null if CAS fails (another caller holds a valid lease, or draft not pending).
 */
export function acquirePendingSyncRecoveryLease(
  db: Database,
  id: number,
): { outboundPayload: string; externalId: string; leaseToken: string } | null {
  const newLease = randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();

  // CAS: acquire when no holder OR lease has expired
  const result = db.run(
    `UPDATE drafts SET
      firefly_lease_token = ?,
      firefly_lease_acquired_at = ?,
      firefly_lease_expires_at = ?,
      updated_at = datetime('now')
    WHERE id = ?
      AND sync_state = 'pending_sync'
      AND (firefly_lease_token IS NULL OR firefly_lease_expires_at < ?)`,
    [newLease, now, expiresAt, id, now],
  );
  if ((result.changes ?? 0) === 0) return null;

  const draft = getDraft(db, id)!;
  if (!draft.fireflyOutboundPayload || !draft.fireflyExternalId) return null;
  return {
    outboundPayload: draft.fireflyOutboundPayload,
    externalId: draft.fireflyExternalId,
    leaseToken: newLease,
  };
}

/**
 * Complete a synced draft: set group/journal IDs, synced timestamp, mark synced+approved.
 * Only succeeds if draft is pending_sync with matching lease token.
 * Clears the lease token (terminal state — lease no longer needed).
 * Never downgrades synced state.
 */
export function completeDraftSync(
  db: Database,
  id: number,
  groupId: string,
  journalId: string,
  leaseToken: string,
): DraftRecord | null {
  const now = new Date().toISOString();
  // P0.8: Canonical output persists group + journal only.
  // Legacy firefly_transaction_id column is left null/unused.
  const result = db.run(
    `UPDATE drafts SET
      firefly_group_id = ?,
      firefly_journal_id = ?,
      firefly_transaction_id = NULL,
      firefly_synced_at = ?,
      firefly_outcome = NULL,
      firefly_error_code = NULL,
      firefly_error_message = NULL,
      firefly_lease_token = NULL,
      firefly_lease_acquired_at = NULL,
      firefly_lease_expires_at = NULL,
      sync_state = 'synced',
      review_state = 'approved',
      updated_at = datetime('now')
    WHERE id = ?
      AND sync_state = 'pending_sync'
      AND firefly_lease_token = ?`,
    [groupId, journalId, now, id, leaseToken],
  );
  if ((result.changes ?? 0) === 0) return null;
  return getDraft(db, id)!;
}

/**
 * Mark sync as failed with sanitized error info.
 * For definite rejections (validation 400/422, duplicate, auth/contract/rate limit).
 * Only succeeds if draft is pending_sync with matching lease token.
 * Clears the lease token (terminal state).
 */
export function failDraftSync(
  db: Database,
  id: number,
  errorCode: string,
  errorMessage: string,
  leaseToken: string,
): DraftRecord | null {
  const result = db.run(
    `UPDATE drafts SET
      firefly_error_code = ?,
      firefly_error_message = ?,
      firefly_outcome = NULL,
      firefly_lease_token = NULL,
      firefly_lease_acquired_at = NULL,
      firefly_lease_expires_at = NULL,
      sync_state = 'sync_failed',
      updated_at = datetime('now')
    WHERE id = ?
      AND sync_state = 'pending_sync'
      AND firefly_lease_token = ?`,
    [errorCode, errorMessage, id, leaseToken],
  );
  if ((result.changes ?? 0) === 0) return null;
  return getDraft(db, id)!;
}

/**
 * Mark sync as outcome unknown (network/timeout/5xx/malformed).
 * Draft stays pending_sync for recovery.
 * Clears the lease token (recovery lease released) while preserving pending state.
 * Only succeeds if draft is pending_sync with matching lease token.
 */
export function markSyncOutcomeUnknown(
  db: Database,
  id: number,
  errorCode: string,
  errorMessage: string,
  leaseToken: string,
): DraftRecord | null {
  const result = db.run(
    `UPDATE drafts SET
      firefly_outcome = 'FIREFLY_OUTCOME_UNKNOWN',
      firefly_error_code = ?,
      firefly_error_message = ?,
      firefly_lease_token = NULL,
      firefly_lease_acquired_at = NULL,
      firefly_lease_expires_at = NULL,
      updated_at = datetime('now')
    WHERE id = ?
      AND sync_state = 'pending_sync'
      AND firefly_lease_token = ?`,
    [errorCode, errorMessage, id, leaseToken],
  );
  if ((result.changes ?? 0) === 0) return null;
  return getDraft(db, id)!;
}

// ─── P1.5: sync_failed safe exit ─────────────────────────────

/**
 * Whether a sync_failed error code is retryable (operational/validation).
 * Duplicate and ambiguous are non-retryable — user must resolve manually.
 */
export function isRetryableSyncFailure(errorCode: string): boolean {
  return (
    errorCode === "FIREFLY_VALIDATION_ERROR" ||
    errorCode === "FIREFLY_AUTH_ERROR" ||
    errorCode === "FIREFLY_RATE_LIMIT" ||
    errorCode === "FIREFLY_SERVER_ERROR" ||
    errorCode === "FIREFLY_NETWORK_ERROR" ||
    errorCode === "FIREFLY_OUTCOME_UNKNOWN" ||
    errorCode === "FIREFLY_SEARCH_ERROR" ||
    errorCode === "FIREFLY_UNKNOWN_ERROR"
  );
}

/**
 * Reset a retryable sync_failed draft back to unsynced + needs_review.
 * Clears persisted request/error state. Only works for retryable failures.
 * Non-retryable (duplicate, ambiguous) stay blocked.
 *
 * Returns the updated draft if successful, null if not eligible.
 */
export function resetSyncFailedDraft(
  db: Database,
  id: number,
): DraftRecord | null {
  const draft = getDraft(db, id);
  if (!draft) return null;
  if (draft.syncState !== "sync_failed") return null;
  if (!draft.fireflyErrorCode || !isRetryableSyncFailure(draft.fireflyErrorCode)) {
    return null; // non-retryable
  }
  db.run(
    `UPDATE drafts SET
      sync_state = 'unsynced',
      review_state = 'needs_review',
      firefly_outbound_payload = NULL,
      firefly_started_at = NULL,
      firefly_error_code = NULL,
      firefly_error_message = NULL,
      firefly_outcome = NULL,
      firefly_lease_token = NULL,
      firefly_lease_acquired_at = NULL,
      firefly_lease_expires_at = NULL,
      firefly_external_id = NULL,
      revision = revision + 1,
      updated_at = datetime('now')
    WHERE id = ?`,
    [id],
  );
  return getDraft(db, id)!;
}

// ─── Helpers ──────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): DraftRecord {
  return {
    id: row.id as number,
    slipId: row.slip_id as number,
    sourcePath: row.source_path as string,
    contentHash: (row.content_hash as string) ?? null,
    date: (row.date as string) ?? null,
    amount: (row.amount as string) ?? null,
    currency: (row.currency as string) ?? null,
    parsedCurrency: (row.parsed_currency as string) ?? null,
    merchant: (row.merchant as string) ?? null,
    parsedMerchant: (row.parsed_merchant as string) ?? null,
    parsedCategory: (row.parsed_category as string) ?? null,
    sourceIdentifier: (row.source_identifier as string) ?? null,
    sourceAccountHints: (row.source_account_hints as string) ?? null,
    sourceAccountName: (row.source_account_name as string) ?? null,
    category: (row.category as string) ?? null,
    reviewState: row.review_state as string,
    syncState: row.sync_state as string,
    duplicateRisk: (row.duplicate_risk as number) === 1 ? 1 : 0,
    hasUncertainty: (row.has_uncertainty as number) === 1 ? 1 : 0,
    userEditedAt: (row.user_edited_at as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    // Firefly link fields
    fireflyTransactionId: (row.firefly_transaction_id as string) ?? null,
    fireflyJournalId: (row.firefly_journal_id as string) ?? null,
    fireflyGroupId: (row.firefly_group_id as string) ?? null,
    fireflySyncedAt: (row.firefly_synced_at as string) ?? null,
    fireflyExternalId: (row.firefly_external_id as string) ?? null,
    // Outbound persistence fields
    fireflyOutboundPayload: (row.firefly_outbound_payload as string) ?? null,
    fireflyStartedAt: (row.firefly_started_at as string) ?? null,
    fireflyErrorCode: (row.firefly_error_code as string) ?? null,
    fireflyErrorMessage: (row.firefly_error_message as string) ?? null,
    fireflyOutcome: (row.firefly_outcome as string) ?? null,
    // Lease + revision
    fireflyLeaseToken: (row.firefly_lease_token as string) ?? null,
    fireflyLeaseAcquiredAt: (row.firefly_lease_acquired_at as string) ?? null,
    fireflyLeaseExpiresAt: (row.firefly_lease_expires_at as string) ?? null,
    revision: (row.revision as number) ?? 0,
  };
}
