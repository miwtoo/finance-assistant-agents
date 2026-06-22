import type { ParseResult } from "./types";

/**
 * Parser provider interface.
 *
 * All parser implementations (Gemini, test doubles) must implement this.
 * The provider is injected at app bootstrap — not imported as a singleton.
 */
export interface ParserProvider {
  /** Human-readable provider name (e.g. "gemini", "fake"). */
  readonly name: string;

  /** Model identifier if applicable (e.g. "gemini-1.5-flash"). */
  readonly model: string | null;

  /**
   * Parse a slip image from the given file path.
   *
   * Implementations must:
   * - Return status=success for complete, high-confidence parses
   * - Return status=partial for parses with missing fields or low confidence
   * - Return status=failed for API errors, schema violations, or unparseable images
   * - Set amount as exact decimal string (never number)
   * - Populate uncertainties with per-field reasons when confidence is low
   * - Include the raw provider response in providerRawPayload exactly as received
   *   (before any validation or transformation)
   * - Provide sourceAccountHints with identifier, evidence text, and source location
   * - Provide parsedCategory as a category guess from available context
   * - NOT mutate or transform the response — return exactly what was parsed
   */
  parse(imagePath: string): Promise<ParseResult>;
}
