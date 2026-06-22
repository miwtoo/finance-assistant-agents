import type { Database } from "bun:sqlite";
import type { SlipCandidate } from "../domain/slipScanner";

/** Schema definition for the `slips` table. */
export interface SlipRecord {
  id: number;
  sourcePath: string;
  contentHash: string | null;
  mtime: string | null;
  lifecycleStatus: string;
  duplicateRisk: boolean;
  scanError: string | null;
  parseStatus: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create the `slips` table if it does not already exist.
 * Safe to call multiple times — idempotent.
 */
export function initSlipsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS slips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT NOT NULL UNIQUE,
      content_hash TEXT,
      mtime TEXT,
      lifecycle_status TEXT NOT NULL DEFAULT 'discovered',
      duplicate_risk INTEGER NOT NULL DEFAULT 0,
      scan_error TEXT,
      parse_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Migration compat: add parse_status to existing tables
  try {
    db.run(
      "ALTER TABLE slips ADD COLUMN parse_status TEXT NOT NULL DEFAULT 'pending'",
    );
  } catch {
    // Column already exists — ignore
  }
}

/**
 * Insert or update a slip record from a scanned candidate.
 * Detects duplicate risk: if another record with a different source_path
 * shares the same content_hash, the new/updated record is flagged.
 *
 * Returns the upserted SlipRecord.
 */
export function upsertSlipRecord(
  db: Database,
  candidate: SlipCandidate,
): SlipRecord {
  // Detect duplicate risk: same content_hash from a different source_path
  let duplicateRisk = false;
  if (candidate.contentHash !== null) {
    const existingHashes = db
      .query(
        `SELECT source_path FROM slips
         WHERE content_hash = ? AND source_path != ?`,
      )
      .all(candidate.contentHash, candidate.sourcePath) as {
      source_path: string;
    }[];

    if (existingHashes.length > 0) {
      duplicateRisk = true;
    }
  }

  const mtimeIso = candidate.mtime?.toISOString() ?? null;

  db.run(
    `INSERT INTO slips (source_path, content_hash, mtime, duplicate_risk, scan_error, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(source_path) DO UPDATE SET
       content_hash = excluded.content_hash,
       mtime = excluded.mtime,
       duplicate_risk = excluded.duplicate_risk,
       scan_error = excluded.scan_error,
       updated_at = datetime('now')`,
    [
      candidate.sourcePath,
      candidate.contentHash,
      mtimeIso,
      duplicateRisk ? 1 : 0,
      candidate.error ?? null,
    ],
  );

  const row = db
    .query("SELECT * FROM slips WHERE source_path = ?")
    .get(candidate.sourcePath) as Record<string, unknown>;

  return mapRow(row);
}

/** Return all slip records ordered by newest first (id descending). */
export function getAllSlips(db: Database): SlipRecord[] {
  const rows = db
    .query("SELECT * FROM slips ORDER BY id DESC")
    .all() as Record<string, unknown>[];

  return rows.map(mapRow);
}

/** Return slip records matching the given source paths, ordered newest first. */
export function getSlipsByPaths(db: Database, paths: string[]): SlipRecord[] {
  if (paths.length === 0) return [];
  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .query(`SELECT * FROM slips WHERE source_path IN (${placeholders}) ORDER BY id DESC`)
    .all(...paths) as Record<string, unknown>[];

  return rows.map(mapRow);
}

/** Return a slip record by its id, or null if not found. */
export function getSlipById(db: Database, id: number): SlipRecord | null {
  const row = db
    .query("SELECT * FROM slips WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

function mapRow(row: Record<string, unknown>): SlipRecord {
  return {
    id: row.id as number,
    sourcePath: row.source_path as string,
    contentHash: (row.content_hash as string) ?? null,
    mtime: (row.mtime as string) ?? null,
    lifecycleStatus: row.lifecycle_status as string,
    duplicateRisk: (row.duplicate_risk as number) === 1,
    scanError: (row.scan_error as string) ?? null,
    parseStatus: (row.parse_status as string) ?? "pending",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
