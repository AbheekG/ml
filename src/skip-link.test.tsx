// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SkipLink } from "./SkipLink";

afterEach(cleanup);

describe("SkipLink", () => {
  it("focuses the main landmark without changing the URL fragment", async () => {
    const user = userEvent.setup();
    render(<><SkipLink /><main id="main-content">Content</main></>);

    await user.click(screen.getByRole("link", { name: "Skip to content" }));

    const main = screen.getByRole("main");
    expect(document.activeElement).toBe(main);
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(window.location.hash).toBe("");
  });
});
