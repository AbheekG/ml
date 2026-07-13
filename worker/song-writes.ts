import { z } from "zod";

const nonBlankText = (maximum: number) => z.string()
  .max(maximum)
  .refine((value) => value.trim().length > 0, "Must not be blank");

const songShape = {
  titleLatin: nonBlankText(200),
  titleNative: z.string().max(200).nullable().optional(),
  status: z.enum(["draft", "checked"]),
  languageIds: z.array(nonBlankText(100)).min(1).max(20),
  tagIds: z.array(nonBlankText(100)).max(100).default([]),
  aliases: z.array(nonBlankText(200)).max(50).default([]),
  credits: z.array(z.object({
    personId: nonBlankText(100),
    role: z.enum(["lyrics", "music"]),
  }).strict()).max(200).default([]),
  notes: z.string().max(50_000).nullable().optional(),
} as const;

function validateLists(
  value: {
    languageIds: string[];
    tagIds: string[];
    aliases: string[];
    credits: Array<{ personId: string; role: "lyrics" | "music" }>;
  },
  context: z.RefinementCtx,
): void {
  if (new Set(value.languageIds).size !== value.languageIds.length) {
    context.addIssue({ code: "custom", path: ["languageIds"], message: "Duplicate Languages are not allowed" });
  }
  if (new Set(value.tagIds).size !== value.tagIds.length) {
    context.addIssue({ code: "custom", path: ["tagIds"], message: "Duplicate Tags are not allowed" });
  }

  const normalizedAliases = value.aliases.map(normalizedTextKey);
  if (new Set(normalizedAliases).size !== normalizedAliases.length) {
    context.addIssue({ code: "custom", path: ["aliases"], message: "Duplicate Aliases are not allowed" });
  }
  const creditKeys = value.credits.map((credit) => `${credit.personId}:${credit.role}`);
  if (new Set(creditKeys).size !== creditKeys.length) {
    context.addIssue({ code: "custom", path: ["credits"], message: "Duplicate Song credits are not allowed" });
  }
}

const createSongSchema = z.object(songShape).strict().superRefine(validateLists);
const updateSongSchema = z.object({
  ...songShape,
  revision: z.number().int().positive(),
}).strict().superRefine(validateLists);

const songRevisionSchema = z.object({
  revision: z.number().int().positive(),
}).strict();

export type SongWriteInput = {
  titleLatin: string;
  normalizedTitleLatin: string;
  titleNative: string | null;
  status: "draft" | "checked";
  languageIds: string[];
  tagIds: string[];
  aliases: Array<{ value: string; normalizedValue: string }>;
  credits: Array<{ personId: string; role: "lyrics" | "music" }>;
  notes: string | null;
};

export type SongUpdateInput = SongWriteInput & { revision: number };

export type SongParseResult<T> =
  | { success: true; data: T }
  | { success: false; fields: Record<string, string[]> };

export function normalizeWhitespace(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function normalizedTextKey(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase("en");
}

export function titleCaseText(value: string): string {
  return normalizeWhitespace(value)
    .toLocaleLowerCase("en")
    .replace(/(^|[^\p{L}\p{M}])(\p{L})/gu, (_match, prefix: string, letter: string) => (
      `${prefix}${letter.toLocaleUpperCase("en")}`
    ));
}

function optionalTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizedSong(value: z.infer<typeof createSongSchema>): SongWriteInput {
  const titleLatin = titleCaseText(value.titleLatin);
  return {
    titleLatin,
    normalizedTitleLatin: normalizedTextKey(titleLatin),
    titleNative: optionalTrimmed(value.titleNative),
    status: value.status,
    languageIds: value.languageIds,
    tagIds: value.tagIds,
    aliases: value.aliases.map((alias) => {
      const normalizedAlias = titleCaseText(alias);
      return { value: normalizedAlias, normalizedValue: normalizedTextKey(normalizedAlias) };
    }),
    credits: value.credits,
    notes: optionalTrimmed(value.notes),
  };
}

function fieldsFromError(error: z.ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    (fields[field] ??= []).push(issue.message);
  }
  return fields;
}

export function parseSongCreate(value: unknown): SongParseResult<SongWriteInput> {
  const result = createSongSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  return { success: true, data: normalizedSong(result.data) };
}

export function parseSongUpdate(value: unknown): SongParseResult<SongUpdateInput> {
  const result = updateSongSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  return {
    success: true,
    data: { ...normalizedSong(result.data), revision: result.data.revision },
  };
}

export function parseSongRevision(value: unknown): SongParseResult<{ revision: number }> {
  const result = songRevisionSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  return { success: true, data: result.data };
}
