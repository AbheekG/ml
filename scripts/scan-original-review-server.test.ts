import { describe, expect, it } from "vitest";
import { parseAllowedItems, validatedState } from "./scan-original-review-server";

describe("scan original review server", () => {
  const html = `<!doctype html>
    <article class="review-card" id="item-current-0001" data-status="owner_review_probable" data-review="" data-owner-approved="false"></article>
    <article class="review-card" id="item-current-0002" data-status="owner_review_ambiguous" data-review="" data-owner-approved="false"></article>
  `;

  it("parses the exact opaque gallery scope and validates a complete review payload", () => {
    const allowed = parseAllowedItems(html);
    expect([...allowed.entries()]).toEqual([
      ["current-0001", { matchStatus: "owner_review_probable", ownerApproved: false }],
      ["current-0002", { matchStatus: "owner_review_ambiguous", ownerApproved: false }],
    ]);
    expect(validatedState({
      reportSha256: "digest",
      items: [
        {
          currentToken: "current-0001",
          matchStatus: "owner_review_probable",
          reviewDecision: "correct",
          ownerApproved: false,
        },
        {
          currentToken: "current-0002",
          matchStatus: "owner_review_ambiguous",
          reviewDecision: "issue",
          ownerApproved: false,
        },
      ],
    }, "digest", "remaining", allowed)).toMatchObject({
      schemaVersion: 1,
      reportSha256: "digest",
      scope: "remaining",
      itemCount: 2,
      reviewedCount: 2,
      decisions: {
        "current-0001": "correct",
        "current-0002": "issue",
      },
    });
  });

  it("rejects partial, duplicate, or status-mismatched review payloads", () => {
    const allowed = parseAllowedItems(html);
    expect(() => validatedState({
      reportSha256: "digest",
      items: [],
    }, "digest", "remaining", allowed)).toThrow("review_payload_mismatch");
    expect(() => validatedState({
      reportSha256: "digest",
      items: [
        {
          currentToken: "current-0001",
          matchStatus: "wrong",
          reviewDecision: "correct",
          ownerApproved: false,
        },
        {
          currentToken: "current-0001",
          matchStatus: "owner_review_probable",
          reviewDecision: "correct",
          ownerApproved: false,
        },
      ],
    }, "digest", "remaining", allowed)).toThrow("review_payload_invalid");
  });
});
