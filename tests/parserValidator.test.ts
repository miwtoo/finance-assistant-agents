import { describe, expect, it } from "bun:test";
import {
  validateParseResult,
  determineInitialReviewState,
  checkReadiness,
  validateAmount,
  validateDate,
  resolveCurrency,
  isValidCurrency,
  safeParseResult,
} from "../src/domain/parserValidator";
import {
  ParserRunStatus,
  CurrencyCode,
  ReviewState,
  type ParseResult,
} from "../src/domain/types";

// ─── helpers ──────────────────────────────────────────────────

function makeResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    date: "2025-06-22",
    amount: "123.45",
    currency: "THB",
    parsedMerchant: "7-Eleven",
    parsedCategory: "Convenience Store",
    sourceIdentifier: "REF001",
    sourceAccountHints: [{ identifier: "1234", evidence: "X-1234", source: "card" }],
    confidence: "high",
    assessments: {},
    status: ParserRunStatus.Success,
    providerRawPayload: {},
    ...overrides,
  };
}

// ─── validateAmount ──────────────────────────────────────────

describe("validateAmount", () => {
  it("returns null for null/empty", () => {
    expect(validateAmount(null)).toBeNull();
    expect(validateAmount("")).toBeNull();
    expect(validateAmount("  ")).toBeNull();
  });

  it("accepts valid decimal formats", () => {
    expect(validateAmount("123.45")).toBe("123.45");
    expect(validateAmount("123,45")).toBe("123.45");
    expect(validateAmount("0.99")).toBe("0.99");
    expect(validateAmount("100")).toBe("100");
    expect(validateAmount("-50.00")).toBe("-50.00");
  });

  it("rejects invalid formats", () => {
    expect(validateAmount("12.34.56")).toBeNull();
    expect(validateAmount("abc")).toBeNull();
    expect(validateAmount("12,34,56")).toBeNull();
    expect(validateAmount("1.2.3")).toBeNull();
  });
});

// ─── validateDate ────────────────────────────────────────────

describe("validateDate", () => {
  it("returns null for null/empty", () => {
    expect(validateDate(null)).toBeNull();
    expect(validateDate("")).toBeNull();
  });

  it("accepts valid YYYY-MM-DD", () => {
    expect(validateDate("2025-06-22")).toBe("2025-06-22");
    expect(validateDate("2024-02-28")).toBe("2024-02-28");
    expect(validateDate("2024-02-29")).toBe("2024-02-29");
  });

  it("rejects invalid dates", () => {
    expect(validateDate("2025-13-01")).toBeNull();
    expect(validateDate("2025-02-30")).toBeNull();
    expect(validateDate("not-a-date")).toBeNull();
    expect(validateDate("2025/06/22")).toBeNull();
  });
});

// ─── resolveCurrency / isValidCurrency ───────────────────────

describe("resolveCurrency", () => {
  it("returns known currency code with uncertain=false", () => {
    const r = resolveCurrency("THB");
    expect(r.currency).toBe(CurrencyCode.THB);
    expect(r.uncertain).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(resolveCurrency("thb").currency).toBe(CurrencyCode.THB);
    expect(resolveCurrency("Usd").currency).toBe(CurrencyCode.USD);
  });

  it("defaults THB with uncertain=true for null", () => {
    const r = resolveCurrency(null);
    expect(r.currency).toBe(CurrencyCode.THB);
    expect(r.uncertain).toBe(true);
  });

  it("defaults THB with uncertain=true for UNKNOWN", () => {
    const r = resolveCurrency("UNKNOWN");
    expect(r.currency).toBe(CurrencyCode.THB);
    expect(r.uncertain).toBe(true);
  });

  it("defaults THB with uncertain=true for unrecognized currency", () => {
    const r = resolveCurrency("XYZ");
    expect(r.currency).toBe(CurrencyCode.THB);
    expect(r.uncertain).toBe(true);
  });
});

