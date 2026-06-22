import { statSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, relative, basename } from "node:path";
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
 * Minimum magic bytes validation for formats that have well-known signatures.
 * HEIC/HEIF support is extension-only (no magic check) due to format complexity.
 *
 * For simple prefix checks: expects file to start with these bytes.
 * WebP uses custom logic: RIFF at 0-3 + WEBP at 8-11.
 */
const MAGIC_BYTES: Record<string, Uint8Array> = {
  ".jpg": new Uint8Array([0xff, 0xd8, 0xff]),
  ".jpeg": new Uint8Array([0xff, 0xd8, 0xff]),
  ".png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // full PNG signature
};

/**
 * Validate magic bytes of file content.
 * Returns true if the file's first bytes match the expected signature for the extension.
 * HEIC/HEIF skip magic validation (extension-only).
 *
 * WebP requires: bytes 0-3 = RIFF, bytes 8-11 = WEBP.
 */
function validateMagicBytes(filePath: string, ext: string, content: Buffer): boolean {
  // WebP custom validation
  if (ext === ".webp") {
    if (content.length < 12) return false;
    // Bytes 0-3: RIFF
    if (content[0] !== 0x52 || content[1] !== 0x49 || content[2] !== 0x46 || content[3] !== 0x46) return false;
    // Bytes 8-11: WEBP
    if (content[8] !== 0x57 || content[9] !== 0x45 || content[10] !== 0x42 || content[11] !== 0x50) return false;
    return true;
  }

  // Simple prefix check for other formats with known magic
  const expected = MAGIC_BYTES[ext];
  if (!expected) return true; // HEIC/HEIF — extension-only, skip magic check
  if (content.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (content[i] !== expected[i]) return false;
  }
  return true;
}

/**
 * GET /slips/:id/image
 *
 * Serve the original raw slip image. Read-only — never writes to the raw folder.
 *
 * Security:
 * - Resolves the slip's sourcePath against SLIPS_RAW_DIR
 * - Verifies the resolved path is strictly inside SLIPS_RAW_DIR (path traversal guard)
 * - Resolves symlinks and verifies real path is inside raw dir's real path
 * - Only serves files with allowed image extensions
 * - Validates magic bytes for jpg/jpeg/png/webp
 * - Sets X-Content-Type-Options: nosniff
 * - Returns 404 for missing files, 400 for path traversal, 415 for bad extension,
 *   403 for symlink escape, 422 for content-type mismatch
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
 * Serve an image file with path traversal and symlink protection.
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

  // Check file exists before symlink resolution
  if (!existsSync(absPath)) {
    return new Response("Image file not found", { status: 404 });
  }

  // Symlink escape guard: resolve symlinks and verify real path is inside raw dir
  let realPath: string;
  let rawDirReal: string;
  try {
    realPath = realpathSync(absPath);
    rawDirReal = realpathSync(absRawDir);
  } catch {
    return new Response("Cannot resolve file path", { status: 400 });
  }

  const realRel = relative(rawDirReal, realPath);
  if (realRel.startsWith("..") || realRel === "" || resolve(rawDirReal, realRel) !== realPath) {
    return new Response("Symlink target is outside the allowed directory", { status: 403 });
  }

  // Verify it's a file (not a directory)
  try {
    const st = statSync(realPath);
    if (!st.isFile()) {
      return new Response("Not a valid image file", { status: 400 });
    }
  } catch {
    return new Response("Cannot read image file", { status: 404 });
  }

  // Read and validate the file
  try {
    const content = readFileSync(realPath);

    // Magic bytes validation (skip for HEIC/HEIF — extension-only)
    if (!validateMagicBytes(realPath, ext, content)) {
      return new Response(
        `File content does not match expected format for "${ext}"`,
        { status: 422 },
      );
    }

    const fileName = sanitizeFilename(basename(sourcePath));
    return new Response(content, {
      status: 200,
      headers: {
        "content-type": mimeType,
        "cache-control": "private, max-age=3600",
        "content-length": String(content.length),
        "x-content-type-options": "nosniff",
        "content-disposition": `inline; filename="${fileName}"`,
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

/** Sanitize a filename for use in Content-Disposition header.
 *  Removes newlines, control chars, and path separators. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f/\\:"]/g, "_");
}
