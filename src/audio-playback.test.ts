import { describe, expect, it, vi } from "vitest";
import { pauseOtherAudioPlayers } from "./audio-playback";

describe("Recording playback coordination", () => {
  it("pauses every other registered player without interrupting the one that started", () => {
    const first = { pause: vi.fn() };
    const current = { pause: vi.fn() };
    const third = { pause: vi.fn() };

    expect(pauseOtherAudioPlayers(current, [first, current, third])).toBe(2);
    expect(first.pause).toHaveBeenCalledOnce();
    expect(current.pause).not.toHaveBeenCalled();
    expect(third.pause).toHaveBeenCalledOnce();
  });

  it("is a no-op when only the current player is registered", () => {
    const current = { pause: vi.fn() };
    expect(pauseOtherAudioPlayers(current, [current])).toBe(0);
    expect(current.pause).not.toHaveBeenCalled();
  });
});
