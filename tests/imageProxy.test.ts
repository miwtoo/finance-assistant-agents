import { describe, expect, it } from "bun:test";
import { serveImage } from "../src/web/routes/imageProxy";

describe("serveImage (pure function)", () => {
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

  it("returns 415 for unsupported extension", () => {
    const res = serveImage("/tmp", "/tmp/slip.txt");
    expect(res.status).toBe(415);
  });

  it("returns 415 for no extension", () => {
    const res = serveImage("/tmp", "/tmp/slipfile");
    expect(res.status).toBe(415);
  });

  it("returns 200 with correct Content-Type for .jpg", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "img-test-"));
    try {
      writeFileSync(join(dir, "test.jpg"), "fake-jpeg-data");

      const res = serveImage(dir, join(dir, "test.jpg"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 200 with correct Content-Type for .png", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "img-test-png-"));
    try {
      writeFileSync(join(dir, "receipt.png"), "fake-png-data");

      const res = serveImage(dir, join(dir, "receipt.png"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns cache-control header", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "img-test-cache-"));
    try {
      writeFileSync(join(dir, "photo.webp"), "fake-webp");
      const res = serveImage(dir, join(dir, "photo.webp"));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("max-age");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves .heic files", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "img-test-heic-"));
    try {
      writeFileSync(join(dir, "img.heic"), "fake-heic");
      const res = serveImage(dir, join(dir, "img.heic"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/heic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