describe("isValidCurrency", () => {
  it("returns true for known codes", () => {
    expect(isValidCurrency("THB")).toBe(true);
    expect(isValidCurrency("USD")).toBe(true);
    expect(isValidCurrency("thb")).toBe(true);
  });

  it("returns false for null/empty", () => {
    expect(isValidCurrency(null)).toBe(false);
    expect(isValidCurrency("")).toBe(false);
  });

  it("returns false for UNKNOWN", () => {
    expect(isValidCurrency("UNKNOWN")).toBe(false);
    expect(isValidCurrency("unknown")).toBe(false);
  });

  it("returns false for unrecognized codes", () => {
    expect(isValidCurrency("XYZ")).toBe(false);
    expect(isValidCurrency("BTC")).toBe(false);
  });
});

// ─── safeParseResult ─────────────────────────────────────────

describe("safeParseResult", () => {
  it("returns failed result for non-object input", () => {
    const r = safeParseResult(null);
    expect(r.status).toBe(ParserRunStatus.Failed);
    expect(r.providerRawPayload).toBeNull();
  });

  it("returns failed result for string input", () => {
    const r = safeParseResult("not json");
    expect(r.status).toBe(ParserRunStatus.Failed);
  });

  it("extracts fields from a valid object", () => {
    const r = safeParseResult({
      date: "2025-06-22",
      amount: "123.45",
      currency: "THB",
      parsedMerchant: "Shop",
    });
    expect(r.date).toBe("2025-06-22");
    expect(r.amount).toBe("123.45");
    expect(r.currency).toBe("THB");
    expect(r.parsedMerchant).toBe("Shop");
  });

  it("handles missing uncertainties/assessments gracefully", () => {
    const r = safeParseResult({ date: "2025-06-22", amount: "50.00" });
    expect(r.assessments).toEqual({});
    expect(r.status).toBe(ParserRunStatus.Failed); // no status field
  });

  it("accepts assessments field", () => {
    const r = safeParseResult({
      date: "2025-06-22",
      status: "success",
      assessments: { amount: { uncertain: false, confidence: 0.9 } },
    });
    expect(r.assessments).toEqual({ amount: { uncertain: false, confidence: 0.9 } });
  });

  it("falls back to uncertainties field if assessments missing", () => {
    const r = safeParseResult({
      date: "2025-06-22",
      status: "success",
      uncertainties: { amount: { uncertain: false } },
    });
    expect(r.assessments).toEqual({ amount: { uncertain: false } });
  });
});

// ─── validateParseResult ─────────────────────────────────────

