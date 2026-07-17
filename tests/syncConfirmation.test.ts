import { describe, expect, it } from "bun:test";
import {
  buildSyncExternalId,
  buildSyncConfirmation,
  type SyncConfirmation,
  type SyncItem,
} from "../src/domain/syncService";
import {
  CurrencyCode,
  ReviewState,
  SyncState,
  type DraftTransaction,
} from "../src/domain/types";

// ─── Helpers ──────────────────────────────────────────────────

function readyDraft(
  overrides: Partial<DraftTransaction> = {},
): DraftTransaction {
  return {
    id: overrides.id ?? "draft-1",
    slipPath: "/tmp/test/slip.jpg",
    contentHash: "abc123",
    date: "2025-06-24",
    amount: "150.00",
    currency: CurrencyCode.THB,
    merchant: "7-Eleven",
    parsedMerchant: "7-Eleven",
    parsedCategory: "Convenience",
    sourceIdentifier: "REF001",
    sourceAccountHints: [],
    sourceAccountName: "SCB Savings",
    sourceAccountId: "asset-1",
    category: "Groceries",
    reviewState: ReviewState.Ready,
    syncState: SyncState.Unsynced,
    duplicateRisk: false,
    userEditedAt: "2025-06-24T10:00:00Z",
    ...overrides,
  };
}

// ─── buildSyncExternalId ──────────────────────────────────────

describe("buildSyncExternalId", () => {
  it("returns slip-sync:{draftId}:{index} format", () => {
    const id = buildSyncExternalId("abc-123", 0);
    expect(id).toBe("slip-sync:abc-123:0");
  });

  it("is stable (deterministic) for same inputs", () => {
    const a = buildSyncExternalId("draft-1", 0);
    const b = buildSyncExternalId("draft-1", 0);
    expect(a).toBe(b);
  });

  it("includes correct transaction index", () => {
    const id = buildSyncExternalId("draft-1", 2);
    expect(id).toBe("slip-sync:draft-1:2");
  });
});

// ─── buildSyncConfirmation ────────────────────────────────────

describe("buildSyncConfirmation", () => {
  it("returns count 1 and totals for a single ready draft", () => {
    const draft = readyDraft();
    const result = buildSyncConfirmation([draft]);

    expect(result.totalCount).toBe(1);
    expect(result.amountsByCurrency).toEqual({ THB: "150.00" });
    expect(result.items).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("includes merchant, category, source account in item", () => {
    const draft = readyDraft({
      id: "draft-2",
      merchant: "Big C",
      category: "Food",
      sourceAccountName: "KBank Checking",
    });
    const result = buildSyncConfirmation([draft]);
    const item = result.items[0];

    expect(item.merchant).toBe("Big C");
    expect(item.category).toBe("Food");
    expect(item.sourceAccountName).toBe("KBank Checking");
    expect(item.blocked).toBe(false);
  });

  it("excludes duplicate-risk draft, marks blocked with reason duplicate_risk", () => {
    const ready = readyDraft();
    const risky = readyDraft({
      id: "draft-risky",
      duplicateRisk: true,
      amount: "500.00",
      merchant: "Fraud Co",
    });
    const result = buildSyncConfirmation([ready, risky]);

    // Only the ready draft is counted
    expect(result.totalCount).toBe(1);
    expect(result.amountsByCurrency).toEqual({ THB: "150.00" });

    // Both items present but risky is blocked
    expect(result.items).toHaveLength(2);
    const blockedItem = result.items.find((i) => i.draftId === "draft-risky");
    expect(blockedItem).toBeDefined();
    expect(blockedItem!.blocked).toBe(true);
    expect(blockedItem!.blockReason).toBe("duplicate_risk");
  });

  it("excludes needs-review draft (missing source account), marks blocked with reason not_ready", () => {
    const ready = readyDraft();
    const incomplete = readyDraft({
      id: "draft-missing",
      sourceAccountName: null,
      category: null,
      merchant: "Incomplete Co",
    });
    const result = buildSyncConfirmation([ready, incomplete]);

    expect(result.totalCount).toBe(1);
    expect(result.amountsByCurrency).toEqual({ THB: "150.00" });

    const blockedItem = result.items.find(
      (i) => i.draftId === "draft-missing",
    );
    expect(blockedItem).toBeDefined();
    expect(blockedItem!.blocked).toBe(true);
    expect(blockedItem!.blockReason).toBe("not_ready");
  });

  it("excludes needs-review draft even when required fields are present", () => {
    const draft = readyDraft({
      id: "draft-needs-review",
      reviewState: ReviewState.NeedsReview,
    });
    const result = buildSyncConfirmation([draft]);

    expect(result.totalCount).toBe(0);
    expect(result.amountsByCurrency).toEqual({});
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.blocked).toBe(true);
    expect(result.items[0]!.blockReason).toBe("not_ready");
  });

  it("sums amounts for multiple ready drafts in the same currency", () => {
    const d1 = readyDraft({
      id: "same-1",
      amount: "100.00",
      currency: CurrencyCode.THB,
    });
    const d2 = readyDraft({
      id: "same-2",
      amount: "50.00",
      currency: CurrencyCode.THB,
    });
    const result = buildSyncConfirmation([d1, d2]);

    expect(result.totalCount).toBe(2);
    expect(result.amountsByCurrency).toEqual({ THB: "150.00" });
  });

  it("handles mixed drafts: some ready, some blocked for different reasons", () => {
    const d1 = readyDraft({
      id: "d1",
      amount: "100.00",
      currency: CurrencyCode.THB,
    });
    const d2 = readyDraft({
      id: "d2",
      amount: "50.00",
      currency: CurrencyCode.USD,
      merchant: "US Cafe",
      sourceAccountName: "US Bank",
    });
    const risky = readyDraft({
      id: "d3",
      duplicateRisk: true,
      amount: "200.00",
      merchant: "Risky Biz",
    });
    const incomplete = readyDraft({
      id: "d4",
      sourceAccountName: null,
      category: null,
      merchant: "No Account",
    });

    const result = buildSyncConfirmation([d1, d2, risky, incomplete]);

    expect(result.totalCount).toBe(2);
    expect(result.amountsByCurrency).toEqual({ THB: "100.00", USD: "50.00" });
    expect(result.items).toHaveLength(4);

    const riskyItem = result.items.find((i) => i.draftId === "d3");
    expect(riskyItem!.blocked).toBe(true);
    expect(riskyItem!.blockReason).toBe("duplicate_risk");

    const incItem = result.items.find((i) => i.draftId === "d4");
    expect(incItem!.blocked).toBe(true);
    expect(incItem!.blockReason).toBe("not_ready");
  });
});
