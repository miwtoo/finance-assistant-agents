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
  Parsed = "parsed",
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

/** Set of valid currency code strings (upper-case). */
export const VALID_CURRENCY_CODES: ReadonlySet<string> = new Set(
  Object.values(CurrencyCode).filter((c) => c !== "UNKNOWN"),
);

// ─── Parser run status ───────────────────────────────────────
export enum ParserRunStatus {
  Success = "success",
  Partial = "partial",
  Failed = "failed",
}

// ─── Per-field assessment from parser ────────────────────────
export interface FieldAssessment {
  /** Whether the parser considers this field uncertain */
  uncertain: boolean;
  /** Human-readable reason if uncertain */
  reason?: string;
  /** Numeric confidence 0..1 (1 = certain, 0 = completely uncertain) */
  confidence?: number;
}

// ─── Source account hint from parser ─────────────────────────
export interface SourceAccountHint {
  /** Account identifier parsed from slip (e.g. card last-4, account number) */
  identifier: string;
  /** How this identifier appeared on the slip (e.g. "X-1234", "****1234") */
  evidence: string;
  /** Where on the slip the identifier was found (e.g. "card_number", "reference") */
  source: string;
}

// ─── Parser result (immutable provider output) ───────────────
export interface ParseResult {
  /** Parsed transaction date in YYYY-MM-DD format */
  date: string | null;
  /** Parsed amount as exact decimal string (e.g. "123.45") */
  amount: string | null;
  /** ISO 4217 currency code as parsed (may be null, unrecognized, or valid) */
  currency: string | null;
  /** Raw merchant name as extracted by the parser */
  parsedMerchant: string | null;
  /** Category guess from the parser */
  parsedCategory: string | null;
  /** Bank-side transaction reference / identifier */
  sourceIdentifier: string | null;
  /** Source account hints parsed from slip with evidence */
  sourceAccountHints: SourceAccountHint[];
  /** Parser confidence assessment */
  confidence: "high" | "medium" | "low";
  /** Per-field assessment info (uncertain + optional numeric confidence) */
  assessments: Record<string, FieldAssessment>;
  /** Overall status of this parse attempt */
  status: ParserRunStatus;
  /** Raw, immutable provider response payload (JSON-serializable) */
  providerRawPayload: unknown;
}

// ─── Parsed slip result (domain-level, after validation) ─────
export interface ParsedSlip {
  /** Absolute path to the original image file */
  sourcePath: string;
  /** MD5 / SHA-256 content hash for duplicate detection */
  contentHash: string;
  /** Parsed transaction date in YYYY-MM-DD format */
  date: string | null;
  /** Parsed amount as exact decimal string (e.g. "123.45") */
  amount: string | null;
  /** ISO 4217 currency code (defaulted to THB if missing) */
  currency: CurrencyCode;
  /** Raw currency string as parsed (before defaulting/validation) */
  parsedCurrency: string | null;
  /** Raw merchant name as extracted by the parser */
  parsedMerchant: string | null;
  /** Normalized merchant name (mapped via alias rules) */
  normalizedMerchant: string | null;
  /** Firefly destination expense account name */
  destinationAccountName: string | null;
  /** Category guess from the parser */
  parsedCategory: string | null;
  /** Bank-side transaction reference / identifier */
  sourceIdentifier: string | null;
  /** Source account hints with evidence */
  sourceAccountHints: SourceAccountHint[];
  /** Whether any field has unresolved uncertainty */
  hasUncertainty: boolean;
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
  /** Transaction amount as exact decimal string */
  amount: string;
  /** ISO 4217 currency code */
  currency: CurrencyCode;
  /** Normalized merchant name (used as Firefly destination) */
  merchant: string;
  /** Original parsed merchant text for audit */
  parsedMerchant: string;
  /** Category guess from parser (may differ from user-selected category) */
  parsedCategory: string | null;
  /** Source account identifier from slip */
  sourceIdentifier: string | null;
  /** Source account hints with evidence */
  sourceAccountHints: SourceAccountHint[];
  /** Firefly source asset account name */
  sourceAccountName: string | null;
  /** Firefly source asset account ID */
  sourceAccountId: string | null;
  /** Firefly category name */
  category: string | null;
  /** Review state */
  reviewState: ReviewState;
  /** Sync state */
  syncState: SyncState;
  /** Whether this draft has been flagged as duplicate-risk */
  duplicateRisk: boolean;
  /** When the user last edited this draft (null = parser-owned) */
  userEditedAt: string | null;
}
