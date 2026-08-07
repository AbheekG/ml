export const OFFLINE_READINESS_REQUEST = "music-library-offline-readiness";
export const OFFLINE_READINESS_RESPONSE = "music-library-offline-readiness-result";

type ServiceWorkerControllerLike = {
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

type ServiceWorkerContainerLike = {
  controller: ServiceWorkerControllerLike | null;
};

export async function queryOfflineShellReady(
  serviceWorker: ServiceWorkerContainerLike,
  timeoutMs = 1_500,
): Promise<boolean> {
  const controller = serviceWorker.controller;
  if (!controller || typeof MessageChannel === "undefined") return false;

  const channel = new MessageChannel();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.port1.close();
      resolve(ready);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data as { type?: unknown; ready?: unknown } | null;
      finish(value?.type === OFFLINE_READINESS_RESPONSE && value.ready === true);
    };
    channel.port1.onmessageerror = () => finish(false);
    try {
      controller.postMessage({ type: OFFLINE_READINESS_REQUEST }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}
