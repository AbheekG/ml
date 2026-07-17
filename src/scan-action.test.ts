import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScanActionContent, type ScanActionKind } from "./ScanAction";

describe("Scan action presentation", () => {
  it.each<[ScanActionKind, string]>([
    ["view", "View"],
    ["share", "Share"],
    ["edit", "Edit"],
  ])("renders a decorative %s icon alongside its text label", (kind, label) => {
    const markup = renderToStaticMarkup(createElement(ScanActionContent, { kind, label }));

    expect(markup).toContain(`>${label}</span>`);
    expect(markup).toContain('class="scan-action-icon"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
  });
});
