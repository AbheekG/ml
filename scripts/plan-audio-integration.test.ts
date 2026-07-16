import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAudioIntegrationPlan,
  type PlannerOptions,
} from "./plan-audio-integration";

const roots: string[] = [];
const policyId = "mp3-v1-libmp3lame-q2";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(): Promise<PlannerOptions> {
  const root = await mkdtemp(resolve(tmpdir(), "audio-integration-"));
  roots.push(root);
  const catalogPath = resolve(root, "data/import-output/catalog.json");
  const manifestPath = resolve(root, "notes/private/audio-batch-manifest.json");
  const detailsPath = resolve(root, "notes/private/audio-batch-reuse-details.json");
  const planPath = resolve(root, "data/import-output/audio-integration-plan.json");
  const outputRoot = resolve(root, "notes/private/audio-migration-output");
  const directSource = resolve(root, "legacy/appsheet/recordings/direct.mp3");
  const derivativeSource = resolve(root, "legacy/appsheet/recordings/source.m4a");
  const directOutput = resolve(outputRoot, "media-direct.mp3");
  const derivativeOutput = resolve(outputRoot, "media-derivative.mp3");
  const directBytes = Buffer.from("direct source");
  const sourceBytes = Buffer.from("derivative source");
  const derivativeBytes = Buffer.from("verified derivative");
  await mkdir(dirname(directSource), { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(directSource, directBytes);
  await writeFile(derivativeSource, sourceBytes);
  await writeFile(derivativeOutput, derivativeBytes);
  await writeJson(`${derivativeOutput}.json`, {
    schemaVersion: 1,
    policyId,
    sourceSha256: hash(sourceBytes),
    sourceByteSize: sourceBytes.length,
    derivativeSha256: hash(derivativeBytes),
    derivativeByteSize: derivativeBytes.length,
  });

  await writeJson(catalogPath, {
    schemaVersion: 2,
    mediaObjects: [
      {
        id: "original-direct",
        objectKey: "recordings/direct.mp3",
        originalFilename: "direct.mp3",
        mimeType: "audio/mpeg",
        byteSize: directBytes.length,
        sha256: null,
        kind: "original_audio",
        state: "active",
      },
      {
        id: "original-derivative",
        objectKey: "recordings/source.m4a",
        originalFilename: "source.m4a",
        mimeType: "audio/mp4",
        byteSize: sourceBytes.length,
        sha256: null,
        kind: "original_audio",
        state: "active",
      },
    ],
    recordings: [
      {
        id: "recording-direct",
        originalMediaId: "original-direct",
        playbackMediaId: "original-direct",
        processingState: "ready",
        processingError: null,
        revision: 1,
      },
      {
        id: "recording-derivative",
        originalMediaId: "original-derivative",
        playbackMediaId: null,
        processingState: "ready",
        processingError: null,
        revision: 2,
      },
    ],
  });
  await writeJson(manifestPath, {
    schemaVersion: 1,
    outputRoot: "audio-migration-output",
    jobs: [
      {
        label: "media-direct",
        catalogMediaId: "original-direct",
        input: relative(dirname(manifestPath), directSource),
        output: relative(dirname(manifestPath), directOutput),
      },
      {
        label: "media-derivative",
        catalogMediaId: "original-derivative",
        input: relative(dirname(manifestPath), derivativeSource),
        output: relative(dirname(manifestPath), derivativeOutput),
      },
    ],
  });
  await writeJson(detailsPath, {
    schemaVersion: 1,
    mode: "execute",
    entries: [
      {
        label: "media-direct",
        status: "original_is_playback",
        decision: { kind: "use_original", reason: "canonical_mp3" },
        original: { sha256: hash(directBytes), byte_size: directBytes.length },
        derivative: null,
        validation: null,
      },
      {
        label: "media-derivative",
        status: "verified_existing_derivative",
        decision: {
          kind: "require_derivative",
          reason: "noncanonical_audio_requires_mp3",
        },
        original: { sha256: hash(sourceBytes), byte_size: sourceBytes.length },
        derivative: {
          sha256: hash(derivativeBytes),
          byte_size: derivativeBytes.length,
        },
        validation: { accepted: true, reason: "required_derivative_valid" },
      },
    ],
  });

  return {
    catalogPath,
    batchManifestPath: manifestPath,
    batchDetailsPath: detailsPath,
    planPath,
    writePlan: false,
    workers: 2,
    projectRoot: root,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("audio integration planner", () => {
  it("builds a deterministic private plan and aggregate reconciliation", async () => {
    const options = await fixture();

    const first = await buildAudioIntegrationPlan(options);
    const second = await buildAudioIntegrationPlan(options);

    expect(second).toEqual(first);
    expect(first.aggregate).toMatchObject({
      mode: "dry-run",
      recordings: 2,
      originals: 2,
      directPlayback: 1,
      derivativePlayback: 1,
      originalHashBackfills: 2,
      playbackMediaInserts: 1,
      derivativeProvenanceInserts: 1,
      recordingPlaybackUpdates: 1,
      currentPlaybackMissingToDerivative: 1,
      currentPlaybackOriginalToDerivative: 0,
      plannedR2Objects: 1,
      duplicateOriginalHashGroups: 0,
      duplicateDerivativeHashGroups: 0,
    });
    expect(first.plan.playbackMediaInserts[0]).toMatchObject({
      objectKey: `recordings/playback/${policyId}/media-derivative.mp3`,
      mimeType: "audio/mpeg",
      kind: "playback_audio",
      state: "active",
    });
    expect(first.plan.derivativeProvenanceInserts[0]).toMatchObject({
      policyId,
      sourceMediaId: "original-derivative",
    });
    expect(first.plan.recordingPlaybackUpdates[0]).toMatchObject({
      expectedOriginalMediaId: "original-derivative",
      expectedPlaybackMediaId: null,
      expectedRevision: 2,
    });
    expect(JSON.stringify(first.aggregate)).not.toContain("recording-derivative");
    expect(JSON.stringify(first.aggregate)).not.toContain(options.projectRoot);
  });

  it("rejects a derivative whose bytes no longer match the verified report", async () => {
    const options = await fixture();
    const manifest = JSON.parse(
      await readFile(options.batchManifestPath, "utf8"),
    ) as { jobs: Array<{ output: string }> };
    const output = resolve(dirname(options.batchManifestPath), manifest.jobs[1].output);
    await writeFile(output, "changed derivative");

    await expect(buildAudioIntegrationPlan(options)).rejects.toMatchObject({
      code: "derivative_size_mismatch",
    });
  });

  it("rejects unexpected files in the derivative output root", async () => {
    const options = await fixture();
    await writeFile(
      resolve(dirname(options.batchManifestPath), "audio-migration-output/unexpected"),
      "unexpected",
    );

    await expect(buildAudioIntegrationPlan(options)).rejects.toMatchObject({
      code: "batch_output_reconciliation_failed",
    });
  });
});
