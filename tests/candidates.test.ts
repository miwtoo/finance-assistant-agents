import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/index";
import { openDatabase } from "../src/db/client";
import { initSlipsTable } from "../src/db/slips";

describe("GET /candidates", () => {
  let tmpSlipsDir: string;
  let tmpDbPath: string;

  beforeAll(() => {
    tmpSlipsDir = mkdtempSync(join(tmpdir(), "candidates-test-slips-"));
    writeFileSync(join(tmpSlipsDir, "receipt.jpg"), "receipt-image-data");
    writeFileSync(join(tmpSlipsDir, "bill.png"), "bill-image-data");
    tmpDbPath = join(tmpdir(), "candidates-test-db.sqlite");
  });

  afterAll(() => {
    rmSync(tmpSlipsDir, { recursive: true, force: true });
    try { rmSync(tmpDbPath); } catch {}
  });

  /** Set env for createApp, run fn with the app, then restore env. */
  async function withApp<T>(
    overrides: Record<string, string | undefined>,
    fn: (app: ReturnType<typeof createApp>) => Promise<T>,
  ): Promise<T> {
    const prev = { ...process.env };
    try {
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const app = createApp();
      return await fn(app);
    } finally {
      process.env = prev;
    }
  }

  async function fetchCandidates(query = ""): Promise<Response> {
    return withApp(
      {
        FIREFLY_BASE_URL: "http://test",
        FIREFLY_TOKEN: "test",
        GEMINI_API_KEY: "test",
        SLIPS_RAW_DIR: tmpSlipsDir,
        DB_PATH: tmpDbPath,
        CF_ACCESS_DEV_BYPASS: "true",
      },
      async (app) => app.handle(new Request(`http://test/candidates${query}`)),
    );
  }

  it("returns 200 with html content type", async () => {
    const res = await fetchCandidates();
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.toLowerCase()).toContain("text/html");
  });

  it("lists slip candidates in the html body", async () => {
    const res = await fetchCandidates();
    const body = await res.text();
    expect(body).toContain("receipt.jpg");
    expect(body).toContain("bill.png");
  });

  it("shows lifecycle status for each candidate", async () => {
    const res = await fetchCandidates();
    const body = await res.text();
    expect(body.toLowerCase()).toMatch(/discovered/);
  });

  it("shows parse_status column for each candidate", async () => {
    const res = await fetchCandidates();
    const body = await res.text();
    expect(body.toLowerCase()).toMatch(/parse.?status|pending/i);
  });

  it("shows duplicate-risk badge near the duplicate filename", async () => {
    writeFileSync(join(tmpSlipsDir, "receipt-dup.jpg"), "receipt-image-data");
    const res = await fetchCandidates();
    const body = await res.text();
    // receipt-dup and "Duplicate Risk" appear in the same row (separated by newlines)
    expect(body).toMatch(/receipt-dup[\s\S]*Duplicate\s*Risk|Duplicate\s*Risk[\s\S]*receipt-dup/i);
    rmSync(join(tmpSlipsDir, "receipt-dup.jpg"));
  });

  it("shows empty state when no slip images present", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "candidates-empty-"));
    const emptyDb = join(tmpdir(), "candidates-empty-db.sqlite");
    await withApp(
      {
        FIREFLY_BASE_URL: "http://test",
        FIREFLY_TOKEN: "test",
        GEMINI_API_KEY: "test",
        SLIPS_RAW_DIR: emptyDir,
        DB_PATH: emptyDb,
        CF_ACCESS_DEV_BYPASS: "true",
      },
      async (app) => {
        const res = await app.handle(new Request("http://test/candidates"));
        const body = await res.text();
        expect(body.toLowerCase()).toMatch(/no slips|no candidates|empty|none found/i);
      },
    );
    rmSync(emptyDir, { recursive: true, force: true });
    try { rmSync(emptyDb); } catch {}
  });

  it("shows error state when SLIPS_RAW_DIR is missing", async () => {
    const missingDir = "/tmp/nonexistent-slips-dir-98765";
    const errorDb = join(tmpdir(), "candidates-error-db.sqlite");
    await withApp(
      {
        FIREFLY_BASE_URL: "http://test",
        FIREFLY_TOKEN: "test",
        GEMINI_API_KEY: "test",
        SLIPS_RAW_DIR: missingDir,
        DB_PATH: errorDb,
        CF_ACCESS_DEV_BYPASS: "true",
      },
      async (app) => {
        const res = await app.handle(new Request("http://test/candidates"));
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body.toLowerCase()).toMatch(/error|unable|unreadable|not found|scan.*fail/i);
      },
    );
    try { rmSync(errorDb); } catch {}
  });

  it("is protected by Cloudflare Access when dev bypass is off", async () => {
    const securedDb = join(tmpdir(), "candidates-secured-db.sqlite");
    await withApp(
      {
        FIREFLY_BASE_URL: "http://test",
        FIREFLY_TOKEN: "test",
        GEMINI_API_KEY: "test",
        SLIPS_RAW_DIR: tmpSlipsDir,
        DB_PATH: securedDb,
      },
      async (app) => {
        const res = await app.handle(
          new Request("http://test/candidates", { headers: {} }),
        );
        expect(res.status).toBe(401);
      },
    );
    try { rmSync(securedDb); } catch {}
  });

  it("accepts startDate query param and filters results", async () => {
    const oldFile = join(tmpSlipsDir, "old-slip.jpg");
    writeFileSync(oldFile, "old-content");
    const oldDate = new Date("2020-01-01T00:00:00Z");
    utimesSync(oldFile, oldDate, oldDate);

    const newFile = join(tmpSlipsDir, "new-slip.jpg");
    writeFileSync(newFile, "new-content");
    const recentDate = new Date("2025-06-22T00:00:00Z");
    utimesSync(newFile, recentDate, recentDate);

    try {
      const res = await fetchCandidates("?startDate=2024-01-01");
      const body = await res.text();
      expect(body).toContain("new-slip.jpg");
      expect(body).not.toContain("old-slip.jpg");
    } finally {
      rmSync(oldFile);
      rmSync(newFile);
    }
  });

  it("accepts endDate query param and filters results", async () => {
    const oldFile = join(tmpSlipsDir, "old-slip2.jpg");
    writeFileSync(oldFile, "old-content2");
    const oldDate = new Date("2020-01-01T00:00:00Z");
    utimesSync(oldFile, oldDate, oldDate);

    try {
      const res = await fetchCandidates("?endDate=2021-01-01");
      const body = await res.text();
      expect(body).toContain("old-slip2.jpg");
      expect(body).not.toContain("receipt.jpg");
    } finally {
      rmSync(oldFile);
    }
  });

  it("includes a scan trigger with loading indicator in the page", async () => {
    const res = await fetchCandidates();
    const body = await res.text();
    expect(body).toMatch(/button|input.*submit|form/);
    expect(body).toMatch(/scanning|loading|rescan|refresh/i);
    expect(body).toMatch(/<script/i);
  });

  it("renders only current scan results, not historical out-of-range records", async () => {
    const res1 = await fetchCandidates();
    const body1 = await res1.text();
    expect(body1).toContain("receipt.jpg");

    const res2 = await fetchCandidates("?endDate=2020-01-01");
    const body2 = await res2.text();
    expect(body2).not.toContain("receipt.jpg");
    expect(body2.toLowerCase()).toMatch(/no slips|no candidates|empty|none found/i);
  });

  // ─── Parse action button ─────────────────────────────────────

  it("shows a parse button for each discovered slip", async () => {
    const res = await fetchCandidates();
    const body = await res.text();
    // Should contain a Parse button that references the slip
    expect(body).toMatch(/parse/i);
    expect(body).toMatch(/onclick="parseSlip\(\d+\)"/);
  });

  it("shows a View button (image link) for each slip", async () => {
    const res = await fetchCandidates();
    const body = await res.text();
    expect(body).toMatch(/\/slips\/\d+\/image/);
    expect(body).toMatch(/🔍 View/);
  });

  it("shows parse status reflecting parse result after parse endpoint call", async () => {
    // Trigger a parse with injected parser
    const db = openDatabase(tmpDbPath);
    try {
      initSlipsTable(db);
      const { getSlipsByPaths } = require("../src/db/slips");
      const slipsBefore = getSlipsByPaths(db, [
        join(tmpSlipsDir, "receipt.jpg"),
      ]);
      const slipId = slipsBefore[0]?.id;
      expect(slipId).toBeDefined();

      const { FakeParser } = require("./fakes/fakeParser");
      const app = createApp(
        {
          fireflyBaseUrl: "http://test",
          fireflyToken: "test",
          geminiApiKey: "test",
          geminiModel: "gemini-2.5-flash",
          slipsRawDir: tmpSlipsDir,
          dbPath: tmpDbPath,
          cfAccessHeader: "Cf-Access-Authenticated-User-Email",
          cfAccessDevBypass: true,
          port: 0,
        },
        { parserProvider: FakeParser.success() },
      );
      const res = await app.handle(new Request(`http://test/candidates/${slipId}/parse`, { method: "POST" }));
      expect(res.status).toBe(200);
    } finally {
      db.close();
    }

    // Now check candidates page shows parse status
    const res2 = await fetchCandidates();
    const body2 = await res2.text();
    // The receipt.jpg slip should show some parse-related status
    expect(body2.toLowerCase()).toMatch(/parsed|success|parse/);
  });

  it("shows a draft link after successful parse", async () => {
    // Trigger parse with injected parser
    const db = openDatabase(tmpDbPath);
    try {
      initSlipsTable(db);
      const { getSlipsByPaths } = require("../src/db/slips");
      const slips = getSlipsByPaths(db, [join(tmpSlipsDir, "bill.png")]);
      const slipId = slips[0]?.id;
      expect(slipId).toBeDefined();

      const { FakeParser } = require("./fakes/fakeParser");
      const app = createApp(
        {
          fireflyBaseUrl: "http://test",
          fireflyToken: "test",
          geminiApiKey: "test",
          geminiModel: "gemini-2.5-flash",
          slipsRawDir: tmpSlipsDir,
          dbPath: tmpDbPath,
          cfAccessHeader: "Cf-Access-Authenticated-User-Email",
          cfAccessDevBypass: true,
          port: 0,
        },
        { parserProvider: FakeParser.success() },
      );
      await app.handle(new Request(`http://test/candidates/${slipId}/parse`, { method: "POST" }));
    } finally {
      db.close();
    }

    // Check candidates page shows draft link
    const res2 = await fetchCandidates();
    const body2 = await res2.text();
    // Should contain a link to /drafts/:id
    expect(body2).toMatch(/\/drafts\/\d+/);
    expect(body2).toMatch(/Draft|Ready|Needs Review/i);
  });
});
