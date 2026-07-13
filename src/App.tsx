import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { ScanViewer } from "./ScanViewer";
import {
  ApiError,
  createLyric,
  createSong,
  loadRecordingEditorOptions,
  loadTrash,
  loadScanEditorOptions,
  loadSession,
  loadSongEditorOptions,
  readCachedCatalog,
  readCachedSong,
  refreshOfflineLibrary,
  refreshSong,
  restoreLyric,
  restoreRecording,
  restoreScan,
  restoreSong,
  trashRecording,
  trashScan,
  trashSong,
  trashLyric,
  updateScan,
  updateLyric,
  updateRecording,
  updateSong,
  type AppSession,
  type CatalogSong,
  type RecordingEditorOptions,
  type SongEditorOptions,
  type SongDetail,
  type SongWritePayload,
  type ScanEditorOptions,
  type TrashedLyric,
  type TrashedRecording,
  type TrashedScan,
  type TrashedSong,
} from "./catalog";
import { scanDisplayName } from "./scan-viewer";

function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    let disposed = false;
    let activeRequest: AbortController | null = null;

    async function checkConnection(): Promise<void> {
      activeRequest?.abort();
      const controller = new AbortController();
      activeRequest = controller;
      const timeout = window.setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(`/api/health?connectivity=${Date.now()}`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const isHealthy = response.ok
          && response.headers.get("content-type")?.includes("application/json") === true;
        if (!disposed) setIsOnline(isHealthy);
      } catch {
        if (!disposed) setIsOnline(false);
      } finally {
        window.clearTimeout(timeout);
      }
    }

    const goOnline = () => { void checkConnection(); };
    const goOffline = () => setIsOnline(false);
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkConnection();
    };

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    window.addEventListener("focus", goOnline);
    window.addEventListener("pageshow", goOnline);
    document.addEventListener("visibilitychange", checkWhenVisible);
    const interval = window.setInterval(() => { void checkConnection(); }, 30000);
    void checkConnection();

    return () => {
      disposed = true;
      activeRequest?.abort();
      window.clearInterval(interval);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("focus", goOnline);
      window.removeEventListener("pageshow", goOnline);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, []);

  return isOnline;
}

