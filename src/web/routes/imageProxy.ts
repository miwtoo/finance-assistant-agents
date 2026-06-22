import { statSync, readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { Database } from "bun:sqlite";
import type { AppConfig } from "../../config";
import { openDatabase } from "../../db/client";
import { initSlipsTable, getSlipById } from "../../db/slips";

/**
 * MIME types for supported slip image extensions.
 * Maps lowercase extension (with dot) to Content-Type.
 */
const EXTENSION_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(EXTENSION_MIME));

/**
 * GET /slips/:id/image
 *
 * Serve the original raw slip image. Read-only — never writes to the raw folder.
 *
 * Security:
 * - Resolves the slip's sourcePath against SLIPS_RAW_DIR
 * - Verifies the resolved path is strictly inside SLIPS_RAW_DIR (path traversal guard)
 * - Only serves files with allowed image extensions
 * - Returns 404 for missing files, 400 for path traversal, 415 for bad extension
 */
export function slipImageHandler(config: AppConfig) {
  return async (context: { params: { id: string } }): Promise<Response> => {
    const slipId = Number.parseInt(context.params.id, 10);
    if (Number.isNaN(slipId) || slipId <= 0) {
      return new Response("Invalid slip ID", { status: 400 });
    }

    let db: Database | null = null;
    try {
      db = openDatabase(config.dbPath);
      initSlipsTable(db);

      const slip = getSlipById(db, slipId);
      if (!slip) {
        return new Response("Slip not found", { status: 404 });
      }

      return serveImage(config.slipsRawDir, slip.sourcePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`Image error: ${msg}`, { status: 500 });
    } finally {
      db?.close();
    }
  };
}

/**
 * Serve an image file with path traversal protection.
 * Extracted as a pure function for testability.
 */
export function serveImage(slipsRawDir: string, sourcePath: string): Response {
  // Normalize paths
  const absRawDir = resolve(slipsRawDir);
  const absPath = resolve(sourcePath);

  // Path traversal guard: resolved path must be strictly inside raw dir
  const rel = relative(absRawDir, absPath);
  if (rel.startsWith("..") || rel === "" || resolve(absRawDir, rel) !== absPath) {
    return new Response("Path is outside the allowed directory", { status: 400 });
  }

  // Extension whitelist (check before file I/O for security)
  const ext = extname(absPath).toLowerCase();
  const mimeType = EXTENSION_MIME[ext];
  if (!mimeType) {
    return new Response(
      `Unsupported image type "${ext}". Allowed: ${ALLOWED_EXTENSIONS.size} types`,
      { status: 415 },
    );
  }

  // Check file exists
  if (!existsSync(absPath)) {
    return new Response("Image file not found", { status: 404 });
  }

  // Verify it's a file (not a directory)
  try {
    const st = statSync(absPath);
    if (!st.isFile()) {
      return new Response("Not a valid image file", { status: 400 });
    }
  } catch {
    return new Response("Cannot read image file", { status: 404 });
  }

  // Read and serve the file
  try {
    const content = readFileSync(absPath);
    return new Response(content, {
      status: 200,
      headers: {
        "content-type": mimeType,
        "cache-control": "private, max-age=3600",
        "content-length": String(content.length),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Cannot read image: ${msg}`, { status: 500 });
  }
}

function extname(p: string): string {
  const idx = p.lastIndexOf(".");
  return idx >= 0 ? p.slice(idx).toLowerCase() : "";
}
