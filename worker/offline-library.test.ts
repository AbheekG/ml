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
            content: "Lyrics",
            origin: "user",
            revision: 2,
          }] };
          if (query.includes("FROM scans")) return { results: [{
            songId: "song-1",
            id: "scan-1",
            mediaId: "scan-media-1",
            notebookId: "notebook-1",
            notebookName: "Blue notebook",
            pageLabel: "Page 12",
            revision: 3,
            rotationQuarterTurns: 2,
            hasReadabilityDerivative: 1,
            filename: "page.jpg",
          }] };
          if (query.includes("FROM recordings\n")) return { results: [{
            songId: "song-1",
            id: "recording-1",
            originalMediaId: "media-1",
            playbackMediaId: null,
            playbackByteSize: 1234,
            description: "First take",
            recordedOn: null,
            revision: 4,
            processingState: "ready",
            filename: "recording.mp3",
            hasPlaybackMedia: 0,
          }] };
          if (query.includes("FROM recording_credits")) return { results: [{
            recordingId: "recording-1",
            personId: "person-1",
            fullName: "A person",
            role: "vocals",
          }] };
          return { results: [] };
        },
      }),
    } as unknown as D1Database;

    const songs = await loadOfflineLibrary(database);

    expect(songs).toEqual([expect.objectContaining({
      id: "song-1",
      languages: [{ id: "bn", displayName: "Bengali" }],
      lyricTexts: [expect.objectContaining({ content: "Lyrics", revision: 2 })],
      scans: [expect.objectContaining({
        id: "scan-1",
        notebookId: "notebook-1",
        pageLabel: "Page 12",
        revision: 3,
        rotationQuarterTurns: 2,
        hasReadabilityDerivative: true,
      })],
      recordings: [expect.objectContaining({
        id: "recording-1",
        revision: 4,
        playbackByteSize: 1234,
        hasPlaybackMedia: false,
        credits: [expect.objectContaining({ fullName: "A person" })],
      })],
    })]);
  });
});
