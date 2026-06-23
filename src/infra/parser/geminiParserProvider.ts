import { readFileSync } from "node:fs";
import { GoogleGenAI, createPartFromBase64, createUserContent } from "@google/genai";
import type { ParserProvider } from "../../domain/parserTypes";
import type { ParseResult, SourceAccountHint, FieldAssessment } from "../../domain/types";
import { ParserRunStatus } from "../../domain/types";

/**
 * MIME type lookup for slip image extensions.
 */
const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/**
 * System prompt instructing Gemini to extract structured data from Thai
 * banking slip images. Returns JSON with exact fields.
 */
const SYSTEM_PROMPT = `You are a financial document parser for Thai banking slips.
Extract transaction details from the slip image and return ONLY valid JSON.

Use the following schema:
{
  "date": "YYYY-MM-DD or null",
  "amount": "exact decimal string (e.g., "123.45") or null",
  "currency": "THB or USD or null",
  "merchant": "merchant/payee name or null",
  "category": "best category guess or null (e.g., "Food & Dining", "Transportation", "Shopping", "Utilities", "Entertainment", "Healthcare", "Education", "Groceries")",
  "sourceIdentifier": "any reference/transaction ID or null",
  "sourceAccountHints": [
    {
      "identifier": "card/account last digits or null",
      "evidence": "how it appeared on slip (e.g., "X-1234")",
      "source": "where on slip (e.g., "card_number", "reference")"
    }
  ]
}

Rules:
- Return amount as exact decimal STRING — never a number. If digits are ambiguous or missing, return null and add to uncertainties.
- If currency is not clearly indicated, return null (app will default to THB).
- If the slip text is unreadable or not a valid banking slip, set all fields to null.
- confidence MUST be one of: "high", "medium", "low".
- uncertainties is a map of field names to objects with "uncertain" (boolean) and optional "reason".
- assessments includes a numeric "confidence" (0.0 to 1.0) per field where possible.`;

/**
 * Gemini ParserProvider implementation.
 *
 * Uses the @google/genai SDK to send slip images to Gemini for structured
 * data extraction. All responses are validated through the existing
 * safeParseResult / validator chain.
 */
export class GeminiParserProvider implements ParserProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly client: GoogleGenAI;

  constructor(apiKey: string, model: string) {
    this.model = model;
    this.client = new GoogleGenAI({ apiKey });
  }

  async parse(imagePath: string): Promise<ParseResult> {
    try {
      // Read image file and determine MIME type
      const ext = extname(imagePath).toLowerCase();
      const mimeType = EXT_MIME[ext];
      if (!mimeType) {
        return {
          date: null, amount: null, currency: null,
          parsedMerchant: null, parsedCategory: null,
          sourceIdentifier: null, sourceAccountHints: [],
          confidence: "low", assessments: {},
          status: ParserRunStatus.Failed,
          providerRawPayload: { error: `Unsupported image type: ${ext}` },
        };
      }

      const imageData = readFileSync(imagePath);
      const base64Data = imageData.toString("base64");

      // Build the content parts: system prompt + image
      const contents = [
        createUserContent([
          createPartFromBase64(base64Data, mimeType),
        ]),
      ];

      // Call Gemini
      const response = await this.client.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      });

      // Extract raw response payload for audit
      const rawPayload = {
        model: this.model,
        promptTokens: response.usageMetadata?.promptTokenCount ?? null,
        candidatesTokenCount: response.usageMetadata?.candidatesTokenCount ?? null,
        finishReason: response.candidates?.[0]?.finishReason ?? null,
        response: response.text ?? null,
      };

      // Parse the JSON response
      const text = response.text ?? "";
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {
          date: null, amount: null, currency: null,
          parsedMerchant: null, parsedCategory: null,
          sourceIdentifier: null, sourceAccountHints: [],
          confidence: "low", assessments: {},
          status: ParserRunStatus.Failed,
          providerRawPayload: rawPayload,
        };
      }

      // Map to ParseResult
      const result = this.mapResponse(parsed);
      result.providerRawPayload = rawPayload;
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        date: null, amount: null, currency: null,
        parsedMerchant: null, parsedCategory: null,
        sourceIdentifier: null, sourceAccountHints: [],
        confidence: "low", assessments: {},
        status: ParserRunStatus.Failed,
        providerRawPayload: { error: errorMessage },
      };
    }
  }

  /**
   * Map the parsed JSON response from Gemini to the ParseResult interface.
   */
  private mapResponse(parsed: Record<string, unknown>): ParseResult {
    const safeStr = (key: string): string | null =>
      typeof parsed[key] === "string" && parsed[key] !== ""
        ? (parsed[key] as string)
        : null;

    const safeArr = (key: string): unknown[] =>
      Array.isArray(parsed[key]) ? (parsed[key] as unknown[]) : [];

    // Map sourceAccountHints
    const hints: SourceAccountHint[] = safeArr("sourceAccountHints")
      .filter(
        (h): h is Record<string, unknown> =>
          typeof h === "object" && h !== null,
      )
      .map((h) => ({
        identifier: typeof h.identifier === "string" ? h.identifier : "",
        evidence: typeof h.evidence === "string" ? h.evidence : "",
        source: typeof h.source === "string" ? h.source : "",
      }))
      .filter((h) => h.identifier.length > 0);

    // Map assessments with per-field numeric confidence
    const assessments: Record<string, FieldAssessment> = {};
    const rawAssessments = parsed["assessments"];
    if (rawAssessments && typeof rawAssessments === "object" && !Array.isArray(rawAssessments)) {
      for (const [key, val] of Object.entries(rawAssessments as Record<string, unknown>)) {
        if (val && typeof val === "object") {
          const v = val as Record<string, unknown>;
          assessments[key] = {
            uncertain: v.uncertain === true,
            reason: typeof v.reason === "string" ? v.reason : undefined,
            confidence: typeof v.confidence === "number" && !Number.isNaN(v.confidence)
              ? Math.max(0, Math.min(1, v.confidence))
              : undefined,
          };
        }
      }
    }

    // Determine status
    const confidence = safeStr("confidence") ?? "low";
    const hasAmount = !!safeStr("amount");
    const hasMerchant = !!safeStr("merchant");
    const hasDate = !!safeStr("date");
    const hasAllRequired = hasAmount && hasMerchant && hasDate;
    const hasAnyField = hasAmount || hasMerchant || hasDate;
    const status: ParserRunStatus = !hasAnyField
      ? ParserRunStatus.Failed
      : hasAllRequired && confidence !== "low"
        ? ParserRunStatus.Success
        : ParserRunStatus.Partial;

    return {
      date: safeStr("date"),
      amount: safeStr("amount"),
      currency: safeStr("currency"),
      parsedMerchant: safeStr("merchant"),
      parsedCategory: safeStr("category"),
      sourceIdentifier: safeStr("sourceIdentifier"),
      sourceAccountHints: hints,
      confidence: ["high", "medium", "low"].includes(confidence)
        ? (confidence as "high" | "medium" | "low")
        : "low",
      assessments,
      status,
      providerRawPayload: null, // filled in by caller
    };
  }
}

function extname(p: string): string {
  const idx = p.lastIndexOf(".");
  return idx >= 0 ? p.slice(idx).toLowerCase() : "";
}
