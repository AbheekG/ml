import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(".");
const DEFAULT_CATALOG = resolve("data/import-output/catalog.json");
const DEFAULT_BATCH_MANIFEST = resolve("notes/private/audio-batch-manifest.json");
const DEFAULT_BATCH_DETAILS = resolve("notes/private/audio-batch-reuse-details.json");
const DEFAULT_PLAN = resolve("data/import-output/audio-integration-plan.json");
const PRIVATE_PLAN_ROOTS = [
  resolve("data/import-output"),
  resolve("notes/private"),
];
const PROTECTED_LEGACY_ROOTS = [resolve("legacy/appsheet"), resolve("legacy/woodchime")];
const OPAQUE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type JsonObject = Record<string, unknown>;

type MediaObject = {
  id: string;
  objectKey: string;
  originalFilename: string;
  mimeType: string | null;
  byteSize: number;
  sha256: string | null;
  kind: string;
  state: string;
};

type Recording = {
  id: string;
  originalMediaId: string;
  playbackMediaId: string | null;
  processingState: string;
  processingError: string | null;
  revision: number;
};

type BatchJob = {
  label: string;
  catalogMediaId: string;
  source: string;
  output: string;
};

type DetailEntry = {
  label: string;
  status: string;
  decision: JsonObject;
  original: JsonObject;
  derivative: JsonObject | null;
  validation: JsonObject | null;
};

export type AudioIntegrationPlan = {
  schemaVersion: 1;
  catalogSchemaVersion: 2;
  catalogSha256: string;
  policyId: string;
  originalHashUpdates: Array<{
    mediaId: string;
    expectedObjectKey: string;
    expectedSha256: string | null;
    sha256: string;
    byteSize: number;
  }>;
  playbackMediaInserts: Array<{
    id: string;
    objectKey: string;
    originalFilename: string;
    mimeType: "audio/mpeg";
    byteSize: number;
    sha256: string;
    kind: "playback_audio";
    state: "active";
    localPath: string;
  }>;
  derivativeProvenanceInserts: Array<{
    playbackMediaId: string;
    sourceMediaId: string;
    policyId: string;
    sourceSha256: string;
    sourceByteSize: number;
    derivativeSha256: string;
    derivativeByteSize: number;
  }>;
  recordingPlaybackUpdates: Array<{
    recordingId: string;
    expectedOriginalMediaId: string;
    expectedPlaybackMediaId: string | null;
    expectedRevision: number;
    playbackMediaId: string;
  }>;
};

export type AudioIntegrationAggregate = {
  schemaVersion: 1;
  mode: "dry-run" | "write-plan";
  policyId: string;
  recordings: number;
  originals: number;
  directPlayback: number;
  derivativePlayback: number;
  originalBytes: number;
  derivativeSourceBytes: number;
  derivativeBytes: number;
  originalHashBackfills: number;
  playbackMediaInserts: number;
  derivativeProvenanceInserts: number;
  recordingPlaybackUpdates: number;
  currentPlaybackMissingToDerivative: number;
  currentPlaybackOriginalToDerivative: number;
  currentPlaybackMissingToOriginal: number;
  plannedR2Objects: number;
  plannedR2Bytes: number;
  duplicateOriginalHashGroups: number;
  duplicateDerivativeHashGroups: number;
  unexpectedOutputFiles: number;
};

export type PlannerOptions = {
  catalogPath: string;
  batchManifestPath: string;
  batchDetailsPath: string;
  planPath: string;
  writePlan: boolean;
  workers: number;
  projectRoot?: string;
};

export class AudioIntegrationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function objectValue(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AudioIntegrationError(code);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new AudioIntegrationError(code);
  return value;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AudioIntegrationError(code);
  }
  return value;
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null) return null;
  return stringValue(value, code);
}

function integerValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AudioIntegrationError(code);
  }
  return value as number;
}

