import { z } from "zod";

const mediaParentMoveSchema = z.object({
  revision: z.number().int().positive(),
  targetSongId: z.string().min(1).max(100),
  duplicateUpload: z.object({
    sessionId: z.string().min(1).max(100),
    revision: z.number().int().positive(),
  }).strict().optional(),
}).strict();

export type MediaParentMoveInput = z.infer<typeof mediaParentMoveSchema>;

export function parseMediaParentMove(value: unknown):
  | { success: true; data: MediaParentMoveInput }
  | { success: false } {
  const result = mediaParentMoveSchema.safeParse(value);
  return result.success ? { success: true, data: result.data } : { success: false };
}
