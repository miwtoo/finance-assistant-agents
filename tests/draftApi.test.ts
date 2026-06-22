import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/index";
import { FakeParser } from "./fakes/fakeParser";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/client";
import { initSlipsTable, upsertSlipRecord } from "../src/db/slips";
import { initDraftsTable, getAllDrafts } from "../src/db/drafts";
import { initParserRunsTable } from "../src/db/parserRuns";
import type { SlipCandidate } from "../src/domain/slipScanner";

describe("Draft API routes", () => {
  let tmpSlipsDir: string;
  let tmpDbPath: string;
  let config: AppConfig;

  const baseEnv = {
    FIREFLY_BASE_URL: "http://test",
    FIREFLY_TOKEN: "test",
    GEMINI_API_KEY: "test",
    CF_ACCESS_DEV_BYPASS: "true",
  };

  function makeEnv(overrides: Record<string, string> = {}): Record<string, string> {
    return { ...baseEnv, ...overrides };
  }

  /** Seed a slip into the DB directly, return its id. */
  function seedSlip(dbPath: string, path = "/tmp/test/seed-slip.jpg", contentHash = "seed-hash"): number {
    const db = openDatabase(dbPath);
    try {
      initSlipsTable(db);
      const candidate: SlipCandidate = { sourcePath: path, contentHash, mtime: new Date() };
      return upsertSlipRecord(db, candidate).id;
    } finally {
      db.close();
    }
  }

  /** Seed both slips and drafts tables. Returns draft id. */
  function seedDraft(
    dbPath: string,
    overrides: { slipPath?: string; amount?: string; currency?: string; merchant?: string; reviewState?: string } = {},
  ): { slipId: number; draftId: number } {
    const db = openDatabase(dbPath);
    try {
      initSlipsTable(db);
      initDraftsTable(db);
      const slipPath = overrides.slipPath ?? "/tmp/test/draft-seed.jpg";
      const slip = upsertSlipRecord(db, { sourcePath: slipPath, contentHash: "draft-seed-hash", mtime: new Date() });

      const { upsertDraft } = require("../src/db/drafts");
      type Overrides = { slipPath?: string; amount?: string; currency?: string; merchant?: string; reviewState?: string };
      const ov = overrides as Overrides;
      const draft = upsertDraft(db, {
        slipId: slip.id,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: "2025-06-22",
        amount: "amount" in ov ? ov.amount ?? "100.00" : "100.00",
        currency: "currency" in ov ? ov.currency ?? "THB" : "THB",
        parsedCurrency: "THB",
        merchant: "merchant" in ov ? ov.merchant ?? "Test Merchant" : "Test Merchant",
        parsedMerchant: "Test Merchant",
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: null,
        sourceAccountName: "My Bank",
        category: null,
        reviewState: (overrides.reviewState ?? "parsed") as any,
        syncState: "unsynced" as any,
        duplicateRisk: false,
        hasUncertainty: false,
        userEditedAt: null,
      });
      return { slipId: slip.id, draftId: draft.id };
    } finally {
      db.close();
    }
  }

  beforeAll(() => {
    tmpSlipsDir = mkdtempSync(join(tmpdir(), "draft-api-test-slips-"));
    writeFileSync(join(tmpSlipsDir, "receipt.jpg"), "receipt-data");
    tmpDbPath = join(tmpdir(), "draft-api-test-db.sqlite");
    config = {
      fireflyBaseUrl: "http://test",
      fireflyToken: "test",
      geminiApiKey: "test",
      slipsRawDir: tmpSlipsDir,
      dbPath: tmpDbPath,
      cfAccessHeader: "Cf-Access-Authenticated-User-Email",
      cfAccessDevBypass: true,
      port: 0,
    };
  });

  afterAll(() => {
    rmSync(tmpSlipsDir, { recursive: true, force: true });
    try { rmSync(tmpDbPath); } catch {}
  });

  // ─── POST /candidates/:id/parse ──────────────────────────────

  it("returns 400 for invalid slip id", async () => {
    const app = createApp(config, { parserProvider: FakeParser.success() });
    const res = await app.handle(new Request("http://test/candidates/abc/parse", { method: "POST" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("returns 404 for non-existent slip", async () => {
    const app = createApp(config, { parserProvider: FakeParser.success() });
    const res = await app.handle(new Request("http://test/candidates/99999/parse", { method: "POST" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("creates a draft on parse success and returns draft info", async () => {
    const slipId = seedSlip(tmpDbPath, "/tmp/test/parse-success.jpg", "parse-success-hash");
    const app = createApp(config, { parserProvider: FakeParser.success() });

    const res = await app.handle(new Request(`http://test/candidates/${slipId}/parse`, { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.draftId).toBeGreaterThan(0);
    expect(body.reviewState).toBe("parsed");
    expect(body.duplicateRisk).toBe(false);
  });

  it("returns friendly message on parse failure (malformed payload)", async () => {
    const slipId = seedSlip(tmpDbPath, "/tmp/test/parse-fail.jpg", "parse-fail-hash");
    const app = createApp(config, { parserProvider: new FakeParser({
      result: null as any,
    }) });

    const res = await app.handle(new Request(`http://test/candidates/${slipId}/parse`, { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.draft).toBeNull();
    expect(body.message).toContain("No draft created");
  });

  it("does not overwrite existing draft on failed re-parse", async () => {
    const slipId = seedSlip(tmpDbPath, "/tmp/test/parse-no-overwrite.jpg", "no-overwrite-hash");

    // First parse succeeds
    const app1 = createApp(config, { parserProvider: FakeParser.success({ amount: "50.00" }) });
    const res1 = await app1.handle(new Request(`http://test/candidates/${slipId}/parse`, { method: "POST" }));
    expect(res1.status).toBe(200);

    // Second parse with failure
    const app2 = createApp(config, { parserProvider: FakeParser.failure() });
    const res2 = await app2.handle(new Request(`http://test/candidates/${slipId}/parse`, { method: "POST" }));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.draft).toBeNull(); // total failure returns no draft
  });

  // ─── POST /candidates/:id/create-draft ───────────────────────

  it("creates a manual draft for a slip", async () => {
    const slipId = seedSlip(tmpDbPath, "/tmp/test/manual-draft.jpg", "manual-draft-hash");
    const app = createApp(config);

    const res = await app.handle(new Request(`http://test/candidates/${slipId}/create-draft`, { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.draftId).toBeGreaterThan(0);
    expect(body.reviewState).toBe("needs_review");

    // Verify userEditedAt was set (manual draft)
    const db = openDatabase(tmpDbPath);
    try {
      const { getDraftBySlipId } = require("../src/db/drafts");
      const draft = getDraftBySlipId(db, slipId);
      expect(draft.userEditedAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("returns 409 when draft already exists for slip", async () => {
    const { slipId } = seedDraft(tmpDbPath);
    const app = createApp(config);

    const res = await app.handle(new Request(`http://test/candidates/${slipId}/create-draft`, { method: "POST" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("already exists");
  });

  // ─── PATCH /drafts/:id ───────────────────────────────────────

  it("saves a field and sets user_edited_at", async () => {
    const { draftId } = seedDraft(tmpDbPath);
    const app = createApp(config);

    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "merchant", value: "User Merchant" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.draft.merchant).toBe("User Merchant");
    expect(body.draft.userEditedAt).not.toBeNull();
  });

  it("rejects invalid field name", async () => {
    const { draftId } = seedDraft(tmpDbPath);
    const app = createApp(config);

    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "nonexistent_field", value: "test" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent draft", async () => {
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/99999`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "merchant", value: "test" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  // ─── POST /drafts/:id/mark-ready ─────────────────────────────

  it("marks a complete draft as ready", async () => {
    const { draftId } = seedDraft(tmpDbPath, {
      amount: "100.00",
      currency: "THB",
      merchant: "Test Shop",
    });
    const app = createApp(config);

    const res = await app.handle(new Request(`http://test/drafts/${draftId}/mark-ready`, { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns validation errors for incomplete draft", async () => {
    // Create a draft with missing fields directly
    const db = openDatabase(tmpDbPath);
    try {
      initSlipsTable(db);
      initDraftsTable(db);
      const { upsertDraft } = require("../src/db/drafts");
      const slip = upsertSlipRecord(db, { sourcePath: "/tmp/test/incomplete.jpg", contentHash: "incomplete-hash", mtime: new Date() });
      const draft = upsertDraft(db, {
        slipId: slip.id,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: null,
        amount: null,
        currency: null,
        parsedCurrency: null,
        merchant: null,
        parsedMerchant: null,
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: null,
        sourceAccountName: null,
        category: null,
        reviewState: "parsed" as any,
        syncState: "unsynced" as any,
        duplicateRisk: false,
        hasUncertainty: false,
        userEditedAt: null,
      });
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draft.id}/mark-ready`, { method: "POST" }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.errors.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("blocks ready when currency is invalid 'XYZ'", async () => {
    const { draftId } = seedDraft(tmpDbPath, { currency: "XYZ" });
    const app = createApp(config);

    const res = await app.handle(new Request(`http://test/drafts/${draftId}/mark-ready`, { method: "POST" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.some((e: string) => e.includes("XYZ"))).toBe(true);
  });

  it("blocks ready when currency is UNKNOWN", async () => {
    const { draftId } = seedDraft(tmpDbPath, { currency: "UNKNOWN" });
    const app = createApp(config);

    const res = await app.handle(new Request(`http://test/drafts/${draftId}/mark-ready`, { method: "POST" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.some((e: string) => e.toLowerCase().includes("currency"))).toBe(true);
  });

  it("blocks ready when amount has invalid format", async () => {
    const { draftId } = seedDraft(tmpDbPath, { amount: "abc" });
    const app = createApp(config);

    const res = await app.handle(new Request(`http://test/drafts/${draftId}/mark-ready`, { method: "POST" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.some((e: string) => e.toLowerCase().includes("amount"))).toBe(true);
  });

  it("blocks ready when source account is missing", async () => {
    const db = openDatabase(tmpDbPath);
    try {
      initSlipsTable(db);
      initDraftsTable(db);
      const { upsertDraft } = require("../src/db/drafts");
      const slip = upsertSlipRecord(db, { sourcePath: "/tmp/test/no-source.jpg", contentHash: "no-source-hash", mtime: new Date() });
      const draft = upsertDraft(db, {
        slipId: slip.id,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: "2025-06-22",
        amount: "100.00",
        currency: "THB",
        parsedCurrency: "THB",
        merchant: "Test",
        parsedMerchant: "Test",
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: null,
        sourceAccountName: null, // missing!
        category: null,
        reviewState: "parsed" as any,
        syncState: "unsynced" as any,
        duplicateRisk: false,
        hasUncertainty: false,
        userEditedAt: null,
      });
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draft.id}/mark-ready`, { method: "POST" }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.errors.some((e: string) => e.toLowerCase().includes("source account"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("blocks ready when duplicate risk is active", async () => {
    const db = openDatabase(tmpDbPath);
    try {
      initSlipsTable(db);
      initDraftsTable(db);
      const { upsertDraft } = require("../src/db/drafts");
      const slip = upsertSlipRecord(db, { sourcePath: "/tmp/test/dup-risk.jpg", contentHash: "dup-risk-hash", mtime: new Date() });
      const draft = upsertDraft(db, {
        slipId: slip.id,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: "2025-06-22",
        amount: "100.00",
        currency: "THB",
        parsedCurrency: "THB",
        merchant: "Test",
        parsedMerchant: "Test",
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: null,
        sourceAccountName: "My Bank",
        category: null,
        reviewState: "parsed" as any,
        syncState: "unsynced" as any,
        duplicateRisk: true,
        hasUncertainty: false,
        userEditedAt: null,
      });
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draft.id}/mark-ready`, { method: "POST" }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.errors.some((e: string) => e.toLowerCase().includes("duplicate"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("allows mark-ready when category is null but everything else is valid", async () => {
    const { draftId } = seedDraft(tmpDbPath, { amount: "200.00", currency: "THB", merchant: "Shop" });
    const app = createApp(config);

    const res = await app.handle(new Request(`http://test/drafts/${draftId}/mark-ready`, { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("preserves parsed vs normalized merchant through save", async () => {
    const { draftId } = seedDraft(tmpDbPath, { merchant: "Normalized Shop" });
    const app = createApp(config);

    // Update normalized merchant via save
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "merchant", value: "User Updated Merchant" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft.merchant).toBe("User Updated Merchant");

    // parsedMerchant should remain unchanged
    expect(body.draft.parsedMerchant).toBe("Test Merchant");
  });
});
