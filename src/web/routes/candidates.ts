import { Database } from "bun:sqlite";
import type { AppConfig } from "../../config";
import { openDatabase } from "../../db/client";
import { initSlipsTable, upsertSlipRecord, getSlipsByPaths } from "../../db/slips";
import type { SlipRecord } from "../../db/slips";
import { initDraftsTable, getDraftBySlipId, getAllDrafts } from "../../db/drafts";
import { discoverSlipCandidates, type ScanOptions } from "../../domain/slipScanner";
import type { SlipCandidate } from "../../domain/slipScanner";

interface SlipRow extends SlipRecord {
  draftId: number | null;
  draftReviewState: string | null;
  draftSyncState: string | null;
}

/**
 * GET /candidates handler.
 *
 * Accepts optional query params:
 *   startDate — ISO date string (files with mtime >= this date)
 *   endDate   — ISO date string (files with mtime <= this date)
 *
 * Scans SLIPS_RAW_DIR, upserts results into DB (idempotent), and returns
 * an HTML page showing only the current scan results with status badges,
 * duplicate-risk indicators, parse status, scan/loading affordance, and
 * error handling.
 *
 * Each row includes:
 * - Parse action button (POST /candidates/:id/parse)
 * - Draft link if a draft exists for the slip
 * - Image link to view the raw slip
 */
export function candidatesPageHandler(config: AppConfig) {
  return async (context: {
    query: Record<string, string | undefined>;
  }): Promise<Response> => {
    let db: Database | null = null;

    try {
      db = openDatabase(config.dbPath);
      initSlipsTable(db);
      initDraftsTable(db);

      // Parse optional date-range query params
      const scanOptions = parseScanOptions(context.query);

      let candidates: SlipCandidate[] = [];
      let scanError: string | null = null;

      try {
        candidates = await discoverSlipCandidates(config.slipsRawDir, scanOptions);
      } catch (e) {
        scanError = e instanceof Error ? e.message : String(e);
      }

      // Upsert all discovered candidates into DB
      for (const c of candidates) {
        upsertSlipRecord(db, c);
      }

      // Query only the current scan results (not all historical records)
      const currentPaths = candidates.map((c) => c.sourcePath);
      const safeDb = db!; // guaranteed non-null from open + init above
      const records: SlipRow[] =
        currentPaths.length > 0
          ? (getSlipsByPaths(safeDb, currentPaths) as SlipRow[]).map((r) => {
              const draft = getDraftBySlipId(safeDb, r.id);
              return {
                ...r,
                draftId: draft?.id ?? null,
                draftReviewState: draft?.reviewState ?? null,
                draftSyncState: draft?.syncState ?? null,
              };
            })
          : [];

      const html = renderCandidatesPage(records, scanError, scanOptions);
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      // Catch-all for unexpected errors (e.g. DB open failure)
      const msg = e instanceof Error ? e.message : String(e);
      const html = renderCandidatesPage([], `Unexpected error: ${msg}`, undefined);
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } finally {
      db?.close();
    }
  };
}

function parseScanOptions(query: Record<string, string | undefined>): ScanOptions | undefined {
  const rawStart = query["startDate"] ?? query["startdate"];
  const rawEnd = query["endDate"] ?? query["enddate"];

  if (!rawStart && !rawEnd) return undefined;

  const opts: ScanOptions = {};
  if (rawStart) {
    const d = new Date(rawStart);
    if (!Number.isNaN(d.getTime())) opts.startDate = d;
  }
  if (rawEnd) {
    const d = new Date(rawEnd);
    if (!Number.isNaN(d.getTime())) opts.endDate = d;
  }

  return Object.keys(opts).length > 0 ? opts : undefined;
}

