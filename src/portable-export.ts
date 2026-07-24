import profileText from "../portable/profile.json?raw";
import catalogSchemaText from "../portable/schemas/catalog.schema.json?raw";
import exportPlanSchemaText from "../portable/schemas/export-plan.schema.json?raw";
import exportReportSchemaText from "../portable/schemas/export-report.schema.json?raw";
import profileSchemaText from "../portable/schemas/profile.schema.json?raw";
import archiveToolText from "../tools/music_library_archive.py?raw";
import {
  buildPortableExportModel,
  PORTABLE_PROFILE_ID,
  PORTABLE_PROFILE_VERSION,
  PORTABLE_TOOL_VERSION,
  type FrozenExportItem,
  type FrozenExportSession,
  type PortableExportModel,
  type SnapshotRecord,
} from "./portable-model";

export type PortableExportSession = FrozenExportSession & {
  state: "preparing" | "ready" | "revoked" | "expired" | "failed";
  profileVersion: string;
  createdAt: string;
  readyAt: string | null;
  revokedAt: string | null;
  expiredAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  detailPurgedAt: string | null;
  activeSongs: number | null;
  trashedSongs: number | null;
  activeLyrics: number | null;
  trashedLyrics: number | null;
  activeScans: number | null;
  trashedScans: number | null;
  activeRecordings: number | null;
  trashedRecordings: number | null;
  historyRelationships: number | null;
  unassignedMedia: number | null;
};

export type PrivateExportKit = {
  filename: string;
  bytes: Uint8Array;
  model: PortableExportModel;
  plan: Record<string, unknown>;
};

const textEncoder = new TextEncoder();
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORED_METHOD = 0;
const ZIP_DOS_DATE_1980_01_01 = 0x0021;
const MAX_KIT_BYTES = 256 * 1024 * 1024;

function apiErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    insufficient_role: "Administrator access is required.",
    portable_export_precondition_failed: "The library could not be frozen safely. No usable plan was created.",
    portable_export_expired: "This export plan has expired. Prepare a new one.",
    portable_export_revoked: "This export plan was revoked.",
    portable_export_unavailable: "This export plan is not available.",
    portable_export_not_configured: "Portable export is not configured on this deployment.",
  };
  return messages[code] ?? "The portable export request failed.";
}

async function responseJson<T>(response: Response): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("The portable export response was invalid.");
  }
  if (!response.ok) {
    const code = value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string"
      ? (value as { error: string }).error
      : "portable_export_failed";
    throw new Error(apiErrorMessage(code));
  }
  return value as T;
}

export async function preparePortableExport(
  clientMutationId: string = crypto.randomUUID(),
): Promise<PortableExportSession> {
  const response = await fetch("/api/admin/portable-exports", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientMutationId }),
  });
  const payload = await responseJson<{ export: PortableExportSession }>(response);
  return payload.export;
}

export async function loadPortableExportSession(
  exportId: string,
): Promise<PortableExportSession> {
  const response = await fetch(
    `/api/admin/portable-exports/${encodeURIComponent(exportId)}`,
    { credentials: "same-origin" },
  );
  const payload = await responseJson<{ export: PortableExportSession }>(response);
  return payload.export;
}

export async function loadCurrentPortableExport(): Promise<PortableExportSession | null> {
  const response = await fetch(
    "/api/admin/portable-exports/current",
    { credentials: "same-origin" },
  );
  const payload = await responseJson<{ export: PortableExportSession | null }>(response);
  return payload.export;
}

async function loadAllPages<T>(
  path: string,
  field: "records" | "items",
): Promise<T[]> {
  const result: T[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const response: globalThis.Response = await fetch(`${path}?limit=200&offset=${offset}`, {
      credentials: "same-origin",
    });
    const payload: {
      records?: T[];
      items?: T[];
      nextOffset: number | null;
    } = await responseJson(response);
    const values = payload[field];
    if (!Array.isArray(values)) throw new Error("The portable export page was invalid.");
    result.push(...values);
    offset = payload.nextOffset;
  }
  return result;
}

export async function loadPortableExportSnapshot(
  exportId: string,
): Promise<{ records: SnapshotRecord[]; items: FrozenExportItem[] }> {
  const base = `/api/admin/portable-exports/${encodeURIComponent(exportId)}`;
  const [records, items] = await Promise.all([
    loadAllPages<SnapshotRecord>(`${base}/records`, "records"),
    loadAllPages<FrozenExportItem>(`${base}/items`, "items"),
  ]);
  return { records, items };
}

export async function revokePortableExport(
  exportId: string,
): Promise<PortableExportSession> {
  const response = await fetch(
    `/api/admin/portable-exports/${encodeURIComponent(exportId)}/revoke`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  const payload = await responseJson<{ export: PortableExportSession }>(response);
  return payload.export;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, sortedJsonValue(child)]),
    );
  }
  return value;
}

