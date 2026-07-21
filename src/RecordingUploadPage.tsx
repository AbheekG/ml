import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CreditRows } from "./CreditRows";
import { RecordingDateField } from "./RecordingDateField";
import { FeedbackMessage, useRevealFeedback } from "./FeedbackMessage";
import {
  loadRecordingEditorOptions,
  moveTrashedRecording,
  refreshOfflineLibrary,
  refreshSong,
  type RecordingEditorOptions,
} from "./catalog";
import {
  MAX_RECORDING_UPLOAD_BYTES,
  RecordingUploadError,
  abortRecordingUpload,
  completeServerHeldRecordingUpload,
  discardRecordingUpload,
  finishStoredRecordingUpload,
  listRecoverableRecordingUploads,
  reuseHistoricalRecordingUpload,
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
import { editorValuesChanged, shouldRefreshEditor, useUnsavedChanges } from "./UnsavedChanges";

export function RecordingUploadPage({
  mode = "create",
  isOnline,
  canEdit,
}: {
  mode?: "create" | "replace";
  isOnline: boolean;
  canEdit: boolean | null;
}) {
  const { songId = "", recordingId } = useParams();
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
  const duplicateNoticeRef = useRevealFeedback(duplicate);
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
  const [replaceTarget, setReplaceTarget] = useState<{ recordingId: string; revision: number } | null>(null);
  const [recoverableUploads, setRecoverableUploads] = useState<RecordingUploadSession[]>([]);
  const activeRequest = useRef<AbortController | null>(null);
  const editorKey = `${mode}:${songId}:${recordingId ?? ""}`;
  const loadedEditorKey = useRef<string | null>(null);
  const [initialValues, setInitialValues] = useState<{
    key: string;
    value: { description: string; recordedOn: string; vocalistIds: string[]; fileSelected: boolean };
  } | null>(null);
  const currentValues = { description, recordedOn, vocalistIds, fileSelected: file !== null };
  const uploadRequiresAttention = attempt !== null
    && !duplicate
    && upload?.status !== "finalized"
    && upload?.status !== "aborted";
  const hasUnsavedChanges = !duplicate && (
    uploadRequiresAttention
    || (initialValues?.key === editorKey && editorValuesChanged(initialValues.value, currentValues))
  );
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
        const [editorOptions, song, serverUploads] = await Promise.all([
          loadRecordingEditorOptions(),
          refreshSong(songId),
          listRecoverableRecordingUploads(songId).catch(() => []),
        ]);
        if (!cancelled) {
          setOptions(editorOptions);
          setSongTitle(song.titleLatin);
          setFile(null);
          setAttempt(null);
          setUpload(null);
          setProgress(null);
          setDuplicate(null);
          setDescriptionConflict(null);
          setDescriptionOverride("");
          setRecoverableUploads(serverUploads.filter((candidate) => (
            candidate.intent === null
            || (mode === "create" && candidate.intent.kind === "create")
            || (
              mode === "replace"
              && candidate.intent.kind === "replace"
              && candidate.intent.targetRecordingId === recordingId
            )
          )));
          if (mode === "replace") {
            const recording = song.recordings.find((r) => r.id === recordingId);
            if (!recording) throw new Error("This Recording is no longer available.");
            if (recording.processingState === "processing") {
              throw new Error("Wait for the current audio processing to finish before replacing this Recording.");
            }
            const nextValues = {
              description: recording.description,
              recordedOn: recording.recordedOn || "",
              vocalistIds: recording.credits.filter((c) => c.role === "vocals").map((c) => c.personId),
              fileSelected: false,
            };
            setDescription(nextValues.description);
            setRecordedOn(nextValues.recordedOn);
            setVocalistIds(nextValues.vocalistIds);
            setInitialValues({ key: editorKey, value: nextValues });
            setReplaceTarget({ recordingId: recording.id, revision: recording.revision });
          } else {
            const nextValues = {
              description: "",
              recordedOn: "",
              vocalistIds: [] as string[],
              fileSelected: false,
            };
            setDescription(nextValues.description);
            setRecordedOn(nextValues.recordedOn);
            setVocalistIds(nextValues.vocalistIds);
            setInitialValues({ key: editorKey, value: nextValues });
            setReplaceTarget(null);
          }
          loadedEditorKey.current = editorKey;
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
  }, [canEdit, editorKey, isOnline, mode, recordingId, songId]);

  useEffect(() => {
    if (!isOnline) activeRequest.current?.abort();
  }, [isOnline]);

  useEffect(() => () => activeRequest.current?.abort(), []);

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
        ...(replaceTarget ? { replaceTarget } : {}),
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
      allowNextNavigation();
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
      setRecoverableUploads((current) => current.filter((candidate) => candidate.id !== upload.id));
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

  function selectRecoverableUpload(candidate: RecordingUploadSession): void {
    setUpload(candidate);
    setProgress(null);
    setError(null);
    setNotice("Reselect the same original file. Upload will continue only from server-verified parts.");
  }

  async function finishRecoverableUpload(candidate: RecordingUploadSession): Promise<void> {
    if (!isOnline || canEdit !== true || isSaving) return;
    setIsSaving(true);
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const stored = candidate.status === "stored"
        ? candidate
        : await completeServerHeldRecordingUpload(candidate, fetch, controller.signal);
      if (stored.status === "duplicate" && stored.duplicateRecording) {
        setDuplicate(stored.duplicateRecording);
        setUpload(stored);
        setRecoverableUploads((current) => current.map((item) => (
          item.id === stored.id ? stored : item
        )));
        return;
      }
      const replacement = stored.intent?.kind === "replace"
        ? {
            recordingId: stored.intent.targetRecordingId,
            revision: stored.intent.targetRecordingRevision,
          }
        : undefined;
      const result = await finishStoredRecordingUpload(stored, {
        signal: controller.signal,
        replaceTarget: replacement,
      });
      if (result.kind === "duplicate") {
        setDuplicate(result.duplicateRecording);
        setUpload(result.upload);
        setRecoverableUploads((current) => current.map((item) => (
          item.id === result.upload.id ? result.upload : item
        )));
        return;
      }
      await refreshOfflineLibrary().catch(() => undefined);
      allowNextNavigation();
      navigate(`/songs/${encodeURIComponent(songId)}`, { replace: true });
    } catch (finishError) {
      setError(finishError instanceof Error
        ? finishError.message
        : "The server-held Recording upload could not be finished.");
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      setIsSaving(false);
    }
  }

  async function discardRecoverableUpload(candidate: RecordingUploadSession): Promise<void> {
    if (!isOnline || canEdit !== true || isSaving) return;
    if (!window.confirm(
      "Dismiss this completed upload? Its private object will be retained for administrator review, but it will no longer block this Song.",
    )) return;
    setIsSaving(true);
    setError(null);
    try {
      await discardRecordingUpload(candidate);
      setRecoverableUploads((current) => current.filter((item) => item.id !== candidate.id));
      if (upload?.id === candidate.id) setUpload(null);
      setNotice("The upload was dismissed from active work. Its private object remains retained for review.");
    } catch (discardError) {
      setError(discardError instanceof Error
        ? discardError.message
        : "The completed upload could not be dismissed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function recoverDuplicateRecording(): Promise<void> {
    if (
      !duplicate?.trashed
      || !duplicate.id
      || !duplicate.songId
      || duplicate.revision === null
      || !upload
      || isSaving
      || !isOnline
      || canEdit !== true
    ) return;
    const restoringHere = duplicate.songId === songId;
    if (!window.confirm(
      `${restoringHere ? "Restore" : "Move"} the existing Recording ${restoringHere ? "to this Song" : `to “${songTitle}”`}? The stored audio will be reused and the duplicate upload checkpoint will be dismissed. Nothing will be copied or deleted.`,
    )) return;
    setIsSaving(true);
    setError(null);
    try {
      await moveTrashedRecording(
        duplicate.id,
        duplicate.revision,
        songId,
        { sessionId: upload.id, revision: upload.revision },
      );
      await refreshOfflineLibrary().catch(() => undefined);
      allowNextNavigation();
      navigate(`/songs/${encodeURIComponent(songId)}`, {
        replace: true,
        state: {
          statusMessage: `Recording ${restoringHere ? "restored to" : "moved to"} “${songTitle}”.`,
        },
      });
    } catch (moveError) {
      setError(moveError instanceof Error
        ? moveError.message
        : "The existing Recording could not be recovered.");
    } finally {
      setIsSaving(false);
    }
  }

  async function reuseHistoricalRecording(): Promise<void> {
    if (
      mode !== "replace"
      || !duplicate?.isHistorical
      || !duplicate.id
      || duplicate.id !== recordingId
      || !upload
      || !replaceTarget
      || isSaving
      || !isOnline
      || canEdit !== true
    ) return;
    if (!window.confirm(
      "Restore this retained historical audio as the current Recording? The current audio will be preserved in history, and the duplicate upload object will remain private for administrator review.",
    )) return;
    setIsSaving(true);
    setError(null);
    try {
      await reuseHistoricalRecordingUpload(upload, replaceTarget);
      await refreshOfflineLibrary().catch(() => undefined);
      allowNextNavigation();
      navigate(`/songs/${encodeURIComponent(songId)}`, {
        replace: true,
        state: { statusMessage: "The retained historical audio is current again." },
      });
    } catch (reuseError) {
      setError(reuseError instanceof Error
        ? reuseError.message
        : "The retained historical audio could not be restored.");
    } finally {
      setIsSaving(false);
    }
  }

  async function abortRecoverableUpload(candidate: RecordingUploadSession): Promise<void> {
    if (!isOnline || canEdit !== true || isSaving) return;
    if (!window.confirm("Cancel this incomplete upload? It cannot be resumed afterward.")) return;
    setIsSaving(true);
    setError(null);
    try {
      await abortRecordingUpload(candidate);
      setRecoverableUploads((current) => current.filter((item) => item.id !== candidate.id));
      if (upload?.id === candidate.id) setUpload(null);
      setNotice("The incomplete private upload was cancelled.");
    } catch (abortError) {
      setError(abortError instanceof Error
        ? abortError.message
        : "The incomplete upload could not be cancelled.");
    } finally {
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
        <h1>{mode === "replace" ? "Replace Recording Audio" : "Add Recording"}</h1>
        <p className="lede">
          {mode === "replace"
            ? "Upload a new private original to replace the current audio. The previous audio is preserved in history."
            : "Upload one private original. Playback stays unavailable until the stored bytes have been verified and any required derivative is ready."}
        </p>
      </header>

      <FeedbackMessage message={error} />
      <FeedbackMessage message={notice} tone="status" />

      {!attempt && recoverableUploads.length > 0 && (
        <section className="form-card" aria-labelledby="recover-recording-uploads-title">
          <h2 id="recover-recording-uploads-title">Server-held uploads</h2>
          <p>These private uploads survived an interrupted page or connection.</p>
          <div className="choice-grid">
            {recoverableUploads.map((candidate) => {
              const canFinish = candidate.intent !== null && (
                candidate.status === "stored"
                || candidate.status === "completing"
                || (
                  candidate.status === "open"
                  && candidate.completedParts.length === candidate.partCount
                )
              );
              const needsFile = candidate.intent !== null
                && candidate.status === "open"
                && candidate.completedParts.length < candidate.partCount;
              return (
                <article className="recording-upload-notice" key={candidate.id}>
                  <div>
                    <strong>{candidate.filename}</strong>
                    <span>{formatRecordingBytes(candidate.byteSize)} · {candidate.status}</span>
                    {candidate.intent === null && <span>This older session needs review before it can be finalized.</span>}
                  </div>
                  <div className="recording-upload-notice-actions">
                    {canFinish && (
                      <button className="primary-action" type="button" disabled={isSaving} onClick={() => { void finishRecoverableUpload(candidate); }}>Finish</button>
                    )}
                    {needsFile && (
                      <button className="secondary-action" type="button" disabled={isSaving} onClick={() => selectRecoverableUpload(candidate)}>Resume</button>
                    )}
                    {(candidate.status === "creating" || candidate.status === "open") && (
                      <button className="danger-action" type="button" disabled={isSaving} onClick={() => { void abortRecoverableUpload(candidate); }}>Cancel upload</button>
                    )}
                    {(candidate.status === "stored" || candidate.status === "duplicate") && (
                      <button className="danger-action" type="button" disabled={isSaving} onClick={() => { void discardRecoverableUpload(candidate); }}>Dismiss</button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {duplicate && (
        <section
          className="recording-upload-notice"
          ref={duplicateNoticeRef}
          role="alert"
          aria-labelledby="duplicate-recording-title"
        >
          <div>
            <strong id="duplicate-recording-title">This exact audio original is already stored</strong>
            <span>No new Recording or processing job was created.</span>
            {duplicate.trashed && <span>The matching Recording is currently in Trash.</span>}
            {duplicate.isHistorical && <span>The matching bytes are retained in this Recording’s replacement history.</span>}
          </div>
          <div className="recording-upload-notice-actions">
            {duplicate.trashed && duplicate.id && duplicate.songId && duplicate.revision !== null && upload && (
              <button className="primary-action" type="button" disabled={isSaving} onClick={() => { void recoverDuplicateRecording(); }}>
                {isSaving ? "Moving…" : duplicate.songId === songId ? "Restore existing Recording" : "Move existing Recording here"}
              </button>
            )}
            {mode === "replace" && duplicate.isHistorical && duplicate.id === recordingId && upload && replaceTarget && (
              <button className="primary-action" type="button" disabled={isSaving} onClick={() => { void reuseHistoricalRecording(); }}>
                {isSaving ? "Restoring…" : "Restore retained audio"}
              </button>
            )}
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
            <RecordingDateField
              disabled={formLocked}
              value={recordedOn}
              onChange={setRecordedOn}
              errors={fieldErrors.recordedOn}
            />
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
