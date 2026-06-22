import type { Database } from "bun:sqlite";

/** Schema for the `parser_runs` table. */
export interface ParserRunRecord {
  id: number;
  slipId: number;
  provider: string;
  model: string | null;
  status: string;
  rawJson: string | null;
  metadata: string | null;
  createdAt: string;
}

/** Input for recording a parser run. */
export interface ParserRunInput {
  slipId: number;
  provider: string;
  model: string | null;
  status: string;
  rawJson: string | null;
  metadata: string | null;
}

/**
 * Create the `parser_runs` table if it does not exist.
 */
export function initParserRunsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS parser_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slip_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      raw_json TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (slip_id) REFERENCES slips(id) ON DELETE CASCADE
    );
  `);
}

/**
 * Insert a parser run record. Returns the inserted ParserRunRecord.
 */
export function insertParserRun(
  db: Database,
  input: ParserRunInput,
): ParserRunRecord {
  db.run(
    `INSERT INTO parser_runs
      (slip_id, provider, model, status, raw_json, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      input.slipId,
      input.provider,
      input.model,
      input.status,
      input.rawJson,
      input.metadata,
    ],
  );
  const row = db
    .query("SELECT * FROM parser_runs WHERE id = last_insert_rowid()")
    .get() as Record<string, unknown>;
  return mapRow(row);
}

/** Get all parser runs for a given slip_id, ordered newest first. */
export function getParserRunsBySlipId(
  db: Database,
  slipId: number,
): ParserRunRecord[] {
  const rows = db
    .query(
      "SELECT * FROM parser_runs WHERE slip_id = ? ORDER BY id DESC",
    )
    .all(slipId) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** Get the latest parser run for a slip_id, or null if none. */
export function getLatestParserRun(
  db: Database,
  slipId: number,
): ParserRunRecord | null {
  const row = db
    .query(
      "SELECT * FROM parser_runs WHERE slip_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(slipId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

function mapRow(row: Record<string, unknown>): ParserRunRecord {
  return {
    id: row.id as number,
    slipId: row.slip_id as number,
    provider: row.provider as string,
    model: (row.model as string) ?? null,
    status: row.status as string,
    rawJson: (row.raw_json as string) ?? null,
    metadata: (row.metadata as string) ?? null,
    createdAt: row.created_at as string,
  };
}
