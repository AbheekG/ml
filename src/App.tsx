import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { ScanViewer } from "./ScanViewer";
import { ActionContent } from "./ActionContent";
import { CatalogControls } from "./CatalogControls";
import { RecordingUploadPage } from "./RecordingUploadPage";
import { RecordingDateField } from "./RecordingDateField";
import { CreditRows } from "./CreditRows";
import { MoveToSongForm } from "./MoveToSongForm";
import { FeedbackMessage, useRevealFeedback } from "./FeedbackMessage";
import { LookupTabs, lookupPanelId, lookupTabId } from "./LookupTabs";
import {
  UnsavedChangesProvider,
  editorValuesChanged,
  shouldRefreshEditor,
  useUnsavedChanges,
} from "./UnsavedChanges";
import { pauseOtherAudioPlayers } from "./audio-playback";
import { copyTextBlock, shareTextBlock, supportsSystemTextShare } from "./text-sharing";
import {
  ApiError,
  clearPrivateLocalData,
  createLookup,
  createLyric,
  createScan,
  createSong,
  loadRecordingEditorOptions,
  loadLookups,
  loadTrash,
  moveTrashedRecording,
  moveTrashedScan,
  loadScanEditorOptions,
  loadSession,
  loadSongEditorOptions,
  readCachedCatalog,
  readCachedSong,
  refreshOfflineLibrary,
  refreshSong,
  replaceScanMedia,
  retryRecordingProcessing,
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
  updateLookup,
  updateSong,
  type AppSession,
  type ActiveSongOption,
  type CatalogSong,
  type DuplicateScanDetails,
  type RecordingEditorOptions,
  type LookupCollections,
  type LookupItem,
  type LookupKind,
  type SongEditorOptions,
  type SongDetail,
  type SongWritePayload,
  type ScanEditorOptions,
  type TrashedLyric,
  type TrashedRecording,
  type TrashedScan,
  type TrashedSong,
} from "./catalog";
import {
  filterAndSortCatalog,
  initialCatalogViewState,
  type CatalogViewState,
} from "./catalog-view";
import { findSimilarLookupItems } from "./lookup-similarity";
import { shouldOfferDirectCameraCapture } from "./device-capabilities";
import { scanDisplayName, scanPositionLabel } from "./scan-viewer";
import {
  isShareAbort,
  loadOptimizedScanShareFile,
  rotateOptimizedScanShareFile,
  ScanSharingError,
  shareOptimizedScanFile,
  supportsOptimizedScanSharing,
} from "./scan-sharing";
import {
  isRecordingShareTooLarge,
  loadRecordingShareFile,
  MAX_RECORDING_SHARE_BYTES,
  RecordingSharingError,
  shareRecordingFile,
  supportsRecordingSharing,
} from "./recording-sharing";
import {
  preserveSessionResolutionDuringRevalidation,
  subscribeToBrowserConnectivity,
} from "./app-lifecycle";
import {
  PRIVATE_CACHE_NAMESPACE_KEY,
  PRIVATE_DATA_BARRIER_KEY,
  PRIVATE_DATA_CHANNEL_NAME,
  PENDING_ACCESS_LOGOUT_KEY,
  completePendingAccessLogout,
  isAccessLogoutPending,
  isPrivateDataBlocked,
  isPrivateDataClearedMessage,
  logoutAndClearPrivateData,
  reconcilePrivateDataSession,
} from "./private-data";

function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => subscribeToBrowserConnectivity(window, () => navigator.onLine, setIsOnline), []);

  return isOnline;
}

