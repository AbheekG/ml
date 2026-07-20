import { useId, useMemo, useState, type FormEvent } from "react";
import type { ActiveSongOption } from "./catalog";

export function filterSongDestinations(
  songs: ActiveSongOption[],
  sourceSongId: string,
  query: string,
): ActiveSongOption[] {
  const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
  if (!needle) return [];
  return songs.filter((song) => song.id !== sourceSongId && (
    song.titleLatin.normalize("NFKC").toLocaleLowerCase().includes(needle)
    || song.titleNative?.normalize("NFKC").toLocaleLowerCase().includes(needle)
  )).slice(0, 8);
}

export function MoveToSongForm({
  songs,
  sourceSongId,
  busy,
  onCancel,
  onMove,
}: {
  songs: ActiveSongOption[];
  sourceSongId: string;
  busy: boolean;
  onCancel: () => void;
  onMove: (song: ActiveSongOption) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const resultsId = useId();
  const results = useMemo(
    () => filterSongDestinations(songs, sourceSongId, query),
    [query, songs, sourceSongId],
  );
  const selected = songs.find((song) => song.id === selectedId) ?? null;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (selected && !busy) onMove(selected);
  }

  return (
    <form className="move-to-song-form" onSubmit={submit}>
      <label>
        <span>Find the destination Song</span>
        <input
          type="search"
          value={query}
          aria-controls={resultsId}
          autoComplete="off"
          placeholder="Search by Song title"
          disabled={busy}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedId(null);
          }}
        />
      </label>
      <div id={resultsId} className="move-to-song-results" aria-live="polite">
        {results.map((song) => (
          <button
            className={song.id === selectedId ? "selected" : ""}
            key={song.id}
            type="button"
            disabled={busy}
            onClick={() => {
              setSelectedId(song.id);
              setQuery(song.titleLatin);
            }}
          >
            <strong>{song.titleLatin}</strong>
            {song.titleNative && <span>{song.titleNative}</span>}
          </button>
        ))}
        {query.trim() && results.length === 0 && <small>No matching active Songs.</small>}
      </div>
      {selected && <p>Destination: <strong>{selected.titleLatin}</strong></p>}
      <div className="form-actions">
        <button className="secondary-action" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="primary-action" type="submit" disabled={busy || !selected}>{busy ? "Moving…" : "Move here"}</button>
      </div>
    </form>
  );
}
