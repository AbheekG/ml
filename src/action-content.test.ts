import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionContent, type ActionIconKind } from "./ActionContent";

describe("action presentation", () => {
  it.each<[ActionIconKind, string]>([
    ["view", "View"],
    ["share", "Share"],
    ["edit", "Edit"],
    ["copy", "Copy"],
    ["add", "Add"],
    ["retry", "Retry"],
    ["replace", "Replace"],
  ])("renders a decorative %s icon alongside its text label", (kind, label) => {
    const markup = renderToStaticMarkup(createElement(ActionContent, { kind, label }));

    expect(markup).toContain(`>${label}</span>`);
    expect(markup).toContain('class="action-icon"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
  });
});
