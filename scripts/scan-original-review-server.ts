import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeOutputPath } from "./safe-output";

type ReviewDecision = "correct" | "issue" | "unsure";
type ReviewScope = "all" | "remaining" | "deferred-unmatched";

type ReviewItem = {
  currentToken: string;
  matchStatus: string;
  reviewDecision: ReviewDecision | "unreviewed";
  ownerApproved: boolean;
};

type ReviewState = {
  schemaVersion: 1;
  reportSha256: string;
  scope: ReviewScope;
  itemCount: number;
  reviewedCount: number;
  updatedAt: string | null;
  decisions: Record<string, ReviewDecision>;
};

export type ScanOriginalReviewServerOptions = {
  outputDirectory: string;
  scope?: ReviewScope;
  host?: "127.0.0.1";
  port?: number;
  token?: string;
  projectRoot?: string;
};

export type RunningScanOriginalReviewServer = {
  server: Server;
  url: string;
  statePath: string;
  close: () => Promise<void>;
};

const GALLERY_FILES: Record<ReviewScope, string> = {
  all: "gallery.html",
  remaining: "remaining.html",
  "deferred-unmatched": "deferred-unmatched.html",
};

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.temporary`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

export function parseAllowedItems(html: string): Map<string, { matchStatus: string; ownerApproved: boolean }> {
  const allowed = new Map<string, { matchStatus: string; ownerApproved: boolean }>();
  const pattern = /<article class="review-card" id="item-(current-\d{4})" data-status="([a-z_]+)" data-review="[a-z]*" data-owner-approved="(true|false)">/gu;
  for (const match of html.matchAll(pattern)) {
    if (allowed.has(match[1])) throw new Error("duplicate_review_token");
    allowed.set(match[1], { matchStatus: match[2], ownerApproved: match[3] === "true" });
  }
  if (allowed.size === 0) throw new Error("empty_review_gallery");
  return allowed;
}

function emptyState(reportSha256: string, scope: ReviewScope, itemCount: number): ReviewState {
  return {
    schemaVersion: 1,
    reportSha256,
    scope,
    itemCount,
    reviewedCount: 0,
    updatedAt: null,
    decisions: {},
  };
}

async function loadState(
  path: string,
  reportSha256: string,
  scope: ReviewScope,
  allowed: Map<string, { matchStatus: string; ownerApproved: boolean }>,
): Promise<ReviewState> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState(reportSha256, scope, allowed.size);
    }
    throw new Error("review_state_unreadable");
  }
  let state: ReviewState;
  try {
    state = JSON.parse(bytes.toString("utf8")) as ReviewState;
  } catch {
    throw new Error("review_state_invalid");
  }
  if (state.schemaVersion !== 1 || state.reportSha256 !== reportSha256
    || state.scope !== scope || state.itemCount !== allowed.size
    || typeof state.decisions !== "object" || state.decisions === null) {
    throw new Error("review_state_report_mismatch");
  }
  const valid = new Set<ReviewDecision>(["correct", "issue", "unsure"]);
  for (const [token, decision] of Object.entries(state.decisions)) {
    if (!allowed.has(token) || !valid.has(decision)) throw new Error("review_state_invalid");
  }
  state.reviewedCount = Object.keys(state.decisions).length;
  return state;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 256_000) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

export function validatedState(
  input: unknown,
  reportSha256: string,
  scope: ReviewScope,
  allowed: Map<string, { matchStatus: string; ownerApproved: boolean }>,
): ReviewState {
  const body = input as { reportSha256?: unknown; items?: unknown };
  if (!body || body.reportSha256 !== reportSha256 || !Array.isArray(body.items)
    || body.items.length !== allowed.size) {
    throw new Error("review_payload_mismatch");
  }
  const decisions: Record<string, ReviewDecision> = {};
  const seen = new Set<string>();
  const valid = new Set(["unreviewed", "correct", "issue", "unsure"]);
  for (const raw of body.items) {
    const item = raw as Partial<ReviewItem>;
    const expected = typeof item.currentToken === "string" ? allowed.get(item.currentToken) : undefined;
    if (!expected || seen.has(item.currentToken!) || item.matchStatus !== expected.matchStatus
      || item.ownerApproved !== expected.ownerApproved
      || typeof item.reviewDecision !== "string" || !valid.has(item.reviewDecision)) {
      throw new Error("review_payload_invalid");
    }
    seen.add(item.currentToken!);
    if (item.reviewDecision !== "unreviewed") {
      decisions[item.currentToken!] = item.reviewDecision as ReviewDecision;
    }
  }
  return {
    schemaVersion: 1,
    reportSha256,
    scope,
    itemCount: allowed.size,
    reviewedCount: Object.keys(decisions).length,
    updatedAt: new Date().toISOString(),
    decisions,
  };
}

function hasAuth(request: IncomingMessage, token: string): boolean {
  const cookies = request.headers.cookie?.split(";").map((part) => part.trim()) ?? [];
  const value = cookies.find((cookie) => cookie.startsWith("scan_review="))?.slice("scan_review=".length);
  return typeof value === "string" && safeEqual(value, token);
}

export async function startScanOriginalReviewServer(
  options: ScanOriginalReviewServerOptions,
): Promise<RunningScanOriginalReviewServer> {
  const outputDirectory = await assertSafeOutputPath(options.outputDirectory, {
    projectRoot: options.projectRoot ?? resolve("."),
    allowedRoots: ["notes/private"],
    kind: "directory",
    outsideCode: "output_must_be_private",
  });
  const reviewDirectory = resolve(outputDirectory, "review");
  const scope = options.scope ?? "remaining";
  const galleryFilename = GALLERY_FILES[scope];
  const [reportBytes, galleryBytes] = await Promise.all([
    readFile(resolve(outputDirectory, "match-report.json")),
    readFile(resolve(reviewDirectory, galleryFilename)),
  ]);
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  const galleryHtml = galleryBytes.toString("utf8");
  const allowed = parseAllowedItems(galleryHtml);
  const statePath = resolve(outputDirectory, `review-state-${scope}.json`);
  let state = await loadState(statePath, reportSha256, scope, allowed);
  const token = options.token ?? randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9_-]{24,128}$/u.test(token)) throw new Error("invalid_review_token");
  const host = options.host ?? "127.0.0.1";
  const configuredPort = options.port ?? 4177;
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
    throw new Error("invalid_review_port");
  }

  const server = createServer(async (request, response) => {
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : configuredPort;
      const origin = `http://${host}:${port}`;
      const url = new URL(request.url ?? "/", origin);
      if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
        if (!safeEqual(url.searchParams.get("token") ?? "", token)) {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        response.writeHead(303, {
          Location: "/",
          "Set-Cookie": `scan_review=${token}; HttpOnly; SameSite=Strict; Path=/`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        response.end();
        return;
      }
      if (!hasAuth(request, token)) {
        sendJson(response, 403, { error: "forbidden" });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === `/${galleryFilename}`)) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": galleryBytes.length,
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        });
        response.end(galleryBytes);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/review-state") {
        sendJson(response, 200, state);
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/review-state") {
        if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        const next = validatedState(await readJsonBody(request), reportSha256, scope, allowed);
        await writeAtomic(statePath, `${JSON.stringify(next, null, 2)}\n`);
        state = next;
        sendJson(response, 200, {
          saved: true,
          itemCount: state.itemCount,
          reviewedCount: state.reviewedCount,
          updatedAt: state.updatedAt,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/export") {
        const body = `${JSON.stringify(state, null, 2)}\n`;
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Content-Disposition": `attachment; filename="scan-original-${scope}-review-state.json"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(body);
        return;
      }
      const imageMatch = /^\/(current-\d{4})\.jpg$/u.exec(url.pathname);
      if (request.method === "GET" && imageMatch && allowed.has(imageMatch[1])) {
        const bytes = await readFile(resolve(reviewDirectory, `${imageMatch[1]}.jpg`));
        response.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": bytes.length,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(bytes);
        return;
      }
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const code = error instanceof Error ? error.message : "unexpected_error";
      const status = code === "request_too_large" ? 413 : 400;
      sendJson(response, status, { error: code });
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(configuredPort, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("review_server_address_unavailable");
  return {
    server,
    url: `http://${host}:${address.port}/?token=${token}`,
    statePath,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

function parseArguments(arguments_: string[]): ScanOriginalReviewServerOptions {
  let outputDirectory = resolve("notes/private/scan-original-recovery");
  let scope: ReviewScope = "remaining";
  let port = 4177;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === "--output" && next) {
      outputDirectory = resolve(next);
      index += 1;
    } else if (argument === "--scope" && (next === "all" || next === "remaining" || next === "deferred-unmatched")) {
      scope = next;
      index += 1;
    } else if (argument === "--port" && next) {
      port = Number(next);
      index += 1;
    } else {
      throw new Error("invalid_argument");
    }
  }
  return { outputDirectory, scope, port };
}

async function main(): Promise<void> {
  const running = await startScanOriginalReviewServer(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ ready: true, url: running.url })}\n`);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isDirectRun) {
  main().catch((error: unknown) => {
    const code = error instanceof Error ? error.message : "unexpected_error";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
