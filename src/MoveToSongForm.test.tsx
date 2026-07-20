// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { filterSongDestinations, MoveToSongForm } from "./MoveToSongForm";

const songs = [
  { id: "song-1", titleLatin: "Alpha", titleNative: null },
  { id: "song-2", titleLatin: "Evening Song", titleNative: "সন্ধ্যা" },
  { id: "song-3", titleLatin: "Morning Song", titleNative: null },
];

describe("MoveToSongForm", () => {
  it("searches Latin and native titles while excluding the current parent", () => {
    expect(filterSongDestinations(songs, "song-1", "song").map((song) => song.id)).toEqual([
      "song-2", "song-3",
    ]);
    expect(filterSongDestinations(songs, "song-1", "সন্ধ্যা").map((song) => song.id)).toEqual([
      "song-2",
    ]);
    expect(filterSongDestinations(songs, "song-2", "evening")).toEqual([]);
  });

  it("requires an explicit result selection before moving", () => {
    const onMove = vi.fn();
    render(<MoveToSongForm songs={songs} sourceSongId="song-1" busy={false} onCancel={() => undefined} onMove={onMove} />);
    const move = screen.getByRole("button", { name: "Move here" });
    expect(move.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "evening" } });
    fireEvent.click(screen.getByRole("button", { name: /Evening Song/u }));
    expect(move.hasAttribute("disabled")).toBe(false);
    fireEvent.click(move);
    expect(onMove).toHaveBeenCalledWith(songs[1]);
  });
});
