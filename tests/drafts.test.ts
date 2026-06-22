import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initDraftsTable, insertDraft, upsertDraft, getDraft, getDraftBySlipId, getAllDrafts, getDraftsByReviewState, updateDraftField, deleteDraftBySlipId } from "../src/db/drafts";
import { initSlipsTable, upsertSlipRecord } from "../src/db/slips";
import type { SlipCandidate } from "../src/domain/slipScanner";

describe("drafts db", () => {
  let db: Database;

  function insertSlip(path = "/tmp/test/slip.jpg"): number {
    const candidate: SlipCandidate = {
      sourcePath: path,
      contentHash: "hash-" + path,
      mtime: new Date(),
    };
    const record = upsertSlipRecord(db, candidate);
    return record.id;
  }

  beforeAll(() => {
    db = new Database(":memory:");
    initSlipsTable(db);
    initDraftsTable(db);
  });

  afterAll(() => {
    db.close();
  });

  it("creates the drafts table on init", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='drafts'")
      .all();
    expect(tables.length).toBe(1);
  });

  it("inserts a new draft record", () => {
    const slipId = insertSlip("/tmp/test/draft-slip.jpg");
    const draft = insertDraft(db, {
      slipId,
      sourcePath: "/tmp/test/draft-slip.jpg",
      contentHash: "hash-draft-1",
      date: "2025-06-22",
      amount: "123.45",
      currency: "THB",
      merchant: "7-Eleven",
      parsedMerchant: "7-Eleven",
      sourceIdentifier: null,
      sourceAccountName: null,
      category: null,
      reviewState: "parsed" as any,
      syncState: "unsynced" as any,
      duplicateRisk: false,
      hasUncertainty: false,
    });
    expect(draft.id).toBeGreaterThan(0);
    expect(draft.slipId).toBe(slipId);
    expect(draft.amount).toBe("123.45");
    expect(draft.currency).toBe("THB");
    expect(draft.merchant).toBe("7-Eleven");
    expect(draft.reviewState).toBe("parsed");
    expect(draft.syncState).toBe("unsynced");
    expect(draft.duplicateRisk).toBe(0);
    expect(draft.hasUncertainty).toBe(0);
  });

  it("stores amount as exact text string", () => {
    const slipId = insertSlip("/tmp/test/amount-test.jpg");
    const draft = insertDraft(db, {
      slipId,
      sourcePath: "/tmp/test/amount-test.jpg",
      contentHash: "hash-amount",
      date: "2025-06-22",
      amount: "99.99",
      currency: "THB",
      merchant: "Test Shop",
      parsedMerchant: "Test Shop",
      sourceIdentifier: null,
      sourceAccountName: null,
      category: null,
      reviewState: "parsed" as any,
      syncState: "unsynced" as any,
      duplicateRisk: false,
      hasUncertainty: false,
    });
    expect(typeof draft.amount).toBe("string");
    expect(draft.amount).toBe("99.99");
  });

  it("upsert replaces existing draft for same slip_id", () => {
    const slipId = insertSlip("/tmp/test/upsert-slip.jpg");
    insertDraft(db, {
      slipId,
      sourcePath: "/tmp/test/upsert-slip.jpg",
      contentHash: "hash-upsert",
      date: "2025-06-22",
      amount: "50.00",
      currency: "THB",
      merchant: "Original",
      parsedMerchant: "Original",
      sourceIdentifier: null,
      sourceAccountName: null,
      category: null,
      reviewState: "parsed" as any,
      syncState: "unsynced" as any,
      duplicateRisk: false,
      hasUncertainty: false,
    });

    const updated = upsertDraft(db, {
      slipId,
      sourcePath: "/tmp/test/upsert-slip.jpg",
      contentHash: "hash-upsert",
      date: "2025-06-23",
      amount: "75.00",
      currency: "USD",
      merchant: "Updated",
      parsedMerchant: "Updated",
      sourceIdentifier: null,
      sourceAccountName: null,
      category: null,
      reviewState: "needs_review" as any,
      syncState: "unsynced" as any,
      duplicateRisk: true,
      hasUncertainty: true,
    });

    const all = getAllDrafts(db);
    const matches = all.filter((d) => d.slipId === slipId);
    expect(matches.length).toBe(1);
    expect(updated.amount).toBe("75.00");
    expect(updated.currency).toBe("USD");
    expect(updated.merchant).toBe("Updated");
    expect(updated.reviewState).toBe("needs_review");
    expect(updated.duplicateRisk).toBe(1);
    expect(updated.hasUncertainty).toBe(1);
  });

  it("getDraft returns null for non-existent id", () => {
    const draft = getDraft(db, 99999);
    expect(draft).toBeNull();
  });

  it("getDraftBySlipId returns correct draft", () => {
    const slipId = insertSlip("/tmp/test/get-by-slip.jpg");
    insertDraft(db, {
      slipId,
      sourcePath: "/tmp/test/get-by-slip.jpg",
      contentHash: "hash-get-by-slip",
      date: "2025-06-22",
      amount: "10.00",
      currency: "THB",
      merchant: "Get By Slip",
      parsedMerchant: "Get By Slip",
      sourceIdentifier: null,
      sourceAccountName: null,
      category: null,
      reviewState: "parsed" as any,
      syncState: "unsynced" as any,
      duplicateRisk: false,
      hasUncertainty: false,
    });
    const draft = getDraftBySlipId(db, slipId);
    expect(draft).not.toBeNull();
    expect(draft!.sourcePath).toContain("get-by-slip.jpg");
  });

  it("getDraftsByReviewState filters correctly", () => {
    const slipId1 = insertSlip("/tmp/test/filter-ready-1.jpg");
    const slipId2 = insertSlip("/tmp/test/filter-ready-2.jpg");
    insertDraft(db, {
      slipId: slipId1,
      sourcePath: "/tmp/test/filter-ready-1.jpg",
      contentHash: "hash-filter-1",
      date: "2025-06-22",
      amount: "10.00",
      currency: "THB",
      merchant: "Filter Test 1",
      parsedMerchant: "Filter Test 1",
      sourceIdentifier: null,
      sourceAccountName: null,
      category: null,
      reviewState: "ready" as any,
      syncState: "unsynced" as any,
      duplicateRisk: false,
      hasUncertainty: false,
    });
    insertDraft(db, {
      slipId: slipId2,
      sourcePath: "/tmp/test/filter-ready-2.jpg",
      contentHash: "hash-filter-2",
      date: "2025-06-22",
      amount: "20.00",
      currency: "THB",
      merchant: "Filter Test 2",
      parsedMerchant: "Filter Test 2",
      sourceIdentifier: null,
      sourceAccountName: null,
      category: null,
      reviewState: "needs_review" as any,
      syncState: "unsynced" as any,
      duplicateRisk: false,
      hasUncertainty: false,
    });

    const readyDrafts = getDraftsByReviewState(db, "ready");
    expect(readyDrafts.length).toBeGreaterThanOrEqual(1);
    expect(readyDrafts.every((d) => d.reviewState === "ready")).toBe(true);
  });

  it("updateDraftField updates a single field", () => {
    const slipId = insertSlip("/tmp/test/update-field.jpg");
    const draft = insertDraft(db, {
      slipId,
      sourcePath: "/tmp/test/update-field.jpg",
      contentHash: "hash-update-field",
      date: "2025-06-22",
      amount: "30.00",
      currency: "THB",
      merchant: "Update Test",
      parsedMerchant: "Update Test",
      sourceIdentifier: null,
      sourceAccountName: null,
      category: null,
      reviewState: "parsed" as any,
      syncState: "unsynced" as any,
      duplicateRisk: false,
      hasUncertainty: false,
    });

    const updated = updateDraftField(db, draft.id, "merchant", "Updated Merchant");
    expect(updated.merchant).toBe("Updated Merchant");
    expect(updated.date).toBe("2025-06-22"); // unchanged
  });

  it("deleteDraftBySlipId removes draft and returns true", () => {
    const slipId = insertSlip("/tmp/test/delete-draft.jpg");
    insertDraft(db, {
      slipId,
      sourcePath: "/tmp/test/delete-draft.jpg",
      contentHash: "hash-delete",
      date: "2025-06-22",
      amount: "40.00",
      currency: "THB",
      merchant: "Delete Test",
      parsedMerchant: "Delete Test",
      sourceIdentifier: null,
      sourceAccountName: null,
      category: null,
      reviewState: "parsed" as any,
      syncState: "unsynced" as any,
      duplicateRisk: false,
      hasUncertainty: false,
    });

    const deleted = deleteDraftBySlipId(db, slipId);
    expect(deleted).toBe(true);
    const draft = getDraftBySlipId(db, slipId);
    expect(draft).toBeNull();
  });

  it("deleteDraftBySlipId returns false for non-existent slip", () => {
    const deleted = deleteDraftBySlipId(db, 99999);
    expect(deleted).toBe(false);
  });

  it("rejects insert with duplicate slip_id", () => {
    const slipId = insertSlip("/tmp/test/dup-slip-id.jpg");
    insertDraft(db, {
      slipId,
      sourcePath: "/tmp/test/dup-slip-id.jpg",
      contentHash: "hash-dup-slip",
      date: "2025-06-22",
      amount: "5.00",
      currency: "THB",
      merchant: "Dup Slip",
      parsedMerchant: "Dup Slip",
      sourceIdentifier: null,
      sourceAccountName: null,
      category: null,
      reviewState: "parsed" as any,
      syncState: "unsynced" as any,
      duplicateRisk: false,
      hasUncertainty: false,
    });

    expect(() => {
      insertDraft(db, {
        slipId,
        sourcePath: "/tmp/test/dup-slip-id.jpg",
        contentHash: "hash-dup-slip",
        date: "2025-06-22",
        amount: "5.00",
        currency: "THB",
        merchant: "Dup Slip Again",
        parsedMerchant: "Dup Slip Again",
        sourceIdentifier: null,
        sourceAccountName: null,
        category: null,
        reviewState: "parsed" as any,
        syncState: "unsynced" as any,
        duplicateRisk: false,
        hasUncertainty: false,
      });
    }).toThrow();
  });
});
