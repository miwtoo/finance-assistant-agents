# Issue #3 — Confirm Sync → Firefly (First Slice)

**State**: Sync confirmation pure functions green. Branch `issue-3-confirm-sync-firefly`.

**Links**:
- Issue #3: https://github.com/miwtoo/finance-assistant-agents/issues/3
- Follow-up #9 (editable synced drafts): https://github.com/miwtoo/finance-assistant-agents/issues/9

---

## Grill-With-Docs Decisions

### Category Required for Ready/Sync
- Category is required for Draft to reach `ready` status.
- Firefly III categories imported at startup via `GET /api/v1/categories` (lazy+manual refresh — no auto-polling).
- When parsed slip produces category name not in imported list → `needs-review`; user must explicitly confirm creation or select existing category.
- New categories are created as flat (no subcategories — Firefly III has no category hierarchy).
- `category_name` field in Firefly transaction payload; if unknown to Firefly, it auto-creates the category.

### Source Account — Manual Picker Only (#3 Scope)
- No auto-matching for MVP 0. User selects from dropdown of imported Firefly asset accounts.
- Account list imported lazily + manually at startup (like categories).
- For #3, `sourceAccountName` must be non-null for Ready gate.
- Issue #3 uses manual picker; future issue may add slip-hint-based suggestion.

### Final Confirmation — Single Draft Now, Generic Model
- `buildSyncConfirmation()` accepts `DraftTransaction[]` — works for 1 or N.
- MVP starts with per-draft confirmation flow; model supports batch for future.
- Confirmation displays: transaction count, total amount by currency, item list with merchant/amount/category/source, blocked items with reason.
- User must explicitly confirm; no Firefly write without this.

### external_id Format
- `slip-sync:<draft-id>:<transaction-index>` — deterministic, stable.
- Used for idempotent Firefly lookups (`external_id` filter on `/api/v1/transactions`).
- Transaction index = 0 for single-transaction drafts (MVP 0 = 1 transaction per draft).

### Firefly Ensure Flow (Lookup-Before-Create)
1. Query Firefly transactions by `external_id`.
2. If found → mark Draft as `synced`, record external reference ID, done.
3. If not found → POST create transaction with `external_id`.
4. On POST success → record external reference ID, mark Draft `synced`.
5. On POST failure (network, auth, 422) → mark Draft `sync_state=failed`, record error, surface to user.
6. Retry permitted — user can retry failed syncs.