function SongsPage({
  isOnline,
  canEdit,
  view,
  onViewChange,
  scrollPosition,
}: {
  isOnline: boolean;
  canEdit: boolean | null;
  view: CatalogViewState;
  onViewChange: (view: CatalogViewState) => void;
  scrollPosition: { current: number };
}) {
  const [songs, setSongs] = useState<CatalogSong[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const restoredScroll = useRef(false);

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

  useLayoutEffect(() => {
    if (restoredScroll.current || (isLoading && songs.length === 0)) return;
    restoredScroll.current = true;
    window.scrollTo({ top: scrollPosition.current, left: 0, behavior: "auto" });
  }, [isLoading, scrollPosition, songs.length]);

  useLayoutEffect(() => {
    const rememberScroll = () => {
      if (!restoredScroll.current) return;
      scrollPosition.current = window.scrollY;
    };
    window.addEventListener("scroll", rememberScroll, { passive: true });
    return () => window.removeEventListener("scroll", rememberScroll);
  }, [scrollPosition]);

  const visibleSongs = filterAndSortCatalog(songs, view.query, view.filters, view.sort);

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
          ? <Link className="primary-action action-link icon-text-action" to="/songs/new"><ActionContent kind="add" label="Add song" /></Link>
          : <button className="primary-action icon-text-action" type="button" disabled title={isOnline ? "Editor access is required" : "Go online to add a song"}><ActionContent kind="add" label="Add song" /></button>}
      </section>

      <CatalogControls
        songs={songs}
        query={view.query}
        filters={view.filters}
        sort={view.sort}
        onQueryChange={(query) => onViewChange({ ...view, query })}
        onFiltersChange={(filters) => onViewChange({ ...view, filters })}
        onSortChange={(sort) => onViewChange({ ...view, sort })}
      />

      {error && <p className="catalog-message error-message" role="alert">{error}</p>}
      {syncedAt && <p className="sync-note">Available offline · updated {new Date(syncedAt).toLocaleString()}</p>}

      {isLoading && songs.length === 0 ? (
        <section className="empty-state"><p>Loading the local catalog…</p></section>
      ) : visibleSongs.length > 0 ? (
        <ol className="song-list" aria-label="Songs">
          {visibleSongs.map((song) => (
            <li key={song.id}>
              <Link
                className="song-row"
                to={`/songs/${encodeURIComponent(song.id)}`}
                onClick={() => { scrollPosition.current = window.scrollY; }}
              >
                <span className="song-titles">
                  <strong>{song.titleLatin}</strong>
                  {song.titleNative && <span lang="und">{song.titleNative}</span>}
                </span>
                <span className="song-meta">
                  {song.languages.map((language) => language.displayName).join(" · ")}
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
          <p>{songs.length > 0 ? "Try a different title or clear some filters." : "Run the verified local import to load songs."}</p>
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
  const [scanShareBusy, setScanShareBusy] = useState<{ scanId: string; phase: "preparing" | "sharing" } | null>(null);
  const [preparedScanShare, setPreparedScanShare] = useState<{
    scanId: string;
    rotationQuarterTurns: 0 | 1 | 2 | 3;
    file: File;
  } | null>(null);
  const [scanShareFeedback, setScanShareFeedback] = useState<{ scanId: string; message: string; isError: boolean } | null>(null);
  const scanShareAbortRef = useRef<AbortController | null>(null);
  const scanShareGenerationRef = useRef(0);
  const [recordingShareBusy, setRecordingShareBusy] = useState<{ recordingId: string; phase: "preparing" | "sharing" } | null>(null);
  const [preparedRecordingShare, setPreparedRecordingShare] = useState<{ recordingId: string; file: File } | null>(null);
  const [recordingShareFeedback, setRecordingShareFeedback] = useState<{ recordingId: string; message: string; isError: boolean } | null>(null);
  const recordingShareAbortRef = useRef<AbortController | null>(null);
  const recordingShareGenerationRef = useRef(0);
  const recordingSharingAvailable = typeof navigator !== "undefined"
    && supportsRecordingSharing();
  const recordingPlayers = useRef(new Map<string, HTMLAudioElement>());
  const [retryingRecordingId, setRetryingRecordingId] = useState<string | null>(null);
  const [processingRetryError, setProcessingRetryError] = useState<string | null>(null);
  const [lyricAction, setLyricAction] = useState<{
    lyricId: string;
    busy: boolean;
    message: string;
    isError: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [songId]);

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

  useEffect(() => {
    scanShareGenerationRef.current += 1;
    scanShareAbortRef.current?.abort();
    scanShareAbortRef.current = null;
    setScanShareBusy(null);
    setPreparedScanShare(null);
    setScanShareFeedback(null);
  }, [songId, isOnline]);

  useEffect(() => () => {
    scanShareGenerationRef.current += 1;
    scanShareAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    recordingShareGenerationRef.current += 1;
    recordingShareAbortRef.current?.abort();
    recordingShareAbortRef.current = null;
    setRecordingShareBusy(null);
    setPreparedRecordingShare(null);
    setRecordingShareFeedback(null);
  }, [songId, isOnline]);

  useEffect(() => () => {
    recordingShareGenerationRef.current += 1;
    recordingShareAbortRef.current?.abort();
  }, []);

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

  async function retryFailedRecording(
    recording: SongDetail["recordings"][number],
  ): Promise<void> {
    if (
      !isOnline
      || canEdit !== true
      || recording.processingState !== "failed"
      || retryingRecordingId !== null
    ) return;
    setRetryingRecordingId(recording.id);
    setProcessingRetryError(null);
    try {
      const retried = await retryRecordingProcessing(recording.id, recording.revision);
      setSong((current) => current && ({
        ...current,
        recordings: current.recordings.map((item) => item.id === retried.id
          ? { ...item, revision: retried.revision, processingState: retried.processingState }
          : item),
      }));
      const refreshed = await refreshSong(songId).catch(() => null);
      if (refreshed) setSong(refreshed);
    } catch (retryError) {
      const refreshed = await refreshSong(songId).catch(() => null);
      if (refreshed) {
        setSong(refreshed);
        const current = refreshed.recordings.find((item) => item.id === recording.id);
        if (current && current.processingState !== "failed") return;
      }
      setProcessingRetryError(retryError instanceof Error
        ? retryError.message
        : "Audio preparation could not be retried.");
    } finally {
      setRetryingRecordingId(null);
    }
  }

  async function copyLyrics(lyricId: string, content: string): Promise<void> {
    setLyricAction({ lyricId, busy: true, message: "", isError: false });
    try {
      await copyTextBlock(content);
      setLyricAction({ lyricId, busy: false, message: "Copied.", isError: false });
    } catch {
      setLyricAction({
        lyricId,
        busy: false,
        message: "Copy is not available in this browser.",
        isError: true,
      });
    }
  }

  async function shareLyrics(lyricId: string, content: string): Promise<void> {
    setLyricAction({ lyricId, busy: true, message: "", isError: false });
    try {
      const outcome = await shareTextBlock(content);
      setLyricAction(outcome === "cancelled"
        ? null
        : { lyricId, busy: false, message: "Shared.", isError: false });
    } catch {
      setLyricAction({
        lyricId,
        busy: false,
        message: "Sharing is not available right now.",
        isError: true,
      });
    }
  }

  async function shareScan(scan: SongDetail["scans"][number]): Promise<void> {
    if (!isOnline || scanShareBusy !== null) return;
    const scanId = scan.id;
    const rotationQuarterTurns = scan.rotationQuarterTurns;
    const generation = scanShareGenerationRef.current;
    setScanShareFeedback(null);

    let file = preparedScanShare?.scanId === scanId
      && preparedScanShare.rotationQuarterTurns === rotationQuarterTurns
      ? preparedScanShare.file
      : null;
    try {
      if (!file) {
        setScanShareBusy({ scanId, phase: "preparing" });
        const controller = new AbortController();
        scanShareAbortRef.current?.abort();
        scanShareAbortRef.current = controller;
        const optimizedFile = await loadOptimizedScanShareFile(scanId, controller.signal);
        file = await rotateOptimizedScanShareFile(optimizedFile, rotationQuarterTurns);
        if (generation !== scanShareGenerationRef.current) return;
        if (scanShareAbortRef.current === controller) scanShareAbortRef.current = null;
        setPreparedScanShare({ scanId, rotationQuarterTurns, file });
      }

      setScanShareBusy({ scanId, phase: "sharing" });
      const outcome = await shareOptimizedScanFile(file);
      if (generation !== scanShareGenerationRef.current) return;
      if (outcome === "retry_required") {
        setPreparedScanShare({ scanId, rotationQuarterTurns, file });
        setScanShareFeedback({
          scanId,
          message: "The optimized scan is ready. Tap Share again.",
          isError: false,
        });
      } else {
        setPreparedScanShare(null);
        setScanShareFeedback(outcome === "shared"
          ? { scanId, message: "Optimized scan shared.", isError: false }
          : null);
      }
    } catch (shareError) {
      if (isShareAbort(shareError) || generation !== scanShareGenerationRef.current) return;
      setPreparedScanShare(null);
      const code = shareError instanceof ScanSharingError ? shareError.code : "share_failed";
      setScanShareFeedback({
        scanId,
        message: code === "optimized_unavailable"
          ? "An optimized copy is not available for sharing."
          : code === "file_too_large"
            ? "This optimized scan is too large to share."
            : code === "share_unavailable"
              ? "File sharing is not available in this browser."
              : "The optimized scan could not be shared right now.",
        isError: true,
      });
    } finally {
      if (generation === scanShareGenerationRef.current) setScanShareBusy(null);
    }
  }

  async function shareRecording(recordingId: string): Promise<void> {
    if (!isOnline || recordingShareBusy !== null) return;
    const generation = recordingShareGenerationRef.current;
    setRecordingShareFeedback(null);

    let file = preparedRecordingShare?.recordingId === recordingId
      ? preparedRecordingShare.file
      : null;
    try {
      if (!file) {
        setRecordingShareBusy({ recordingId, phase: "preparing" });
        const controller = new AbortController();
        recordingShareAbortRef.current?.abort();
        recordingShareAbortRef.current = controller;
        file = await loadRecordingShareFile(recordingId, controller.signal);
        if (generation !== recordingShareGenerationRef.current) return;
        if (recordingShareAbortRef.current === controller) recordingShareAbortRef.current = null;
        setPreparedRecordingShare({ recordingId, file });
      }

      setRecordingShareBusy({ recordingId, phase: "sharing" });
      const outcome = await shareRecordingFile(file);
      if (generation !== recordingShareGenerationRef.current) return;
      if (outcome === "retry_required") {
        setPreparedRecordingShare({ recordingId, file });
        setRecordingShareFeedback({
          recordingId,
          message: "The playback recording is ready. Tap Share again.",
          isError: false,
        });
      } else {
        setPreparedRecordingShare(null);
        setRecordingShareFeedback(outcome === "shared"
          ? { recordingId, message: "Playback recording shared.", isError: false }
          : null);
      }
    } catch (shareError) {
      if (isShareAbort(shareError) || generation !== recordingShareGenerationRef.current) return;
      setPreparedRecordingShare(null);
      const code = shareError instanceof RecordingSharingError ? shareError.code : "share_failed";
      setRecordingShareFeedback({
        recordingId,
        message: code === "file_too_large"
          ? "This playback recording is too large to share."
          : code === "share_unavailable"
            ? "File sharing is not available in this browser."
            : "The playback recording could not be shared right now.",
        isError: true,
      });
    } finally {
      if (generation === recordingShareGenerationRef.current) setRecordingShareBusy(null);
    }
  }

  return (
    <main className="page-shell detail-page" id="main-content">
      <Link className="back-link" to="/songs">← All songs</Link>
      <header className="detail-heading">
        <div className="heading-actions">
          <p className="eyebrow">Song</p>
          {isOnline && canEdit === true && (
            <Link
              className="secondary-action action-link compact-action"
              to={`/songs/${encodeURIComponent(song.id)}/edit`}
              aria-label="Edit Song"
              title="Edit Song"
            ><ActionContent kind="edit" label="Edit song" /></Link>
          )}
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
                <div className="lyric-actions">
                  <button
                    className="secondary-action compact-action"
                    type="button"
                    disabled={lyricAction?.busy === true}
                    aria-label="Copy typed lyrics"
                    title="Copy typed lyrics"
                    onClick={() => { void copyLyrics(lyrics.id, lyrics.content); }}
                  ><ActionContent kind="copy" label="Copy" /></button>
                  {supportsSystemTextShare() && (
                    <button
                      className="secondary-action compact-action"
                      type="button"
                      disabled={lyricAction?.busy === true}
                      aria-label="Share typed lyrics"
                      title="Share typed lyrics"
                      onClick={() => { void shareLyrics(lyrics.id, lyrics.content); }}
                    ><ActionContent kind="share" label="Share" /></button>
                  )}
                  {isOnline && canEdit === true && (
                    <Link
                      className="secondary-action action-link compact-action"
                      to={`/songs/${encodeURIComponent(song.id)}/lyrics/${encodeURIComponent(lyrics.id)}/edit`}
                      aria-label="Edit typed lyrics"
                      title="Edit typed lyrics"
                    ><ActionContent kind="edit" label="Edit" /></Link>
                  )}
                </div>
              </div>
              {lyricAction?.lyricId === lyrics.id && lyricAction.message && (
                <p
                  className={`lyric-action-status${lyricAction.isError ? " error-message" : ""}`}
                  role={lyricAction.isError ? "alert" : "status"}
                >{lyricAction.message}</p>
              )}
              <pre>{lyrics.content}</pre>
            </section>
          ))}

          {isOnline && canEdit === true && (
            <Link className="secondary-action action-link add-child-action icon-text-action" to={`/songs/${encodeURIComponent(song.id)}/lyrics/new`}><ActionContent kind="add" label="Add typed lyrics" /></Link>
          )}

          {song.recordings.length > 0 && (
            <section className="detail-card" aria-labelledby="recordings-title">
              <h2 id="recordings-title">Recordings <span>{song.recordings.length}</span></h2>
              {processingRetryError && <p className="catalog-message error-message" role="alert">{processingRetryError}</p>}
              <ul className="media-list">
                {song.recordings.map((recording) => {
                  const recordingShareTooLarge = isRecordingShareTooLarge(
                    recording.playbackByteSize,
                  );
                  return (
                  <li key={recording.id}>
                    <div className="recording-item">
                      <strong>{recording.description}</strong>
                      {recording.recordedOn && <span>{recording.recordedOn}</span>}
                      {recording.credits.length > 0 && <span>{recording.credits.map((credit) => `${credit.role === "vocals" ? "Vocals" : credit.role}: ${credit.fullName}`).join(" · ")}</span>}
                      {recording.processingState === "ready"
                        ? <audio
                            controls
                            preload="metadata"
                            src={`/api/media/${encodeURIComponent(recording.playbackMediaId ?? recording.originalMediaId)}`}
                            ref={(player) => {
                              if (player) recordingPlayers.current.set(recording.id, player);
                              else recordingPlayers.current.delete(recording.id);
                            }}
                            onPlay={(event) => {
                              pauseOtherAudioPlayers(event.currentTarget, recordingPlayers.current.values());
                            }}
                          />
                        : <span>{recording.processingState === "processing" ? "Preparing audio…" : "Audio needs attention"}</span>}
                    </div>
                    {((recording.processingState === "ready"
                      && recording.hasPlaybackMedia
                      && recordingSharingAvailable)
                      || (isOnline && canEdit === true)) && (
                      <div className="media-item-actions">
                        {recording.processingState === "ready"
                          && recording.hasPlaybackMedia
                          && recordingSharingAvailable && (
                          <button
                            className="media-action compact-action"
                            type="button"
                            disabled={!isOnline || recordingShareBusy !== null || recordingShareTooLarge}
                            aria-label={recordingShareTooLarge
                              ? "Recording is too large to share"
                              : recordingShareBusy?.recordingId === recording.id
                                ? recordingShareBusy.phase === "preparing" ? "Preparing Recording" : "Sharing Recording"
                                : "Share Recording"}
                            aria-busy={recordingShareBusy?.recordingId === recording.id || undefined}
                            aria-describedby={recordingShareTooLarge
                              ? `recording-share-size-${recording.id}`
                              : recordingShareFeedback?.recordingId === recording.id
                                ? `recording-share-${recording.id}`
                                : undefined}
                            title={recordingShareTooLarge
                              ? "This Recording is larger than 50 MiB"
                              : isOnline ? "Share the playback recording" : "Recording sharing requires an internet connection"}
                            onClick={() => { void shareRecording(recording.id); }}
                          ><ActionContent
                              kind="share"
                              label={recordingShareTooLarge
                                ? "Too large"
                                : recordingShareBusy?.recordingId === recording.id
                                  ? recordingShareBusy.phase === "preparing" ? "Preparing…" : "Sharing…"
                                  : "Share"}
                            /></button>
                        )}
                        {isOnline && canEdit === true && recording.processingState === "failed" && (
                          <button
                            className="media-action icon-text-action"
                            type="button"
                            disabled={retryingRecordingId !== null}
                            onClick={() => { void retryFailedRecording(recording); }}
                          >
                            <ActionContent kind="retry" label={retryingRecordingId === recording.id ? "Retrying…" : "Retry preparation"} />
                          </button>
                        )}
                        {isOnline && canEdit === true && (
                          <Link
                            className="media-action compact-action"
                            to={`/songs/${encodeURIComponent(song.id)}/recordings/${encodeURIComponent(recording.id)}/edit`}
                            aria-label="Edit Recording"
                            title="Edit Recording"
                          ><ActionContent kind="edit" label="Edit" /></Link>
                        )}
                        {recordingShareFeedback?.recordingId === recording.id && (
                          <p
                            className={`media-row-share-status${recordingShareFeedback.isError ? " error-message" : ""}`}
                            id={`recording-share-${recording.id}`}
                            role={recordingShareFeedback.isError ? "alert" : "status"}
                          >{recordingShareFeedback.message}</p>
                        )}
                        {recordingShareTooLarge && (
                          <p
                            className="media-row-share-status"
                            id={`recording-share-size-${recording.id}`}
                          >Playback is larger than {MAX_RECORDING_SHARE_BYTES / 1_048_576} MiB and cannot be shared here.</p>
                        )}
                      </div>
                    )}
                  </li>
                  );
                })}
              </ul>
              <p className="media-note">Some legacy formats may need a playback conversion.</p>
            </section>
          )}
          {isOnline && canEdit === true && (
            <Link className="secondary-action action-link add-child-action icon-text-action" to={`/songs/${encodeURIComponent(song.id)}/recordings/new`}><ActionContent kind="add" label="Add Recording" /></Link>
          )}

          {song.scans.length > 0 && (
            <section className="detail-card" aria-labelledby="scans-title">
              <h2 id="scans-title">Scanned lyrics and notation <span>{song.scans.length}</span></h2>
              <ul className="media-list">
                {song.scans.map((scan, index) => {
                  const position = scanPositionLabel(index, song.scans.length);
                  const displayName = scanDisplayName(scan);
                  return (
                  <li key={scan.id}>
                    <div><strong>{displayName}</strong>{position && <span>{position}</span>}</div>
                    <div className="media-item-actions">
                      <button
                        className="media-action compact-action"
                        type="button"
                        disabled={!isOnline}
                        aria-label={`View ${displayName}${position ? `, ${position}` : ""}`}
                        title={isOnline ? "View Scan" : "Scans require an internet connection"}
                        onClick={() => setViewerScanId(scan.id)}
                      ><ActionContent kind="view" label="View" /></button>
                      {supportsOptimizedScanSharing() && (
                        <button
                          className="media-action compact-action"
                          type="button"
                          disabled={!isOnline || scanShareBusy !== null}
                          aria-label={scanShareBusy?.scanId === scan.id
                            ? scanShareBusy.phase === "preparing" ? "Preparing Scan" : "Sharing Scan"
                            : "Share Scan"}
                          aria-busy={scanShareBusy?.scanId === scan.id || undefined}
                          aria-describedby={scanShareFeedback?.scanId === scan.id ? `scan-share-${scan.id}` : undefined}
                          title={isOnline ? "Share the optimized scan image" : "Scan sharing requires an internet connection"}
                          onClick={() => { void shareScan(scan); }}
                        ><ActionContent
                            kind="share"
                            label={scanShareBusy?.scanId === scan.id
                              ? scanShareBusy.phase === "preparing" ? "Preparing…" : "Sharing…"
                              : "Share"}
                          /></button>
                      )}
                      {isOnline && canEdit === true && (
                        <Link
                          className="media-action compact-action"
                          to={`/songs/${encodeURIComponent(song.id)}/scans/${encodeURIComponent(scan.id)}/edit`}
                          aria-label={`Edit ${displayName}${position ? `, ${position}` : ""}`}
                          title="Edit Scan"
                        ><ActionContent kind="edit" label="Edit" /></Link>
                      )}
                      {scanShareFeedback?.scanId === scan.id && (
                        <p
                          className={`media-row-share-status${scanShareFeedback.isError ? " error-message" : ""}`}
                          id={`scan-share-${scan.id}`}
                          role={scanShareFeedback.isError ? "alert" : "status"}
                        >{scanShareFeedback.message}</p>
                      )}
                    </div>
                  </li>
                  );
                })}
              </ul>
            </section>
          )}
          {isOnline && canEdit === true && (
            <Link className="secondary-action action-link add-child-action icon-text-action" to={`/songs/${encodeURIComponent(song.id)}/scans/new`}><ActionContent kind="add" label="Add Scan" /></Link>
          )}
        </div>
        <aside><MetadataList song={song} /></aside>
      </div>
      {viewerScanId && (
        <ScanViewer
          songId={song.id}
          scans={song.scans}
          initialScanId={viewerScanId}
          isOnline={isOnline}
          canEdit={canEdit === true}
          onOrientationSaved={(updated) => {
            setSong((current) => current && ({
              ...current,
              scans: current.scans.map((scan) => scan.id === updated.id
                ? { ...scan, ...updated }
                : scan),
            }));
            setPreparedScanShare(null);
            void refreshOfflineLibrary().catch(() => undefined);
          }}
          onClose={() => setViewerScanId(null)}
        />
      )}
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
  const editorKey = `${mode}:${songId}:${lyricId}`;
  const loadedEditorKey = useRef<string | null>(null);
  const [initialContent, setInitialContent] = useState<{ key: string; value: string } | null>(null);
  const hasUnsavedChanges = initialContent?.key === editorKey
    && editorValuesChanged(initialContent.value, content);
  const { allowNextNavigation } = useUnsavedChanges(hasUnsavedChanges);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!isOnline || canEdit !== true) {
        setIsLoading(false);
        return;
      }
      if (!shouldRefreshEditor(loadedEditorKey.current, editorKey, hasUnsavedChanges)) return;
      setIsLoading(true);
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
          setInitialContent({ key: editorKey, value: lyric.content });
          setRevision(lyric.revision);
          setIsLegacyImport(lyric.origin === "legacy_import");
        } else {
          setContent("");
          setInitialContent({ key: editorKey, value: "" });
          setRevision(null);
          setIsLegacyImport(false);
        }
        loadedEditorKey.current = editorKey;
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The typed-lyrics editor could not be loaded.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [canEdit, editorKey, isOnline, lyricId, mode, songId]);

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
      allowNextNavigation();
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
      allowNextNavigation();
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
      <FeedbackMessage message={error} />
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

function ScanEditorPage({
  mode,
  isOnline,
  canEdit,
}: {
  mode: "create" | "edit" | "replace";
  isOnline: boolean;
  canEdit: boolean | null;
}) {
  const { songId = "", scanId = "" } = useParams();
  const navigate = useNavigate();
  const [options, setOptions] = useState<ScanEditorOptions | null>(null);
  const [songTitle, setSongTitle] = useState("");
  const [filename, setFilename] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [offerDirectCamera] = useState(() => shouldOfferDirectCameraCapture(
    navigator.userAgent,
    navigator.maxTouchPoints,
  ));
  const [notebookId, setNotebookId] = useState("");
  const [pageLabel, setPageLabel] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [duplicateScan, setDuplicateScan] = useState<DuplicateScanDetails | null>(null);
  const duplicateScanNoticeRef = useRevealFeedback(duplicateScan);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);
  const editorKey = `${mode}:${songId}:${scanId}`;
  const loadedEditorKey = useRef<string | null>(null);
  const [initialValues, setInitialValues] = useState<{
    key: string;
    value: { notebookId: string; pageLabel: string; fileSelected: boolean };
  } | null>(null);
  const currentValues = { notebookId, pageLabel, fileSelected: file !== null };
  const hasUnsavedChanges = initialValues?.key === editorKey
    && editorValuesChanged(initialValues.value, currentValues);
  const { allowNextNavigation } = useUnsavedChanges(hasUnsavedChanges);

  useEffect(() => {
    if (!file) {
      setFilePreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setFilePreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!isOnline || canEdit !== true) {
        setIsLoading(false);
        return;
      }
      if (!shouldRefreshEditor(loadedEditorKey.current, editorKey, hasUnsavedChanges)) return;
      setIsLoading(true);
      try {
        const [editorOptions, song] = await Promise.all([
          loadScanEditorOptions(),
          refreshSong(songId),
        ]);
        if (cancelled) return;
        setOptions(editorOptions);
        setSongTitle(song.titleLatin);
        if (mode === "edit" || mode === "replace") {
          const scan = song.scans.find((item) => item.id === scanId);
          if (!scan) {
            setError("This Scan is no longer available.");
            return;
          }
          setFilename(scan.filename);
          setNotebookId(scan.notebookId ?? "");
          setPageLabel(scan.pageLabel ?? "");
          setRevision(scan.revision);
          setFile(null);
          setInitialValues({
            key: editorKey,
            value: {
              notebookId: scan.notebookId ?? "",
              pageLabel: scan.pageLabel ?? "",
              fileSelected: false,
            },
          });
        } else {
          setFilename("");
          setNotebookId("");
          setPageLabel("");
          setRevision(null);
          setFile(null);
          setInitialValues({
            key: editorKey,
            value: { notebookId: "", pageLabel: "", fileSelected: false },
          });
        }
        loadedEditorKey.current = editorKey;
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The Scan editor could not be loaded.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [canEdit, editorKey, isOnline, mode, scanId, songId]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isOnline || canEdit !== true || isSaving || isTrashing) return;
    if ((mode === "edit" || mode === "replace") && revision === null) return;
    if ((mode === "create" || mode === "replace") && !file) {
      setFieldErrors({ file: ["Choose an image file"] });
      return;
    }
    setIsSaving(true);
    setError(null);
    setDuplicateScan(null);
    setFieldErrors({});
    try {
      if (mode === "create") {
        await createScan(songId, {
          file: file!,
          notebookId: notebookId || null,
          pageLabel: notebookId ? pageLabel || null : null,
        });
      } else if (mode === "replace") {
        await replaceScanMedia(songId, scanId, {
          file: file!,
          revision: revision!,
        });
      } else {
        await updateScan(songId, scanId, {
          notebookId: notebookId || null,
          pageLabel: notebookId ? pageLabel || null : null,
          revision: revision!,
        });
      }
      await refreshOfflineLibrary().catch(() => undefined);
      allowNextNavigation();
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (saveError) {
      if (saveError instanceof ApiError) {
        setError(saveError.message);
        setFieldErrors(saveError.fields ?? {});
        setDuplicateScan(saveError.existingScan ?? null);
      } else {
        setError(saveError instanceof Error ? saveError.message : "The Scan could not be saved.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function recoverDuplicateScan(): Promise<void> {
    if (!duplicateScan?.isTrashed || isSaving || !isOnline || canEdit !== true) return;
    const action = duplicateScan.songId === songId ? "restore" : "move";
    if (!window.confirm(
      `${action === "restore" ? "Restore" : "Move"} the existing Scan ${action === "restore" ? "to this Song" : `from “${duplicateScan.songTitle}” to “${songTitle}”`}? No file will be copied or deleted.`,
    )) return;
    setIsSaving(true);
    setError(null);
    try {
      await moveTrashedScan(duplicateScan.scanId, duplicateScan.revision, songId);
      await refreshOfflineLibrary().catch(() => undefined);
      allowNextNavigation();
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "The existing Scan could not be recovered.");
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
      allowNextNavigation();
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (trashError) {
      setError(trashError instanceof Error ? trashError.message : "The Scan could not be moved to Trash.");
    } finally {
      setIsTrashing(false);
    }
  }

  const songUrl = `/songs/${encodeURIComponent(songId)}`;
  function chooseFile(selectedFile: File | null): void {
    setFile(selectedFile);
    setDuplicateScan(null);
    setError(null);
    setFieldErrors((current) => ({ ...current, file: [] }));
  }
  if (!isOnline) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Cancel</Link><section className="empty-state"><h1>Editing is offline</h1><p>Reconnect to add, change, or remove a Scan. Saved Song information remains available to read.</p></section></main>;
  if (canEdit === null) return <main className="page-shell" id="main-content"><p>Checking editor access…</p></main>;
  if (!canEdit) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Song</Link><section className="empty-state"><h1>Editor access required</h1></section></main>;
  if (isLoading) return <main className="page-shell" id="main-content"><p>Loading Scan…</p></main>;
  if (mode === "edit" && revision === null) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Song</Link><section className="empty-state"><h1>Scan unavailable</h1><p>{error}</p></section></main>;

  return (
    <main className="page-shell editor-page" id="main-content">
      <Link className="back-link" to={songUrl}>← Cancel</Link>
      <header className="editor-heading">
        <p className="eyebrow">{songTitle || "Song"}</p>
        <h1>{mode === "create" ? "Add Scan" : mode === "replace" ? "Replace Scan Image" : "Edit Scan"}</h1>
        <p className="lede">{mode === "create" ? "Upload a private image, then optionally identify its Notebook and Page." : mode === "replace" ? "Upload a new private image to replace the current file. The previous image is preserved in history." : "Choose a Notebook and optional Page, or leave both empty for an external Scan."}</p>
      </header>
      <FeedbackMessage message={duplicateScan ? null : error} />
      {duplicateScan && (
        <section
          className="duplicate-scan-notice"
          ref={duplicateScanNoticeRef}
          role="alert"
          aria-labelledby="duplicate-scan-title"
        >
          <div>
            <strong id="duplicate-scan-title">Existing Scan details</strong>
            {error && <span>{error}</span>}
            <span>Song: {duplicateScan.songTitle}</span>
            <span>File: {duplicateScan.filename}</span>
            {duplicateScan.notebookName ? <span>Notebook: {duplicateScan.notebookName}</span> : <span>Type: External Scan</span>}
            {duplicateScan.pageLabel && <span>Page: {duplicateScan.pageLabel}</span>}
            {duplicateScan.isTrashed && <span>This Scan or its Song is currently in Trash.</span>}
          </div>
          <div className="duplicate-notice-actions">
            {duplicateScan.isTrashed && (
              <button className="primary-action" type="button" disabled={isSaving} onClick={() => { void recoverDuplicateScan(); }}>
                {isSaving ? "Moving…" : duplicateScan.songId === songId ? "Restore existing Scan" : "Move existing Scan here"}
              </button>
            )}
            <Link className="secondary-action action-link" to={duplicateScan.isTrashed ? "/trash" : `/songs/${encodeURIComponent(duplicateScan.songId)}`}>{duplicateScan.isTrashed ? "Open Trash" : "Open Song"}</Link>
          </div>
        </section>
      )}
      <form className="song-form" onSubmit={(event) => { void submit(event); }}>
        <section className="form-card">
          {mode === "create" || mode === "replace" ? (
            <div className="form-field">
              <span>Scan image <strong aria-hidden="true">*</strong></span>
              {file ? (
                <div className="selected-scan-file">
                  {filePreviewUrl && <img src={filePreviewUrl} alt={`Preview of ${file.name}`} />}
                  <div>
                    <strong>{file.name}</strong>
                    <span>{(file.size / (1024 * 1024)).toFixed(1)} MB</span>
                    <button className="secondary-action" type="button" disabled={isSaving} onClick={() => chooseFile(null)}>Remove and choose again</button>
                  </div>
                </div>
              ) : (
                <div className="scan-source-options">
                  <label>
                    <strong>Choose image</strong>
                    <span>Open your photo library or files</span>
                    <span className="scan-source-action">Browse images</span>
                    <input
                      className="scan-source-input"
                      type="file"
                      accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                      onChange={(event) => {
                        chooseFile(event.target.files?.[0] ?? null);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  {offerDirectCamera && (
                    <label>
                      <strong>Take photo</strong>
                      <span>Open the camera; rear camera preferred</span>
                      <span className="scan-source-action">Open camera</span>
                      <input
                        className="scan-source-input"
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={(event) => {
                          chooseFile(event.target.files?.[0] ?? null);
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                  )}
                </div>
              )}
              <small>JPEG, PNG, or WebP · maximum 20 MB. The actual file content is checked before it is stored.</small>
              {fieldErrors.file?.map((message) => <em key={message}>{message}</em>)}
            </div>
          ) : (
            <div className="form-file-summary">
              <div>
                <span>Private file</span>
                <strong>{filename}</strong>
              </div>
              <Link className="secondary-action action-link icon-text-action" to={`/songs/${encodeURIComponent(songId)}/scans/${encodeURIComponent(scanId)}/replace`}><ActionContent kind="replace" label="Replace image" /></Link>
            </div>
          )}
          {mode !== "replace" && (
            <>
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
            </>
          )}
        </section>
        <div className="form-actions">
          <Link className="secondary-action action-link" to={songUrl}>Cancel</Link>
          <button className="primary-action" type="submit" disabled={isSaving || isTrashing || ((mode === "create" || mode === "replace") && !file)}>{isSaving ? (mode === "create" || mode === "replace") ? "Uploading…" : "Saving…" : (mode === "create" || mode === "replace") ? "Save Image" : "Save changes"}</button>
        </div>
      </form>
      {mode === "edit" && <section className="danger-zone" aria-labelledby="remove-scan-title">
        <div>
          <h2 id="remove-scan-title">Remove this Scan</h2>
          <p>This moves both the Scan and its private file to recoverable Trash. Nothing is permanently deleted.</p>
        </div>
        <button className="danger-action" type="button" disabled={isSaving || isTrashing} onClick={() => { void moveToTrash(); }}>{isTrashing ? "Moving…" : "Move to Trash"}</button>
      </section>}
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
  const [processingState, setProcessingState] = useState<"processing" | "ready" | "failed">("ready");
  const [revision, setRevision] = useState<number | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);
  const editorKey = `${songId}:${recordingId}`;
  const loadedEditorKey = useRef<string | null>(null);
  const [initialValues, setInitialValues] = useState<{
    key: string;
    value: { description: string; recordedOn: string; vocalistIds: string[] };
  } | null>(null);
  const currentValues = { description, recordedOn, vocalistIds };
  const hasUnsavedChanges = initialValues?.key === editorKey
    && editorValuesChanged(initialValues.value, currentValues);
  const { allowNextNavigation } = useUnsavedChanges(hasUnsavedChanges);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!isOnline || canEdit !== true) {
        setIsLoading(false);
        return;
      }
      if (!shouldRefreshEditor(loadedEditorKey.current, editorKey, hasUnsavedChanges)) return;
      setIsLoading(true);
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
        const nextValues = {
          description: recording.description,
          recordedOn: recording.recordedOn ?? "",
          vocalistIds: recording.credits.filter((credit) => credit.role === "vocals").map((credit) => credit.personId),
        };
        setDescription(nextValues.description);
        setRecordedOn(nextValues.recordedOn);
        setVocalistIds(nextValues.vocalistIds);
        setInitialValues({ key: editorKey, value: nextValues });
        setProcessingState(recording.processingState);
        setRevision(recording.revision);
        loadedEditorKey.current = editorKey;
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The Recording editor could not be loaded.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [canEdit, editorKey, isOnline, recordingId, songId]);

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
      allowNextNavigation();
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
      allowNextNavigation();
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
      <FeedbackMessage message={error} />
      <form className="song-form" onSubmit={(event) => { void submit(event); }}>
        <section className="form-card">
          <div className="form-file-summary">
            <div>
              <span>Private original file</span>
              <strong>{filename}</strong>
            </div>
            {processingState === "processing"
              ? <span className="media-note">Replacement is available after processing finishes.</span>
              : <Link className="secondary-action action-link icon-text-action" to={`/songs/${encodeURIComponent(songId)}/recordings/${encodeURIComponent(recordingId)}/replace`}><ActionContent kind="replace" label="Replace audio" /></Link>}
          </div>
          <label className="form-field">
            <span>Recording description <strong aria-hidden="true">*</strong></span>
            <textarea required rows={5} maxLength={10_000} value={description} onChange={(event) => setDescription(event.target.value)} />
            <small>Use this for details such as an old verse, alternate tune, incomplete take, or accompaniment. Capitalization is preserved.</small>
            {fieldErrors.description?.map((message) => <em key={message}>{message}</em>)}
          </label>
          <RecordingDateField
            value={recordedOn}
            onChange={setRecordedOn}
            errors={fieldErrors.recordedOn}
          />
        </section>
        <fieldset className="form-card choice-group">
          <legend>Vocals</legend>
          <p>Optional. Select the people who sang in this Recording.</p>
          <CreditRows
            people={options?.people ?? []}
            roles={[{ value: "vocals" as const, label: "Vocals" }]}
            value={vocalistIds.map((personId) => ({ personId, role: "vocals" as const }))}
            onChange={(credits) => setVocalistIds(credits.map((credit) => credit.personId))}
            disabled={isSaving || isTrashing}
          />
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
  const navigate = useNavigate();
  const [songs, setSongs] = useState<TrashedSong[]>([]);
  const [lyrics, setLyrics] = useState<TrashedLyric[]>([]);
  const [scans, setScans] = useState<TrashedScan[]>([]);
  const [recordings, setRecordings] = useState<TrashedRecording[]>([]);
  const [activeSongs, setActiveSongs] = useState<ActiveSongOption[]>([]);
  const [moveOpen, setMoveOpen] = useState<{ kind: "scan" | "recording"; id: string } | null>(null);
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
          setActiveSongs(result.activeSongs);
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

  async function moveScanToSong(scan: TrashedScan, target: ActiveSongOption): Promise<void> {
    const moveKey = `move:scan:${scan.id}`;
    if (!isOnline || canEdit !== true || restoringId !== null) return;
    if (!window.confirm(
      `Move this Scan from “${scan.songTitle}” to “${target.titleLatin}”? The existing private file will be reused; nothing will be copied or deleted.`,
    )) return;
    setRestoringId(moveKey);
    setError(null);
    try {
      await moveTrashedScan(scan.id, scan.revision, target.id);
      await refreshOfflineLibrary().catch(() => undefined);
      navigate(`/songs/${encodeURIComponent(target.id)}`);
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "The Scan could not be moved.");
    } finally {
      setRestoringId(null);
    }
  }

  async function moveRecordingToSong(recording: TrashedRecording, target: ActiveSongOption): Promise<void> {
    const moveKey = `move:recording:${recording.id}`;
    if (!isOnline || canEdit !== true || restoringId !== null) return;
    if (!window.confirm(
      `Move “${recording.description}” from “${recording.songTitle}” to “${target.titleLatin}”? The existing private audio will be reused; nothing will be copied or deleted.`,
    )) return;
    setRestoringId(moveKey);
    setError(null);
    try {
      await moveTrashedRecording(recording.id, recording.revision, target.id);
      await refreshOfflineLibrary().catch(() => undefined);
      navigate(`/songs/${encodeURIComponent(target.id)}`);
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "The Recording could not be moved.");
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
      <FeedbackMessage message={error} />
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
                        <small>{recording.recordedOn ? `${recording.recordedOn} · ` : ""}moved {new Date(recording.trashedAt).toLocaleString()}</small>
                      </div>
                      <div className="trash-item-actions">
                        <button className="primary-action" type="button" disabled={restoringId !== null || recording.songIsTrashed} onClick={() => { void restoreTrashedRecording(recording); }}>{restoringId === recording.id ? "Restoring…" : "Restore"}</button>
                        <button className="secondary-action" type="button" disabled={restoringId !== null || activeSongs.every((song) => song.id === recording.songId)} onClick={() => setMoveOpen({ kind: "recording", id: recording.id })}>Move to Song…</button>
                      </div>
                    </div>
                    {recording.songIsTrashed && <p className="media-note">Restore the parent Song before restoring this Recording.</p>}
                    {moveOpen?.kind === "recording" && moveOpen.id === recording.id && (
                      <MoveToSongForm
                        songs={activeSongs}
                        sourceSongId={recording.songId}
                        busy={restoringId === `move:recording:${recording.id}`}
                        onCancel={() => setMoveOpen(null)}
                        onMove={(target) => { void moveRecordingToSong(recording, target); }}
                      />
                    )}
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
                        <span>Scan · {scanDisplayName(scan)}</span>
                        {scan.songIsTrashed
                          ? <strong>{scan.songTitle}</strong>
                          : <Link to={`/songs/${encodeURIComponent(scan.songId)}`}>{scan.songTitle}</Link>}
                        <small>Moved {new Date(scan.trashedAt).toLocaleString()}</small>
                      </div>
                      <div className="trash-item-actions">
                        <button className="primary-action" type="button" disabled={restoringId !== null || scan.songIsTrashed} onClick={() => { void restoreTrashedScan(scan); }}>{restoringId === scan.id ? "Restoring…" : "Restore"}</button>
                        <button className="secondary-action" type="button" disabled={restoringId !== null || activeSongs.every((song) => song.id === scan.songId)} onClick={() => setMoveOpen({ kind: "scan", id: scan.id })}>Move to Song…</button>
                      </div>
                    </div>
                    {scan.songIsTrashed && <p className="media-note">Restore the parent Song before restoring this Scan.</p>}
                    {moveOpen?.kind === "scan" && moveOpen.id === scan.id && (
                      <MoveToSongForm
                        songs={activeSongs}
                        sourceSongId={scan.songId}
                        busy={restoringId === `move:scan:${scan.id}`}
                        onCancel={() => setMoveOpen(null)}
                        onMove={(target) => { void moveScanToSong(scan, target); }}
                      />
                    )}
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
  const editorKey = `${mode}:${songId}`;
  const loadedEditorKey = useRef<string | null>(null);
  const [initialForm, setInitialForm] = useState<{ key: string; value: SongFormState } | null>(null);
  const hasUnsavedChanges = initialForm?.key === editorKey
    && editorValuesChanged(initialForm.value, form);
  const { allowNextNavigation } = useUnsavedChanges(hasUnsavedChanges);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!isOnline || canEdit !== true) {
        setIsLoading(false);
        return;
      }
      if (!shouldRefreshEditor(loadedEditorKey.current, editorKey, hasUnsavedChanges)) return;
      setIsLoading(true);
      try {
        const [editorOptions, song] = await Promise.all([
          loadSongEditorOptions(),
          mode === "edit" ? refreshSong(songId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setOptions(editorOptions);
        if (song) {
          const nextForm: SongFormState = {
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
          };
          setForm(nextForm);
          setInitialForm({ key: editorKey, value: nextForm });
          setChildCounts({
            lyricTexts: song.lyricTexts.length,
            scans: song.scans.length,
            recordings: song.recordings.length,
          });
        } else {
          setForm(EMPTY_SONG_FORM);
          setInitialForm({ key: editorKey, value: EMPTY_SONG_FORM });
          setChildCounts({ lyricTexts: 0, scans: 0, recordings: 0 });
        }
        loadedEditorKey.current = editorKey;
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The editor could not be loaded.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [canEdit, editorKey, isOnline, mode, songId]);

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
      allowNextNavigation();
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
      allowNextNavigation();
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
      <FeedbackMessage message={error} />
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
          <p>Required. Select at least one.</p>
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
          <CreditRows
            people={options?.people ?? []}
            roles={[
              { value: "lyrics" as const, label: "Lyrics" },
              { value: "music" as const, label: "Music" },
            ]}
            value={[
              ...form.lyricsPersonIds.map((personId) => ({ personId, role: "lyrics" as const })),
              ...form.musicPersonIds.map((personId) => ({ personId, role: "music" as const })),
            ]}
            onChange={(credits) => setForm((current) => ({
              ...current,
              lyricsPersonIds: credits.filter((credit) => credit.role === "lyrics").map((credit) => credit.personId),
              musicPersonIds: credits.filter((credit) => credit.role === "music").map((credit) => credit.personId),
            }))}
            disabled={isSaving || isTrashing}
          />
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

function AccountPage({
  session,
  onLogout,
}: {
  session: AppSession | null;
  onLogout: () => Promise<void>;
}) {
  const [isLoggingOut, setIsLoggingOut] = useState(false);
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
      <button
        className="danger-action"
        type="button"
        disabled={isLoggingOut}
        onClick={() => {
          setIsLoggingOut(true);
          void onLogout().catch(() => setIsLoggingOut(false));
        }}
      >
        {isLoggingOut ? "Clearing this device…" : "Sign out and clear this device"}
      </button>
      <p className="media-note">Signing out removes the offline catalog and typed lyrics stored by this browser.</p>
    </main>
  );
}

const LOOKUP_LABELS: Record<LookupKind, { singular: string; plural: string }> = {
  languages: { singular: "Language", plural: "Languages" },
  tags: { singular: "Tag", plural: "Tags" },
  notebooks: { singular: "Notebook", plural: "Notebooks" },
  people: { singular: "Person", plural: "People" },
};

function sortLookupItems(items: LookupItem[]): LookupItem[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function ManageLookupsPage({ isOnline, canEdit }: { isOnline: boolean; canEdit: boolean | null }) {
  const [collections, setCollections] = useState<LookupCollections | null>(null);
  const [activeKind, setActiveKind] = useState<LookupKind>("languages");
  const [filter, setFilter] = useState("");
  const [addName, setAddName] = useState("");
  const [confirmSimilar, setConfirmSimilar] = useState(false);
  const [editing, setEditing] = useState<{ id: string; currentName: string; name: string; confirmSimilar: boolean } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isOnline || canEdit !== true) return () => { cancelled = true; };
    setCollections(null);
    loadLookups().then((loaded) => {
      if (!cancelled) {
        setCollections(loaded);
        setError(null);
      }
    }).catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Lists could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [isOnline, canEdit]);

  if (!isOnline) {
    return <main className="page-shell" id="main-content"><section className="empty-state"><h1>Lists are available online</h1><p>Reconnect before adding or renaming list items.</p></section></main>;
  }
  if (canEdit === null) return <main className="page-shell" id="main-content"><p>Checking editor access…</p></main>;
  if (!canEdit) return <main className="page-shell" id="main-content"><section className="empty-state"><h1>Editor access required</h1></section></main>;

  const items = collections?.[activeKind] ?? [];
  const addMatch = findSimilarLookupItems(addName, items);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleItems = normalizedFilter
    ? items.filter((item) => item.name.toLocaleLowerCase().includes(normalizedFilter))
    : items;

  function replaceItem(kind: LookupKind, item: LookupItem): void {
    setCollections((current) => current && ({
      ...current,
      [kind]: sortLookupItems(current[kind].filter((existing) => existing.id !== item.id).concat(item)),
    }));
  }

  function selectLookupKind(kind: LookupKind): void {
    setActiveKind(kind);
    setFilter("");
    setAddName("");
    setConfirmSimilar(false);
    setEditing(null);
    setError(null);
  }

  async function addItem(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (isSaving || !addName.trim() || addMatch.exact || (addMatch.similar.length > 0 && !confirmSimilar)) return;
    setIsSaving(true);
    setError(null);
    try {
      const item = await createLookup(activeKind, addName);
      replaceItem(activeKind, item);
      setAddName("");
      setConfirmSimilar(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The item could not be added.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveRename(): Promise<void> {
    if (!editing || isSaving) return;
    const renameMatch = findSimilarLookupItems(editing.name, items, editing.id);
    if (!editing.name.trim() || renameMatch.exact || (renameMatch.similar.length > 0 && !editing.confirmSimilar)) return;
    setIsSaving(true);
    setError(null);
    try {
      const item = await updateLookup(activeKind, editing.id, editing.name, editing.currentName);
      replaceItem(activeKind, item);
      setEditing(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The name could not be changed.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="page-shell lookup-page" id="main-content">
      <header className="catalog-heading">
        <div>
          <p className="eyebrow">Editor tools</p>
          <h1>Library lists</h1>
          <p className="lede">Manage the shared choices used by Songs, Scans, and Recordings.</p>
        </div>
      </header>

      <LookupTabs
        activeKind={activeKind}
        options={(Object.keys(LOOKUP_LABELS) as LookupKind[]).map((kind) => ({
          kind,
          label: LOOKUP_LABELS[kind].plural,
          count: collections?.[kind].length ?? null,
        }))}
        onSelect={selectLookupKind}
      />

      <div
        className="lookup-tab-panel"
        id={lookupPanelId(activeKind)}
        role="tabpanel"
        aria-labelledby={lookupTabId(activeKind)}
      >
        <FeedbackMessage message={error} />
        {!collections ? (
          <section className="empty-state"><p>Loading library lists…</p></section>
        ) : (
          <div className="lookup-layout">
          <section className="detail-card lookup-add" aria-labelledby="lookup-add-title">
            <div>
              <p className="eyebrow">New choice</p>
              <h2 id="lookup-add-title">Add {LOOKUP_LABELS[activeKind].singular.toLocaleLowerCase()}</h2>
            </div>
            <form onSubmit={(event) => { void addItem(event); }}>
              <label className="form-field">
                <span>Name</span>
                <input
                  value={addName}
                  maxLength={200}
                  onChange={(event) => { setAddName(event.target.value); setConfirmSimilar(false); }}
                  autoComplete="off"
                />
              </label>
              {addMatch.exact && <p className="lookup-warning" role="alert"><strong>Already exists:</strong> {addMatch.exact.name}</p>}
              {!addMatch.exact && addMatch.similar.length > 0 && (
                <div className="lookup-warning">
                  <strong>Similar existing {addMatch.similar.length === 1 ? "name" : "names"}:</strong> {addMatch.similar.map((item) => item.name).join(", ")}
                  <label><input type="checkbox" checked={confirmSimilar} onChange={(event) => setConfirmSimilar(event.target.checked)} /> This is a different {LOOKUP_LABELS[activeKind].singular.toLocaleLowerCase()}; add it anyway</label>
                </div>
              )}
              <button className="primary-action" type="submit" disabled={isSaving || !addName.trim() || Boolean(addMatch.exact) || (addMatch.similar.length > 0 && !confirmSimilar)}>{isSaving ? "Saving…" : "Add"}</button>
            </form>
          </section>

          <section className="detail-card lookup-existing" aria-labelledby="lookup-existing-title">
            <div className="lookup-list-heading">
              <div>
                <p className="eyebrow">Existing choices</p>
                <h2 id="lookup-existing-title">{LOOKUP_LABELS[activeKind].plural}</h2>
              </div>
              <label className="search-field compact-search">
                <span className="sr-only">Filter {LOOKUP_LABELS[activeKind].plural}</span>
                <span aria-hidden="true">⌕</span>
                <input type="search" placeholder="Filter names" value={filter} onChange={(event) => setFilter(event.target.value)} />
              </label>
            </div>
            {visibleItems.length === 0 ? <p className="media-note">No matching names.</p> : (
              <ul className="lookup-list">
                {visibleItems.map((item) => {
                  const isEditing = editing?.id === item.id;
                  const renameMatch = isEditing ? findSimilarLookupItems(editing.name, items, item.id) : { exact: null, similar: [] };
                  return (
                    <li key={item.id}>
                      {isEditing ? (
                        <div className="lookup-edit-row">
                          <label className="form-field">
                            <span className="sr-only">Rename {item.name}</span>
                            <input value={editing.name} maxLength={200} autoFocus onChange={(event) => setEditing({ ...editing, name: event.target.value, confirmSimilar: false })} />
                          </label>
                          {renameMatch.exact && <p className="lookup-warning" role="alert"><strong>Already exists:</strong> {renameMatch.exact.name}</p>}
                          {!renameMatch.exact && renameMatch.similar.length > 0 && (
                            <div className="lookup-warning">
                              <strong>Similar:</strong> {renameMatch.similar.map((similar) => similar.name).join(", ")}
                              <label><input type="checkbox" checked={editing.confirmSimilar} onChange={(event) => setEditing({ ...editing, confirmSimilar: event.target.checked })} /> This is intentionally different</label>
                            </div>
                          )}
                          <div className="lookup-row-actions">
                            <button className="secondary-action" type="button" disabled={isSaving} onClick={() => setEditing(null)}>Cancel</button>
                            <button className="primary-action" type="button" disabled={isSaving || !editing.name.trim() || Boolean(renameMatch.exact) || (renameMatch.similar.length > 0 && !editing.confirmSimilar)} onClick={() => { void saveRename(); }}>{isSaving ? "Saving…" : "Save"}</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <span>{item.name}</span>
                          <button className="secondary-action" type="button" disabled={isSaving} onClick={() => setEditing({ id: item.id, currentName: item.name, name: item.name, confirmSimilar: false })}>Rename</button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="media-note">Items cannot be deleted because Songs, Scans, or Recordings may refer to them.</p>
          </section>
          </div>
        )}
      </div>
    </main>
  );
}

export function App() {
  const isOnline = useOnlineStatus();
  const [catalogView, setCatalogView] = useState(initialCatalogViewState);
  const catalogScrollPosition = useRef(0);
  const [session, setSession] = useState<AppSession | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);
  const [privateDataBlocked, setPrivateDataBlocked] = useState(isPrivateDataBlocked);
  const [accessLogoutPending, setAccessLogoutPending] = useState(isAccessLogoutPending);
  const sessionGeneration = useRef(0);
  const logoutCompletionActive = useRef(false);

  function notifyPrivateDataCleared(): void {
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(PRIVATE_DATA_CHANNEL_NAME);
      channel.postMessage({ type: "private-data-cleared" });
      channel.close();
    }
  }

  async function logoutAndClear(): Promise<void> {
    setCatalogView(initialCatalogViewState());
    catalogScrollPosition.current = 0;
    sessionGeneration.current += 1;
    setSession(null);
    setSessionResolved(false);
    setPrivateDataBlocked(true);
    setAccessLogoutPending(true);
    logoutCompletionActive.current = true;
    try {
      await logoutAndClearPrivateData({
        clearPrivateLocalData,
        notifyOtherTabs: notifyPrivateDataCleared,
        navigate: (path) => window.location.replace(path),
        online: isOnline,
      });
    } finally {
      logoutCompletionActive.current = false;
    }
  }

  useEffect(() => {
    const invalidatePrivateData = () => {
      setCatalogView(initialCatalogViewState());
      catalogScrollPosition.current = 0;
      sessionGeneration.current += 1;
      localStorage.removeItem(PRIVATE_CACHE_NAMESPACE_KEY);
      setSession(null);
      setSessionResolved(false);
      setPrivateDataBlocked(true);
      setAccessLogoutPending(true);
      void clearPrivateLocalData().catch(() => undefined);
    };
    const storageListener = (event: StorageEvent) => {
      if (
        (event.key === PRIVATE_DATA_BARRIER_KEY || event.key === PENDING_ACCESS_LOGOUT_KEY)
        && event.newValue !== null
      ) {
        invalidatePrivateData();
      }
    };
    window.addEventListener("storage", storageListener);
    if (!("BroadcastChannel" in window)) {
      return () => window.removeEventListener("storage", storageListener);
    }
    const channel = new BroadcastChannel(PRIVATE_DATA_CHANNEL_NAME);
    channel.addEventListener("message", (event) => {
      if (isPrivateDataClearedMessage(event.data)) invalidatePrivateData();
    });
    return () => {
      window.removeEventListener("storage", storageListener);
      channel.close();
    };
  }, []);

  useEffect(() => {
    if (!isOnline || !accessLogoutPending || logoutCompletionActive.current) return undefined;
    let cancelled = false;
    logoutCompletionActive.current = true;
    void completePendingAccessLogout({
      navigate: (path) => window.location.replace(path),
    }).then((navigating) => {
      if (!cancelled && !navigating) setAccessLogoutPending(true);
    }).finally(() => {
      logoutCompletionActive.current = false;
    });
    return () => { cancelled = true; };
  }, [isOnline, accessLogoutPending]);

  useEffect(() => {
    let cancelled = false;
    const generation = sessionGeneration.current;
    if (!isOnline || accessLogoutPending || isAccessLogoutPending()) {
      return () => { cancelled = true; };
    }
    setSessionResolved(preserveSessionResolutionDuringRevalidation);
    void (async () => {
      try {
        const user = await loadSession();
        if (cancelled || generation !== sessionGeneration.current) return;
        await reconcilePrivateDataSession(user.cacheNamespace, clearPrivateLocalData);
        if (cancelled || generation !== sessionGeneration.current) return;
        setSession(user);
        setSessionResolved(true);
        setPrivateDataBlocked(false);
      } catch {
        if (!cancelled && generation === sessionGeneration.current) {
          setSession(null);
          setSessionResolved(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isOnline, accessLogoutPending]);

  const canEdit = !sessionResolved ? null : session?.role === "editor" || session?.role === "admin";

  return (
    <UnsavedChangesProvider>
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

      {privateDataBlocked
        ? <main className="page-shell" id="main-content"><p>{accessLogoutPending ? "This device’s private library has been cleared. Cloudflare sign-out is pending and will finish automatically when this device reconnects." : "This device’s private library has been cleared. Reconnect and sign in to sync it again."}</p></main>
        : isOnline && !sessionResolved
        ? <main className="page-shell" id="main-content"><p>Checking this device’s private session…</p></main>
        : <Routes>
        <Route path="/songs" element={(
          <SongsPage
            isOnline={isOnline}
            canEdit={canEdit}
            view={catalogView}
            onViewChange={setCatalogView}
            scrollPosition={catalogScrollPosition}
          />
        )} />
        <Route path="/songs/new" element={<SongEditorPage mode="create" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/edit" element={<SongEditorPage mode="edit" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/lyrics/new" element={<LyricEditorPage mode="create" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/lyrics/:lyricId/edit" element={<LyricEditorPage mode="edit" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/scans/new" element={<ScanEditorPage mode="create" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/scans/:scanId/replace" element={<ScanEditorPage mode="replace" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/scans/:scanId/edit" element={<ScanEditorPage mode="edit" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/recordings/new" element={<RecordingUploadPage mode="create" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/recordings/:recordingId/replace" element={<RecordingUploadPage mode="replace" isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId/recordings/:recordingId/edit" element={<RecordingEditorPage isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/songs/:songId" element={<SongDetailPage isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/trash" element={<TrashPage isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/manage" element={<ManageLookupsPage isOnline={isOnline} canEdit={canEdit} />} />
        <Route path="/account" element={<AccountPage session={session} onLogout={logoutAndClear} />} />
        <Route path="*" element={<Navigate to="/songs" replace />} />
      </Routes>}

      {!privateDataBlocked && <nav className="bottom-nav" aria-label="Primary navigation">
        <Link to="/songs">Songs</Link>
        {canEdit === true && <Link to="/trash">Trash</Link>}
        {canEdit === true && <Link to="/manage">Lists</Link>}
        <Link to="/account">Account</Link>
      </nav>}
    </div>
    </UnsavedChangesProvider>
  );
}
