import type { ParserProvider } from "../../src/domain/parserTypes";
import type { ParseResult } from "../../src/domain/types";
import { ParserRunStatus } from "../../src/domain/types";

/**
 * Configuration for a FakeParser response.
 */
export interface FakeParserConfig {
  /** The result to return from parse() */
  result: ParseResult;
  /** Optional delay in ms to simulate async parsing */
  delayMs?: number;
  /** If set, parse() will throw this error */
  throwError?: string;
}

/**
 * Fake ParserProvider for tests.
 *
 * Returns pre-configured results. Useful for testing draft creation,
 * validation, and error handling without a real AI provider.
 */
export class FakeParser implements ParserProvider {
  readonly name = "fake";
  readonly model: string | null = "fake-model-v1";

  private config: FakeParserConfig;

  constructor(config: FakeParserConfig) {
    this.config = config;
  }

  async parse(_imagePath: string): Promise<ParseResult> {
    if (this.config.throwError) {
      throw new Error(this.config.throwError);
    }

    if (this.config.delayMs) {
      await new Promise((r) => setTimeout(r, this.config.delayMs));
    }

    return this.config.result;
  }

  /** Convenience factory: success result */
  static success(overrides: Partial<ParseResult> = {}): FakeParser {
    return new FakeParser({
      result: {
        date: "2025-06-22",
        amount: "123.45",
        currency: "THB",
        parsedMerchant: "7-Eleven",
        sourceIdentifier: "REF001",
        confidence: "high",
        uncertainties: {},
        status: ParserRunStatus.Success,
        ...overrides,
      },
    });
  }

  /** Convenience factory: partial result (needs review) */
  static partial(overrides: Partial<ParseResult> = {}): FakeParser {
    return new FakeParser({
      result: {
        date: "2025-06-22",
        amount: "123.45",
        currency: null,
        parsedMerchant: "7-Eleven",
        sourceIdentifier: null,
        confidence: "low",
        uncertainties: {
          currency: { uncertain: true, reason: "Currency not detected" },
        },
        status: ParserRunStatus.Partial,
        ...overrides,
      },
    });
  }

  /** Convenience factory: total failure */
  static failure(overrides: Partial<ParseResult> = {}): FakeParser {
    return new FakeParser({
      result: {
        date: null,
        amount: null,
        currency: null,
        parsedMerchant: null,
        sourceIdentifier: null,
        confidence: "low",
        uncertainties: {},
        status: ParserRunStatus.Failed,
        ...overrides,
      },
    });
  }
}
