# Domain Glossary

Terms used throughout the project. Implementation scope is MVP 0 — slip-based expense sync to Firefly III.

---

**Slip** — A banking slip image (typically from Thai digital banking apps) serving as source evidence for an expense. Slips live in a read-only raw folder synced via Resilio Sync. The app never moves, renames, or modifies the original slip file.

**Category** — A Firefly III category used for expense classification. The app prefers matching against existing Firefly III categories imported at startup. When a parsed slip produces a category name that does not match any existing category, the user must explicitly confirm creation or use of the new name before sync proceeds. Category is required for a Draft to reach `ready` status and be eligible for sync.

**Draft** — A parsed, editable representation of a Slip stored in the app's own state (not in the raw folder). Drafts have a lifecycle status (discovered, parsed, needs-review, ready, synced, skipped) and are the central working object of the workflow. A partial but meaningful parse produces a needs-review Draft for human completion; a total parser failure (API error, schema validation failure, unparseable image) leaves the slip retryable and does not create or overwrite any Draft. Manual retry is permitted because AI parsing results can vary across attempts.

**Source Account** — The Firefly III asset account (bank account or credit card) used to pay for an expense. Matched from identifiers parsed from the slip image, not from folder names or folder structure. Sync is blocked until a valid Source Account is assigned.

**Normalized Merchant** — The cleaned, Firefly-friendly merchant name used as the destination expense account name in Firefly III. Category memory and merchant aliases attach to the Normalized Merchant, not to the raw parsed text.

**Parsed Merchant** — The raw merchant text extracted from the slip by the AI parser (Gemini). Preserved alongside the Normalized Merchant for audit and debugging. The two fields are separate; the Normalized Merchant is what reaches Firefly.

**Duplicate Risk** — A lifecycle status indicating a suspected repeat expense. A draft flagged as Duplicate Risk is blocked from proceeding to final sync until the user explicitly resolves it. This is the primary safety mechanism preventing duplicate transactions from reaching Firefly.

**Final Confirmation** — The last intentional step before Firefly sync. Displays transaction count, total amount by currency, the transaction list, duplicate-risk warnings, and excluded blocked items. The user must explicitly confirm; no Firefly write happens without this step.

**Raw Slips Folder** — The read-only directory containing original banking slip images, synced via Resilio Sync from the user's Android phone. The app scans this folder for eligible images (using file metadata for date-range filtering) but never writes to or modifies anything inside it.

**Monetary Amount** — A finance-sensitive exact decimal value parsed from a slip. Must be handled as exact decimal text (string), never as a floating-point number, to avoid rounding errors. Parser uncertainty about an amount (ambiguous digits, missing separators, partial OCR) must set the draft lifecycle to needs-review for human resolution.

## Domain Boundaries

- **Slip lives in read-only raw folder; app state lives separately.** The app stores drafts, review state, parsing history, matching rules, duplicate-risk data, skipped-slip history, and sync status in its own data store. The raw folder is never used as a state layer.

- **Duplicate Risk means suspected repeat expense that must be blocked before sync.** The system detects exact duplicate images and likely duplicate transactions. Any draft flagged as Duplicate Risk is excluded from approval and sync until the user explicitly overrides or resolves the risk. This is enforced at the review and confirmation boundaries.

- **Category must be confirmed by the user when no match exists.** The app imports existing Firefly III categories at startup and prefers matched categories automatically. When a parsed slip produces a category name that does not match any imported category, the draft is held at `needs-review` and the user must explicitly confirm creation or selection of a new category name before the draft can reach `ready`. This prevents accidental category creation in Firefly III.

- **Draft `ready` status gates sync.** A draft reaches `ready` only when it holds an exact amount, transaction date, currency, category, Normalized Merchant, and assigned Source Account — with no unresolved parser uncertainty, no unresolved Duplicate Risk, and no unconfirmed Category. Any missing or uncertain field holds the draft at `needs-review` or blocks promotion to `ready`.

- **Source Account matched from slip identifiers; folder context is fallback only, never automatic.** Source Account matching uses identifiers parsed from the slip image. If no parsed account hint exists, folder or source-context data may be surfaced to the user as a suggestion labeled as not slip evidence. This fallback must never auto-promote a Draft to ready; the user must explicitly confirm or select the Source Account.
