export type ConnectivityProbe = (signal: AbortSignal) => Promise<boolean>;

export type LatestConnectivityChecker = {
  check: () => Promise<void>;
  markOffline: () => void;
  dispose: () => void;
};

export function createLatestConnectivityChecker(
  probe: ConnectivityProbe,
  onStatus: (isOnline: boolean) => void,
  timeoutMs = 5_000,
): LatestConnectivityChecker {
  let disposed = false;
  let sequence = 0;
  let active: { sequence: number; controller: AbortController } | null = null;

  async function check(): Promise<void> {
    const currentSequence = ++sequence;
    active?.controller.abort();

    const controller = new AbortController();
    active = { sequence: currentSequence, controller };
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const isOnline = await probe(controller.signal);
      if (!disposed && currentSequence === sequence) onStatus(isOnline);
    } catch {
      // A superseded check is intentionally aborted. Only the newest request
      // may turn the application offline; its own timeout/failure remains real.
      if (!disposed && currentSequence === sequence) onStatus(false);
    } finally {
      globalThis.clearTimeout(timeout);
      if (active?.sequence === currentSequence) active = null;
    }
  }

  function markOffline(): void {
    ++sequence;
    active?.controller.abort();
    active = null;
    if (!disposed) onStatus(false);
  }

  function dispose(): void {
    disposed = true;
    ++sequence;
    active?.controller.abort();
    active = null;
  }

  return { check, markOffline, dispose };
}

export function preserveSessionResolutionDuringRevalidation(
  alreadyResolved: boolean,
): boolean {
  // The initial state is already unresolved. Clearing a resolved session on
  // every reconnect would unmount all routes and destroy file/scroll/audio
  // state while the same protected session is checked in the background.
  return alreadyResolved;
}