function sha256Value(value: unknown, code: string): string {
  const hash = stringValue(value, code);
  if (!SHA256.test(hash)) throw new AudioIntegrationError(code);
  return hash;
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

async function readJson(path: string, code: string): Promise<JsonObject> {
  try {
    return objectValue(JSON.parse(await readFile(path, "utf8")), code);
  } catch (error) {
    if (error instanceof AudioIntegrationError) throw error;
    throw new AudioIntegrationError(code);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch {
    throw new AudioIntegrationError("media_file_unreadable");
  }
  return hash.digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AudioIntegrationError("media_path_unreadable");
  }
}

async function filesBelow(root: string): Promise<Set<string>> {
  const files = new Set<string>();

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new AudioIntegrationError("batch_output_root_unreadable");
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.add(path);
      else throw new AudioIntegrationError("unsupported_batch_output_entry");
    }
  }

  await visit(root);
  return files;
}

async function mapLimit<T, U>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<U>,
): Promise<U[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AudioIntegrationError("workers_must_be_positive");
  }
  const output = new Array<U>(values.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await operation(values[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return output;
}

function duplicateGroupCount(values: string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.values()].filter((count) => count > 1).length;
}

function parseMedia(value: unknown): MediaObject {
  const row = objectValue(value, "invalid_catalog_media");
  const sha256 = nullableString(row.sha256, "invalid_catalog_media_sha256");
  if (sha256 !== null && !SHA256.test(sha256)) {
    throw new AudioIntegrationError("invalid_catalog_media_sha256");
  }
  return {
    id: stringValue(row.id, "invalid_catalog_media_id"),
    objectKey: stringValue(row.objectKey, "invalid_catalog_object_key"),
    originalFilename: stringValue(
      row.originalFilename,
      "invalid_catalog_original_filename",
    ),
    mimeType: nullableString(row.mimeType, "invalid_catalog_mime_type"),
    byteSize: integerValue(row.byteSize, "invalid_catalog_media_size"),
    sha256,
    kind: stringValue(row.kind, "invalid_catalog_media_kind"),
    state: stringValue(row.state, "invalid_catalog_media_state"),
  };
}

function parseRecording(value: unknown): Recording {
  const row = objectValue(value, "invalid_catalog_recording");
  return {
    id: stringValue(row.id, "invalid_catalog_recording_id"),
    originalMediaId: stringValue(
      row.originalMediaId,
      "invalid_catalog_recording_original",
    ),
    playbackMediaId: nullableString(
      row.playbackMediaId,
      "invalid_catalog_recording_playback",
    ),
    processingState: stringValue(
      row.processingState,
      "invalid_catalog_recording_processing_state",
    ),
    processingError: nullableString(
      row.processingError,
      "invalid_catalog_recording_processing_error",
    ),
    revision: integerValue(row.revision, "invalid_catalog_recording_revision"),
  };
}

function parseDetailEntry(value: unknown): DetailEntry {
  const row = objectValue(value, "invalid_batch_detail_entry");
  return {
    label: stringValue(row.label, "invalid_batch_detail_label"),
    status: stringValue(row.status, "invalid_batch_detail_status"),
    decision: objectValue(row.decision, "invalid_batch_detail_decision"),
    original: objectValue(row.original, "invalid_batch_detail_original"),
    derivative: row.derivative === null
      ? null
      : objectValue(row.derivative, "invalid_batch_detail_derivative"),
    validation: row.validation === null
      ? null
      : objectValue(row.validation, "invalid_batch_detail_validation"),
  };
}

function sortedBy<T>(values: T[], key: (value: T) => string): T[] {
  return values.sort((left, right) => key(left).localeCompare(key(right), "en"));
}

export async function buildAudioIntegrationPlan(
  options: PlannerOptions,
): Promise<{ plan: AudioIntegrationPlan; aggregate: AudioIntegrationAggregate }> {
  const projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
  const catalogPath = resolve(options.catalogPath);
  const manifestPath = resolve(options.batchManifestPath);
  const detailsPath = resolve(options.batchDetailsPath);
  const [catalog, manifest, details, catalogSha256] = await Promise.all([
    readJson(catalogPath, "invalid_catalog"),
    readJson(manifestPath, "invalid_batch_manifest"),
    readJson(detailsPath, "invalid_batch_details"),
    sha256File(catalogPath),
  ]);

  if (catalog.schemaVersion !== 2) {
    throw new AudioIntegrationError("unsupported_catalog_version");
  }
  if (manifest.schemaVersion !== 1) {
    throw new AudioIntegrationError("unsupported_batch_manifest_version");
  }
  if (details.schemaVersion !== 1 || details.mode !== "execute") {
    throw new AudioIntegrationError("unverified_batch_details");
  }

  const media = arrayValue(catalog.mediaObjects, "catalog_media_required").map(parseMedia);
  const recordings = arrayValue(
    catalog.recordings,
    "catalog_recordings_required",
  ).map(parseRecording);
  const mediaById = new Map(media.map((row) => [row.id, row]));
  const recordingByOriginal = new Map<string, Recording>();
  for (const recording of recordings) {
    if (recordingByOriginal.has(recording.originalMediaId)) {
      throw new AudioIntegrationError("duplicate_recording_original");
    }
    recordingByOriginal.set(recording.originalMediaId, recording);
  }
  if (mediaById.size !== media.length) {
    throw new AudioIntegrationError("duplicate_catalog_media_id");
  }

  const manifestBase = dirname(manifestPath);
  const outputRootValue = stringValue(
    manifest.outputRoot,
    "invalid_batch_output_root",
  );
  const outputRoot = resolve(manifestBase, outputRootValue);
  if (options.writePlan) {
    const planPath = resolve(options.planPath);
    if (
      [catalogPath, manifestPath, detailsPath].includes(planPath)
      || isWithin(planPath, outputRoot)
    ) {
      throw new AudioIntegrationError("plan_output_replaces_input_or_media");
    }
  }
  const rawJobs = arrayValue(manifest.jobs, "batch_jobs_required");
  const jobs: BatchJob[] = rawJobs.map((value) => {
    const row = objectValue(value, "invalid_batch_job");
    const label = stringValue(row.label, "invalid_batch_label");
    if (!OPAQUE_LABEL.test(label)) {
      throw new AudioIntegrationError("invalid_batch_label");
    }
    const output = resolve(
      manifestBase,
      stringValue(row.output, "invalid_batch_output"),
    );
    if (!isWithin(output, outputRoot) || !output.toLowerCase().endsWith(".mp3")) {
      throw new AudioIntegrationError("invalid_batch_output");
    }
    return {
      label,
      catalogMediaId: stringValue(
        row.catalogMediaId,
        "batch_catalog_media_id_required",
      ),
      source: resolve(
        manifestBase,
        stringValue(row.input, "invalid_batch_input"),
      ),
      output,
    };
  });
  if (new Set(jobs.map((job) => job.label)).size !== jobs.length) {
    throw new AudioIntegrationError("duplicate_batch_label");
  }
  if (new Set(jobs.map((job) => job.catalogMediaId)).size !== jobs.length) {
    throw new AudioIntegrationError("duplicate_batch_catalog_media");
  }
  if (new Set(jobs.map((job) => job.source)).size !== jobs.length) {
    throw new AudioIntegrationError("duplicate_batch_input");
  }
  if (new Set(jobs.map((job) => job.output)).size !== jobs.length) {
    throw new AudioIntegrationError("duplicate_batch_output");
  }

  const detailEntries = arrayValue(
    details.entries,
    "batch_detail_entries_required",
  ).map(parseDetailEntry);
  const detailByLabel = new Map(detailEntries.map((entry) => [entry.label, entry]));
  if (detailByLabel.size !== detailEntries.length) {
    throw new AudioIntegrationError("duplicate_batch_detail_label");
  }
  if (detailEntries.length !== jobs.length) {
    throw new AudioIntegrationError("batch_detail_count_mismatch");
  }

  const originalMedia = media.filter((row) => row.kind === "original_audio");
  if (jobs.length !== recordings.length || jobs.length !== originalMedia.length) {
    throw new AudioIntegrationError("catalog_batch_count_mismatch");
  }

  const expectedOutputFiles = new Set<string>();
  const originalHashes: string[] = [];
  const derivativeHashes: string[] = [];
  const originalHashUpdates: AudioIntegrationPlan["originalHashUpdates"] = [];
  const playbackMediaInserts: AudioIntegrationPlan["playbackMediaInserts"] = [];
  const derivativeProvenanceInserts: AudioIntegrationPlan["derivativeProvenanceInserts"] = [];
  const recordingPlaybackUpdates: AudioIntegrationPlan["recordingPlaybackUpdates"] = [];
  const objectKeys = new Set(media.map((row) => row.objectKey));
  const derivativePolicyIds = new Set<string>();
  let directPlayback = 0;
  let derivativePlayback = 0;
  let originalBytes = 0;
  let derivativeSourceBytes = 0;
  let derivativeBytes = 0;
  let missingToDerivative = 0;
  let originalToDerivative = 0;
  let missingToOriginal = 0;

  await mapLimit(jobs, options.workers, async (job) => {
    const original = mediaById.get(job.catalogMediaId);
    const recording = recordingByOriginal.get(job.catalogMediaId);
    const detail = detailByLabel.get(job.label);
    if (!original || original.kind !== "original_audio" || original.state !== "active") {
      throw new AudioIntegrationError("invalid_batch_original_media");
    }
    if (!recording || !detail) {
      throw new AudioIntegrationError("batch_relationship_missing");
    }
    if (
      recording.processingState !== "ready"
      || recording.processingError !== null
      || recording.revision < 1
    ) {
      throw new AudioIntegrationError("unexpected_recording_processing_state");
    }
    const catalogSource = resolve(projectRoot, "legacy/appsheet", original.objectKey);
    if (
      !isWithin(catalogSource, resolve(projectRoot, "legacy/appsheet"))
      || catalogSource !== job.source
    ) {
      throw new AudioIntegrationError("batch_source_catalog_mismatch");
    }

    let sourceStats;
    try {
      sourceStats = await stat(job.source);
    } catch {
      throw new AudioIntegrationError("media_file_unreadable");
    }
    if (!sourceStats.isFile() || sourceStats.size !== original.byteSize) {
      throw new AudioIntegrationError("source_size_mismatch");
    }
    const sourceHash = await sha256File(job.source);
    const detailSourceHash = sha256Value(
      detail.original.sha256,
      "invalid_detail_source_hash",
    );
    const detailSourceBytes = integerValue(
      detail.original.byte_size,
      "invalid_detail_source_size",
    );
    if (sourceHash !== detailSourceHash || sourceStats.size !== detailSourceBytes) {
      throw new AudioIntegrationError("source_detail_mismatch");
    }
    if (original.sha256 !== null && original.sha256 !== sourceHash) {
      throw new AudioIntegrationError("catalog_source_hash_mismatch");
    }
    originalHashes.push(sourceHash);
    originalBytes += sourceStats.size;
    if (original.sha256 === null) {
      originalHashUpdates.push({
        mediaId: original.id,
        expectedObjectKey: original.objectKey,
        expectedSha256: null,
        sha256: sourceHash,
        byteSize: sourceStats.size,
      });
    }

    const decision = stringValue(
      detail.decision.kind,
      "invalid_batch_detail_decision_kind",
    );
    const sidecarPath = `${job.output}.json`;
    if (decision === "use_original") {
      if (
        detail.status !== "original_is_playback"
        || detail.derivative !== null
        || detail.validation !== null
      ) {
        throw new AudioIntegrationError("invalid_direct_playback_detail");
      }
      if (await pathExists(job.output)) {
        throw new AudioIntegrationError("unexpected_direct_playback_output");
      }
      if (await pathExists(sidecarPath)) {
        throw new AudioIntegrationError("unexpected_direct_playback_manifest");
      }
      if (recording.playbackMediaId === null) {
        missingToOriginal += 1;
        recordingPlaybackUpdates.push({
          recordingId: recording.id,
          expectedOriginalMediaId: original.id,
          expectedPlaybackMediaId: null,
          expectedRevision: recording.revision,
          playbackMediaId: original.id,
        });
      } else if (recording.playbackMediaId !== original.id) {
        throw new AudioIntegrationError("unexpected_direct_playback_reference");
      }
      directPlayback += 1;
      return;
    }

    if (
      !["require_derivative", "try_oversized_mp3_derivative"].includes(decision)
      || detail.status !== "verified_existing_derivative"
      || detail.derivative === null
      || detail.validation?.accepted !== true
    ) {
      throw new AudioIntegrationError("unverified_derivative_detail");
    }
    const derivativeHash = sha256Value(
      detail.derivative.sha256,
      "invalid_detail_derivative_hash",
    );
    const derivativeByteSize = integerValue(
      detail.derivative.byte_size,
      "invalid_detail_derivative_size",
    );
    if (derivativeByteSize < 1) {
      throw new AudioIntegrationError("invalid_detail_derivative_size");
    }
    let outputStats;
    try {
      outputStats = await stat(job.output);
    } catch {
      throw new AudioIntegrationError("derivative_file_unreadable");
    }
    if (!outputStats.isFile() || outputStats.size !== derivativeByteSize) {
      throw new AudioIntegrationError("derivative_size_mismatch");
    }
    if (await sha256File(job.output) !== derivativeHash) {
      throw new AudioIntegrationError("derivative_hash_mismatch");
    }
    const provenance = await readJson(
      sidecarPath,
      "invalid_derivative_provenance",
    );
    const policyId = stringValue(
      provenance.policyId,
      "invalid_derivative_policy",
    );
    if (!OPAQUE_LABEL.test(policyId)) {
      throw new AudioIntegrationError("invalid_derivative_policy");
    }
    if (
      provenance.schemaVersion !== 1
      || provenance.sourceSha256 !== sourceHash
      || provenance.sourceByteSize !== sourceStats.size
      || provenance.derivativeSha256 !== derivativeHash
      || provenance.derivativeByteSize !== derivativeByteSize
    ) {
      throw new AudioIntegrationError("derivative_provenance_mismatch");
    }
    derivativePolicyIds.add(policyId);
    derivativeHashes.push(derivativeHash);
    derivativeSourceBytes += sourceStats.size;
    derivativeBytes += derivativeByteSize;
    expectedOutputFiles.add(job.output);
    expectedOutputFiles.add(sidecarPath);

    const playbackMediaId = `media:recording:${recording.id}:playback:${policyId}`;
    const objectKey = `recordings/playback/${policyId}/${job.label}.mp3`;
    const existingPlayback = mediaById.get(playbackMediaId);
    if (existingPlayback) {
      if (
        existingPlayback.objectKey !== objectKey
        || existingPlayback.mimeType !== "audio/mpeg"
        || existingPlayback.byteSize !== derivativeByteSize
        || existingPlayback.sha256 !== derivativeHash
        || existingPlayback.kind !== "playback_audio"
        || existingPlayback.state !== "active"
      ) {
        throw new AudioIntegrationError("existing_playback_media_mismatch");
      }
    } else {
      if (objectKeys.has(objectKey)) {
        throw new AudioIntegrationError("playback_object_key_collision");
      }
      objectKeys.add(objectKey);
      playbackMediaInserts.push({
        id: playbackMediaId,
        objectKey,
        originalFilename: `${job.label}.mp3`,
        mimeType: "audio/mpeg",
        byteSize: derivativeByteSize,
        sha256: derivativeHash,
        kind: "playback_audio",
        state: "active",
        localPath: relative(projectRoot, job.output).split(sep).join("/"),
      });
      derivativeProvenanceInserts.push({
        playbackMediaId,
        sourceMediaId: original.id,
        policyId,
        sourceSha256: sourceHash,
        sourceByteSize: sourceStats.size,
        derivativeSha256: derivativeHash,
        derivativeByteSize,
      });
    }

    if (recording.playbackMediaId !== playbackMediaId) {
      if (recording.playbackMediaId === null) missingToDerivative += 1;
      else if (recording.playbackMediaId === original.id) originalToDerivative += 1;
      else throw new AudioIntegrationError("unexpected_derivative_playback_reference");
      recordingPlaybackUpdates.push({
        recordingId: recording.id,
        expectedOriginalMediaId: original.id,
        expectedPlaybackMediaId: recording.playbackMediaId,
        expectedRevision: recording.revision,
        playbackMediaId,
      });
    }
    derivativePlayback += 1;
  });

  if (derivativePolicyIds.size !== 1) {
    throw new AudioIntegrationError("inconsistent_derivative_policy");
  }
  const policyId = [...derivativePolicyIds][0];
  const actualOutputFiles = await filesBelow(outputRoot);
  const unexpectedOutputFiles = [...actualOutputFiles]
    .filter((path) => !expectedOutputFiles.has(path)).length;
  const missingOutputFiles = [...expectedOutputFiles]
    .filter((path) => !actualOutputFiles.has(path)).length;
  if (unexpectedOutputFiles > 0 || missingOutputFiles > 0) {
    throw new AudioIntegrationError("batch_output_reconciliation_failed");
  }

  const plan: AudioIntegrationPlan = {
    schemaVersion: 1,
    catalogSchemaVersion: 2,
    catalogSha256,
    policyId,
    originalHashUpdates: sortedBy(originalHashUpdates, (row) => row.mediaId),
    playbackMediaInserts: sortedBy(playbackMediaInserts, (row) => row.id),
    derivativeProvenanceInserts: sortedBy(
      derivativeProvenanceInserts,
      (row) => row.playbackMediaId,
    ),
    recordingPlaybackUpdates: sortedBy(
      recordingPlaybackUpdates,
      (row) => row.recordingId,
    ),
  };
  const aggregate: AudioIntegrationAggregate = {
    schemaVersion: 1,
    mode: options.writePlan ? "write-plan" : "dry-run",
    policyId,
    recordings: recordings.length,
    originals: originalMedia.length,
    directPlayback,
    derivativePlayback,
    originalBytes,
    derivativeSourceBytes,
    derivativeBytes,
    originalHashBackfills: originalHashUpdates.length,
    playbackMediaInserts: playbackMediaInserts.length,
    derivativeProvenanceInserts: derivativeProvenanceInserts.length,
    recordingPlaybackUpdates: recordingPlaybackUpdates.length,
    currentPlaybackMissingToDerivative: missingToDerivative,
    currentPlaybackOriginalToDerivative: originalToDerivative,
    currentPlaybackMissingToOriginal: missingToOriginal,
    plannedR2Objects: playbackMediaInserts.length,
    plannedR2Bytes: playbackMediaInserts.reduce(
      (total, row) => total + row.byteSize,
      0,
    ),
    duplicateOriginalHashGroups: duplicateGroupCount(originalHashes),
    duplicateDerivativeHashGroups: duplicateGroupCount(derivativeHashes),
    unexpectedOutputFiles: 0,
  };
  return { plan, aggregate };
}

async function writePlanAtomic(path: string, plan: AudioIntegrationPlan): Promise<void> {
  const resolved = resolve(path);
  if (!PRIVATE_PLAN_ROOTS.some((root) => isWithin(resolved, root))) {
    throw new AudioIntegrationError("plan_output_must_be_private");
  }
  if (PROTECTED_LEGACY_ROOTS.some((root) => isWithin(resolved, root))) {
    throw new AudioIntegrationError("plan_output_inside_legacy_root");
  }
  await mkdir(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.temporary`;
  try {
    await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, resolved);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseArguments(arguments_: string[]): PlannerOptions {
  let catalogPath = DEFAULT_CATALOG;
  let batchManifestPath = DEFAULT_BATCH_MANIFEST;
  let batchDetailsPath = DEFAULT_BATCH_DETAILS;
  let planPath = DEFAULT_PLAN;
  let writePlan = false;
  let workers = 4;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === "--catalog" && next) {
      catalogPath = resolve(next);
      index += 1;
    } else if (argument === "--batch-manifest" && next) {
      batchManifestPath = resolve(next);
      index += 1;
    } else if (argument === "--batch-details" && next) {
      batchDetailsPath = resolve(next);
      index += 1;
    } else if (argument === "--plan" && next) {
      planPath = resolve(next);
      index += 1;
    } else if (argument === "--workers" && next) {
      workers = Number(next);
      index += 1;
    } else if (argument === "--write-plan") {
      writePlan = true;
    } else {
      throw new AudioIntegrationError("unknown_or_incomplete_argument");
    }
  }
  if (!Number.isInteger(workers) || workers < 1) {
    throw new AudioIntegrationError("workers_must_be_positive");
  }
  return {
    catalogPath,
    batchManifestPath,
    batchDetailsPath,
    planPath,
    writePlan,
    workers,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const { plan, aggregate } = await buildAudioIntegrationPlan(options);
  if (options.writePlan) await writePlanAtomic(options.planPath, plan);
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    const code = error instanceof AudioIntegrationError
      ? error.code
      : "audio_integration_planner_failed";
    process.stderr.write(`${JSON.stringify({ status: "error", error: code })}\n`);
    process.exitCode = 1;
  });
}
