import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("src/styles.css"), "utf8");

describe("responsive action styles", () => {
  it("keeps compact mobile actions at a 44-pixel target while hiding only visible text", () => {
    expect(styles).toMatch(/@media \(max-width: 37rem\)[\s\S]*?\.compact-action \{[\s\S]*?width: 2\.75rem;[\s\S]*?height: 2\.75rem;/u);
    expect(styles).toMatch(/\.compact-action \.action-label \{\s*display: none;/u);
    expect(styles).toMatch(/\.compact-action \.action-icon \{[\s\S]*?width: 1\.15rem;[\s\S]*?height: 1\.15rem;/u);
  });
});
