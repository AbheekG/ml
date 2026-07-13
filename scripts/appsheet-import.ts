import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import readXlsxFile, { type SheetData } from "read-excel-file/node";

const LEGACY_ACTOR = "legacy-import";

const EXPECTED_COLUMNS = {
  Songs: [
    "SongID", "TitleLatin", "TitleNative", "Aliases", "Languages", "Tags",
    "LyricsTyped", "Status", "Notes", "SearchKey", "CreatedAt", "UpdatedAt", "CreatedBy",
  ],
  Scans: [
    "ScanID", "SongID", "File", "Version", "Date", "Source", "Notebook",
    "Page", "ScanText", "Notes", "CreatedAt", "CreatedBy",
  ],
  Recordings: [
    "RecID", "SongID", "File", "Version", "Date", "Notes", "CreatedAt", "CreatedBy",
  ],
  People: ["PersonID", "FullName"],
  SongCredits: ["CreditID", "SongID", "PersonID", "Role", "Notes"],
  RecordingCredits: ["RecCreditID", "RecID", "PersonID", "Role", "Notes"],
  Tags: ["TagID", "DisplayName"],
  Languages: ["LangID", "DisplayName"],
  Notebooks: ["NotebookID", "DisplayName"],
} as const;

const LANGUAGE_ID_NORMALIZATIONS: Readonly<Record<string, string>> = {
  BN: "bn",
};

const NOTEBOOK_ID_NORMALIZATIONS: Readonly<Record<string, string>> = {
  O1: "o1",
};

const BCP47_BY_LEGACY_ID: Readonly<Record<string, string>> = {
  as: "as",
  bn: "bn",
  bodo: "brx",
  en: "en",
  hn: "hi",
  ma: "mr",
  od: "or",
  sn: "sa",
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".aac": "audio/aac",
  ".amr": "audio/amr",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".wav": "audio/wav",
};

type RowRecord = Record<string, unknown>;

type ImportOptions = {
  workbookPath: string;
  mediaRoot: string;
  outputDirectory: string;
  writeOutput: boolean;
};

type ImportIssue = {
  category: string;
  message: string;
};

type NormalizedCatalog = {
  schemaVersion: 2;
  generatedAt: string;
  source: { workbook: string; mediaRoot: string };
  languages: Array<Record<string, unknown>>;
  tags: Array<Record<string, unknown>>;
  notebooks: Array<Record<string, unknown>>;
  people: Array<Record<string, unknown>>;
  songs: Array<Record<string, unknown>>;
  songAliases: Array<Record<string, unknown>>;
  songLanguages: Array<Record<string, unknown>>;
  songTags: Array<Record<string, unknown>>;
  songCredits: Array<Record<string, unknown>>;
  lyricTexts: Array<Record<string, unknown>>;
  mediaObjects: Array<Record<string, unknown>>;
  scans: Array<Record<string, unknown>>;
  recordings: Array<Record<string, unknown>>;
  recordingCredits: Array<Record<string, unknown>>;
};

type ImportReport = {
  generatedAt: string;
  mode: "dry-run" | "write";
  source: { workbook: string; mediaRoot: string };
  sheetRows: Record<string, number>;
  outputRows: Record<string, number>;
  normalizations: {
    languageIds: number;
    notebookIds: number;
    legacyCombinedLyrics: number;
  };
  media: {
    referenced: number;
    missing: number;
    unreferenced: number;
    bytes: number;
    extensions: Record<string, number>;
  };
  ignoredOperationalRows: Record<string, number>;
  errors: ImportIssue[];
  warnings: ImportIssue[];
};

