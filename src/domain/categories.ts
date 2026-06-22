/**
 * Fixed MVP category list.
 *
 * These categories are used for Firefly sync with the same names.
 * "Unknown" is the fallback when a category cannot be determined.
 */
export const FIXED_CATEGORIES = [
  "Food",
  "Coffee / Drink",
  "Convenience Store",
  "Household",
  "Transport",
  "Shopping",
  "Subscription",
  "Bill / Utility",
  "Health",
  "Entertainment",
  "Travel",
  "Other",
  "Unknown",
] as const;

export type FixedCategory = (typeof FIXED_CATEGORIES)[number];

/**
 * Ambiguous merchants that require explicit category confirmation
 * even when a remembered category suggestion exists.
 */
export const AMBIGUOUS_MERCHANTS = [
  "7-Eleven",
  "Big C",
  "Lotus's",
  "Shopee",
  "Lazada",
  "Grab",
  "Tops",
  "Makro",
  "Central",
] as const;

export type AmbiguousMerchant = (typeof AMBIGUOUS_MERCHANTS)[number];
