export type BrowserConnectivityTarget = {
  addEventListener: (type: "online" | "offline" | "pageshow", listener: EventListener) => void;
  removeEventListener: (type: "online" | "offline" | "pageshow", listener: EventListener) => void;
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
