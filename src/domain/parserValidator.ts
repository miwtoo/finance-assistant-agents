import {
  CurrencyCode,
  VALID_CURRENCY_CODES,
  ReviewState,
  ParserRunStatus,
  type ParseResult,
  type ParsedSlip,
  type SourceAccountHint,
  type FieldAssessment,
} from "./types";
import { normalizeMerchant } from "./merchantNormalizer";

/** Minimum required fields for a parse to be considered meaningful.
 *  Uses VALIDATED values (after format check), not raw provider output. */
const MEANINGFUL_FIELDS: (keyof ParsedSlip)[] = [
  "date",
  "amount",
  "parsedMerchant",
];

/** Amount format: optional leading -, digits, optional single . or , as decimal. */
const AMOUNT_REGEX = /^-?\d+([.,]\d+)?$/;

/** Date format: YYYY-MM-DD */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Max numeric confidence value. */
const MAX_CONFIDENCE = 1.0;
/** Min numeric confidence value. */
const MIN_CONFIDENCE = 0.0;

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
 * Check whether a currency string is a known, valid currency code.
 * UNKNOWN is not considered valid for ready-gate purposes.
 */
export function isValidCurrency(currency: string | null): boolean {
  if (!currency) return false;
  return VALID_CURRENCY_CODES.has(currency.toUpperCase());
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
 * Safely extract assessments from a provider result.
 * Tolerates missing, null, non-object, or wrong-type assessments.
 * Returns a new Record with validated FieldAssessment values.
 */
function collectAssessments(result: ParseResult): Record<string, FieldAssessment> {
  const out: Record<string, FieldAssessment> = {};

  // Safely iterate assessments - handle missing/wrong type
  const raw = result.assessments;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, val] of Object.entries(raw)) {
      if (val && typeof val === "object") {
        const va = val as unknown as Record<string, unknown>;
        const uncertain = va.uncertain === true;
        const reason = typeof va.reason === "string" ? va.reason : undefined;
        let confidence: number | undefined;
        if (typeof va.confidence === "number" && !Number.isNaN(va.confidence)) {
          confidence = Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, va.confidence));
        }
        if (uncertain || reason || confidence !== undefined) {
          out[key] = { uncertain, reason, confidence };
        }
      }
    }
  }

  // Low overall confidence implies general uncertainty
  if (result.confidence === "low" && !out["_overall"]) {
    out["_overall"] = { uncertain: true, reason: "Parser returned low confidence" };
  }

  return out;
}

/**
 * Safely decode a raw unknown payload into a ParseResult.
 * Never throws — returns a failed ParseResult on any error.
 * Use this at the provider boundary before calling validateParseResult.
 */
export function safeParseResult(raw: unknown): ParseResult {
  try {
    if (typeof raw !== "object" || raw === null) {
      return {
        date: null, amount: null, currency: null,
        parsedMerchant: null, parsedCategory: null,
        sourceIdentifier: null, sourceAccountHints: [],
        confidence: "low",
        assessments: {},
        status: ParserRunStatus.Failed,
        providerRawPayload: raw,
      };
    }
    const obj = raw as Record<string, unknown>;

    const safeStr = (k: string): string | null =>
      typeof obj[k] === "string" && obj[k] !== "" ? (obj[k] as string) : null;

    const safeArr = (k: string): unknown[] =>
      Array.isArray(obj[k]) ? (obj[k] as unknown[]) : [];

    return {
      date: safeStr("date"),
      amount: safeStr("amount"),
      currency: safeStr("currency"),
      parsedMerchant: safeStr("parsedMerchant") ?? safeStr("merchant"),
      parsedCategory: safeStr("parsedCategory") ?? safeStr("category"),
      sourceIdentifier: safeStr("sourceIdentifier") ?? safeStr("sourceId"),
      sourceAccountHints: safeArr("sourceAccountHints").filter(
        (h): h is SourceAccountHint =>
          typeof h === "object" && h !== null && typeof (h as Record<string, unknown>).identifier === "string",
      ),
      confidence: ["high", "medium", "low"].includes(obj.confidence as string)
        ? (obj.confidence as "high" | "medium" | "low")
        : "low",
      assessments: typeof obj.assessments === "object" && obj.assessments !== null
        ? (obj.assessments as Record<string, FieldAssessment>)
        : (typeof obj.uncertainties === "object" && obj.uncertainties !== null
            ? (obj.uncertainties as Record<string, FieldAssessment>)
            : {}),
      status: ["success", "partial", "failed"].includes(obj.status as string)
        ? (obj.status as ParserRunStatus)
        : ParserRunStatus.Failed,
      providerRawPayload: raw,
    };
  } catch {
    return {
      date: null, amount: null, currency: null,
      parsedMerchant: null, parsedCategory: null,
      sourceIdentifier: null, sourceAccountHints: [],
      confidence: "low",
      assessments: {},
      status: ParserRunStatus.Failed,
      providerRawPayload: raw,
    };
  }
}

