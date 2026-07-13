import { z } from "zod";
import { normalizedTextKey } from "./song-writes";

const description = z.string()
  .max(10_000, "Recording description is too long")
  .refine((value) => value.trim().length > 0, "Recording description must not be blank");

const recordedOn = z.string().nullable().optional().superRefine((value, context) => {
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
  if (value > new Date().toISOString().slice(0, 10)) {
    context.addIssue({ code: "custom", message: "Recorded date cannot be in the future" });
  }
});

const updateRecordingSchema = z.object({
  description,
  recordedOn,
  creditPersonIds: z.array(z.string().min(1).max(100)).max(100).default([]),
  revision: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (new Set(value.creditPersonIds).size !== value.creditPersonIds.length) {
    context.addIssue({
      code: "custom",
      path: ["creditPersonIds"],
      message: "Duplicate contributors are not allowed",
    });
  }
});

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

export function parseRecordingUpdate(value: unknown): RecordingParseResult<RecordingUpdateInput> {
  const result = updateRecordingSchema.safeParse(value);
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

export function parseRecordingRevision(value: unknown): RecordingParseResult<{ revision: number }> {
  const result = recordingRevisionSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  return { success: true, data: result.data };
}