### Synced Draft Locked/Read-Only (#3 Scope)
- Once `sync_state = synced`, PATCH/mark-ready/resolve-uncertainty all return 409.
- Exception: future resync/repair flow (issue #9).
- Issue #9 will add editable synced drafts for correction/resync.

### Withdrawal Payload Shape
- `source_id` → Firefly asset account ID (source account selected by user).
- `destination_name` → Normalized Merchant (Firefly auto-creates Expense account).
- `external_id` → `slip-sync:<draft-id>:0`.
- `category_name` → Draft's category (Firefly auto-creates if new).
- `amount`, `date`, `currency` from Draft.
- Type: `withdrawal`.
- Description: slip file path for audit trail.

### Duplicate Hash Safety
- Check Firefly by `external_id` before create (ensure idempotent).
- `duplicateRisk` on Draft blocks pre-sync (user must override).
- Both mechanisms together prevent double-posting.

### Loading/Success/Failure UX Decisions
- Confirmation step is server-rendered HTML page (`GET /confirm`).
- "Sync Now" button triggers POST `/api/sync/confirm` → runs ensure flow per draft.
- During sync: loading spinner per-item, then success/failure badge.
- Success: draft card turns green with "Synced ✓" badge, links to Firefly transaction.
- Failure: draft card turns red with error message and "Retry" button.
- Final success banner: "X transactions synced to Firefly" with link to Firefly.
- If any failures: "Y of X failed" with retry-all option.

### TDD Order
1. Domain/service pure functions first ← **DONE** (syncService.ts + tests)
2. Firefly client fake + ensure service
3. Accounts/category import registry
4. DB sync transition + snapshot
5. Routes: GET /confirm + POST /api/sync/confirm
6. UI: confirmation page with per-item status

---

## Research Facts — Firefly III API

### Categories
- `GET /api/v1/categories` → returns `{ data: [{ id, attributes: { name } }] }`.
- Categories are flat (no subcategories).
- When a transaction is created with `category_name` that doesn't exist, Firefly auto-creates the category.
- No delete endpoint needed for MVP.

### Transactions
- `GET /api/v1/transactions` with `external_id={id}` filter → returns matching transaction or empty.
- `POST /api/v1/transactions` → body `{ transactions: [{ type: "withdrawal", date, amount, description, source_id, destination_name, category_name, external_id, currency_code, ... }] }`.
- `source_id` is the asset account ID (integer from Firefly).
- `destination_name` is the merchant name — Firefly auto-creates an Expense account if one doesn't exist with that name.
- Using `destination_name` (not `destination_id`) is safest for MVP — avoids needing to pre-create Expense accounts.
- Response contains `transaction_journal_id` for the created transaction.

### Accounts
- `GET /api/v1/accounts?type=asset` → returns asset accounts (bank accounts, credit cards).
- Each account has `id` and `attributes.name`.
- Accounts are stable — once imported, cache locally.
- No account creation needed from app (user manages accounts in Firefly UI).

---

## Current TDD Status

### Done (this slice)
| Layer | Files | Status |
|-------|-------|--------|
| Pure functions | `src/domain/syncService.ts` | ✅ 8 tests green |
| Tests | `tests/syncConfirmation.test.ts` | ✅ 29 expect() calls |
| Typecheck | tsc --noEmit | ✅ clean |
| Full suite | 237/238 pass | ⚠️ 1 pre-existing Cloudflare test fail |

### What the Pure Functions Cover
- `buildSyncExternalId(draftId, index)` → deterministic `slip-sync:{draftId}:{index}`.
- `buildSyncConfirmation(drafts[])` → `SyncConfirmation` with:
  - `totalCount` (ready drafts only).
  - `amountsByCurrency` (sum of ready amounts).
  - `items[]` (all drafts: ready + blocked with reason).
  - `blocked` + `blockReason` for duplicate-risk and not-ready drafts.
- Ready gate logic: `isReady()` requires date, amount, currency, merchant, sourceAccountName, category, no duplicateRisk.

### Next Phases (in order)

| Phase | What | Target |
|-------|------|--------|
| 1 | **Firefly client** — HTTP client interface + fake for tests + real implementation using fetch | Next |
| 2 | **Ensure service** — `ensureTransactionInFirefly(syncItem)` with lookup-before-create, retry, error recording | Next |
| 3 | **Account/category import** — registry with lazy+manual refresh from Firefly API | After 1-2 |
| 4 | **DB sync transitions** — `sync_state`, `external_ref_id`, `synced_at`, `sync_error` columns; update on sync | After 2 |
| 5 | **Routes** — `GET /confirm` (list ready drafts), `POST /api/sync/confirm` (run ensure), `GET /api/sync/status/:id` (poll) | After 3-4 |
| 6 | **UI confirmation page** — confirmation table, sync button, per-item spinner/success/failure, final banner | After 5 |

### Known Design Decisions Ahead
- `ensureTransactionInFirefly()` must be safe to call multiple times (idempotent via external_id).
- Synced drafts are locked (409 on edit) per #3 scope. Issue #9 will add editable synced drafts.
- Category/account import is lazy+manual — user clicks "Refresh Accounts" / "Refresh Categories" in UI. No auto-poll at startup.
- Firefly client will be injectable (interface + impl) for testability, same pattern as `ParserProvider`.
- Error responses from Firefly (422 validation, 401 auth, network timeout) must be surfaced as user-friendly messages.
- Total sync is intentionally NOT wrapped in a DB transaction — Firefly writes are remote and may succeed/fail independently.
