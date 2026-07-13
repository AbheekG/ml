import { describe, expect, it } from "vitest";
import { shouldOfferDirectCameraCapture } from "./device-capabilities";

describe("direct camera capture offer", () => {
  it("is offered on Android and iPhone", () => {
    expect(shouldOfferDirectCameraCapture("Mozilla/5.0 (Linux; Android 16)", 5)).toBe(true);
    expect(shouldOfferDirectCameraCapture("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0)", 5)).toBe(true);
  });

  it("recognizes iPadOS desktop-style identification through touch capability", () => {
    expect(shouldOfferDirectCameraCapture("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", 5)).toBe(true);
  });

  it("does not present the unreliable capture input on laptops", () => {
    expect(shouldOfferDirectCameraCapture("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)", 0)).toBe(false);
    expect(shouldOfferDirectCameraCapture("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0)).toBe(false);
  });
});
