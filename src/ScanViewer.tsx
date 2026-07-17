import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { SongScan } from "./catalog";
import {
  adjacentScanId,
  clampScanView,
  fitScanSize,
  MAX_SCAN_ZOOM,
  MIN_SCAN_ZOOM,
  scanViewAfterLayoutChange,
  scanViewAfterWheel,
  scanDisplayName,
  SCAN_ZOOM_STEP,
  type ScanPoint,
  type ScanSize,
  type ScanView,
  zoomScanAtPoint,
} from "./scan-viewer";

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void | Promise<void>;
};

type WebkitElement = HTMLDivElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};

type Gesture =
  | { kind: "pan"; pointerId: number; start: ScanPoint; view: ScanView }
  | { kind: "pinch"; distance: number; contentPoint: ScanPoint; zoom: number };

function pointDistance(first: ScanPoint, second: ScanPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function midpoint(first: ScanPoint, second: ScanPoint): ScanPoint {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function activeFullscreenElement(): Element | null {
  const webkitDocument = document as WebkitDocument;
  return document.fullscreenElement ?? webkitDocument.webkitFullscreenElement ?? null;
}

export function ScanViewer({
  scans,
  initialScanId,
  onClose,
}: {
  scans: SongScan[];
  initialScanId: string;
  onClose: () => void;
}) {
  const [currentScanId, setCurrentScanId] = useState(initialScanId);
  const [naturalSize, setNaturalSize] = useState<ScanSize>({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState<ScanSize>({ width: 0, height: 0 });
  const [view, setView] = useState<ScanView>({ zoom: MIN_SCAN_ZOOM, x: 0, y: 0 });
  const [loadFailed, setLoadFailed] = useState(false);
  const [isImageOnly, setIsImageOnly] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const viewRef = useRef(view);
  const fitNewImageRef = useRef(true);
  const pointersRef = useRef(new Map<number, ScanPoint>());
  const gestureRef = useRef<Gesture | null>(null);
  const currentScan = scans.find((scan) => scan.id === currentScanId) ?? scans[0];
  const previousId = currentScan ? adjacentScanId(scans, currentScan.id, -1) : null;
  const nextId = currentScan ? adjacentScanId(scans, currentScan.id, 1) : null;
  const currentIndex = currentScan ? scans.findIndex((scan) => scan.id === currentScan.id) : -1;
  const mediaUrl = currentScan ? `/api/scans/${encodeURIComponent(currentScan.id)}/image` : "";
  const originalMediaUrl = currentScan ? `/api/media/${encodeURIComponent(currentScan.mediaId)}` : "";
  const fittedSize = fitScanSize(naturalSize, viewportSize);
  const webkitDocument = typeof document !== "undefined" ? document as WebkitDocument : null;
  const fullscreenAvailable = typeof document !== "undefined" && (
    document.fullscreenEnabled
    || webkitDocument?.webkitFullscreenEnabled === true
    || "webkitRequestFullscreen" in HTMLElement.prototype
    || typeof (overlayRef.current as WebkitElement | null)?.webkitRequestFullscreen === "function"
  );

  function applyView(next: ScanView): void {
    viewRef.current = next;
    setView(next);
  }

  function stagePoint(clientX: number, clientY: number): ScanPoint {
    const bounds = stageRef.current?.getBoundingClientRect();
    return { x: clientX - (bounds?.left ?? 0), y: clientY - (bounds?.top ?? 0) };
  }

  function beginGesture(): void {
    const entries = [...pointersRef.current.entries()];
    const current = viewRef.current;
    if (entries.length === 1) {
      gestureRef.current = {
        kind: "pan",
        pointerId: entries[0][0],
        start: entries[0][1],
        view: current,
      };
      return;
    }
    if (entries.length >= 2) {
      const first = entries[0][1];
      const second = entries[1][1];
      const center = midpoint(first, second);
      gestureRef.current = {
        kind: "pinch",
        distance: Math.max(1, pointDistance(first, second)),
        contentPoint: {
          x: (center.x - current.x) / current.zoom,
          y: (center.y - current.y) / current.zoom,
        },
        zoom: current.zoom,
      };
      return;
    }
    gestureRef.current = null;
  }

  useEffect(() => {
    fitNewImageRef.current = true;
    setNaturalSize({ width: 0, height: 0 });
    setLoadFailed(false);
    pointersRef.current.clear();
    gestureRef.current = null;
  }, [currentScanId]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => setViewportSize({ width: stage.clientWidth, height: stage.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [currentScanId, isImageOnly]);

  useEffect(() => {
    if (fittedSize.width === 0 || fittedSize.height === 0) return;
    const next = scanViewAfterLayoutChange(
      viewRef.current,
      fittedSize,
      viewportSize,
      fitNewImageRef.current,
    );
    fitNewImageRef.current = false;
    viewRef.current = next;
    setView(next);
  }, [fittedSize.height, fittedSize.width, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const stage = stageRef.current;
    if (!overlay || !stage) return;
    const wheelStage = stage;

    function handleWheel(event: WheelEvent): void {
      const target = event.target;
      const isOverStage = target instanceof Node && wheelStage.contains(target);

      if (!isOverStage) {
        if (event.ctrlKey || event.metaKey) event.preventDefault();
        return;
      }

      event.preventDefault();
      applyView(scanViewAfterWheel(
        viewRef.current,
        event,
        stagePoint(event.clientX, event.clientY),
        fittedSize,
        viewportSize,
      ));
    }

    overlay.addEventListener("wheel", handleWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", handleWheel);
  }, [fittedSize.height, fittedSize.width, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (isImageOnly) closeButtonRef.current?.focus();
  }, [isImageOnly]);

  useEffect(() => {
    function keyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (!isImageOnly && event.key === "ArrowLeft" && previousId) {
        event.preventDefault();
        setCurrentScanId(previousId);
        return;
      }
      if (!isImageOnly && event.key === "ArrowRight" && nextId) {
        event.preventDefault();
        setCurrentScanId(nextId);
        return;
      }
      if (event.key !== "Tab" || !overlayRef.current) return;

      const focusable = Array.from(overlayRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", keyDown);
    return () => document.removeEventListener("keydown", keyDown);
  }, [isImageOnly, nextId, onClose, previousId]);

  if (!currentScan) return null;

  function zoomTo(nextZoom: number, focalPoint?: ScanPoint): void {
    const focal = focalPoint ?? { x: viewportSize.width / 2, y: viewportSize.height / 2 };
    applyView(zoomScanAtPoint(viewRef.current, nextZoom, focal, fittedSize, viewportSize));
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, stagePoint(event.clientX, event.clientY));
    beginGesture();
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, stagePoint(event.clientX, event.clientY));
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.kind === "pan") {
      const point = pointersRef.current.get(gesture.pointerId);
      if (!point) return;
      applyView(clampScanView({
        zoom: gesture.view.zoom,
        x: gesture.view.x + point.x - gesture.start.x,
        y: gesture.view.y + point.y - gesture.start.y,
      }, fittedSize, viewportSize));
      return;
    }

    const points = [...pointersRef.current.values()];
    if (points.length < 2) return;
    const center = midpoint(points[0], points[1]);
    const nextZoom = gesture.zoom * pointDistance(points[0], points[1]) / gesture.distance;
    const zoom = Math.min(MAX_SCAN_ZOOM, Math.max(MIN_SCAN_ZOOM, nextZoom));
    applyView(clampScanView({
      zoom,
      x: center.x - gesture.contentPoint.x * zoom,
      y: center.y - gesture.contentPoint.y * zoom,
    }, fittedSize, viewportSize));
  }

  function pointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    pointersRef.current.delete(event.pointerId);
    beginGesture();
  }

  async function enterImageOnly(): Promise<void> {
    setIsImageOnly(true);
    const element = overlayRef.current as WebkitElement | null;
    if (!element || !fullscreenAvailable) return;
    try {
      if (element.requestFullscreen) {
        await element.requestFullscreen();
      } else if (element.webkitRequestFullscreen) {
        await element.webkitRequestFullscreen();
      }
    } catch {
      // Image-only mode remains useful when a browser refuses true fullscreen.
    }
  }

  function closeViewer(): void {
    const webkitDoc = document as WebkitDocument;
    if (activeFullscreenElement() === overlayRef.current) {
      try {
        if (document.exitFullscreen) {
          void document.exitFullscreen();
        } else {
          void webkitDoc.webkitExitFullscreen?.();
        }
      } catch {
        // Closing the viewer still removes the fullscreen element.
      }
    }
    onClose();
  }

  return (
    <div
      className={`scan-viewer${isImageOnly ? " scan-viewer-image-only" : ""}`}
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-viewer-title"
      onMouseDown={(event) => {
        if (!isImageOnly && event.target === event.currentTarget) closeViewer();
      }}
    >
      <div className="scan-viewer-panel">
        {isImageOnly && <h2 className="sr-only" id="scan-viewer-title">{scanDisplayName(currentScan)}</h2>}
        {!isImageOnly && (
          <header className="scan-viewer-header">
            <div>
              <h2 id="scan-viewer-title">{scanDisplayName(currentScan)}</h2>
              <span>{scans.length > 1 ? `${currentIndex + 1} of ${scans.length} · ` : ""}{currentScan.filename}</span>
            </div>
            <button className="scan-icon-action scan-close-action" ref={closeButtonRef} type="button" onClick={closeViewer} aria-label="Close scan viewer">×</button>
          </header>
        )}

        {!isImageOnly && (
          <div className="scan-viewer-toolbar" aria-label="Scan viewing controls">
            <div>
              <button type="button" disabled={view.zoom <= MIN_SCAN_ZOOM} onClick={() => zoomTo(view.zoom - SCAN_ZOOM_STEP)} aria-label="Zoom out">−</button>
              <button type="button" onClick={() => zoomTo(MIN_SCAN_ZOOM)}>{Math.round(view.zoom * 100)}%</button>
              <button type="button" disabled={view.zoom >= MAX_SCAN_ZOOM} onClick={() => zoomTo(view.zoom + SCAN_ZOOM_STEP)} aria-label="Zoom in">+</button>
            </div>
            <div>
              <a href={originalMediaUrl} target="_blank" rel="noreferrer">Open original</a>
              <button type="button" onClick={() => { void enterImageOnly(); }} title="Hide controls and use device fullscreen when available">Image only</button>
            </div>
          </div>
        )}

        <div
          className="scan-viewer-stage"
          ref={stageRef}
          aria-busy={!loadFailed && naturalSize.width === 0}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerEnd}
          onPointerCancel={pointerEnd}
          onLostPointerCapture={pointerEnd}
        >
          {loadFailed ? (
            <div className="scan-load-error" role="alert">
              <strong>This scan could not be displayed here.</strong>
              <a href={originalMediaUrl} target="_blank" rel="noreferrer">Open the original file</a>
            </div>
          ) : (
            <>
              {naturalSize.width === 0 && (
                <div className="scan-loading" role="status">
                  <span aria-hidden="true" />
                  Loading scan…
                </div>
              )}
              <img
                src={mediaUrl}
                alt={scanDisplayName(currentScan)}
                draggable="false"
                fetchPriority="high"
                loading="eager"
                style={{
                  width: fittedSize.width,
                  height: fittedSize.height,
                  transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})`,
                }}
                onLoad={(event) => {
                  fitNewImageRef.current = true;
                  setNaturalSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  });
                }}
                onError={() => setLoadFailed(true)}
              />
            </>
          )}
        </div>

        {isImageOnly && <button className="scan-image-only-close" ref={closeButtonRef} type="button" onClick={closeViewer} aria-label="Close scan viewer">×</button>}

        {!isImageOnly && scans.length > 1 && (
          <footer className="scan-viewer-navigation">
            <button type="button" disabled={!previousId} onClick={() => previousId && setCurrentScanId(previousId)}>← Previous</button>
            <button type="button" disabled={!nextId} onClick={() => nextId && setCurrentScanId(nextId)}>Next →</button>
          </footer>
        )}
      </div>
    </div>
  );
}
