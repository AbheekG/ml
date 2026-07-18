import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("src/styles.css"), "utf8");

function hexColor(variable: string): string {
  const match = styles.match(new RegExp(`--${variable}:\\s*(#[0-9a-f]{6});`, "iu"));
  if (!match) throw new Error(`Missing CSS color token --${variable}`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(left: string, right: string): number {
  const luminances = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

describe("responsive action styles", () => {
  it("keeps compact mobile actions at a 44-pixel target while hiding only visible text", () => {
    expect(styles).toMatch(/@media \(max-width: 37rem\)[\s\S]*?\.compact-action \{[\s\S]*?width: 2\.75rem;[\s\S]*?height: 2\.75rem;/u);
    expect(styles).toMatch(/\.compact-action \.action-label \{\s*display: none;/u);
    expect(styles).toMatch(/\.compact-action \.action-icon \{[\s\S]*?width: 1\.15rem;[\s\S]*?height: 1\.15rem;/u);
  });

  it("keeps focus indicators and interactive boundaries above 3:1 on every light surface", () => {
    const focusRing = hexColor("focus-ring");
    const controlLine = hexColor("control-line");
    const surfaces = ["#ffffff", hexColor("paper"), "#f5efe4"];

    for (const surface of surfaces) {
      expect(contrastRatio(focusRing, surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(controlLine, surface)).toBeGreaterThanOrEqual(3);
    }
    expect(styles).toMatch(/button:focus-visible,[\s\S]*?outline: 3px solid var\(--focus-ring\);/u);
    expect(styles).toMatch(/\.search-field:focus-within,[\s\S]*?outline: 3px solid var\(--focus-ring\);/u);
    expect(styles).toMatch(/\.form-field input,[\s\S]*?border: 1px solid var\(--control-line\);/u);
  });
});
