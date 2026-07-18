import { describe, expect, it } from "vitest";
import { localIsoDate } from "./local-date";

describe("local calendar dates", () => {
  it("formats the device-local date rather than slicing the UTC timestamp", () => {
    const localLateEvening = new Date(2026, 0, 2, 23, 45, 0);
    expect(localIsoDate(localLateEvening)).toBe("2026-01-02");
  });

  it("pads one-digit months and days", () => {
    expect(localIsoDate(new Date(2024, 1, 9, 12, 0, 0))).toBe("2024-02-09");
  });
});
