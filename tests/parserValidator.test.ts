import { describe, expect, it } from "bun:test";
import {
  validateParseResult,
  determineInitialReviewState,
  checkReadiness,
  validateAmount,
  validateDate,
  resolveCurrency,
} from "../src/domain/parserValidator";
import {
  ParserRunStatus,
  CurrencyCode,
  ReviewState,
  type ParseResult,
} from "../src/domain/types";

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

describe("validateDate", () => {
  it("returns null for null/empty", () => {
    expect(validateDate(null)).toBeNull();
    expect(validateDate("")).toBeNull();
  });

  it("accepts valid YYYY-MM-DD", () => {
    expect(validateDate("2025-06-22")).toBe("2025-06-22");
    expect(validateDate("2024-02-28")).toBe("2024-02-28");
    expect(validateDate("2024-02-29")).toBe("2024-02-29"); // leap year
  });

  it("rejects invalid dates", () => {
    expect(validateDate("2025-13-01")).toBeNull(); // invalid month
    expect(validateDate("2025-02-30")).toBeNull(); // invalid day
    expect(validateDate("not-a-date")).toBeNull();
    expect(validateDate("2025/06/22")).toBeNull();
  });
});

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

describe("validateParseResult", () => {
  it("returns meaningful=true and parsedSlip for a complete parse", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "123.45",
      currency: "THB",
      parsedMerchant: "7-Eleven",
      parsedCategory: "Convenience Store",
      sourceIdentifier: "REF001",
      sourceAccountHints: [{ identifier: "1234", evidence: "X-1234", source: "card" }],
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
      providerRawPayload: {},
    };
    const { parsedSlip, isMeaningful } = validateParseResult(
      result,
      "/tmp/slip.jpg",
      "abc123",
    );
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
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "99.99",
      currency: "THB",
      parsedMerchant: "Test",
      parsedCategory: null,
      sourceIdentifier: null,
      sourceAccountHints: [],
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
      providerRawPayload: { key: "original" },
    };
    const frozen = JSON.stringify(result);
    validateParseResult(result, "/tmp/s.jpg", "h");
    expect(JSON.stringify(result)).toBe(frozen);
  });

  it("treats empty/whitespace strings as null", () => {
    const result: ParseResult = {
      date: "",
      amount: "   ",
      currency: null,
      parsedMerchant: "Shop",
      parsedCategory: null,
      sourceIdentifier: null,
      sourceAccountHints: [],
      confidence: "low",
      uncertainties: {},
      status: ParserRunStatus.Partial,
      providerRawPayload: {},
    };
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.date).toBeNull();
    expect(parsedSlip.amount).toBeNull();
    expect(parsedSlip.parsedMerchant).toBe("Shop");
    expect(parsedSlip.hasUncertainty).toBe(true); // low confidence
  });

  it("defaults missing currency to THB and records uncertainty", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "50.00",
      currency: null,
      parsedMerchant: "Shop",
      parsedCategory: null,
      sourceIdentifier: null,
      sourceAccountHints: [],
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
      providerRawPayload: {},
    };
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.currency).toBe(CurrencyCode.THB);
    expect(parsedSlip.parsedCurrency).toBeNull();
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("defaults unknown currency string to THB with uncertainty", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "50.00",
      currency: "XYZ",
      parsedMerchant: "Shop",
      parsedCategory: null,
      sourceIdentifier: null,
      sourceAccountHints: [],
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
      providerRawPayload: {},
    };
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.currency).toBe(CurrencyCode.THB);
    expect(parsedSlip.parsedCurrency).toBe("XYZ");
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("defaults UNKNOWN currency to THB with uncertainty", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "50.00",
      currency: "UNKNOWN",
      parsedMerchant: "Shop",
      parsedCategory: null,
      sourceIdentifier: null,
      sourceAccountHints: [],
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
      providerRawPayload: {},
    };
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.currency).toBe(CurrencyCode.THB);
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("normalizes comma decimal separator to dot", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "123,45",
      currency: "THB",
      parsedMerchant: "Shop",
      parsedCategory: null,
      sourceIdentifier: null,
      sourceAccountHints: [],
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
      providerRawPayload: {},
    };
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.amount).toBe("123.45");
  });

  it("rejects invalid amount format as null with uncertainty", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "12.34.56",
      currency: "THB",
      parsedMerchant: "Shop",
      parsedCategory: null,
      sourceIdentifier: null,
      sourceAccountHints: [],
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
      providerRawPayload: {},
    };
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.amount).toBeNull();
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("rejects invalid date format as null with uncertainty", () => {
    const result: ParseResult = {
      date: "not-a-date",
      amount: "100.00",
      currency: "THB",
      parsedMerchant: "Shop",
      parsedCategory: null,
      sourceIdentifier: null,
      sourceAccountHints: [],
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
      providerRawPayload: {},
    };
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.date).toBeNull();
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("returns isMeaningful=false when status is failed", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "123.45",
      currency: "THB",
      parsedMerchant: "Shop",
      parsedCategory: null,
      sourceIdentifier: null,
      sourceAccountHints: [],
      confidence: "low",
      uncertainties: {},
      status: ParserRunStatus.Failed,
      providerRawPayload: {},
    };
    const { isMeaningful, parsedSlip } = validateParseResult(
      result,
      "/tmp/s.jpg",
      "h",
    );
    expect(isMeaningful).toBe(false);
    expect(parsedSlip.amount).toBe("123.45"); // still parsed, but not meaningful
  });

  it("returns isMeaningful=true when at least one meaningful field present", () => {
    const result: ParseResult = {
      date: null,
      amount: null,
      currency: null,
      parsedMerchant: "Shop",
      parsedCategory: null,
      sourceIdentifier: null,
      sourceAccountHints: [],
      confidence: "medium",
      uncertainties: { amount: { uncertain: true, reason: "blurry" } },
      status: ParserRunStatus.Partial,
      providerRawPayload: {},
    };
    const { isMeaningful } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(isMeaningful).toBe(true); // parsedMerchant is present
  });
});

