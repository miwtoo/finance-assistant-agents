import type { Database } from "bun:sqlite";
import type {
  ReviewState,
  SyncState,
  CurrencyCode,
} from "../domain/types";

/** Schema for the `drafts` table. */
export interface DraftRecord {
  id: number;
  slipId: number;
  sourcePath: string;
  contentHash: string | null;
  date: string | null;
  amount: string | null;
  currency: string | null;
  merchant: string | null;
  parsedMerchant: string | null;
  sourceIdentifier: string | null;
  sourceAccountName: string | null;
  category: string | null;
  reviewState: string;
  syncState: string;
  duplicateRisk: number;
  hasUncertainty: number;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating or updating a draft. */
export interface DraftInput {
  slipId: number;
  sourcePath: string;
  contentHash: string | null;
  date: string | null;
  amount: string | null;
  currency: string | null;
  merchant: string | null;
  parsedMerchant: string | null;
  sourceIdentifier: string | null;
  sourceAccountName: string | null;
  category: string | null;
  reviewState: ReviewState;
  syncState: SyncState;
  duplicateRisk: boolean;
  hasUncertainty: boolean;
}

/**
 * Create the `drafts` table if it does not exist.
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
      merchant TEXT,
      parsed_merchant TEXT,
      source_identifier TEXT,
      source_account_name TEXT,
      category TEXT,
      review_state TEXT NOT NULL DEFAULT 'parsed',
      sync_state TEXT NOT NULL DEFAULT 'unsynced',
      duplicate_risk INTEGER NOT NULL DEFAULT 0,
      has_uncertainty INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (slip_id) REFERENCES slips(id) ON DELETE CASCADE
    );
  `);
}

/**
 * Insert a new draft record. Returns the inserted DraftRecord.
 * Throws if a draft for this slip_id already exists.
 */
export function insertDraft(db: Database, input: DraftInput): DraftRecord {
  db.run(
    `INSERT INTO drafts
      (slip_id, source_path, content_hash, date, amount, currency,
       merchant, parsed_merchant, source_identifier, source_account_name,
       category, review_state, sync_state, duplicate_risk, has_uncertainty,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      input.slipId,
      input.sourcePath,
      input.contentHash,
      input.date,
      input.amount,
      input.currency,
      input.merchant,
      input.parsedMerchant,
      input.sourceIdentifier,
      input.sourceAccountName,
      input.category,
      input.reviewState,
      input.syncState,
      input.duplicateRisk ? 1 : 0,
      input.hasUncertainty ? 1 : 0,
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
       merchant, parsed_merchant, source_identifier, source_account_name,
       category, review_state, sync_state, duplicate_risk, has_uncertainty,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(slip_id) DO UPDATE SET
       source_path = excluded.source_path,
       content_hash = excluded.content_hash,
       date = excluded.date,
       amount = excluded.amount,
       currency = excluded.currency,
       merchant = excluded.merchant,
       parsed_merchant = excluded.parsed_merchant,
       source_identifier = excluded.source_identifier,
       source_account_name = excluded.source_account_name,
       category = excluded.category,
       review_state = excluded.review_state,
       sync_state = excluded.sync_state,
       duplicate_risk = excluded.duplicate_risk,
       has_uncertainty = excluded.has_uncertainty,
       updated_at = datetime('now')`,
    [
      input.slipId,
      input.sourcePath,
      input.contentHash,
      input.date,
      input.amount,
      input.currency,
      input.merchant,
      input.parsedMerchant,
      input.sourceIdentifier,
      input.sourceAccountName,
      input.category,
      input.reviewState,
      input.syncState,
      input.duplicateRisk ? 1 : 0,
      input.hasUncertainty ? 1 : 0,
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

/** Update a single field on a draft by id. Returns the updated record. */
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
    "source_identifier",
    "source_account_name",
    "category",
    "review_state",
    "sync_state",
    "duplicate_risk",
    "has_uncertainty",
  ]);
  // Map camelCase field names to snake_case columns
  const colMap: Record<string, string> = {
    parsedMerchant: "parsed_merchant",
    sourceIdentifier: "source_identifier",
    sourceAccountName: "source_account_name",
    reviewState: "review_state",
    syncState: "sync_state",
    duplicateRisk: "duplicate_risk",
    hasUncertainty: "has_uncertainty",
  };
  const col = colMap[field] ?? field;
  if (!allowedFields.has(col)) {
    throw new Error(`Invalid field: ${field}`);
  }
  db.run(
    `UPDATE drafts SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`,
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

function mapRow(row: Record<string, unknown>): DraftRecord {
  return {
    id: row.id as number,
    slipId: row.slip_id as number,
    sourcePath: row.source_path as string,
    contentHash: (row.content_hash as string) ?? null,
    date: (row.date as string) ?? null,
    amount: (row.amount as string) ?? null,
    currency: (row.currency as string) ?? null,
    merchant: (row.merchant as string) ?? null,
    parsedMerchant: (row.parsed_merchant as string) ?? null,
    sourceIdentifier: (row.source_identifier as string) ?? null,
    sourceAccountName: (row.source_account_name as string) ?? null,
    category: (row.category as string) ?? null,
    reviewState: row.review_state as string,
    syncState: row.sync_state as string,
    duplicateRisk: (row.duplicate_risk as number) === 1 ? 1 : 0,
    hasUncertainty: (row.has_uncertainty as number) === 1 ? 1 : 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
