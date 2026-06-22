import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initSlipsTable, upsertSlipRecord, getAllSlips, getSlipsByPaths } from "../../src/db/slips";
import type { SlipCandidate } from "../../src/domain/slipScanner";

describe("slips db", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initSlipsTable(db);
  });

  afterAll(() => {
    db.close();
  });

  it("creates the slips table on init", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='slips'")
      .all();
    expect(tables.length).toBe(1);
  });

  it("has parse_status column defaulting to 'pending'", () => {
    const cols = db.query("PRAGMA table_info('slips')").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("parse_status");
    // Verify default via insert then read
    db.run("INSERT INTO slips (source_path) VALUES ('/tmp/parse-test.jpg')");
    const row = db.query("SELECT parse_status FROM slips WHERE source_path = ?").get("/tmp/parse-test.jpg") as Record<string, unknown>;
    expect(row.parse_status).toBe("pending");
    db.run("DELETE FROM slips WHERE source_path = '/tmp/parse-test.jpg'");
  });

  it("inserts a new slip record from a candidate", () => {
    const candidate: SlipCandidate = {
      sourcePath: "/tmp/test/receipt.jpg",
      contentHash: "a".repeat(64),
      mtime: new Date("2025-06-22T10:00:00Z"),
    };
    const record = upsertSlipRecord(db, candidate);
    expect(record.sourcePath).toBe("/tmp/test/receipt.jpg");
    expect(record.contentHash).toBe("a".repeat(64));
    expect(record.lifecycleStatus).toBe("discovered");
    expect(record.duplicateRisk).toBe(false);
    expect(record.mtime).toBe("2025-06-22T10:00:00.000Z");
    expect(record.scanError).toBeNull();
    expect(record.parseStatus).toBe("pending");
    expect(record.id).toBeGreaterThan(0);
  });

  it("upsert is idempotent — re-inserting same sourcePath updates rather than duplicates", () => {
    const candidate: SlipCandidate = {
      sourcePath: "/tmp/test/receipt.jpg",
      contentHash: "b".repeat(64),
      mtime: new Date("2025-06-22T12:00:00Z"),
    };
    const record = upsertSlipRecord(db, candidate);
    const all = getAllSlips(db);
    const matches = all.filter((s) => s.sourcePath === "/tmp/test/receipt.jpg");
    expect(matches.length).toBe(1);
    expect(record.contentHash).toBe("b".repeat(64));
    expect(record.mtime).toBe("2025-06-22T12:00:00.000Z");
  });

  it("flags duplicate_risk when same contentHash exists from different sourcePath", () => {
    const original: SlipCandidate = {
      sourcePath: "/tmp/test/original.jpg",
      contentHash: "dup-hash-value-123",
      mtime: new Date("2025-06-22T10:00:00Z"),
    };
    upsertSlipRecord(db, original);

    const duplicate: SlipCandidate = {
      sourcePath: "/tmp/test/duplicate.jpg",
      contentHash: "dup-hash-value-123",
      mtime: new Date("2025-06-22T11:00:00Z"),
    };
    const record = upsertSlipRecord(db, duplicate);
    expect(record.duplicateRisk).toBe(true);
  });

  it("does not flag duplicate_risk for same sourcePath (re-scan of same file)", () => {
    const candidate: SlipCandidate = {
      sourcePath: "/tmp/test/re-rescan.jpg",
      contentHash: "re-scan-hash",
      mtime: new Date("2025-06-22T10:00:00Z"),
    };
    upsertSlipRecord(db, candidate);
    const reRecord = upsertSlipRecord(db, candidate);
    expect(reRecord.duplicateRisk).toBe(false);
  });

  it("getAllSlips returns all records ordered by created_at desc", () => {
    const candidate1: SlipCandidate = {
      sourcePath: "/tmp/test/first.jpg",
      contentHash: "hash-first",
      mtime: new Date("2025-01-01T00:00:00Z"),
    };
    const candidate2: SlipCandidate = {
      sourcePath: "/tmp/test/second.jpg",
      contentHash: "hash-second",
      mtime: new Date("2025-06-01T00:00:00Z"),
    };
    upsertSlipRecord(db, candidate1);
    upsertSlipRecord(db, candidate2);

    const all = getAllSlips(db);
    const idx1 = all.findIndex((s) => s.sourcePath.endsWith("first.jpg"));
    const idx2 = all.findIndex((s) => s.sourcePath.endsWith("second.jpg"));
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeLessThan(idx1); // second.jpg inserted after first.jpg, so appears first
  });

  it("handles candidate with null contentHash and error", () => {
    const broken: SlipCandidate = {
      sourcePath: "/tmp/test/unreadable.jpg",
      contentHash: null,
      mtime: new Date("2025-06-22T10:00:00Z"),
      error: "Permission denied",
    };
    const record = upsertSlipRecord(db, broken);
    expect(record.contentHash).toBeNull();
    expect(record.scanError).toBe("Permission denied");
    expect(record.duplicateRisk).toBe(false);
  });

  it("handles candidate with null mtime", () => {
    const noMtime: SlipCandidate = {
      sourcePath: "/tmp/test/nomtime.jpg",
      contentHash: "hash-no-mtime",
      mtime: null,
    };
    const record = upsertSlipRecord(db, noMtime);
    expect(record.mtime).toBeNull();
  });

  it("getSlipsByPaths returns only matching records", () => {
    const paths = ["/tmp/test/receipt.jpg", "/tmp/test/original.jpg"];
    const records = getSlipsByPaths(db, paths);
    expect(records.length).toBe(2);
    for (const r of records) {
      expect(paths).toContain(r.sourcePath);
    }
  });

  it("getSlipsByPaths returns empty array for no match", () => {
    const records = getSlipsByPaths(db, ["/tmp/test/nonexistent.jpg"]);
    expect(records.length).toBe(0);
  });
});
