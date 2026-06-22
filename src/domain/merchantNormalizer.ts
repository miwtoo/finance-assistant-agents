/**
 * Normalize a parsed merchant name.
 *
 * Currently a pass-through — returns the input unchanged.
 * In future, applies alias rules: exact match first, then contains match.
 * If no alias matches, parsed merchant is used directly as normalized merchant.
 *
 * Category memory and merchant aliases attach to the normalized merchant,
 * not to the raw parsed text.
 */
export function normalizeMerchant(parsedMerchant: string): string {
  // MVP 0: pass-through. Alias rules added later.
  return parsedMerchant.trim();
}
