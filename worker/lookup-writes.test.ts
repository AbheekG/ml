import { describe, expect, it } from "vitest";
import { parseLookupCreate, parseLookupKind, parseLookupUpdate } from "./lookup-writes";

describe("controlled lookup validation", () => {
  it("accepts only supported lookup kinds", () => {
    expect(parseLookupKind("languages")).toBe("languages");
    expect(parseLookupKind("songs")).toBeNull();
  });

  it("normalizes whitespace while preserving intentional capitalization", () => {
    expect(parseLookupCreate({ name: "  A. R.   Rahman " })).toEqual({
      success: true,
      data: { name: "A. R. Rahman", normalizedName: "a. r. rahman" },
    });
  });

  it("requires the previously loaded name for optimistic renames", () => {
    expect(parseLookupUpdate({ name: "New name", currentName: "Old name" })).toEqual({
      success: true,
      data: { name: "New name", normalizedName: "new name", currentName: "Old name" },
    });
    expect(parseLookupUpdate({ name: "New name" })).toMatchObject({ success: false });
  });

  it("rejects blank and unexpected fields", () => {
    expect(parseLookupCreate({ name: "   " })).toMatchObject({ success: false });
    expect(parseLookupCreate({ name: "Valid", id: "chosen-by-client" })).toMatchObject({ success: false });
  });
});
