import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const BUCKET = "music-library-media-staging";
const CATALOG_PATH = resolve("data/import-output/catalog.json");
const STATE_PATH = resolve("data/import-output/r2-upload-state.json");
const MEDIA_ROOT = resolve("appsheet");
const WRANGLER = resolve("node_modules/.bin/wrangler");

type MediaObject = {
  id: string;
  objectKey: string;
  mimeType: string | null;
  byteSize: number;
};

type Catalog = { mediaObjects: MediaObject[] };
type UploadState = { completed: Record<string, { byteSize: number }> };

function integerOption(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} requires a positive integer`);
  return value;
}

async function readState(): Promise<UploadState> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as UploadState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { completed: {} };
    throw error;
  }
}

async function saveState(state: UploadState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

async function upload(media: MediaObject): Promise<void> {
  const source = resolve(MEDIA_ROOT, media.objectKey);
  const sourceStats = await stat(source);
  if (sourceStats.size !== media.byteSize) throw new Error("source size changed after import validation");

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(WRANGLER, [
      "r2", "object", "put", `${BUCKET}/${media.objectKey}`,
      "--remote",
      "--file", source,
      "--content-type", media.mimeType ?? "application/octet-stream",
      "--cache-control", "private, max-age=3600",
      "--force",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.resume();
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Wrangler upload failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function main(): Promise<void> {
  const shouldWrite = process.argv.includes("--write");
  const concurrency = integerOption("--concurrency", 3);
  const limit = integerOption("--limit", Number.MAX_SAFE_INTEGER);
  const catalog = JSON.parse(await readFile(CATALOG_PATH, "utf8")) as Catalog;
  const state = await readState();
  const pending = catalog.mediaObjects
    .filter((media) => state.completed[media.id]?.byteSize !== media.byteSize)
    .slice(0, limit);
  const bytes = pending.reduce((total, media) => total + media.byteSize, 0);

  process.stdout.write(`${JSON.stringify({ mode: shouldWrite ? "write" : "dry-run", pending: pending.length, bytes, concurrency })}\n`);
  if (!shouldWrite || pending.length === 0) return;

  let next = 0;
  let completed = 0;
  const failures: Error[] = [];
  let saveQueue = Promise.resolve();

  async function worker(): Promise<void> {
    while (next < pending.length) {
      const media = pending[next++];
      try {
        await upload(media);
        state.completed[media.id] = { byteSize: media.byteSize };
        completed += 1;
        saveQueue = saveQueue.then(() => saveState(state));
        await saveQueue;
        if (completed % 25 === 0 || completed === pending.length) {
          process.stdout.write(`${JSON.stringify({ completed, total: pending.length })}\n`);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failures.length > 0) throw new Error(`${failures.length} upload(s) failed; rerun to retry pending files`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
