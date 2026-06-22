import { describe, expect, it } from "bun:test";
import { GeminiParserProvider } from "../src/infra/parser/geminiParserProvider";
import { ParserRunStatus } from "../src/domain/types";

describe("GeminiParserProvider", () => {
  // ─── Unsupported extension → failed parse ──────────────────

  it("returns failed status for unsupported image extension", async () => {
    const provider = new GeminiParserProvider("test-key", "gemini-2.5-flash");
    const result = await provider.parse("/tmp/nonexistent/file.txt");
    expect(result.status).toBe(ParserRunStatus.Failed);
    expect(result.providerRawPayload).toBeTruthy();
  });

  it("returns failed status for non-existent file", async () => {
    const provider = new GeminiParserProvider("test-key", "gemini-2.5-flash");
    const result = await provider.parse("/tmp/nonexistent-file-12345.jpg");
    expect(result.status).toBe(ParserRunStatus.Failed);
  });

  // ─── Provider identity ─────────────────────────────────────

  it("has correct name and model", () => {
    const provider = new GeminiParserProvider("key", "gemini-test-model");
    expect(provider.name).toBe("gemini");
    expect(provider.model).toBe("gemini-test-model");
  });

  it("uses the model passed in constructor", () => {
    const provider = new GeminiParserProvider("key", "gemini-2.0-flash");
    expect(provider.model).toBe("gemini-2.0-flash");
  });
});

describe("null parser (app default when no API key)", () => {
  it("returns failed result for any input", () => {
    const { createNullParser } = require("../src/index");
    const provider = createNullParser();
    const result = provider.parse("/tmp/any.jpg");
    expect(result).resolves.toMatchObject({
      status: ParserRunStatus.Failed,
      amount: null,
    });
  });
});

describe("createDefaultParser (config-based provider selection)", () => {
  it("returns Gemini provider when valid API key", () => {
    const { createDefaultParser } = require("../src/index");
    const config = {
      fireflyBaseUrl: "http://test",
      fireflyToken: "test",
      geminiApiKey: "some-api-key",
      geminiModel: "gemini-2.5-flash",
      slipsRawDir: "/tmp",
      dbPath: "/tmp/db.sqlite",
      cfAccessHeader: "x-test",
      cfAccessDevBypass: true,
      port: 0,
    };
    const provider = createDefaultParser(config);
    expect(provider.name).toBe("gemini");
    expect(provider.model).toBe("gemini-2.5-flash");
  });

  it("returns null parser when API key empty", () => {
    const { createDefaultParser } = require("../src/index");
    const config = {
      fireflyBaseUrl: "http://test",
      fireflyToken: "test",
      geminiApiKey: "",
      geminiModel: "gemini-2.5-flash",
      slipsRawDir: "/tmp",
      dbPath: "/tmp/db.sqlite",
      cfAccessHeader: "x-test",
      cfAccessDevBypass: true,
      port: 0,
    };
    const provider = createDefaultParser(config);
    expect(provider.name).toBe("none");
  });

  it("returns null parser when API key is whitespace", () => {
    const { createDefaultParser } = require("../src/index");
    const config = {
      fireflyBaseUrl: "http://test",
      fireflyToken: "test",
      geminiApiKey: "   ",
      geminiModel: "gemini-2.5-flash",
      slipsRawDir: "/tmp",
      dbPath: "/tmp/db.sqlite",
      cfAccessHeader: "x-test",
      cfAccessDevBypass: true,
      port: 0,
    };
    const provider = createDefaultParser(config);
    expect(provider.name).toBe("none");
  });
});
