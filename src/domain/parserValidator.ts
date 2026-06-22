import {
  CurrencyCode,
  ReviewState,
  ParserRunStatus,
  type ParseResult,
  type ParsedSlip,
} from "./types";
import { normalizeMerchant } from "./merchantNormalizer";

/** Minimum required fields for a parse to be considered meaningful. */
const MEANINGFUL_FIELDS: (keyof ParseResult)[] = [
  "date",
  "amount",
  "parsedMerchant",
];

/**
 * Validate a raw ParseResult and produce a domain-level ParsedSlip.
 *
 * Rules:
 * - If amount is present, it must be a valid decimal string (digits, optional dot/comma).
 * - Empty or whitespace-only strings are treated as null.
 * - Currency: if null/empty/unknown, defaults to THB and records uncertainty.
 * - "Meaningful parse" = at least one of {date, amount, parsedMerchant} is present
 *   AND status is not "failed".
 * - Uncertainty is recorded per-field from the ParseResult.
 */
export function validateParseResult(
  result: ParseResult,
  sourcePath: string,
  contentHash: string,
): { parsedSlip: ParsedSlip; isMeaningful: boolean } {
  const trimOrNull = (s: string | null | undefined): string | null => {
    if (!s || s.trim() === "") return null;
    return s.trim();
  };

  const date = trimOrNull(result.date);
  const rawAmount = trimOrNull(result.amount);
  const parsedMerchant = trimOrNull(result.parsedMerchant);
  const sourceIdentifier = trimOrNull(result.sourceIdentifier);

  // Validate amount format if present
  let amount: string | null = null;
  if (rawAmount !== null) {
    // Accept digits, optional single . or , as decimal separator, optional leading -
    if (/^-?\d+([.,]\d+)?$/.test(rawAmount)) {
      // Normalize comma to dot for storage
      amount = rawAmount.replace(",", ".");
    } else {
      // Invalid amount format — treat as uncertain / null
      result.uncertainties["amount"] = {
        uncertain: true,
        reason: `Invalid amount format: "${rawAmount}"`,
      };
    }
  }

  // Currency: default THB if missing
  let currency: CurrencyCode;
  let hasUncertainty = false;
  const rawCurrency = trimOrNull(result.currency);
  if (rawCurrency && rawCurrency.toUpperCase() in CurrencyCode) {
    currency = CurrencyCode[rawCurrency.toUpperCase() as keyof typeof CurrencyCode];
  } else {
    currency = CurrencyCode.THB;
    if (rawCurrency === null) {
      // No currency provided → record uncertainty
      result.uncertainties["currency"] = {
        uncertain: true,
        reason: "Currency not detected, defaulted to THB",
      };
    }
  }

  // Check if any uncertainties exist
  for (const key of Object.keys(result.uncertainties)) {
    if (result.uncertainties[key]?.uncertain) {
      hasUncertainty = true;
      break;
    }
  }

  // Check if confidence is low (implies general uncertainty)
  if (result.confidence === "low") {
    hasUncertainty = true;
  }

  // Normalize merchant
  const normalizedMerchant = parsedMerchant
    ? normalizeMerchant(parsedMerchant)
    : null;

  // Determine if this is a meaningful parse
  const meaningfulCount = MEANINGFUL_FIELDS.filter((field) => {
    const val = result[field];
    return val !== null && val !== undefined && String(val).trim() !== "";
  }).length;

  const isMeaningful =
    result.status !== ParserRunStatus.Failed && meaningfulCount >= 1;

  return {
    parsedSlip: {
      sourcePath,
      contentHash,
      date,
      amount,
      currency,
      parsedMerchant,
      normalizedMerchant,
      destinationAccountName: normalizedMerchant,
      sourceIdentifier,
      hasUncertainty,
    },
    isMeaningful,
  };
}

/**
 * Determine the initial review state for a newly created draft.
 *
 * - If hasUncertainty → NeedsReview
 * - If any required field is missing → NeedsReview
 *   Required fields: amount, date, merchant
 * - Otherwise → Parsed (auto-parsed, awaiting first human look)
 */
export function determineInitialReviewState(
  parsedSlip: ParsedSlip,
): ReviewState {
  const requiredFields: (keyof ParsedSlip)[] = [
    "amount",
    "date",
    "parsedMerchant",
  ];

  const hasAllRequired = requiredFields.every(
    (field) =>
      parsedSlip[field] !== null &&
      parsedSlip[field] !== undefined &&
      String(parsedSlip[field]).trim() !== "",
  );

  if (parsedSlip.hasUncertainty || !hasAllRequired) {
    return ReviewState.NeedsReview;
  }

  return ReviewState.Parsed;
}

/**
 * Check whether a draft can be promoted to "ready" state.
 */
export interface ReadinessResult {
  ready: boolean;
  errors: string[];
}

/**
 * Validates whether a DraftTransaction can be marked ready.
 * Does not access DB — pure domain logic on the draft fields.
 */
export function checkReadiness(draft: {
  date: string | null;
  amount: string | null;
  currency: string | null;
  merchant: string | null;
  sourceAccountName: string | null;
  duplicateRisk: boolean;
  hasUncertainty: boolean;
}): ReadinessResult {
  const errors: string[] = [];

  if (!draft.date) errors.push("Transaction date is required");
  if (!draft.amount) errors.push("Amount is required");
  if (!draft.currency) errors.push("Currency is required");
  if (!draft.merchant) errors.push("Merchant is required");
  if (!draft.sourceAccountName)
    errors.push("Source account is required");
  if (draft.duplicateRisk)
    errors.push(
      "Duplicate risk must be resolved before marking as ready",
    );
  if (draft.hasUncertainty)
    errors.push(
      "Unresolved parser uncertainty must be reviewed before marking as ready",
    );

  return { ready: errors.length === 0, errors };
}
