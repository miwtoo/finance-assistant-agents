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
    const parser = FakeParser.success({ parsedMerchant: "Lotus's", amount: "250.00" });

    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs.length).toBe(1);
    expect(runs[0].provider).toBe("fake");
    expect(runs[0].model).toBe("fake-model-v1");
    expect(runs[0].status).toBe(ParserRunStatus.Success);

    const raw = JSON.parse(runs[0].rawJson!);
    expect(raw.amount).toBe("250.00");
    expect(raw.parsedMerchant).toBe("Lotus's");
    expect(raw.providerRawPayload).toEqual({ raw: "response", model: "fake-v1" });
    expect(raw.hasUncertainty).toBeUndefined();
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
    expect(draft!.hasUncertainty).toBe(1);

    const readyResult = markDraftReady(db, draft!.id);
    expect(readyResult.success).toBe(false);
  });

  // ─── 4. Unknown currency → THB + uncertainty + blocks ready ───

  it("defaults unknown currency 'XYZ' to THB with uncertainty, blocks ready", async () => {
    const slip = insertSlip("/tmp/test/unknown-currency.jpg");
    const parser = FakeParser.success({ amount: "75.00", parsedMerchant: "Shop", currency: "XYZ" });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.draft!.hasUncertainty).toBe(true);
    expect(result.draft!.reviewState).toBe(ReviewState.NeedsReview);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.currency).toBe("THB");
    expect(draft!.parsedCurrency).toBe("XYZ");

    expect(markDraftReady(db, draft!.id).success).toBe(false);
  });

  // ─── 5. Invalid amount → null + uncertainty + needs-review ───

  it("rejects invalid amount format, records uncertainty, sets needs-review", async () => {
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

  it("rejects invalid date format, records uncertainty, sets needs-review", async () => {
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

    expect(getDraftBySlipId(db, slip.id)!.amount).toBe("150.00");

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs[0].status).toBe(ParserRunStatus.Failed);
  });

  // ─── 9. Duplicate risk from same hash different path ─────────

  it("flags duplicate risk and blocks ready when same hash exists from different path", async () => {
    const sharedHash = "dup-hash-basic";
    const slip1 = insertSlip("/tmp/test/orig.jpg", sharedHash);
    await parseSlipToDraftAsync(db, slip1.id, slip1.path, slip1.hash, FakeParser.success({ amount: "75.00" }));

    const slip2 = insertSlip("/tmp/test/dup.jpg", sharedHash);
    const result2 = await parseSlipToDraftAsync(db, slip2.id, slip2.path, slip2.hash, FakeParser.success({ amount: "75.00" }));

    expect(result2.draft!.duplicateRisk).toBe(true);
    expect(markDraftReady(db, getDraftBySlipId(db, slip2.id)!.id).success).toBe(false);
  });

  // ─── 10. Duplicate risk propagation from slips ───────────────

  it("propagates slip-level duplicate_risk into draft and blocks ready", async () => {
    const slip = insertSlip("/tmp/test/slip-dup-flag.jpg", "unique-hash-slip", true);
    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "100.00" }));

    expect(result.draft!.duplicateRisk).toBe(true);

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.duplicateRisk).toBe(1);
    expect(markDraftReady(db, draft!.id).success).toBe(false);
  });

  // ─── 11. Same path re-parse NO duplicate risk ─────────────────

  it("does not flag duplicate risk when same sourcePath is re-parsed", async () => {
    const slip = insertSlip("/tmp/test/rescan-slip.jpg", "rescan-hash-unique");

    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "50.00" }));
    const result2 = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "55.00" }));

    expect(result2.draft!.duplicateRisk).toBe(false);
    expect(getDraftBySlipId(db, slip.id)!.duplicateRisk).toBe(0);
  });

  // ─── 12. Category optional — does not block ready ─────────────

  it("allows draft to reach ready when category is null but all required fields present", async () => {
    const slip = insertSlip("/tmp/test/no-category-ready.jpg");
    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({
      amount: "200.00", parsedMerchant: "Coffee Shop", parsedCategory: null,
    }));

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft!.category).toBeNull();
    expect(draft!.parsedCategory).toBeNull();

    updateDraftField(db, draft!.id, "source_account_name", "My Bank Account");
    updateDraftField(db, draft!.id, "source_account_id", "asset-1");
    expect(markDraftReady(db, draft!.id).success).toBe(true);
  });

  // ─── 13. Parser provider throw → failed run, no draft ─────────

  it("records failed run and no draft when parser provider throws", async () => {
    const slip = insertSlip("/tmp/test/throws-error.jpg");
    const parser = new FakeParser({
      result: {
        date: null, amount: null, currency: null,
        parsedMerchant: null, parsedCategory: null,
        sourceIdentifier: null, sourceAccountHints: [],
        confidence: "low", assessments: {},
        status: ParserRunStatus.Failed, providerRawPayload: {},
      },
      throwError: "Network error: API unreachable",
    });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.isMeaningful).toBe(false);
    expect(result.draft).toBeNull();

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs[0].status).toBe(ParserRunStatus.Failed);
    expect(JSON.parse(runs[0].metadata!).error).toContain("Network error");
  });

  // ─── Blocker 1: Invalid-only parse → no draft (total validation failure) ──

  it("does not create draft when parser returns only invalid amount with no valid fields", async () => {
    const slip = insertSlip("/tmp/test/invalid-only-amount.jpg");
    const parser = FakeParser.success({ amount: "abc", date: null, parsedMerchant: null });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.isMeaningful).toBe(false);
    expect(result.draft).toBeNull();
    expect(result.parserRunId).toBeGreaterThan(0);

    // Parser run should be recorded as success (provider returned, but validation failed)
    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs.length).toBe(1);
  });

  it("does not create draft when parser returns only invalid date with no valid fields", async () => {
    const slip = insertSlip("/tmp/test/invalid-only-date.jpg");
    const parser = FakeParser.success({ date: "bad-date", amount: null, parsedMerchant: null });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    expect(result.isMeaningful).toBe(false);
    expect(result.draft).toBeNull();
  });

  // ─── Blocker 3: Ready gate rejects unknown manual currency ────

  it("blocks ready when draft has unrecognized currency 'XYZ'", async () => {
    const slip = insertSlip("/tmp/test/xyz-currency-ready.jpg");
    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({
      amount: "50.00", parsedMerchant: "Shop", currency: "THB",
    }));

    const draft = getDraftBySlipId(db, slip.id);
    expect(draft).not.toBeNull();

    // Manually set currency to something invalid (simulating user entry)
    updateDraftField(db, draft!.id, "currency", "XYZ");
    updateDraftField(db, draft!.id, "source_account_name", "My Bank");
    updateDraftField(db, draft!.id, "has_uncertainty", "0");
    updateDraftField(db, draft!.id, "review_state", ReviewState.Parsed);

    const readyResult = markDraftReady(db, draft!.id);
    expect(readyResult.success).toBe(false);
    expect(readyResult.errors.some((e) => e.includes("XYZ"))).toBe(true);
  });

  // ─── Blocker 4: Per-field numeric confidence in parser run ────

  it("stores per-field numeric confidence assessments in parser run metadata", async () => {
    const slip = insertSlip("/tmp/test/per-field-confidence.jpg");
    const parser = FakeParser.success({
      assessments: {
        amount: { uncertain: false, confidence: 0.95 },
        date: { uncertain: false, confidence: 0.98 },
        currency: { uncertain: false, confidence: 0.99 },
        parsedMerchant: { uncertain: false, confidence: 0.85 },
      },
    });

    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, parser);

    const runs = getParserRunsBySlipId(db, slip.id);
    const meta = JSON.parse(runs[0].metadata!);
    expect(meta.uncertainties.amount.confidence).toBe(0.95);
    expect(meta.uncertainties.date.confidence).toBe(0.98);
  });

  // ─── Blocker 5: Retry improves parser-owned NeedsReview ──────

  it("retry overwrites parser-owned needs_review draft (userEditedAt=null)", async () => {
    const slip = insertSlip("/tmp/test/retry-improve-parser-owned.jpg");

    // First parse with low confidence → creates NeedsReview (parser-owned)
    const first = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.partial({
      amount: "50.00",
      parsedMerchant: "Bad OCR",
    }));
    expect(first.draft!.reviewState).toBe(ReviewState.NeedsReview);

    const before = getDraftBySlipId(db, slip.id);
    expect(before!.userEditedAt).toBeNull(); // parser-owned

    // Retry with better result → should overwrite
    const retry = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({
      amount: "55.00",
      parsedMerchant: "Fixed OCR",
    }));

    expect(retry.preserved).toBe(false); // was overwritten
    expect(retry.draft).not.toBeNull();

    const after = getDraftBySlipId(db, slip.id);
    expect(after!.amount).toBe("55.00"); // updated
    expect(after!.parsedMerchant).toBe("Fixed OCR"); // updated
    expect(after!.userEditedAt).toBeNull(); // still parser-owned
  });

  // ─── Blocker 5: Retry preserves user-edited NeedsReview ──────

  it("retry preserves user-edited needs_review draft (userEditedAt set)", async () => {
    const slip = insertSlip("/tmp/test/retry-preserve-user-edited.jpg");

    // First parse creates draft
    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "50.00" }));

    // User edits a field (simulate by setting user_edited_at)
    const draftBefore = getDraftBySlipId(db, slip.id);
    updateDraftField(db, draftBefore!.id, "merchant", "User Merchant");
    updateDraftField(db, draftBefore!.id, "user_edited_at", new Date().toISOString());
    updateDraftField(db, draftBefore!.id, "review_state", ReviewState.NeedsReview);

    // Retry with different data
    const retry = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "999.99" }));

    expect(retry.preserved).toBe(true); // preserved because user-edited

    const draftAfter = getDraftBySlipId(db, slip.id);
    expect(draftAfter!.amount).toBe("50.00"); // unchanged
    expect(draftAfter!.merchant).toBe("User Merchant"); // unchanged
  });

  // ─── Blocker 6: Malformed provider responses ─────────────────

  it("records failed parser_run and no draft when provider returns null", async () => {
    const slip = insertSlip("/tmp/test/null-return.jpg");

    // Provider that returns null at runtime (bypassing TS types)
    const nullParser: FakeParser = new FakeParser({
      result: null as unknown as any,
    });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, nullParser);

    expect(result.isMeaningful).toBe(false);
    expect(result.draft).toBeNull();
    expect(result.parserRunId).toBeGreaterThan(0);

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs.length).toBe(1);
    // Should be recorded as failed since null is not a valid parse result
    expect(runs[0].status).toBe(ParserRunStatus.Failed);
    // rawJson should store the original null
    expect(runs[0].rawJson).toBe("null");
  });

  it("records failed parser_run when provider returns missing status field", async () => {
    const slip = insertSlip("/tmp/test/no-status.jpg");

    // Object missing the `status` field entirely
    const malformedParser = new FakeParser({
      result: {
        date: "2025-06-22",
        amount: "123.45",
        // no status field
      } as any,
    });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, malformedParser);

    expect(result.isMeaningful).toBe(false);
    expect(result.draft).toBeNull();

    const runs = getParserRunsBySlipId(db, slip.id);
    expect(runs.length).toBe(1);
    // safeParseResult should detect missing status → Failed
    expect(runs[0].status).toBe(ParserRunStatus.Failed);
  });

  it("preserves existing draft when malformed provider response is received on retry", async () => {
    const slip = insertSlip("/tmp/test/malformed-retry-preserve.jpg");

    // First parse creates a draft successfully
    await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, FakeParser.success({ amount: "200.00" }));
    expect(getDraftBySlipId(db, slip.id)).not.toBeNull();

    // Retry with malformed response
    const malformedParser = new FakeParser({
      result: "completely unexpected string" as any,
    });

    const result = await parseSlipToDraftAsync(db, slip.id, slip.path, slip.hash, malformedParser);

    expect(result.isMeaningful).toBe(false);
    expect(result.draft).toBeNull();

    // Existing draft must be preserved
    const draft = getDraftBySlipId(db, slip.id);
    expect(draft).not.toBeNull();
    expect(draft!.amount).toBe("200.00");
  });
});
