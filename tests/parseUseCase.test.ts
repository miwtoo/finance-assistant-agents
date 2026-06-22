import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initSlipsTable, upsertSlipRecord } from "../src/db/slips";
import { initDraftsTable, getDraftBySlipId, getAllDrafts, updateDraftField } from "../src/db/drafts";
import { initParserRunsTable, getParserRunsBySlipId } from "../src/db/parserRuns";
import { parseSlipToDraftAsync, markDraftReady } from "../src/domain/draftService";
import { ParserRunStatus, ReviewState } from "../src/domain/types";
import { FakeParser } from "./fakes/fakeParser";
import type { SlipCandidate } from "../src/domain/slipScanner";

describe("parseSlipToDraftAsync — use-case integration", () => {
  let db: Database;

  function insertSlip(
    path: string,
    contentHash?: string,
    duplicateRisk?: boolean,
  ): { id: number; path: string; hash: string } {
    const hash = contentHash ?? "hash-" + path;
    const candidate: SlipCandidate = {
      sourcePath: path,
      contentHash: hash,
      mtime: new Date(),
    };
    const record = upsertSlipRecord(db, candidate);
    if (duplicateRisk) {
      db.run("UPDATE slips SET duplicate_risk = 1 WHERE id = ?", [record.id]);
    }
    return { id: record.id, path, hash };
  }

  beforeAll(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON;");
    initSlipsTable(db);
    initDraftsTable(db);
    initParserRunsTable(db);
  });

  afterAll(() => {
    db.close();
  });

  // ─── 1. Successful parse ──────────────────────────────────────

  it("creates a parsed draft with amount as string '123.45' and merchant preserved", async () => {
    const slip = insertSlip("/tmp/test/success-slip.jpg");
    const parser = FakeParser.success();

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.isMeaningful).toBe(true);
    expect(result.draft).not.toBeNull();
    expect(result.draft!.reviewState).toBe(ReviewState.Parsed);
    expect(result.preserved).toBe(false);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft).not.toBeNull();
    expect(typeof draft!.amount).toBe("string");
    expect(draft!.amount).toBe("123.45");
    expect(draft!.parsedMerchant).toBe("7-Eleven");
    expect(draft!.merchant).toBe("7-Eleven");
    expect(draft!.parsedCategory).toBe("Convenience Store");
    expect(draft!.sourceAccountHints).not.toBeNull();
  });

  // ─── 2. Parser run stores raw immutable JSON ──────────────────

  it("stores parser run with raw provider payload, model metadata, and status", async () => {
    const slip = insertSlip("/tmp/test/parser-run-raw.jpg");
    const parser = FakeParser.success({
      parsedMerchant: "Lotus's",
      amount: "250.00",
    });

    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs.length).toBe(1);
    expect(runs[0].provider).toBe("fake");
    expect(runs[0].model).toBe("fake-model-v1");
    expect(runs[0].status).toBe(ParserRunStatus.Success);

    // rawJson must contain the EXACT result before validation
    const raw = JSON.parse(runs[0].rawJson!);
    expect(raw.amount).toBe("250.00");
    expect(raw.parsedMerchant).toBe("Lotus's");
    expect(raw.providerRawPayload).toEqual({ raw: "response", model: "fake-v1" });
    // Must NOT contain validator-added fields
    expect(raw.hasUncertainty).toBeUndefined();
    expect(raw.parsedCurrency).toBeUndefined();
  });

  // ─── 3. Missing currency → THB + uncertainty + blocks ready ───

  it("defaults missing currency to THB, records uncertainty, blocks ready", async () => {
    const slip = insertSlip("/tmp/test/currency-default.jpg");
    const parser = FakeParser.partial({ amount: "99.00", parsedMerchant: "Big C" });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.draft).not.toBeNull();
    expect(result.draft!.hasUncertainty).toBe(true);
    expect(result.draft!.reviewState).toBe(ReviewState.NeedsReview);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.currency).toBe("THB");
    expect(draft!.parsedCurrency).toBeNull();
    expect(draft!.hasUncertainty).toBe(1);

    const readyResult = markDraftReady(db, draft!.id);
    expect(readyResult.success).toBe(false);
    expect(readyResult.errors.some((e) => e.toLowerCase().includes("uncertainty"))).toBe(true);
  });

  // ─── 4. Unknown currency → THB + uncertainty + blocks ready ───

  it("defaults unknown currency 'XYZ' to THB with uncertainty and blocks ready", async () => {
    const slip = insertSlip("/tmp/test/unknown-currency.jpg");
    const parser = FakeParser.success({
      amount: "75.00",
      parsedMerchant: "Shop",
      currency: "XYZ",
      confidence: "high",
    });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.draft!.hasUncertainty).toBe(true);
    expect(result.draft!.reviewState).toBe(ReviewState.NeedsReview);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.currency).toBe("THB");
    expect(draft!.parsedCurrency).toBe("XYZ");

    const readyResult = markDraftReady(db, draft!.id);
    expect(readyResult.success).toBe(false);
  });

  // ─── 5. Invalid amount → null + uncertainty + needs-review ───

  it("rejects invalid amount format from parser, records uncertainty, sets needs-review", async () => {
    const slip = insertSlip("/tmp/test/invalid-amount.jpg");
    const parser = FakeParser.success({ amount: "12.34.56" });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.draft).not.toBeNull();
    expect(result.draft!.hasUncertainty).toBe(true);
    expect(result.draft!.reviewState).toBe(ReviewState.NeedsReview);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.amount).toBeNull();
  });

  // ─── 6. Invalid date → null + uncertainty + needs-review ─────

  it("rejects invalid date format from parser, records uncertainty, sets needs-review", async () => {
    const slip = insertSlip("/tmp/test/invalid-date.jpg");
    const parser = FakeParser.success({ date: "not-a-date" });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.draft).not.toBeNull();
    expect(result.draft!.hasUncertainty).toBe(true);
    expect(result.draft!.reviewState).toBe(ReviewState.NeedsReview);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.date).toBeNull();
  });

  // ─── 7. Total failure → no draft, failed run ──────────────────

  it("does not create draft on total parser failure and records failed run", async () => {
    const slip = insertSlip("/tmp/test/total-failure.jpg");
    const parser = FakeParser.failure();
    const beforeCount = getAllDrafts(db).length;

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.isMeaningful).toBe(false);
    expect(result.draft).toBeNull();
    expect(getAllDrafts(db).length).toBe(beforeCount);

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs[0].status).toBe(ParserRunStatus.Failed);
  });

  // ─── 8. Total failure retry does not overwrite existing draft ──

  it("does not overwrite existing draft on retry total failure", async () => {
    const slip = insertSlip("/tmp/test/no-overwrite-fail.jpg");

    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "150.00" }));
    const failResult = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.failure());

    expect(failResult.isMeaningful).toBe(false);
    expect(failResult.draft).toBeNull();

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.amount).toBe("150.00");

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs.length).toBe(2);
    expect(runs[0].status).toBe(ParserRunStatus.Failed);
  });

  // ─── 9. Successful retry preserves user-owned draft ───────────

  it("does not overwrite user-edited draft on successful retry", async () => {
    const slip = insertSlip("/tmp/test/retry-preserve.jpg");

    // First parse creates initial draft
    const first = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "50.00" }));
    expect(first.draft).not.toBeNull();

    // User edits the draft (simulate by updating review state to NeedsReview)
    const draftBefore = getDraftBySlipId(db, slip.id);
    updateDraftField(db, draftBefore!.id, "review_state", ReviewState.NeedsReview);
    updateDraftField(db, draftBefore!.id, "merchant", "User-Edited Merchant");

    // Retry with different data
    const retry = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "999.99", parsedMerchant: "Overwritten Merchant" }));

    // Should preserve user-owned draft
    expect(retry.preserved).toBe(true);
    expect(retry.draft).not.toBeNull();

    const draftAfter = getDraftBySlipId(db, slip.id);
    expect(draftAfter!.amount).toBe("50.00"); // unchanged
    expect(draftAfter!.merchant).toBe("User-Edited Merchant"); // unchanged
  });

  // ─── 10. Duplicate risk from same hash different path ─────────

  it("flags duplicate risk and blocks ready when same hash exists from different path", async () => {
    const sharedHash = "dup-hash-basic";

    const slip1 = insertSlip("/tmp/test/orig.jpg", sharedHash);
    await parseSlipToDraftAsync(db, slip1.id, slip1.path, slip1.hash, FakeParser.success({ amount: "75.00" }));

    const slip2 = insertSlip("/tmp/test/dup.jpg", sharedHash);
    const result2 = await parseSlipToDraftAsync(db, slip2.id, slip2.path, slip2.hash, FakeParser.success({ amount: "75.00" }));

    expect(result2.draft!.duplicateRisk).toBe(true);

    const draft2 = getDraftBySlipId(db, slip2.id);
    expect(draft2!.duplicateRisk).toBe(1);

    const readyResult = markDraftReady(db, draft2!.id);
    expect(readyResult.success).toBe(false);
    expect(readyResult.errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
  });

  // ─── 11. Duplicate risk propagation from slips ────────────────

  it("propagates slip-level duplicate_risk into draft and blocks ready", async () => {
    // Insert a slip that was already flagged as duplicate_risk at scan time
    const slip = insertSlip("/tmp/test/slip-dup-flag.jpg", "unique-hash-slip", true);
    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "100.00" }));

    expect(result.draft!.duplicateRisk).toBe(true);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.duplicateRisk).toBe(1);

    const readyResult = markDraftReady(db, draft!.id);
    expect(readyResult.success).toBe(false);
  });

  // ─── 12. Same path re-parse NO duplicate risk ─────────────────

  it("does not flag duplicate risk when same sourcePath is re-parsed", async () => {
    const slip = insertSlip("/tmp/test/rescan-slip.jpg", "rescan-hash-unique");

    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "50.00" }));
    const result2 = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "55.00" }));

    expect(result2.draft!.duplicateRisk).toBe(false);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.duplicateRisk).toBe(0);
  });

  // ─── 13. Category optional — does not block ready ─────────────

  it("allows draft to reach ready when category is null but all required fields are present", async () => {
    const slip = insertSlip("/tmp/test/no-category-ready.jpg");
    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({
      amount: "200.00",
      parsedMerchant: "Coffee Shop",
      parsedCategory: null,
    }));

    expect(result.draft).not.toBeNull();

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.category).toBeNull();
    expect(draft!.parsedCategory).toBeNull();

    // Add source account
    updateDraftField(db, draft!.id, "source_account_name", "My Bank Account");

    const readyResult = markDraftReady(db, draft!.id);
    expect(readyResult.success).toBe(true);
    expect(readyResult.errors).toEqual([]);
  });

  // ─── 14. Parser provider throw → failed run, no draft ─────────

  it("records failed run and no draft when parser provider throws", async () => {
    const slip = insertSlip("/tmp/test/throws-error.jpg");
    const parser = new FakeParser({
      result: {
        date: null,
        amount: null,
        currency: null,
        parsedMerchant: null,
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: [],
        confidence: "low",
        uncertainties: {},
        status: ParserRunStatus.Failed,
        providerRawPayload: {},
      },
      throwError: "Network error: API unreachable",
    });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.isMeaningful).toBe(false);
    expect(result.draft).toBeNull();

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs[0].status).toBe(ParserRunStatus.Failed);
    const meta = JSON.parse(runs[0].metadata!);
    expect(meta.error).toContain("Network error");
  });
});
