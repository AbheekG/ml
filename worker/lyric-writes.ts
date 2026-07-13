import { z } from "zod";

const lyricContent = z.string()
  .max(500_000, "Typed lyrics are too long")
  .refine((value) => value.trim().length > 0, "Typed lyrics must not be blank");

const createLyricSchema = z.object({
  content: lyricContent,
}).strict();

const updateLyricSchema = z.object({
  content: lyricContent,
  revision: z.number().int().positive(),
}).strict();

export type LyricWriteInput = {
  content: string;
};

export type LyricUpdateInput = LyricWriteInput & {
  revision: number;
};

export type LyricParseResult<T> =
  | { success: true; data: T }
  | { success: false; fields: Record<string, string[]> };

function fieldsFromError(error: z.ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    (fields[field] ??= []).push(issue.message);
  }
  return fields;
}

export function parseLyricCreate(value: unknown): LyricParseResult<LyricWriteInput> {
  const result = createLyricSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  return { success: true, data: result.data };
}

export function parseLyricUpdate(value: unknown): LyricParseResult<LyricUpdateInput> {
  const result = updateLyricSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  return { success: true, data: result.data };
}
