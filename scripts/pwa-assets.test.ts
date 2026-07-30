import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

type ManifestIcon = {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
};

type WebManifest = {
  id: string;
  start_url: string;
  scope: string;
  display: string;
  icons: ManifestIcon[];
};

const manifest = JSON.parse(
  readFileSync(resolve("public/manifest.webmanifest"), "utf8"),
) as WebManifest;
const indexHtml = readFileSync(resolve("index.html"), "utf8");
const appSource = readFileSync(resolve("src/App.tsx"), "utf8");
const styles = readFileSync(resolve("src/styles.css"), "utf8");
const serviceWorkerBuilder = readFileSync(
  resolve("scripts/build-service-worker.ts"),
  "utf8",
);

describe("PWA identity assets", () => {
  it("declares stable iOS and Android installation metadata", () => {
    expect(manifest).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    expect(manifest.icons).toEqual([
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ]);
    expect(indexHtml).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
    );
    expect(indexHtml).toContain(
      '<meta name="apple-mobile-web-app-title" content="Music Library" />',
    );
    expect(indexHtml).toContain(
      '<link rel="icon" type="image/svg+xml" href="/icon.svg" />',
    );
  });

  it.each([
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-192.png", 192],
    ["icon-maskable-512.png", 512],
  ])("ships an opaque square %s", async (filename, size) => {
    const metadata = await sharp(resolve("public", filename)).metadata();
    expect(metadata).toMatchObject({
      format: "png",
      width: size,
      height: size,
      hasAlpha: false,
    });
  });

  it("keeps the maskable foreground inside Android's safe circle", async () => {
    const { data, info } = await sharp(resolve("public/icon-maskable-512.png"))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const center = info.width / 2;
    const safeRadius = info.width * 0.4;
    let farthestForegroundPixel = 0;

    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        const isBackground = (
          data[offset] === 124
          && data[offset + 1] === 63
          && data[offset + 2] === 44
        );
        if (!isBackground) {
          farthestForegroundPixel = Math.max(
            farthestForegroundPixel,
            Math.hypot(x + 0.5 - center, y + 0.5 - center),
          );
        }
      }
    }

    expect(farthestForegroundPixel).toBeLessThanOrEqual(safeRadius);
  });

  it("uses the installed identity in a compact non-persistent header", () => {
    expect(appSource).toContain(
      '<img className="brand-mark" src="/icon.svg" alt="" width="32" height="32" aria-hidden="true" />',
    );
    expect(appSource).toContain(
      'isOnline ? "app-header" : "app-header app-header-offline"',
    );
    const headerStyles = styles.match(/\.app-header \{([\s\S]*?)\n\}/)?.[1];
    expect(headerStyles).toContain("position: relative");
    expect(headerStyles).toContain("min-height: 3.5rem");
    expect(headerStyles).not.toContain("position: sticky");
    const offlineHeaderStyles = styles.match(
      /\.app-header-offline \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(offlineHeaderStyles).toContain("position: sticky");
  });

  it("precaches both maskable fallbacks", () => {
    expect(serviceWorkerBuilder).toContain('"/icon-maskable-192.png"');
    expect(serviceWorkerBuilder).toContain('"/icon-maskable-512.png"');
  });
});
