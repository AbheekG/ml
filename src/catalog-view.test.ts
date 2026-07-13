import { describe, expect, it } from "vitest";
import type { CatalogSong } from "./catalog";
import {
  buildCatalogFilterOptions,
  createCatalogSongIndex,
  emptyCatalogFilters,
  filterAndSortCatalog,
  matchesCatalogFilters,
  sortCatalogSongs,
} from "./catalog-view";
import type { SongDetail } from "./catalog";

function song(overrides: Partial<CatalogSong> & Pick<CatalogSong, "id" | "titleLatin">): CatalogSong {
  return {
    titleNative: null,
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    languageIds: [],
    languages: [],
    tags: [],
    credits: [],
    notebooks: [],
    lyricCount: 0,
    scanCount: 0,
    recordingCount: 0,
    ...overrides,
  };
}

const songs = [
  song({
    id: "alpha",
    titleLatin: "Alpha Song",
    titleNative: "আলফা",
    status: "checked",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
    languageIds: ["bn"],
    languages: [{ id: "bn", displayName: "Bengali" }],
    tags: [{ id: "tag-quiet", displayName: "Quiet" }],
    credits: [
      { personId: "person-a", fullName: "Person A", role: "lyrics" },
      { personId: "person-b", fullName: "Person B", role: "vocals" },
    ],
    notebooks: [{ id: "book-blue", displayName: "Blue notebook" }],
    lyricCount: 1,
    scanCount: 1,
    recordingCount: 1,
  }),
  song({
    id: "beta",
    titleLatin: "Beta Song",
    titleNative: "বেটা",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    languageIds: ["en"],
    languages: [{ id: "en", displayName: "English" }],
    tags: [{ id: "tag-loud", displayName: "Loud" }],
    credits: [{ personId: "person-a", fullName: "Person A", role: "music" }],
  }),
];

describe("catalog filters", () => {
  it("derives filter fields from complete cached Song details", () => {
    const indexed = createCatalogSongIndex({
      id: "indexed",
      titleLatin: "Indexed Song",
      titleNative: null,
      status: "checked",
      notes: null,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      aliases: [],
      languages: [{ id: "bn", displayName: "Bengali" }],
      tags: [{ id: "tag-1", displayName: "Quiet" }],
      credits: [{ personId: "person-a", fullName: "Person A", role: "lyrics" }],
      lyricTexts: [{ id: "lyrics-1", content: "Text", origin: "user", revision: 1 }],
      scans: [{
        id: "scan-1",
        mediaId: "media-1",
        notebookId: "book-1",
        notebookName: "Notebook One",
        pageLabel: "1",
        revision: 1,
        filename: "page.jpg",
      }],
      recordings: [{
        id: "recording-1",
        originalMediaId: "media-2",
        playbackMediaId: null,
        description: "Take",
        recordedOn: null,
        revision: 1,
        processingState: "ready",
        filename: "take.mp3",
        hasPlaybackMedia: false,
        credits: [{ personId: "person-b", fullName: "Person B", role: "vocals" }],
      }],
    } satisfies SongDetail);

    expect(indexed).toEqual(expect.objectContaining({
      languageIds: ["bn"],
      notebooks: [{ id: "book-1", displayName: "Notebook One" }],
      lyricCount: 1,
      scanCount: 1,
      recordingCount: 1,
    }));
    expect(indexed.credits.map((credit) => credit.role)).toEqual(["lyrics", "vocals"]);
  });

  it("composes title query with lookup, status, and media-presence filters", () => {
    const filters = {
      ...emptyCatalogFilters(),
      languageIds: ["bn"],
      tagIds: ["tag-quiet"],
      people: [{ personId: "person-a", role: "lyrics" as const }],
      notebookIds: ["book-blue"],
      statuses: ["checked"],
      hasLyrics: true,
      hasScans: true,
      hasRecordings: true,
    };

    expect(filterAndSortCatalog(songs, "alpha", filters, "latin-asc").map((item) => item.id)).toEqual(["alpha"]);
    expect(filterAndSortCatalog(songs, "beta", filters, "latin-asc")).toEqual([]);
  });

  it("matches any selected value within one category", () => {
    const filters = { ...emptyCatalogFilters(), languageIds: ["bn", "en"] };
    expect(songs.every((item) => matchesCatalogFilters(item, filters))).toBe(true);
  });

  it("correlates a selected person with the selected credit role", () => {
    const lyrics = {
      ...emptyCatalogFilters(),
      people: [{ personId: "person-a", role: "lyrics" as const }],
    };
    const music = {
      ...emptyCatalogFilters(),
      people: [{ personId: "person-a", role: "music" as const }],
    };

    expect(songs.filter((item) => matchesCatalogFilters(item, lyrics)).map((item) => item.id)).toEqual(["alpha"]);
    expect(songs.filter((item) => matchesCatalogFilters(item, music)).map((item) => item.id)).toEqual(["beta"]);
  });

  it("matches any selected Person–Role pair without separating the role", () => {
    const filters = {
      ...emptyCatalogFilters(),
      people: [
        { personId: "person-a", role: "music" as const },
        { personId: "person-b", role: "vocals" as const },
      ],
    };

    expect(songs.filter((item) => matchesCatalogFilters(item, filters)).map((item) => item.id)).toEqual(["alpha", "beta"]);
  });

  it("builds deduplicated filter choices from the local catalog", () => {
    const options = buildCatalogFilterOptions(songs);
    expect(options.languages.map((option) => option.name)).toEqual(["Bengali", "English"]);
    expect(options.people.map((option) => option.name)).toEqual(["Person A", "Person B"]);
    expect(options.statuses.map((option) => option.name)).toEqual(["Checked", "Draft"]);
  });
});

describe("catalog sorting", () => {
  const sortable = [
    song({ id: "ten", titleLatin: "Song 10", titleNative: null, createdAt: "2026-02-02", updatedAt: "2026-02-01" }),
    song({ id: "two", titleLatin: "song 2", titleNative: "Beta", createdAt: "2026-02-01", updatedAt: "2026-02-03" }),
    song({ id: "one", titleLatin: "Alpha", titleNative: "Alpha", createdAt: "2026-02-03", updatedAt: "2026-02-02" }),
  ];

  it("sorts Latin titles naturally in both directions", () => {
    expect(sortCatalogSongs(sortable, "latin-asc").map((item) => item.id)).toEqual(["one", "two", "ten"]);
    expect(sortCatalogSongs(sortable, "latin-desc").map((item) => item.id)).toEqual(["ten", "two", "one"]);
  });

  it("keeps missing native titles last in both directions", () => {
    expect(sortCatalogSongs(sortable, "native-asc").map((item) => item.id)).toEqual(["one", "two", "ten"]);
    expect(sortCatalogSongs(sortable, "native-desc").map((item) => item.id)).toEqual(["two", "one", "ten"]);
  });

  it("sorts newest timestamps first with title tie-breaking", () => {
    expect(sortCatalogSongs(sortable, "updated-desc").map((item) => item.id)).toEqual(["two", "one", "ten"]);
    expect(sortCatalogSongs(sortable, "created-desc").map((item) => item.id)).toEqual(["one", "ten", "two"]);
  });
});
