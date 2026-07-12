import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("dist/client");
const indexPath = resolve(outputDirectory, "index.html");
const serviceWorkerPath = resolve(outputDirectory, "sw.js");

const indexHtml = await readFile(indexPath, "utf8");
const serviceWorker = await readFile(serviceWorkerPath, "utf8");
const referencedUrls = [...indexHtml.matchAll(/(?:src|href)="(\/[^\"]+)"/g)].map((match) => match[1]);
const precacheUrls = [...new Set(["/", "/manifest.webmanifest", ...referencedUrls])].sort();
const buildId = createHash("sha256")
  .update(indexHtml)
  .update(JSON.stringify(precacheUrls))
  .digest("hex")
  .slice(0, 12);

const generated = serviceWorker
  .replace('const BUILD_ID = "development"; // INJECT_BUILD_ID', `const BUILD_ID = ${JSON.stringify(buildId)};`)
  .replace('const PRECACHE_URLS = ["/"]; // INJECT_PRECACHE_URLS', `const PRECACHE_URLS = ${JSON.stringify(precacheUrls)};`);

if (generated === serviceWorker) throw new Error("Service worker injection markers were not found");
await writeFile(serviceWorkerPath, generated);
process.stdout.write(`${JSON.stringify({ buildId, precacheEntries: precacheUrls.length })}\n`);
