import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";
import {
  readCachedCatalog,
  readCachedSong,
  refreshCatalog,
  refreshSong,
  type CatalogSong,
  type SongDetail,
} from "./catalog";

function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return isOnline;
}

function SongsPage({ isOnline }: { isOnline: boolean }) {
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
          const fresh = await refreshCatalog();
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
        <button className="primary-action" type="button" disabled title="Editing arrives after the catalog import">
          Add song
        </button>
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
            <dt>{credit.role}</dt>
            <dd>{credit.fullName}{credit.notes ? ` · ${credit.notes}` : ""}</dd>
          </div>
        ))}
      </dl>
      {song.notes && <p className="detail-notes">{song.notes}</p>}
    </section>
  );
}

function SongDetailPage({ isOnline }: { isOnline: boolean }) {
  const { songId = "" } = useParams();
  const [song, setSong] = useState<SongDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
        <p className="eyebrow">Song</p>
        <h1>{song.titleLatin}</h1>
        {song.titleNative && <p className="native-title" lang="und">{song.titleNative}</p>}
        {error && <p className="catalog-message error-message" role="alert">Showing saved copy · {error}</p>}
      </header>

      <div className="detail-grid">
        <div className="detail-main">
          {song.lyricTexts.map((lyrics) => (
            <section className="detail-card lyrics-card" key={lyrics.id} aria-labelledby={`${lyrics.id}-title`}>
              <p className="eyebrow">{lyrics.languageName ?? lyrics.representation.replaceAll("_", " ")}</p>
              <h2 id={`${lyrics.id}-title`}>{lyrics.label ?? "Typed lyrics"}</h2>
              <pre>{lyrics.content}</pre>
            </section>
          ))}

          {song.recordings.length > 0 && (
            <section className="detail-card" aria-labelledby="recordings-title">
              <h2 id="recordings-title">Recordings <span>{song.recordings.length}</span></h2>
              <ul className="media-list">
                {song.recordings.map((recording) => (
                  <li key={recording.id}>
                    <div className="recording-item">
                      <strong>{recording.version || "Recording"}</strong>
                      <span>{recording.recordedOn || recording.filename}</span>
                      <audio
                        controls
                        preload="metadata"
                        src={`/api/media/${encodeURIComponent(recording.playbackMediaId ?? recording.originalMediaId)}`}
                      />
                    </div>
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
                    <div><strong>{scan.version || scan.source}</strong><span>{[scan.notebookName, scan.pageLabel].filter(Boolean).join(" · ") || scan.filename}</span></div>
                    <a className="media-action" href={`/api/media/${encodeURIComponent(scan.mediaId)}`} target="_blank" rel="noreferrer">View</a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <aside><MetadataList song={song} /></aside>
      </div>
    </main>
  );
}

function AccountPage() {
  return (
    <main className="page-shell account-page" id="main-content">
      <p className="eyebrow">Application</p>
      <h1>Account and sync</h1>
      <dl className="settings-list">
        <div>
          <dt>Environment</dt>
          <dd>Local development</dd>
        </div>
        <div>
          <dt>Catalog</dt>
          <dd>Waiting for first import</dd>
        </div>
      </dl>
    </main>
  );
}

export function App() {
  const isOnline = useOnlineStatus();

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
        <Route path="/songs" element={<SongsPage isOnline={isOnline} />} />
        <Route path="/songs/:songId" element={<SongDetailPage isOnline={isOnline} />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="*" element={<Navigate to="/songs" replace />} />
      </Routes>

      <nav className="bottom-nav" aria-label="Primary navigation">
        <Link to="/songs">Songs</Link>
        <Link to="/account">Account</Link>
      </nav>
    </div>
  );
}
