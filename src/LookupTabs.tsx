import { useRef, type KeyboardEvent } from "react";
import type { LookupKind } from "./catalog";

export type LookupTabOption = {
  kind: LookupKind;
  label: string;
  count: number | null;
};

export function lookupTabId(kind: LookupKind): string {
  return `lookup-tab-${kind}`;
}

export function lookupPanelId(kind: LookupKind): string {
  return `lookup-panel-${kind}`;
}

export function nextLookupTabIndex(
  key: string,
  currentIndex: number,
  tabCount: number,
): number | null {
  if (tabCount <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  if (key === "ArrowRight") return (currentIndex + 1) % tabCount;
  if (key === "ArrowLeft") return (currentIndex - 1 + tabCount) % tabCount;
  return null;
}

export function LookupTabs({
  activeKind,
  options,
  onSelect,
}: {
  activeKind: LookupKind;
  options: LookupTabOption[];
  onSelect: (kind: LookupKind) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number): void {
    const nextIndex = nextLookupTabIndex(event.key, currentIndex, options.length);
    if (nextIndex === null) return;
    event.preventDefault();
    onSelect(options[nextIndex].kind);
    buttons.current[nextIndex]?.focus();
  }

  return (
    <div className="lookup-tabs" role="tablist" aria-label="Library lists">
      {options.map((option, index) => (
        <button
          ref={(button) => { buttons.current[index] = button; }}
          id={lookupTabId(option.kind)}
          type="button"
          role="tab"
          aria-controls={lookupPanelId(option.kind)}
          aria-selected={activeKind === option.kind}
          tabIndex={activeKind === option.kind ? 0 : -1}
          className={activeKind === option.kind ? "active" : ""}
          key={option.kind}
          onClick={() => onSelect(option.kind)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {option.label}
          <span>{option.count ?? "–"}</span>
        </button>
      ))}
    </div>
  );
}