export function canonicalPrettyJson(value: unknown): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(sortedJsonValue(value), null, 2)}\n`);
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function header(length: number, write: (view: DataView) => void): Uint8Array {
  const result = new Uint8Array(length);
  write(new DataView(result.buffer));
  return result;
}

export function buildStoredZip(files: Map<string, Uint8Array>): Uint8Array {
  const entries = [...files.entries()].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  if (entries.length > 65_535) throw new Error("The private kit has too many files.");
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;

  for (const [name, contents] of entries) {
    const nameBytes = textEncoder.encode(name);
    if (
      !name
      || name.startsWith("/")
      || name.includes("\\")
      || name.split("/").some((component) => !component || component === "." || component === "..")
      || nameBytes.byteLength > 0xffff
      || contents.byteLength > 0xffffffff
    ) {
      throw new Error("The private kit contains an unsafe file path.");
    }
    const checksum = crc32(contents);
    const localHeader = header(30, (view) => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, ZIP_UTF8_FLAG, true);
      view.setUint16(8, ZIP_STORED_METHOD, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, ZIP_DOS_DATE_1980_01_01, true);
      view.setUint32(14, checksum, true);
      view.setUint32(18, contents.byteLength, true);
      view.setUint32(22, contents.byteLength, true);
      view.setUint16(26, nameBytes.byteLength, true);
      view.setUint16(28, 0, true);
    });
    const centralHeader = header(46, (view) => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 0x0314, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, ZIP_UTF8_FLAG, true);
      view.setUint16(10, ZIP_STORED_METHOD, true);
      view.setUint16(12, 0, true);
      view.setUint16(14, ZIP_DOS_DATE_1980_01_01, true);
      view.setUint32(16, checksum, true);
      view.setUint32(20, contents.byteLength, true);
      view.setUint32(24, contents.byteLength, true);
      view.setUint16(28, nameBytes.byteLength, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, (0o100600 << 16) >>> 0, true);
      view.setUint32(42, localOffset, true);
    });
    localChunks.push(localHeader, nameBytes, contents);
    centralChunks.push(centralHeader, nameBytes);
    localOffset += localHeader.byteLength + nameBytes.byteLength + contents.byteLength;
  }
  const central = concatenate(centralChunks);
  if (localOffset > 0xffffffff || central.byteLength > 0xffffffff) {
    throw new Error("The private kit is unexpectedly large.");
  }
  const end = header(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entries.length, true);
    view.setUint16(10, entries.length, true);
    view.setUint32(12, central.byteLength, true);
    view.setUint32(16, localOffset, true);
    view.setUint16(20, 0, true);
  });
  const result = concatenate([...localChunks, central, end]);
  if (result.byteLength > MAX_KIT_BYTES) throw new Error("The private kit is unexpectedly large.");
  return result;
}

function kitReadme(): Uint8Array {
  return textEncoder.encode(`<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Music Library private export kit</title>
<body><h1>Music Library private export kit</h1>
<p><strong>Private and incomplete:</strong> this kit contains frozen metadata, but it is not a backup
until the local builder downloads every media object and reports <code>VERIFIED</code>.</p>
<p>Requirements: Python 3.11 or newer, <code>cloudflared</code>, and conservative free disk space.</p>
<p>Keep the extracted kit, archive, and resumable work folder on a private disk outside any Git
or source-code repository. In Terminal, change into the extracted kit directory before running:</p>
<pre>python3 tools/music_library_archive.py build --kit . --output ../music-library-preservation.zip
python3 tools/music_library_archive.py verify ../music-library-preservation.zip
python3 tools/music_library_archive.py inspect ../music-library-preservation.zip</pre>
<p>The builder uses Cloudflare's end-user Access login, keeps the token only in memory, supports
resuming interrupted downloads, and never receives a storage key. The plan expires at the time
recorded in <code>export-plan.json</code>.</p></body></html>
`);
}

function safeOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password) {
    throw new Error("The application origin is not a supported HTTPS origin.");
  }
  return origin;
}

export async function buildPrivateExportKit(
  session: PortableExportSession,
  records: SnapshotRecord[],
  items: FrozenExportItem[],
  origin: string,
): Promise<PrivateExportKit> {
  if (session.state !== "ready") throw new Error("Only a ready export plan can produce a kit.");
  const exactOrigin = safeOrigin(origin);
  const model = await buildPortableExportModel(session, records, items);
  const catalogBytes = canonicalPrettyJson(model.catalog);
  const plan = {
    profile: { id: PORTABLE_PROFILE_ID, version: PORTABLE_PROFILE_VERSION },
    toolVersion: PORTABLE_TOOL_VERSION,
    creatorBound: true,
    exportId: session.id,
    origin: exactOrigin,
    snapshotAt: session.snapshotAt,
    expiresAt: session.expiresAt,
    planDigest: session.planDigest,
    catalogSha256: await sha256Hex(catalogBytes),
    objectCount: model.items.length,
    plannedBytes: model.items.reduce((total, item) => total + item.byteSize, 0),
    items: model.items,
  };
  const files = new Map<string, Uint8Array>([
    ["README.html", kitReadme()],
    ["export-plan.json", canonicalPrettyJson(plan)],
    ["metadata/catalog.json", catalogBytes],
    ["metadata/profile.json", textEncoder.encode(profileText)],
    ["metadata/schemas/catalog.schema.json", textEncoder.encode(catalogSchemaText)],
    ["metadata/schemas/export-plan.schema.json", textEncoder.encode(exportPlanSchemaText)],
    ["metadata/schemas/export-report.schema.json", textEncoder.encode(exportReportSchemaText)],
    ["metadata/schemas/profile.schema.json", textEncoder.encode(profileSchemaText)],
    ["tools/music_library_archive.py", textEncoder.encode(archiveToolText)],
  ]);
  const manifestLines: string[] = [];
  for (const [path, contents] of [...files.entries()].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ))) {
    manifestLines.push(`${await sha256Hex(contents)}  ${path}`);
  }
  files.set("KIT-MANIFEST.sha256", textEncoder.encode(`${manifestLines.join("\n")}\n`));
  const bytes = buildStoredZip(files);
  return {
    filename: `music-library-export-kit-${session.snapshotAt.slice(0, 10)}-${session.id.slice(0, 8)}.zip`,
    bytes,
    model,
    plan,
  };
}

export function downloadPrivateExportKit(kit: PrivateExportKit): void {
  const blob = new Blob([kit.bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = kit.filename;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function formatPrivateBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}
