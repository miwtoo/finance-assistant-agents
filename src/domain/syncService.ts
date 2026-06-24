import type { DraftTransaction, CurrencyCode } from "./types";

// ─── Exported types ───────────────────────────────────────────

export interface SyncItem {
  draftId: string;
  merchant: string;
  amount: string;
  currency: CurrencyCode;
  category: string | null;
  sourceAccountName: string | null;
  externalId: string;
  blocked: boolean;
  blockReason?: string;
}

export interface SyncConfirmation {
  totalCount: number;
  amountsByCurrency: Record<string, string>;
  items: SyncItem[];
  warnings: string[];
}

// ─── Helpers ──────────────────────────────────────────────────

function isReady(d: DraftTransaction): boolean {
  return (
    !!d.date &&
    !!d.amount &&
    !!d.currency &&
    !!d.merchant &&
    !!d.sourceAccountName &&
    !!d.category &&
    !d.duplicateRisk
  );
}

// ─── Public API ───────────────────────────────────────────────

export function buildSyncExternalId(
  draftId: string,
  transactionIndex: number,
): string {
  return `slip-sync:${draftId}:${transactionIndex}`;
}

export function buildSyncConfirmation(
  drafts: DraftTransaction[],
): SyncConfirmation {
  const items: SyncItem[] = [];
  let totalCount = 0;
  const amountsByCurrency: Record<string, string> = {};
  const warnings: string[] = [];

  for (const d of drafts) {
    if (d.duplicateRisk) {
      items.push({
        draftId: d.id,
        merchant: d.merchant,
        amount: d.amount,
        currency: d.currency,
        category: d.category,
        sourceAccountName: d.sourceAccountName,
        externalId: buildSyncExternalId(d.id, 0),
        blocked: true,
        blockReason: "duplicate_risk",
      });
      continue;
    }

    if (!isReady(d)) {
      items.push({
        draftId: d.id,
        merchant: d.merchant,
        amount: d.amount,
        currency: d.currency,
        category: d.category,
        sourceAccountName: d.sourceAccountName,
        externalId: buildSyncExternalId(d.id, 0),
        blocked: true,
        blockReason: "not_ready",
      });
      continue;
    }

    // Ready draft
    totalCount++;
    const prev = amountsByCurrency[d.currency];
    amountsByCurrency[d.currency] = prev
      ? (Number(prev) + Number(d.amount)).toFixed(2)
      : d.amount;

    items.push({
      draftId: d.id,
      merchant: d.merchant,
      amount: d.amount,
      currency: d.currency,
      category: d.category,
      sourceAccountName: d.sourceAccountName,
      externalId: buildSyncExternalId(d.id, 0),
      blocked: false,
    });
  }

  return { totalCount, amountsByCurrency, items, warnings };
}
