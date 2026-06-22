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
      // Minimal valid PNG header
      writeFileSync(join(dir, "img.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
      const res = serveImage(dir, join(dir, "img.png"));
      expect(res.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects .png with wrong magic bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-magic-png-bad-"));
    try {
      // Invalid PNG header
      writeFileSync(join(dir, "bad.png"), new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x0d, 0x0a]));
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

  it("returns cache-control header", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-cache-"));
    try {
      writeFileSync(join(dir, "photo.webp"), new Uint8Array([0x52, 0x49, 0x46, 0x46]));
      const res = serveImage(dir, join(dir, "photo.webp"));
      expect(res.headers.get("cache-control")).toContain("max-age");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── HEIC (extension-only) ──────────────────────────────────

  it("serves .heic files (extension-only, no magic check)", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-heic-"));
    try {
      writeFileSync(join(dir, "img.heic"), "fake-heic-content");
      const res = serveImage(dir, join(dir, "img.heic"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/heic");
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
