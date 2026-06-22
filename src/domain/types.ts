// ─── Slip lifecycle ───────────────────────────────────────────
export enum SlipLifecycleStatus {
  Discovered = "discovered",
  Parsing = "parsing",
  Parsed = "parsed",
  ParseFailed = "parse_failed",
  Skipped = "skipped",
  Synced = "synced",
}

// ─── Review state ─────────────────────────────────────────────
export enum ReviewState {
  Pending = "pending",
  NeedsReview = "needs_review",
  Ready = "ready",
  Approved = "approved",
}

// ─── Sync state ───────────────────────────────────────────────
export enum SyncState {
  Unsynced = "unsynced",
  PendingSync = "pending_sync",
  Synced = "synced",
  SyncFailed = "sync_failed",
}

// ─── Transaction type (MVP 0: expense only) ──────────────────
export enum TransactionType {
  Expense = "expense",
  // Future: Transfer = "transfer", Deposit = "deposit"
}

// ─── Currency ────────────────────────────────────────────────
export enum CurrencyCode {
  THB = "THB",
  USD = "USD",
  EUR = "EUR",
  JPY = "JPY",
  GBP = "GBP",
  SGD = "SGD",
  CNY = "CNY",
  Unknown = "UNKNOWN",
}

// ─── Parsed slip result ──────────────────────────────────────
export interface ParsedSlip {
  /** Absolute path to the original image file */
  sourcePath: string;
  /** MD5 / SHA-256 content hash for duplicate detection */
  contentHash: string;
  /** Parsed transaction date in YYYY-MM-DD format */
  date: string | null;
  /** Parsed amount in minor units (e.g. 123.45) */
  amount: number | null;
  /** ISO 4217 currency code */
  currency: CurrencyCode;
  /** Raw merchant name as extracted by the parser */
  parsedMerchant: string | null;
  /** Normalized merchant name (mapped via alias rules) */
  normalizedMerchant: string | null;
  /** Firefly destination expense account name */
  destinationAccountName: string | null;
  /** Bank-side transaction reference / identifier */
  sourceIdentifier: string | null;
}

// ─── Draft transaction awaiting review / sync ────────────────
export interface DraftTransaction {
  /** Unique local identifier */
  id: string;
  /** Reference to the source slip image path */
  slipPath: string;
  /** Content hash of the source image */
  contentHash: string;
  /** Parsed / user-confirmed transaction date */
  date: string;
  /** Transaction amount */
  amount: number;
  /** ISO 4217 currency code */
  currency: CurrencyCode;
  /** Normalized merchant name (used as Firefly destination) */
  merchant: string;
  /** Original parsed merchant text for audit */
  parsedMerchant: string;
  /** Source account identifier from slip */
  sourceIdentifier: string | null;
  /** Firefly source asset account name */
  sourceAccountName: string | null;
  /** Firefly category name */
  category: string;
  /** Review state */
  reviewState: ReviewState;
  /** Sync state */
  syncState: SyncState;
  /** Whether this draft has been flagged as duplicate-risk */
  duplicateRisk: boolean;
}
