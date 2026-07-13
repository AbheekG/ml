import { z } from "zod";
import { normalizeWhitespace, normalizedTextKey } from "./song-writes";

export const LOOKUP_KINDS = ["languages", "tags", "notebooks", "people"] as const;
export type LookupKind = typeof LOOKUP_KINDS[number];

const lookupKindSchema = z.enum(LOOKUP_KINDS);
const lookupName = z.string()
  .max(200, "Name is too long")
  .refine((value) => value.trim().length > 0, "Name must not be blank");

const createLookupSchema = z.object({ name: lookupName }).strict();
const updateLookupSchema = z.object({
  name: lookupName,
  currentName: lookupName,
}).strict();

export type LookupWriteInput = {
  name: string;
  normalizedName: string;
};

export type LookupUpdateInput = LookupWriteInput & {
  currentName: string;
};

export type LookupParseResult<T> =
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

export function parseLookupKind(value: string): LookupKind | null {
  const result = lookupKindSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseLookupCreate(value: unknown): LookupParseResult<LookupWriteInput> {
  const result = createLookupSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  const name = normalizeWhitespace(result.data.name);
  return { success: true, data: { name, normalizedName: normalizedTextKey(name) } };
}

export function parseLookupUpdate(value: unknown): LookupParseResult<LookupUpdateInput> {
  const result = updateLookupSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  const name = normalizeWhitespace(result.data.name);
  return {
    success: true,
    data: {
      name,
      normalizedName: normalizedTextKey(name),
      currentName: result.data.currentName,
    },
  };
}