/**
 * Validate a raw ParseResult and produce a domain-level ParsedSlip.
 *
 * Rules:
 * - NEVER mutates the input ParseResult.
 * - Amount: must be valid decimal string; invalid → null + uncertainty.
 * - Date: must be valid YYYY-MM-DD; invalid → null + uncertainty.
 * - Currency: null/unknown/default → THB + uncertainty.
 * - "Meaningful parse" = at least one VALIDATED meaningful field is non-null
 *   AND status is not "failed".
 * - Uncertainty is collected from provider + validation results.
 */
export function validateParseResult(
  result: ParseResult,
  sourcePath: string,
  contentHash: string,
): { parsedSlip: ParsedSlip; isMeaningful: boolean; uncertainties: Record<string, FieldAssessment> } {
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

  // Collect assessments (from provider) safely
  const assessments = collectAssessments(result);

  // Add validation-derived assessments
  if (result.date !== null && date === null) {
    assessments["date"] = { uncertain: true, reason: `Invalid date format: "${result.date}"` };
  }
  if (result.amount !== null && amount === null) {
    assessments["amount"] = { uncertain: true, reason: `Invalid amount format: "${result.amount}"` };
  }
  if (currencyUncertain) {
    const raw = trimOrNull(result.currency);
    assessments["currency"] = {
      uncertain: true,
      reason: raw
        ? `Unrecognized currency "${raw}", defaulted to THB`
        : "Currency not detected, defaulted to THB",
    };
  }

  const hasUncertainty = Object.values(assessments).some((a) => a.uncertain);

  // Normalize merchant
  const normalizedMerchant = parsedMerchant
    ? normalizeMerchant(parsedMerchant)
    : null;

  // Determine if this is a meaningful parse based on VALIDATED fields
  const validatedFields: ParsedSlip = {
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
  };

  const meaningfulCount = MEANINGFUL_FIELDS.filter((field) => {
    const val = validatedFields[field];
    return val !== null && val !== undefined && String(val).trim() !== "";
  }).length;

  const isMeaningful =
    result.status !== ParserRunStatus.Failed && meaningfulCount >= 1;

  return {
    parsedSlip: validatedFields,
    isMeaningful,
    uncertainties: assessments,
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
 * - Currency is set to a valid known CurrencyCode (not UNKNOWN/unrecognized)
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
  sourceAccountId: string | null;
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

  // Currency: must be a known valid code (not UNKNOWN, not unrecognized)
  if (!draft.currency) {
    errors.push("Currency is required");
  } else if (!isValidCurrency(draft.currency)) {
    errors.push(`Currency "${draft.currency}" is not a recognized currency code`);
  }

  // Merchant
  if (!draft.merchant) {
    errors.push("Merchant is required");
  }

  // Source account
  if (!draft.sourceAccountId) {
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
