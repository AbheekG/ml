import { describe, expect, it } from "vitest";
import {
  latestCurrentCalendarDate,
  parseRecordingRevision,
  parseRecordingUpdate,
} from "./recording-writes";

describe("Recording validation", () => {
  it("trims descriptions without rewriting their internal content", () => {
    expect(parseRecordingUpdate({
      description: "  Verse old version\n\nDifferent tune  ",
      recordedOn: "2020-02-29",
      creditPersonIds: ["person-1"],
      revision: 2,
    })).toEqual({
      success: true,
      data: {
        description: "Verse old version\n\nDifferent tune",
        normalizedDescription: "verse old version different tune",
        recordedOn: "2020-02-29",
        creditPersonIds: ["person-1"],
        revision: 2,
      },
    });
  });

  it("allows an absent date and contributors", () => {
    expect(parseRecordingUpdate({
      description: "Recording 1",
      recordedOn: null,
      creditPersonIds: [],
      revision: 1,
    })).toMatchObject({
      success: true,
      data: { recordedOn: null, creditPersonIds: [] },
    });
  });

  it("rejects blank descriptions, impossible dates, future dates, and duplicate contributors", () => {
    expect(parseRecordingUpdate({
      description: "   ", recordedOn: null, creditPersonIds: [], revision: 1,
    })).toMatchObject({ success: false, fields: { description: expect.any(Array) } });
    expect(parseRecordingUpdate({
      description: "Take", recordedOn: "2023-02-29", creditPersonIds: [], revision: 1,
    })).toMatchObject({ success: false, fields: { recordedOn: ["Use a valid date"] } });
    expect(parseRecordingUpdate({
      description: "Take", recordedOn: "2999-01-01", creditPersonIds: [], revision: 1,
    })).toMatchObject({ success: false, fields: { recordedOn: ["Recorded date cannot be in the future"] } });
    expect(parseRecordingUpdate({
      description: "Take", recordedOn: null, creditPersonIds: ["p1", "p1"], revision: 1,
    })).toMatchObject({ success: false, fields: { creditPersonIds: ["Duplicate contributors are not allowed"] } });
  });

  it("accepts a local current date after UTC midnight boundaries but rejects the next global day", () => {
    const now = new Date("2026-07-18T12:30:00.000Z");
    expect(latestCurrentCalendarDate(now)).toBe("2026-07-19");
    expect(parseRecordingUpdate({
      description: "Take",
      recordedOn: "2026-07-19",
      creditPersonIds: [],
      revision: 1,
    }, now).success).toBe(true);
    expect(parseRecordingUpdate({
      description: "Take",
      recordedOn: "2026-07-20",
      creditPersonIds: [],
      revision: 1,
    }, now)).toMatchObject({
      success: false,
      fields: { recordedOn: ["Recorded date cannot be in the future"] },
    });
  });

  it("requires a positive revision for Trash-state changes", () => {
    expect(parseRecordingRevision({ revision: 2 })).toEqual({ success: true, data: { revision: 2 } });
    expect(parseRecordingRevision({ revision: 0 })).toMatchObject({ success: false });
  });
});
