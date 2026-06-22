import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

/** Accepted image file extensions (case-insensitive). */
const ACCEPTED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
]);

export interface SlipCandidate {
  /** Absolute path to the original image file */
  sourcePath: string;
  /** SHA-256 hex content hash for duplicate detection (null if file unreadable) */
  contentHash: string | null;
  /** File modification timestamp (null if unreadable) */
  mtime: Date | null;
  /** Human-readable error description if file could not be fully processed */
  error?: string;
}

export interface ScanOptions {
  /** Only include files with mtime >= this date (inclusive) */
  startDate?: Date;
  /** Only include files with mtime <= this date (inclusive) */
  endDate?: Date;
}

/**
 * Recursively scan `dirPath` for eligible slip image files.
 * Returns discovered candidates with content hash and mtime.
 * Never writes to or modifies the scanned directory.
 *
 * Unreadable files are still included with contentHash=null and an error message,
 * satisfying the acceptance criterion that missing metadata does not skip the image.
 */
export async function discoverSlipCandidates(
  dirPath: string,
  options?: ScanOptions,
): Promise<SlipCandidate[]> {
  const candidates: SlipCandidate[] = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      if (!ACCEPTED_EXTENSIONS.has(ext)) continue;

      let mtime: Date | null = null;
      try {
        const stat = statSync(fullPath);
        mtime = stat.mtime;
      } catch {
        // Missing or unreadable metadata — still include the slip (per AC)
      }

      // Date range filter (skip if mtime is null — include it when no metadata)
      if (options && mtime !== null) {
        if (options.startDate && mtime < options.startDate) continue;
        if (options.endDate && mtime > options.endDate) continue;
      }

      let contentHash: string | null = null;
      let error: string | undefined;

      try {
        const content = readFileSync(fullPath);
        contentHash = createHash("sha256").update(content).digest("hex");
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        // Include with null hash — file is still visible for review
      }

      candidates.push({ sourcePath: fullPath, contentHash, mtime, error });
    }
  }

  return candidates;
}
