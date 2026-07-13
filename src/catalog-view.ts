import type { CatalogSong, Credit, SongDetail } from "./catalog";
import {
  buildCatalogSearchFields,
  normalizeCatalogSearchText,
  scoreCatalogSearch,
} from "./catalog-search";

export const CATALOG_SORTS = [
  "latin-asc",
  "latin-desc",
  "native-asc",
  "native-desc",
  "updated-desc",
  "created-desc",
] as const;

export type CatalogSort = typeof CATALOG_SORTS[number];
export type CatalogCreditRole = "any" | "lyrics" | "music" | "vocals";
export type CatalogPersonFilter = {
  personId: string;
  role: CatalogCreditRole;
};

export type CatalogFilters = {
  languageIds: string[];
  tagIds: string[];
  people: CatalogPersonFilter[];
  notebookIds: string[];
  statuses: string[];
  hasLyrics: boolean;
  hasScans: boolean;
  hasRecordings: boolean;
};

export type CatalogFilterOption = {
  id: string;
  name: string;
};

export type CatalogFilterOptions = {
  languages: CatalogFilterOption[];
  tags: CatalogFilterOption[];
  people: CatalogFilterOption[];
  notebooks: CatalogFilterOption[];
  statuses: CatalogFilterOption[];
};

export function emptyCatalogFilters(): CatalogFilters {
  return {
    languageIds: [],
    tagIds: [],
    people: [],
    notebookIds: [],
    statuses: [],
    hasLyrics: false,
    hasScans: false,
    hasRecordings: false,
  };
}

export function createCatalogSongIndex(song: SongDetail): CatalogSong {
  const credits = new Map<string, Credit>();
  for (const credit of [
    ...song.credits,
    ...song.recordings.flatMap((recording) => recording.credits),
  ]) {
    credits.set(`${credit.personId}:${credit.role}`, credit);
  }

  const notebooks = new Map<string, { id: string; displayName: string }>();
  for (const scan of song.scans) {
    if (scan.notebookId && scan.notebookName) {
      notebooks.set(scan.notebookId, { id: scan.notebookId, displayName: scan.notebookName });
    }
  }

  const indexedCredits = [...credits.values()];
  const indexedNotebooks = [...notebooks.values()];
  const searchFields = buildCatalogSearchFields({
    titles: [song.titleLatin, song.titleNative],
    aliases: song.aliases,
    lyrics: song.lyricTexts.map((lyricText) => lyricText.content),
    metadata: [
      ...song.languages.map((language) => language.displayName),
      ...song.tags.map((tag) => tag.displayName),
      ...indexedCredits.flatMap((credit) => [credit.fullName, credit.role]),
      ...indexedNotebooks.map((notebook) => notebook.displayName),
      ...song.recordings.map((recording) => recording.description),
    ],
  });

  return {
    id: song.id,
    titleLatin: song.titleLatin,
    titleNative: song.titleNative,
    status: song.status,
    createdAt: song.createdAt,
    updatedAt: song.updatedAt,
    languageIds: song.languages.map((language) => language.id),
    languages: song.languages,
    tags: song.tags,
    credits: indexedCredits,
    notebooks: indexedNotebooks,
    searchFields,
    lyricCount: song.lyricTexts.length,
    scanCount: song.scans.length,
    recordingCount: song.recordings.length,
  };
}

const titleCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function selectedValueMatches(values: string[], selectedValues: string[]): boolean {
  return selectedValues.length === 0 || selectedValues.some((selected) => values.includes(selected));
}

export function matchesCatalogFilters(song: CatalogSong, filters: CatalogFilters): boolean {
  if (!selectedValueMatches(song.languages.map((language) => language.id), filters.languageIds)) return false;
  if (!selectedValueMatches(song.tags.map((tag) => tag.id), filters.tagIds)) return false;
  if (!selectedValueMatches(song.notebooks.map((notebook) => notebook.id), filters.notebookIds)) return false;
  if (!selectedValueMatches(song.status ? [song.status] : [], filters.statuses)) return false;

  if (filters.people.length > 0 && !filters.people.some((personFilter) => (
    song.credits.some((credit) => (
      credit.personId === personFilter.personId
      && (personFilter.role === "any" || credit.role === personFilter.role)
    ))
  ))) return false;

  if (filters.hasLyrics && song.lyricCount === 0) return false;
  if (filters.hasScans && song.scanCount === 0) return false;
  if (filters.hasRecordings && song.recordingCount === 0) return false;
  return true;
}

