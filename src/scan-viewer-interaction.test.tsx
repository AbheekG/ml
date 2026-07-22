// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanViewer } from "./ScanViewer";
import type { SongScan } from "./catalog";

const scan: SongScan = {
  id: "scan-1",
  mediaId: "media-1",
  notebookId: null,
  notebookName: null,
  pageLabel: null,
  revision: 2,
  rotationQuarterTurns: 0,
  hasReadabilityDerivative: true,
  filename: "page.jpg",
};

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(): void {
    this.callback([], this as unknown as ResizeObserver);
  }

  disconnect(): void {}
  unobserve(): void {}
}

function loadDisplayedScan(): HTMLImageElement {
  const image = screen.getByRole("img", { name: "Scanned page" }) as HTMLImageElement;
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1200 });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: 900 });
  fireEvent.load(image);
  return image;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(640);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Scan viewer rotation", () => {
  it("lets a viewer rotate and share the complete visible orientation without a request", async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: vi.fn(() => true),
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => { throw new Error("unexpected request"); },
    );
    vi.stubGlobal("fetch", fetcher);
    const drawImage = vi.fn();
    const translate = vi.fn();
    const rotate = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      translate,
      rotate,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
    });

    render(
      <ScanViewer
        songId="song-1"
        songTitle="Evening Song"
        scans={[scan]}
        initialScanId={scan.id}
        isOnline
        canEdit={false}
        onOrientationSaved={() => undefined}
        onClose={() => undefined}
      />,
    );
    const image = loadDisplayedScan();
    expect(screen.queryByText(scan.filename)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Rotate Scan clockwise" }));
    expect(image.style.transform).toContain("rotate(90deg)");
    expect(screen.getByRole("status").textContent).toContain("this view only");

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(fetcher).not.toHaveBeenCalled();
    expect(translate).toHaveBeenCalledWith(900, 0);
    expect(rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0);
    const sharedFile = (share.mock.calls[0][0] as ShareData).files?.[0];
    expect(sharedFile).toMatchObject({
      name: "Evening Song — Scanned Lyrics.jpg",
      type: "image/jpeg",
      size: 3,
    });
  });

  it("coalesces rapid editor turns into one absolute revision-guarded save", async () => {
    vi.useFakeTimers();
    const saved = vi.fn();
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({
        scan: { id: "scan-1", revision: 3, rotationQuarterTurns: 3 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    render(
      <StrictMode>
        <ScanViewer
          songId="song-1"
          songTitle="Evening Song"
          scans={[scan]}
          initialScanId={scan.id}
          isOnline
          canEdit
          onOrientationSaved={saved}
          onClose={() => undefined}
        />
      </StrictMode>,
    );
    const image = loadDisplayedScan();
    const rotateButton = screen.getByRole("button", { name: "Rotate Scan clockwise" });
    fireEvent.click(rotateButton);
    fireEvent.click(rotateButton);
    fireEvent.click(rotateButton);
    expect(image.style.transform).toContain("rotate(270deg)");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/songs/song-1/scans/scan-1/orientation");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      rotationQuarterTurns: 3,
      revision: 2,
    });
    expect(saved).toHaveBeenCalledWith({
      id: "scan-1",
      revision: 3,
      rotationQuarterTurns: 3,
    });
    expect(screen.getByRole("status").textContent).toBe("Orientation saved.");
  });
});
