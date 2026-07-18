import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LookupTabs, nextLookupTabIndex } from "./LookupTabs";

describe("lookup tab semantics", () => {
  it("renders one operable tab and complete tab-to-panel relationships", () => {
    const markup = renderToStaticMarkup(createElement(LookupTabs, {
      activeKind: "tags",
      options: [
        { kind: "languages", label: "Languages", count: 3 },
        { kind: "tags", label: "Tags", count: 8 },
      ],
      onSelect: () => undefined,
    }));

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('id="lookup-tab-languages"');
    expect(markup).toContain('aria-controls="lookup-panel-languages"');
    expect(markup).toContain('aria-selected="false" tabindex="-1"');
    expect(markup).toContain('id="lookup-tab-tags"');
    expect(markup).toContain('aria-controls="lookup-panel-tags"');
    expect(markup).toContain('aria-selected="true" tabindex="0"');
  });

  it("supports horizontal arrow, Home, and End movement with wrapping", () => {
    expect(nextLookupTabIndex("ArrowRight", 3, 4)).toBe(0);
    expect(nextLookupTabIndex("ArrowLeft", 0, 4)).toBe(3);
    expect(nextLookupTabIndex("Home", 2, 4)).toBe(0);
    expect(nextLookupTabIndex("End", 1, 4)).toBe(3);
    expect(nextLookupTabIndex("Enter", 1, 4)).toBeNull();
  });
});
