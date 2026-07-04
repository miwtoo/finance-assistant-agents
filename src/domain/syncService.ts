import { ReviewState, type DraftTransaction, type CurrencyCode } from "./types";

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

/** Add two decimal strings without floating-point precision loss. */
function addDecimalStrings(a: string, b: string): string {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const ap = BigInt(ai + af.padEnd(scale, "0"));
  const bp = BigInt(bi + bf.padEnd(scale, "0"));
  const sum = (ap + bp).toString().padStart(scale + 1, "0");
  const intPart = sum.slice(0, -scale);
  const fracPart = sum.slice(-scale);
  return scale === 0 ? intPart : `${intPart}.${fracPart}`;
}

function isReady(d: DraftTransaction): boolean {
  return (
    d.reviewState === ReviewState.Ready &&
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
      ? addDecimalStrings(prev, d.amount)
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
