import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

/**
 * Open (or create) a SQLite database at `dbPath`, enabling WAL mode
 * and foreign key enforcement.
 * Creates parent directories if they do not exist.
 */
export function openDatabase(dbPath: string): Database {
  // Ensure the parent directory exists
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  // Enable WAL mode for better concurrent-read performance
  db.run("PRAGMA journal_mode = WAL;");
  // Enforce foreign key constraints
  db.run("PRAGMA foreign_keys = ON;");
  return db;
}
