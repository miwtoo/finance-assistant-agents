import { FIXED_CATEGORIES } from "../../domain/categories";
import type { DraftRecord } from "../../db/drafts";
import type { SlipRecord } from "../../db/slips";

interface RenderProps {
  draft: DraftRecord;
  slip: SlipRecord;
  saveError?: string | null;
  saveSuccess?: string | null;
}

export function renderDraftDetailPage(props: RenderProps): string {
  const { draft, slip, saveError, saveSuccess } = props;
  const imageUrl = `/slips/${slip.id}/image`;
  const isReady = draft.reviewState === "ready" || draft.reviewState === "approved";
  const isSynced = draft.syncState === "synced";

  const statusBadgeClass = (status: string) => {
    const map: Record<string, string> = {
      parsed: "badge-parsed",
      needs_review: "badge-needs-review",
      ready: "badge-ready",
      approved: "badge-ready",
      unsynced: "badge-unsynced",
      pending_sync: "badge-pending",
      synced: "badge-synced",
      sync_failed: "badge-error",
    };
    return map[status] ?? "badge-unsynced";
  };

  const categoryOptions = FIXED_CATEGORIES.map(
    (cat) => `<option value="${escapeHtml(cat)}" ${draft.category === cat ? "selected" : ""}>${escapeHtml(cat)}</option>`,
  ).join("\n");

  const currencyOptions = ["THB", "USD", "EUR", "JPY", "GBP", "SGD", "CNY"].map(
    (c) => `<option value="${c}" ${draft.currency === c ? "selected" : ""}>${c}</option>`,
  ).join("\n");

  const sourceAccountHints = draft.sourceAccountHints
    ? tryParseHints(draft.sourceAccountHints)
    : [];

  const hasValidFieldsForResolve =
    !!draft.date &&
    !!draft.amount &&
    !!draft.currency &&
    !!draft.merchant &&
    !!draft.sourceAccountName;

  const isCurrencyDefaulted =
    draft.hasUncertainty &&
    draft.parsedCurrency !== draft.currency;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Draft #${draft.id} — Finance Assistant</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0; padding: 0; background: #f5f5f5; color: #333; line-height: 1.5;
    }
    .split-layout { display: flex; min-height: 100vh; }
    .image-panel {
      flex: 1; background: #1a1a1a; display: flex; align-items: center; justify-content: center;
      padding: 1rem; position: sticky; top: 0; height: 100vh;
    }
    .image-panel img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px; }
    .form-panel { flex: 1; max-width: 640px; padding: 2rem; overflow-y: auto; }
    .form-panel h1 { margin-top: 0; font-size: 1.5rem; }

    @media (max-width: 768px) {
      .split-layout { flex-direction: column; }
      .image-panel { position: relative; height: 40vh; }
      .form-panel { max-width: none; padding: 1rem; }
    }

    .status-row { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .badge {
      display: inline-block; padding: 0.25rem 0.75rem; border-radius: 4px;
      font-size: 0.8rem; font-weight: 500;
    }
    .badge-parsed { background: #e3f2fd; color: #1565c0; }
    .badge-needs-review { background: #fff3e0; color: #e65100; }
    .badge-ready { background: #e8f5e9; color: #2e7d32; }
    .badge-approved { background: #e8f5e9; color: #1b5e20; }
    .badge-unsynced { background: #f5f5f5; color: #616161; }
    .badge-pending { background: #fff8e1; color: #f57f17; }
    .badge-synced { background: #e8f5e9; color: #2e7d32; }
    .badge-error { background: #ffebee; color: #c62828; }
    .badge-duplicate { background: #ffebee; color: #c62828; }
    .badge-uncertainty { background: #fff3e0; color: #e65100; }

    .banner {
      padding: 0.875rem 1rem; border-radius: 6px; margin-bottom: 1rem;
      font-size: 0.95rem;
    }
    .banner-error { background: #ffebee; color: #c62828; border: 1px solid #ef9a9a; }
    .banner-warning { background: #fff3e0; color: #e65100; border: 1px solid #ffcc80; }
    .banner-success { background: #e8f5e9; color: #2e7d32; border: 1px solid #a5d6a7; }

    .field-group { margin-bottom: 1.25rem; }
    .field-group label {
      display: block; font-weight: 500; margin-bottom: 0.375rem;
      font-size: 0.9rem; color: #444;
    }
    .field-group input, .field-group select, .field-group textarea {
      width: 100%; padding: 0.625rem; border: 1px solid #ccc; border-radius: 6px;
      font-size: 1rem; min-height: 44px; background: #fff;
    }
    .field-group input:focus, .field-group select:focus, .field-group textarea:focus {
      outline: none; border-color: #1565c0; box-shadow: 0 0 0 3px rgba(21,101,192,0.15);
    }
    .field-group input:read-only, .field-group textarea:read-only {
      background: #f5f5f5; color: #666;
    }
    .field-group .help-text { font-size: 0.8rem; color: #666; margin-top: 0.375rem; }
    .field-group .audit-field {
      background: #f5f5f5; padding: 0.625rem; border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9rem; color: #555; word-break: break-word;
    }

    .actions { display: flex; gap: 0.5rem; margin-top: 1.5rem; flex-wrap: wrap; }
    .btn {
      padding: 0.625rem 1.25rem; border: none; border-radius: 6px;
      font-size: 0.95rem; font-weight: 500; cursor: pointer; min-height: 44px;
      transition: opacity 0.15s;
    }
    .btn:hover:not(:disabled) { opacity: 0.9; }
    .btn-primary { background: #1565c0; color: white; }
    .btn-secondary { background: #f5f5f5; color: #333; border: 1px solid #ccc; }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }

    .parse-actions { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1.25rem; flex-wrap: wrap; }
    .loading-text { color: #666; font-size: 0.9rem; }

    .back-link { display: inline-block; margin-bottom: 1rem; color: #1565c0; text-decoration: none; font-size: 0.9rem; }
    .back-link:hover { text-decoration: underline; }

    .section-title { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin: 1.5rem 0 0.75rem; font-weight: 600; }

    .hint-list { font-size: 0.8rem; color: #666; margin-top: 0.375rem; }
    .hint-item { margin-bottom: 0.25rem; }
  </style>
</head>
<body>
  <div class="split-layout">
    <div class="image-panel">
      <img src="${escapeHtml(imageUrl)}" alt="Banking slip image for draft #${draft.id}">
    </div>
    <div class="form-panel">
      <a href="/candidates" class="back-link">← Back to candidates</a>
      <h1>Draft #${draft.id}</h1>

      <div class="status-row">
        <span class="badge ${statusBadgeClass(draft.reviewState)}">${escapeHtml(draft.reviewState)}</span>
        <span class="badge ${statusBadgeClass(draft.syncState)}">${escapeHtml(draft.syncState)}</span>
        ${draft.duplicateRisk ? '<span class="badge badge-duplicate">duplicate risk</span>' : ""}
        ${draft.hasUncertainty ? '<span class="badge badge-uncertainty">uncertainty</span>' : ""}
      </div>

      ${draft.duplicateRisk ? `
      <div class="banner banner-error" role="alert">
        <strong>Duplicate risk.</strong> This slip may already exist in the workflow.
        You can save edits, but you cannot mark as ready until resolved.
      </div>
      ` : ""}

      ${draft.hasUncertainty ? `
      <div class="banner banner-warning" role="alert">
        <strong>Parser uncertainty.</strong> Some fields need your review.
        Fill in valid values, then click <strong>Confirm reviewed fields</strong>.
      </div>
      ` : ""}

      ${saveError ? `<div class="banner banner-error" role="alert"><strong>Error:</strong> ${escapeHtml(saveError)}</div>` : ""}
      ${saveSuccess ? `<div class="banner banner-success" role="status">${escapeHtml(saveSuccess)}</div>` : ""}

      <div id="jsErrorBanner" class="banner banner-error" role="alert" style="display:none;"></div>

      ${!isReady && !isSynced ? `
      <div class="parse-actions">
        <button class="btn ${!draft.merchant && !draft.amount ? 'btn-primary' : 'btn-secondary'}" id="parseBtn" onclick="parseSlip()">${!draft.merchant && !draft.amount ? 'Parse slip' : 'Re-parse slip'}</button>
        <span class="loading-text" id="parseLoading" style="display:none;">Parsing with Gemini…</span>
      </div>
      ` : ""}

      <div class="section-title">Transaction details</div>

      <form id="draftForm" onsubmit="return false;">

      <div class="field-group">
        <label for="date">Date</label>
        <input type="date" id="date" name="date" value="${escapeHtml(draft.date ?? "")}" ${isSynced ? "readonly" : ""}>
      </div>

      <div class="field-group">
        <label for="amount">Amount</label>
        <input type="text" inputmode="decimal" id="amount" name="amount" value="${escapeHtml(draft.amount ?? "")}" placeholder="123.45" ${isSynced ? "readonly" : ""}>
        <div class="help-text">Exact decimal value. Never rounded.</div>
      </div>

      <div class="field-group">
        <label for="currency">Currency</label>
        <select id="currency" name="currency" ${isSynced ? "disabled" : ""}>
          ${currencyOptions}
        </select>
        ${isCurrencyDefaulted ? `
          <div class="help-text">Parser could not confirm currency; THB is the default until reviewed.</div>
        ` : (!draft.currency || draft.currency === "UNKNOWN") ? `
          <div class="help-text">Defaulted to THB — verify before marking ready</div>
        ` : ""}
      </div>

      <div class="field-group">
        <label>Parsed merchant (audit)</label>
        <div class="audit-field" id="parsedMerchant">${escapeHtml(draft.parsedMerchant ?? "—")}</div>
        <div class="help-text">Original text from the parser. Not editable.</div>
      </div>

      <div class="field-group">
        <label for="merchant">Normalized merchant</label>
        <input type="text" id="merchant" name="merchant" value="${escapeHtml(draft.merchant ?? "")}" placeholder="Clean merchant name" ${isSynced ? "readonly" : ""}>
        <div class="help-text">Clean name used as the Firefly destination account.</div>
      </div>

      <div class="field-group">
        <label for="category">Category (optional)</label>
        <select id="category" name="category" ${isSynced ? "disabled" : ""}>
          <option value="" ${!draft.category ? "selected" : ""}>— None —</option>
          ${categoryOptions}
        </select>
      </div>

      <div class="field-group">
        <label for="source_account_name">Source account</label>
        <input type="text" id="source_account_name" name="source_account_name" value="${escapeHtml(draft.sourceAccountName ?? "")}" placeholder="e.g. Kasikorn Savings" ${isSynced ? "readonly" : ""}>
        ${sourceAccountHints.length > 0 ? `
          <div class="hint-list">
            <div class="hint-item">Hints from slip:</div>
            ${sourceAccountHints.map(h => `<div class="hint-item">• ${escapeHtml(h.identifier)} — ${escapeHtml(h.evidence)} (${escapeHtml(h.source)})</div>`).join("")}
          </div>
        ` : ""}
        <div class="help-text">Must match a Firefly asset account. Not auto-detected from folders.</div>
      </div>

      ${!isSynced ? `
      <div class="actions">
        <button type="button" class="btn btn-secondary" onclick="saveDraft()">Save as needs review</button>
        ${draft.hasUncertainty ? `<button type="button" class="btn btn-secondary" onclick="resolveUncertainty()" ${!hasValidFieldsForResolve ? "disabled" : ""}>Confirm reviewed fields</button>` : ""}
        <button type="button" class="btn btn-primary" onclick="markReady()" ${draft.duplicateRisk || draft.hasUncertainty || !hasValidFieldsForResolve ? "disabled" : ""}>Mark ready</button>
      </div>
      ${!hasValidFieldsForResolve && !draft.duplicateRisk && !draft.hasUncertainty ? '<div class="help-text">Fill all required fields to enable Mark ready.</div>' : ""}
      ` : `
      <div class="banner banner-success" role="status">This draft is synced and read-only.</div>
      `}
      </form>
    </div>
  </div>

  <script>
    const draftId = ${draft.id};
    const slipId = ${draft.slipId};

    function setLoading(id, loading) {
      const el = document.getElementById(id);
      if (el) el.style.display = loading ? 'inline' : 'none';
    }
    function disableBtn(id, disabled) {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    }
    function showJsError(msg) {
      const el = document.getElementById('jsErrorBanner');
      if (el) { el.textContent = msg; el.style.display = 'block'; }
    }
    function hideJsError() {
      const el = document.getElementById('jsErrorBanner');
      if (el) { el.style.display = 'none'; }
    }

    async function parseSlip() {
      hideJsError();
      setLoading('parseLoading', true);
      disableBtn('parseBtn', true);
      try {
        const res = await fetch('/candidates/' + slipId + '/parse', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          window.location.reload();
        } else {
          showJsError('Parse failed: ' + (data.message || 'Unknown error'));
          setLoading('parseLoading', false);
          disableBtn('parseBtn', false);
        }
      } catch (e) {
        showJsError('Parse error: ' + (e.message || 'Network error'));
        setLoading('parseLoading', false);
        disableBtn('parseBtn', false);
      }
    }

    async function saveDraft() {
      hideJsError();
      const fields = [
        { id: 'date', name: 'date' },
        { id: 'amount', name: 'amount' },
        { id: 'currency', name: 'currency' },
        { id: 'merchant', name: 'merchant' },
        { id: 'source_account_name', name: 'source_account_name' },
        { id: 'category', name: 'category' },
      ];
      try {
        for (const f of fields) {
          const el = document.getElementById(f.id);
          const value = el ? el.value : null;
          const res = await fetch('/drafts/' + draftId, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ field: f.name, value: value || null })
          });
          if (!res.ok) {
            let msg = 'Save failed for ' + f.name;
            try {
              const data = await res.json();
              msg = data.message || msg;
            } catch {}
            showJsError(msg);
            return;
          }
        }
        window.location.search = '?saved=1';
      } catch (e) {
        showJsError('Save error: ' + (e.message || 'Network error'));
      }
    }

    async function resolveUncertainty() {
      hideJsError();
      // Client-side pre-check: amount and date must look valid
      const amountEl = document.getElementById('amount');
      const dateEl = document.getElementById('date');
      const amountVal = amountEl ? amountEl.value : '';
      const dateVal = dateEl ? dateEl.value : '';
      if (!/^-?\d+([.,]\d+)?$/.test(amountVal)) {
        showJsError('Amount must be a valid decimal before confirming review.');
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
        showJsError('Date must be in YYYY-MM-DD format before confirming review.');
        return;
      }
      try {
        const res = await fetch('/drafts/' + draftId + '/resolve-uncertainty', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          window.location.search = '?resolved=1';
        } else {
          showJsError('Cannot resolve: ' + (data.errors ? data.errors.join(', ') : data.message));
        }
      } catch (e) {
        showJsError('Error: ' + (e.message || 'Network error'));
      }
    }

    async function markReady() {
      hideJsError();
      try {
        const res = await fetch('/drafts/' + draftId + '/mark-ready', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          window.location.search = '?ready=1';
        } else {
          showJsError('Not ready: ' + (data.errors ? data.errors.join(', ') : data.message));
        }
      } catch (e) {
        showJsError('Error: ' + (e.message || 'Network error'));
      }
    }
  </script>
</body>
</html>`;
}

interface SourceAccountHint {
  identifier: string;
  evidence: string;
  source: string;
}

function tryParseHints(raw: string): SourceAccountHint[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (h): h is SourceAccountHint =>
          typeof h === "object" &&
          h !== null &&
          typeof h.identifier === "string" &&
          typeof h.evidence === "string" &&
          typeof h.source === "string",
      );
    }
  } catch {
    // ignore
  }
  return [];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
