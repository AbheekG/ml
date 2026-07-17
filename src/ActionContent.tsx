export type ActionIconKind =
  | "add"
  | "copy"
  | "edit"
  | "replace"
  | "retry"
  | "share"
  | "view";

export function ActionContent({
  kind,
  label,
}: {
  kind: ActionIconKind;
  label: string;
}) {
  return (
    <>
      <svg
        className="action-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {kind === "view" && (
          <>
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
            <circle cx="12" cy="12" r="2.5" />
          </>
        )}
        {kind === "edit" && (
          <>
            <path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z" />
            <path d="m14.5 6.7 2.8 2.8" />
          </>
        )}
        {kind === "share" && (
          <>
            <circle cx="18" cy="5" r="2.5" />
            <circle cx="6" cy="12" r="2.5" />
            <circle cx="18" cy="19" r="2.5" />
            <path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5" />
          </>
        )}
        {kind === "copy" && (
          <>
            <rect x="8" y="8" width="11" height="11" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </>
        )}
        {kind === "add" && <path d="M12 5v14M5 12h14" />}
        {kind === "retry" && (
          <>
            <path d="M20 7v5h-5" />
            <path d="M19 12a7 7 0 1 0-2.1 5" />
          </>
        )}
        {kind === "replace" && (
          <>
            <path d="m16 3 4 4-4 4" />
            <path d="M4 7h16" />
            <path d="m8 21-4-4 4-4" />
            <path d="M20 17H4" />
          </>
        )}
      </svg>
      <span className="action-label">{label}</span>
    </>
  );
}
