import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";

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

function SongsPage() {
  return (
    <main className="page-shell" id="main-content">
      <section className="catalog-heading" aria-labelledby="catalog-title">
        <div>
          <p className="eyebrow">Your collection</p>
          <h1 id="catalog-title">All songs</h1>
          <p className="lede">Browse titles, typed lyrics, scans, and recordings.</p>
        </div>
        <button className="primary-action" type="button" disabled title="Editing arrives after the catalog import">
          Add song
        </button>
      </section>

      <section className="catalog-tools" aria-label="Catalog tools">
        <label className="search-field">
          <span className="sr-only">Search songs</span>
          <span aria-hidden="true">⌕</span>
          <input type="search" placeholder="Search songs and lyrics" disabled />
        </label>
        <button className="secondary-action" type="button" disabled>
          Filters
        </button>
      </section>

      <section className="empty-state" aria-labelledby="empty-title">
        <div className="empty-mark" aria-hidden="true">♪</div>
        <h2 id="empty-title">Catalog foundation ready</h2>
        <p>The verified AppSheet data importer is the next step. No legacy data has been changed.</p>
      </section>
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
        <Route path="/songs" element={<SongsPage />} />
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
