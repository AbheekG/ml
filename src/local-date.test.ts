import { describe, expect, it } from "vitest";
import { indiaIsoDate, isoDateInTimeZone, recordingDateInputDetails } from "./local-date";

describe("shared India calendar dates", () => {
  it("formats calendar dates in an explicit timezone", () => {
    const value = new Date("2026-07-18T20:00:00.000Z");
    expect(isoDateInTimeZone(value, "Europe/Berlin")).toBe("2026-07-18");
    expect(indiaIsoDate(value)).toBe("2026-07-19");
  });

  it("does not add a note when the device and India share the same date", () => {
    expect(recordingDateInputDetails(
      new Date("2026-07-18T12:00:00.000Z"),
      "Europe/Berlin",
    )).toEqual({ maximumDate: "2026-07-18", indiaDateNote: null });
  });

  it("briefly explains the India date only when the device date differs", () => {
    expect(recordingDateInputDetails(
      new Date("2026-07-18T20:00:00.000Z"),
      "Europe/Berlin",
    )).toEqual({
      maximumDate: "2026-07-19",
      indiaDateNote: "Date in India: 19 July.",
    });
  });
});