export function matchesCatalogQuery(song: CatalogSong, query: string): boolean {
  return scoreCatalogSearch(song.searchFields, query) !== null;
}

function compareLatinTitles(left: CatalogSong, right: CatalogSong, direction: 1 | -1): number {
  return direction * titleCollator.compare(left.titleLatin, right.titleLatin)
    || titleCollator.compare(left.id, right.id);
}

function compareNativeTitles(left: CatalogSong, right: CatalogSong, direction: 1 | -1): number {
  if (left.titleNative === null && right.titleNative === null) return compareLatinTitles(left, right, 1);
  if (left.titleNative === null) return 1;
  if (right.titleNative === null) return -1;
  return direction * titleCollator.compare(left.titleNative, right.titleNative)
    || compareLatinTitles(left, right, 1);
}

export function sortCatalogSongs(songs: CatalogSong[], sort: CatalogSort): CatalogSong[] {
  return [...songs].sort((left, right) => {
    if (sort === "latin-asc") return compareLatinTitles(left, right, 1);
    if (sort === "latin-desc") return compareLatinTitles(left, right, -1);
    if (sort === "native-asc") return compareNativeTitles(left, right, 1);
    if (sort === "native-desc") return compareNativeTitles(left, right, -1);
    if (sort === "updated-desc") {
      return right.updatedAt.localeCompare(left.updatedAt) || compareLatinTitles(left, right, 1);
    }
    return right.createdAt.localeCompare(left.createdAt) || compareLatinTitles(left, right, 1);
  });
}

export function filterAndSortCatalog(
  songs: CatalogSong[],
  query: string,
  filters: CatalogFilters,
  sort: CatalogSort,
): CatalogSong[] {
  const filtered = songs.filter((song) => matchesCatalogFilters(song, filters));
  const normalizedQuery = normalizeCatalogSearchText(query);
  if (!normalizedQuery) return sortCatalogSongs(filtered, sort);

  const sortedBySelectedOption = sortCatalogSongs(filtered, sort);
  const selectedSortOrder = new Map(sortedBySelectedOption.map((song, index) => [song.id, index]));
  return filtered
    .map((song) => ({ song, score: scoreCatalogSearch(song.searchFields, normalizedQuery) }))
    .filter((result): result is { song: CatalogSong; score: number } => result.score !== null)
    .sort((left, right) => (
      right.score - left.score
      || (selectedSortOrder.get(left.song.id) ?? 0) - (selectedSortOrder.get(right.song.id) ?? 0)
    ))
    .map((result) => result.song);
}

function sortedOptions(values: CatalogFilterOption[]): CatalogFilterOption[] {
  const byId = new Map(values.map((value) => [value.id, value]));
  return [...byId.values()].sort((left, right) => titleCollator.compare(left.name, right.name));
}

function statusLabel(status: string): string {
  return status.length > 0 ? `${status[0].toLocaleUpperCase()}${status.slice(1)}` : status;
}

export function buildCatalogFilterOptions(songs: CatalogSong[]): CatalogFilterOptions {
  return {
    languages: sortedOptions(songs.flatMap((song) => (
      song.languages.map((language) => ({ id: language.id, name: language.displayName }))
    ))),
    tags: sortedOptions(songs.flatMap((song) => (
      song.tags.map((tag) => ({ id: tag.id, name: tag.displayName }))
    ))),
    people: sortedOptions(songs.flatMap((song) => (
      song.credits.map((credit) => ({ id: credit.personId, name: credit.fullName }))
    ))),
    notebooks: sortedOptions(songs.flatMap((song) => (
      song.notebooks.map((notebook) => ({ id: notebook.id, name: notebook.displayName }))
    ))),
    statuses: sortedOptions(songs.flatMap((song) => (
      song.status ? [{ id: song.status, name: statusLabel(song.status) }] : []
    ))),
  };
}

export function activeCatalogFilterCount(filters: CatalogFilters): number {
  return filters.languageIds.length
    + filters.tagIds.length
    + filters.people.length
    + filters.notebookIds.length
    + filters.statuses.length
    + Number(filters.hasLyrics)
    + Number(filters.hasScans)
    + Number(filters.hasRecordings);
}
