import { describe, expect, it, afterEach } from "bun:test";
import { loadConfig } from "../src/config";

describe("config", () => {
  // Preserve original env to restore after tests
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    // Restore env after each test
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL)) {
        delete process.env[key];
      }
    }
    for (const [key, val] of Object.entries(ORIGINAL)) {
      process.env[key] = val;
    }
  });

  it("returns defaults for optional variables when env is not set", () => {
    // Remove optional env vars to test defaults
    delete process.env.DB_PATH;
    delete process.env.CF_ACCESS_HEADER;
    delete process.env.CF_ACCESS_DEV_BYPASS;
    delete process.env.PORT;

    // Set required vars so loadConfig does not throw
    process.env.FIREFLY_BASE_URL = "http://example.com";
    process.env.FIREFLY_TOKEN = "test-token";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.SLIPS_RAW_DIR = "/tmp/slips";

    const cfg = loadConfig();

    expect(cfg.fireflyBaseUrl).toBe("http://example.com");
    expect(cfg.fireflyToken).toBe("test-token");
    expect(cfg.geminiApiKey).toBe("test-key");
    expect(cfg.slipsRawDir).toBe("/tmp/slips");
    expect(cfg.dbPath).toBe("./data/app.sqlite");
    expect(cfg.cfAccessHeader).toBe("Cf-Access-Authenticated-User-Email");
    expect(cfg.cfAccessDevBypass).toBe(false);
    expect(cfg.port).toBe(3000);
  });

  it("parses CF_ACCESS_DEV_BYPASS correctly", () => {
    process.env.FIREFLY_BASE_URL = "http://example.com";
    process.env.FIREFLY_TOKEN = "test";
    process.env.GEMINI_API_KEY = "test";
    process.env.SLIPS_RAW_DIR = "/tmp/slips";
    process.env.CF_ACCESS_DEV_BYPASS = "true";

    const cfg = loadConfig();
    expect(cfg.cfAccessDevBypass).toBe(true);
  });

  it("throws when required env vars are missing", () => {
    // Clear everything
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }

    expect(() => loadConfig()).toThrow(/Missing required environment variable/);
  });

  it("uses provided DB_PATH when set", () => {
    process.env.FIREFLY_BASE_URL = "http://example.com";
    process.env.FIREFLY_TOKEN = "test";
    process.env.GEMINI_API_KEY = "test";
    process.env.SLIPS_RAW_DIR = "/tmp/slips";
    process.env.DB_PATH = "/custom/path/db.sqlite";

    const cfg = loadConfig();
    expect(cfg.dbPath).toBe("/custom/path/db.sqlite");
  });
});
