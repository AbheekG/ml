import { describe, expect, it } from "vitest";
import {
  adjacentScanId,
  clampScanView,
  clampScanZoom,
  fitScanSize,
  fittedScanView,
  nextScanRotation,
  rotatedScanSize,
  scanImageTransform,
  scanViewAfterLayoutChange,
  scanViewAfterWheel,
  scanDisplayName,
  scanPositionLabel,
  zoomScanAtPoint,
} from "./scan-viewer";

const scans = [
  { id: "one", mediaId: "m1", notebookId: "book", notebookName: "Book", pageLabel: "1", revision: 1, rotationQuarterTurns: 0 as const, hasReadabilityDerivative: true, filename: "1.jpg" },
  { id: "two", mediaId: "m2", notebookId: null, notebookName: null, pageLabel: null, revision: 1, rotationQuarterTurns: 0 as const, hasReadabilityDerivative: true, filename: "2.jpg" },
];

describe("scan viewer helpers", () => {
  it("keeps zoom within the supported range", () => {
    expect(clampScanZoom(0.5)).toBe(1);
    expect(clampScanZoom(1.75)).toBe(1.75);
    expect(clampScanZoom(4)).toBe(3);
  });

  it("navigates without wrapping past the available scans", () => {
    expect(adjacentScanId(scans, "one", 1)).toBe("two");
    expect(adjacentScanId(scans, "one", -1)).toBeNull();
    expect(adjacentScanId(scans, "two", 1)).toBeNull();
  });

  it("uses Notebook and Page when available and a clean fallback otherwise", () => {
    expect(scanDisplayName(scans[0])).toBe("Book · 1");
    expect(scanDisplayName(scans[1])).toBe("Scanned page");
    expect(scanPositionLabel(0, 1)).toBeNull();
    expect(scanPositionLabel(1, 4)).toBe("2 of 4");
    expect(scanPositionLabel(-1, 4)).toBeNull();
  });

  it("zooms relative to the fitted page instead of the full viewer width", () => {
    const viewport = { width: 1200, height: 600 };
    const fitted = fitScanSize({ width: 1000, height: 2000 }, viewport);
    const initial = fittedScanView(fitted, viewport);
    const zoomed = zoomScanAtPoint(initial, 1.25, { x: 600, y: 300 }, fitted, viewport);

    expect(fitted).toEqual({ width: 300, height: 600 });
    expect(fitted.width * zoomed.zoom).toBe(375);
    expect(fitted.height * zoomed.zoom).toBe(750);
  });

  it("centers a fitted page and constrains panning at larger zoom", () => {
    const viewport = { width: 800, height: 600 };
    const fitted = { width: 300, height: 600 };

    expect(fittedScanView(fitted, viewport)).toEqual({ zoom: 1, x: 250, y: 0 });
    expect(clampScanView({ zoom: 3, x: 500, y: -2000 }, fitted, viewport)).toEqual({
      zoom: 3,
      x: 0,
      y: -1200,
    });
  });

  it("fits a newly loaded image but preserves zoom across later viewport changes", () => {
    const fitted = { width: 300, height: 600 };
    const initialViewport = { width: 800, height: 600 };
    const resizedViewport = { width: 760, height: 560 };
    const zoomed = { zoom: 3, x: -40, y: -500 };

    expect(scanViewAfterLayoutChange(zoomed, fitted, initialViewport, true)).toEqual({
      zoom: 1,
      x: 250,
      y: 0,
    });
    expect(scanViewAfterLayoutChange(zoomed, fitted, resizedViewport, false)).toEqual({
      zoom: 3,
      x: -40,
      y: -500,
    });
  });

  it("converts browser pinch-wheel input into bounded image zoom", () => {
    const viewport = { width: 600, height: 600 };
    const fitted = { width: 200, height: 400 };
    const initial = fittedScanView(fitted, viewport);
    const zoomed = scanViewAfterWheel(initial, {
      ctrlKey: true,
      metaKey: false,
      deltaX: 0,
      deltaY: -100,
    }, { x: 300, y: 300 }, fitted, viewport);

    expect(zoomed.zoom).toBeCloseTo(Math.exp(0.4));
    expect(zoomed.x).toBeCloseTo((viewport.width - fitted.width * zoomed.zoom) / 2);
    expect(zoomed.y).toBeCloseTo((viewport.height - fitted.height * zoomed.zoom) / 2);
  });

  it("pans ordinary wheel input without changing image zoom", () => {
    const viewport = { width: 600, height: 600 };
    const fitted = { width: 400, height: 600 };
    const current = clampScanView({ zoom: 2, x: -50, y: -200 }, fitted, viewport);
    const panned = scanViewAfterWheel(current, {
      ctrlKey: false,
      metaKey: false,
      deltaX: 40,
      deltaY: 75,
    }, { x: 300, y: 300 }, fitted, viewport);

    expect(panned).toEqual({ zoom: 2, x: -90, y: -275 });
  });

  it("cycles clockwise through all four orientations", () => {
    expect(nextScanRotation(0)).toBe(1);
    expect(nextScanRotation(1)).toBe(2);
    expect(nextScanRotation(2)).toBe(3);
    expect(nextScanRotation(3)).toBe(0);
  });

  it("swaps fitted dimensions and positions each rotated image from the top-left origin", () => {
    expect(rotatedScanSize({ width: 1200, height: 900 }, 0))
      .toEqual({ width: 1200, height: 900 });
    expect(rotatedScanSize({ width: 1200, height: 900 }, 1))
      .toEqual({ width: 900, height: 1200 });
    const view = { zoom: 1, x: 10, y: 20 };
    const fitted = { width: 300, height: 400 };
    expect(scanImageTransform(view, fitted, 0))
      .toBe("translate3d(10px, 20px, 0) scale(1)");
    expect(scanImageTransform(view, fitted, 1))
      .toBe("translate3d(10px, 20px, 0) scale(1) translateX(300px) rotate(90deg)");
    expect(scanImageTransform(view, fitted, 2))
      .toBe("translate3d(10px, 20px, 0) scale(1) translate(300px, 400px) rotate(180deg)");
    expect(scanImageTransform(view, fitted, 3))
      .toBe("translate3d(10px, 20px, 0) scale(1) translateY(400px) rotate(270deg)");
  });
});
