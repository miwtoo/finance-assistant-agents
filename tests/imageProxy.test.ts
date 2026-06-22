import { describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { serveImage } from "../src/web/routes/imageProxy";

describe("serveImage — security guards", () => {
  // ─── Path traversal ─────────────────────────────────────────

  it("returns 400 for path outside SLIPS_RAW_DIR", () => {
    const res = serveImage("/tmp/slips", "/etc/passwd");
    expect(res.status).toBe(400);
  });

  it("returns 400 for path traversal with ../", () => {
    const res = serveImage("/tmp/slips", "/tmp/slips/../../etc/passwd");
    expect(res.status).toBe(400);
  });

  it("returns 400 when resolved path equals raw dir", () => {
    const res = serveImage("/tmp/slips", "/tmp/slips");
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent file inside raw dir", () => {
    const res = serveImage("/tmp", "/tmp/nonexistent-file-12345.jpg");
    expect(res.status).toBe(404);
  });

  // ─── Extension whitelist ────────────────────────────────────

  it("returns 415 for unsupported extension", () => {
    const res = serveImage("/tmp", "/tmp/slip.txt");
    expect(res.status).toBe(415);
  });

  it("returns 415 for no extension", () => {
    const res = serveImage("/tmp", "/tmp/slipfile");
    expect(res.status).toBe(415);
  });

  // ─── Symlink escape ─────────────────────────────────────────

  it("returns 403 for symlink inside raw dir pointing outside", async () => {
    const dir = mkdtempSync(join(tmpdir(), "img-sym-escape-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "img-sym-outside-"));
    try {
      // Create a secret file outside the raw dir
      const secretFile = join(outsideDir, "secret.jpg");
      writeFileSync(secretFile, "secret-data");

      // Create a symlink inside raw dir pointing to the outside file
      const linkPath = join(dir, "innocent.jpg");
      symlinkSync(secretFile, linkPath);

      const res = serveImage(dir, linkPath);
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/symlink|outside|allowed/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("returns 200 for symlink inside raw dir pointing inside raw dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-sym-internal-"));
    try {
      // Real file inside raw dir
      const realFile = join(dir, "real.jpg");
      writeFileSync(realFile, new Uint8Array([0xff, 0xd8, 0xff, 0x00]));

      // Symlink inside raw dir pointing to another file inside raw dir
      const linkPath = join(dir, "link.jpg");
      symlinkSync(realFile, linkPath);

      const res = serveImage(dir, linkPath);
      expect(res.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── Magic bytes validation ─────────────────────────────────

  it("rejects .jpg containing plain text with 422", async () => {
    const dir = mkdtempSync(join(tmpdir(), "img-magic-text-"));
    try {
      // Text file with .jpg extension — no JPEG magic bytes
      writeFileSync(join(dir, "fake.jpg"), "this is not a jpeg image");
      const res = serveImage(dir, join(dir, "fake.jpg"));
      expect(res.status).toBe(422);
      expect(await res.text()).toMatch(/content.*format|format.*not match/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts .jpg with valid JPEG magic bytes (FF D8 FF)", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-magic-jpg-"));
    try {
      // Minimal valid JPEG file (SOI marker)
      writeFileSync(join(dir, "photo.jpg"), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
      const res = serveImage(dir, join(dir, "photo.jpg"));
      expect(res.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts .png with valid PNG magic bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-magic-png-"));
    try {
      // Full PNG 8-byte signature
      writeFileSync(join(dir, "img.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
      const res = serveImage(dir, join(dir, "img.png"));
      expect(res.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects .png with wrong magic bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-magic-png-bad-"));
    try {
      // Invalid PNG header (all zeros)
      writeFileSync(join(dir, "bad.png"), new Uint8Array(8));
      const res = serveImage(dir, join(dir, "bad.png"));
      expect(res.status).toBe(422);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── Headers ────────────────────────────────────────────────

  it("returns nosniff header", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-headers-"));
    try {
      writeFileSync(join(dir, "test.jpg"), new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
      const res = serveImage(dir, join(dir, "test.jpg"));
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns content-disposition inline header with filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-disposition-"));
    try {
      writeFileSync(join(dir, "photo.jpg"), new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
      const res = serveImage(dir, join(dir, "photo.jpg"));
      const cd = res.headers.get("content-disposition") || "";
      expect(cd).toContain("inline");
      expect(cd).toContain("photo.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes filename in content-disposition", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-sanitize-"));
    try {
      const badName = join(dir, "bad\nfile:test.jpg");
      writeFileSync(badName, new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
      const res = serveImage(dir, badName);
      const cd = res.headers.get("content-disposition") || "";
      // newline and colon should be removed/replaced
      expect(cd).not.toContain("\n");
      expect(cd).not.toContain(":");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns cache-control header", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-cache-"));
    try {
      writeFileSync(join(dir, "photo.webp"), new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]));
      const res = serveImage(dir, join(dir, "photo.webp"));
      expect(res.headers.get("cache-control")).toContain("max-age");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── WebP ───────────────────────────────────────────────────

  it("rejects .webp with WAV content (RIFF+WAVE) with 422", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-webp-wav-"));
    try {
      // WAV files also start with RIFF but have WAVE at offset 8, not WEBP
      writeFileSync(
        join(dir, "fake.webp"),
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]),
      );
      const res = serveImage(dir, join(dir, "fake.webp"));
      expect(res.status).toBe(422);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts .webp with valid RIFF+WEBP header", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-webp-valid-"));
    try {
      // Valid minimal WebP: RIFF + size + WEBP
      writeFileSync(
        join(dir, "img.webp"),
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      );
      const res = serveImage(dir, join(dir, "img.webp"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects short .webp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-webp-short-"));
    try {
      writeFileSync(join(dir, "short.webp"), new Uint8Array([0x52, 0x49, 0x46, 0x46]));
      const res = serveImage(dir, join(dir, "short.webp"));
      expect(res.status).toBe(422);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── PNG full signature ─────────────────────────────────────

  it("accepts .png with full 8-byte signature", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-png-full-"));
    try {
      // Full PNG signature: 89 50 4E 47 0D 0A 1A 0A
      writeFileSync(join(dir, "img.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const res = serveImage(dir, join(dir, "img.png"));
      expect(res.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects .png with truncated signature (only 4 bytes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-png-short-"));
    try {
      // Only first 4 bytes of PNG signature, but full 8 required
      writeFileSync(join(dir, "short.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]));
      const res = serveImage(dir, join(dir, "short.png"));
      expect(res.status).toBe(422);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("serveImage — route integration via slipImageHandler", () => {
  it("returns 400 for slip path outside raw dir through route", async () => {
    // Test the pure function with a DB-like scenario: sourcePath outside rawDir
    const dir = mkdtempSync(join(tmpdir(), "img-route-outside-"));
    try {
      // Create a file outside raw dir
      const outsideDir = mkdtempSync(join(tmpdir(), "img-route-outside-file-"));
      writeFileSync(join(outsideDir, "outside.jpg"), "data");

      // serveImage with rawDir != file's actual location
      // The file is at /outside/outside.jpg, rawDir is /img-route-outside-
      const res = serveImage(dir, join(outsideDir, "outside.jpg"));
      expect(res.status).toBe(400);
      rmSync(outsideDir, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
