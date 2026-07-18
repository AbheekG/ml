import { useEffect, useRef } from "react";

type RevealableElement = {
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
};

export function revealFeedback(element: RevealableElement | null): void {
  element?.scrollIntoView({ block: "nearest" });
}

export function useRevealFeedback(trigger: unknown) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (trigger) revealFeedback(ref.current);
  }, [trigger]);
  return ref;
}

export function FeedbackMessage({
  message,
  tone = "error",
}: {
  message: string | null;
  tone?: "error" | "status";
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) revealFeedback(ref.current);
  }, [message]);

  if (!message) return null;
  return (
    <p
      className={`catalog-message${tone === "error" ? " error-message" : ""}`}
      ref={ref}
      role={tone === "error" ? "alert" : "status"}
    >
      {message}
    </p>
  );
}
