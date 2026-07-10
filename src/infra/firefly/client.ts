import { FIREFLY_REQUEST_TIMEOUT_MS } from "../../db/drafts";

/**
 * Thin Firefly III API client.
 *
 * Uses native fetch with AbortSignal timeout.
 * Config: fireflyBaseUrl + Bearer token from AppConfig.
 */

// ─── Types ──────────────────────────────────────────────────

export interface FireflyAccount {
  id: string;
  name: string;
  type: string;
}

/**
 * Firefly III StoreTransaction request body.
 * `error_if_duplicate_hash` is at top level per official contract,
 * NOT inside each transaction entry.
 */
export interface FireflyWithdrawalRequest {
  error_if_duplicate_hash: true;
  transactions: [
    {
      type: "withdrawal";
      date: string;
      amount: string;
      description: string;
      source_id: string;
      destination_id: string;
      currency_code: string;
      external_id: string;
    },
    ...Array<Record<string, unknown>>,
  ];
}

export interface FireflyTransactionResult {
  groupId: string;
  journalId: string;
}

export interface FireflySearchResult {
  found: boolean;
  count: number;
  groupId: string | null;
  journalId: string | null;
  /** True when results exist but IDs could not be extracted (malformed response). */
  malformed: boolean;
}

export interface FireflyClientError {
  ok: false;
  status: number;
  message: string;
}

export type FireflyClientResult<T> =
  | { ok: true; data: T }
  | FireflyClientError;

// ─── Client factory ─────────────────────────────────────────

export interface FireflyClientConfig {
  baseUrl: string;
  token: string;
}

export function createFireflyClient(cfg: FireflyClientConfig) {
  return {
    getAssetAccounts: () => getAccounts(cfg, "asset"),
    getExpenseAccounts: () => getAccounts(cfg, "expense"),
    createWithdrawal: (body: FireflyWithdrawalRequest) =>
      createWithdrawal(cfg, body),
    searchByExternalId: (externalId: string) =>
      searchByExternalId(cfg, externalId),
  };
}

// ─── Internal helpers ───────────────────────────────────────

async function apiGet(
  cfg: FireflyClientConfig,
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<FireflyClientResult<unknown>> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(FIREFLY_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Capture response text for internal error classification (P1.7).
      // Raw body is never persisted or returned to clients — sanitization
      // happens at the route level via sanitizeFireflyError/mapFireflyErrorToSyncResult.
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        message: `Firefly GET failed (${res.status}): ${text}`,
      };
    }
    const json = await res.json();
    return { ok: true, data: json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, message: `Firefly network error: ${msg}` };
  }
}

async function apiPost(
  cfg: FireflyClientConfig,
  path: string,
  body: unknown,
): Promise<FireflyClientResult<unknown>> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FIREFLY_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Capture response text for internal error classification (P1.7).
      // Raw body is never persisted or returned to clients — sanitization
      // happens at the route level via sanitizeFireflyError/mapFireflyErrorToSyncResult.
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        message: `Firefly POST failed (${res.status}): ${text}`,
      };
    }
    const json = await res.json();
    return { ok: true, data: json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, message: `Firefly network error: ${msg}` };
  }
}

// ─── Account endpoints ──────────────────────────────────────

async function getAccounts(
  cfg: FireflyClientConfig,
  type: "asset" | "expense",
): Promise<FireflyClientResult<FireflyAccount[]>> {
  // Fetch up to 3 pages (max ~750 accounts) — sufficient for MVP
  const all: FireflyAccount[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = await apiGet(cfg, `/api/v1/accounts?type=${type}&page=${page}&limit=250`);
    if (!res.ok) return res;
    const data = res.data as {
      data?: Array<{ id: string; attributes: { name: string; type: string } }>;
    };
    const entries = data.data ?? [];
    for (const e of entries) {
      all.push({ id: e.id, name: e.attributes.name, type: e.attributes.type });
    }
    if (entries.length < 250) break; // last page
  }
  return { ok: true, data: all };
}

// ─── Transaction endpoint ───────────────────────────────────

async function createWithdrawal(
  cfg: FireflyClientConfig,
  body: FireflyWithdrawalRequest,
): Promise<FireflyClientResult<FireflyTransactionResult>> {
  const res = await apiPost(cfg, "/api/v1/transactions", body);
  if (!res.ok) return res;

  const raw = res.data as {
    data?: {
      id?: string;
      attributes?: {
        transactions?: Array<{ transaction_journal_id?: string }>;
      };
    };
  };

  const groupId = raw.data?.id;
  const journalId = raw.data?.attributes?.transactions?.[0]?.transaction_journal_id;

  if (!groupId || !journalId) {
    return {
      ok: false,
      status: 200,
      message: "Firefly returned unexpected withdrawal response shape",
    };
  }

  return { ok: true, data: { groupId, journalId } };
}

// ─── Search endpoint ────────────────────────────────────────

/**
 * Search for a transaction by external_id using Firefly's search API.
 *
 * Correct endpoint: GET /api/v1/search/transactions?query=external_id_is%3A%22<id>%22
 * Requires: Accept: application/vnd.api+json
 *
 * P0.2: If any result exists but no usable group/journal IDs, classify as malformed.
 * Both start and recover must remain pending and MUST NOT POST.
 */
async function searchByExternalId(
  cfg: FireflyClientConfig,
  externalId: string,
): Promise<FireflyClientResult<FireflySearchResult>> {
  const encoded = encodeURIComponent(`external_id_is:"${externalId}"`);
  const path = `/api/v1/search/transactions?query=${encoded}&page=1&limit=2`;
  const res = await apiGet(cfg, path, {
    Accept: "application/vnd.api+json",
  });
  if (!res.ok) return res;

  const raw = res.data as {
    data?: Array<{
      id?: string;
      attributes?: {
        transactions?: Array<{ transaction_journal_id?: string }>;
      };
    }>;
  };

  const entries = raw.data ?? [];
  const count = entries.length;

  if (count === 0) {
    return { ok: true, data: { found: false, count: 0, groupId: null, journalId: null, malformed: false } };
  }

  if (count > 1) {
    return { ok: true, data: { found: true, count, groupId: null, journalId: null, malformed: false } };
  }

  // Exactly 1 match — extract IDs
  const first = entries[0];
  const groupId = first.id ?? null;
  const journalId =
    first.attributes?.transactions?.[0]?.transaction_journal_id ?? null;

  // P0.2: If IDs are missing, classify as malformed
  if (!groupId || !journalId) {
    return { ok: true, data: { found: true, count: 1, groupId: null, journalId: null, malformed: true } };
  }

  return {
    ok: true,
    data: { found: true, count: 1, groupId, journalId, malformed: false },
  };
}
