import { z } from "zod";

const nullableShortText = z.string().max(100).nullable().optional();

const scanMetadataShape = {
  notebookId: nullableShortText,
  pageLabel: nullableShortText,
};

const createScanSchema = z.object(scanMetadataShape).strict().superRefine(validateNotebookPage);

const updateScanSchema = z.object({
  ...scanMetadataShape,
  revision: z.number().int().positive(),
}).strict().superRefine(validateNotebookPage);

function validateNotebookPage(
  value: { notebookId?: string | null; pageLabel?: string | null },
  context: z.RefinementCtx,
): void {
  if (value.pageLabel?.trim() && !value.notebookId?.trim()) {
    context.addIssue({
      code: "custom",
      path: ["pageLabel"],
      message: "Select a Notebook before adding a Page",
    });
  }
}

const scanRevisionSchema = z.object({
  revision: z.number().int().positive(),
}).strict();

export type ScanUpdateInput = {
  notebookId: string | null;
  pageLabel: string | null;
  revision: number;
};

export type ScanCreateInput = Omit<ScanUpdateInput, "revision">;

export type ScanParseResult<T> =
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

function optionalNormalized(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/gu, " ") ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function parseScanUpdate(value: unknown): ScanParseResult<ScanUpdateInput> {
  const result = updateScanSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  return {
    success: true,
    data: {
      notebookId: optionalNormalized(result.data.notebookId),
      pageLabel: optionalNormalized(result.data.pageLabel),
      revision: result.data.revision,
    },
  };
}

export function parseScanCreate(value: unknown): ScanParseResult<ScanCreateInput> {
  const result = createScanSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  return {
    success: true,
    data: {
      notebookId: optionalNormalized(result.data.notebookId),
      pageLabel: optionalNormalized(result.data.pageLabel),
    },
  };
}

export function parseScanRevision(value: unknown): ScanParseResult<{ revision: number }> {
  const result = scanRevisionSchema.safeParse(value);
  if (!result.success) return { success: false, fields: fieldsFromError(result.error) };
  return { success: true, data: result.data };
}
