import { describe, expect, it } from "bun:test";
import {
  FIXED_CATEGORIES,
  AMBIGUOUS_MERCHANTS,
} from "../src/domain/categories";

describe("categories", () => {
  it("includes Unknown in the category list", () => {
    expect(FIXED_CATEGORIES).toContain("Unknown");
  });

  it("includes 7-Eleven in ambiguous merchants", () => {
    expect(AMBIGUOUS_MERCHANTS).toContain("7-Eleven");
  });

  it("includes Grab in ambiguous merchants", () => {
    expect(AMBIGUOUS_MERCHANTS).toContain("Grab");
  });

  it("has 13 fixed categories", () => {
    expect(FIXED_CATEGORIES.length).toBe(13);
  });

  it("has 9 ambiguous merchants", () => {
    expect(AMBIGUOUS_MERCHANTS.length).toBe(9);
  });
});
