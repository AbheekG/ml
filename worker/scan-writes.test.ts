import { describe, expect, it } from "vitest";
import { parseScanRevision, parseScanUpdate } from "./scan-writes";

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
});
