import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  chmodSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSlipCandidates } from "../src/domain/slipScanner";

function collectPaths(dir: string): string[] {
  const entries: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const items = readdirSync(current, { withFileTypes: true });
    for (const item of items) {
      const full = join(current, item.name);
      if (item.isDirectory()) stack.push(full);
      else entries.push(full);
    }
  }
  return entries.sort();
}

describe("discoverSlipCandidates", () => {
  let tmpDir: string;
  let subDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "slip-test-"));
    subDir = join(tmpDir, "nested");
    mkdirSync(subDir, { recursive: true });

    writeFileSync(join(tmpDir, "receipt.jpg"), "jpg-content");
    writeFileSync(join(tmpDir, "bill.png"), "png-content");
    writeFileSync(join(tmpDir, "photo.webp"), "webp-content");
    writeFileSync(join(tmpDir, "image.jpeg"), "jpeg-content");
    writeFileSync(join(tmpDir, "snap.HEIC"), "heic-content");
    writeFileSync(join(tmpDir, "shot.heif"), "heif-content");
    writeFileSync(join(tmpDir, "note.txt"), "not-an-image");
    writeFileSync(join(subDir, "deep.heic"), "deep-heic-content");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers image files recursively by accepted extensions", async () => {
    const slips = await discoverSlipCandidates(tmpDir);
    const paths = slips.map((s) => s.sourcePath);

    expect(paths).toContain(join(tmpDir, "receipt.jpg"));
    expect(paths).toContain(join(tmpDir, "bill.png"));
    expect(paths).toContain(join(tmpDir, "photo.webp"));
    expect(paths).toContain(join(tmpDir, "image.jpeg"));
    expect(paths).toContain(join(tmpDir, "snap.HEIC"));
    expect(paths).toContain(join(tmpDir, "shot.heif"));
    expect(paths).toContain(join(subDir, "deep.heic"));
    expect(paths).not.toContain(join(tmpDir, "note.txt"));
  });

  it("computes a consistent SHA-256 content hash for each slip", async () => {
    const slips = await discoverSlipCandidates(tmpDir);
    const receipt = slips.find((s) => s.sourcePath.endsWith("receipt.jpg"));
    expect(receipt).toBeDefined();
    expect(receipt!.contentHash).toBeTruthy();
    expect(typeof receipt!.contentHash).toBe("string");
    expect(receipt!.contentHash!.length).toBe(64);
  });

  it("same content produces identical hash across files", async () => {
    writeFileSync(join(tmpDir, "duplicate-a.jpg"), "same-content");
    writeFileSync(join(tmpDir, "duplicate-b.jpg"), "same-content");
    try {
      const slips = await discoverSlipCandidates(tmpDir);
      const a = slips.find((s) => s.sourcePath.endsWith("duplicate-a.jpg"));
      const b = slips.find((s) => s.sourcePath.endsWith("duplicate-b.jpg"));
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a!.contentHash).toBeTruthy();
      expect(b!.contentHash).toBeTruthy();
      expect(a!.contentHash).toBe(b!.contentHash);
    } finally {
      rmSync(join(tmpDir, "duplicate-a.jpg"));
      rmSync(join(tmpDir, "duplicate-b.jpg"));
    }
  });

  it("returns mtime for each slip", async () => {
    const slips = await discoverSlipCandidates(tmpDir);
    for (const slip of slips) {
      expect(slip.mtime).toBeInstanceOf(Date);
    }
  });

  it("sets contentHash to null and includes error for unreadable files", async () => {
    const unreadable = join(tmpDir, "corrupted.jpg");
    writeFileSync(unreadable, "readable-content-then-we-change-perms");
    chmodSync(unreadable, 0o000);
    try {
      const slips = await discoverSlipCandidates(tmpDir);
      const found = slips.find((s) => s.sourcePath === unreadable);
      expect(found).toBeDefined();
      expect(found!.contentHash).toBeNull();
      expect(found!.error).toBeDefined();
      expect(found!.mtime).toBeInstanceOf(Date);
    } finally {
      chmodSync(unreadable, 0o644);
      rmSync(unreadable);
    }
  });

  it("includes file at startDate boundary (inclusive)", async () => {
    const f = join(tmpDir, "boundary-start.jpg");
    writeFileSync(f, "bs");
    const boundary = new Date("2025-06-01T00:00:00Z");
    utimesSync(f, boundary, boundary);
    try {
      const slips = await discoverSlipCandidates(tmpDir, { startDate: boundary });
      expect(slips.find((s) => s.sourcePath === f)).toBeDefined();
    } finally {
      rmSync(f);
    }
  });

  it("includes file at endDate boundary (inclusive)", async () => {
    const f = join(tmpDir, "boundary-end.jpg");
    writeFileSync(f, "be");
    const boundary = new Date("2025-06-01T00:00:00Z");
    utimesSync(f, boundary, boundary);
    try {
      const slips = await discoverSlipCandidates(tmpDir, { endDate: boundary });
      expect(slips.find((s) => s.sourcePath === f)).toBeDefined();
    } finally {
      rmSync(f);
    }
  });

  it("excludes file just before startDate", async () => {
    const f = join(tmpDir, "before-start.jpg");
    writeFileSync(f, "bf");
    const boundary = new Date("2025-06-01T00:00:00Z");
    const justBefore = new Date(boundary.getTime() - 1000);
    utimesSync(f, justBefore, justBefore);
    try {
      const slips = await discoverSlipCandidates(tmpDir, { startDate: boundary });
      expect(slips.find((s) => s.sourcePath === f)).toBeUndefined();
    } finally {
      rmSync(f);
    }
  });

  it("excludes file just after endDate", async () => {
    const f = join(tmpDir, "after-end.jpg");
    writeFileSync(f, "af");
    const boundary = new Date("2025-06-01T00:00:00Z");
    const justAfter = new Date(boundary.getTime() + 1000);
    utimesSync(f, justAfter, justAfter);
    try {
      const slips = await discoverSlipCandidates(tmpDir, { endDate: boundary });
      expect(slips.find((s) => s.sourcePath === f)).toBeUndefined();
    } finally {
      rmSync(f);
    }
  });

  it("does not modify the source directory (read-only)", async () => {
    const before = collectPaths(tmpDir);
    await discoverSlipCandidates(tmpDir);
    const after = collectPaths(tmpDir);
    expect(after).toEqual(before);
  });
});
