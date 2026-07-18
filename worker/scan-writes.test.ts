import { describe, expect, it } from "vitest";
import {
  parseScanCreate,
  parseScanOrientation,
  parseScanRevision,
  parseScanUpdate,
} from "./scan-writes";

describe("Scan validation", () => {
  it("normalizes optional Notebook and Page values", () => {
    expect(parseScanUpdate({
      notebookId: " notebook-1 ",
      pageLabel: "  12A   verso ",
      revision: 2,
    })).toEqual({
      success: true,
      data: { notebookId: "notebook-1", pageLabel: "12A verso", revision: 2 },
    });
  });

  it("allows an external Scan without Notebook or Page", () => {
    expect(parseScanUpdate({ notebookId: null, pageLabel: null, revision: 1 })).toEqual({
      success: true,
      data: { notebookId: null, pageLabel: null, revision: 1 },
    });
  });

  it("validates create metadata without requiring a revision", () => {
    expect(parseScanCreate({ notebookId: " notebook-1 ", pageLabel: " cover " })).toEqual({
      success: true,
      data: { notebookId: "notebook-1", pageLabel: "cover" },
    });
  });

  it("rejects a Page without a Notebook", () => {
    expect(parseScanUpdate({ notebookId: null, pageLabel: "4", revision: 1 })).toEqual({
      success: false,
      fields: { pageLabel: ["Select a Notebook before adding a Page"] },
    });
  });

  it("requires only a positive revision for Trash-state changes", () => {
    expect(parseScanRevision({ revision: 2 })).toEqual({
      success: true,
      data: { revision: 2 },
    });
    expect(parseScanRevision({ revision: 0 })).toMatchObject({ success: false });
  });

  it("accepts only absolute quarter-turn orientation values", () => {
    expect(parseScanOrientation({ rotationQuarterTurns: 3, revision: 2 })).toEqual({
      success: true,
      data: { rotationQuarterTurns: 3, revision: 2 },
    });
    expect(parseScanOrientation({ rotationQuarterTurns: 4, revision: 2 }))
      .toMatchObject({ success: false });
    expect(parseScanOrientation({ rotationQuarterTurns: 1, revision: 0 }))
      .toMatchObject({ success: false });
    expect(parseScanOrientation({ rotationQuarterTurns: 1, revision: 2, extra: true }))
      .toMatchObject({ success: false });
  });
});
