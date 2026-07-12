import { describe, expect, it } from "vitest";
import { loadOfflineLibrary } from "./offline-library";

describe("loadOfflineLibrary", () => {
  it("assembles normalized rows into complete offline song records", async () => {
    const database = {
      prepare: (query: string) => ({
        all: async () => {
          if (query.includes("FROM songs")) return { results: [{
            id: "song-1",
            titleLatin: "A song",
            titleNative: null,
            status: null,
            notes: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          }] };
          if (query.includes("FROM song_languages")) return { results: [{
            songId: "song-1", id: "bn", displayName: "Bengali",
          }] };
          if (query.includes("FROM lyric_texts")) return { results: [{
            songId: "song-1",
            id: "lyrics-1",
            languageId: "bn",
            languageName: "Bengali",
            scriptCode: null,
            representation: "original",
            label: null,
            content: "Lyrics",
          }] };
          if (query.includes("FROM recordings\n")) return { results: [{
            songId: "song-1",
            id: "recording-1",
            originalMediaId: "media-1",
            playbackMediaId: null,
            version: null,
            recordedOn: null,
            notes: null,
            filename: "recording.mp3",
            hasPlaybackMedia: 0,
          }] };
          if (query.includes("FROM recording_credits")) return { results: [{
            recordingId: "recording-1",
            personId: "person-1",
            fullName: "A person",
            role: "Singer",
            notes: null,
          }] };
          return { results: [] };
        },
      }),
    } as unknown as D1Database;

    const songs = await loadOfflineLibrary(database);

    expect(songs).toEqual([expect.objectContaining({
      id: "song-1",
      languages: [{ id: "bn", displayName: "Bengali" }],
      lyricTexts: [expect.objectContaining({ content: "Lyrics" })],
      recordings: [expect.objectContaining({
        id: "recording-1",
        hasPlaybackMedia: false,
        credits: [expect.objectContaining({ fullName: "A person" })],
      })],
    })]);
  });
});
