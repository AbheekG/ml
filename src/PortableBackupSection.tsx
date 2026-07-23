import { useState } from "react";
import {
  buildPrivateExportKit,
  downloadPrivateExportKit,
  formatPrivateBytes,
  loadPortableExportSnapshot,
  preparePortableExport,
  revokePortableExport,
  type PortableExportSession,
} from "./portable-export";
import type { FrozenExportItem, SnapshotRecord } from "./portable-model";

export type PortableBackupDependencies = {
  prepare: () => Promise<PortableExportSession>;
  loadSnapshot: (
    exportId: string,
  ) => Promise<{ records: SnapshotRecord[]; items: FrozenExportItem[] }>;
  buildKit: typeof buildPrivateExportKit;
  downloadKit: typeof downloadPrivateExportKit;
  revoke: (exportId: string) => Promise<PortableExportSession>;
};

const defaultDependencies: PortableBackupDependencies = {
  prepare: preparePortableExport,
  loadSnapshot: loadPortableExportSnapshot,
  buildKit: buildPrivateExportKit,
  downloadKit: downloadPrivateExportKit,
  revoke: revokePortableExport,
};

function count(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString();
}

export function PortableBackupSection({
  isOnline,
  dependencies = defaultDependencies,
}: {
  isOnline: boolean;
  dependencies?: PortableBackupDependencies;
}) {
  const [prepared, setPrepared] = useState<PortableExportSession | null>(null);
  const [stage, setStage] = useState<
    "idle" | "preparing" | "ready" | "building-kit" | "kit-downloaded" | "revoking" | "revoked"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  const prepare = async () => {
    setStage("preparing");
    setError(null);
    try {
      const session = await dependencies.prepare();
      setPrepared(session);
      setStage("ready");
    } catch (prepareError) {
      setStage("idle");
      setError(prepareError instanceof Error ? prepareError.message : "The export plan could not be prepared.");
    }
  };

  const download = async () => {
    if (!prepared) return;
    setStage("building-kit");
    setError(null);
    try {
      const snapshot = await dependencies.loadSnapshot(prepared.id);
      const kit = await dependencies.buildKit(
        prepared,
        snapshot.records,
        snapshot.items,
        window.location.origin,
      );
      dependencies.downloadKit(kit);
      setStage("kit-downloaded");
    } catch (downloadError) {
      setStage("ready");
      setError(downloadError instanceof Error ? downloadError.message : "The private kit could not be downloaded.");
    }
  };

  const revoke = async () => {
    if (!prepared) return;
    setStage("revoking");
    setError(null);
    try {
      setPrepared(await dependencies.revoke(prepared.id));
      setStage("revoked");
    } catch (revokeError) {
      setStage(prepared.state === "ready" ? "ready" : "revoked");
      setError(revokeError instanceof Error ? revokeError.message : "The export plan could not be revoked.");
    }
  };

  const estimatedArchive = prepared ? Math.ceil(prepared.plannedBytes * 1.03) + 64 * 1024 * 1024 : 0;
  const requiredDisk = prepared ? (prepared.plannedBytes * 2) + 1024 * 1024 * 1024 : 0;
  const busy = ["preparing", "building-kit", "revoking"].includes(stage);
  const usable = prepared?.state === "ready" && stage !== "revoked";

  return (
    <section className="portable-backup form-card" aria-labelledby="portable-backup-title">
      <p className="eyebrow">Administrator</p>
      <h2 id="portable-backup-title">Portable backup</h2>
      <p>
        Prepare a frozen, private preservation export of the complete durable library:
        active records, Trash, typed lyrics, retained originals and optimized files,
        replacement and move history, attribution, and provenance.
      </p>
      <p className="media-note">
        A plan or downloaded kit is not a completed backup. The kit contains private
        metadata but no media, Access token, or storage key. Only the local builder’s
        final <strong>VERIFIED</strong> result is usable.
      </p>
      <ul className="portable-requirements">
        <li>Online administrator access is required to prepare, download, or revoke a plan.</li>
        <li>Building requires Python 3.11+ and <code>cloudflared</code> on the destination computer.</li>
        <li><code>cloudflared</code> may open a browser once; its Access token remains only in process memory.</li>
        <li>Four bounded downloads run by default and can resume after interruption.</li>
      </ul>

      {!prepared ? (
        <button
          className="primary-action"
          type="button"
          disabled={!isOnline || busy}
          onClick={() => { void prepare(); }}
        >
          {stage === "preparing" ? "Preparing frozen plan…" : "Prepare export kit"}
        </button>
      ) : (
        <>
          <dl className="settings-list portable-export-summary">
            <div><dt>Status</dt><dd>{stage === "revoked" ? "Revoked" : stage === "kit-downloaded" ? "Kit downloaded · media incomplete" : "Plan prepared"}</dd></div>
            <div><dt>Export</dt><dd><code>{prepared.id.slice(0, 8)}…</code></dd></div>
            <div><dt>Snapshot</dt><dd>{new Date(prepared.snapshotAt).toLocaleString()}</dd></div>
            <div><dt>Expires</dt><dd>{new Date(prepared.expiresAt).toLocaleString()}</dd></div>
            <div><dt>Songs</dt><dd>{count(prepared.activeSongs)} active · {count(prepared.trashedSongs)} Trash</dd></div>
            <div><dt>Typed lyrics</dt><dd>{count(prepared.activeLyrics)} active · {count(prepared.trashedLyrics)} Trash</dd></div>
            <div><dt>Scans</dt><dd>{count(prepared.activeScans)} active · {count(prepared.trashedScans)} Trash</dd></div>
            <div><dt>Recordings</dt><dd>{count(prepared.activeRecordings)} active · {count(prepared.trashedRecordings)} Trash</dd></div>
            <div><dt>History</dt><dd>{count(prepared.historyRelationships)} retained relationships · {count(prepared.unassignedMedia)} unassigned media</dd></div>
            <div><dt>Planned media</dt><dd>{prepared.itemCount.toLocaleString()} objects · {formatPrivateBytes(prepared.plannedBytes)}</dd></div>
            <div><dt>Estimated archive</dt><dd>{formatPrivateBytes(estimatedArchive)}</dd></div>
            <div><dt>Conservative free disk</dt><dd>{formatPrivateBytes(requiredDisk)}</dd></div>
          </dl>
          {usable && (
            <div className="form-actions portable-export-actions">
              <button
                className="primary-action"
                type="button"
                disabled={!isOnline || busy}
                onClick={() => { void download(); }}
              >
                {stage === "building-kit" ? "Constructing private kit…" : stage === "kit-downloaded" ? "Download kit again" : "Download export kit"}
              </button>
              <button
                className="danger-action"
                type="button"
                disabled={!isOnline || busy}
                onClick={() => { void revoke(); }}
              >
                {stage === "revoking" ? "Revoking…" : "Revoke this kit"}
              </button>
            </div>
          )}
          <p className="media-note">
            Revocation removes only derived export access. It does not change catalog rows,
            private media, a downloaded kit, or an archive already built on your computer.
          </p>
          {stage === "kit-downloaded" && (
            <div className="portable-command" role="status">
              <p>Kit downloaded. Extract it on the chosen private disk, then run:</p>
              <code>python3 tools/music_library_archive.py build --kit . --output ../music-library-preservation.zip</code>
              <p>Wait for <strong>VERIFIED</strong>, then run the independent <code>verify</code> command.</p>
            </div>
          )}
        </>
      )}
      {!isOnline && <p className="catalog-message">Go online to use portable backup. Existing local reading remains available.</p>}
      {error && <p className="catalog-message error-message" role="alert">{error}</p>}
      <p className="media-note">
        Stages: Plan prepared → Kit downloaded → Media incomplete → Archive built → Verified.
      </p>
    </section>
  );
}

