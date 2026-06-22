import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/index";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/client";
import { initSlipsTable, upsertSlipRecord } from "../src/db/slips";
import { initDraftsTable, upsertDraft } from "../src/db/drafts";
import type { SlipCandidate } from "../src/domain/slipScanner";

describe("GET /drafts/:id", () => {
  let tmpSlipsDir: string;
  let tmpDbPath: string;
  let config: AppConfig;

  beforeAll(() => {
    tmpSlipsDir = mkdtempSync(join(tmpdir(), "draft-detail-test-slips-"));
    writeFileSync(join(tmpSlipsDir, "test-slip.jpg"), "fake-image-data");
    tmpDbPath = join(tmpdir(), "draft-detail-test-db.sqlite");
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

  /** Seed a slip and draft into the DB directly. Returns draft id. */
  function seedDraft(overrides: {
    duplicateRisk?: boolean;
    hasUncertainty?: boolean;
    reviewState?: string;
    syncState?: string;
    amount?: string | null;
    merchant?: string | null;
    sourceAccountName?: string | null;
    category?: string | null;
    parsedMerchant?: string | null;
    sourceAccountHints?: string | null;
  } = {}): number {
    const db = openDatabase(tmpDbPath);
    try {
      initSlipsTable(db);
      initDraftsTable(db);
      const slipPath = join(tmpSlipsDir, "test-slip.jpg");
      const slip = upsertSlipRecord(db, {
        sourcePath: slipPath,
        contentHash: "detail-test-hash",
        mtime: new Date(),
      } as SlipCandidate);

      const draft = upsertDraft(db, {
        slipId: slip.id,
        sourcePath: slip.sourcePath,
        contentHash: slip.contentHash,
        date: "2025-06-22",
        amount: ("amount" in overrides ? overrides.amount : "100.00") as string | null,
        currency: "THB",
        parsedCurrency: "THB",
        merchant: ("merchant" in overrides ? overrides.merchant : "Test Merchant") as string | null,
        parsedMerchant: ("parsedMerchant" in overrides ? overrides.parsedMerchant : "Test Parsed Merchant") as string | null,
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: ("sourceAccountHints" in overrides ? overrides.sourceAccountHints : null) as string | null,
        sourceAccountName: ("sourceAccountName" in overrides ? overrides.sourceAccountName : "My Bank") as string | null,
        category: ("category" in overrides ? overrides.category : null) as string | null,
        reviewState: ("reviewState" in overrides ? overrides.reviewState : "parsed") as any,
        syncState: ("syncState" in overrides ? overrides.syncState : "unsynced") as any,
        duplicateRisk: ("duplicateRisk" in overrides ? overrides.duplicateRisk : false) as boolean,
        hasUncertainty: ("hasUncertainty" in overrides ? overrides.hasUncertainty : false) as boolean,
        userEditedAt: null,
      });
      return draft.id;
    } finally {
      db.close();
    }
  }

  it("returns 404 for missing draft", async () => {
    const app = createApp(config);
    const res = await app.handle(new Request("http://test/drafts/99999"));
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.toLowerCase()).toContain("not found");
  });

  it("returns 400 for invalid draft id", async () => {
    const app = createApp(config);
    const res = await app.handle(new Request("http://test/drafts/abc"));
    expect(res.status).toBe(400);
  });

  it("shows split view with image and form", async () => {
    const draftId = seedDraft();
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.toLowerCase()).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("<img");
    expect(body).toContain(`/slips/`);
    expect(body).toContain("/image");
    expect(body).toContain("<form");
    expect(body).toContain('id="date"');
    expect(body).toContain('id="amount"');
    expect(body).toContain('id="currency"');
    expect(body).toContain('id="merchant"');
    expect(body).toContain('id="category"');
    expect(body).toContain('id="source_account_name"');
  });

  it("amount input is type text with inputmode decimal", async () => {
    const draftId = seedDraft();
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/type=["']text["']/);
    expect(body).toMatch(/inputmode=["']decimal["']/);
  });

  it("shows parsed merchant as read-only audit field", async () => {
    const draftId = seedDraft({ parsedMerchant: "7-ELEVEN @ SIAM" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toContain("7-ELEVEN @ SIAM");
    expect(body).toMatch(/audit-field/);
    expect(body).toMatch(/parsed merchant \(audit\)/i);
  });

  it("shows normalized merchant as editable input", async () => {
    const draftId = seedDraft({ merchant: "7-Eleven Siam" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toContain("7-Eleven Siam");
    expect(body).toMatch(/normalized merchant/i);
    expect(body).toMatch(/id=["']merchant["']/);
  });

  it("shows status badges for review and sync state", async () => {
    const draftId = seedDraft({ reviewState: "needs_review", syncState: "unsynced" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body.toLowerCase()).toContain("needs_review");
    expect(body.toLowerCase()).toContain("unsynced");
  });

  it("shows duplicate risk banner when duplicateRisk is true", async () => {
    const draftId = seedDraft({ duplicateRisk: true });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body.toLowerCase()).toContain("duplicate risk");
    expect(body).toMatch(/banner-error/);
  });

  it("does not show duplicate risk banner when false", async () => {
    const draftId = seedDraft({ duplicateRisk: false });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("duplicate risk");
  });

  it("shows uncertainty banner and resolve action when hasUncertainty is true", async () => {
    const draftId = seedDraft({ hasUncertainty: true, amount: "100.00", merchant: "Shop", sourceAccountName: "Bank" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body.toLowerCase()).toContain("uncertainty");
    expect(body).toMatch(/resolve review/i);
    expect(body).toMatch(/banner-warning/);
  });

  it("does not show resolve action when hasUncertainty is false", async () => {
    const draftId = seedDraft({ hasUncertainty: false });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("resolve review");
  });

  it("mark-ready button is disabled when duplicate risk is active", async () => {
    const draftId = seedDraft({ duplicateRisk: true });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/mark ready/i);
    expect(body).toMatch(/disabled/);
  });

  it("mark-ready button is disabled when required fields are missing", async () => {
    const draftId = seedDraft({ amount: null, merchant: null, sourceAccountName: null });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/mark ready/i);
    expect(body).toMatch(/disabled/);
  });

  it("category is optional (includes empty option)", async () => {
    const draftId = seedDraft({ category: null });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/category \(optional\)/i);
    expect(body).toMatch(/<option value=""/);
  });

  it("shows source account hints from slip when available", async () => {
    const draftId = seedDraft({
      sourceAccountHints: JSON.stringify([{ identifier: "****1234", evidence: "****1234", source: "card_number" }]),
    });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toContain("****1234");
    expect(body).toMatch(/hints from slip/i);
  });

  it("has responsive viewport meta tag", async () => {
    const draftId = seedDraft();
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/<meta name="viewport"/);
    expect(body).toMatch(/width=device-width/);
  });

  it("has parse action buttons when draft is empty", async () => {
    const draftId = seedDraft({ amount: null, merchant: null, parsedMerchant: null });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/parse slip/i);
    expect(body).toMatch(/create draft manually/i);
  });

  it("shows re-parse button when draft has data", async () => {
    const draftId = seedDraft({ amount: "50.00", merchant: "Shop" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/re-parse slip/i);
    expect(body).not.toMatch(/create draft manually/i);
  });

  it("shows loading copy for parse action", async () => {
    const draftId = seedDraft();
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/parsing with gemini/i);
    expect(body).toMatch(/parseLoading/);
  });

  it("save button uses snake_case field names in JS", async () => {
    const draftId = seedDraft();
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toContain('"source_account_name"');
    expect(body).toContain('"merchant"');
    expect(body).toContain('"date"');
    expect(body).toContain('"amount"');
    expect(body).toContain('"currency"');
    expect(body).toContain('"category"');
  });

  it("shows read-only state when draft is synced", async () => {
    const draftId = seedDraft({ syncState: "synced" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/read-only/i);
    expect(body).toMatch(/synced and read-only/i);
  });
});
