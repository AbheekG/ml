import type { SongScan } from "./catalog";

export const MIN_SCAN_ZOOM = 1;
export const MAX_SCAN_ZOOM = 3;
export const SCAN_ZOOM_STEP = 0.25;

export type ScanSize = { width: number; height: number };
export type ScanPoint = { x: number; y: number };
export type ScanView = { zoom: number; x: number; y: number };
export type ScanWheelInput = {
  ctrlKey: boolean;
  deltaX: number;
  deltaY: number;
  metaKey: boolean;
};

export function clampScanZoom(value: number): number {
  return Math.min(MAX_SCAN_ZOOM, Math.max(MIN_SCAN_ZOOM, value));
}

export function adjacentScanId(
  scans: SongScan[],
  currentId: string,
  direction: -1 | 1,
): string | null {
  const index = scans.findIndex((scan) => scan.id === currentId);
  const next = index + direction;
  return index >= 0 && next >= 0 && next < scans.length ? scans[next].id : null;
}

export function scanDisplayName(scan: SongScan): string {
  return [scan.notebookName, scan.pageLabel].filter(Boolean).join(" · ") || "Scanned page";
}

export function fitScanSize(natural: ScanSize, viewport: ScanSize): ScanSize {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(
    1,
    viewport.width / natural.width,
    viewport.height / natural.height,
  );
  return { width: natural.width * scale, height: natural.height * scale };
}

function axisPosition(value: number, viewport: number, content: number): number {
  if (content <= viewport) return (viewport - content) / 2;
  return Math.min(0, Math.max(viewport - content, value));
}

export function clampScanView(
  view: ScanView,
  fitted: ScanSize,
  viewport: ScanSize,
): ScanView {
  const zoom = clampScanZoom(view.zoom);
  return {
    zoom,
    x: axisPosition(view.x, viewport.width, fitted.width * zoom),
    y: axisPosition(view.y, viewport.height, fitted.height * zoom),
  };
}

export function fittedScanView(fitted: ScanSize, viewport: ScanSize): ScanView {
  return clampScanView({ zoom: MIN_SCAN_ZOOM, x: 0, y: 0 }, fitted, viewport);
}

export function zoomScanAtPoint(
  current: ScanView,
  nextZoom: number,
  focalPoint: ScanPoint,
  fitted: ScanSize,
  viewport: ScanSize,
): ScanView {
  const zoom = clampScanZoom(nextZoom);
  const ratio = zoom / current.zoom;
  return clampScanView({
    zoom,
    x: focalPoint.x - (focalPoint.x - current.x) * ratio,
    y: focalPoint.y - (focalPoint.y - current.y) * ratio,
  }, fitted, viewport);
}

export function scanViewAfterWheel(
  current: ScanView,
  input: ScanWheelInput,
  focalPoint: ScanPoint,
  fitted: ScanSize,
  viewport: ScanSize,
): ScanView {
  if (input.ctrlKey || input.metaKey) {
    return zoomScanAtPoint(
      current,
      current.zoom * Math.exp(-input.deltaY * 0.004),
      focalPoint,
      fitted,
      viewport,
    );
  }

  return clampScanView({
    ...current,
    x: current.x - input.deltaX,
    y: current.y - input.deltaY,
  }, fitted, viewport);
}