function SongsPage({ isOnline, canEdit }: { isOnline: boolean; canEdit: boolean | null }) {
  const [songs, setSongs] = useState<CatalogSong[]>([]);
  const [query, setQuery] = useState("");
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const cached = await readCachedCatalog();
        if (cancelled) return;
        setSongs(cached.songs);
        setSyncedAt(cached.syncedAt);

        if (navigator.onLine) {
          const fresh = await refreshOfflineLibrary();
          if (cancelled) return;
          setSongs(fresh.songs);
          setSyncedAt(fresh.syncedAt);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Catalog could not be loaded");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [isOnline]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSongs = normalizedQuery
    ? songs.filter((song) => `${song.titleLatin} ${song.titleNative ?? ""}`.toLocaleLowerCase().includes(normalizedQuery))
    : songs;

  return (
    <main className="page-shell" id="main-content">
      <section className="catalog-heading" aria-labelledby="catalog-title">
        <div>
          <p className="eyebrow">Your collection</p>
          <h1 id="catalog-title">All songs</h1>
          <p className="lede">
            {songs.length > 0 ? `${visibleSongs.length} of ${songs.length} songs` : "Browse titles, typed lyrics, scans, and recordings."}
          </p>
        </div>
        {isOnline && canEdit === true
          ? <Link className="primary-action action-link" to="/songs/new">Add song</Link>
          : <button className="primary-action" type="button" disabled title={isOnline ? "Editor access is required" : "Go online to add a song"}>Add song</button>}
      </section>

      <section className="catalog-tools" aria-label="Catalog tools">
        <label className="search-field">
          <span className="sr-only">Search songs</span>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="Search song titles"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={songs.length === 0}
          />
        </label>
        <button className="secondary-action" type="button" disabled>
          Filters
        </button>
      </section>

      {error && <p className="catalog-message error-message" role="alert">{error}</p>}
      {syncedAt && <p className="sync-note">Available offline · updated {new Date(syncedAt).toLocaleString()}</p>}

      {isLoading && songs.length === 0 ? (
        <section className="empty-state"><p>Loading the local catalog…</p></section>
      ) : visibleSongs.length > 0 ? (
        <ol className="song-list" aria-label="Songs">
          {visibleSongs.map((song) => (
            <li key={song.id}>
              <Link className="song-row" to={`/songs/${encodeURIComponent(song.id)}`}>
                <span className="song-titles">
                  <strong>{song.titleLatin}</strong>
                  {song.titleNative && <span lang="und">{song.titleNative}</span>}
                </span>
                <span className="song-meta">
                  {song.languageIds.join(" · ")}
                  <span aria-label={`${song.lyricCount} lyric texts, ${song.scanCount} scans, ${song.recordingCount} recordings`}>
                    T{song.lyricCount} · S{song.scanCount} · R{song.recordingCount}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <section className="empty-state" aria-labelledby="empty-title">
          <div className="empty-mark" aria-hidden="true">♪</div>
          <h2 id="empty-title">{songs.length > 0 ? "No matching songs" : "Catalog is empty"}</h2>
          <p>{songs.length > 0 ? "Try a different title." : "Run the verified local import to load songs."}</p>
        </section>
      )}
    </main>
  );
}

function MetadataList({ song }: { song: SongDetail }) {
  const items = [
    ["Languages", song.languages.map((item) => item.displayName).join(", ")],
    ["Tags", song.tags.map((item) => item.displayName).join(", ")],
    ["Aliases", song.aliases.join(", ")],
    ["Status", song.status],
  ].filter(([, value]) => value);

  if (items.length === 0 && song.credits.length === 0) return null;

  return (
    <section className="detail-card" aria-labelledby="metadata-title">
      <h2 id="metadata-title">About</h2>
      <dl className="metadata-list">
        {items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        {song.credits.map((credit) => (
          <div key={`${credit.personId}:${credit.role}`}>
            <dt>{contributionLabel(credit.role)}</dt>
            <dd>{credit.fullName}</dd>
          </div>
        ))}
      </dl>
      {song.notes && <p className="detail-notes">{song.notes}</p>}
    </section>
  );
}

const CONTRIBUTION_LABELS: Readonly<Record<string, string>> = {
  lyrics: "Lyrics",
  music: "Music",
  vocals: "Vocals",
};

function contributionLabel(role: string): string {
  return CONTRIBUTION_LABELS[role]
    ?? role.replaceAll("_", " ").replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function SongDetailPage({ isOnline, canEdit }: { isOnline: boolean; canEdit: boolean | null }) {
  const { songId = "" } = useParams();
  const [song, setSong] = useState<SongDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [viewerScanId, setViewerScanId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOnline) setViewerScanId(null);
  }, [isOnline]);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const cached = await readCachedSong(songId);
        if (cancelled) return;
        if (cached) setSong(cached);

        if (navigator.onLine) {
          const fresh = await refreshSong(songId);
          if (!cancelled) {
            setSong(fresh);
            setError(null);
          }
        } else if (!cached) {
          setError("This song has not yet been saved for offline viewing.");
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Song could not be loaded");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [songId, isOnline]);

  if (isLoading && !song) {
    return <main className="page-shell" id="main-content"><p>Loading song…</p></main>;
  }

  if (!song) {
    return (
      <main className="page-shell" id="main-content">
        <Link className="back-link" to="/songs">← All songs</Link>
        <section className="empty-state"><h1>Song unavailable</h1><p>{error}</p></section>
      </main>
    );
  }

  return (
    <main className="page-shell detail-page" id="main-content">
      <Link className="back-link" to="/songs">← All songs</Link>
      <header className="detail-heading">
        <div className="heading-actions">
          <p className="eyebrow">Song</p>
          {isOnline && canEdit === true && <Link className="secondary-action action-link" to={`/songs/${encodeURIComponent(song.id)}/edit`}>Edit song</Link>}
        </div>
        <h1>{song.titleLatin}</h1>
        {song.titleNative && <p className="native-title" lang="und">{song.titleNative}</p>}
        {error && <p className="catalog-message error-message" role="alert">Showing saved copy · {error}</p>}
      </header>

      <div className="detail-grid">
        <div className="detail-main">
          {song.lyricTexts.map((lyrics) => (
            <section className="detail-card lyrics-card" key={lyrics.id} aria-labelledby={`${lyrics.id}-title`}>
              <div className="card-heading">
                <h2 id={`${lyrics.id}-title`}>Typed lyrics</h2>
                {isOnline && canEdit === true && <Link className="secondary-action action-link" to={`/songs/${encodeURIComponent(song.id)}/lyrics/${encodeURIComponent(lyrics.id)}/edit`}>Edit</Link>}
              </div>
              <pre>{lyrics.content}</pre>
            </section>
          ))}

          {isOnline && canEdit === true && (
            <Link className="secondary-action action-link add-child-action" to={`/songs/${encodeURIComponent(song.id)}/lyrics/new`}>Add typed lyrics</Link>
          )}

          {song.recordings.length > 0 && (
            <section className="detail-card" aria-labelledby="recordings-title">
              <h2 id="recordings-title">Recordings <span>{song.recordings.length}</span></h2>
              <ul className="media-list">
                {song.recordings.map((recording) => (
                  <li key={recording.id}>
                    <div className="recording-item">
                      <strong>{recording.description}</strong>
                      <span>{[recording.recordedOn, recording.filename].filter(Boolean).join(" · ")}</span>
                      {recording.credits.length > 0 && <span>{recording.credits.map((credit) => `${credit.role === "vocals" ? "Vocals" : credit.role}: ${credit.fullName}`).join(" · ")}</span>}
                      {recording.processingState === "ready"
                        ? <audio
                            controls
                            preload="metadata"
                            src={`/api/media/${encodeURIComponent(recording.playbackMediaId ?? recording.originalMediaId)}`}
                          />
                        : <span>{recording.processingState === "processing" ? "Preparing audio…" : "Audio needs attention"}</span>}
                    </div>
                    {isOnline && canEdit === true && (
                      <div className="media-item-actions">
                        <Link className="media-action" to={`/songs/${encodeURIComponent(song.id)}/recordings/${encodeURIComponent(recording.id)}/edit`}>Edit</Link>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="media-note">Some legacy formats may need a playback conversion.</p>
            </section>
          )}

          {song.scans.length > 0 && (
            <section className="detail-card" aria-labelledby="scans-title">
              <h2 id="scans-title">Scanned lyrics and notation <span>{song.scans.length}</span></h2>
              <ul className="media-list">
                {song.scans.map((scan) => (
                  <li key={scan.id}>
                    <div><strong>{scanDisplayName(scan)}</strong><span>{scan.filename}</span></div>
                    <div className="media-item-actions">
                      <button className="media-action" type="button" disabled={!isOnline} title={isOnline ? "View scan" : "Scans require an internet connection"} onClick={() => setViewerScanId(scan.id)}>View</button>
                      {isOnline && canEdit === true && <Link className="media-action" to={`/songs/${encodeURIComponent(song.id)}/scans/${encodeURIComponent(scan.id)}/edit`}>Edit</Link>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <aside><MetadataList song={song} /></aside>
      </div>
      {viewerScanId && <ScanViewer scans={song.scans} initialScanId={viewerScanId} onClose={() => setViewerScanId(null)} />}
    </main>
  );
}

function LyricEditorPage({
  mode,
  isOnline,
  canEdit,
}: {
  mode: "create" | "edit";
  isOnline: boolean;
  canEdit: boolean | null;
}) {
  const { songId = "", lyricId = "" } = useParams();
  const navigate = useNavigate();
  const [songTitle, setSongTitle] = useState("");
  const [content, setContent] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [isLegacyImport, setIsLegacyImport] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!isOnline || canEdit !== true) {
        setIsLoading(false);
        return;
      }
      try {
        const song = await refreshSong(songId);
        if (cancelled) return;
        setSongTitle(song.titleLatin);
        if (mode === "edit") {
          const lyric = song.lyricTexts.find((item) => item.id === lyricId);
          if (!lyric) {
            setError("These typed lyrics are no longer available.");
            return;
          }
          setContent(lyric.content);
          setRevision(lyric.revision);
          setIsLegacyImport(lyric.origin === "legacy_import");
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The typed-lyrics editor could not be loaded.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [canEdit, isOnline, lyricId, mode, songId]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isOnline || canEdit !== true || isSaving) return;
    setIsSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      if (mode === "create") {
        await createLyric(songId, content);
      } else {
        await updateLyric(songId, lyricId, content, revision ?? 0);
      }
      await refreshOfflineLibrary().catch(() => undefined);
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (saveError) {
      if (saveError instanceof ApiError) {
        setError(saveError.message);
        setFieldErrors(saveError.fields ?? {});
      } else {
        setError(saveError instanceof Error ? saveError.message : "The typed lyrics could not be saved.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function moveToTrash(): Promise<void> {
    if (
      mode !== "edit"
      || revision === null
      || !isOnline
      || canEdit !== true
      || isSaving
      || isTrashing
    ) return;
    const confirmed = window.confirm(
      "Move this typed-lyrics block to Trash? It will disappear from the Song but can be restored later.",
    );
    if (!confirmed) return;

    setIsTrashing(true);
    setError(null);
    try {
      await trashLyric(songId, lyricId, revision);
      await refreshOfflineLibrary().catch(() => undefined);
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (trashError) {
      setError(trashError instanceof Error ? trashError.message : "The typed lyrics could not be moved to Trash.");
    } finally {
      setIsTrashing(false);
    }
  }

  const songUrl = `/songs/${encodeURIComponent(songId)}`;
  if (!isOnline) {
    return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Cancel</Link><section className="empty-state"><h1>Editing is offline</h1><p>Reconnect to create or change typed lyrics. Saved lyrics remain available to read.</p></section></main>;
  }
  if (canEdit === null) return <main className="page-shell" id="main-content"><p>Checking editor access…</p></main>;
  if (!canEdit) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Song</Link><section className="empty-state"><h1>Editor access required</h1></section></main>;
  if (isLoading) return <main className="page-shell" id="main-content"><p>Loading typed lyrics…</p></main>;
  if (mode === "edit" && revision === null) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Song</Link><section className="empty-state"><h1>Typed lyrics unavailable</h1><p>{error}</p></section></main>;

  return (
    <main className="page-shell editor-page" id="main-content">
      <Link className="back-link" to={songUrl}>← Cancel</Link>
      <header className="editor-heading">
        <p className="eyebrow">{songTitle || "Song"}</p>
        <h1>{mode === "create" ? "Add typed lyrics" : "Edit typed lyrics"}</h1>
        <p className="lede">Spaces, blank lines, capitalization, and script are saved exactly as entered.</p>
        {isLegacyImport && <p className="editor-note">This is an imported combined block. It remains marked for the later split-and-review workflow.</p>}
      </header>
      {error && <p className="catalog-message error-message" role="alert">{error}</p>}
      <form className="song-form" onSubmit={(event) => { void submit(event); }}>
        <section className="form-card">
          <label className="form-field">
            <span>Typed lyrics <strong aria-hidden="true">*</strong></span>
            <textarea
              className="lyrics-input"
              required
              rows={22}
              maxLength={500_000}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              autoFocus
            />
            {fieldErrors.content?.map((message) => <em key={message}>{message}</em>)}
          </label>
        </section>
        <div className="form-actions">
          <Link className="secondary-action action-link" to={songUrl}>Cancel</Link>
          <button className="primary-action" type="submit" disabled={isSaving || isTrashing || content.trim().length === 0}>{isSaving ? "Saving…" : mode === "create" ? "Add lyrics" : "Save changes"}</button>
        </div>
      </form>
      {mode === "edit" && (
        <section className="danger-zone" aria-labelledby="remove-lyrics-title">
          <div>
            <h2 id="remove-lyrics-title">Remove these typed lyrics</h2>
            <p>This moves the block to Trash. It is not permanently deleted and can be restored.</p>
          </div>
          <button className="danger-action" type="button" disabled={isSaving || isTrashing} onClick={() => { void moveToTrash(); }}>{isTrashing ? "Moving…" : "Move to Trash"}</button>
        </section>
      )}
    </main>
  );
}

function ScanEditorPage({ isOnline, canEdit }: { isOnline: boolean; canEdit: boolean | null }) {
  const { songId = "", scanId = "" } = useParams();
  const navigate = useNavigate();
  const [options, setOptions] = useState<ScanEditorOptions | null>(null);
  const [songTitle, setSongTitle] = useState("");
  const [filename, setFilename] = useState("");
  const [notebookId, setNotebookId] = useState("");
  const [pageLabel, setPageLabel] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!isOnline || canEdit !== true) {
        setIsLoading(false);
        return;
      }
      try {
        const [editorOptions, song] = await Promise.all([
          loadScanEditorOptions(),
          refreshSong(songId),
        ]);
        if (cancelled) return;
        const scan = song.scans.find((item) => item.id === scanId);
        setOptions(editorOptions);
        setSongTitle(song.titleLatin);
        if (!scan) {
          setError("This Scan is no longer available.");
          return;
        }
        setFilename(scan.filename);
        setNotebookId(scan.notebookId ?? "");
        setPageLabel(scan.pageLabel ?? "");
        setRevision(scan.revision);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The Scan editor could not be loaded.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [canEdit, isOnline, scanId, songId]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isOnline || canEdit !== true || revision === null || isSaving || isTrashing) return;
    setIsSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      await updateScan(songId, scanId, {
        notebookId: notebookId || null,
        pageLabel: notebookId ? pageLabel || null : null,
        revision,
      });
      await refreshOfflineLibrary().catch(() => undefined);
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (saveError) {
      if (saveError instanceof ApiError) {
        setError(saveError.message);
        setFieldErrors(saveError.fields ?? {});
      } else {
        setError(saveError instanceof Error ? saveError.message : "The Scan could not be saved.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function moveToTrash(): Promise<void> {
    if (!isOnline || canEdit !== true || revision === null || isSaving || isTrashing) return;
    const confirmed = window.confirm(
      "Move this Scan to Trash? Its private file will be retained and can be restored later.",
    );
    if (!confirmed) return;

    setIsTrashing(true);
    setError(null);
    try {
      await trashScan(songId, scanId, revision);
      await refreshOfflineLibrary().catch(() => undefined);
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (trashError) {
      setError(trashError instanceof Error ? trashError.message : "The Scan could not be moved to Trash.");
    } finally {
      setIsTrashing(false);
    }
  }

  const songUrl = `/songs/${encodeURIComponent(songId)}`;
  if (!isOnline) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Cancel</Link><section className="empty-state"><h1>Editing is offline</h1><p>Reconnect to change or remove a Scan. Saved Song information remains available to read.</p></section></main>;
  if (canEdit === null) return <main className="page-shell" id="main-content"><p>Checking editor access…</p></main>;
  if (!canEdit) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Song</Link><section className="empty-state"><h1>Editor access required</h1></section></main>;
  if (isLoading) return <main className="page-shell" id="main-content"><p>Loading Scan…</p></main>;
  if (revision === null) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Song</Link><section className="empty-state"><h1>Scan unavailable</h1><p>{error}</p></section></main>;

  return (
    <main className="page-shell editor-page" id="main-content">
      <Link className="back-link" to={songUrl}>← Cancel</Link>
      <header className="editor-heading">
        <p className="eyebrow">{songTitle || "Song"}</p>
        <h1>Edit Scan</h1>
        <p className="lede">Choose a Notebook and optional Page, or leave both empty for an external Scan.</p>
      </header>
      {error && <p className="catalog-message error-message" role="alert">{error}</p>}
      <form className="song-form" onSubmit={(event) => { void submit(event); }}>
        <section className="form-card">
          <div className="form-file-summary">
            <span>Private file</span>
            <strong>{filename}</strong>
          </div>
          <label className="form-field">
            <span>Notebook</span>
            <select value={notebookId} onChange={(event) => {
              const value = event.target.value;
              setNotebookId(value);
              if (!value) setPageLabel("");
            }}>
              <option value="">No Notebook — external Scan</option>
              {options?.notebooks.map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.displayName}</option>)}
            </select>
            {fieldErrors.notebookId?.map((message) => <em key={message}>{message}</em>)}
          </label>
          {notebookId && (
            <label className="form-field compact-field">
              <span>Page</span>
              <input maxLength={100} value={pageLabel} onChange={(event) => setPageLabel(event.target.value)} placeholder="For example: 12A or cover" />
              {fieldErrors.pageLabel?.map((message) => <em key={message}>{message}</em>)}
            </label>
          )}
        </section>
        <div className="form-actions">
          <Link className="secondary-action action-link" to={songUrl}>Cancel</Link>
          <button className="primary-action" type="submit" disabled={isSaving || isTrashing}>{isSaving ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
      <section className="danger-zone" aria-labelledby="remove-scan-title">
        <div>
          <h2 id="remove-scan-title">Remove this Scan</h2>
          <p>This moves both the Scan and its private file to recoverable Trash. Nothing is permanently deleted.</p>
        </div>
        <button className="danger-action" type="button" disabled={isSaving || isTrashing} onClick={() => { void moveToTrash(); }}>{isTrashing ? "Moving…" : "Move to Trash"}</button>
      </section>
    </main>
  );
}

function RecordingEditorPage({ isOnline, canEdit }: { isOnline: boolean; canEdit: boolean | null }) {
  const { songId = "", recordingId = "" } = useParams();
  const navigate = useNavigate();
  const [options, setOptions] = useState<RecordingEditorOptions | null>(null);
  const [songTitle, setSongTitle] = useState("");
  const [filename, setFilename] = useState("");
  const [description, setDescription] = useState("");
  const [recordedOn, setRecordedOn] = useState("");
  const [vocalistIds, setVocalistIds] = useState<string[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!isOnline || canEdit !== true) {
        setIsLoading(false);
        return;
      }
      try {
        const [editorOptions, song] = await Promise.all([
          loadRecordingEditorOptions(),
          refreshSong(songId),
        ]);
        if (cancelled) return;
        const recording = song.recordings.find((item) => item.id === recordingId);
        setOptions(editorOptions);
        setSongTitle(song.titleLatin);
        if (!recording) {
          setError("This Recording is no longer available.");
          return;
        }
        setFilename(recording.filename);
        setDescription(recording.description);
        setRecordedOn(recording.recordedOn ?? "");
        setVocalistIds(recording.credits.filter((credit) => credit.role === "vocals").map((credit) => credit.personId));
        setRevision(recording.revision);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The Recording editor could not be loaded.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [canEdit, isOnline, recordingId, songId]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isOnline || canEdit !== true || revision === null || isSaving || isTrashing) return;
    setIsSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      await updateRecording(songId, recordingId, {
        description,
        recordedOn: recordedOn || null,
        creditPersonIds: vocalistIds,
        revision,
      });
      await refreshOfflineLibrary().catch(() => undefined);
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (saveError) {
      if (saveError instanceof ApiError) {
        setError(saveError.message);
        setFieldErrors(saveError.fields ?? {});
      } else {
        setError(saveError instanceof Error ? saveError.message : "The Recording could not be saved.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function moveToTrash(): Promise<void> {
    if (!isOnline || canEdit !== true || revision === null || isSaving || isTrashing) return;
    const confirmed = window.confirm(
      "Move this Recording to Trash? Its original audio and any playback copy will be retained for recovery.",
    );
    if (!confirmed) return;
    setIsTrashing(true);
    setError(null);
    try {
      await trashRecording(songId, recordingId, revision);
      await refreshOfflineLibrary().catch(() => undefined);
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (trashError) {
      setError(trashError instanceof Error ? trashError.message : "The Recording could not be moved to Trash.");
    } finally {
      setIsTrashing(false);
    }
  }

  const songUrl = `/songs/${encodeURIComponent(songId)}`;
  if (!isOnline) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Cancel</Link><section className="empty-state"><h1>Editing is offline</h1><p>Reconnect to change or remove a Recording. Saved Song information remains available to read.</p></section></main>;
  if (canEdit === null) return <main className="page-shell" id="main-content"><p>Checking editor access…</p></main>;
  if (!canEdit) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Song</Link><section className="empty-state"><h1>Editor access required</h1></section></main>;
  if (isLoading) return <main className="page-shell" id="main-content"><p>Loading Recording…</p></main>;
  if (revision === null) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Song</Link><section className="empty-state"><h1>Recording unavailable</h1><p>{error}</p></section></main>;

  return (
    <main className="page-shell editor-page" id="main-content">
      <Link className="back-link" to={songUrl}>← Cancel</Link>
      <header className="editor-heading">
        <p className="eyebrow">{songTitle || "Song"}</p>
        <h1>Edit Recording</h1>
        <p className="lede">Describe this take, optionally record its date, and select any known vocalists.</p>
      </header>
      {error && <p className="catalog-message error-message" role="alert">{error}</p>}
      <form className="song-form" onSubmit={(event) => { void submit(event); }}>
        <section className="form-card">
          <div className="form-file-summary">
            <span>Private original file</span>
            <strong>{filename}</strong>
          </div>
          <label className="form-field">
            <span>Recording description <strong aria-hidden="true">*</strong></span>
            <textarea required rows={5} maxLength={10_000} value={description} onChange={(event) => setDescription(event.target.value)} />
            <small>Use this for details such as an old verse, alternate tune, incomplete take, or accompaniment. Capitalization is preserved.</small>
            {fieldErrors.description?.map((message) => <em key={message}>{message}</em>)}
          </label>
          <label className="form-field compact-field">
            <span>Recorded date</span>
            <input type="date" max={new Date().toISOString().slice(0, 10)} value={recordedOn} onChange={(event) => setRecordedOn(event.target.value)} />
            {fieldErrors.recordedOn?.map((message) => <em key={message}>{message}</em>)}
          </label>
        </section>
        <fieldset className="form-card choice-group">
          <legend>Vocals</legend>
          <p>Optional. Select the people who sang in this Recording.</p>
          <div className="choice-grid">
            {options?.people.map((person) => (
              <label key={person.id}><input type="checkbox" checked={vocalistIds.includes(person.id)} onChange={(event) => setVocalistIds(selected(vocalistIds, person.id, event.target.checked))} /><span>{person.fullName}</span></label>
            ))}
          </div>
          {fieldErrors.creditPersonIds?.map((message) => <em key={message}>{message}</em>)}
        </fieldset>
        <div className="form-actions">
          <Link className="secondary-action action-link" to={songUrl}>Cancel</Link>
          <button className="primary-action" type="submit" disabled={isSaving || isTrashing || description.trim().length === 0}>{isSaving ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
      <section className="danger-zone" aria-labelledby="remove-recording-title">
        <div>
          <h2 id="remove-recording-title">Remove this Recording</h2>
          <p>This moves the Recording and its unshared private audio files to recoverable Trash. Nothing is permanently deleted.</p>
        </div>
        <button className="danger-action" type="button" disabled={isSaving || isTrashing} onClick={() => { void moveToTrash(); }}>{isTrashing ? "Moving…" : "Move to Trash"}</button>
      </section>
    </main>
  );
}

function TrashPage({ isOnline, canEdit }: { isOnline: boolean; canEdit: boolean | null }) {
  const [songs, setSongs] = useState<TrashedSong[]>([]);
  const [lyrics, setLyrics] = useState<TrashedLyric[]>([]);
  const [scans, setScans] = useState<TrashedScan[]>([]);
  const [recordings, setRecordings] = useState<TrashedRecording[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!isOnline || canEdit !== true) {
        setIsLoading(false);
        return;
      }
      try {
        const result = await loadTrash();
        if (!cancelled) {
          setSongs(result.songs);
          setLyrics(result.lyrics);
          setScans(result.scans);
          setRecordings(result.recordings);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Trash could not be loaded.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [canEdit, isOnline]);

  async function restore(lyric: TrashedLyric): Promise<void> {
    if (!isOnline || canEdit !== true || restoringId !== null || lyric.songIsTrashed) return;
    setRestoringId(lyric.id);
    setError(null);
    try {
      await restoreLyric(lyric.id, lyric.revision);
      await refreshOfflineLibrary().catch(() => undefined);
      setLyrics((current) => current.filter((item) => item.id !== lyric.id));
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "The typed lyrics could not be restored.");
    } finally {
      setRestoringId(null);
    }
  }

  async function restoreTrashedScan(scan: TrashedScan): Promise<void> {
    if (!isOnline || canEdit !== true || restoringId !== null || scan.songIsTrashed) return;
    setRestoringId(scan.id);
    setError(null);
    try {
      await restoreScan(scan.id, scan.revision);
      await refreshOfflineLibrary().catch(() => undefined);
      setScans((current) => current.filter((item) => item.id !== scan.id));
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "The Scan could not be restored.");
    } finally {
      setRestoringId(null);
    }
  }

  async function restoreTrashedRecording(recording: TrashedRecording): Promise<void> {
    if (!isOnline || canEdit !== true || restoringId !== null || recording.songIsTrashed) return;
    setRestoringId(recording.id);
    setError(null);
    try {
      await restoreRecording(recording.id, recording.revision);
      await refreshOfflineLibrary().catch(() => undefined);
      setRecordings((current) => current.filter((item) => item.id !== recording.id));
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "The Recording could not be restored.");
    } finally {
      setRestoringId(null);
    }
  }

  async function restoreTrashedSong(song: TrashedSong): Promise<void> {
    const restoreKey = `song:${song.id}`;
    if (!isOnline || canEdit !== true || restoringId !== null) return;
    setRestoringId(restoreKey);
    setError(null);
    try {
      await restoreSong(song.id, song.revision);
      await refreshOfflineLibrary().catch(() => undefined);
      setSongs((current) => current.filter((item) => item.id !== song.id));
      setLyrics((current) => current.map((item) => item.songId === song.id ? { ...item, songIsTrashed: false } : item));
      setScans((current) => current.map((item) => item.songId === song.id ? { ...item, songIsTrashed: false } : item));
      setRecordings((current) => current.map((item) => item.songId === song.id ? { ...item, songIsTrashed: false } : item));
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "The Song could not be restored.");
    } finally {
      setRestoringId(null);
    }
  }

  if (!isOnline) {
    return <main className="page-shell" id="main-content"><section className="empty-state"><h1>Trash is available online</h1><p>Reconnect to review or restore removed items. Your saved library remains available to read.</p></section></main>;
  }
  if (canEdit === null) return <main className="page-shell" id="main-content"><p>Checking editor access…</p></main>;
  if (!canEdit) return <main className="page-shell" id="main-content"><section className="empty-state"><h1>Editor access required</h1></section></main>;

  return (
    <main className="page-shell trash-page" id="main-content">
      <header className="catalog-heading">
        <div>
          <p className="eyebrow">Recovery</p>
          <h1>Trash</h1>
          <p className="lede">Removed items stay here indefinitely unless a future permanent-cleanup policy is approved.</p>
        </div>
      </header>
      {error && <p className="catalog-message error-message" role="alert">{error}</p>}
      {isLoading ? (
        <section className="empty-state"><p>Loading Trash…</p></section>
      ) : songs.length === 0 && lyrics.length === 0 && scans.length === 0 && recordings.length === 0 ? (
        <section className="empty-state"><div className="empty-mark" aria-hidden="true">✓</div><h2>Trash is empty</h2><p>Removed Songs, typed lyrics, Scans, and Recordings will appear here.</p></section>
      ) : (
        <div className="trash-sections">
          {songs.length > 0 && (
            <section className="trash-section" aria-labelledby="trashed-songs-title">
              <h2 id="trashed-songs-title">Songs <span>{songs.length}</span></h2>
              <ol className="trash-list" aria-label="Trashed Songs">
                {songs.map((song) => {
                  const restoreKey = `song:${song.id}`;
                  const childSummary = [
                    song.lyricCount > 0 ? `${song.lyricCount} typed lyrics` : "",
                    song.scanCount > 0 ? `${song.scanCount} Scans` : "",
                    song.recordingCount > 0 ? `${song.recordingCount} Recordings` : "",
                  ].filter(Boolean).join(" · ");
                  return (
                    <li className="detail-card trash-item" key={song.id}>
                      <div className="trash-item-heading">
                        <div>
                          <span>Song</span>
                          <strong>{song.titleLatin}</strong>
                          {song.titleNative && <small>{song.titleNative}</small>}
                          <small>{childSummary ? `${childSummary} · ` : ""}moved {new Date(song.trashedAt).toLocaleString()}</small>
                        </div>
                        <button className="primary-action" type="button" disabled={restoringId !== null} onClick={() => { void restoreTrashedSong(song); }}>{restoringId === restoreKey ? "Restoring…" : "Restore"}</button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
          {recordings.length > 0 && (
            <section className="trash-section" aria-labelledby="trashed-recordings-title">
              <h2 id="trashed-recordings-title">Recordings <span>{recordings.length}</span></h2>
              <ol className="trash-list" aria-label="Trashed Recordings">
                {recordings.map((recording) => (
                  <li className="detail-card trash-item" key={recording.id}>
                    <div className="trash-item-heading">
                      <div>
                        <span>Recording · {recording.description}</span>
                        {recording.songIsTrashed
                          ? <strong>{recording.songTitle}</strong>
                          : <Link to={`/songs/${encodeURIComponent(recording.songId)}`}>{recording.songTitle}</Link>}
                        <small>{[recording.recordedOn, recording.filename].filter(Boolean).join(" · ")} · moved {new Date(recording.trashedAt).toLocaleString()}</small>
                      </div>
                      <button className="primary-action" type="button" disabled={restoringId !== null || recording.songIsTrashed} onClick={() => { void restoreTrashedRecording(recording); }}>{restoringId === recording.id ? "Restoring…" : "Restore"}</button>
                    </div>
                    {recording.songIsTrashed && <p className="media-note">Restore the parent Song before restoring this Recording.</p>}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {scans.length > 0 && (
            <section className="trash-section" aria-labelledby="trashed-scans-title">
              <h2 id="trashed-scans-title">Scans <span>{scans.length}</span></h2>
              <ol className="trash-list" aria-label="Trashed Scans">
                {scans.map((scan) => (
                  <li className="detail-card trash-item" key={scan.id}>
                    <div className="trash-item-heading">
                      <div>
                        <span>Scan · {[scan.notebookName, scan.pageLabel].filter(Boolean).join(" · ") || "External"}</span>
                        {scan.songIsTrashed
                          ? <strong>{scan.songTitle}</strong>
                          : <Link to={`/songs/${encodeURIComponent(scan.songId)}`}>{scan.songTitle}</Link>}
                        <small>{scan.filename} · moved {new Date(scan.trashedAt).toLocaleString()}</small>
                      </div>
                      <button className="primary-action" type="button" disabled={restoringId !== null || scan.songIsTrashed} onClick={() => { void restoreTrashedScan(scan); }}>{restoringId === scan.id ? "Restoring…" : "Restore"}</button>
                    </div>
                    {scan.songIsTrashed && <p className="media-note">Restore the parent Song before restoring this Scan.</p>}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {lyrics.length > 0 && (
            <section className="trash-section" aria-labelledby="trashed-lyrics-title">
              <h2 id="trashed-lyrics-title">Typed lyrics <span>{lyrics.length}</span></h2>
              <ol className="trash-list" aria-label="Trashed typed lyrics">
                {lyrics.map((lyric) => (
                  <li className="detail-card trash-item" key={lyric.id}>
                    <div className="trash-item-heading">
                      <div>
                        <span>Typed lyrics</span>
                        {lyric.songIsTrashed
                          ? <strong>{lyric.songTitle}</strong>
                          : <Link to={`/songs/${encodeURIComponent(lyric.songId)}`}>{lyric.songTitle}</Link>}
                        <small>Moved {new Date(lyric.trashedAt).toLocaleString()}</small>
                      </div>
                      <button className="primary-action" type="button" disabled={restoringId !== null || lyric.songIsTrashed} onClick={() => { void restore(lyric); }}>{restoringId === lyric.id ? "Restoring…" : "Restore"}</button>
                    </div>
                    {lyric.songIsTrashed && <p className="media-note">Restore the parent Song before restoring this block.</p>}
                    <details className="trash-preview">
                      <summary>View content</summary>
                      <pre>{lyric.content}</pre>
                    </details>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}
    </main>
  );
}

type SongFormState = {
  titleLatin: string;
  titleNative: string;
  status: "draft" | "checked";
  languageIds: string[];
  tagIds: string[];
  lyricsPersonIds: string[];
  musicPersonIds: string[];
  aliasesText: string;
  notes: string;
  revision: number | null;
};

const EMPTY_SONG_FORM: SongFormState = {
  titleLatin: "",
  titleNative: "",
  status: "draft",
  languageIds: [],
  tagIds: [],
  lyricsPersonIds: [],
  musicPersonIds: [],
  aliasesText: "",
  notes: "",
  revision: null,
};

function titleCaseInput(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    .toLocaleLowerCase("en")
    .replace(/(^|[^\p{L}\p{M}])(\p{L})/gu, (_match, prefix: string, letter: string) => (
      `${prefix}${letter.toLocaleUpperCase("en")}`
    ));
}

function selected(values: string[], value: string, checked: boolean): string[] {
  if (checked) return values.includes(value) ? values : [...values, value];
  return values.filter((item) => item !== value);
}

function SongEditorPage({
  mode,
  isOnline,
  canEdit,
}: {
  mode: "create" | "edit";
  isOnline: boolean;
  canEdit: boolean | null;
}) {
  const { songId = "" } = useParams();
  const navigate = useNavigate();
  const [options, setOptions] = useState<SongEditorOptions | null>(null);
  const [form, setForm] = useState<SongFormState>(EMPTY_SONG_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [childCounts, setChildCounts] = useState({ lyricTexts: 0, scans: 0, recordings: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!isOnline || canEdit !== true) {
        setIsLoading(false);
        return;
      }
      try {
        const [editorOptions, song] = await Promise.all([
          loadSongEditorOptions(),
          mode === "edit" ? refreshSong(songId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setOptions(editorOptions);
        if (song) {
          setForm({
            titleLatin: song.titleLatin,
            titleNative: song.titleNative ?? "",
            status: song.status === "checked" ? "checked" : "draft",
            languageIds: song.languages.map((language) => language.id),
            tagIds: song.tags.map((tag) => tag.id),
            lyricsPersonIds: song.credits.filter((credit) => credit.role === "lyrics").map((credit) => credit.personId),
            musicPersonIds: song.credits.filter((credit) => credit.role === "music").map((credit) => credit.personId),
            aliasesText: song.aliases.join("\n"),
            notes: song.notes ?? "",
            revision: song.revision,
          });
          setChildCounts({
            lyricTexts: song.lyricTexts.length,
            scans: song.scans.length,
            recordings: song.recordings.length,
          });
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The editor could not be loaded.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [canEdit, isOnline, mode, songId]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isOnline || canEdit !== true || isSaving || isTrashing) return;
    setIsSaving(true);
    setError(null);
    setFieldErrors({});
    const payload: SongWritePayload = {
      titleLatin: form.titleLatin,
      titleNative: form.titleNative || null,
      status: form.status,
      languageIds: form.languageIds,
      tagIds: form.tagIds,
      aliases: form.aliasesText.split(/\r?\n/u).map((alias) => alias.trim()).filter(Boolean),
      credits: [
        ...form.lyricsPersonIds.map((personId) => ({ personId, role: "lyrics" as const })),
        ...form.musicPersonIds.map((personId) => ({ personId, role: "music" as const })),
      ],
      notes: form.notes || null,
    };
    try {
      const saved = mode === "create"
        ? await createSong(payload)
        : await updateSong(songId, { ...payload, revision: form.revision ?? 0 });
      await refreshOfflineLibrary().catch(() => undefined);
      navigate(`/songs/${encodeURIComponent(saved.id)}`, { replace: true });
    } catch (saveError) {
      if (saveError instanceof ApiError) {
        setError(saveError.message);
        setFieldErrors(saveError.fields ?? {});
      } else {
        setError(saveError instanceof Error ? saveError.message : "The song could not be saved.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function moveSongToTrash(): Promise<void> {
    if (mode !== "edit" || !isOnline || canEdit !== true || form.revision === null || isSaving || isTrashing) return;
    if (childCounts.lyricTexts + childCounts.scans + childCounts.recordings > 0) return;
    const confirmed = window.confirm(
      "Move this Song to Trash? Its metadata and relationships will be retained and can be restored later.",
    );
    if (!confirmed) return;
    setIsTrashing(true);
    setError(null);
    try {
      await trashSong(songId, form.revision);
      await refreshOfflineLibrary().catch(() => undefined);
      navigate("/songs", { replace: true });
    } catch (trashError) {
      setError(trashError instanceof Error ? trashError.message : "The Song could not be moved to Trash.");
    } finally {
      setIsTrashing(false);
    }
  }

  if (!isOnline) {
    return <main className="page-shell" id="main-content"><Link className="back-link" to={mode === "edit" ? `/songs/${encodeURIComponent(songId)}` : "/songs"}>← Cancel</Link><section className="empty-state"><h1>Editing is offline</h1><p>Reconnect to create or change a song. Your saved library remains available to read.</p></section></main>;
  }
  if (canEdit === null) {
    return <main className="page-shell" id="main-content"><p>Checking editor access…</p></main>;
  }
  if (!canEdit) {
    return <main className="page-shell" id="main-content"><Link className="back-link" to="/songs">← All songs</Link><section className="empty-state"><h1>Editor access required</h1></section></main>;
  }
  if (isLoading) return <main className="page-shell" id="main-content"><p>Loading editor…</p></main>;

  return (
    <main className="page-shell editor-page" id="main-content">
      <Link className="back-link" to={mode === "edit" ? `/songs/${encodeURIComponent(songId)}` : "/songs"}>← Cancel</Link>
      <header className="editor-heading">
        <p className="eyebrow">Online editing</p>
        <h1>{mode === "create" ? "Add song" : "Edit song"}</h1>
        <p className="lede">Required fields are marked. Changes are saved immediately to the private library.</p>
      </header>
      {error && <p className="catalog-message error-message" role="alert">{error}</p>}
      <form className="song-form" onSubmit={(event) => { void submit(event); }}>
        <section className="form-card">
          <label className="form-field">
            <span>Latin or transliterated title <strong aria-hidden="true">*</strong></span>
            <input required maxLength={200} value={form.titleLatin} onChange={(event) => setForm({ ...form, titleLatin: event.target.value })} onBlur={() => setForm((current) => ({ ...current, titleLatin: titleCaseInput(current.titleLatin) }))} />
            <small>Capitalization and repeated spaces are corrected automatically.</small>
            {fieldErrors.titleLatin?.map((message) => <em key={message}>{message}</em>)}
          </label>
          <label className="form-field">
            <span>Native-script title</span>
            <input maxLength={200} value={form.titleNative} onChange={(event) => setForm({ ...form, titleNative: event.target.value })} />
          </label>
          <label className="form-field compact-field">
            <span>Status <strong aria-hidden="true">*</strong></span>
            <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as "draft" | "checked" })}>
              <option value="draft">Draft</option>
              <option value="checked">Checked</option>
            </select>
          </label>
        </section>

        <fieldset className="form-card choice-group">
          <legend>Languages <strong aria-hidden="true">*</strong></legend>
          <p>Select at least one.</p>
          <div className="choice-grid">
            {options?.languages.map((language) => (
              <label key={language.id}><input type="checkbox" checked={form.languageIds.includes(language.id)} onChange={(event) => setForm({ ...form, languageIds: selected(form.languageIds, language.id, event.target.checked) })} /><span>{language.displayName}</span></label>
            ))}
          </div>
          {fieldErrors.languageIds?.map((message) => <em key={message}>{message}</em>)}
        </fieldset>

        <fieldset className="form-card choice-group">
          <legend>Tags</legend>
          <div className="choice-grid">
            {options?.tags.map((tag) => (
              <label key={tag.id}><input type="checkbox" checked={form.tagIds.includes(tag.id)} onChange={(event) => setForm({ ...form, tagIds: selected(form.tagIds, tag.id, event.target.checked) })} /><span>{tag.displayName}</span></label>
            ))}
          </div>
        </fieldset>

        <fieldset className="form-card choice-group credit-choice-group">
          <legend>Song contributors</legend>
          <p>Optional. A Person may be credited for Lyrics, Music, or both.</p>
          <div className="credit-grid">
            <div className="credit-grid-header" aria-hidden="true"><span>Person</span><span>Lyrics</span><span>Music</span></div>
            {options?.people.map((person) => (
              <div className="credit-grid-row" key={person.id}>
                <span>{person.fullName}</span>
                <label><input type="checkbox" aria-label={`${person.fullName}: Lyrics`} checked={form.lyricsPersonIds.includes(person.id)} onChange={(event) => setForm({ ...form, lyricsPersonIds: selected(form.lyricsPersonIds, person.id, event.target.checked) })} /></label>
                <label><input type="checkbox" aria-label={`${person.fullName}: Music`} checked={form.musicPersonIds.includes(person.id)} onChange={(event) => setForm({ ...form, musicPersonIds: selected(form.musicPersonIds, person.id, event.target.checked) })} /></label>
              </div>
            ))}
          </div>
          {fieldErrors.credits?.map((message) => <em key={message}>{message}</em>)}
        </fieldset>

        <section className="form-card">
          <label className="form-field">
            <span>Aliases</span>
            <textarea rows={4} value={form.aliasesText} onChange={(event) => setForm({ ...form, aliasesText: event.target.value })} placeholder="One alternative title per line" />
            <small>Each alias is normalized to title case and kept unique within this song.</small>
            {fieldErrors.aliases?.map((message) => <em key={message}>{message}</em>)}
          </label>
          <label className="form-field">
            <span>Song notes</span>
            <textarea rows={7} maxLength={50_000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </label>
        </section>

        <div className="form-actions">
          <Link className="secondary-action action-link" to={mode === "edit" ? `/songs/${encodeURIComponent(songId)}` : "/songs"}>Cancel</Link>
          <button className="primary-action" type="submit" disabled={isSaving || isTrashing || form.languageIds.length === 0 || form.titleLatin.trim().length === 0}>{isSaving ? "Saving…" : mode === "create" ? "Add song" : "Save changes"}</button>
        </div>
      </form>
      {mode === "edit" && (
        <section className="danger-zone" aria-labelledby="remove-song-title">
          <div>
            <h2 id="remove-song-title">Remove this Song</h2>
            {childCounts.lyricTexts + childCounts.scans + childCounts.recordings > 0
              ? <p>Move its active content to Trash first: {[childCounts.lyricTexts ? `${childCounts.lyricTexts} typed lyrics` : "", childCounts.scans ? `${childCounts.scans} Scans` : "", childCounts.recordings ? `${childCounts.recordings} Recordings` : ""].filter(Boolean).join(" · ")}.</p>
              : <p>This moves the Song to recoverable Trash. Nothing is permanently deleted.</p>}
          </div>
          <button className="danger-action" type="button" disabled={isSaving || isTrashing || childCounts.lyricTexts + childCounts.scans + childCounts.recordings > 0} onClick={() => { void moveSongToTrash(); }}>{isTrashing ? "Moving…" : "Move to Trash"}</button>
        </section>
      )}
    </main>
  );
}

function AccountPage({ session }: { session: AppSession | null }) {
  return (
    <main className="page-shell account-page" id="main-content">
      <p className="eyebrow">Application</p>
      <h1>Account and sync</h1>
      <dl className="settings-list">
        <div>
          <dt>Signed in as</dt>
          <dd>{session?.displayName ?? "Authenticated user"}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{session?.role ?? "Unavailable"}</dd>
        </div>
      </dl>
    </main>
  );
}

export function App() {
  const isOnline = useOnlineStatus();
  const [session, setSession] = useState<AppSession | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!isOnline) return () => { cancelled = true; };
    setSessionResolved(false);
    loadSession().then((user) => {
      if (!cancelled) {
        setSession(user);
        setSessionResolved(true);
      }
    }).catch(() => {
      if (!cancelled) {
        setSession(null);
        setSessionResolved(true);
      }
    });
    return () => { cancelled = true; };
  }, [isOnline]);

  const canEdit = !sessionResolved ? null : session?.role === "editor" || session?.role === "admin";

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="app-header">
        <Link className="brand" to="/songs" aria-label="Music Library home">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>Music Library</span>
        </Link>
        <span className={isOnline ? "connection online" : "connection offline"} role="status">
          <span aria-hidden="true" />
          {isOnline ? "Online" : "Offline · read only"}
        </span>
      </header>

      <Routes>
        <Route path="/songs" element={<SongsPage isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/new" element={<SongEditorPage mode="create" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/edit" element={<SongEditorPage mode="edit" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/lyrics/new" element={<LyricEditorPage mode="create" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/lyrics/:lyricId/edit" element={<LyricEditorPage mode="edit" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/scans/:scanId/edit" element={<ScanEditorPage isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/recordings/:recordingId/edit" element={<RecordingEditorPage isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId" element={<SongDetailPage isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/trash" element={<TrashPage isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/account" element={<AccountPage session={session} />} />
        <Route path="*" element={<Navigate to="/songs" replace />} />
      </Routes>

      <nav className="bottom-nav" aria-label="Primary navigation">
        <Link to="/songs">Songs</Link>
        {canEdit === true && <Link to="/trash">Trash</Link>}
        <Link to="/account">Account</Link>
      </nav>
    </div>
  );
}
