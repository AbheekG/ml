import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useBeforeUnload, useBlocker, useLocation } from "react-router-dom";

type UnsavedChangesContextValue = {
  setDirty: (registration: symbol, dirty: boolean) => void;
  unregister: (registration: symbol) => void;
  allowNextNavigation: () => void;
};

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

function DiscardChangesDialog({
  onDiscard,
  onStay,
}: {
  onDiscard: () => void;
  onStay: () => void;
}) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const stayButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    stayButton.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onStay();
      return;
    }
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(
      "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="discard-dialog-backdrop">
      <div
        className="discard-dialog"
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="discard-dialog-title"
        aria-describedby="discard-dialog-description"
        onKeyDown={handleKeyDown}
      >
        <h2 id="discard-dialog-title">Discard unsaved changes?</h2>
        <p id="discard-dialog-description">Changes on this screen have not been saved. Leave only if you are comfortable losing them.</p>
        <div className="discard-dialog-actions">
          <button ref={stayButton} className="primary-action" type="button" onClick={onStay}>Stay here</button>
          <button className="danger-action" type="button" onClick={onDiscard}>Discard and leave</button>
        </div>
      </div>
    </div>
  );
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [dirtyRegistrations, setDirtyRegistrations] = useState<Set<symbol>>(() => new Set());
  const allowNavigation = useRef(false);
  const location = useLocation();
  const isDirty = dirtyRegistrations.size > 0;

  const setDirty = useCallback((registration: symbol, dirty: boolean) => {
    setDirtyRegistrations((current) => {
      if (current.has(registration) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(registration);
      else next.delete(registration);
      return next;
    });
  }, []);

  const unregister = useCallback((registration: symbol) => {
    setDirtyRegistrations((current) => {
      if (!current.has(registration)) return current;
      const next = new Set(current);
      next.delete(registration);
      return next;
    });
  }, []);

  const allowNextNavigation = useCallback(() => {
    allowNavigation.current = true;
  }, []);

  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation }) => (
    isDirty
    && !allowNavigation.current
    && (
      currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search
      || currentLocation.hash !== nextLocation.hash
    )
  ), [isDirty]));

  useBeforeUnload(useCallback((event) => {
    if (!isDirty || allowNavigation.current) return;
    event.preventDefault();
    event.returnValue = "";
  }, [isDirty]));

  useEffect(() => {
    allowNavigation.current = false;
  }, [location.key]);

  const value = useMemo<UnsavedChangesContextValue>(() => ({
    setDirty,
    unregister,
    allowNextNavigation,
  }), [allowNextNavigation, setDirty, unregister]);

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      {blocker.state === "blocked" && (
        <DiscardChangesDialog
          onStay={() => blocker.reset()}
          onDiscard={() => {
            allowNavigation.current = true;
            blocker.proceed();
          }}
        />
      )}
    </UnsavedChangesContext.Provider>
  );
}

export function useUnsavedChanges(isDirty: boolean): { allowNextNavigation: () => void } {
  const context = useContext(UnsavedChangesContext);
  if (!context) throw new Error("useUnsavedChanges must be used inside UnsavedChangesProvider");
  const registration = useRef(Symbol("unsaved-changes"));

  useLayoutEffect(() => {
    const currentRegistration = registration.current;
    context.setDirty(currentRegistration, isDirty);
    return () => context.unregister(currentRegistration);
  }, [context, isDirty]);

  return { allowNextNavigation: context.allowNextNavigation };
}

export function editorValuesChanged<T>(initial: T | null, current: T): boolean {
  return initial !== null && JSON.stringify(initial) !== JSON.stringify(current);
}

export function shouldRefreshEditor(
  loadedEditorKey: string | null,
  currentEditorKey: string,
  hasUnsavedChanges: boolean,
): boolean {
  return loadedEditorKey !== currentEditorKey || !hasUnsavedChanges;
}

export function editorLoadStatus(
  loadedEditorKey: string | null,
  failedEditorKey: string | null,
  currentEditorKey: string,
  isLoading: boolean,
): "loading" | "ready" | "failed" {
  if (isLoading) return "loading";
  if (loadedEditorKey === currentEditorKey) return "ready";
  if (failedEditorKey === currentEditorKey) return "failed";
  return "loading";
}