export function splitReferences(value: unknown): string[] {
  return optionalText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeLanguageId(value: string): string {
  return LANGUAGE_ID_NORMALIZATIONS[value] ?? value;
}

export function normalizeNotebookId(value: string): string {
  return NOTEBOOK_ID_NORMALIZATIONS[value] ?? value;
}

export function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

export function createLegacyLyricText(song: RowRecord): Record<string, unknown> | null {
  const content = preserveText(song.LyricsTyped);

  if (!content) {
    return null;
  }

  const songId = requiredText(song.SongID, "Songs.SongID");
  const createdAt = isoText(song.CreatedAt) ?? new Date(0).toISOString();
  const updatedAt = isoText(song.UpdatedAt) ?? createdAt;
  const actor = optionalText(song.CreatedBy) || LEGACY_ACTOR;

  return {
    id: `lyrics:${songId}:legacy`,
    songId,
    content,
    origin: "legacy_import",
    sortOrder: 0,
    revision: 1,
    createdAt,
    createdBy: actor,
    updatedAt,
    updatedBy: actor,
    trashedAt: null,
    trashedBy: null,
  };
}

function preserveText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function optionalText(value: unknown): string {
  return preserveText(value).trim();
}

function requiredText(value: unknown, field: string): string {
  const text = optionalText(value);

  if (!text) {
    throw new Error(`${field} is required`);
  }

  return text;
}

function songCreditRole(value: unknown): "lyrics" | "music" {
  const role = requiredText(value, "SongCredits.Role");
  if (role === "Writer" || role === "Lyricist" || role === "Lyrics") return "lyrics";
  if (role === "Composer" || role === "Music") return "music";
  throw new Error(`Unsupported Song credit role: ${role}`);
}

function recordingCreditRole(value: unknown): string {
  const role = requiredText(value, "RecordingCredits.Role");
  if (role === "Singer" || role === "Vocals") return "vocals";
  return normalizedName(role);
}

function isoText(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const text = optionalText(value);
  return text || null;
}

function safeIdPart(value: string): string {
  return encodeURIComponent(value);
}

function sheetToRecords(name: string, data: SheetData): RowRecord[] {
  if (data.length === 0) {
    return [];
  }

  const headers = data[0].map((cell) => optionalText(cell));
  const expected = EXPECTED_COLUMNS[name as keyof typeof EXPECTED_COLUMNS];

  if (expected) {
    const missing = expected.filter((column) => !headers.includes(column));
    if (missing.length > 0) {
      throw new Error(`${name} is missing columns: ${missing.join(", ")}`);
    }
  }

  return data.slice(1)
    .filter((row) => row.some((cell) => cell !== null && cell !== ""))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null])));
}

function findDuplicates(rows: RowRecord[], field: string): string[] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const value = optionalText(row[field]);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

function addDuplicateIssues(
  issues: ImportIssue[],
  sheetRows: Record<string, RowRecord[]>,
): void {
  const keys: Readonly<Record<string, string>> = {
    Songs: "SongID",
    Scans: "ScanID",
    Recordings: "RecID",
    People: "PersonID",
    SongCredits: "CreditID",
    RecordingCredits: "RecCreditID",
    Tags: "TagID",
    Languages: "LangID",
    Notebooks: "NotebookID",
  };

  for (const [sheet, field] of Object.entries(keys)) {
    const duplicates = findDuplicates(sheetRows[sheet] ?? [], field);
    for (const value of duplicates) {
      issues.push({ category: "duplicate_key", message: `${sheet}.${field}: ${value}` });
    }
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const output: string[] = [];

  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }

  await visit(directory);
  return output;
}

function relativeObjectKey(mediaRoot: string, path: string): string {
  return relative(mediaRoot, path).split(sep).join("/");
}

function mimeFor(path: string): string | null {
  return MIME_BY_EXTENSION[extname(path).toLocaleLowerCase("en")] ?? null;
}

function asDateOnly(value: unknown): string | null {
  const iso = isoText(value);
  return iso?.slice(0, 10) ?? null;
}

function parseOptions(arguments_: string[]): ImportOptions {
  const options: ImportOptions = {
    workbookPath: "appsheet/data.xlsx",
    mediaRoot: "appsheet",
    outputDirectory: "data/import-output",
    writeOutput: false,
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];

    if (argument === "--write") options.writeOutput = true;
    else if (argument === "--workbook" && next) {
      options.workbookPath = next;
      index += 1;
    } else if (argument === "--media-root" && next) {
      options.mediaRoot = next;
      index += 1;
    } else if (argument === "--output" && next) {
      options.outputDirectory = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }

  options.workbookPath = resolve(options.workbookPath);
  options.mediaRoot = resolve(options.mediaRoot);
  options.outputDirectory = resolve(options.outputDirectory);
  return options;
}