function renderCandidatesPage(
  records: SlipRow[],
  scanError: string | null,
  scanOptions?: ScanOptions,
): string {
  const rows = records
    .map(
      (r) => `
      <tr>
        <td>
          <a href="/slips/${r.id}/image" target="_blank" rel="noopener">${escapeHtml(basename(r.sourcePath))}</a>
          <br><small>${escapeHtml(r.sourcePath)}</small>
        </td>
        <td><span class="status status-${r.lifecycleStatus}">${escapeHtml(r.lifecycleStatus)}</span></td>
        <td>${escapeHtml(r.parseStatus)}</td>
        <td>${r.duplicateRisk ? '<span class="badge badge-risk">⚠ Duplicate Risk</span>' : ""}</td>
        <td>
          ${renderActions(r)}
        </td>
        <td>${r.scanError ? escapeHtml(r.scanError) : ""}</td>
      </tr>`,
    )
    .join("\n");

  const filterInfo =
    scanOptions?.startDate || scanOptions?.endDate
      ? ` (filter: ${scanOptions.startDate?.toISOString() ?? "—"} – ${scanOptions.endDate?.toISOString() ?? "—"})`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Slip Candidates — Finance Assistant</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem; background: #f5f5f5; color: #333; }
    h1 { margin-top: 0; }
    table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid #eee; }
    th { background: #fafafa; font-weight: 600; }
    tr:hover { background: #f0f8ff; }
    .status { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 500; }
    .status-discovered { background: #e3f2fd; color: #1565c0; }
    .status-parsed { background: #e8f5e9; color: #2e7d32; }
    .status-parse_failed { background: #ffebee; color: #c62828; }
    .status-skipped { background: #f5f5f5; color: #757575; }
    .badge-risk { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; background: #fff3e0; color: #e65100; font-weight: 600; }
    .badge-draft { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; background: #e8f5e9; color: #2e7d32; font-weight: 500; }
    .btn { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 4px; font-size: 0.8rem; text-decoration: none; cursor: pointer; border: 1px solid #ccc; background: #fff; color: #333; }
    .btn-primary { background: #1565c0; color: #fff; border-color: #1565c0; }
    .btn-small { font-size: 0.75rem; padding: 0.15rem 0.4rem; }
    .empty { text-align: center; padding: 3rem; color: #888; }
    .error-banner { background: #ffebee; color: #c62828; padding: 1rem; border-radius: 4px; margin-bottom: 1rem; }
    .scan-bar { margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
    .scan-bar button { padding: 0.4rem 1rem; cursor: pointer; }
    .scan-bar .loading { display: none; }
    .scan-bar.scanning button { display: none; }
    .scan-bar.scanning .loading { display: inline; }
    .actions { display: flex; gap: 0.3rem; flex-wrap: wrap; align-items: center; }
  </style>
</head>
<body>
  <h1>Slip Candidates</h1>

  <div class="scan-bar" id="scanBar">
    <button id="scanBtn" onclick="scan()">Scan Now</button>
    <span class="loading">Scanning…</span>
  </div>

  ${scanError ? `<div class="error-banner"><strong>Scan Error:</strong> ${escapeHtml(scanError)}</div>` : ""}

  <p>${records.length} record(s)${filterInfo}</p>

  ${records.length === 0 && !scanError ? '<div class="empty"><p>No slips found. Click "Scan Now" or add slip images to the raw folder and refresh.</p></div>' : ""}

  ${records.length > 0 ? `<table>
    <thead>
      <tr>
        <th>File</th>
        <th>Status</th>
        <th>Parse</th>
        <th>Risk</th>
        <th>Actions</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>` : ""}

  <script>
    function scan() {
      document.getElementById('scanBar').classList.add('scanning');
      setTimeout(function () {
        window.location.reload();
      }, 200);
    }
    async function parseSlip(slipId) {
      try {
        const res = await fetch('/candidates/' + slipId + '/parse', { method: 'POST' });
        const data = await res.json();
        if (data.ok && data.draftId) {
          window.location.href = '/drafts/' + data.draftId;
        } else {
          alert('Parse result: ' + (data.message || 'unknown'));
          window.location.reload();
        }
      } catch (e) {
        alert('Parse error: ' + e.message);
        window.location.reload();
      }
    }
    async function createManualDraft(slipId) {
      try {
        const res = await fetch('/candidates/' + slipId + '/create-draft', { method: 'POST' });
        const data = await res.json();
        if (data.ok && data.draftId) {
          window.location.href = '/drafts/' + data.draftId;
        } else {
          alert('Error: ' + (data.message || 'unknown'));
          window.location.reload();
        }
      } catch (e) {
        alert('Error: ' + e.message);
        window.location.reload();
      }
    }
  </script>
</body>
</html>`;
}

function renderActions(r: SlipRow): string {
  const parts: string[] = [];

  // Image link (always available)
  parts.push(`<a href="/slips/${r.id}/image" target="_blank" class="btn btn-small">🔍 View</a>`);

  // Draft link if draft exists
  if (r.draftId) {
    const stateLabel = r.draftReviewState === "ready" ? "✅ Ready" : r.draftReviewState === "needs_review" ? "🔧 Needs Review" : r.draftReviewState ?? "Draft";
    parts.push(`<a href="/drafts/${r.draftId}" class="btn btn-small badge-draft">${stateLabel}</a>`);
  } else {
    // Parse trigger button
    parts.push(`<button onclick="parseSlip(${r.id})" class="btn btn-small btn-primary">Parse</button>`);
    // Manual draft button (alternative)
    parts.push(`<button onclick="createManualDraft(${r.id})" class="btn btn-small">Manual</button>`);
  }

  return `<div class="actions">${parts.join(" ")}</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}
