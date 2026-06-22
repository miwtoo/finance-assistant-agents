import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initParserRunsTable, insertParserRun, getParserRunsBySlipId, getLatestParserRun } from "../src/db/parserRuns";

describe("parser_runs db", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initParserRunsTable(db);
  });

  afterAll(() => {
    db.close();
  });

  it("creates the parser_runs table on init", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='parser_runs'")
      .all();
    expect(tables.length).toBe(1);
  });

  it("inserts a parser run record", () => {
    const run = insertParserRun(db, {
      slipId: 1,
      provider: "gemini",
      model: "gemini-1.5-flash",
      status: "success",
      rawJson: JSON.stringify({ amount: "123.45" }),
      metadata: JSON.stringify({ confidence: "high" }),
    });
    expect(run.id).toBeGreaterThan(0);
    expect(run.slipId).toBe(1);
    expect(run.provider).toBe("gemini");
    expect(run.model).toBe("gemini-1.5-flash");
    expect(run.status).toBe("success");
    expect(run.rawJson).toBe(JSON.stringify({ amount: "123.45" }));
  });

  it("inserts a parser run with null fields", () => {
    const run = insertParserRun(db, {
      slipId: 2,
      provider: "fake",
      model: null,
      status: "failed",
      rawJson: null,
      metadata: null,
    });
    expect(run.id).toBeGreaterThan(0);
    expect(run.provider).toBe("fake");
    expect(run.model).toBeNull();
    expect(run.rawJson).toBeNull();
    expect(run.metadata).toBeNull();
  });

  it("getParserRunsBySlipId returns runs for a slip, ordered newest first", () => {
    insertParserRun(db, {
      slipId: 10,
      provider: "fake",
      model: "v1",
      status: "failed",
      rawJson: null,
      metadata: null,
    });
    insertParserRun(db, {
      slipId: 10,
      provider: "fake",
      model: "v2",
      status: "success",
      rawJson: JSON.stringify({ amount: "50" }),
      metadata: null,
    });

    const runs = getParserRunsBySlipId(db, 10);
    expect(runs.length).toBe(2);
    expect(runs[0].model).toBe("v2"); // newest first
    expect(runs[1].model).toBe("v1"); // oldest last
  });

  it("getLatestParserRun returns most recent run for a slip", () => {
    const run = getLatestParserRun(db, 10);
    expect(run).not.toBeNull();
    expect(run!.model).toBe("v2");
  });

  it("getLatestParserRun returns null when no runs exist", () => {
    const run = getLatestParserRun(db, 999);
    expect(run).toBeNull();
  });

  it("stores raw JSON as text for audit trail", () => {
    const rawJson = JSON.stringify({
      date: "2025-06-22",
      amount: "123.45",
      currency: "THB",
      merchant: "7-Eleven",
    });
    const run = insertParserRun(db, {
      slipId: 20,
      provider: "gemini",
      model: null,
      status: "success",
      rawJson,
      metadata: JSON.stringify({ confidence: "high", tokens: 150 }),
    });
    expect(run.rawJson).toBe(rawJson);
    expect(run.metadata).toBe(
      JSON.stringify({ confidence: "high", tokens: 150 }),
    );
  });
});
