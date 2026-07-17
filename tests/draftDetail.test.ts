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

  function seedDraft(overrides: {
    duplicateRisk?: boolean;
    hasUncertainty?: boolean;
    reviewState?: string;
    syncState?: string;
    amount?: string | null;
    merchant?: string | null;
    sourceAccountName?: string | null;
    sourceAccountId?: string | null;
    category?: string | null;
    parsedMerchant?: string | null;
    parsedCurrency?: string | null;
    currency?: string | null;
    sourceAccountHints?: string | null;
    fireflyGroupId?: string | null;
    fireflyJournalId?: string | null;
    fireflyExternalId?: string | null;
    fireflyErrorMessage?: string | null;
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
        currency: ("currency" in overrides ? overrides.currency : "THB") as string | null,
        parsedCurrency: ("parsedCurrency" in overrides ? overrides.parsedCurrency : "THB") as string | null,
        merchant: ("merchant" in overrides ? overrides.merchant : "Test Merchant") as string | null,
        parsedMerchant: ("parsedMerchant" in overrides ? overrides.parsedMerchant : "Test Parsed Merchant") as string | null,
        parsedCategory: null,
        sourceIdentifier: null,
        sourceAccountHints: ("sourceAccountHints" in overrides ? overrides.sourceAccountHints : null) as string | null,
        sourceAccountName: ("sourceAccountName" in overrides ? overrides.sourceAccountName : "My Bank") as string | null,
        sourceAccountId: ("sourceAccountId" in overrides ? overrides.sourceAccountId : "asset-1") as string | null,
        category: ("category" in overrides ? overrides.category : null) as string | null,
        reviewState: ("reviewState" in overrides ? overrides.reviewState : "parsed") as any,
        syncState: ("syncState" in overrides ? overrides.syncState : "unsynced") as any,
        duplicateRisk: ("duplicateRisk" in overrides ? overrides.duplicateRisk : false) as boolean,
        hasUncertainty: ("hasUncertainty" in overrides ? overrides.hasUncertainty : false) as boolean,
        userEditedAt: null,
      });

      if (
        "fireflyGroupId" in overrides ||
        "fireflyJournalId" in overrides ||
        "fireflyExternalId" in overrides ||
        "fireflyErrorMessage" in overrides
      ) {
        db.run(
          `UPDATE drafts SET
            firefly_group_id = ?,
            firefly_journal_id = ?,
            firefly_external_id = ?,
            firefly_error_message = ?
          WHERE id = ?`,
          [
            overrides.fireflyGroupId ?? null,
            overrides.fireflyJournalId ?? null,
            overrides.fireflyExternalId ?? null,
            overrides.fireflyErrorMessage ?? null,
            draft.id,
          ],
        );
      }

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
    expect(body).toContain("/slips/");
    expect(body).toContain("/image");
    expect(body).toContain("<form");
    expect(body).toContain('id="date"');
    expect(body).toContain('id="amount"');
    expect(body).toContain('id="currency"');
    expect(body).toContain('id="merchant"');
    expect(body).toContain('id="category"');
    expect(body).toContain('id="source_account_id"');
    expect(body).not.toContain('id="source_account_name"');
    expect(body).toContain('/source-accounts');
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

  it("shows uncertainty banner and confirm action when hasUncertainty is true", async () => {
    const draftId = seedDraft({ hasUncertainty: true, amount: "100.00", merchant: "Shop", sourceAccountName: "Bank" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body.toLowerCase()).toContain("uncertainty");
    expect(body).toMatch(/confirm reviewed fields/i);
    expect(body).toMatch(/banner-warning/);
  });

  it("does not show confirm reviewed fields action when hasUncertainty is false", async () => {
    const draftId = seedDraft({ hasUncertainty: false });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("confirm reviewed fields");
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

  it("allows source-account selection to enable Mark ready when other fields are valid", async () => {
    const draftId = seedDraft({ sourceAccountId: null });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toContain("const canMarkReadyWithoutSourceAccount = true");
    expect(body).toContain("updateMarkReadyAvailability");
  });

  it("category is optional (includes empty option)", async () => {
    const draftId = seedDraft({ category: null });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/category \(optional\)/i);
    expect(body).toMatch(/<option value=""/);
  });

  it("shows source account hints with evidence and source when available", async () => {
    const draftId = seedDraft({
      sourceAccountHints: JSON.stringify([{ identifier: "****1234", evidence: "****1234", source: "card_number" }]),
    });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toContain("****1234");
    expect(body).toMatch(/hints from slip/i);
    expect(body).toMatch(/card_number/);
  });

  it("has responsive viewport meta tag", async () => {
    const draftId = seedDraft();
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/<meta name="viewport"/);
    expect(body).toMatch(/width=device-width/);
  });

  it("has parse button when draft is empty but no create-draft button", async () => {
    const draftId = seedDraft({ amount: null, merchant: null, parsedMerchant: null });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/parse slip/i);
    expect(body).not.toMatch(/create draft manually/i);
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

  it("saves ordinary draft fields separately from the source-account selector", async () => {
    const draftId = seedDraft();
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).not.toContain('"source_account_name"');
    expect(body).toContain("/source-account");
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

  it("shows currency default uncertainty copy when parsedCurrency differs from currency", async () => {
    const draftId = seedDraft({
      hasUncertainty: true,
      parsedCurrency: null,
      currency: "THB",
      amount: "100.00",
      merchant: "Shop",
      sourceAccountName: "Bank",
    });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/parser could not confirm currency/i);
    expect(body).toMatch(/thb is the default until reviewed/i);
  });

  it("shows currency default uncertainty copy when parsedCurrency is unrecognized", async () => {
    const draftId = seedDraft({
      hasUncertainty: true,
      parsedCurrency: "XYZ",
      currency: "THB",
      amount: "100.00",
      merchant: "Shop",
      sourceAccountName: "Bank",
    });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/parser could not confirm currency/i);
  });

  it("does not show currency default copy when parsedCurrency matches currency", async () => {
    const draftId = seedDraft({
      hasUncertainty: true,
      parsedCurrency: "THB",
      currency: "THB",
      amount: "100.00",
      merchant: "Shop",
      sourceAccountName: "Bank",
    });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).not.toMatch(/parser could not confirm currency/i);
  });

  it("action buttons have type button inside form", async () => {
    const draftId = seedDraft();
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    // All onclick buttons inside the form should be type="button"
    expect(body).toMatch(/type=["']button["']/);
  });

  it("saveDraft JS checks res.ok and shows error banner on failure", async () => {
    const draftId = seedDraft();
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/if \(!res\.ok\)/);
    expect(body).toMatch(/showJsError/);
    expect(body).toMatch(/jsErrorBanner/);
  });

  it("locks the form and shows recovery UI when syncState is pending_sync", async () => {
    const draftId = seedDraft({
      reviewState: "ready",
      syncState: "pending_sync",
      fireflyExternalId: "finance-assistant:test:draft:1",
    });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/sync result unknown/i);
    expect(body).toMatch(/Recover sync/i);
    expect(body).toMatch(/Recover this sync/i);
    expect(body).toMatch(/search Firefly/i);
    expect(body).toMatch(/identical withdrawal/i);
    expect(body).toContain("finance-assistant:test:draft:1");
    expect(body).not.toMatch(/Review and sync/i);
    expect(body).not.toMatch(/Mark ready/i);
    expect(body).toMatch(/id=["']date["'][^>]*readonly/);
    expect(body).toMatch(/id=["']currency["'][^>]*disabled/);
  });

  it("shows persisted Firefly references when synced", async () => {
    const draftId = seedDraft({
      syncState: "synced",
      fireflyGroupId: "grp-123",
      fireflyJournalId: "jrnl-456",
      fireflyExternalId: "ext-789",
    });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toContain("grp-123");
    expect(body).toContain("jrnl-456");
    expect(body).toContain("ext-789");
    expect(body).toMatch(/read-only/i);
  });

  it("emitted inline JS regex backslashes are preserved in rendered HTML", async () => {
    const draftId = seedDraft({ hasUncertainty: true, amount: "35.00", merchant: "Shop", sourceAccountName: "Bank" });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();

    // Amount regex: \d must survive template literal escaping
    expect(body).toContain("/^-?\\d+([.,]\\d+)?$/");
    expect(body).not.toContain("/^-?d+([.,]d+)?$/");

    // Date regex: \d must survive template literal escaping
    expect(body).toContain("/^\\d{4}-\\d{2}-\\d{2}$/");
    expect(body).not.toContain("/^d{4}-d{2}-d{2}$/");
  });

  it("shows server error for sync_failed without retry action", async () => {
    const draftId = seedDraft({
      reviewState: "ready",
      syncState: "sync_failed",
      fireflyErrorMessage: "Firefly withdrawal failed: 401 Unauthorized",
    });
    const app = createApp(config);
    const res = await app.handle(new Request(`http://test/drafts/${draftId}`));
    const body = await res.text();
    expect(body).toMatch(/Sync failed/i);
    expect(body).toContain("Firefly withdrawal failed: 401 Unauthorized");
    expect(body).not.toMatch(/Recover sync/i);
    expect(body).not.toMatch(/Review and sync/i);
    expect(body).not.toMatch(/Retry/i);
  });
});