describe("validateParseResult", () => {
  it("returns meaningful=true and parsedSlip for a complete parse", () => {
    const result = makeResult();
    const { parsedSlip, isMeaningful } = validateParseResult(result, "/tmp/slip.jpg", "abc123");
    expect(isMeaningful).toBe(true);
    expect(parsedSlip.amount).toBe("123.45");
    expect(typeof parsedSlip.amount).toBe("string");
    expect(parsedSlip.currency).toBe(CurrencyCode.THB);
    expect(parsedSlip.parsedCurrency).toBe("THB");
    expect(parsedSlip.parsedMerchant).toBe("7-Eleven");
    expect(parsedSlip.parsedCategory).toBe("Convenience Store");
    expect(parsedSlip.normalizedMerchant).toBe("7-Eleven");
    expect(parsedSlip.hasUncertainty).toBe(false);
    expect(parsedSlip.sourceAccountHints).toHaveLength(1);
  });

  it("does NOT mutate the input ParseResult", () => {
    const result = makeResult({ providerRawPayload: { key: "original" } });
    const frozen = JSON.stringify(result);
    validateParseResult(result, "/tmp/s.jpg", "h");
    expect(JSON.stringify(result)).toBe(frozen);
  });

  it("treats empty/whitespace strings as null", () => {
    const result = makeResult({
      date: "", amount: "   ", currency: null,
      parsedMerchant: "Shop",
      confidence: "low",
      status: ParserRunStatus.Partial,
    });
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.date).toBeNull();
    expect(parsedSlip.amount).toBeNull();
    expect(parsedSlip.parsedMerchant).toBe("Shop");
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("defaults missing currency to THB and records uncertainty", () => {
    const result = makeResult({ currency: null });
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.currency).toBe(CurrencyCode.THB);
    expect(parsedSlip.parsedCurrency).toBeNull();
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("defaults unknown currency string to THB with uncertainty", () => {
    const result = makeResult({ currency: "XYZ" });
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.currency).toBe(CurrencyCode.THB);
    expect(parsedSlip.parsedCurrency).toBe("XYZ");
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("defaults UNKNOWN currency to THB with uncertainty", () => {
    const result = makeResult({ currency: "UNKNOWN" });
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.currency).toBe(CurrencyCode.THB);
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("normalizes comma decimal separator to dot", () => {
    const result = makeResult({ amount: "123,45" });
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.amount).toBe("123.45");
  });

  it("rejects invalid amount as null with uncertainty", () => {
    const result = makeResult({ amount: "12.34.56" });
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.amount).toBeNull();
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("rejects invalid date as null with uncertainty", () => {
    const result = makeResult({ date: "not-a-date" });
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.date).toBeNull();
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("returns isMeaningful=false when status is failed", () => {
    const result = makeResult({ status: ParserRunStatus.Failed });
    const { isMeaningful } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(isMeaningful).toBe(false);
  });

  it("returns isMeaningful=true when at least one validated field present", () => {
    const result = makeResult({
      date: null, amount: null, currency: null,
      parsedMerchant: "Shop",
      status: ParserRunStatus.Partial,
    });
    const { isMeaningful } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(isMeaningful).toBe(true);
  });

  // ─── Blocker 1: Invalid-only parse → not meaningful ──────────

  it("returns isMeaningful=false when only invalid amount and no other valid field", () => {
    const result = makeResult({
      date: null, amount: "abc", currency: null,
      parsedMerchant: null, status: ParserRunStatus.Partial,
    });
    const { isMeaningful, parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(isMeaningful).toBe(false);
    expect(parsedSlip.amount).toBeNull();
  });

  it("returns isMeaningful=false when only invalid date and no other valid field", () => {
    const result = makeResult({
      date: "not-a-date", amount: null, currency: null,
      parsedMerchant: null, status: ParserRunStatus.Partial,
    });
    const { isMeaningful, parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(isMeaningful).toBe(false);
    expect(parsedSlip.date).toBeNull();
  });

  // ─── Blocker 2: Safe assessments collection tolerates malformed ──

  it("tolerates null assessments without throwing", () => {
    const result = makeResult({ assessments: null as any, date: "2025-06-22", amount: "100.00" });
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.date).toBe("2025-06-22");
    expect(parsedSlip.amount).toBe("100.00");
  });

  it("tolerates string assessments without throwing", () => {
    const result = makeResult({ assessments: "oops" as any });
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.amount).toBe("123.45");
  });

  it("collects per-field numeric confidence from assessments", () => {
    const result = makeResult({
      assessments: {
        amount: { uncertain: false, confidence: 0.95 },
        date: { uncertain: false, confidence: 0.98 },
        currency: { uncertain: true, confidence: 0.2, reason: "blurry" },
      },
    });
    const { uncertainties } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(uncertainties["amount"]?.confidence).toBe(0.95);
    expect(uncertainties["date"]?.confidence).toBe(0.98);
    expect(uncertainties["currency"]?.uncertain).toBe(true);
  });

  it("clamps out-of-range confidence values", () => {
    const result = makeResult({
      assessments: {
        amount: { uncertain: false, confidence: 1.5 },
        date: { uncertain: false, confidence: -0.5 },
      },
    });
    const { uncertainties } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(uncertainties["amount"]?.confidence).toBe(1.0);
    expect(uncertainties["date"]?.confidence).toBe(0.0);
  });
});

// ─── determineInitialReviewState ─────────────────────────────

describe("determineInitialReviewState", () => {
  it("returns Parsed when all required fields present and no uncertainty", () => {
    const state = determineInitialReviewState({
      sourcePath: "/tmp/s.jpg", contentHash: "h",
      date: "2025-06-22", amount: "123.45",
      parsedCurrency: "THB", currency: CurrencyCode.THB,
      parsedMerchant: "Shop", parsedCategory: null,
      normalizedMerchant: "Shop", destinationAccountName: "Shop",
      sourceIdentifier: null, sourceAccountHints: [],
      hasUncertainty: false,
    });
    expect(state).toBe(ReviewState.Parsed);
  });

  it("returns NeedsReview when amount is missing", () => {
    const state = determineInitialReviewState({
      sourcePath: "/tmp/s.jpg", contentHash: "h",
      date: "2025-06-22", amount: null,
      parsedCurrency: "THB", currency: CurrencyCode.THB,
      parsedMerchant: "Shop", parsedCategory: null,
      normalizedMerchant: "Shop", destinationAccountName: "Shop",
      sourceIdentifier: null, sourceAccountHints: [],
      hasUncertainty: false,
    });
    expect(state).toBe(ReviewState.NeedsReview);
  });

  it("returns NeedsReview when hasUncertainty is true", () => {
    const state = determineInitialReviewState({
      sourcePath: "/tmp/s.jpg", contentHash: "h",
      date: "2025-06-22", amount: "123.45",
      parsedCurrency: "THB", currency: CurrencyCode.THB,
      parsedMerchant: "Shop", parsedCategory: null,
      normalizedMerchant: "Shop", destinationAccountName: "Shop",
      sourceIdentifier: null, sourceAccountHints: [],
      hasUncertainty: true,
    });
    expect(state).toBe(ReviewState.NeedsReview);
  });
});

// ─── checkReadiness ──────────────────────────────────────────

describe("checkReadiness", () => {
  it("returns ready=true when all conditions met", () => {
    const result = checkReadiness({
      date: "2025-06-22", amount: "123.45", currency: "THB",
      merchant: "Shop", sourceAccountName: "My Bank",
      duplicateRisk: false, hasUncertainty: false,
    });
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns ready=false when amount is missing", () => {
    const result = checkReadiness({
      date: "2025-06-22", amount: null, currency: "THB",
      merchant: "Shop", sourceAccountName: "My Bank",
      duplicateRisk: false, hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors).toContain("Amount is required");
  });

  it("returns ready=false when amount has invalid format", () => {
    const result = checkReadiness({
      date: "2025-06-22", amount: "abc", currency: "THB",
      merchant: "Shop", sourceAccountName: "My Bank",
      duplicateRisk: false, hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("amount") && e.toLowerCase().includes("valid"))).toBe(true);
  });

  it("returns ready=false when date has invalid format", () => {
    const result = checkReadiness({
      date: "not-a-date", amount: "100.00", currency: "THB",
      merchant: "Shop", sourceAccountName: "My Bank",
      duplicateRisk: false, hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("date"))).toBe(true);
  });

  it("returns ready=false when currency is UNKNOWN", () => {
    const result = checkReadiness({
      date: "2025-06-22", amount: "100.00", currency: "UNKNOWN",
      merchant: "Shop", sourceAccountName: "My Bank",
      duplicateRisk: false, hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("currency"))).toBe(true);
  });

  // ─── Blocker 3: Unknown manual currency blocks ready ─────────

  it("returns ready=false when currency is unrecognized like 'XYZ'", () => {
    const result = checkReadiness({
      date: "2025-06-22", amount: "100.00", currency: "XYZ",
      merchant: "Shop", sourceAccountName: "My Bank",
      duplicateRisk: false, hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("XYZ"))).toBe(true);
  });

  it("returns ready=false when sourceAccountName is not set", () => {
    const result = checkReadiness({
      date: "2025-06-22", amount: "100.00", currency: "THB",
      merchant: "Shop", sourceAccountName: null,
      duplicateRisk: false, hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("source account"))).toBe(true);
  });

  it("returns ready=false when duplicateRisk is true", () => {
    const result = checkReadiness({
      date: "2025-06-22", amount: "100.00", currency: "THB",
      merchant: "Shop", sourceAccountName: "My Bank",
      duplicateRisk: true, hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
  });

  it("returns ready=false when hasUncertainty is true", () => {
    const result = checkReadiness({
      date: "2025-06-22", amount: "100.00", currency: "THB",
      merchant: "Shop", sourceAccountName: "My Bank",
      duplicateRisk: false, hasUncertainty: true,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("uncertainty"))).toBe(true);
  });
});
