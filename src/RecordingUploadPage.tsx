import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CreditRows } from "./CreditRows";
import {
  loadRecordingEditorOptions,
  refreshOfflineLibrary,
  refreshSong,
  type RecordingEditorOptions,
} from "./catalog";
import {
  MAX_RECORDING_UPLOAD_BYTES,
  RecordingUploadError,
  abortRecordingUpload,
  uploadRecordingOriginal,
  type DuplicateRecording,
  type RecordingUploadInput,
  type RecordingUploadProgress,
  type RecordingUploadSession,
} from "./recording-upload";
import {
  RECORDING_FILE_ACCEPT,
  canAbortRecordingUpload,
  formatRecordingBytes,
  recordingUploadPercent,
  recordingUploadProgressLabel,
} from "./recording-upload-view";

export function RecordingUploadPage({
  isOnline,
  canEdit,
}: {
  isOnline: boolean;
  canEdit: boolean | null;
}) {
  const { songId = "" } = useParams();
  const navigate = useNavigate();
  const [options, setOptions] = useState<RecordingEditorOptions | null>(null);
  const [songTitle, setSongTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [recordedOn, setRecordedOn] = useState("");
  const [vocalistIds, setVocalistIds] = useState<string[]>([]);
  const [attempt, setAttempt] = useState<RecordingUploadInput | null>(null);
  const [upload, setUpload] = useState<RecordingUploadSession | null>(null);
  const [progress, setProgress] = useState<RecordingUploadProgress | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateRecording | null>(null);
  const [descriptionConflict, setDescriptionConflict] = useState<{
    existingId: string;
    existingSongId: string;
  } | null>(null);
  const [descriptionOverride, setDescriptionOverride] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

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
        if (!cancelled) {
          setOptions(editorOptions);
          setSongTitle(song.titleLatin);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error
            ? loadError.message
            : "The Recording upload form could not be loaded.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [canEdit, isOnline, songId]);

  useEffect(() => {
    if (!isOnline) activeRequest.current?.abort();
  }, [isOnline]);

  useEffect(() => () => activeRequest.current?.abort(), []);

  useEffect(() => {
    if (!attempt || duplicate || upload?.status === "finalized" || upload?.status === "aborted") {
      return undefined;
    }
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [attempt, duplicate, upload?.status]);

  function chooseFile(nextFile: File | null): void {
    if (attempt) return;
    setFile(nextFile);
    setError(null);
    setNotice(null);
    setFieldErrors((current) => ({ ...current, file: [] }));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isOnline || canEdit !== true || isSaving || duplicate) return;
    if (!attempt && !file) {
      setFieldErrors({ file: ["Choose an audio file"] });
      return;
    }
    if (descriptionConflict && descriptionOverride.trim().length === 0) {
      setFieldErrors({ descriptionOverride: ["Enter a different Recording description"] });
      return;
    }

    const currentAttempt = attempt ?? {
      songId,
      file: file!,
      clientMutationId: crypto.randomUUID(),
      description: description.trim() || null,
      recordedOn: recordedOn || null,
      creditPersonIds: vocalistIds,
    };
    setAttempt(currentAttempt);
    setIsSaving(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    try {
      const result = await uploadRecordingOriginal(currentAttempt, {
        signal: controller.signal,
        resumeUpload: upload ?? undefined,
        ...(descriptionConflict
          ? { descriptionOverride: descriptionOverride.trim() }
          : {}),
        onProgress: (nextProgress) => {
          setProgress(nextProgress);
          if (nextProgress.upload) setUpload(nextProgress.upload);
        },
      });
      setUpload(result.upload);
      if (result.kind === "duplicate") {
        setDuplicate(result.duplicateRecording);
        setProgress(null);
        setError(null);
        return;
      }
      await refreshOfflineLibrary().catch(() => undefined);
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (saveError) {
      if (saveError instanceof DOMException && saveError.name === "AbortError") {
        setError("The upload paused when the connection changed. Reconnect and retry from the server-held checkpoint.");
      } else if (saveError instanceof RecordingUploadError) {
        setError(saveError.message);
        setFieldErrors(saveError.fields ?? {});
        if (saveError.upload) setUpload(saveError.upload);
        if (saveError.code === "duplicate_recording_description" && saveError.existingRecording) {
          setDescriptionConflict({
            existingId: saveError.existingRecording.id,
            existingSongId: saveError.existingRecording.songId,
          });
        }
      } else {
        setError(saveError instanceof Error
          ? saveError.message
          : "The Recording upload could not continue.");
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      setIsSaving(false);
    }
  }

  async function abortUpload(): Promise<void> {
    if (
      !isOnline
      || canEdit !== true
      || isSaving
      || !upload
      || !canAbortRecordingUpload(upload.status)
    ) return;
    if (!window.confirm(
      "Cancel this incomplete Recording upload? Its server-held multipart state will be aborted and cannot be resumed.",
    )) return;

    setIsSaving(true);
    setError(null);
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      await abortRecordingUpload(upload, fetch, controller.signal);
      setAttempt(null);
      setUpload(null);
      setProgress(null);
      setFile(null);
      setDescriptionConflict(null);
      setDescriptionOverride("");
      setNotice("The incomplete private upload was cancelled. You can choose a file to start again.");
    } catch (abortError) {
      if (abortError instanceof RecordingUploadError) {
        setError(abortError.message);
        if (abortError.upload) setUpload(abortError.upload);
      } else if (!(abortError instanceof DOMException && abortError.name === "AbortError")) {
        setError(abortError instanceof Error
          ? abortError.message
          : "The incomplete upload could not be cancelled.");
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      setIsSaving(false);
    }
  }

  const songUrl = `/songs/${encodeURIComponent(songId)}`;
  if (!isOnline) {
    return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Song</Link><section className="empty-state"><h1>Recording uploads are offline</h1><p>Reconnect to start or resume a private audio upload. Existing Song information remains available to read.</p></section></main>;
  }
  if (canEdit === null) return <main className="page-shell" id="main-content"><p>Checking editor access…</p></main>;
  if (!canEdit) return <main className="page-shell" id="main-content"><Link className="back-link" to={songUrl}>← Song</Link><section className="empty-state"><h1>Editor access required</h1></section></main>;
  if (isLoading) return <main className="page-shell" id="main-content"><p>Loading Recording upload…</p></main>;

  const percent = progress ? recordingUploadPercent(progress) : 0;
  const formLocked = attempt !== null;
  const mayAbort = upload ? canAbortRecordingUpload(upload.status) : false;

  return (
    <main className="page-shell editor-page" id="main-content">
      {!attempt && <Link className="back-link" to={songUrl}>← Cancel</Link>}
      <header className="editor-heading">
        <p className="eyebrow">{songTitle || "Song"}</p>
        <h1>Add Recording</h1>
        <p className="lede">Upload one private original. Playback stays unavailable until the stored bytes have been verified and any required derivative is ready.</p>
      </header>

      {error && <p className="catalog-message error-message" role="alert">{error}</p>}
      {notice && <p className="catalog-message" role="status">{notice}</p>}

      {duplicate && (
        <section className="recording-upload-notice" aria-labelledby="duplicate-recording-title">
          <div>
            <strong id="duplicate-recording-title">This exact audio original is already stored</strong>
            <span>No new Recording or processing job was created.</span>
            {duplicate.trashed && <span>The matching Recording is currently in Trash.</span>}
          </div>
          <div className="recording-upload-notice-actions">
            {duplicate.id && duplicate.songId && (
              <Link className="secondary-action action-link" to={duplicate.trashed ? "/trash" : `/songs/${encodeURIComponent(duplicate.songId)}`}>{duplicate.trashed ? "Open Trash" : "Open existing Song"}</Link>
            )}
            <Link className="primary-action action-link" to={songUrl}>Return to Song</Link>
          </div>
        </section>
      )}

      {!duplicate && (
        <form className="song-form" onSubmit={(event) => { void submit(event); }}>
          <section className="form-card">
            <div className="form-field">
              <span>Audio original <strong aria-hidden="true">*</strong></span>
              {file ? (
                <div className="selected-recording-file">
                  <div>
                    <strong>{file.name}</strong>
                    <span>{formatRecordingBytes(file.size)}</span>
                  </div>
                  {!formLocked && <button className="secondary-action" type="button" onClick={() => chooseFile(null)}>Remove and choose again</button>}
                </div>
              ) : (
                <label className="recording-file-source">
                  <strong>Choose audio file</strong>
                  <span>Browse recordings or files on this device</span>
                  <span className="scan-source-action">Browse audio</span>
                  <input
                    className="scan-source-input"
                    type="file"
                    accept={RECORDING_FILE_ACCEPT}
                    onChange={(event) => {
                      chooseFile(event.target.files?.[0] ?? null);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              )}
              <small>Maximum 512 MB. The browser sends sequential 8 MiB parts; the original remains private and is retained even when a separate playback copy is needed.</small>
              {fieldErrors.file?.map((message) => <em key={message}>{message}</em>)}
              {fieldErrors.byteSize?.map((message) => <em key={message}>{message}</em>)}
              {fieldErrors.form?.map((message) => <em key={message}>{message}</em>)}
              {file && file.size > MAX_RECORDING_UPLOAD_BYTES && <em>The selected file is larger than 512 MB.</em>}
            </div>
            <label className="form-field">
              <span>Recording description</span>
              <textarea disabled={formLocked} rows={5} maxLength={10_000} value={description} onChange={(event) => setDescription(event.target.value)} />
              <small>Optional. Leave empty to use the first available “Recording N” name. Capitalization is preserved.</small>
              {fieldErrors.description?.map((message) => <em key={message}>{message}</em>)}
            </label>
            <label className="form-field compact-field">
              <span>Recorded date</span>
              <input disabled={formLocked} type="date" max={new Date().toISOString().slice(0, 10)} value={recordedOn} onChange={(event) => setRecordedOn(event.target.value)} />
              {fieldErrors.recordedOn?.map((message) => <em key={message}>{message}</em>)}
            </label>
          </section>

          <fieldset className="form-card choice-group" disabled={formLocked}>
            <legend>Vocals</legend>
            <p>Optional. Select the people who sang in this Recording.</p>
            <CreditRows
              people={options?.people ?? []}
              roles={[{ value: "vocals" as const, label: "Vocals" }]}
              value={vocalistIds.map((personId) => ({ personId, role: "vocals" as const }))}
              onChange={(credits) => setVocalistIds(credits.map((credit) => credit.personId))}
              disabled={formLocked}
            />
            {fieldErrors.creditPersonIds?.map((message) => <em key={message}>{message}</em>)}
          </fieldset>

          {progress && (
            <section className="recording-upload-progress" aria-live="polite">
              <div>
                <strong>{recordingUploadProgressLabel(progress)}</strong>
                <span>{progress.completedParts} of {progress.totalParts} parts safely checkpointed</span>
              </div>
              <progress max={100} value={percent}>{percent}%</progress>
            </section>
          )}

          {descriptionConflict && (
            <section className="recording-description-conflict" aria-labelledby="recording-description-conflict-title">
              <div>
                <strong id="recording-description-conflict-title">Choose a different description to finish</strong>
                <span>The verified private original is stored safely. No Recording has been created yet.</span>
                <Link to={`/songs/${encodeURIComponent(descriptionConflict.existingSongId)}/recordings/${encodeURIComponent(descriptionConflict.existingId)}/edit`}>Open the existing Recording</Link>
              </div>
              <label className="form-field">
                <span>New Recording description <strong aria-hidden="true">*</strong></span>
                <textarea required rows={4} maxLength={10_000} value={descriptionOverride} onChange={(event) => {
                  setDescriptionOverride(event.target.value);
                  setFieldErrors((current) => ({ ...current, descriptionOverride: [] }));
                }} />
                {fieldErrors.descriptionOverride?.map((message) => <em key={message}>{message}</em>)}
              </label>
            </section>
          )}

          <div className="form-actions">
            {!attempt && <Link className="secondary-action action-link" to={songUrl}>Cancel</Link>}
            {mayAbort && !isSaving && <button className="danger-action" type="button" onClick={() => { void abortUpload(); }}>Cancel incomplete upload</button>}
            <button
              className="primary-action"
              type="submit"
              disabled={
                isSaving
                || (!attempt && (!file || file.size === 0 || file.size > MAX_RECORDING_UPLOAD_BYTES))
                || (descriptionConflict !== null && descriptionOverride.trim().length === 0)
              }
            >
              {isSaving
                ? "Working…"
                : descriptionConflict
                  ? "Finish Recording"
                  : attempt
                    ? "Retry upload"
                    : "Upload and add Recording"}
            </button>
          </div>
          {attempt && !mayAbort && upload?.status === "stored" && !descriptionConflict && (
            <p className="media-note">The original is already verified in private storage. Retry to finish creating the Recording; this stored object is not abortable.</p>
          )}
        </form>
      )}
    </main>
  );
}
