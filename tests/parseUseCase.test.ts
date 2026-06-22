import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initSlipsTable, upsertSlipRecord } from "../src/db/slips";
import { initDraftsTable, getDraftBySlipId, getAllDrafts } from "../src/db/drafts";
import { initParserRunsTable, getParserRunsBySlipId, getLatestParserRun } from "../src/db/parserRuns";
import { parseSlipToDraftAsync, markDraftReady } from "../src/domain/draftService";
import { ParserRunStatus, ReviewState } from "../src/domain/types";
import { FakeParser } from "./fakes/fakeParser";
import type { SlipCandidate } from "../src/domain/slipScanner";

describe("parseSlipToDraftAsync — use-case integration", () => {
  let db: Database;

  function insertSlip(
    path: string,
    contentHash?: string,
  ): { id: number; path: string; hash: string } {
    const hash = contentHash ?? "hash-" + path;
    const candidate: SlipCandidate = {
      sourcePath: path,
      contentHash: hash,
      mtime: new Date(),
    };
    const record = upsertSlipRecord(db, candidate);
    return { id: record.id, path, hash };
  }

  beforeAll(() => {
    db = new Database(":memory:");
    initSlipsTable(db);
    initDraftsTable(db);
    initParserRunsTable(db);
  });

  afterAll(() => {
    db.close();
  });

  // ─── Test: successful parse creates needs_review draft with amount string ───

  it("creates a parsed draft with amount as string '123.45' and merchant preserved for a perfect parse", async () => {
    const slip = insertSlip("/tmp/test/success-slip.jpg");
    const parser = FakeParser.success();

    const result = await parseSlipToDraftAsync(
      db,
      slip.id,
      slip.path,
      slip.hash,
      parser,
    );

    expect(result.isMeaningful).toBe(true);
    expect(result.draft).not.toBeNull();

    // Perfect parse with high confidence and all fields → ReviewState.Parsed
    expect(result.draft!.reviewState).toBe(ReviewState.Parsed);

    // Verify draft in DB
    const draft = getDraftBySlipId(db, slip.id);
    expect(draft).not.toBeNull();
    expect(typeof draft!.amount).toBe("string");
    expect(draft!.amount).toBe("123.45");
    expect(draft!.parsedMerchant).toBe("7-Eleven");
    expect(draft!.merchant).toBe("7-Eleven"); // normalized = parsed (no aliases yet)
  });

  // ─── Test: parser run stores raw JSON + metadata and status ───

  it("stores parser run with raw JSON, provider/model metadata, and success status", async () => {
    const slip = insertSlip("/tmp/test/parser-run-metadata.jpg");
    const parser = FakeParser.success({
      parsedMerchant: "Lotus's",
      amount: "250.00",
      sourceIdentifier: "TXN001",
    });

    const result = await parseSlipToDraftAsync(
      db,
      slip.id,
      slip.path,
      slip.hash,
      parser,
    );

    expect(result.parserRunId).toBeGreaterThan(0);

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs.length).toBe(1);
    expect(runs[0].provider).toBe("fake");
    expect(runs[0].model).toBe("fake-model-v1");
    expect(runs[0].status).toBe(ParserRunStatus.Success);

    // rawJson should contain the full parse result
    expect(runs[0].rawJson).not.toBeNull();
    const raw = JSON.parse(runs[0].rawJson!);
    expect(raw.amount).toBe("250.00");
    expect(raw.parsedMerchant).toBe("Lotus's");

    // metadata should contain confidence info
    expect(runs[0].metadata).not.toBeNull();
    const meta = JSON.parse(runs[0].metadata!);
    expect(meta.confidence).toBe("high");
  });

  // ─── Test: missing currency defaults THB, records uncertainty, blocks ready ───

  it("defaults missing currency to THB, records uncertainty, and blocks ready", async () => {
    const slip = insertSlip("/tmp/test/currency-default.jpg");
    const parser = FakeParser.partial({
      amount: "99.00",
      parsedMerchant: "Big C",
    });

    const result = await parseSlipToDraftAsync(
      db,
      slip.id,
      slip.path,
      slip.hash,
      parser,
    );

    expect(result.isMeaningful).toBe(true);
    expect(result.draft).not.toBeNull();
    expect(result.draft!.hasUncertainty).toBe(true);
    expect(result.draft!.reviewState).toBe(ReviewState.NeedsReview);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft).not.toBeNull();
    expect(draft!.currency).toBe("THB");
    expect(draft!.hasUncertainty).toBe(1);

    // Cannot mark as ready
    const readyResult = markDraftReady(db, draft!.id);
    expect(readyResult.success).toBe(false);
    expect(readyResult.errors.some((e) => e.toLowerCase().includes("uncertainty"))).toBe(true);
  });

  // ─── Test: total failure records failed parser_run, does NOT create draft ───

  it("does not create draft on total parser failure and records failed run", async () => {
    const slip = insertSlip("/tmp/test/total-failure.jpg");
    const parser = FakeParser.failure();

    const beforeCount = getAllDrafts(db).length;

    const result = await parseSlipToDraftAsync(
      db,
      slip.id,
      slip.path,
      slip.hash,
      parser,
    );

    expect(result.isMeaningful).toBe(false);
    expect(result.draft).toBeNull();

    const afterCount = getAllDrafts(db).length;
    expect(afterCount).toBe(beforeCount); // no draft created

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe(ParserRunStatus.Failed);
  });

  // ─── Test: total failure does not overwrite existing draft ───

  it("does not overwrite existing draft on retry total failure", async () => {
    const slip = insertSlip("/tmp/test/no-overwrite-fail.jpg");

    // First parse succeeds
    const successParser = FakeParser.success({ amount: "150.00" });
    const firstResult = await parseSlipToDraftAsync(
      db,
      slip.id,
      slip.path,
      slip.hash,
      successParser,
    );
    expect(firstResult.draft).not.toBeNull();

    // Second parse fails — should not overwrite draft
    const failParser = FakeParser.failure();
    const secondResult = await parseSlipToDraftAsync(
      db,
      slip.id,
      slip.path,
      slip.hash,
      failParser,
    );

    expect(secondResult.isMeaningful).toBe(false);
    expect(secondResult.draft).toBeNull();

    // Draft should still have the first result's data
    const draft = getDraftBySlipId(db, slip.id);
    expect(draft).not.toBeNull();
    expect(draft!.amount).toBe("150.00");

    // Both parser runs should exist; newest first (failed)
    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs.length).toBe(2);
    expect(runs[0].status).toBe(ParserRunStatus.Failed);
    expect(runs[1].status).toBe(ParserRunStatus.Success);
  });

  // ─── Test: duplicateRisk slip blocks ready ───

  it("flags duplicate risk and blocks ready when same content hash exists from different path", async () => {
    const sharedHash = "duplicate-hash-content";

    // First slip
    const slip1 = insertSlip("/tmp/test/original-slip.jpg", sharedHash);
    const parser1 = FakeParser.success({ amount: "75.00" });
    await parseSlipToDraftAsync(db, slip1.id, slip1.path, slip1.hash, parser1);

    // Second slip with same hash — should flag duplicate risk
    const slip2 = insertSlip("/tmp/test/duplicate-slip.jpg", sharedHash);
    const parser2 = FakeParser.success({ amount: "75.00" });
    const result2 = await parseSlipToDraftAsync(
      db,
      slip2.id,
      slip2.path,
      slip2.hash,
      parser2,
    );

    expect(result2.draft).not.toBeNull();
    expect(result2.draft!.duplicateRisk).toBe(true);

    const draft2 = getDraftBySlipId(db, slip2.id);
    expect(draft2).not.toBeNull();
    expect(draft2!.duplicateRisk).toBe(1);

    // Cannot mark as ready
    const readyResult = markDraftReady(db, draft2!.id);
    expect(readyResult.success).toBe(false);
    expect(readyResult.errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
  });

  // ─── Test: same path re-parse (rescan) does NOT get duplicate risk ───

  it("does not flag duplicate risk when same sourcePath is re-parsed", async () => {
    const slip = insertSlip("/tmp/test/rescan-slip.jpg", "rescan-hash-unique");

    const parser1 = FakeParser.success({ amount: "50.00" });
    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser1);

    // Re-parse (upserts existing draft)
    const parser2 = FakeParser.success({ amount: "55.00" });
    const result2 = await parseSlipToDraftAsync(
      db,
      slip.id,
      slip.path,
      slip.hash,
      parser2,
    );

    expect(result2.draft).not.toBeNull();
    expect(result2.draft!.duplicateRisk).toBe(false);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.duplicateRisk).toBe(0);
    expect(draft!.amount).toBe("55.00");
  });

  // ─── Test: category is optional, does not block ready ───

  it("allows draft to reach ready when category is null but all required fields are present", async () => {
    const slip = insertSlip("/tmp/test/no-category-ready.jpg");
    const parser = FakeParser.success({
      amount: "200.00",
      parsedMerchant: "Coffee Shop",
      sourceIdentifier: "REF-COFFEE",
    });

    const result = await parseSlipToDraftAsync(
      db,
      slip.id,
      slip.path,
      slip.hash,
      parser,
    );

    expect(result.draft).not.toBeNull();

    // Perfect parse → ReviewState.Parsed (all fields present, no uncertainty)
    expect(result.draft!.reviewState).toBe(ReviewState.Parsed);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.category).toBeNull(); // no category set

    // Add source account to satisfy ready requirement
    const { updateDraftField } = await import("../src/db/drafts");
    updateDraftField(db, draft!.id, "source_account_name", "My Bank Account");

    // Now should be markable as ready (all required fields present, no uncertainty, no dup risk)
    const readyResult = markDraftReady(db, draft!.id);
    expect(readyResult.success).toBe(true);
    expect(readyResult.errors).toEqual([]);
  });

  // ─── Test: parser provider error returns failed run, no draft ───

  it("records failed run and no draft when parser provider throws", async () => {
    const slip = insertSlip("/tmp/test/throws-error.jpg");
    const parser = new FakeParser({
      result: {
        date: null,
        amount: null,
        currency: null,
        parsedMerchant: null,
        sourceIdentifier: null,
        confidence: "low",
        uncertainties: {},
        status: ParserRunStatus.Failed,
      },
      throwError: "Network error: API unreachable",
    });

    const result = await parseSlipToDraftAsync(
      db,
      slip.id,
      slip.path,
      slip.hash,
      parser,
    );

    expect(result.isMeaningful).toBe(false);
    expect(result.draft).toBeNull();

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe(ParserRunStatus.Failed);

    // metadata should contain the error
    expect(runs[0].metadata).not.toBeNull();
    const meta = JSON.parse(runs[0].metadata!);
    expect(meta.error).toContain("Network error");
  });
});
