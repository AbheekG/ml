import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStoredZip,
  canonicalPrettyJson,
  formatPrivateBytes,
  loadCurrentPortableExport,
  loadPortableExportSnapshot,
  preparePortableExport,
  revokePortableExport,
} from "./portable-export";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function zipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    expect(method).toBe(0);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    result.set(name, bytes.slice(contentStart, contentStart + size));
    offset = contentStart + size;
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50);
  return result;
}

describe("private portable export kit", () => {
  it("writes a deterministic UTF-8 stored ZIP with no implicit directories", () => {
    const encoder = new TextEncoder();
    const first = buildStoredZip(new Map([
      ["tools/tool.py", encoder.encode("print('ok')\n")],
      ["metadata/示例.json", encoder.encode("{}\n")],
    ]));
    const second = buildStoredZip(new Map([
      ["metadata/示例.json", encoder.encode("{}\n")],
      ["tools/tool.py", encoder.encode("print('ok')\n")],
    ]));
    expect(second).toEqual(first);
    const entries = zipEntries(first);
    expect([...entries]).toEqual([
      ["metadata/示例.json", encoder.encode("{}\n")],
      ["tools/tool.py", encoder.encode("print('ok')\n")],
    ]);
  });

  it("canonicalizes JSON the same way regardless of object insertion order", () => {
    const first = canonicalPrettyJson({ z: "示例", a: { y: 2, x: 1 }, list: [2, 1] });
    const second = canonicalPrettyJson({ list: [2, 1], a: { x: 1, y: 2 }, z: "示例" });
    expect(second).toEqual(first);
    expect(new TextDecoder().decode(first)).toBe(
      '{\n  "a": {\n    "x": 1,\n    "y": 2\n  },\n  "list": [\n    2,\n    1\n  ],\n  "z": "示例"\n}\n',
    );
  });

  it("uses exact JSON mutation requests and deterministic bounded paging", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      let body: unknown;
      let status = 200;
      if (url === "/api/admin/portable-exports") {
        body = { export: { id: "a".repeat(32) } };
        status = 201;
      } else if (url === "/api/admin/portable-exports/current") {
        body = { export: { id: "a".repeat(32), state: "ready" } };
      } else if (url.includes("/records") && url.endsWith("offset=0")) {
        body = {
          records: [{ kind: "songs", key: "song-1", orderKey: "song-1", data: { id: "song-1" } }],
          nextOffset: 1,
        };
      } else if (url.includes("/records") && url.endsWith("offset=1")) {
        body = {
          records: [{ kind: "tags", key: "tag-1", orderKey: "tag-1", data: { id: "tag-1" } }],
          nextOffset: null,
        };
      } else if (url.includes("/items")) {
        body = { items: [{ id: "1".repeat(32) }], nextOffset: null };
      } else {
        body = { export: { id: "a".repeat(32), state: "revoked" } };
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    await preparePortableExport("mutation-1");
    await expect(loadCurrentPortableExport()).resolves.toMatchObject({
      id: "a".repeat(32),
      state: "ready",
    });
    const snapshot = await loadPortableExportSnapshot("a".repeat(32));
    await revokePortableExport("a".repeat(32));
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.items).toHaveLength(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientMutationId: "mutation-1" }),
    });
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
      "/api/admin/portable-exports",
      "/api/admin/portable-exports/current",
      `/api/admin/portable-exports/${"a".repeat(32)}/records?limit=200&offset=0`,
      `/api/admin/portable-exports/${"a".repeat(32)}/items?limit=200&offset=0`,
      `/api/admin/portable-exports/${"a".repeat(32)}/records?limit=200&offset=1`,
      `/api/admin/portable-exports/${"a".repeat(32)}/revoke`,
    ]));
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("cf-access-token");
  });

  it("formats exact private plan estimates without claiming completion", () => {
    expect(formatPrivateBytes(0)).toBe("0 B");
    expect(formatPrivateBytes(7_955_140_423)).toBe("7.4 GiB");
    expect(formatPrivateBytes(Number.NaN)).toBe("Unavailable");
  });
});
