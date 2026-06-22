import {
  CurrencyCode,
  ReviewState,
  ParserRunStatus,
  type ParseResult,
  type ParsedSlip,
  type SourceAccountHint,
} from "./types";
import { normalizeMerchant } from "./merchantNormalizer";

/** Minimum required fields for a parse to be considered meaningful. */
const MEANINGFUL_FIELDS: (keyof ParseResult)[] = [
  "date",
  "amount",
  "parsedMerchant",
];

/** Amount format: optional leading -, digits, optional single . or , as decimal. */
const AMOUNT_REGEX = /^-?\d+([.,]\d+)?$/;

/** Date format: YYYY-MM-DD */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function trimOrNull(s: string | null | undefined): string | null {
  if (!s || s.trim() === "") return null;
  return s.trim();
}

/**
 * Validate an amount string format.
 * Returns normalized decimal string (comma→dot) or null if invalid.
 */
export function validateAmount(raw: string | null): string | null {
  const trimmed = trimOrNull(raw);
  if (!trimmed) return null;
  if (!AMOUNT_REGEX.test(trimmed)) return null;
  return trimmed.replace(",", ".");
}

/**
 * Validate a date string format (YYYY-MM-DD).
 */
export function validateDate(raw: string | null): string | null {
  const trimmed = trimOrNull(raw);
  if (!trimmed) return null;
  if (!DATE_REGEX.test(trimmed)) return null;
  // Reject invalid dates like 2025-02-30
  const d = new Date(trimmed + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  // Ensure the date components match (catches e.g. 2025-02-30 → 2025-03-02)
  const iso = d.toISOString().slice(0, 10);
  if (iso !== trimmed) return null;
  return trimmed;
}

/**
 * Resolve currency: known CurrencyCode → as-is; null/unknown → THB + uncertainty.
 */
export function resolveCurrency(
  raw: string | null,
): { currency: CurrencyCode; uncertain: boolean } {
  const trimmed = trimOrNull(raw);
  if (trimmed) {
    const upper = trimmed.toUpperCase();
    if (upper in CurrencyCode && upper !== "UNKNOWN") {
      return { currency: CurrencyCode[upper as keyof typeof CurrencyCode], uncertain: false };
    }
  }
  // null, empty, "UNKNOWN", or unrecognized → default THB, record uncertainty
  return { currency: CurrencyCode.THB, uncertain: true };
}

/**
 * Build a set of uncertainties from a ParseResult, without mutating it.
 * Returns a new Record with all detected uncertainties merged.
 */
function collectUncertainties(result: ParseResult): Record<string, { uncertain: boolean; reason?: string }> {
  const u: Record<string, { uncertain: boolean; reason?: string }> = {};

  // Copy existing uncertainties from the provider
  for (const [key, val] of Object.entries(result.uncertainties)) {
    if (val?.uncertain) {
      u[key] = { uncertain: true, reason: val.reason };
    }
  }

  // Low overall confidence implies general uncertainty
  if (result.confidence === "low" && !u["_overall"]) {
    u["_overall"] = { uncertain: true, reason: "Parser returned low confidence" };
  }

  return u;
}

/**
 * Validate a raw ParseResult and produce a domain-level ParsedSlip.
 *
 * Rules:
 * - NEVER mutates the input ParseResult.
 * - Amount: must be valid decimal string; invalid → null + uncertainty.
 * - Date: must be valid YYYY-MM-DD; invalid → null + uncertainty.
 * - Currency: null/unknown/default → THB + uncertainty.
 * - "Meaningful parse" = at least one of {date, amount, parsedMerchant} is present
 *   AND status is not "failed".
 * - Uncertainty is collected from provider + validation results.
 */
export function validateParseResult(
  result: ParseResult,
  sourcePath: string,
  contentHash: string,
): { parsedSlip: ParsedSlip; isMeaningful: boolean; uncertainties: Record<string, { uncertain: boolean; reason?: string }> } {
  const date = validateDate(result.date);
  const amount = validateAmount(result.amount);
  const parsedMerchant = trimOrNull(result.parsedMerchant);
  const sourceIdentifier = trimOrNull(result.sourceIdentifier);
  const parsedCategory = trimOrNull(result.parsedCategory);
  const sourceAccountHints: SourceAccountHint[] = Array.isArray(result.sourceAccountHints)
    ? result.sourceAccountHints.filter(
        (h): h is SourceAccountHint =>
          typeof h?.identifier === "string" && h.identifier.length > 0,
      )
    : [];

  // Resolve currency
  const { currency, uncertain: currencyUncertain } = resolveCurrency(result.currency);

  // Collect uncertainties (from provider) + add validation-derived ones
  const uncertainties = collectUncertainties(result);

  // Add validation-derived uncertainties
  if (result.date !== null && date === null) {
    uncertainties["date"] = { uncertain: true, reason: `Invalid date format: "${result.date}"` };
  }
  if (result.amount !== null && amount === null) {
    uncertainties["amount"] = { uncertain: true, reason: `Invalid amount format: "${result.amount}"` };
  }
  if (currencyUncertain) {
    const raw = trimOrNull(result.currency);
    uncertainties["currency"] = {
      uncertain: true,
      reason: raw
        ? `Unrecognized currency "${raw}", defaulted to THB`
        : "Currency not detected, defaulted to THB",
    };
  }

  const hasUncertainty = Object.values(uncertainties).some((u) => u.uncertain);

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
      parsedCurrency: trimOrNull(result.currency),
      parsedMerchant,
      normalizedMerchant,
      destinationAccountName: normalizedMerchant,
      parsedCategory,
      sourceIdentifier,
      sourceAccountHints,
      hasUncertainty,
    },
    isMeaningful,
    uncertainties,
  };
}

/**
 * Determine the initial review state for a newly created draft.
 *
 * - If hasUncertainty → NeedsReview
 * - If any required field is missing → NeedsReview
 *   Required fields: amount, date, parsedMerchant
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
 *
 * Validates:
 * - Amount is present AND valid decimal format
 * - Date is present AND valid YYYY-MM-DD
 * - Currency is set and known
 * - Merchant is present
 * - Source account is assigned
 * - No duplicate risk
 * - No unresolved uncertainty
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

  // Amount: must be present and valid format
  if (!draft.amount) {
    errors.push("Amount is required");
  } else if (!validateAmount(draft.amount)) {
    errors.push(`Amount "${draft.amount}" is not a valid decimal format`);
  }

  // Date: must be present and valid
  if (!draft.date) {
    errors.push("Transaction date is required");
  } else if (!validateDate(draft.date)) {
    errors.push(`Date "${draft.date}" is not a valid date (expected YYYY-MM-DD)`);
  }

  // Currency: must be set and not UNKNOWN
  if (!draft.currency) {
    errors.push("Currency is required");
  } else if (draft.currency === "UNKNOWN") {
    errors.push("Currency must be resolved (currently UNKNOWN)");
  }

  // Merchant
  if (!draft.merchant) {
    errors.push("Merchant is required");
  }

  // Source account
  if (!draft.sourceAccountName) {
    errors.push("Source account is required");
  }

  // Duplicate risk
  if (draft.duplicateRisk) {
    errors.push("Duplicate risk must be resolved before marking as ready");
  }

  // Uncertainty
  if (draft.hasUncertainty) {
    errors.push("Unresolved parser uncertainty must be reviewed before marking as ready");
  }

  return { ready: errors.length === 0, errors };
}
