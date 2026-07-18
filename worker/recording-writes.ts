import { z } from "zod";
import { normalizedTextKey } from "./song-writes";

const description = z.string()
  .max(10_000, "Recording description is too long")
  .refine((value) => value.trim().length > 0, "Recording description must not be blank");

const MAX_TIMEZONE_OFFSET_HOURS = 14;

export function latestCurrentCalendarDate(now: Date = new Date()): string {
  return new Date(now.valueOf() + (MAX_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000))
    .toISOString()
    .slice(0, 10);
}

function recordedOn(maximumDate: string) {
  return z.string().nullable().optional().superRefine((value, context) => {
    if (value === null || value === undefined || value === "") return;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      context.addIssue({ code: "custom", message: "Use a valid date" });
      return;
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
      context.addIssue({ code: "custom", message: "Use a valid date" });
      return;
    }
    if (value > maximumDate) {
      context.addIssue({ code: "custom", message: "Recorded date cannot be in the future" });
    }
  });
}

const creditPersonIds = z.array(z.string().min(1).max(100)).max(100).default([]);

function rejectDuplicateCredits(
  value: { creditPersonIds: string[] },
  context: z.RefinementCtx,
): void {
  if (new Set(value.creditPersonIds).size !== value.creditPersonIds.length) {
    context.addIssue({
      code: "custom",
      path: ["creditPersonIds"],
      message: "Duplicate contributors are not allowed",
    });
  }
}

function updateRecordingSchema(maximumDate: string) {
  return z.object({
    description,
    recordedOn: recordedOn(maximumDate),
    creditPersonIds,
    revision: z.number().int().positive(),
  }).strict().superRefine(rejectDuplicateCredits);
}

function createRecordingMetadataSchema(maximumDate: string) {
  return z.object({
    description: z.string().max(10_000, "Recording description is too long").nullable().optional(),
    recordedOn: recordedOn(maximumDate),
    creditPersonIds,
  }).strict().superRefine(rejectDuplicateCredits);
}

const recordingRevisionSchema = z.object({
  revision: z.number().int().positive(),
}).strict();

export type RecordingUpdateInput = {
  description: string;
  normalizedDescription: string;
  recordedOn: string | null;
  creditPersonIds: string[];
  revision: number;
};

export type RecordingCreateMetadataInput = {
  description: string | null;
  recordedOn: string | null;
  creditPersonIds: string[];
};

export type RecordingParseResult<T> =
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

export function parseRecordingUpdate(
  value: unknown,
  now: Date = new Date(),
): RecordingParseResult<RecordingUpdateInput> {
  const result = updateRecordingSchema(latestCurrentCalendarDate(now)).safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  const trimmedDescription = result.data.description.trim();
  return {
    success: true,
    data: {
      description: trimmedDescription,
      normalizedDescription: normalizedTextKey(trimmedDescription),
      recordedOn: result.data.recordedOn || null,
      creditPersonIds: result.data.creditPersonIds,
      revision: result.data.revision,
    },
  };
}

export function parseRecordingCreateMetadata(
  value: unknown,
  now: Date = new Date(),
): RecordingParseResult<RecordingCreateMetadataInput> {
  const result = createRecordingMetadataSchema(latestCurrentCalendarDate(now)).safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  const description = result.data.description?.trim() || null;
  return {
    success: true,
    data: {
      description,
      recordedOn: result.data.recordedOn || null,
      creditPersonIds: result.data.creditPersonIds,
    },
  };
}

export function parseRecordingRevision(value: unknown): RecordingParseResult<{ revision: number }> {
  const result = recordingRevisionSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  return { success: true, data: result.data };
}
