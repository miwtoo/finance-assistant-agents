import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initDraftsTable,
  insertDraft,
  upsertDraft,
  getDraft,
  getDraftBySlipId,
  getAllDrafts,
  getDraftsByReviewState,
  updateDraftField,
  deleteDraftBySlipId,
} from "../src/db/drafts";
import { initSlipsTable, upsertSlipRecord } from "../src/db/slips";
import type { SlipCandidate } from "../src/domain/slipScanner";
import { ReviewState, SyncState } from "../src/domain/types";

describe("drafts db", () => {
  let db: Database;
  let slipCounter = 0;

  function insertSlip(path?: string): number {
    const p = path ?? `/tmp/test/draft-slip-${++slipCounter}.jpg`;
    const candidate: SlipCandidate = {
      sourcePath: p,
      contentHash: "hash-" + p,
      mtime: new Date(),
    };
    return upsertSlipRecord(db, candidate).id;
  }

  function makeInput(
    overrides: Partial<{
      slipId: number;
      sourcePath: string;
      contentHash: string;
      date: string;
      amount: string;
      currency: string;
      parsedCurrency: string | null;
      merchant: string;
      parsedMerchant: string;
      parsedCategory: string | null;
      sourceIdentifier: string | null;
      sourceAccountHints: string | null;
      sourceAccountName: string | null;
      sourceAccountId: string | null;
      category: string | null;
      reviewState: ReviewState;
      syncState: SyncState;
      duplicateRisk: boolean;
      hasUncertainty: boolean;
      userEditedAt: string | null;
    }> = {},
  ) {
    const slipId = overrides.slipId ?? insertSlip();
    return {
      slipId,
      sourcePath: overrides.sourcePath ?? `/tmp/test/draft-${slipId}.jpg`,
      contentHash: overrides.contentHash ?? `hash-${slipId}`,
      date: overrides.date ?? "2025-06-22",
      amount: overrides.amount ?? "123.45",
      currency: overrides.currency ?? "THB",
      parsedCurrency: overrides.parsedCurrency ?? "THB",
      merchant: overrides.merchant ?? "Test Merchant",
      parsedMerchant: overrides.parsedMerchant ?? "Test Merchant",
      parsedCategory: overrides.parsedCategory ?? null,
      sourceIdentifier: overrides.sourceIdentifier ?? null,
      sourceAccountHints: overrides.sourceAccountHints ?? null,
      sourceAccountName: overrides.sourceAccountName ?? null,
      sourceAccountId: overrides.sourceAccountId ?? null,
      category: overrides.category ?? null,
      reviewState: overrides.reviewState ?? ReviewState.Parsed,
      syncState: overrides.syncState ?? SyncState.Unsynced,
      duplicateRisk: overrides.duplicateRisk ?? false,
      hasUncertainty: overrides.hasUncertainty ?? false,
      userEditedAt: overrides.userEditedAt ?? null,
    };
  }

  beforeAll(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON;");
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

  it("inserts a new draft record with all fields including user_edited_at", () => {
    const input = makeInput({
      amount: "123.45",
      currency: "THB",
      merchant: "7-Eleven",
      parsedMerchant: "7-Eleven",
      parsedCategory: "Convenience Store",
      sourceAccountHints: JSON.stringify([{ identifier: "1234", evidence: "X-1234", source: "card" }]),
      userEditedAt: null,
    });
    const draft = insertDraft(db, input);
    expect(draft.id).toBeGreaterThan(0);
    expect(draft.amount).toBe("123.45");
    expect(draft.currency).toBe("THB");
    expect(draft.parsedCurrency).toBe("THB");
    expect(draft.merchant).toBe("7-Eleven");
    expect(draft.parsedCategory).toBe("Convenience Store");
    expect(draft.reviewState).toBe("parsed");
    expect(draft.userEditedAt).toBeNull();
  });

  it("stores amount as exact text string", () => {
    const input = makeInput({ amount: "99.99" });
    const draft = insertDraft(db, input);
    expect(typeof draft.amount).toBe("string");
    expect(draft.amount).toBe("99.99");
  });

  it("stores user_edited_at when provided", () => {
    const ts = "2025-06-22T10:00:00.000Z";
    const input = makeInput({ userEditedAt: ts });
    const draft = insertDraft(db, input);
    expect(draft.userEditedAt).toBe(ts);
  });

  it("upsert replaces existing draft for same slip_id", () => {
    const input1 = makeInput({ amount: "50.00", merchant: "Original" });
    insertDraft(db, input1);

    const updated = upsertDraft(db, {
      ...input1,
      amount: "75.00",
      merchant: "Updated",
      reviewState: ReviewState.NeedsReview,
      duplicateRisk: true,
      hasUncertainty: true,
    });

    const matches = getAllDrafts(db).filter((d) => d.slipId === input1.slipId);
    expect(matches.length).toBe(1);
    expect(updated.amount).toBe("75.00");
    expect(updated.merchant).toBe("Updated");
    expect(updated.reviewState).toBe("needs_review");
    expect(updated.duplicateRisk).toBe(1);
  });

  it("getDraft returns null for non-existent id", () => {
    expect(getDraft(db, 99999)).toBeNull();
  });

  it("getDraftBySlipId returns correct draft", () => {
    const input = makeInput({ merchant: "Get By Slip" });
    insertDraft(db, input);
    const draft = getDraftBySlipId(db, input.slipId);
    expect(draft).not.toBeNull();
    expect(draft!.merchant).toBe("Get By Slip");
  });

  it("getDraftsByReviewState filters correctly", () => {
    const r1 = makeInput({ reviewState: ReviewState.Ready, merchant: "Ready Filter" });
    const r2 = makeInput({ reviewState: ReviewState.NeedsReview, merchant: "NeedsReview Filter" });
    insertDraft(db, r1);
    insertDraft(db, r2);

    const readyDrafts = getDraftsByReviewState(db, "ready");
    expect(readyDrafts.length).toBeGreaterThanOrEqual(1);
    expect(readyDrafts.every((d) => d.reviewState === "ready")).toBe(true);
  });

  it("updateDraftField updates user_edited_at", () => {
    const input = makeInput({ merchant: "Edit Test" });
    const draft = insertDraft(db, input);
    const ts = "2025-06-22T12:00:00.000Z";
    const updated = updateDraftField(db, draft.id, "user_edited_at", ts);
    expect(updated.userEditedAt).toBe(ts);
  });

  it("deleteDraftBySlipId removes draft and returns true", () => {
    const input = makeInput({ merchant: "Delete Test" });
    insertDraft(db, input);
    expect(deleteDraftBySlipId(db, input.slipId)).toBe(true);
    expect(getDraftBySlipId(db, input.slipId)).toBeNull();
  });

  it("deleteDraftBySlipId returns false for non-existent slip", () => {
    expect(deleteDraftBySlipId(db, 99999)).toBe(false);
  });

  it("rejects insert with duplicate slip_id", () => {
    const input = makeInput({ merchant: "Dup Slip" });
    insertDraft(db, input);
    expect(() => insertDraft(db, input)).toThrow();
  });
});
