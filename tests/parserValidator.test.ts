import { describe, expect, it } from "bun:test";
import {
  validateParseResult,
  determineInitialReviewState,
  checkReadiness,
} from "../src/domain/parserValidator";
import {
  ParserRunStatus,
  CurrencyCode,
  ReviewState,
  type ParseResult,
} from "../src/domain/types";

describe("validateParseResult", () => {
  it("returns meaningful=true and parsedSlip for a complete parse", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "123.45",
      currency: "THB",
      parsedMerchant: "7-Eleven",
      sourceIdentifier: "REF001",
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
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
    expect(parsedSlip.parsedMerchant).toBe("7-Eleven");
    expect(parsedSlip.normalizedMerchant).toBe("7-Eleven");
    expect(parsedSlip.hasUncertainty).toBe(false);
  });

  it("returns amount as exact string, never number", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "99.99",
      currency: "THB",
      parsedMerchant: "Test",
      sourceIdentifier: null,
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
    };
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(typeof parsedSlip.amount).toBe("string");
    expect(parsedSlip.amount).toBe("99.99");
  });

  it("treats empty/whitespace strings as null", () => {
    const result: ParseResult = {
      date: "",
      amount: "   ",
      currency: null,
      parsedMerchant: "Shop",
      sourceIdentifier: null,
      confidence: "low",
      uncertainties: {},
      status: ParserRunStatus.Partial,
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
      sourceIdentifier: null,
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
    };
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.currency).toBe(CurrencyCode.THB);
    expect(parsedSlip.hasUncertainty).toBe(true); // currency uncertainty recorded
  });

  it("normalizes comma decimal separator to dot", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "123,45",
      currency: "THB",
      parsedMerchant: "Shop",
      sourceIdentifier: null,
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
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
      sourceIdentifier: null,
      confidence: "high",
      uncertainties: {},
      status: ParserRunStatus.Success,
    };
    const { parsedSlip } = validateParseResult(result, "/tmp/s.jpg", "h");
    expect(parsedSlip.amount).toBeNull();
    expect(parsedSlip.hasUncertainty).toBe(true);
  });

  it("returns isMeaningful=false when status is failed", () => {
    const result: ParseResult = {
      date: "2025-06-22",
      amount: "123.45",
      currency: "THB",
      parsedMerchant: "Shop",
      sourceIdentifier: null,
      confidence: "low",
      uncertainties: {},
      status: ParserRunStatus.Failed,
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
      sourceIdentifier: null,
      confidence: "medium",
      uncertainties: { amount: { uncertain: true, reason: "blurry" } },
      status: ParserRunStatus.Partial,
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
      currency: CurrencyCode.THB,
      parsedMerchant: "Shop",
      normalizedMerchant: "Shop",
      destinationAccountName: "Shop",
      sourceIdentifier: null,
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
      currency: CurrencyCode.THB,
      parsedMerchant: "Shop",
      normalizedMerchant: "Shop",
      destinationAccountName: "Shop",
      sourceIdentifier: null,
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
      currency: CurrencyCode.THB,
      parsedMerchant: "Shop",
      normalizedMerchant: "Shop",
      destinationAccountName: "Shop",
      sourceIdentifier: null,
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
