export type BrowserConnectivityTarget = {
  addEventListener: (type: "online" | "offline" | "pageshow", listener: EventListener) => void;
  removeEventListener: (type: "online" | "offline" | "pageshow", listener: EventListener) => void;
};

export type BrowserRevalidationTarget = {
  addEventListener: (type: "focus" | "pageshow", listener: EventListener) => void;
  removeEventListener: (type: "focus" | "pageshow", listener: EventListener) => void;
};

export function subscribeToBrowserConnectivity(
  target: BrowserConnectivityTarget,
  readOnline: () => boolean,
  onStatus: (isOnline: boolean) => void,
): () => void {
  const update = () => onStatus(readOnline());
  const eventTypes = ["online", "offline", "pageshow"] as const;
  for (const eventType of eventTypes) target.addEventListener(eventType, update);
  return () => {
    for (const eventType of eventTypes) target.removeEventListener(eventType, update);
  };
}

export function preserveSessionResolutionDuringRevalidation(
  alreadyResolved: boolean,
): boolean {
  // The initial state is already unresolved. Clearing a resolved session on
  // every reconnect would unmount all routes and destroy file/scroll/audio
  // state while the same protected session is checked in the background.
  return alreadyResolved;
}

export function subscribeToSessionRevalidation(
  target: BrowserRevalidationTarget,
  onRevalidate: () => void,
): () => void {
  const listener = () => onRevalidate();
  target.addEventListener("focus", listener);
  target.addEventListener("pageshow", listener);
  return () => {
    target.removeEventListener("focus", listener);
    target.removeEventListener("pageshow", listener);
  };
}

export function sessionFailureInvalidatesIdentity(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}
