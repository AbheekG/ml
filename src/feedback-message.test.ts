import { describe, expect, it, vi } from "vitest";
import { revealFeedback } from "./FeedbackMessage";

describe("action feedback", () => {
  it("reveals new feedback without forcing it to the top of the viewport", () => {
    const scrollIntoView = vi.fn();
    revealFeedback({ scrollIntoView });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("does nothing before feedback is rendered", () => {
    expect(() => revealFeedback(null)).not.toThrow();
  });
});
