import { Database } from "bun:sqlite";
import type { AppConfig } from "../../config";
import { openDatabase } from "../../db/client";
import { initSlipsTable, upsertSlipRecord, getSlipsByPaths } from "../../db/slips";
import type { SlipRecord } from "../../db/slips";
import { discoverSlipCandidates, type ScanOptions } from "../../domain/slipScanner";
import type { SlipCandidate } from "../../domain/slipScanner";

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
 */
export function candidatesPageHandler(config: AppConfig) {
  return async (context: {
    query: Record<string, string | undefined>;
  }): Promise<Response> => {
    let db: Database | null = null;

    try {
      db = openDatabase(config.dbPath);
      initSlipsTable(db);

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
      const records =
        currentPaths.length > 0 ? getSlipsByPaths(db, currentPaths) : [];

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
  records: SlipRecord[],
  scanError: string | null,
  scanOptions?: ScanOptions,
): string {
  const rows = records
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.sourcePath)}</td>
        <td>${escapeHtml(r.contentHash ?? "—")}</td>
        <td>${escapeHtml(r.mtime ?? "—")}</td>
        <td><span class="status status-${r.lifecycleStatus}">${escapeHtml(r.lifecycleStatus)}</span></td>
        <td>${escapeHtml(r.parseStatus)}</td>
        <td>${r.duplicateRisk ? '<span class="badge badge-risk">⚠ Duplicate Risk</span>' : ""}</td>
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
    .badge-risk { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; background: #fff3e0; color: #e65100; font-weight: 600; }
    .empty { text-align: center; padding: 3rem; color: #888; }
    .error-banner { background: #ffebee; color: #c62828; padding: 1rem; border-radius: 4px; margin-bottom: 1rem; }
    .scan-bar { margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
    .scan-bar button { padding: 0.4rem 1rem; cursor: pointer; }
    .scan-bar .loading { display: none; }
    .scan-bar.scanning button { display: none; }
    .scan-bar.scanning .loading { display: inline; }
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
        <th>Path</th>
        <th>Content Hash</th>
        <th>Modified</th>
        <th>Status</th>
        <th>Parse Status</th>
        <th>Duplicate Risk</th>
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
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
