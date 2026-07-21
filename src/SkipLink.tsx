import type { MouseEvent } from "react";

export function focusMainContent(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  const main = document.getElementById("main-content");
  if (!(main instanceof HTMLElement)) return;
  if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  main.focus();
}

export function SkipLink() {
  return (
    <a className="skip-link" href="#main-content" onClick={focusMainContent}>
      Skip to content
    </a>
  );
}
