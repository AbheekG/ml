export type ScanActionKind = "view" | "share" | "edit";

export function ScanActionContent({
  kind,
  label,
}: {
  kind: ScanActionKind;
  label: string;
}) {
  return (
    <>
      <svg
        className="scan-action-icon"
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
      </svg>
      <span className="scan-action-label">{label}</span>
    </>
  );
}
