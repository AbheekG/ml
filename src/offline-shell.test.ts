import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_READINESS_REQUEST,
  OFFLINE_READINESS_RESPONSE,
  queryOfflineShellReady,
} from "./offline-shell";

afterEach(() => vi.unstubAllGlobals());

describe("offline shell readiness", () => {
  it("requires an active service-worker controller", async () => {
    await expect(queryOfflineShellReady({ controller: null })).resolves.toBe(false);
  });

  it("accepts only the bounded readiness response", async () => {
    vi.stubGlobal("MessageChannel", MessageChannel);
    await expect(queryOfflineShellReady({
      controller: {
        postMessage(message, transfer) {
          expect(message).toEqual({ type: OFFLINE_READINESS_REQUEST });
          const port = transfer[0] as MessagePort;
          port.postMessage({ type: OFFLINE_READINESS_RESPONSE, ready: true });
        },
      },
    })).resolves.toBe(true);
  });

  it("fails closed when the controller does not answer", async () => {
    vi.stubGlobal("MessageChannel", MessageChannel);
    await expect(queryOfflineShellReady({
      controller: { postMessage: vi.fn() },
    }, 1)).resolves.toBe(false);
  });
});
