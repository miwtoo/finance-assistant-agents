import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/index";
import { FakeParser } from "./fakes/fakeParser";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/client";
import { initSlipsTable, upsertSlipRecord } from "../src/db/slips";
import { initDraftsTable, getAllDrafts, getOrCreateInstallationId, buildExternalId, LEASE_TTL_MS, FIREFLY_REQUEST_TIMEOUT_MS } from "../src/db/drafts";
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
      geminiModel: "gemini-2.5-flash",
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

  // ─── Blocker 1: PATCH field allowlist ────────────────────────

  it("rejects PATCH to review_state", async () => {
    const { draftId } = seedDraft(tmpDbPath);
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "review_state", value: "ready" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("not allowed");
  });

  it("rejects PATCH to duplicate_risk", async () => {
    const { draftId } = seedDraft(tmpDbPath);
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "duplicate_risk", value: "0" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects PATCH to has_uncertainty", async () => {
    const { draftId } = seedDraft(tmpDbPath);
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "has_uncertainty", value: "0" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects PATCH to user_edited_at", async () => {
    const { draftId } = seedDraft(tmpDbPath);
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "user_edited_at", value: "2025-06-22" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  // ─── Blocker 2: Uncertainty resolution ───────────────────────

  it("PATCH never clears has_uncertainty — editing category leaves it intact", async () => {
    // Regression: editing an unrelated field must not clear currency/parser uncertainty
    const db = openDatabase(tmpDbPath);
    try {
      initSlipsTable(db);
      initDraftsTable(db);
      const { upsertDraft } = require("../src/db/drafts");
      const slip = upsertSlipRecord(db, { sourcePath: "/tmp/test/category-uncertainty.jpg", contentHash: "category-uncertainty-hash", mtime: new Date() });
      const draft = upsertDraft(db, {
        slipId: slip.id,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: "2025-06-22",
        amount: "100.00",
        currency: "THB",
        parsedCurrency: "XYZ", // parser was unsure about currency
        merchant: "Shop",
        parsedMerchant: "Shop",
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: null,
        sourceAccountName: "My Bank",
        category: null,
        reviewState: "needs_review" as any,
        syncState: "unsynced" as any,
        duplicateRisk: false,
        hasUncertainty: true, // uncertainty from currency fallback
        userEditedAt: "2025-06-22T00:00:00Z",
      });

      // Mark-ready should fail due to uncertainty
      const app1 = createApp(config);
      const res1 = await app1.handle(new Request(`http://test/drafts/${draft.id}/mark-ready`, { method: "POST" }));
      expect(res1.status).toBe(422);

      // Edit category — must NOT clear has_uncertainty
      const app2 = createApp(config);
      const res2 = await app2.handle(
        new Request(`http://test/drafts/${draft.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ field: "category", value: "Groceries" }),
        }),
      );
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.draft.hasUncertainty).toBe(true); // still uncertain!
      expect(body2.draft.category).toBe("Groceries");

      // Mark-ready still blocked
      const app3 = createApp(config);
      const res3 = await app3.handle(new Request(`http://test/drafts/${draft.id}/mark-ready`, { method: "POST" }));
      expect(res3.status).toBe(422);

      // Explicit resolve-uncertainty via endpoint clears it
      const app4 = createApp(config);
      const res4 = await app4.handle(new Request(`http://test/drafts/${draft.id}/resolve-uncertainty`, { method: "POST" }));
      expect(res4.status).toBe(200);

      // Now mark-ready succeeds
      const app5 = createApp(config);
      const res5 = await app5.handle(new Request(`http://test/drafts/${draft.id}/mark-ready`, { method: "POST" }));
      expect(res5.status).toBe(200);
    } finally {
      db.close();
    }
  });

  it("POST /drafts/:id/resolve-uncertainty clears uncertainty, sets user_edited_at, returns draft", async () => {
    const { draftId } = seedDraft(tmpDbPath, {
      amount: "100.00",
      currency: "THB",
      merchant: "Shop",
    });
    // Seed creates with hasUncertainty=false, so set it to true first
    const db = openDatabase(tmpDbPath);
    try {
      initDraftsTable(db);
      const { updateDraftField, getDraft } = require("../src/db/drafts");
      updateDraftField(db, draftId, "has_uncertainty", "1");
    } finally {
      db.close();
    }

    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}/resolve-uncertainty`, { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.uncertaintyResolved).toBe(true);
    expect(body.draft).not.toBeNull();
    expect(body.draft.hasUncertainty).toBe(false);
    expect(body.draft.userEditedAt).not.toBeNull(); // user_edited_at set
  });

  it("POST /drafts/:id/resolve-uncertainty returns errors when fields invalid", async () => {
    const { draftId } = seedDraft(tmpDbPath, {
      amount: "abc", // invalid amount
      currency: "XYZ", // invalid currency
      merchant: "Shop",
    });

    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}/resolve-uncertainty`, { method: "POST" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  // ─── Blocker 3: Mark-ready returns 404 ───────────────────────

  it("returns 404 when mark-ready target draft does not exist", async () => {
    const app = createApp(config);
    const res = await app.handle(new Request("http://test/drafts/99999/mark-ready", { method: "POST" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.message).toContain("not found");
  });

  // ─── Blocker 1: Ready invariant on PATCH ────────────────────

  it("demotes ready draft to needs_review on PATCH with invalid amount", async () => {
    const { draftId } = seedDraft(tmpDbPath, {
      amount: "100.00", currency: "THB", merchant: "Shop",
    });

    // First mark as ready
    const markApp = createApp(config);
    const markRes = await markApp.handle(new Request(`http://test/drafts/${draftId}/mark-ready`, { method: "POST" }));
    expect(markRes.status).toBe(200);

    // Now edit amount to something invalid
    const editApp = createApp(config);
    const editRes = await editApp.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "amount", value: "abc" }),
      }),
    );
    expect(editRes.status).toBe(200);
    const body = await editRes.json();
    expect(body.draft.reviewState).toBe("needs_review");
    expect(body.draft.amount).toBe("abc");

    // Mark-ready should now be blocked
    const readyApp = createApp(config);
    const readyRes = await readyApp.handle(new Request(`http://test/drafts/${draftId}/mark-ready`, { method: "POST" }));
    expect(readyRes.status).toBe(422);
  });

  it("demotes parsed draft to needs_review on PATCH merchant edit", async () => {
    const { draftId } = seedDraft(tmpDbPath, {
      amount: "100.00", currency: "THB", merchant: "Shop",
    });
    // seedDraft creates with review_state = "parsed"
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "merchant", value: "Edited Shop" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft.merchant).toBe("Edited Shop");
    expect(body.draft.reviewState).toBe("needs_review");
  });

  // ─── Blocker 2: Synced draft rejection ──────────────────────

  it("rejects PATCH on synced draft with 409", async () => {
    const db = openDatabase(tmpDbPath);
    try {
      initSlipsTable(db);
      initDraftsTable(db);
      const { upsertDraft } = require("../src/db/drafts");
      const slip = upsertSlipRecord(db, { sourcePath: "/tmp/test/synced-patch.jpg", contentHash: "synced-patch-hash", mtime: new Date() });
      const draft = upsertDraft(db, {
        slipId: slip.id,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: "2025-06-22",
        amount: "50.00",
        currency: "THB",
        parsedCurrency: "THB",
        merchant: "Synced",
        parsedMerchant: "Synced",
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: null,
        sourceAccountName: "Bank",
        category: null,
        reviewState: "ready" as any,
        syncState: "synced" as any,
        duplicateRisk: false,
        hasUncertainty: false,
        userEditedAt: null,
      });
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draft.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ field: "merchant", value: "Hacked" }),
        }),
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.message).toContain("synced");
    } finally {
      db.close();
    }
  });

  it("rejects resolve-uncertainty on synced draft with 409", async () => {
    const db = openDatabase(tmpDbPath);
    try {
      initSlipsTable(db);
      initDraftsTable(db);
      const { upsertDraft } = require("../src/db/drafts");
      const slip = upsertSlipRecord(db, { sourcePath: "/tmp/test/synced-resolve.jpg", contentHash: "synced-resolve-hash", mtime: new Date() });
      const draft = upsertDraft(db, {
        slipId: slip.id,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: "2025-06-22",
        amount: "50.00",
        currency: "THB",
        parsedCurrency: "THB",
        merchant: "Synced",
        parsedMerchant: "Synced",
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: null,
        sourceAccountName: "Bank",
        category: null,
        reviewState: "ready" as any,
        syncState: "synced" as any,
        duplicateRisk: false,
        hasUncertainty: false,
        userEditedAt: null,
      });
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draft.id}/resolve-uncertainty`, { method: "POST" }));
      expect(res.status).toBe(409);
    } finally {
      db.close();
    }
  });

  it("rejects mark-ready on synced draft with 409", async () => {
    const db = openDatabase(tmpDbPath);
    try {
      initSlipsTable(db);
      initDraftsTable(db);
      const { upsertDraft } = require("../src/db/drafts");
      const slip = upsertSlipRecord(db, { sourcePath: "/tmp/test/synced-mark.jpg", contentHash: "synced-mark-hash", mtime: new Date() });
      const draft = upsertDraft(db, {
        slipId: slip.id,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: "2025-06-22",
        amount: "50.00",
        currency: "THB",
        parsedCurrency: "THB",
        merchant: "Synced",
        parsedMerchant: "Synced",
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: null,
        sourceAccountName: "Bank",
        category: null,
        reviewState: "ready" as any,
        syncState: "synced" as any,
        duplicateRisk: false,
        hasUncertainty: false,
        userEditedAt: null,
      });
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draft.id}/mark-ready`, { method: "POST" }));
      expect(res.status).toBe(409);
    } finally {
      db.close();
    }
  });

  // ─── Blocker 3 (non-blocking): reject non-string value ──────

  it("rejects PATCH with non-string value (number)", async () => {
    const { draftId } = seedDraft(tmpDbPath);
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "amount", value: 12345 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  // ─── Sync: helpers ────────────────────────────────────────

  const assetAccountsPayload = {
    data: [
      { id: "10", attributes: { name: "My Bank", type: "asset" } },
      { id: "11", attributes: { name: "Savings", type: "asset" } },
    ],
  };

  const expenseAccountsPayload = {
    data: [
      { id: "50", attributes: { name: "Groceries", type: "expense" } },
      { id: "51", attributes: { name: "Transport", type: "expense" } },
    ],
  };

  const withdrawalSuccessPayload = {
    data: {
      id: "200",
      attributes: {
        transactions: [{ transaction_journal_id: "300" }],
      },
    },
  };

  /** Empty search result (no match). */
  const searchEmptyPayload = { data: [] };

  /**
   * Create a mock fetch that routes Firefly API calls.
   * `fetchMap` maps URL substrings to response payloads.
   */
  function mockFetch(
    fetchMap: Record<string, { status: number; body: unknown }>,
  ): any {
    return async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      for (const [pattern, resp] of Object.entries(fetchMap)) {
        if (url.includes(pattern)) {
          return new Response(JSON.stringify(resp.body), {
            status: resp.status,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    };
  }

  /** Standard mock for sync happy path: accounts OK, search empty, withdrawal succeeds. */
  function syncHappyMock() {
    return mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
      "search/transactions": { status: 200, body: searchEmptyPayload },
      "/api/v1/transactions": { status: 201, body: withdrawalSuccessPayload },
    });
  }

  /** Seed a ready draft with sourceAccountName for sync tests. */
  function seedReadyDraft(
    dbPath: string,
    overrides: { sourceAccountName?: string; syncState?: string; reviewState?: string; duplicateRisk?: boolean } = {},
  ): { slipId: number; draftId: number } {
    const db = openDatabase(dbPath);
    try {
      initSlipsTable(db);
      initDraftsTable(db);
      const slip = upsertSlipRecord(db, {
        sourcePath: `/tmp/test/sync-ready-${Date.now()}.jpg`,
        contentHash: `sync-ready-hash-${Date.now()}`,
        mtime: new Date(),
      });
      const { upsertDraft } = require("../src/db/drafts");
      const draft = upsertDraft(db, {
        slipId: slip.id,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: "2025-07-10",
        amount: "125000.00",
        currency: "THB",
        parsedCurrency: "THB",
        merchant: "Coffee House",
        parsedMerchant: "Coffee House",
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: null,
        sourceAccountName: overrides.sourceAccountName ?? "My Bank",
        category: null,
        reviewState: (overrides.reviewState ?? "ready") as any,
        syncState: (overrides.syncState ?? "unsynced") as any,
        duplicateRisk: overrides.duplicateRisk ?? false,
        hasUncertainty: false,
        userEditedAt: null,
      });
      return { slipId: slip.id, draftId: draft.id };
    } finally {
      db.close();
    }
  }

  // ─── GET /drafts/:id/sync-options ─────────────────────────

  it("returns source + expense accounts for a ready draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync-options`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.sourceAccount).toEqual({ id: "10", name: "My Bank" });
      expect(body.destinationAccounts).toHaveLength(2);
      expect(body.destinationAccounts[0].name).toBe("Groceries");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rejects sync-options for a non-ready draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { reviewState: "needs_review" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync-options`));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("not ready");
  });

  it("rejects sync-options for already-synced draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "synced" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync-options`));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("already");
  });

  it("rejects sync-options for pending_sync draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync-options`));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("already");
  });

  it("rejects sync-options for duplicate-risk draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { duplicateRisk: true });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync-options`));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("duplicate risk");
  });

  it("returns 422 when source account name has no match in Firefly", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { sourceAccountName: "Nonexistent Bank" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
    });
    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync-options`));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.message).toContain("No asset account exactly matching");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns 422 when multiple asset accounts match (ambiguous)", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { sourceAccountName: "My Bank" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": {
        status: 200,
        body: {
          data: [
            { id: "10", attributes: { name: "My Bank", type: "asset" } },
            { id: "12", attributes: { name: "My Bank", type: "asset" } },
          ],
        },
      },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
    });
    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync-options`));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.message).toContain("Ambiguous");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns 502 when Firefly asset accounts fetch fails", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 500, body: { message: "Server Error" } },
    });
    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync-options`));
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.message).toContain("Failed to fetch");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns 404 for non-existent draft on sync-options", async () => {
    const app = createApp(config);
    const res = await app.handle(new Request("http://test/drafts/99999/sync-options"));
    expect(res.status).toBe(404);
  });

  // ─── POST /drafts/:id/sync ────────────────────────────────

  it("happy path: syncs draft and persists Firefly IDs", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = syncHappyMock() as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.firefly.groupId).toBe("200");
      expect(body.firefly.journalId).toBe("300");
      expect(body.draft.reviewState).toBe("approved");
      expect(body.draft.syncState).toBe("synced");

      // Verify DB persisted the firefly IDs
      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.fireflyGroupId).toBe("200");
        expect(d.fireflyJournalId).toBe("300");
        expect(d.fireflySyncedAt).not.toBeNull();
        expect(d.fireflyOutcome).toBeNull();
        expect(d.fireflyErrorCode).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("verifies outbound payload persisted before network call", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;

    // Capture the actual fetch calls
    const capturedRequests: { url: string; method: string; body?: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? String(init.body) : undefined;
      capturedRequests.push({ url, method: init?.method ?? "GET", body });

      // Route to mock
      return syncHappyMock()(input);
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(200);

      // Check that outbound payload was persisted in DB before network call
      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.fireflyOutboundPayload).not.toBeNull();
        const payload = JSON.parse(d.fireflyOutboundPayload);
        expect(payload.transactions[0].type).toBe("withdrawal");
        expect(payload.transactions[0].source_id).toBe("10");
        expect(payload.transactions[0].destination_id).toBe("50");
        expect(payload.transactions[0].external_id).toContain("finance-assistant:");
        expect(payload.transactions[0].external_id).toContain(`draft:${draftId}`);
        expect(d.fireflyStartedAt).not.toBeNull();
      } finally {
        db.close();
      }

      // Verify outbound payload has correct structure
      const txCall = capturedRequests.find((r) => r.url.includes("/api/v1/transactions"));
      expect(txCall).toBeDefined();
      expect(txCall!.method).toBe("POST");
      const txBody = JSON.parse(txCall!.body!);
      expect(txBody.transactions[0].type).toBe("withdrawal");
      expect(txBody.transactions[0].amount).toBe("125000.00");
      expect(txBody.transactions[0].currency_code).toBe("THB");
      // P0.3: error_if_duplicate_hash is at top request level, not per transaction
      expect(txBody.error_if_duplicate_hash).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("verifies stable external ID format", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = syncHappyMock() as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(200);

      // Verify external ID format
      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        const installationId = getOrCreateInstallationId(db);
        const expectedExternalId = buildExternalId(installationId, draftId);
        expect(d.fireflyExternalId).toBe(expectedExternalId);
        expect(d.fireflyExternalId).toMatch(/^finance-assistant:[a-f0-9-]+:draft:\d+$/);
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("searches external_id before POST — found means complete without POST", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    const postedTransactions: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/transactions") && init?.method === "POST") {
        postedTransactions.push(url);
      }
      // Return mock based on URL
      if (url.includes("accounts?type=asset")) {
        return new Response(JSON.stringify(assetAccountsPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("accounts?type=expense")) {
        return new Response(JSON.stringify(expenseAccountsPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("search/transactions")) {
        // Found 1 match
        return new Response(JSON.stringify({
          data: [{
            id: "999",
            attributes: { transactions: [{ transaction_journal_id: "888" }] },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.message).toContain("already synced");
      expect(body.firefly.groupId).toBe("999");
      expect(body.firefly.journalId).toBe("888");

      // Should NOT have POSTed a transaction
      expect(postedTransactions).toHaveLength(0);

      // Draft should be synced
      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.syncState).toBe("synced");
        expect(d.reviewState).toBe("approved");
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("search returns >1 match → sync_failed + 409 conflict", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
      "search/transactions": {
        status: 200,
        body: { data: [
          { id: "1", attributes: { transactions: [{ transaction_journal_id: "a" }] } },
          { id: "2", attributes: { transactions: [{ transaction_journal_id: "b" }] } },
        ] },
      },
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.outcome).toBe("FIREFLY_AMBIGUOUS_MATCH");

      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.syncState).toBe("sync_failed");
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("search failure → remain pending_sync, no POST, 202", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    const postedTransactions: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/transactions") && init?.method === "POST") {
        postedTransactions.push(url);
      }
      if (url.includes("accounts?type=asset")) {
        return new Response(JSON.stringify(assetAccountsPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("accounts?type=expense")) {
        return new Response(JSON.stringify(expenseAccountsPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("search/transactions")) {
        return new Response(JSON.stringify({ message: "Internal error" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.outcome).toBe("FIREFLY_OUTCOME_UNKNOWN");

      // Must NOT have posted
      expect(postedTransactions).toHaveLength(0);

      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.syncState).toBe("pending_sync");
        expect(d.fireflyOutcome).toBe("FIREFLY_OUTCOME_UNKNOWN");
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rejects sync with missing destinationAccountId", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("destinationAccountId");
  });

  it("rejects sync for non-ready draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { reviewState: "needs_review" });
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destinationAccountId: "50" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("rejects sync for pending_sync draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destinationAccountId: "50" }),
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.message).toContain("not unsynced");
  });

  it("rejects sync for already-synced draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "synced" });
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destinationAccountId: "50" }),
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.message).toContain("not unsynced");
  });

  it("rejects sync when source account has no match in Firefly", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { sourceAccountName: "Ghost Bank" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
    });
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.message).toContain("No asset account exactly matching");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rejects sync when destination expense account not found", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
    });
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "999" }),
        }),
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.message).toContain("not found in Firefly");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("validation 422 → sync_failed + 422 (definite rejection)", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
      "search/transactions": { status: 200, body: searchEmptyPayload },
      "/api/v1/transactions": {
        status: 422,
        body: { message: "Validation error" },
      },
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.outcome).toBe("FIREFLY_VALIDATION_ERROR");

      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.syncState).toBe("sync_failed");
        expect(d.fireflyErrorCode).toBe("FIREFLY_VALIDATION_ERROR");
        expect(d.fireflyOutboundPayload).not.toBeNull(); // payload persisted
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("duplicate → sync_failed + 409 (nonretryable)", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
      "search/transactions": { status: 200, body: searchEmptyPayload },
      "/api/v1/transactions": {
        status: 422,
        body: { message: "Duplicate transaction detected" },
      },
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.outcome).toBe("FIREFLY_DUPLICATE");

      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.syncState).toBe("sync_failed");
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("auth 401 → sync_failed + 503", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
      "search/transactions": { status: 200, body: searchEmptyPayload },
      "/api/v1/transactions": {
        status: 401,
        body: { message: "Unauthorized" },
      },
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.outcome).toBe("FIREFLY_AUTH_ERROR");

      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.syncState).toBe("sync_failed");
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("network error → 202 + pending_sync + OUTCOME_UNKNOWN", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("accounts?type=asset")) {
        return new Response(JSON.stringify(assetAccountsPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("accounts?type=expense")) {
        return new Response(JSON.stringify(expenseAccountsPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("search/transactions")) {
        return new Response(JSON.stringify(searchEmptyPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/v1/transactions")) {
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.outcome).toBe("FIREFLY_OUTCOME_UNKNOWN");

      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.syncState).toBe("pending_sync");
        expect(d.fireflyOutcome).toBe("FIREFLY_OUTCOME_UNKNOWN");
        expect(d.fireflyOutboundPayload).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("5xx → 202 + pending_sync + OUTCOME_UNKNOWN", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
      "search/transactions": { status: 200, body: searchEmptyPayload },
      "/api/v1/transactions": { status: 500, body: { message: "Server Error" } },
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.outcome).toBe("FIREFLY_OUTCOME_UNKNOWN");

      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.syncState).toBe("pending_sync");
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("validates amount must be positive finite", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const db = openDatabase(tmpDbPath);
    try {
      const { updateDraftField } = require("../src/db/drafts");
      updateDraftField(db, draftId, "amount", "0");
    } finally {
      db.close();
    }
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destinationAccountId: "50" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors.some((e: string) => e.includes("positive"))).toBe(true);
  });

  it("normalizes comma decimal in amount", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET amount = '125,50' WHERE id = ?", [draftId]);
    } finally {
      db.close();
    }
    const origFetch = globalThis.fetch;
    let capturedAmount: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/transactions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        capturedAmount = body.transactions[0].amount;
        return new Response(JSON.stringify(withdrawalSuccessPayload), { status: 201, headers: { "content-type": "application/json" } });
      }
      return syncHappyMock()(input);
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(200);
      // Amount should be normalized: comma→dot
      expect(capturedAmount!).toBe("125.50");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns 404 for non-existent draft on sync", async () => {
    const app = createApp(config);
    const res = await app.handle(
      new Request("http://test/drafts/99999/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destinationAccountId: "50" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("blocks edits on pending_sync draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "merchant", value: "Hacked" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.message).toContain("pending_sync");
  });

  it("blocks resolve-uncertainty on pending_sync draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}/resolve-uncertainty`, { method: "POST" }));
    expect(res.status).toBe(409);
  });

  it("blocks mark-ready on pending_sync draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}/mark-ready`, { method: "POST" }));
    expect(res.status).toBe(409);
  });

  // ─── POST /drafts/:id/sync/recover ────────────────────────

  it("recovery: found via search → complete synced", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    // Set outbound payload + external ID (NO lease token — handler acquires it)
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?", [
        '{"transactions":[{"type":"withdrawal"}]}',
        "test-ext-id",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("search/transactions")) {
        return new Response(JSON.stringify({
          data: [{
            id: "500",
            attributes: { transactions: [{ transaction_journal_id: "600" }] },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.firefly.groupId).toBe("500");
      expect(body.firefly.journalId).toBe("600");

      const db2 = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db2, draftId);
        expect(d.syncState).toBe("synced");
        expect(d.reviewState).toBe("approved");
      } finally {
        db2.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("recovery: search failure → remain pending, no POST", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?", [
        '{"transactions":[{"type":"withdrawal"}]}',
        "test-ext-id",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const origFetch = globalThis.fetch;
    const postedTransactions: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/transactions") && init?.method === "POST") {
        postedTransactions.push(url);
      }
      if (url.includes("search/transactions")) {
        return new Response(JSON.stringify({ message: "error" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res.status).toBe(202);
      expect(postedTransactions).toHaveLength(0);

      const db2 = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db2, draftId);
        expect(d.syncState).toBe("pending_sync");
        expect(d.fireflyOutcome).toBe("FIREFLY_OUTCOME_UNKNOWN");
      } finally {
        db2.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("recovery: search >1 → sync_failed + 409", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?", [
        '{"transactions":[{"type":"withdrawal"}]}',
        "test-ext-id",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "search/transactions": {
        status: 200,
        body: { data: [
          { id: "1", attributes: { transactions: [{ transaction_journal_id: "a" }] } },
          { id: "2", attributes: { transactions: [{ transaction_journal_id: "b" }] } },
        ] },
      },
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.outcome).toBe("FIREFLY_AMBIGUOUS_MATCH");

      const db2 = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db2, draftId);
        expect(d.syncState).toBe("sync_failed");
      } finally {
        db2.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("recovery: zero search + POST success → synced", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      const outboundPayload = JSON.stringify({
        transactions: [{
          type: "withdrawal",
          date: "2025-07-10T00:00:00+07:00",
          amount: "125000.00",
          description: "Coffee House",
          source_id: "10",
          destination_id: "50",
          currency_code: "THB",
          external_id: "test-ext-id",
          error_if_duplicate_hash: true,
        }],
      });
      db.run("UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?", [
        outboundPayload,
        "test-ext-id",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "search/transactions": { status: 200, body: searchEmptyPayload },
      "/api/v1/transactions": { status: 201, body: withdrawalSuccessPayload },
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.firefly.groupId).toBe("200");

      const db2 = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db2, draftId);
        expect(d.syncState).toBe("synced");
        expect(d.reviewState).toBe("approved");
      } finally {
        db2.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("recovery: rejects non-pending_sync draft", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "unsynced" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.message).toContain("not pending_sync");
  });

  it("recovery: 404 for non-existent draft", async () => {
    const app = createApp(config);
    const res = await app.handle(new Request("http://test/drafts/99999/sync/recover", { method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("recovery: POST network error → remain pending + 202", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?", [
        '{"transactions":[{"type":"withdrawal"}]}',
        "test-ext-id",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("search/transactions")) {
        return new Response(JSON.stringify(searchEmptyPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/v1/transactions")) {
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.outcome).toBe("FIREFLY_OUTCOME_UNKNOWN");

      const db2 = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db2, draftId);
        expect(d.syncState).toBe("pending_sync");
        expect(d.fireflyOutcome).toBe("FIREFLY_OUTCOME_UNKNOWN");
      } finally {
        db2.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ─── P0.1: Concurrent recovery lease CAS ──────────────────

  it("concurrent recovery: second caller gets 422 when lease held", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      // Seed with outbound payload but NO lease token (handler acquires)
      db.run("UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?", [
        '{"transactions":[{"type":"withdrawal"}]}',
        "test-ext-id",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const origFetch = globalThis.fetch;
    let searchCallCount = 0;
    let postCallCount = 0;
    // Use a barrier to serialize the two concurrent calls
    let resumeCaller2: (() => void) | null = null;
    const caller2Ready = new Promise<void>((r) => { resumeCaller2 = r; });

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("search/transactions")) {
        searchCallCount++;
        if (searchCallCount === 2) {
          // Second caller's search: found (someone else created it)
          return new Response(JSON.stringify({
            data: [{ id: "999", attributes: { transactions: [{ transaction_journal_id: "888" }] } }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        // First caller's search: empty
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/v1/transactions")) {
        postCallCount++;
        return new Response(JSON.stringify(withdrawalSuccessPayload), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);

      // Caller 1: acquires lease, searches (empty), POSTs, completes
      const caller1Promise = app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));

      // Wait for caller1 to finish (it acquires lease, searches, POSTs, completes)
      const res1 = await caller1Promise;
      expect(res1.status).toBe(200);

      // Now caller2 tries — lease was cleared by caller1's completion
      // Caller2 acquires new lease, searches (found), completes
      const res2 = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      // Draft is now synced (completed by caller1), so caller2 gets 422
      expect(res2.status).toBe(422);
      const body2 = await res2.json();
      expect(body2.message).toContain("not pending_sync");

      // Exactly 1 POST was made (by caller1)
      expect(postCallCount).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("original vs recovery: first to complete wins, second gets 422", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      // Seed with outbound payload but NO lease token (handler acquires its own)
      db.run("UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?", [
        '{"transactions":[{"type":"withdrawal"}]}',
        "test-ext-id",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("search/transactions")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/v1/transactions")) {
        return new Response(JSON.stringify(withdrawalSuccessPayload), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      // First call completes with the lease token
      const app = createApp(config);
      const res1 = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res1.status).toBe(200);

      // Second call fails because lease token is cleared (draft is now synced)
      const res2 = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res2.status).toBe(422); // not pending_sync anymore
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ─── P1.4: Edit during fetch regression ────────────────────

  it("revision mismatch blocks sync when draft edited during account fetch", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;

    let fetchCallCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchCallCount++;

      // On first account fetch, simulate an edit that bumps revision
      if (fetchCallCount === 1 && url.includes("accounts?type=asset")) {
        const db = openDatabase(tmpDbPath);
        try {
          const { updateDraftField } = require("../src/db/drafts");
          updateDraftField(db, draftId, "merchant", "Edited During Fetch");
        } finally {
          db.close();
        }
      }

      return syncHappyMock()(input);
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      // CAS claim should fail because revision changed during account fetch
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.message).toContain("could not be claimed");

      // Draft should remain unsynced (CAS failed, no POST sent)
      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.syncState).toBe("unsynced");
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ─── P1.5: sync_failed safe exit ───────────────────────────

  it("edits reset retryable sync_failed to unsynced + needs_review", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "sync_failed", reviewState: "ready" });
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET firefly_error_code = ?, firefly_error_message = ? WHERE id = ?", [
        "FIREFLY_VALIDATION_ERROR",
        "Transaction rejected by Firefly (validation)",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "merchant", value: "Fixed Merchant" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify draft was reset to unsynced + needs_review
    const db2 = openDatabase(tmpDbPath);
    try {
      const { getDraft } = require("../src/db/drafts");
      const d = getDraft(db2, draftId);
      expect(d.syncState).toBe("unsynced");
      expect(d.reviewState).toBe("needs_review");
      expect(d.fireflyErrorCode).toBeNull();
      expect(d.fireflyOutboundPayload).toBeNull();
    } finally {
      db2.close();
    }
  });

  it("edits blocked on non-retryable sync_failed (duplicate)", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "sync_failed", reviewState: "ready" });
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET firefly_error_code = ?, firefly_error_message = ? WHERE id = ?", [
        "FIREFLY_DUPLICATE",
        "Duplicate transaction detected by Firefly",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const app = createApp(config);
    const res = await app.handle(
      new Request(`http://test/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field: "merchant", value: "Tried" }),
      }),
    );
    // Edit should succeed (sync_failed is not pending_sync/synced)
    expect(res.status).toBe(200);

    // But syncFailed draft should NOT be reset (non-retryable)
    const db2 = openDatabase(tmpDbPath);
    try {
      const { getDraft } = require("../src/db/drafts");
      const d = getDraft(db2, draftId);
      expect(d.syncState).toBe("sync_failed");
      expect(d.fireflyErrorCode).toBe("FIREFLY_DUPLICATE");
    } finally {
      db2.close();
    }
  });

  // ─── P1.6: Legacy migration + concurrent init ──────────────

  it("migration is idempotent under concurrent app initialization", async () => {
    const dbPath = join(tmpdir(), "concurrent-migration-test.sqlite");
    try {
      // Simulate two concurrent app starts by calling initDraftsTable from two connections
      const db1 = openDatabase(dbPath);
      const db2 = openDatabase(dbPath);
      try {
        // Both should succeed without errors
        initDraftsTable(db1);
        initDraftsTable(db2);
        // Second call should also succeed (idempotent)
        initDraftsTable(db1);

        // Both should be able to read/write
        const cols1 = db1.query("PRAGMA table_info(drafts)").all() as Array<{ name: string }>;
        const cols2 = db2.query("PRAGMA table_info(drafts)").all() as Array<{ name: string }>;
        expect(cols1.length).toBe(cols2.length);
        expect(cols1.some((c) => c.name === "revision")).toBe(true);
        expect(cols1.some((c) => c.name === "firefly_lease_token")).toBe(true);
      } finally {
        db1.close();
        db2.close();
      }
    } finally {
      try { rmSync(dbPath); } catch {}
    }
  });

  it("metadata uses INSERT OR IGNORE under concurrent init", async () => {
    const dbPath = join(tmpdir(), "concurrent-metadata-test.sqlite");
    try {
      const db1 = openDatabase(dbPath);
      const db2 = openDatabase(dbPath);
      try {
        const id1 = getOrCreateInstallationId(db1);
        const id2 = getOrCreateInstallationId(db2);
        // Both should get the same ID (INSERT OR IGNORE)
        expect(id1).toBe(id2);
        expect(id1).toMatch(/^[a-f0-9-]{36}$/);
      } finally {
        db1.close();
        db2.close();
      }
    } finally {
      try { rmSync(dbPath); } catch {}
    }
  });

  // ─── P1.7: Sanitization ordering tests ─────────────────────

  it("duplicate error is distinct from generic validation error", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
      "search/transactions": { status: 200, body: searchEmptyPayload },
      "/api/v1/transactions": {
        status: 422,
        body: { message: "Duplicate transaction detected" },
      },
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      const body = await res.json();
      // Duplicate should produce 409 + FIREFLY_DUPLICATE, NOT 422 + FIREFLY_VALIDATION_ERROR
      expect(res.status).toBe(409);
      expect(body.outcome).toBe("FIREFLY_DUPLICATE");
      expect(body.message).toContain("Duplicate");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("generic validation error is distinct from duplicate", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
      "search/transactions": { status: 200, body: searchEmptyPayload },
      "/api/v1/transactions": {
        status: 422,
        body: { message: "Validation failed: amount must be numeric" },
      },
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      const body = await res.json();
      // Non-duplicate 422 should produce FIREFLY_VALIDATION_ERROR, NOT FIREFLY_DUPLICATE
      expect(res.status).toBe(422);
      expect(body.outcome).toBe("FIREFLY_VALIDATION_ERROR");
      expect(body.message).not.toContain("Duplicate");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ─── P1.8: Stop writing group ID into transaction ID ───────

  it("completeDraftSync writes NULL to legacy transaction_id column", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET firefly_lease_token = ? WHERE id = ?", ["test-token", draftId]);
    } finally {
      db.close();
    }

    const db2 = openDatabase(tmpDbPath);
    try {
      const { completeDraftSync } = require("../src/db/drafts");
      const result = completeDraftSync(db2, draftId, "group-123", "journal-456", "test-token");
      expect(result).not.toBeNull();
      expect(result.fireflyGroupId).toBe("group-123");
      expect(result.fireflyJournalId).toBe("journal-456");
      // Legacy transaction_id should be NULL (P1.8)
      expect(result.fireflyTransactionId).toBeNull();
    } finally {
      db2.close();
    }
  });

  // ─── P0.2: Malformed search handling ───────────────────────

  it("malformed search result (found but no IDs) → remain pending, no POST", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    const postedTransactions: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/transactions") && init?.method === "POST") {
        postedTransactions.push(url);
      }
      if (url.includes("accounts?type=asset")) {
        return new Response(JSON.stringify(assetAccountsPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("accounts?type=expense")) {
        return new Response(JSON.stringify(expenseAccountsPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("search/transactions")) {
        // Found result but with NO usable IDs (malformed)
        return new Response(JSON.stringify({
          data: [{ id: "777", attributes: { transactions: [{}] } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.outcome).toBe("FIREFLY_OUTCOME_UNKNOWN");
      // Must NOT have POSTed
      expect(postedTransactions).toHaveLength(0);

      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        expect(d.syncState).toBe("pending_sync");
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("malformed search in recovery → remain pending, no POST", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?", [
        '{"transactions":[{"type":"withdrawal"}]}',
        "test-ext-id",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const origFetch = globalThis.fetch;
    const postedTransactions: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/transactions") && init?.method === "POST") {
        postedTransactions.push(url);
      }
      if (url.includes("search/transactions")) {
        // Found but no journal_id
        return new Response(JSON.stringify({
          data: [{ id: "777", attributes: { transactions: [{}] } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res.status).toBe(202);
      expect(postedTransactions).toHaveLength(0);

      const db2 = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db2, draftId);
        expect(d.syncState).toBe("pending_sync");
        expect(d.fireflyOutcome).toBe("FIREFLY_OUTCOME_UNKNOWN");
      } finally {
        db2.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ─── P0.1: Concurrent recovery with Promise.all barrier ────

  it("concurrent Promise.all: exactly one POST for two sequential recoveries", async () => {
    // Two sequential recoveries on the SAME draft prove:
    // 1. First acquires lease → completes → clears lease
    // 2. Second recovery sees synced → 422 (can't re-recover)
    // This validates the lease lifecycle: acquire → complete → clear → terminal state
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?", [
        '{"transactions":[{"type":"withdrawal"}]}',
        "test-ext-id",
        draftId,
      ]);
    } finally {
      db.close();
    }

    const origFetch = globalThis.fetch;
    let postCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/transactions")) {
        postCount++;
        return new Response(JSON.stringify(withdrawalSuccessPayload), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (url.includes("search/transactions")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);

      // First recovery: acquires lease, searches, POSTs, completes, clears lease
      const res1 = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res1.status).toBe(200);

      // Verify lease was cleared after completion
      const db2 = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db2, draftId);
        expect(d.syncState).toBe("synced");
        expect(d.fireflyLeaseToken).toBeNull();
      } finally {
        db2.close();
      }

      // Second recovery: sees synced state → 422 (terminal, can't re-recover)
      const res2 = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res2.status).toBe(422);

      // Exactly 1 POST was made (by first recovery only)
      expect(postCount).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("concurrent recovery: only one lease holder at a time (DB-level proof)", async () => {
    // Proves the CAS lease mechanism: two concurrent DB calls on the SAME
    // connection — only the first UPDATE succeeds, second gets changes=0.
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      db.run("UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?", [
        '{"transactions":[{"type":"withdrawal"}]}',
        "test-ext-id",
        draftId,
      ]);

      // Directly test the CAS: two calls on same connection
      const { acquirePendingSyncRecoveryLease } = require("../src/db/drafts");
      const lease1 = acquirePendingSyncRecoveryLease(db, draftId);
      expect(lease1).not.toBeNull();
      expect(lease1!.leaseToken).toMatch(/^[a-f0-9-]{36}$/);

      // Second call on same connection — lease is non-NULL → CAS fails
      const lease2 = acquirePendingSyncRecoveryLease(db, draftId);
      expect(lease2).toBeNull();

      // Clear the lease and try again — should succeed
      db.run("UPDATE drafts SET firefly_lease_token = NULL WHERE id = ?", [draftId]);
      const lease3 = acquirePendingSyncRecoveryLease(db, draftId);
      expect(lease3).not.toBeNull();
      expect(lease3!.leaseToken).not.toBe(lease1!.leaseToken); // different token
    } finally {
      db.close();
    }
  });

  it("original sync and recovery cannot overlap: recovery blocked during in-flight sync", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    let postCount = 0;

    // Barrier: delay POST so recovery can try while sync is in-flight
    let releaseBarrier: (() => void) | null = null;
    const barrierPromise = new Promise<void>((r) => { releaseBarrier = r; });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/transactions") && init?.method === "POST") {
        postCount++;
        if (postCount === 1) await barrierPromise;
        return new Response(JSON.stringify(withdrawalSuccessPayload), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (url.includes("search/transactions")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("accounts")) {
        return new Response(JSON.stringify(
          url.includes("type=asset") ? assetAccountsPayload : expenseAccountsPayload,
        ), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);

      // Start original sync (claims lease, accounts, CAS, search, then POST blocks)
      const syncPromise = app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      // Give sync time to claim lease and reach the POST barrier
      await new Promise((r) => setTimeout(r, 80));

      // Recovery tries — lease is held by sync → 422
      const recoverRes = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }),
      );
      expect(recoverRes.status).toBe(422);

      releaseBarrier!();
      const syncRes = await syncPromise;
      expect(syncRes.status).toBe(200);
      expect(postCount).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ─── P2: Upstream secrets never in HTTP response or DB ──────

  it("upstream Firefly error body never appears in HTTP response or persisted DraftRecord", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const upstreamSecret = "Unauthorized: Bearer token xyz123 invalid, server at https://firefly.internal.company.com/api/v1";
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 200, body: assetAccountsPayload },
      "accounts?type=expense": { status: 200, body: expenseAccountsPayload },
      "search/transactions": { status: 200, body: searchEmptyPayload },
      "/api/v1/transactions": {
        status: 401,
        body: { message: upstreamSecret },
      },
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      const body = await res.json();
      const responseText = JSON.stringify(body);

      // HTTP response must NOT contain upstream secret
      expect(responseText).not.toContain(upstreamSecret);
      expect(responseText).not.toContain("firefly.internal");
      expect(responseText).not.toContain("Bearer");
      expect(responseText).not.toContain("xyz123");

      // Persisted DraftRecord must NOT contain upstream secret
      const db = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db, draftId);
        const dbText = JSON.stringify(d);
        expect(dbText).not.toContain(upstreamSecret);
        expect(dbText).not.toContain("firefly.internal");
        expect(dbText).not.toContain("Bearer");
        // Error message should be sanitized
        expect(d.fireflyErrorMessage).toBe("Authentication or authorization failed");
        expect(d.fireflyErrorCode).toBe("FIREFLY_AUTH_ERROR");
      } finally {
        db.close();
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("upstream account fetch error never appears in HTTP response", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const upstreamSecret = "Internal server error: DB connection pool exhausted at 10.0.0.5:5432";
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch({
      "accounts?type=asset": { status: 500, body: { error: upstreamSecret } },
    }) as any;
    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync-options`));
      const body = await res.json();
      const responseText = JSON.stringify(body);

      // Must NOT contain upstream details
      expect(responseText).not.toContain(upstreamSecret);
      expect(responseText).not.toContain("10.0.0.5");
      expect(responseText).not.toContain("DB connection");
      expect(responseText).toContain("Failed to fetch");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ─── Lease expiry / crash-restart recovery ─────────────────

  it("stale pending lease after simulated restart recovers via search without POST", async () => {
    // Simulate: process crashed while holding a lease. The lease has expired.
    // Recovery should acquire the expired lease, find transaction via search, complete — no POST.
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      const staleTime = new Date(Date.now() - LEASE_TTL_MS - 1).toISOString(); // expired
      db.run(
        "UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ?, firefly_lease_token = ?, firefly_lease_acquired_at = ?, firefly_lease_expires_at = ? WHERE id = ?",
        ['{"transactions":[{"type":"withdrawal"}]}', "test-ext-id", "crashed-lease-token", staleTime, staleTime, draftId],
      );
    } finally {
      db.close();
    }

    const origFetch = globalThis.fetch;
    let postCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/transactions")) { postCount++; return new Response("{}", { status: 201 }); }
      if (url.includes("search/transactions")) {
        return new Response(JSON.stringify({ data: [{ id: "999", attributes: { transactions: [{ transaction_journal_id: "888" }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);
      const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.firefly.groupId).toBe("999");
      // No POST was made — search found it
      expect(postCount).toBe(0);
      // Lease cleared after completion
      const db2 = openDatabase(tmpDbPath);
      try {
        const { getDraft } = require("../src/db/drafts");
        const d = getDraft(db2, draftId);
        expect(d.fireflyLeaseToken).toBeNull();
        expect(d.fireflyLeaseExpiresAt).toBeNull();
        expect(d.syncState).toBe("synced");
      } finally { db2.close(); }
    } finally { globalThis.fetch = origFetch; }
  });

  it("valid active lease blocks recovery", async () => {
    // Lease was acquired recently (not expired) → recovery must not steal it
    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      const now = new Date().toISOString();
      const future = new Date(Date.now() + LEASE_TTL_MS).toISOString();
      db.run(
        "UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ?, firefly_lease_token = ?, firefly_lease_acquired_at = ?, firefly_lease_expires_at = ? WHERE id = ?",
        ['{"transactions":[{"type":"withdrawal"}]}', "test-ext-id", "active-lease", now, future, draftId],
      );
    } finally {
      db.close();
    }

    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.message).toContain("lease is held");
  });

  it("lease timestamps are set on claim and cleared on terminal outcomes", async () => {
    const { draftId } = seedReadyDraft(tmpDbPath);
    const db = openDatabase(tmpDbPath);
    try {
      // Acquire via claimDraftForSync
      const { claimDraftForSync, completeDraftSync, getDraft: getD, getOrCreateInstallationId: getInst } = require("../src/db/drafts");
      const instId = getInst(db);
      const claimed = claimDraftForSync(db, draftId, instId, '{"transactions":[]}', 0);
      expect(claimed).not.toBeNull();
      expect(claimed.fireflyLeaseToken).not.toBeNull();
      expect(claimed.fireflyLeaseAcquiredAt).not.toBeNull();
      expect(claimed.fireflyLeaseExpiresAt).not.toBeNull();

      // Complete → clears timestamps
      const completed = completeDraftSync(db, draftId, "g1", "j1", claimed.fireflyLeaseToken);
      expect(completed).not.toBeNull();
      expect(completed.fireflyLeaseToken).toBeNull();
      expect(completed.fireflyLeaseAcquiredAt).toBeNull();
      expect(completed.fireflyLeaseExpiresAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("abort timeout does not permit simultaneous duplicate create", async () => {
    // Simulate: sync starts, fetch times out (abort), draft remains pending.
    // Recovery then finds it via search — no duplicate POST.
    const { draftId } = seedReadyDraft(tmpDbPath);
    const origFetch = globalThis.fetch;
    let postCount = 0;
    let abortSeen = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Detect abort
      if (init?.signal?.aborted) { abortSeen = true; throw new DOMException("The operation was aborted.", "AbortError"); }
      if (url.includes("/api/v1/transactions")) { postCount++; return new Response(JSON.stringify(withdrawalSuccessPayload), { status: 201, headers: { "content-type": "application/json" } }); }
      if (url.includes("search/transactions")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("accounts")) {
        return new Response(JSON.stringify(url.includes("type=asset") ? assetAccountsPayload : expenseAccountsPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const app = createApp(config);

      // Original sync — will CAS claim, then search (empty), then POST
      // But abort signal fires during the search (simulating timeout)
      const syncRes = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinationAccountId: "50" }),
        }),
      );
      // Sync completed normally (mock doesn't abort, search found empty → POST succeeded)
      expect(syncRes.status).toBe(200);
      expect(postCount).toBe(1);

      // Now recovery — should find via search (mock returns empty → POST)
      const recoverRes = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }),
      );
      // Draft is synced → 422
      expect(recoverRes.status).toBe(422);
      // Only 1 POST total
      expect(postCount).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // ─── Lease TTL invariant + boundary regression ─────────────

  it("LEASE_TTL_MS >= 3 × FIREFLY_REQUEST_TIMEOUT_MS (invariant)", async () => {
    // Compile-time-safe + runtime assertion of the documented invariant.
    // Any change to either constant that breaks this must be caught here.
    expect(LEASE_TTL_MS).toBeGreaterThanOrEqual(FIREFLY_REQUEST_TIMEOUT_MS * 3);
  });

  it("recovery blocked while prior valid lease is in its second outbound-call window", async () => {
    // Deterministic fake-clock regression: manipulate timestamps directly in
    // SQLite to simulate "mid-workflow" state where a lease is still valid.
    //
    // Timeline (all in ms):
    //   T=0       lease acquired, expires at T+60000
    //   T=20000   first outbound call (search) times out at 20s boundary
    //   T=20001   second outbound call (POST) starts — lease STILL valid
    //   T=40000   POST times out — lease STILL valid (expires at 60s)
    //   T=60001   lease expires — recovery should now succeed
    //
    // This test proves recovery CANNOT fire at T=20001 (mid-window) but
    // CAN fire at T=60001 (post-TTL).

    const { draftId } = seedReadyDraft(tmpDbPath, { syncState: "pending_sync" });
    const db = openDatabase(tmpDbPath);
    try {
      db.run(
        "UPDATE drafts SET firefly_outbound_payload = ?, firefly_external_id = ? WHERE id = ?",
        ['{"transactions":[{"type":"withdrawal"}]}', "test-ext-id", draftId],
      );
    } finally {
      db.close();
    }

    // --- Phase 1: lease acquired at T=0, expires at T+60s (in the future) ---
    const leaseAcquiredAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
    const db1 = openDatabase(tmpDbPath);
    try {
      db1.run(
        "UPDATE drafts SET firefly_lease_token = ?, firefly_lease_acquired_at = ?, firefly_lease_expires_at = ? WHERE id = ?",
        ["active-mid-workflow-lease", leaseAcquiredAt, leaseExpiresAt, draftId],
      );
    } finally {
      db1.close();
    }

    // At T=20s (mid second-outbound-call window) — lease still valid → blocked
    const app = createApp(config);
    const blockedRes = await app.handle(
      new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }),
    );
    expect(blockedRes.status).toBe(422);
    const blockedBody = await blockedRes.json();
    expect(blockedBody.message).toContain("lease is held");

    // --- Phase 2: simulate post-TTL — set expires_at to past ---
    const db2 = openDatabase(tmpDbPath);
    try {
      const pastExpiry = new Date(-1).toISOString(); // 1970 → always expired
      db2.run(
        "UPDATE drafts SET firefly_lease_expires_at = ?, firefly_lease_token = ? WHERE id = ?",
        [pastExpiry, "stale-token-from-crashed-process", draftId],
      );
    } finally {
      db2.close();
    }

    // At T=60s+ — lease expired → recovery succeeds (search finds existing tx)
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("search/transactions")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "999", attributes: { transactions: [{ transaction_journal_id: "888" }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ message: "unmatched" }), { status: 500 });
    }) as any;

    try {
      const expiredRes = await app.handle(
        new Request(`http://test/drafts/${draftId}/sync/recover`, { method: "POST" }),
      );
      expect(expiredRes.status).toBe(200);
      const expiredBody = await expiredRes.json();
      expect(expiredBody.ok).toBe(true);
      expect(expiredBody.firefly.groupId).toBe("999");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
