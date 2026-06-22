import { Database } from "bun:sqlite";
import type { AppConfig } from "../../config";
import { openDatabase } from "../../db/client";
import { initSlipsTable, getSlipById } from "../../db/slips";
import { initDraftsTable, getDraft } from "../../db/drafts";
import { renderDraftDetailPage } from "../views/draftDetailPage";

/**
 * GET /drafts/:id
 *
 * Render the draft detail split-view page:
 * - Slip image on the left (via /slips/:id/image)
 * - Editable draft form on the right
 *
 * Query params (transient UI feedback):
 *   saved=1   → show save success banner
 *   resolved=1 → show resolve success banner
 *   ready=1   → show mark-ready success banner
 *   error=msg → show error banner
 */
export function draftDetailHandler(config: AppConfig) {
  return async (context: {
    params: { id: string };
    query: Record<string, string | undefined>;
  }): Promise<Response> => {
    const draftId = Number.parseInt(context.params.id, 10);
    if (Number.isNaN(draftId) || draftId <= 0) {
      return htmlError("Invalid draft ID", 400);
    }

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initDraftsTable(db);
      initSlipsTable(db);

      const draft = getDraft(db, draftId);
      if (!draft) {
        return htmlError(`Draft #${draftId} not found`, 404);
      }

      const slip = getSlipById(db, draft.slipId);
      if (!slip) {
        return htmlError(`Source slip for draft #${draftId} not found`, 404);
      }

      const saveSuccess = context.query.saved
        ? "Draft saved."
        : context.query.resolved
          ? "Review resolved."
          : context.query.ready
            ? "Draft marked as ready."
            : null;

      const saveError = context.query.error ?? null;

      const html = renderDraftDetailPage({ draft, slip, saveError, saveSuccess });
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return htmlError(`Server error: ${msg}`, 500);
    } finally {
      db?.close();
    }
  };
}

function htmlError(message: string, status: number): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error — Finance Assistant</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem; background: #f5f5f5; color: #333; }
    .error-box { background: #ffebee; color: #c62828; padding: 1.5rem; border-radius: 6px; max-width: 600px; margin: 2rem auto; }
    a { color: #1565c0; }
  </style>
</head>
<body>
  <div class="error-box">
    <h1>Error</h1>
    <p>${message.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>
    <p><a href="/candidates">← Back to candidates</a></p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