describe("determineInitialReviewState", () => {
  it("returns Parsed when all required fields present and no uncertainty", () => {
    const state = determineInitialReviewState({
      sourcePath: "/tmp/s.jpg",
      contentHash: "h",
      date: "2025-06-22",
      amount: "123.45",
      parsedCurrency: "THB",
      currency: CurrencyCode.THB,
      parsedMerchant: "Shop",
      parsedCategory: null,
      normalizedMerchant: "Shop",
      destinationAccountName: "Shop",
      sourceIdentifier: null,
      sourceAccountHints: [],
      hasUncertainty: false,
    });
    expect(state).toBe(ReviewState.Parsed);
  });

  it("returns NeedsReview when amount is missing", () => {
    const state = determineInitialReviewState({
      sourcePath: "/tmp/s.jpg",
      contentHash: "h",
      date: "2025-06-22",
      amount: null,
      parsedCurrency: "THB",
      currency: CurrencyCode.THB,
      parsedMerchant: "Shop",
      parsedCategory: null,
      normalizedMerchant: "Shop",
      destinationAccountName: "Shop",
      sourceIdentifier: null,
      sourceAccountHints: [],
      hasUncertainty: false,
    });
    expect(state).toBe(ReviewState.NeedsReview);
  });

  it("returns NeedsReview when hasUncertainty is true", () => {
    const state = determineInitialReviewState({
      sourcePath: "/tmp/s.jpg",
      contentHash: "h",
      date: "2025-06-22",
      amount: "123.45",
      parsedCurrency: "THB",
      currency: CurrencyCode.THB,
      parsedMerchant: "Shop",
      parsedCategory: null,
      normalizedMerchant: "Shop",
      destinationAccountName: "Shop",
      sourceIdentifier: null,
      sourceAccountHints: [],
      hasUncertainty: true,
    });
    expect(state).toBe(ReviewState.NeedsReview);
  });
});

describe("checkReadiness", () => {
  it("returns ready=true when all conditions met", () => {
    const result = checkReadiness({
      date: "2025-06-22",
      amount: "123.45",
      currency: "THB",
      merchant: "Shop",
      sourceAccountName: "My Bank",
      duplicateRisk: false,
      hasUncertainty: false,
    });
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns ready=false when amount is missing", () => {
    const result = checkReadiness({
      date: "2025-06-22",
      amount: null,
      currency: "THB",
      merchant: "Shop",
      sourceAccountName: "My Bank",
      duplicateRisk: false,
      hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors).toContain("Amount is required");
  });

  it("returns ready=false when amount has invalid format", () => {
    const result = checkReadiness({
      date: "2025-06-22",
      amount: "abc",
      currency: "THB",
      merchant: "Shop",
      sourceAccountName: "My Bank",
      duplicateRisk: false,
      hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("amount") && e.toLowerCase().includes("valid"))).toBe(true);
  });

  it("returns ready=false when date has invalid format", () => {
    const result = checkReadiness({
      date: "not-a-date",
      amount: "100.00",
      currency: "THB",
      merchant: "Shop",
      sourceAccountName: "My Bank",
      duplicateRisk: false,
      hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("date"))).toBe(true);
  });

  it("returns ready=false when currency is UNKNOWN", () => {
    const result = checkReadiness({
      date: "2025-06-22",
      amount: "100.00",
      currency: "UNKNOWN",
      merchant: "Shop",
      sourceAccountName: "My Bank",
      duplicateRisk: false,
      hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("currency"))).toBe(true);
  });

  it("returns ready=false when sourceAccountName is not set", () => {
    const result = checkReadiness({
      date: "2025-06-22",
      amount: "100.00",
      currency: "THB",
      merchant: "Shop",
      sourceAccountName: null,
      duplicateRisk: false,
      hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("source account"))).toBe(true);
  });

  it("returns ready=false when duplicateRisk is true", () => {
    const result = checkReadiness({
      date: "2025-06-22",
      amount: "100.00",
      currency: "THB",
      merchant: "Shop",
      sourceAccountName: "My Bank",
      duplicateRisk: true,
      hasUncertainty: false,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
  });

  it("returns ready=false when hasUncertainty is true", () => {
    const result = checkReadiness({
      date: "2025-06-22",
      amount: "100.00",
      currency: "THB",
      merchant: "Shop",
      sourceAccountName: "My Bank",
      duplicateRisk: false,
      hasUncertainty: true,
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("uncertainty"))).toBe(true);
  });
});
