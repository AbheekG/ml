// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Link,
  RouterProvider,
  createMemoryRouter,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  UnsavedChangesProvider,
  editorLoadStatus,
  editorValuesChanged,
  shouldRefreshEditor,
  useUnsavedChanges,
} from "./UnsavedChanges";

afterEach(cleanup);

function EditorFixture() {
  const [value, setValue] = useState("");
  const navigate = useNavigate();
  const { allowNextNavigation } = useUnsavedChanges(value !== "");
  return (
    <main>
      <label>Notes<input value={value} onChange={(event) => setValue(event.target.value)} /></label>
      <Link to="/next">Next screen</Link>
      <button type="button" onClick={() => {
        allowNextNavigation();
        navigate("/next");
      }}>Save and leave</button>
    </main>
  );
}

function RouteFixture() {
  const location = useLocation();
  return location.pathname === "/next" ? <h1>Next</h1> : <EditorFixture />;
}

function renderFixture() {
  const router = createMemoryRouter([
    {
      path: "*",
      element: (
        <UnsavedChangesProvider>
          <RouteFixture />
        </UnsavedChangesProvider>
      ),
    },
  ], { initialEntries: ["/edit"] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("unsaved editor navigation", () => {
  it("keeps dirty work after Stay and leaves only after explicit discard", async () => {
    const user = userEvent.setup();
    const router = renderFixture();
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "draft");
    await user.click(screen.getByRole("link", { name: "Next screen" }));

    const dialog = screen.getByRole("alertdialog", { name: "Discard unsaved changes?" });
    expect(router.state.location.pathname).toBe("/edit");
    expect(screen.getByRole("button", { name: "Stay here" })).toBe(document.activeElement);
    expect(document.body.style.overflow).toBe("hidden");

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Discard and leave" })).toBe(document.activeElement);
    await user.tab();
    expect(screen.getByRole("button", { name: "Stay here" })).toBe(document.activeElement);

    await user.click(screen.getByRole("button", { name: "Stay here" }));
    expect(dialog.isConnected).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveProperty("value", "draft");

    await user.click(screen.getByRole("link", { name: "Next screen" }));
    await user.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByRole("heading", { name: "Next" })).toBeTruthy();
  });

  it("allows successful saves to navigate without showing a discard dialog", async () => {
    const user = userEvent.setup();
    const router = renderFixture();
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "saved");
    await user.click(screen.getByRole("button", { name: "Save and leave" }));

    expect(router.state.location.pathname).toBe("/next");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("prevents browser unload while registered work is dirty", async () => {
    const user = userEvent.setup();
    renderFixture();
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "draft");

    const event = new Event("beforeunload", { bubbles: false, cancelable: true });
    expect(window.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("editor value comparisons", () => {
  it("treats only initialized value changes as dirty", () => {
    expect(editorValuesChanged(null, { value: "draft" })).toBe(false);
    expect(editorValuesChanged({ value: "same" }, { value: "same" })).toBe(false);
    expect(editorValuesChanged({ value: "before" }, { value: "after" })).toBe(true);
  });

  it("refreshes clean or newly selected editors but preserves a dirty loaded editor", () => {
    expect(shouldRefreshEditor("song:1", "song:1", true)).toBe(false);
    expect(shouldRefreshEditor("song:1", "song:1", false)).toBe(true);
    expect(shouldRefreshEditor("song:1", "song:2", true)).toBe(true);
    expect(shouldRefreshEditor(null, "song:1", false)).toBe(true);
  });

  it("never treats editor data loaded for a previous route as current", () => {
    expect(editorLoadStatus("edit:song-1", null, "edit:song-2", false)).toBe("loading");
    expect(editorLoadStatus("edit:song-1", "edit:song-2", "edit:song-2", false)).toBe("failed");
    expect(editorLoadStatus("edit:song-2", null, "edit:song-2", false)).toBe("ready");
    expect(editorLoadStatus("edit:song-2", null, "edit:song-2", true)).toBe("loading");
  });
});
