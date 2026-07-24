// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPage } from "./App";
import {
  PortableBackupSection,
  type PortableBackupDependencies,
} from "./PortableBackupSection";
import type { PortableExportSession, PrivateExportKit } from "./portable-export";

afterEach(cleanup);

const prepared: PortableExportSession = {
  id: "a".repeat(32),
  profileVersion: "1.0.0",
  state: "ready",
  sourceSchemaVersion: "0022",
  sourceCommit: "1234567",
  sourceEnvironment: "synthetic",
  snapshotAt: "2026-07-24T10:00:00.000Z",
  createdAt: "2026-07-24T10:00:00.000Z",
  expiresAt: "2026-07-25T10:00:00.000Z",
  recordCount: 20,
  itemCount: 3,
  plannedBytes: 1024,
  planDigest: "b".repeat(64),
  readyAt: "2026-07-24T10:00:00.000Z",
  revokedAt: null,
  expiredAt: null,
  failedAt: null,
  failureCode: null,
  detailPurgedAt: null,
  activeSongs: 2,
  trashedSongs: 1,
  activeLyrics: 3,
  trashedLyrics: 1,
  activeScans: 2,
  trashedScans: 1,
  activeRecordings: 2,
  trashedRecordings: 1,
  historyRelationships: 4,
  unassignedMedia: 1,
};

function dependencies(): PortableBackupDependencies {
  return {
    prepare: vi.fn(async () => prepared),
    loadSnapshot: vi.fn(async () => ({ records: [], items: [] })),
    buildKit: vi.fn(async () => ({
      filename: "private-kit.zip",
      bytes: new Uint8Array([1]),
      model: { catalog: {}, items: [] },
      plan: {},
    } as unknown as PrivateExportKit)),
    downloadKit: vi.fn(),
    revoke: vi.fn(async (): Promise<PortableExportSession> => ({
      ...prepared,
      state: "revoked",
      revokedAt: "2026-07-24T11:00:00.000Z",
    })),
  };
}

describe("PortableBackupSection", () => {
  it("keeps the admin workflow online-only and distinguishes plan, kit, and verified archive", async () => {
    const user = userEvent.setup();
    const api = dependencies();
    render(<PortableBackupSection isOnline dependencies={api} />);
    expect(screen.getByText(/not a completed backup/i)).toBeTruthy();
    expect(screen.getByText(/Plan prepared → Kit downloaded → Media incomplete → Archive built → Verified/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Prepare export kit" }));
    expect((await screen.findAllByText("2 active · 1 Trash")).length).toBe(3);
    expect(screen.getByText("3 objects · 1.0 KiB")).toBeTruthy();
    expect(screen.getByText(/24-hour|expires/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Download export kit" }));
    expect(api.loadSnapshot).toHaveBeenCalledWith(prepared.id);
    expect(api.buildKit).toHaveBeenCalled();
    expect(api.downloadKit).toHaveBeenCalled();
    expect(await screen.findByText(/Kit downloaded\. Extract it/)).toBeTruthy();
    expect(screen.getByText(/Wait for/).textContent).toContain("VERIFIED");

    await user.click(screen.getByRole("button", { name: "Revoke this kit" }));
    expect(api.revoke).toHaveBeenCalledWith(prepared.id);
    expect(await screen.findByText("Revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Download kit/ })).toBeNull();
  });

  it("disables preparation while offline", () => {
    render(<PortableBackupSection isOnline={false} dependencies={dependencies()} />);
    expect(screen.getByRole("button", { name: "Prepare export kit" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/Go online to use portable backup/)).toBeTruthy();
  });

  it("is rendered by Account only for an administrator", () => {
    const logout = vi.fn(async () => undefined);
    const { rerender } = render(
      <AccountPage
        session={{ email: "viewer@example.invalid", role: "viewer", cacheNamespace: "cache" }}
        isOnline
        onLogout={logout}
      />,
    );
    expect(screen.queryByRole("heading", { name: "Portable backup" })).toBeNull();
    rerender(
      <AccountPage
        session={{ email: "admin@example.invalid", role: "admin", cacheNamespace: "cache" }}
        isOnline
        onLogout={logout}
      />,
    );
    expect(screen.getByRole("heading", { name: "Portable backup" })).toBeTruthy();
  });
});