export async function importAppSheet(options: ImportOptions): Promise<{
  catalog: NormalizedCatalog;
  report: ImportReport;
}> {
  const generatedAt = new Date().toISOString();
  const workbookSheets = await readXlsxFile(options.workbookPath);
  const sheetRows = Object.fromEntries(
    workbookSheets.map(({ sheet, data }) => [sheet, sheetToRecords(sheet, data)]),
  );
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  addDuplicateIssues(errors, sheetRows);

  const songs = sheetRows.Songs ?? [];
  const scans = sheetRows.Scans ?? [];
  const recordings = sheetRows.Recordings ?? [];
  const people = sheetRows.People ?? [];
  const songCredits = sheetRows.SongCredits ?? [];
  const recordingCredits = sheetRows.RecordingCredits ?? [];
  const languages = sheetRows.Languages ?? [];
  const tags = sheetRows.Tags ?? [];
  const notebooks = sheetRows.Notebooks ?? [];

  const songIds = new Set(songs.map((row) => requiredText(row.SongID, "Songs.SongID")));
  const recordingIds = new Set(recordings.map((row) => requiredText(row.RecID, "Recordings.RecID")));
  const personIds = new Set(people.map((row) => requiredText(row.PersonID, "People.PersonID")));
  const languageIds = new Set(languages.map((row) => requiredText(row.LangID, "Languages.LangID")));
  const tagIds = new Set(tags.map((row) => requiredText(row.TagID, "Tags.TagID")));
  const notebookIds = new Set(notebooks.map((row) => requiredText(row.NotebookID, "Notebooks.NotebookID")));

  const orphan = (category: string, id: string) => errors.push({ category, message: id });

  for (const row of scans) {
    const id = requiredText(row.ScanID, "Scans.ScanID");
    if (!songIds.has(requiredText(row.SongID, "Scans.SongID"))) orphan("orphan_scan_song", id);
  }
  for (const row of recordings) {
    const id = requiredText(row.RecID, "Recordings.RecID");
    if (!songIds.has(requiredText(row.SongID, "Recordings.SongID"))) orphan("orphan_recording_song", id);
  }
  for (const row of songCredits) {
    const id = requiredText(row.CreditID, "SongCredits.CreditID");
    if (!songIds.has(requiredText(row.SongID, "SongCredits.SongID"))) orphan("orphan_song_credit_song", id);
    if (!personIds.has(requiredText(row.PersonID, "SongCredits.PersonID"))) orphan("orphan_song_credit_person", id);
  }
  for (const row of recordingCredits) {
    const id = requiredText(row.RecCreditID, "RecordingCredits.RecCreditID");
    if (!recordingIds.has(requiredText(row.RecID, "RecordingCredits.RecID"))) orphan("orphan_recording_credit_recording", id);
    if (!personIds.has(requiredText(row.PersonID, "RecordingCredits.PersonID"))) orphan("orphan_recording_credit_person", id);
  }

  let languageNormalizationCount = 0;
  let notebookNormalizationCount = 0;
  const songLanguageRows: Array<Record<string, unknown>> = [];
  const songTagRows: Array<Record<string, unknown>> = [];
  const songAliasRows: Array<Record<string, unknown>> = [];

  for (const song of songs) {
    const songId = requiredText(song.SongID, "Songs.SongID");
    for (const [sortOrder, rawId] of splitReferences(song.Languages).entries()) {
      const languageId = normalizeLanguageId(rawId);
      if (languageId !== rawId) languageNormalizationCount += 1;
      if (!languageIds.has(languageId)) orphan("invalid_song_language", `${songId}:${rawId}`);
      songLanguageRows.push({ songId, languageId, sortOrder });
    }
    for (const [sortOrder, tagId] of splitReferences(song.Tags).entries()) {
      if (!tagIds.has(tagId)) orphan("invalid_song_tag", `${songId}:${tagId}`);
      songTagRows.push({ songId, tagId, sortOrder });
    }
    for (const [sortOrder, alias] of splitReferences(song.Aliases).entries()) {
      songAliasRows.push({
        id: `alias:${songId}:${sortOrder + 1}`,
        songId,
        alias,
        normalizedAlias: normalizedName(alias),
        sortOrder,
      });
    }
  }

  const mediaObjects: Array<Record<string, unknown>> = [];
  const normalizedScans: Array<Record<string, unknown>> = [];
  const normalizedRecordings: Array<Record<string, unknown>> = [];
  const recordingNumberBySong = new Map<string, number>();
  const referencedKeys = new Set<string>();
  const extensionCounts = new Map<string, number>();
  let referencedBytes = 0;

  async function mediaFromReference(
    id: string,
    fileReference: unknown,
    kind: "scan" | "original_audio",
    actor: string,
    createdAt: string,
  ): Promise<Record<string, unknown>> {
    const objectKey = requiredText(fileReference, `${kind}.File`).replaceAll("\\", "/");
    const absolutePath = resolve(options.mediaRoot, objectKey);
    const relativePath = relative(options.mediaRoot, absolutePath);

    if (relativePath.startsWith("..") || relativePath === "") {
      throw new Error(`Unsafe media path: ${objectKey}`);
    }

    let fileSize = 0;
    try {
      fileSize = (await stat(absolutePath)).size;
      referencedBytes += fileSize;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        errors.push({ category: "missing_media", message: objectKey });
      } else {
        throw error;
      }
    }

    const extension = extname(objectKey).toLocaleLowerCase("en") || "(none)";
    extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
    referencedKeys.add(objectKey);

    const media = {
      id,
      objectKey,
      originalFilename: basename(objectKey),
      mimeType: mimeFor(objectKey),
      byteSize: fileSize,
      sha256: null,
      kind,
      state: "active",
      createdAt,
      createdBy: actor,
      trashedAt: null,
      trashedBy: null,
    };
    mediaObjects.push(media);
    return media;
  }

  for (const row of scans) {
    const id = requiredText(row.ScanID, "Scans.ScanID");
    const songId = requiredText(row.SongID, "Scans.SongID");
    const createdAt = isoText(row.CreatedAt) ?? new Date(0).toISOString();
    const actor = optionalText(row.CreatedBy) || LEGACY_ACTOR;
    const mediaId = `media:scan:${id}`;
    await mediaFromReference(mediaId, row.File, "scan", actor, createdAt);

    const rawNotebookId = optionalText(row.Notebook);
    const notebookId = rawNotebookId ? normalizeNotebookId(rawNotebookId) : null;
    if (notebookId !== rawNotebookId && rawNotebookId) notebookNormalizationCount += 1;
    if (notebookId && !notebookIds.has(notebookId)) orphan("invalid_scan_notebook", `${id}:${rawNotebookId}`);

    normalizedScans.push({
      id,
      songId,
      mediaId,
      notebookId,
      pageLabel: optionalText(row.Page) || null,
      legacyVersion: optionalText(row.Version) || null,
      legacyCapturedOn: asDateOnly(row.Date),
      legacySource: requiredText(row.Source, "Scans.Source"),
      legacyScanText: preserveText(row.ScanText) || null,
      legacyNotes: preserveText(row.Notes) || null,
      revision: 1,
      createdAt,
      createdBy: actor,
      updatedAt: createdAt,
      updatedBy: actor,
      trashedAt: null,
      trashedBy: null,
    });
  }

  for (const row of recordings) {
    const id = requiredText(row.RecID, "Recordings.RecID");
    const songId = requiredText(row.SongID, "Recordings.SongID");
    const createdAt = isoText(row.CreatedAt) ?? new Date(0).toISOString();
    const actor = optionalText(row.CreatedBy) || LEGACY_ACTOR;
    const mediaId = `media:recording:${id}:original`;
    const media = await mediaFromReference(mediaId, row.File, "original_audio", actor, createdAt);
    const playbackMediaId = media.mimeType === "audio/mpeg" ? mediaId : null;
    const legacyVersion = optionalText(row.Version) || null;
    const legacyNotes = preserveText(row.Notes) || null;
    const recordingNumber = (recordingNumberBySong.get(songId) ?? 0) + 1;
    recordingNumberBySong.set(songId, recordingNumber);
    const description = legacyVersion
      ? legacyNotes ? `${legacyVersion}\n\n${legacyNotes}` : legacyVersion
      : `Recording ${recordingNumber}`;

    normalizedRecordings.push({
      id,
      songId,
      originalMediaId: mediaId,
      playbackMediaId,
      description,
      normalizedDescription: normalizedName(description),
      recordedOn: asDateOnly(row.Date),
      processingState: "ready",
      processingError: null,
      legacyVersion,
      legacyNotes,
      revision: 1,
      createdAt,
      createdBy: actor,
      updatedAt: createdAt,
      updatedBy: actor,
      trashedAt: null,
      trashedBy: null,
    });
  }

  const diskFiles = [
    ...(await listFiles(resolve(options.mediaRoot, "scans"))),
    ...(await listFiles(resolve(options.mediaRoot, "recordings"))),
  ];
  const diskKeys = diskFiles.map((path) => relativeObjectKey(options.mediaRoot, path));
  const unreferenced = diskKeys.filter((key) => !referencedKeys.has(key));
  for (const key of unreferenced) warnings.push({ category: "unreferenced_media", message: key });

  const lyricTexts = songs.map(createLegacyLyricText).filter((row) => row !== null);
  const normalizedSongs = songs.map((row) => {
    const id = requiredText(row.SongID, "Songs.SongID");
    const createdAt = isoText(row.CreatedAt) ?? new Date(0).toISOString();
    const updatedAt = isoText(row.UpdatedAt) ?? createdAt;
    const actor = optionalText(row.CreatedBy) || LEGACY_ACTOR;
    const titleLatin = requiredText(row.TitleLatin, "Songs.TitleLatin");
    const status = optionalText(row.Status) || "draft";
    if (status !== "draft" && status !== "checked") {
      errors.push({ category: "invalid_song_status", message: id });
    }
    return {
      id,
      titleLatin,
      normalizedTitleLatin: normalizedName(titleLatin),
      titleNative: optionalText(row.TitleNative) || null,
      status,
      notes: preserveText(row.Notes) || null,
      revision: 1,
      createdAt,
      createdBy: actor,
      updatedAt,
      updatedBy: actor,
      trashedAt: null,
      trashedBy: null,
    };
  });

  const normalizedSongTitles = new Set<string>();
  for (const song of normalizedSongs) {
    const key = String(song.normalizedTitleLatin);
    if (normalizedSongTitles.has(key)) {
      errors.push({ category: "duplicate_song_title", message: String(song.id) });
    }
    normalizedSongTitles.add(key);
    if (!songLanguageRows.some((row) => row.songId === song.id)) {
      errors.push({ category: "song_missing_language", message: String(song.id) });
    }
  }

  const recordingDescriptions = new Set<string>();
  for (const recording of normalizedRecordings) {
    const key = `${String(recording.songId)}\0${String(recording.normalizedDescription)}`;
    if (recordingDescriptions.has(key)) {
      errors.push({ category: "duplicate_recording_description", message: String(recording.id) });
    }
    recordingDescriptions.add(key);
  }

  const catalog: NormalizedCatalog = {
    schemaVersion: 2,
    generatedAt,
    source: { workbook: options.workbookPath, mediaRoot: options.mediaRoot },
    languages: languages.map((row, sortOrder) => {
      const id = requiredText(row.LangID, "Languages.LangID");
      const displayName = requiredText(row.DisplayName, "Languages.DisplayName");
      return {
        id,
        displayName,
        normalizedName: normalizedName(displayName),
        bcp47Tag: BCP47_BY_LEGACY_ID[id] ?? null,
        sortOrder,
      };
    }),
    tags: tags.map((row, sortOrder) => {
      const displayName = requiredText(row.DisplayName, "Tags.DisplayName");
      return {
        id: requiredText(row.TagID, "Tags.TagID"),
        displayName,
        normalizedName: normalizedName(displayName),
        sortOrder,
      };
    }),
    notebooks: notebooks.map((row, sortOrder) => {
      const displayName = requiredText(row.DisplayName, "Notebooks.DisplayName");
      return {
        id: requiredText(row.NotebookID, "Notebooks.NotebookID"),
        displayName,
        normalizedName: normalizedName(displayName),
        sortOrder,
      };
    }),
    people: people.map((row) => {
      const fullName = requiredText(row.FullName, "People.FullName");
      return {
        id: requiredText(row.PersonID, "People.PersonID"),
        fullName,
        normalizedName: normalizedName(fullName),
        createdAt: generatedAt,
        updatedAt: generatedAt,
      };
    }),
    songs: normalizedSongs,
    songAliases: songAliasRows,
    songLanguages: songLanguageRows,
    songTags: songTagRows,
    songCredits: songCredits.map((row, sortOrder) => ({
      id: requiredText(row.CreditID, "SongCredits.CreditID"),
      songId: requiredText(row.SongID, "SongCredits.SongID"),
      personId: requiredText(row.PersonID, "SongCredits.PersonID"),
      role: songCreditRole(row.Role),
      sortOrder,
    })),
    lyricTexts,
    mediaObjects,
    scans: normalizedScans,
    recordings: normalizedRecordings,
    recordingCredits: recordingCredits.map((row, sortOrder) => ({
      id: requiredText(row.RecCreditID, "RecordingCredits.RecCreditID"),
      recordingId: requiredText(row.RecID, "RecordingCredits.RecID"),
      personId: requiredText(row.PersonID, "RecordingCredits.PersonID"),
      role: recordingCreditRole(row.Role),
      sortOrder,
    })),
  };

  const outputRows = Object.fromEntries(
    Object.entries(catalog)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, (value as unknown[]).length]),
  );

  const report: ImportReport = {
    generatedAt,
    mode: options.writeOutput ? "write" : "dry-run",
    source: { workbook: options.workbookPath, mediaRoot: options.mediaRoot },
    sheetRows: Object.fromEntries(Object.entries(sheetRows).map(([name, rows]) => [name, rows.length])),
    outputRows,
    normalizations: {
      languageIds: languageNormalizationCount,
      notebookIds: notebookNormalizationCount,
      legacyCombinedLyrics: lyricTexts.length,
    },
    media: {
      referenced: referencedKeys.size,
      missing: errors.filter((issue) => issue.category === "missing_media").length,
      unreferenced: unreferenced.length,
      bytes: referencedBytes,
      extensions: Object.fromEntries([...extensionCounts.entries()].sort()),
    },
    ignoredOperationalRows: {
      Home: sheetRows.Home?.length ?? 0,
      README: sheetRows.README?.length ?? 0,
      Search: sheetRows.Search?.length ?? 0,
      SearchResults: sheetRows.SearchResults?.length ?? 0,
    },
    errors,
    warnings,
  };

  if (options.writeOutput) {
    await mkdir(options.outputDirectory, { recursive: true });
    await Promise.all([
      writeFile(resolve(options.outputDirectory, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`),
      writeFile(resolve(options.outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    ]);
  }

  return { catalog, report };
}

function printSummary(report: ImportReport): void {
  const summary = {
    mode: report.mode,
    sheetRows: report.sheetRows,
    outputRows: report.outputRows,
    normalizations: report.normalizations,
    media: report.media,
    ignoredOperationalRows: report.ignoredOperationalRows,
    errors: report.errors.length,
    warnings: report.warnings.length,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const { report } = await importAppSheet(options);
  printSummary(report);
  if (report.errors.length > 0) process.exitCode = 1;
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`AppSheet import failed: ${message}\n`);
    process.exitCode = 1;
  });
}
