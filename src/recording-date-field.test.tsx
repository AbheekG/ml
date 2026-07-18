import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordingDateField } from "./RecordingDateField";

describe("Recording date field", () => {
  it("uses the India cutoff without permanent helper text", () => {
    const markup = renderToStaticMarkup(createElement(RecordingDateField, {
      value: "",
      onChange: () => undefined,
      currentTime: new Date("2026-07-18T12:00:00.000Z"),
      deviceTimeZone: "Europe/Berlin",
    }));
    expect(markup).toContain('max="2026-07-18"');
    expect(markup).not.toContain("Date in India");
  });

  it("shows the compact India-date note at a differing local boundary", () => {
    const markup = renderToStaticMarkup(createElement(RecordingDateField, {
      value: "",
      onChange: () => undefined,
      currentTime: new Date("2026-07-18T20:00:00.000Z"),
      deviceTimeZone: "Europe/Berlin",
    }));
    expect(markup).toContain('max="2026-07-19"');
    expect(markup).toContain("Date in India: 19 July.");
  });
});
