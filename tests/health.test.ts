import { describe, expect, it } from "bun:test";
import { createApp } from "../src/index";

describe("GET /health", () => {
  it("returns ok JSON with service name", async () => {
    // Set required env vars so createApp can load config
    const prev = { ...process.env };
    process.env.FIREFLY_BASE_URL = "http://test";
    process.env.FIREFLY_TOKEN = "test";
    process.env.GEMINI_API_KEY = "test";
    process.env.SLIPS_RAW_DIR = "/tmp/test";
    process.env.CF_ACCESS_DEV_BYPASS = "true";

    try {
      const app = createApp();
      const res = await app.handle(new Request("http://test/health"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        ok: true,
        service: "finance-assistant-agents",
      });
    } finally {
      process.env = prev;
    }
  });
});
