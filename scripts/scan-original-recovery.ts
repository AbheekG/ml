import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const PROJECT_ROOT = resolve(".");
const DEFAULT_CATALOG = resolve("data/import-output/catalog.json");
const DEFAULT_CURRENT_ROOT = resolve("legacy/appsheet");
const DEFAULT_GENUINE_ROOT = resolve("legacy/drive/Final");
const DEFAULT_OUTPUT = resolve("notes/private/scan-original-recovery");
const FEATURE_SIZE = 64;
const QUALITY_SIZE = 192;
const MAX_IMAGE_PIXELS = 120_000_000;
const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".heic", ".heif",
]);

type JsonObject = Record<string, unknown>;

type CatalogSong = {
  id: string;
  titleKeys: string[];
};

type CatalogScan = {
  id: string;
  songId: string;
  mediaId: string;
  notebookId: string | null;
  pageLabel: string | null;
};

type CatalogMedia = {
  id: string;
  objectKey: string;
  originalFilename: string;
  byteSize: number;
  sha256: string | null;
};

type Hash64 = { high: number; low: number };

type FeatureVariant = {
  kind: string;
  pixels: Uint8Array;
  hashes: Array<{ p: Hash64; d: Hash64 }>;
};

type ImageFeatures = {
  format: string;
  width: number;
  height: number;
  orientation: number | null;
  sharpness: number;
  entropy: number;
  edgeDensity: number;
  borderInkRatio: number;
  contentCoverage: number;
  variants: FeatureVariant[];
};

type CurrentImage = {
  token: string;
  scan: CatalogScan;
  media: CatalogMedia;
  path: string;
  relativePath: string;
  sha256: string;
  features: ImageFeatures;
  orderIndex: number;
  songScanCount: number;
};

type GenuineImage = {
  token: string;
  path: string;
  relativePath: string;
  directory: string;
  filename: string;
  byteSize: number;
  sha256: string;
  features: ImageFeatures;
  folderAssociation: FolderAssociation;
  orderIndex: number;
  directoryImageCount: number;
};

type FolderAssociation = {
  kind: "exact" | "fuzzy" | "ambiguous" | "none";
  songIds: string[];
  score: number;
};

type VisualEvidence = {
  score: number;
  roughDistance: number;
  pHashDistance: number;
  dHashDistance: number;
  correlation: number;
  edgeCorrelation: number;
  ssim: number;
  currentVariant: string;
  genuineVariant: string;
  rotationDegrees: number;
  strength: "ultra" | "strong" | "moderate" | "weak";
};

type AssociationEvidence = {
  folder: FolderAssociation["kind"];
  filename: boolean;
  pageNumber: boolean;
  order: boolean;
  corroborationCount: number;
};

type QualityEvidence = {
  pixelAreaRatio: number;
  sharpnessRatio: number;
  sourceByteRatio: number;
  borderInkDelta: number;
  contentCoverageRatio: number;
  materialGain: boolean;
  severeRegression: boolean;
  warnings: string[];
  estimatedCurrentDerivativeBytes?: number;
  estimatedGenuineDerivativeBytes?: number;
};

type RegistrationEvidence = {
  inkDice: number;
  rowProjectionCorrelation: number;
  columnProjectionCorrelation: number;
  blockEdgeCorrelation: number;
  structuralScore: number;
};

type CandidateEvaluation = {
  currentToken: string;
  genuineToken: string;
  exactBytes: boolean;
  existingCurrentHashConflict: boolean;
  visual: VisualEvidence;
  association: AssociationEvidence;
  quality: QualityEvidence;
  registration?: RegistrationEvidence;
};

type MatchStatus =
  | "exact_bytes_already_genuine"
  | "confirmed_replacement"
  | "confirmed_visual_equivalent_no_change"
  | "owner_review_quality"
  | "owner_review_ambiguous"
  | "owner_review_probable"
  | "unmatched";

type MatchDecision = {
  currentToken: string;
  status: MatchStatus;
  confidenceTier: "exact" | "confirmed" | "probable" | "ambiguous" | "unmatched";
  proposedAction: "retain_current" | "replace_after_approval" | "owner_review";
  genuineToken: string | null;
  reasonCodes: string[];
  evaluation: CandidateEvaluation | null;
  alternatives: CandidateEvaluation[];
  lockedStage: number | null;
};

export type ScanOriginalRecoveryOptions = {
  catalogPath: string;
  currentRoot: string;
  genuineRoot: string;
  outputDirectory: string;
  workers: number;
  writeReport: boolean;
  writeReview: boolean;
  reviewLimit: number;
  stagingScanCount?: number;
  projectRoot?: string;
  experimentalUnmatched?: boolean;
  ownerApproveConfirmedReplacements?: boolean;
};

export type ScanOriginalRecoveryAggregate = {
  schemaVersion: 1;
  mode: "dry-run" | "write-report";
  catalogScans: number;
  stagingOnlyScansExcluded: number;
  currentFiles: number;
  currentDirectories: number;
  currentSymlinks: number;
  currentSpecialFiles: number;
  currentReferencedFiles: number;
  currentUnreferencedFiles: number;
  currentBytes: number;
  genuineFiles: number;
  genuineDirectories: number;
  genuineSymlinks: number;
  genuineSpecialFiles: number;
  genuineImageCandidates: number;
  genuineNonImageFiles: number;
  genuineBytes: number;
  genuineImageBytes: number;
  genuineDecodeFailures: number;
  currentDuplicateHashGroups: number;
  genuineDuplicateHashGroups: number;
  exactAlreadyGenuine: number;
  confirmedReplacements: number;
  confirmedVisualEquivalentNoChange: number;
  ownerReviewQuality: number;
  ownerReviewAmbiguous: number;
  ownerReviewProbable: number;
  unmatchedCurrent: number;
  unmatchedGenuineImages: number;
  manyToOneConflicts: number;
  oneToManyConflicts: number;
  confirmedOneToOne: boolean;
  estimatedChanges: {
    sourceFilesActivated: number;
    formerSourceFilesRemovedFromActiveUse: number;
    currentSourceBytesRemovedFromActiveUse: number;
    genuineSourceBytesActivated: number;
    currentDerivativeBytesEstimated: number;
    genuineDerivativeBytesEstimated: number;
    privateR2BytesAddedEstimated: number;
    formerBytesRetainedAsHistoryEstimated: number;
    netActiveBytesEstimated: number;
  };
  reportSha256?: string;
  reviewAidsWritten?: number;
};

type RecoveryReport = {
  schemaVersion: 1;
  methodVersion: "scan-original-recovery-v1" | "scan-original-recovery-v2";
  inputs: {
    catalogSha256: string;
    currentInventorySha256: string;
    genuineInventorySha256: string;
    catalogPath: string;
    currentRoot: string;
    genuineRoot: string;
  };
  aggregate: Omit<ScanOriginalRecoveryAggregate, "mode" | "reportSha256" | "reviewAidsWritten">;
  invariants: {
    everyCatalogScanHasOneCurrentFile: boolean;
    confirmedCurrentUnique: boolean;
    confirmedGenuineUnique: boolean;
    confirmedGenuineHashesUnique: boolean;
    confirmedReplacementHashCollisionFree: boolean;
    legacyInputsWritten: false;
    cloudContacted: false;
  };
  inventories: {
    current: Array<Record<string, unknown>>;
    currentUnreferencedFiles: Array<{ relativePath: string; byteSize: number }>;
    genuineImages: Array<Record<string, unknown>>;
    genuineNonImages: Array<{
      token: string;
      relativePath: string;
      byteSize: number;
      extension: string;
    }>;
    genuineNonImageExtensions: Record<string, number>;
    genuineDecodeFailures: Array<{ token: string; relativePath: string }>;
  };
  decisions: Array<Record<string, unknown>>;
  conflicts: {
    manyToOne: Array<{ genuineToken: string; currentTokens: string[] }>;
    oneToMany: Array<{ currentToken: string; genuineTokens: string[] }>;
  };
  duplicateGroups: {
    current: Array<{ sha256: string; tokens: string[] }>;
    genuine: Array<{ sha256: string; tokens: string[] }>;
  };
  unmatchedGenuineTokens: string[];
};

export class ScanOriginalRecoveryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function objectValue(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScanOriginalRecoveryError(code);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new ScanOriginalRecoveryError(code);
  return value;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ScanOriginalRecoveryError(code);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integerValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ScanOriginalRecoveryError(code);
  }
  return value as number;
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function filenameKey(value: string): string {
  return normalizeText(basename(value, extname(value)))
    .replace(/\b(?:scan|image|img|photo|page|copy)\b/gu, "")
    .trim()
    .replace(/\s+/gu, " ");
}

function firstNumber(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/\d+/u);
  return match ? Number(match[0]) : null;
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch {
    throw new ScanOriginalRecoveryError("input_file_unreadable");
  }
  return hash.digest("hex");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function mapLimit<T, U>(
  values: readonly T[],
  limit: number,
  operation: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ScanOriginalRecoveryError("workers_must_be_positive");
  }
  const output = new Array<U>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(limit, Math.max(values.length, 1)) },
    () => worker(),
  ));
  return output;
}

type WalkResult = {
  files: Array<{ path: string; relativePath: string; byteSize: number }>;
  directories: number;
  symlinks: number;
  special: number;
};

async function walkReadOnly(root: string): Promise<WalkResult> {
  const resolvedRoot = resolve(root);
  const actualRoot = await realpath(resolvedRoot).catch(() => {
    throw new ScanOriginalRecoveryError("input_root_unreadable");
  });
  const files: WalkResult["files"] = [];
  let directories = 0;
  let symlinks = 0;
  let special = 0;

  async function visit(directoryPath: string): Promise<void> {
    directories += 1;
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      throw new ScanOriginalRecoveryError("input_root_unreadable");
    }
    entries.sort((left, right) => naturalCompare(left.name, right.name));
    for (const entry of entries) {
      const path = resolve(directoryPath, entry.name);
      if (!isWithin(path, actualRoot)) throw new ScanOriginalRecoveryError("unsafe_input_path");
      if (entry.isSymbolicLink()) {
        symlinks += 1;
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const fileStats = await stat(path);
        files.push({ path, relativePath: relative(actualRoot, path).split(sep).join("/"), byteSize: fileStats.size });
      } else {
        special += 1;
      }
    }
  }

  await visit(actualRoot);
  files.sort((left, right) => naturalCompare(left.relativePath, right.relativePath));
  return { files, directories, symlinks, special };
}

async function hasImageSignature(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
    const bytes = Buffer.alloc(32);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
    if (bytesRead >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
    if (bytesRead >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return true;
    if (bytesRead >= 4 && (
      bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
      || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
    )) return true;
    if (bytesRead >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
      const brand = bytes.toString("ascii", 8, 12).toLocaleLowerCase("en");
      return ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif"].includes(brand);
    }
    return false;
  } catch {
    throw new ScanOriginalRecoveryError("input_file_unreadable");
  } finally {
    await handle?.close();
  }
}

function popcount32(value: number): number {
  let item = value >>> 0;
  item -= (item >>> 1) & 0x55555555;
  item = (item & 0x33333333) + ((item >>> 2) & 0x33333333);
  return (((item + (item >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function hashDistance(left: Hash64, right: Hash64): number {
  return (popcount32((left.high ^ right.high) >>> 0)
    + popcount32((left.low ^ right.low) >>> 0)) / 64;
}

function bitsToHash(bits: readonly boolean[]): Hash64 {
  let high = 0;
  let low = 0;
  for (let index = 0; index < 64; index += 1) {
    if (!bits[index]) continue;
    if (index < 32) high = (high | (1 << (31 - index))) >>> 0;
    else low = (low | (1 << (63 - index))) >>> 0;
  }
  return { high, low };
}

function resizeSquare(input: Uint8Array, sourceSize: number, targetSize: number): Uint8Array {
  if (sourceSize === targetSize) return input.slice();
  const output = new Uint8Array(targetSize * targetSize);
  for (let y = 0; y < targetSize; y += 1) {
    const sourceY = ((y + 0.5) * sourceSize / targetSize) - 0.5;
    const y0 = Math.max(0, Math.min(sourceSize - 1, Math.floor(sourceY)));
    const y1 = Math.max(0, Math.min(sourceSize - 1, y0 + 1));
    const fy = Math.max(0, sourceY - y0);
    for (let x = 0; x < targetSize; x += 1) {
      const sourceX = ((x + 0.5) * sourceSize / targetSize) - 0.5;
      const x0 = Math.max(0, Math.min(sourceSize - 1, Math.floor(sourceX)));
      const x1 = Math.max(0, Math.min(sourceSize - 1, x0 + 1));
      const fx = Math.max(0, sourceX - x0);
      const top = input[y0 * sourceSize + x0] * (1 - fx) + input[y0 * sourceSize + x1] * fx;
      const bottom = input[y1 * sourceSize + x0] * (1 - fx) + input[y1 * sourceSize + x1] * fx;
      output[y * targetSize + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return output;
}

function cropAndResize(input: Uint8Array, size: number, inset: number): Uint8Array {
  if (inset === 0) return input.slice();
  const croppedSize = size - inset * 2;
  const cropped = new Uint8Array(croppedSize * croppedSize);
  for (let y = 0; y < croppedSize; y += 1) {
    cropped.set(input.subarray((y + inset) * size + inset, (y + inset) * size + inset + croppedSize), y * croppedSize);
  }
  return resizeSquare(cropped, croppedSize, size);
}

function sampledPixel(input: Uint8Array, size: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > size - 1 || y > size - 1) return 255;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const top = input[y0 * size + x0] * (1 - fx) + input[y0 * size + x1] * fx;
  const bottom = input[y1 * size + x0] * (1 - fx) + input[y1 * size + x1] * fx;
  return Math.round(top * (1 - fy) + bottom * fy);
}

function cropRectangleAndResize(
  input: Uint8Array,
  size: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): Uint8Array {
  const width = size - left - right;
  const height = size - top - bottom;
  if (width < size / 2 || height < size / 2) {
    throw new ScanOriginalRecoveryError("registration_crop_invalid");
  }
  const output = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const sourceY = top + ((y + 0.5) * height / size) - 0.5;
    for (let x = 0; x < size; x += 1) {
      const sourceX = left + ((x + 0.5) * width / size) - 0.5;
      output[y * size + x] = sampledPixel(input, size, sourceX, sourceY);
    }
  }
  return output;
}

function shearPixels(
  input: Uint8Array,
  size: number,
  horizontal: number,
  vertical: number,
): Uint8Array {
  const output = new Uint8Array(size * size);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = x - horizontal * (y - center);
      const sourceY = y - vertical * (x - center);
      output[y * size + x] = sampledPixel(input, size, sourceX, sourceY);
    }
  }
  return output;
}

function rotatePixels(input: Uint8Array, size: number, turns: number): Uint8Array {
  const normalized = ((turns % 4) + 4) % 4;
  if (normalized === 0) return input;
  const output = new Uint8Array(input.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = input[y * size + x];
      if (normalized === 1) output[x * size + (size - 1 - y)] = value;
      else if (normalized === 2) output[(size - 1 - y) * size + (size - 1 - x)] = value;
      else output[(size - 1 - x) * size + y] = value;
    }
  }
  return output;
}

function equalize(input: Uint8Array): Uint8Array {
  const histogram = new Uint32Array(256);
  for (const value of input) histogram[value] += 1;
  const cumulative = new Uint32Array(256);
  let total = 0;
  let first = 0;
  let found = false;
  for (let index = 0; index < 256; index += 1) {
    total += histogram[index];
    cumulative[index] = total;
    if (!found && histogram[index] > 0) {
      first = total;
      found = true;
    }
  }
  const denominator = Math.max(1, input.length - first);
  return Uint8Array.from(input, (value) => Math.round((cumulative[value] - first) * 255 / denominator));
}

function pHash(input: Uint8Array): Hash64 {
  const sample = resizeSquare(input, FEATURE_SIZE, 16);
  const coefficients: number[] = [];
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < 16; y += 1) {
        const cy = Math.cos(((2 * y + 1) * v * Math.PI) / 32);
        for (let x = 0; x < 16; x += 1) {
          sum += sample[y * 16 + x]
            * Math.cos(((2 * x + 1) * u * Math.PI) / 32)
            * cy;
        }
      }
      coefficients.push(sum);
    }
  }
  const sorted = coefficients.slice(1).sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return bitsToHash(coefficients.map((value, index) => index === 0 ? false : value >= median));
}

function dHash(input: Uint8Array): Hash64 {
  const resized = resizeSquare(input, FEATURE_SIZE, 9);
  const bits: boolean[] = [];
  for (let y = 0; y < 8; y += 1) {
    const sourceY = Math.round(y * 8 / 7);
    for (let x = 0; x < 8; x += 1) {
      bits.push(resized[sourceY * 9 + x] > resized[sourceY * 9 + x + 1]);
    }
  }
  return bitsToHash(bits);
}

function makeVariant(kind: string, pixels: Uint8Array): FeatureVariant {
  const normalized = equalize(pixels);
  return {
    kind,
    pixels: normalized,
    hashes: [0, 1, 2, 3].map((turns) => {
      const rotated = rotatePixels(normalized, FEATURE_SIZE, turns);
      return { p: pHash(rotated), d: dHash(rotated) };
    }),
  };
}

const registrationVariantCache = new WeakMap<ImageFeatures, FeatureVariant[]>();

function registrationVariants(features: ImageFeatures): FeatureVariant[] {
  const cached = registrationVariantCache.get(features);
  if (cached) return cached;
  const full = features.variants.find((variant) => variant.kind === "full");
  const trimmed = features.variants.find((variant) => variant.kind === "trim");
  if (!full || !trimmed) throw new ScanOriginalRecoveryError("registration_variant_missing");
  const variants = [...features.variants];
  const addCrops = (source: FeatureVariant, prefix: string, inset: number): void => {
    const crops = [
      [inset, 0, 0, 0, "left"],
      [0, 0, inset, 0, "right"],
      [0, inset, 0, 0, "top"],
      [0, 0, 0, inset, "bottom"],
    ] as const;
    for (const [left, top, right, bottom, name] of crops) {
      variants.push(makeVariant(
        `${prefix}_crop_${name}_${inset}px`,
        cropRectangleAndResize(source.pixels, FEATURE_SIZE, left, top, right, bottom),
      ));
    }
  };
  addCrops(full, "full", 5);
  addCrops(full, "full", 8);
  addCrops(full, "full", 13);
  addCrops(full, "full", 16);
  addCrops(trimmed, "trim", 5);
  for (const [left, top, right, bottom, name] of [
    [4, 4, 0, 0, "left_top"],
    [0, 4, 4, 0, "right_top"],
    [4, 0, 0, 4, "left_bottom"],
    [0, 0, 4, 4, "right_bottom"],
  ] as const) {
    variants.push(makeVariant(
      `full_crop_${name}_4px`,
      cropRectangleAndResize(full.pixels, FEATURE_SIZE, left, top, right, bottom),
    ));
  }
  for (const source of [full, trimmed]) {
    for (const [horizontal, vertical, name] of [
      [0.08, 0, "shear_right"],
      [-0.08, 0, "shear_left"],
      [0, 0.08, "shear_down"],
      [0, -0.08, "shear_up"],
    ] as const) {
      variants.push(makeVariant(
        `${source.kind}_${name}`,
        shearPixels(source.pixels, FEATURE_SIZE, horizontal, vertical),
      ));
    }
  }
  registrationVariantCache.set(features, variants);
  return variants;
}

function grayscaleStatistics(pixels: Uint8Array, size: number): Pick<
  ImageFeatures,
  "sharpness" | "entropy" | "edgeDensity" | "borderInkRatio" | "contentCoverage"
> {
  let laplacianSum = 0;
  let laplacianSquared = 0;
  let laplacianCount = 0;
  let edgeCount = 0;
  const histogram = new Uint32Array(256);
  let ink = 0;
  let borderInk = 0;
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = pixels[y * size + x];
      histogram[value] += 1;
      if (value < 225) {
        ink += 1;
        if (x < 3 || y < 3 || x >= size - 3 || y >= size - 3) borderInk += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (x > 0 && y > 0 && x < size - 1 && y < size - 1) {
        const laplacian = 4 * value
          - pixels[y * size + x - 1]
          - pixels[y * size + x + 1]
          - pixels[(y - 1) * size + x]
          - pixels[(y + 1) * size + x];
        laplacianSum += laplacian;
        laplacianSquared += laplacian * laplacian;
        laplacianCount += 1;
        if (Math.abs(laplacian) > 18) edgeCount += 1;
      }
    }
  }
  const mean = laplacianCount > 0 ? laplacianSum / laplacianCount : 0;
  const sharpness = laplacianCount > 0 ? laplacianSquared / laplacianCount - mean * mean : 0;
  let entropy = 0;
  for (const count of histogram) {
    if (count === 0) continue;
    const probability = count / pixels.length;
    entropy -= probability * Math.log2(probability);
  }
  const contentCoverage = ink > 0
    ? ((maxX - minX + 1) * (maxY - minY + 1)) / (size * size)
    : 0;
  return {
    sharpness: round(sharpness),
    entropy: round(entropy),
    edgeDensity: round(laplacianCount > 0 ? edgeCount / laplacianCount : 0),
    borderInkRatio: round(ink > 0 ? borderInk / ink : 0),
    contentCoverage: round(contentCoverage),
  };
}

async function extractImageFeatures(path: string): Promise<ImageFeatures> {
  try {
    const image = sharp(path, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS, animated: false });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || !metadata.format) {
      throw new ScanOriginalRecoveryError("image_metadata_invalid");
    }
    const orientation = metadata.orientation ?? null;
    const swap = orientation !== null && orientation >= 5 && orientation <= 8;
    const width = swap ? metadata.height : metadata.width;
    const height = swap ? metadata.width : metadata.height;
    const base = image.rotate().flatten({ background: "#ffffff" }).greyscale();
    const [full, contain, quality] = await Promise.all([
      base.clone().resize(FEATURE_SIZE, FEATURE_SIZE, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer(),
      base.clone().resize(FEATURE_SIZE, FEATURE_SIZE, { fit: "contain", background: "#ffffff", kernel: "lanczos3" }).raw().toBuffer(),
      base.clone().resize(QUALITY_SIZE, QUALITY_SIZE, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer(),
    ]);
    let trimmed: Buffer;
    try {
      trimmed = await base.clone()
        .trim({ background: "#ffffff", threshold: 12 })
        .resize(FEATURE_SIZE, FEATURE_SIZE, { fit: "fill", kernel: "lanczos3" })
        .raw()
        .toBuffer();
    } catch {
      trimmed = full;
    }
    const fullPixels = new Uint8Array(full);
    const trimPixels = new Uint8Array(trimmed);
    return {
      format: metadata.format,
      width,
      height,
      orientation,
      ...grayscaleStatistics(new Uint8Array(quality), QUALITY_SIZE),
      variants: [
        makeVariant("full", fullPixels),
        makeVariant("contain", new Uint8Array(contain)),
        makeVariant("trim", trimPixels),
        makeVariant("full_crop_3pct", cropAndResize(fullPixels, FEATURE_SIZE, 2)),
        makeVariant("full_crop_6pct", cropAndResize(fullPixels, FEATURE_SIZE, 4)),
        makeVariant("trim_crop_3pct", cropAndResize(trimPixels, FEATURE_SIZE, 2)),
      ],
    };
  } catch (error) {
    if (error instanceof ScanOriginalRecoveryError) throw error;
    throw new ScanOriginalRecoveryError("image_decode_failed");
  }
}

type CachedFeatures = {
  schemaVersion: 1;
  extractorVersion: "scan-features-v1";
  relativePath: string;
  byteSize: number;
  sha256: string;
  features: Omit<ImageFeatures, "variants"> & {
    variants: Array<{
      kind: string;
      pixelsBase64: string;
      hashes: Array<{ p: Hash64; d: Hash64 }>;
    }>;
  };
};

function featureCachePath(
  outputDirectory: string,
  collection: "current" | "genuine",
  relativePath: string,
): string {
  const opaqueName = createHash("sha256").update(`${collection}\0${relativePath}`).digest("hex");
  return resolve(outputDirectory, "feature-cache", collection, `${opaqueName}.json`);
}

function serializeFeatures(
  relativePath: string,
  byteSize: number,
  sha256: string,
  features: ImageFeatures,
): CachedFeatures {
  return {
    schemaVersion: 1,
    extractorVersion: "scan-features-v1",
    relativePath,
    byteSize,
    sha256,
    features: {
      ...features,
      variants: features.variants.map((variant) => ({
        kind: variant.kind,
        pixelsBase64: Buffer.from(variant.pixels).toString("base64"),
        hashes: variant.hashes,
      })),
    },
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function deserializeFeatures(
  value: unknown,
  relativePath: string,
  byteSize: number,
  sha256: string,
): ImageFeatures | null {
  try {
    const cache = objectValue(value, "invalid_feature_cache");
    if (cache.schemaVersion !== 1
      || cache.extractorVersion !== "scan-features-v1"
      || cache.relativePath !== relativePath
      || cache.byteSize !== byteSize
      || cache.sha256 !== sha256) return null;
    const features = objectValue(cache.features, "invalid_feature_cache");
    const numericFields = [
      "width", "height", "sharpness", "entropy", "edgeDensity", "borderInkRatio", "contentCoverage",
    ] as const;
    if (typeof features.format !== "string"
      || !numericFields.every((field) => finiteNumber(features[field]))
      || !(features.orientation === null || finiteNumber(features.orientation))) return null;
    const variants = arrayValue(features.variants, "invalid_feature_cache").map((item) => {
      const variant = objectValue(item, "invalid_feature_cache");
      if (typeof variant.kind !== "string" || typeof variant.pixelsBase64 !== "string") {
        throw new ScanOriginalRecoveryError("invalid_feature_cache");
      }
      const pixels = new Uint8Array(Buffer.from(variant.pixelsBase64, "base64"));
      if (pixels.length !== FEATURE_SIZE * FEATURE_SIZE) {
        throw new ScanOriginalRecoveryError("invalid_feature_cache");
      }
      const hashes = arrayValue(variant.hashes, "invalid_feature_cache").map((hashItem) => {
        const hashesObject = objectValue(hashItem, "invalid_feature_cache");
        const parseHash = (hashValue: unknown): Hash64 => {
          const hashObject = objectValue(hashValue, "invalid_feature_cache");
          if (!Number.isInteger(hashObject.high) || !Number.isInteger(hashObject.low)) {
            throw new ScanOriginalRecoveryError("invalid_feature_cache");
          }
          return { high: (hashObject.high as number) >>> 0, low: (hashObject.low as number) >>> 0 };
        };
        return { p: parseHash(hashesObject.p), d: parseHash(hashesObject.d) };
      });
      if (hashes.length !== 4) throw new ScanOriginalRecoveryError("invalid_feature_cache");
      return { kind: variant.kind, pixels, hashes };
    });
    if (variants.length !== 6) return null;
    return {
      format: features.format,
      width: features.width as number,
      height: features.height as number,
      orientation: features.orientation as number | null,
      sharpness: features.sharpness as number,
      entropy: features.entropy as number,
      edgeDensity: features.edgeDensity as number,
      borderInkRatio: features.borderInkRatio as number,
      contentCoverage: features.contentCoverage as number,
      variants,
    };
  } catch {
    return null;
  }
}

async function hashAndExtractFeatures(
  path: string,
  relativePath: string,
  byteSize: number,
  collection: "current" | "genuine",
  outputDirectory: string,
  writeCache: boolean,
): Promise<{ sha256: string; features: ImageFeatures }> {
  const sha256 = await sha256File(path);
  const cachePath = featureCachePath(outputDirectory, collection, relativePath);
  try {
    const cached = deserializeFeatures(
      JSON.parse(await readFile(cachePath, "utf8")),
      relativePath,
      byteSize,
      sha256,
    );
    if (cached) return { sha256, features: cached };
  } catch {
    // Missing or stale private cache entries are safely regenerated.
  }
  const features = await extractImageFeatures(path);
  if (writeCache) {
    await writeAtomic(
      cachePath,
      `${JSON.stringify(serializeFeatures(relativePath, byteSize, sha256, features))}\n`,
    );
  }
  return { sha256, features };
}

function roughComparison(current: ImageFeatures, genuine: ImageFeatures): number {
  let best = 1;
  for (const currentIndex of [0, 2]) {
    const currentVariant = current.variants[currentIndex];
    for (const genuineIndex of [0, 2]) {
      const genuineVariant = genuine.variants[genuineIndex];
      for (const hashes of genuineVariant.hashes) {
        const p = hashDistance(currentVariant.hashes[0].p, hashes.p);
        const d = hashDistance(currentVariant.hashes[0].d, hashes.d);
        best = Math.min(best, p * 0.72 + d * 0.28);
      }
    }
  }
  return best;
}

function registrationRoughComparison(current: ImageFeatures, genuine: ImageFeatures): number {
  let best = 1;
  const currentVariants = registrationVariants(current);
  const genuineVariants = registrationVariants(genuine);
  for (const currentVariant of currentVariants) {
    for (const genuineVariant of genuineVariants) {
      for (const hashes of genuineVariant.hashes) {
        const p = hashDistance(currentVariant.hashes[0].p, hashes.p);
        const d = hashDistance(currentVariant.hashes[0].d, hashes.d);
        best = Math.min(best, p * 0.72 + d * 0.28);
      }
    }
  }
  return best;
}

function registrationFeatures(features: ImageFeatures): ImageFeatures {
  return { ...features, variants: registrationVariants(features) };
}

function correlation(left: Uint8Array, right: Uint8Array): number {
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < left.length; index += 1) {
    leftMean += left[index];
    rightMean += right[index];
  }
  leftMean /= left.length;
  rightMean /= right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? covariance / denominator : leftMean === rightMean ? 1 : 0;
}

function sobel(input: Uint8Array): Float64Array {
  const output = new Float64Array(input.length);
  for (let y = 1; y < FEATURE_SIZE - 1; y += 1) {
    for (let x = 1; x < FEATURE_SIZE - 1; x += 1) {
      const topLeft = input[(y - 1) * FEATURE_SIZE + x - 1];
      const top = input[(y - 1) * FEATURE_SIZE + x];
      const topRight = input[(y - 1) * FEATURE_SIZE + x + 1];
      const left = input[y * FEATURE_SIZE + x - 1];
      const right = input[y * FEATURE_SIZE + x + 1];
      const bottomLeft = input[(y + 1) * FEATURE_SIZE + x - 1];
      const bottom = input[(y + 1) * FEATURE_SIZE + x];
      const bottomRight = input[(y + 1) * FEATURE_SIZE + x + 1];
      const gx = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gy = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      output[y * FEATURE_SIZE + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return output;
}

function cosine(left: Float64Array, right: Float64Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftNorm * rightNorm);
  return denominator > 0 ? dot / denominator : 0;
}

function globalSsim(left: Uint8Array, right: Uint8Array): number {
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < left.length; index += 1) {
    leftMean += left[index];
    rightMean += right[index];
  }
  leftMean /= left.length;
  rightMean /= right.length;
  let leftVariance = 0;
  let rightVariance = 0;
  let covariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
    covariance += leftDelta * rightDelta;
  }
  const denominator = Math.max(1, left.length - 1);
  leftVariance /= denominator;
  rightVariance /= denominator;
  covariance /= denominator;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  return ((2 * leftMean * rightMean + c1) * (2 * covariance + c2))
    / ((leftMean ** 2 + rightMean ** 2 + c1) * (leftVariance + rightVariance + c2));
}

function binaryDice(left: Uint8Array, right: Uint8Array, threshold: number): number {
  let leftInk = 0;
  let rightInk = 0;
  let intersection = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDark = left[index] < threshold;
    const rightDark = right[index] < threshold;
    if (leftDark) leftInk += 1;
    if (rightDark) rightInk += 1;
    if (leftDark && rightDark) intersection += 1;
  }
  const total = leftInk + rightInk;
  return total > 0 ? (2 * intersection) / total : 1;
}

function inkProjections(input: Uint8Array, threshold: number): {
  rows: Uint8Array;
  columns: Uint8Array;
} {
  const rows = new Uint8Array(FEATURE_SIZE);
  const columns = new Uint8Array(FEATURE_SIZE);
  for (let y = 0; y < FEATURE_SIZE; y += 1) {
    for (let x = 0; x < FEATURE_SIZE; x += 1) {
      if (input[y * FEATURE_SIZE + x] < threshold) {
        rows[y] += 1;
        columns[x] += 1;
      }
    }
  }
  return { rows, columns };
}

function blockEdgeVector(input: Uint8Array): Float64Array {
  const edges = sobel(input);
  const blocks = 8;
  const blockSize = FEATURE_SIZE / blocks;
  const output = new Float64Array(blocks * blocks);
  for (let y = 0; y < FEATURE_SIZE; y += 1) {
    for (let x = 0; x < FEATURE_SIZE; x += 1) {
      const blockX = Math.floor(x / blockSize);
      const blockY = Math.floor(y / blockSize);
      output[blockY * blocks + blockX] += edges[y * FEATURE_SIZE + x];
    }
  }
  return output;
}

function registrationEvidence(left: Uint8Array, right: Uint8Array): RegistrationEvidence {
  const thresholds = [96, 128, 160, 192];
  const threshold = thresholds
    .map((value) => ({ value, dice: binaryDice(left, right, value) }))
    .sort((a, b) => b.dice - a.dice || a.value - b.value)[0];
  const leftProjections = inkProjections(left, threshold.value);
  const rightProjections = inkProjections(right, threshold.value);
  const rowProjectionCorrelation = correlation(leftProjections.rows, rightProjections.rows);
  const columnProjectionCorrelation = correlation(
    leftProjections.columns,
    rightProjections.columns,
  );
  const blockEdgeCorrelation = cosine(blockEdgeVector(left), blockEdgeVector(right));
  const pixelCorrelation = Math.max(0, correlation(left, right));
  const ssim = Math.max(0, globalSsim(left, right));
  const edgeCorrelation = Math.max(0, cosine(sobel(left), sobel(right)));
  const projectionCorrelation = Math.max(
    0,
    (rowProjectionCorrelation + columnProjectionCorrelation) / 2,
  );
  return {
    inkDice: round(threshold.dice),
    rowProjectionCorrelation: round(rowProjectionCorrelation),
    columnProjectionCorrelation: round(columnProjectionCorrelation),
    blockEdgeCorrelation: round(blockEdgeCorrelation),
    structuralScore: round(
      pixelCorrelation * 0.25
      + ssim * 0.20
      + edgeCorrelation * 0.20
      + threshold.dice * 0.15
      + projectionCorrelation * 0.10
      + Math.max(0, blockEdgeCorrelation) * 0.10,
    ),
  };
}

function detailedComparison(current: ImageFeatures, genuine: ImageFeatures): VisualEvidence {
  const rough: Array<{
    value: number;
    p: number;
    d: number;
    currentVariant: FeatureVariant;
    genuineVariant: FeatureVariant;
    turns: number;
  }> = [];
  for (const currentVariant of current.variants) {
    for (const genuineVariant of genuine.variants) {
      for (let turns = 0; turns < 4; turns += 1) {
        const p = hashDistance(currentVariant.hashes[0].p, genuineVariant.hashes[turns].p);
        const d = hashDistance(currentVariant.hashes[0].d, genuineVariant.hashes[turns].d);
        rough.push({
          value: p * 0.72 + d * 0.28,
          p,
          d,
          currentVariant,
          genuineVariant,
          turns,
        });
      }
    }
  }
  rough.sort((left, right) => left.value - right.value);
  let best: VisualEvidence | null = null;
  for (const item of rough.slice(0, 6)) {
    const rotated = rotatePixels(item.genuineVariant.pixels, FEATURE_SIZE, item.turns);
    const pixelCorrelation = correlation(item.currentVariant.pixels, rotated);
    const edgeCorrelation = cosine(sobel(item.currentVariant.pixels), sobel(rotated));
    const ssim = globalSsim(item.currentVariant.pixels, rotated);
    const score = (1 - item.p) * 0.28
      + (1 - item.d) * 0.12
      + Math.max(0, pixelCorrelation) * 0.30
      + edgeCorrelation * 0.20
      + Math.max(0, ssim) * 0.10;
    const strength = item.p <= 0.078125
      && pixelCorrelation >= 0.965
      && edgeCorrelation >= 0.94
      && ssim >= 0.90
      ? "ultra"
      : item.p <= 0.14
        && pixelCorrelation >= 0.90
        && ssim >= 0.78
        && (edgeCorrelation >= 0.86 || (pixelCorrelation >= 0.94 && ssim >= 0.90))
        ? "strong"
        : item.p <= 0.27
          && pixelCorrelation >= 0.70
          && edgeCorrelation >= 0.65
          && ssim >= 0.50
          ? "moderate"
          : "weak";
    const evidence: VisualEvidence = {
      score: round(score),
      roughDistance: round(item.value),
      pHashDistance: round(item.p),
      dHashDistance: round(item.d),
      correlation: round(pixelCorrelation),
      edgeCorrelation: round(edgeCorrelation),
      ssim: round(ssim),
      currentVariant: item.currentVariant.kind,
      genuineVariant: item.genuineVariant.kind,
      rotationDegrees: item.turns * 90,
      strength,
    };
    if (best === null || evidence.score > best.score) best = evidence;
  }
  if (best === null) throw new ScanOriginalRecoveryError("visual_comparison_failed");
  return best;
}

function detailedRegistrationComparison(
  current: ImageFeatures,
  genuine: ImageFeatures,
): { visual: VisualEvidence; registration: RegistrationEvidence } {
  const currentRegistered = registrationFeatures(current);
  const genuineRegistered = registrationFeatures(genuine);
  const visual = detailedComparison(currentRegistered, genuineRegistered);
  const currentVariant = currentRegistered.variants.find((item) => (
    item.kind === visual.currentVariant
  ));
  const genuineVariant = genuineRegistered.variants.find((item) => (
    item.kind === visual.genuineVariant
  ));
  if (!currentVariant || !genuineVariant) {
    throw new ScanOriginalRecoveryError("registration_comparison_variant_missing");
  }
  const rotated = rotatePixels(
    genuineVariant.pixels,
    FEATURE_SIZE,
    visual.rotationDegrees / 90,
  );
  return {
    visual,
    registration: registrationEvidence(currentVariant.pixels, rotated),
  };
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const current = new Array<number>(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    for (let index = 0; index <= right.length; index += 1) previous[index] = current[index];
  }
  return previous[right.length];
}

function associateFolder(folderName: string, songs: CatalogSong[]): FolderAssociation {
  const key = normalizeText(folderName);
  if (!key) return { kind: "none", songIds: [], score: 0 };
  const exact = songs.filter((song) => song.titleKeys.includes(key)).map((song) => song.id);
  if (exact.length === 1) return { kind: "exact", songIds: exact, score: 1 };
  if (exact.length > 1) return { kind: "ambiguous", songIds: exact.sort(), score: 1 };
  const scored = songs.map((song) => {
    const score = Math.max(...song.titleKeys.map((title) => {
      const distance = levenshtein(key, title);
      return 1 - distance / Math.max(key.length, title.length, 1);
    }));
    return { songId: song.id, score };
  }).sort((left, right) => right.score - left.score || left.songId.localeCompare(right.songId, "en"));
  const best = scored[0];
  const second = scored[1];
  if (best && best.score >= 0.90 && (!second || best.score - second.score >= 0.04)) {
    return { kind: "fuzzy", songIds: [best.songId], score: round(best.score) };
  }
  if (best && best.score >= 0.90) {
    return {
      kind: "ambiguous",
      songIds: scored.filter((item) => best.score - item.score < 0.04).map((item) => item.songId).sort(),
      score: round(best.score),
    };
  }
  return { kind: "none", songIds: [], score: best ? round(best.score) : 0 };
}

function associationEvidence(current: CurrentImage, genuine: GenuineImage): AssociationEvidence {
  const folderMatches = genuine.folderAssociation.songIds.includes(current.scan.songId);
  const currentFilename = filenameKey(current.media.originalFilename);
  const genuineFilename = filenameKey(genuine.filename);
  const filename = currentFilename.length >= 3 && currentFilename === genuineFilename;
  const currentNumber = firstNumber(current.scan.pageLabel) ?? firstNumber(currentFilename);
  const genuineNumber = firstNumber(genuineFilename);
  const pageNumber = currentNumber !== null && currentNumber === genuineNumber;
  const order = folderMatches
    && current.songScanCount === genuine.directoryImageCount
    && current.orderIndex === genuine.orderIndex;
  const folder = folderMatches ? genuine.folderAssociation.kind : "none";
  return {
    folder,
    filename,
    pageNumber,
    order,
    corroborationCount: (folder === "exact" || folder === "fuzzy" ? 1 : 0)
      + Number(filename)
      + Number(pageNumber)
      + Number(order),
  };
}

function qualityEvidence(current: CurrentImage, genuine: GenuineImage): QualityEvidence {
  const pixelAreaRatio = (genuine.features.width * genuine.features.height)
    / Math.max(1, current.features.width * current.features.height);
  const sharpnessRatio = genuine.features.sharpness / Math.max(1, current.features.sharpness);
  const sourceByteRatio = genuine.byteSize / Math.max(1, current.media.byteSize);
  const borderInkDelta = genuine.features.borderInkRatio - current.features.borderInkRatio;
  const contentCoverageRatio = genuine.features.contentCoverage
    / Math.max(0.000001, current.features.contentCoverage);
  const warnings: string[] = [];
  if (pixelAreaRatio < 0.85) warnings.push("genuine_candidate_has_fewer_pixels");
  if (sharpnessRatio < 0.78) warnings.push("genuine_candidate_is_materially_less_sharp");
  if (borderInkDelta > 0.08) warnings.push("genuine_candidate_may_be_more_clipped");
  if (contentCoverageRatio < 0.80) warnings.push("genuine_candidate_has_less_page_coverage");
  const severeRegression = warnings.length > 0;
  const materialGain = !severeRegression && (
    (pixelAreaRatio >= 1.20 && sharpnessRatio >= 0.80)
    || sharpnessRatio >= 1.15
    || (sourceByteRatio >= 1.30 && pixelAreaRatio >= 1.05 && sharpnessRatio >= 0.92)
  );
  return {
    pixelAreaRatio: round(pixelAreaRatio),
    sharpnessRatio: round(sharpnessRatio),
    sourceByteRatio: round(sourceByteRatio),
    borderInkDelta: round(borderInkDelta),
    contentCoverageRatio: round(contentCoverageRatio),
    materialGain,
    severeRegression,
    warnings,
  };
}

function duplicateGroups<T extends { sha256: string; token: string }>(values: T[]): Array<{
  sha256: string;
  tokens: string[];
}> {
  const groups = new Map<string, string[]>();
  for (const value of values) {
    const group = groups.get(value.sha256) ?? [];
    group.push(value.token);
    groups.set(value.sha256, group);
  }
  return [...groups.entries()]
    .filter(([, tokens]) => tokens.length > 1)
    .map(([sha256, tokens]) => ({ sha256, tokens: tokens.sort() }))
    .sort((left, right) => left.sha256.localeCompare(right.sha256, "en"));
}

function groupByHash<T extends { sha256: string }>(values: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = groups.get(value.sha256) ?? [];
    group.push(value);
    groups.set(value.sha256, group);
  }
  return groups;
}

function parseCatalog(value: unknown): {
  songs: CatalogSong[];
  scans: CatalogScan[];
  media: CatalogMedia[];
} {
  const catalog = objectValue(value, "invalid_catalog");
  if (catalog.schemaVersion !== 2) throw new ScanOriginalRecoveryError("unsupported_catalog_version");
  const aliasesBySong = new Map<string, string[]>();
  for (const item of arrayValue(catalog.songAliases, "catalog_aliases_required")) {
    const row = objectValue(item, "invalid_catalog_alias");
    const songId = stringValue(row.songId, "invalid_catalog_alias_song");
    const alias = stringValue(row.alias, "invalid_catalog_alias_value");
    const aliases = aliasesBySong.get(songId) ?? [];
    aliases.push(alias);
    aliasesBySong.set(songId, aliases);
  }
  const songs = arrayValue(catalog.songs, "catalog_songs_required").map((item) => {
    const row = objectValue(item, "invalid_catalog_song");
    const id = stringValue(row.id, "invalid_catalog_song_id");
    const keys = [
      stringValue(row.titleLatin, "invalid_catalog_song_title"),
      nullableString(row.titleNative),
      ...(aliasesBySong.get(id) ?? []),
    ].filter((title): title is string => title !== null).map(normalizeText).filter(Boolean);
    return { id, titleKeys: [...new Set(keys)].sort() };
  });
  const scans = arrayValue(catalog.scans, "catalog_scans_required").map((item) => {
    const row = objectValue(item, "invalid_catalog_scan");
    return {
      id: stringValue(row.id, "invalid_catalog_scan_id"),
      songId: stringValue(row.songId, "invalid_catalog_scan_song"),
      mediaId: stringValue(row.mediaId, "invalid_catalog_scan_media"),
      notebookId: nullableString(row.notebookId),
      pageLabel: nullableString(row.pageLabel),
    };
  });
  const media = arrayValue(catalog.mediaObjects, "catalog_media_required")
    .map((item) => objectValue(item, "invalid_catalog_media"))
    .filter((row) => row.kind === "scan")
    .map((row) => ({
      id: stringValue(row.id, "invalid_catalog_media_id"),
      objectKey: stringValue(row.objectKey, "invalid_catalog_media_key"),
      originalFilename: stringValue(row.originalFilename, "invalid_catalog_media_filename"),
      byteSize: integerValue(row.byteSize, "invalid_catalog_media_size"),
      sha256: nullableString(row.sha256),
    }));
  return { songs, scans, media };
}

function currentOrder(scans: CatalogScan[], mediaById: Map<string, CatalogMedia>): Map<string, {
  index: number;
  count: number;
}> {
  const bySong = new Map<string, CatalogScan[]>();
  for (const scan of scans) {
    const group = bySong.get(scan.songId) ?? [];
    group.push(scan);
    bySong.set(scan.songId, group);
  }
  const result = new Map<string, { index: number; count: number }>();
  for (const group of bySong.values()) {
    group.sort((left, right) => naturalCompare(
      left.pageLabel ?? mediaById.get(left.mediaId)?.originalFilename ?? left.id,
      right.pageLabel ?? mediaById.get(right.mediaId)?.originalFilename ?? right.id,
    ));
    group.forEach((scan, index) => result.set(scan.id, { index, count: group.length }));
  }
  return result;
}

function genuineOrder(files: WalkResult["files"]): Map<string, { index: number; count: number }> {
  const byDirectory = new Map<string, WalkResult["files"]>();
  for (const file of files) {
    const directory = dirname(file.relativePath);
    const group = byDirectory.get(directory) ?? [];
    group.push(file);
    byDirectory.set(directory, group);
  }
  const result = new Map<string, { index: number; count: number }>();
  for (const group of byDirectory.values()) {
    group.sort((left, right) => naturalCompare(left.relativePath, right.relativePath));
    group.forEach((file, index) => result.set(file.relativePath, { index, count: group.length }));
  }
  return result;
}

async function estimateDerivativeBytes(path: string): Promise<number> {
  try {
    const output = await sharp(path, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS, animated: false })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .jpeg({ quality: 85, chromaSubsampling: "4:2:0" })
      .toBuffer();
    return output.byteLength;
  } catch {
    throw new ScanOriginalRecoveryError("derivative_estimate_failed");
  }
}

function stableEvaluation(value: CandidateEvaluation): CandidateEvaluation {
  return {
    ...value,
    quality: { ...value.quality, warnings: [...value.quality.warnings] },
  };
}

function evaluationSort(left: CandidateEvaluation, right: CandidateEvaluation): number {
  if (left.exactBytes !== right.exactBytes) return left.exactBytes ? -1 : 1;
  return right.visual.score - left.visual.score
    || right.association.corroborationCount - left.association.corroborationCount
    || left.genuineToken.localeCompare(right.genuineToken, "en");
}

function strongEvaluation(value: CandidateEvaluation): boolean {
  return value.exactBytes || value.visual.strength === "ultra" || value.visual.strength === "strong";
}

function decideMatches(
  current: CurrentImage[],
  genuine: GenuineImage[],
  evaluations: Map<string, CandidateEvaluation[]>,
): { decisions: MatchDecision[]; lockedGenuine: Set<string> } {
  const decisions = new Map<string, MatchDecision>();
  const lockedGenuine = new Set<string>();
  const lockedGenuineHashes = new Set<string>();
  const genuineByToken = new Map(genuine.map((item) => [item.token, item]));
  const currentByHash = groupByHash(current);
  const genuineByHash = groupByHash(genuine);

  for (const item of current) {
    const currentGroup = currentByHash.get(item.sha256) ?? [];
    const genuineGroup = genuineByHash.get(item.sha256) ?? [];
    if (currentGroup.length === 1 && genuineGroup.length === 1) {
      const exact = (evaluations.get(item.token) ?? []).find((value) => value.genuineToken === genuineGroup[0].token);
      if (!exact) throw new ScanOriginalRecoveryError("exact_evaluation_missing");
      decisions.set(item.token, {
        currentToken: item.token,
        status: "exact_bytes_already_genuine",
        confidenceTier: "exact",
        proposedAction: "retain_current",
        genuineToken: exact.genuineToken,
        reasonCodes: ["unique_exact_sha256", "current_already_genuine"],
        evaluation: exact,
        alternatives: (evaluations.get(item.token) ?? []).slice(0, 5),
        lockedStage: 1,
      });
      lockedGenuine.add(exact.genuineToken);
      lockedGenuineHashes.add(genuineGroup[0].sha256);
    }
  }

  function lockVisual(stage: number, requireAssociation: boolean): number {
    const availableCurrent = current.filter((item) => !decisions.has(item.token));
    const bestByCurrent = new Map<string, CandidateEvaluation>();
    for (const item of availableCurrent) {
      const candidates = (evaluations.get(item.token) ?? []).filter((candidate) => {
        const candidateHash = genuineByToken.get(candidate.genuineToken)?.sha256;
        if (lockedGenuine.has(candidate.genuineToken)
          || (candidateHash !== undefined && lockedGenuineHashes.has(candidateHash))
          || candidate.existingCurrentHashConflict
          || !strongEvaluation(candidate)) return false;
        if (candidate.quality.severeRegression) return false;
        if (requireAssociation) {
          return candidate.association.folder === "exact" || candidate.association.folder === "fuzzy";
        }
        return candidate.visual.strength === "ultra" && candidate.association.corroborationCount >= 1;
      });
      if (candidates[0]) bestByCurrent.set(item.token, candidates[0]);
    }
    const contendersByGenuine = new Map<string, CandidateEvaluation[]>();
    for (const candidate of bestByCurrent.values()) {
      const group = contendersByGenuine.get(candidate.genuineToken) ?? [];
      group.push(candidate);
      contendersByGenuine.set(candidate.genuineToken, group);
    }
    let locked = 0;
    for (const item of availableCurrent) {
      const best = bestByCurrent.get(item.token);
      if (!best) continue;
      const contenders = (contendersByGenuine.get(best.genuineToken) ?? [])
        .sort((left, right) => right.visual.score - left.visual.score);
      if (contenders[0]?.currentToken !== item.token) continue;
      const alternatives = (evaluations.get(item.token) ?? [])
        .filter((candidate) => !lockedGenuine.has(candidate.genuineToken));
      const next = alternatives.find((candidate) => candidate.genuineToken !== best.genuineToken);
      const currentMargin = next ? best.visual.score - next.visual.score : 1;
      const contenderMargin = contenders[1] ? best.visual.score - contenders[1].visual.score : 1;
      if (currentMargin < 0.025 || contenderMargin < 0.025) continue;
      const status: MatchStatus = best.quality.materialGain
        ? "confirmed_replacement"
        : "confirmed_visual_equivalent_no_change";
      decisions.set(item.token, {
        currentToken: item.token,
        status,
        confidenceTier: "confirmed",
        proposedAction: best.quality.materialGain ? "replace_after_approval" : "retain_current",
        genuineToken: best.genuineToken,
        reasonCodes: [
          `visual_${best.visual.strength}`,
          "mutual_unique_best",
          requireAssociation ? "folder_association_corroborated" : "metadata_corroborated",
          best.quality.materialGain ? "material_quality_gain" : "no_material_quality_gain",
        ],
        evaluation: best,
        alternatives: alternatives.slice(0, 5),
        lockedStage: stage,
      });
      lockedGenuine.add(best.genuineToken);
      const lockedHash = genuineByToken.get(best.genuineToken)?.sha256;
      if (lockedHash) lockedGenuineHashes.add(lockedHash);
      locked += 1;
    }
    return locked;
  }

  while (lockVisual(2, true) > 0) {
    // A new pass deliberately recomputes unique best candidates after locked pairs leave the pool.
  }
  while (lockVisual(3, false) > 0) {
    // The final automatic tier requires ultra-strong content plus independent metadata.
  }

  for (const item of current) {
    if (decisions.has(item.token)) continue;
    const alternatives = (evaluations.get(item.token) ?? [])
      .filter((candidate) => !lockedGenuine.has(candidate.genuineToken));
    const best = alternatives[0] ?? null;
    const strong = alternatives.filter(strongEvaluation);
    if (best?.quality.severeRegression && strongEvaluation(best)) {
      decisions.set(item.token, {
        currentToken: item.token,
        status: "owner_review_quality",
        confidenceTier: "probable",
        proposedAction: "owner_review",
        genuineToken: best.genuineToken,
        reasonCodes: ["strong_content_match", ...best.quality.warnings],
        evaluation: best,
        alternatives: alternatives.slice(0, 5),
        lockedStage: null,
      });
    } else if (best?.existingCurrentHashConflict && strongEvaluation(best)) {
      decisions.set(item.token, {
        currentToken: item.token,
        status: "owner_review_ambiguous",
        confidenceTier: "ambiguous",
        proposedAction: "owner_review",
        genuineToken: best.genuineToken,
        reasonCodes: ["candidate_hash_already_belongs_to_another_current_scan"],
        evaluation: best,
        alternatives: alternatives.slice(0, 5),
        lockedStage: null,
      });
    } else if (strong.length > 1
      || (best
        && best.visual.strength !== "weak"
        && alternatives[1]
        && best.visual.score - alternatives[1].visual.score < 0.025)) {
      decisions.set(item.token, {
        currentToken: item.token,
        status: "owner_review_ambiguous",
        confidenceTier: "ambiguous",
        proposedAction: "owner_review",
        genuineToken: best?.genuineToken ?? null,
        reasonCodes: ["multiple_plausible_candidates_or_small_margin"],
        evaluation: best,
        alternatives: alternatives.slice(0, 5),
        lockedStage: null,
      });
    } else if (best && best.visual.strength !== "weak") {
      decisions.set(item.token, {
        currentToken: item.token,
        status: "owner_review_probable",
        confidenceTier: "probable",
        proposedAction: "owner_review",
        genuineToken: best.genuineToken,
        reasonCodes: [
          `visual_${best.visual.strength}`,
          best.association.corroborationCount > 0 ? "metadata_corroborated" : "association_not_corroborated",
        ],
        evaluation: best,
        alternatives: alternatives.slice(0, 5),
        lockedStage: null,
      });
    } else {
      decisions.set(item.token, {
        currentToken: item.token,
        status: "unmatched",
        confidenceTier: "unmatched",
        proposedAction: "owner_review",
        genuineToken: best?.genuineToken ?? null,
        reasonCodes: ["no_strong_candidate"],
        evaluation: best,
        alternatives: alternatives.slice(0, 5),
        lockedStage: null,
      });
    }
  }
  return {
    decisions: current.map((item) => decisions.get(item.token)!).filter(Boolean),
    lockedGenuine,
  };
}

function registrationStrongEvaluation(value: CandidateEvaluation): boolean {
  const hashSupported = ((value.visual.strength === "ultra" || value.visual.strength === "strong")
      && value.visual.score >= 0.82)
    || (value.visual.score >= 0.87
      && value.visual.pHashDistance <= 0.11
      && value.visual.dHashDistance <= 0.08
      && value.visual.correlation >= 0.85
      && value.visual.edgeCorrelation >= 0.80
      && value.visual.ssim >= 0.82);
  const structure = value.registration;
  const structureSupported = structure !== undefined
    && value.visual.score >= 0.82
    && value.visual.correlation >= 0.93
    && value.visual.edgeCorrelation >= 0.83
    && value.visual.ssim >= 0.93
    && structure.inkDice >= 0.72
    && (structure.rowProjectionCorrelation + structure.columnProjectionCorrelation) / 2 >= 0.82
    && structure.blockEdgeCorrelation >= 0.82
    && structure.structuralScore >= 0.86;
  return hashSupported || structureSupported;
}

function refineUnmatchedWithRegistration(
  current: CurrentImage[],
  genuine: GenuineImage[],
  evaluations: Map<string, CandidateEvaluation[]>,
  decisions: MatchDecision[],
  lockedGenuine: Set<string>,
): void {
  const currentByToken = new Map(current.map((item) => [item.token, item]));
  const genuineByToken = new Map(genuine.map((item) => [item.token, item]));
  const currentByHash = groupByHash(current);
  const genuineByHash = groupByHash(genuine);
  const lockedHashes = new Set(
    [...lockedGenuine]
      .map((token) => genuineByToken.get(token)?.sha256)
      .filter((hash): hash is string => hash !== undefined),
  );
  const availableGenuine = genuine.filter((item) => (
    !lockedGenuine.has(item.token) && !lockedHashes.has(item.sha256)
  ));
  const registered = new Map<string, CandidateEvaluation[]>();

  for (const decision of decisions.filter((item) => item.status === "unmatched")) {
    const currentItem = currentByToken.get(decision.currentToken);
    if (!currentItem) throw new ScanOriginalRecoveryError("unmatched_current_missing");
    const shortlist = availableGenuine
      .map((genuineItem) => ({
        genuine: genuineItem,
        rough: registrationRoughComparison(currentItem.features, genuineItem.features),
      }))
      .sort((left, right) => left.rough - right.rough
        || left.genuine.token.localeCompare(right.genuine.token, "en"))
      .slice(0, 24);
    const detailed = shortlist.map(({ genuine: genuineItem }): CandidateEvaluation => {
      const exactBytes = genuineItem.sha256 === currentItem.sha256;
      const comparison = exactBytes
        ? {
            visual: {
              score: 1,
              roughDistance: 0,
              pHashDistance: 0,
              dHashDistance: 0,
              correlation: 1,
              edgeCorrelation: 1,
              ssim: 1,
              currentVariant: "exact_bytes",
              genuineVariant: "exact_bytes",
              rotationDegrees: 0,
              strength: "ultra" as const,
            },
            registration: {
              inkDice: 1,
              rowProjectionCorrelation: 1,
              columnProjectionCorrelation: 1,
              blockEdgeCorrelation: 1,
              structuralScore: 1,
            },
          }
        : detailedRegistrationComparison(currentItem.features, genuineItem.features);
      return {
        currentToken: currentItem.token,
        genuineToken: genuineItem.token,
        exactBytes,
        existingCurrentHashConflict: (currentByHash.get(genuineItem.sha256) ?? [])
          .some((item) => item.token !== currentItem.token),
        visual: comparison.visual,
        association: associationEvidence(currentItem, genuineItem),
        quality: qualityEvidence(currentItem, genuineItem),
        registration: comparison.registration,
      };
    }).sort(evaluationSort);
    registered.set(decision.currentToken, detailed);
    evaluations.set(decision.currentToken, detailed);
  }

  const bestSecureByCurrent = new Map<string, CandidateEvaluation>();
  const contendersByGenuine = new Map<string, CandidateEvaluation[]>();
  for (const [currentToken, candidates] of registered) {
    const best = candidates.find(registrationStrongEvaluation);
    if (!best) continue;
    bestSecureByCurrent.set(currentToken, best);
    const contenders = contendersByGenuine.get(best.genuineToken) ?? [];
    contenders.push(best);
    contendersByGenuine.set(best.genuineToken, contenders);
  }

  for (const decision of decisions.filter((item) => item.status === "unmatched")) {
    const candidates = registered.get(decision.currentToken) ?? [];
    const best = candidates[0] ?? null;
    const bestSecure = bestSecureByCurrent.get(decision.currentToken);
    if (!bestSecure) {
      if (best && (!decision.evaluation || best.visual.score > decision.evaluation.visual.score)) {
        decision.genuineToken = best.genuineToken;
        decision.evaluation = best;
        decision.alternatives = candidates.slice(0, 5);
        decision.reasonCodes = ["registered_search_found_no_secure_match"];
      }
      continue;
    }
    const secure = candidates.filter(registrationStrongEvaluation);
    const next = candidates.find((candidate) => candidate.genuineToken !== bestSecure.genuineToken);
    const smallMargin = next !== undefined && bestSecure.visual.score - next.visual.score < 0.025;
    const manyToOne = (contendersByGenuine.get(bestSecure.genuineToken) ?? []).length > 1;
    const duplicateCandidate = (genuineByHash.get(
      genuineByToken.get(bestSecure.genuineToken)?.sha256 ?? "",
    ) ?? []).length > 1;
    const ambiguous = bestSecure.existingCurrentHashConflict
      || duplicateCandidate
      || secure.length > 1
      || smallMargin
      || manyToOne;

    decision.genuineToken = bestSecure.genuineToken;
    decision.evaluation = bestSecure;
    decision.alternatives = candidates.slice(0, 5);
    decision.lockedStage = null;
    if (ambiguous) {
      decision.status = "owner_review_ambiguous";
      decision.confidenceTier = "ambiguous";
      decision.proposedAction = "owner_review";
      decision.reasonCodes = [
        "registered_asymmetric_crop_or_shear_match",
        "registered_candidate_conflict_or_small_margin",
        "experimental_owner_review_only",
      ];
    } else if (bestSecure.quality.severeRegression) {
      decision.status = "owner_review_quality";
      decision.confidenceTier = "probable";
      decision.proposedAction = "owner_review";
      decision.reasonCodes = [
        "registered_asymmetric_crop_or_shear_match",
        ...bestSecure.quality.warnings,
        "experimental_owner_review_only",
      ];
    } else {
      decision.status = "owner_review_probable";
      decision.confidenceTier = "probable";
      decision.proposedAction = "owner_review";
      decision.reasonCodes = [
        `visual_${bestSecure.visual.strength}`,
        "registered_asymmetric_crop_or_shear_match",
        bestSecure.association.corroborationCount > 0
          ? "metadata_corroborated"
          : "association_not_corroborated",
        "experimental_owner_review_only",
      ];
    }
  }
}

function conflictGroups(
  evaluations: Map<string, CandidateEvaluation[]>,
): RecoveryReport["conflicts"] {
  const many = new Map<string, Set<string>>();
  const one: Array<{ currentToken: string; genuineTokens: string[] }> = [];
  for (const [currentToken, candidates] of evaluations) {
    const plausible = candidates.filter(strongEvaluation);
    if (plausible.length > 1) {
      one.push({ currentToken, genuineTokens: plausible.map((item) => item.genuineToken).sort() });
    }
    for (const candidate of plausible) {
      const group = many.get(candidate.genuineToken) ?? new Set<string>();
      group.add(currentToken);
      many.set(candidate.genuineToken, group);
    }
  }
  return {
    manyToOne: [...many.entries()]
      .filter(([, tokens]) => tokens.size > 1)
      .map(([genuineToken, tokens]) => ({ genuineToken, currentTokens: [...tokens].sort() }))
      .sort((left, right) => left.genuineToken.localeCompare(right.genuineToken, "en")),
    oneToMany: one.sort((left, right) => left.currentToken.localeCompare(right.currentToken, "en")),
  };
}

async function writeAtomic(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.temporary`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function assertPrivateOutput(path: string, projectRoot: string): string {
  const output = resolve(path);
  const allowed = [resolve(projectRoot, "notes/private"), resolve(projectRoot, "data/import-output")];
  const protectedRoots = [resolve(projectRoot, "legacy")];
  if (!allowed.some((root) => isWithin(output, root))) {
    throw new ScanOriginalRecoveryError("output_must_be_private");
  }
  if (protectedRoots.some((root) => isWithin(output, root))) {
    throw new ScanOriginalRecoveryError("output_inside_legacy_root");
  }
  return output;
}

function reportMarkdown(report: RecoveryReport): string {
  const lines = [
    "# Scan original recovery report",
    "",
    "This ignored private report is deterministic for the recorded inputs. Paths and identifiers below must not be copied into tracked files or ordinary logs.",
    "",
    "## Aggregate",
    "",
    "```json",
    JSON.stringify(report.aggregate, null, 2),
    "```",
    "",
    "## Decisions",
    "",
    "| Current | Status | Candidate | Visual | Folder | Action |",
    "|---|---|---|---:|---|---|",
  ];
  for (const decision of report.decisions) {
    const evaluation = decision.evaluation as CandidateEvaluation | null;
    lines.push(`| ${String(decision.currentToken)} | ${String(decision.status)} | ${String(decision.genuineToken ?? "—")} | ${evaluation?.visual.score ?? "—"} | ${evaluation?.association.folder ?? "—"} | ${String(decision.proposedAction)} |`);
  }
  lines.push(
    "",
    "## Review",
    "",
    "See `review/index.md` for generated visual aids. A confirmed tier is still only a proposed local mapping; no cloud replacement is authorized by this report.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function thumbnail(path: string, width: number, height: number): Promise<Buffer> {
  return sharp(path, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS, animated: false })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(width, height, { fit: "contain", background: "#ffffff", withoutEnlargement: false })
    .jpeg({ quality: 86 })
    .toBuffer();
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function writeReviewAid(
  outputPath: string,
  decision: MatchDecision,
  current: CurrentImage,
  genuine: GenuineImage,
): Promise<void> {
  const width = 420;
  const height = 560;
  const [left, right] = await Promise.all([
    thumbnail(current.path, width, height),
    thumbnail(genuine.path, width, height),
  ]);
  const difference = await sharp(left)
    .composite([{ input: right, blend: "difference" }])
    .linear(2.2, 0)
    .jpeg({ quality: 86 })
    .toBuffer();
  const label = `${decision.currentToken}  ${decision.status}  score=${decision.evaluation?.visual.score ?? 0}`;
  const caption = Buffer.from(`<svg width="1260" height="70"><rect width="1260" height="70" fill="#111"/><text x="20" y="43" fill="white" font-size="24" font-family="sans-serif">${xmlEscape(label)}</text></svg>`);
  const canvas = sharp({ create: { width: width * 3, height: height + 70, channels: 3, background: "#ffffff" } });
  const output = await canvas.composite([
    { input: left, left: 0, top: 70 },
    { input: right, left: width, top: 70 },
    { input: difference, left: width * 2, top: 70 },
    { input: caption, left: 0, top: 0 },
  ]).jpeg({ quality: 88 }).toBuffer();
  await writeAtomic(outputPath, output);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function reviewGalleryHtml(
  selected: MatchDecision[],
  reportSha256: string,
  ownerApprovedTokens: Set<string>,
  title = "Scan original recovery review",
): string {
  const count = (status: MatchStatus): number => selected.filter((item) => item.status === status).length;
  const ownerReviewCount = selected.filter((item) => item.status.startsWith("owner_review_")).length;
  const cards = selected.map((decision, index) => {
    const token = escapeHtml(decision.currentToken);
    const status = escapeHtml(decision.status);
    const statusLabel = escapeHtml(decision.status.replaceAll("_", " "));
    const ownerApproved = ownerApprovedTokens.has(decision.currentToken);
    const initialReview = ownerApproved ? "correct" : "";
    return `
      <article class="review-card" id="item-${token}" data-status="${status}" data-review="${initialReview}" data-owner-approved="${ownerApproved}">
        <header>
          <span class="sequence">${index + 1} / ${selected.length}</span>
          <strong>${token}</strong>
          <span class="status">${statusLabel}</span>
          <label class="decision-label">${ownerApproved ? "Owner decision" : "Review"}
            <select class="decision" aria-label="Review decision for ${token}"${ownerApproved ? " disabled" : ""}>
              <option value="">Unreviewed</option>
              <option value="correct"${ownerApproved ? " selected" : ""}>${ownerApproved ? "Confirmed by owner" : "Looks correct"}</option>
              <option value="issue">Issue</option>
              <option value="unsure">Unsure</option>
            </select>
          </label>
        </header>
        <img src="${token}.jpg" alt="Current source, proposed candidate, and difference for ${token}" loading="lazy" decoding="async">
      </article>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self';">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font: 15px/1.4 system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    .toolbar { position: sticky; top: 0; z-index: 10; padding: .75rem 1rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 22%, transparent); background: color-mix(in srgb, Canvas 94%, transparent); backdrop-filter: blur(12px); }
    .toolbar h1 { display: inline; margin: 0 1rem 0 0; font-size: 1.05rem; }
    .controls { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; }
    .controls label { white-space: nowrap; }
    select, button { font: inherit; padding: .3rem .5rem; }
    button { cursor: pointer; }
    .help { margin: .45rem 0 0; color: color-mix(in srgb, CanvasText 70%, transparent); font-size: .88rem; }
    #progress { font-variant-numeric: tabular-nums; font-weight: 650; }
    #save-status { padding: .15rem .45rem; border-radius: .3rem; font-weight: 650; }
    #save-status[data-state="saved"] { color: #248a3d; }
    #save-status[data-state="saving"] { color: #b86b00; }
    #save-status[data-state="error"] { color: #d33; background: color-mix(in srgb, #d33 10%, transparent); }
    main { display: grid; gap: 1rem; margin: 1rem auto 4rem; padding: 0 1rem; max-width: 1900px; }
    main[data-density="compact"] { grid-template-columns: repeat(auto-fit, minmax(min(100%, 560px), 1fr)); }
    .review-card { overflow: clip; border: 2px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: .55rem; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); content-visibility: auto; contain-intrinsic-size: auto 700px; }
    .review-card[data-review="correct"] { border-color: #248a3d; }
    .review-card[data-review="issue"] { border-color: #d33; box-shadow: 0 0 0 2px color-mix(in srgb, #d33 25%, transparent); }
    .review-card[data-review="unsure"] { border-color: #d08a00; }
    .review-card header { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem .8rem; padding: .55rem .7rem; }
    .sequence { color: color-mix(in srgb, CanvasText 65%, transparent); font-variant-numeric: tabular-nums; }
    .status { padding: .1rem .45rem; border-radius: 999px; background: color-mix(in srgb, CanvasText 10%, transparent); font-size: .82rem; }
    .decision-label { margin-left: auto; }
    .review-card img { display: block; width: 100%; height: auto; background: white; }
    .empty { display: none; padding: 3rem 1rem; text-align: center; }
    .empty.visible { display: block; }
    @media (max-width: 700px) {
      .toolbar { position: static; }
      .controls { display: flex; margin-top: .6rem; }
      .decision-label { width: 100%; margin-left: 0; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>${escapeHtml(title)}</h1>
    <div class="controls">
      <label>Matches
        <select id="status-filter">
          <option value="all">All (${selected.length})</option>
          <option value="confirmed_replacement">Confirmed replacements (${count("confirmed_replacement")})</option>
          <option value="confirmed_visual_equivalent_no_change">No change (${count("confirmed_visual_equivalent_no_change")})</option>
          <option value="owner_review">Owner review (${ownerReviewCount})</option>
          <option value="unmatched">Unmatched (${count("unmatched")})</option>
        </select>
      </label>
      <label>Checklist
        <select id="review-filter">
          <option value="all">All states</option>
          <option value="">Unreviewed</option>
          <option value="correct">Looks correct</option>
          <option value="issue">Issues</option>
          <option value="unsure">Unsure</option>
        </select>
      </label>
      <label>Layout
        <select id="density">
          <option value="large">Large</option>
          <option value="compact">Compact grid</option>
        </select>
      </label>
      <button type="button" id="next-unreviewed">Next unreviewed</button>
      <label>Mark all shown as
        <select id="bulk-decision">
          <option value="correct">Looks correct</option>
          <option value="issue">Issue</option>
          <option value="unsure">Unsure</option>
          <option value="">Unreviewed</option>
        </select>
      </label>
      <button type="button" id="apply-bulk">Apply</button>
      <button type="button" id="export-reviews">Export reviews</button>
      <button type="button" id="clear-marks">Clear marks</button>
      <span id="progress" aria-live="polite"></span>
      <span id="save-status" data-state="saving" aria-live="polite">Connecting to file-backed autosave…</span>
    </div>
    <p class="help">Each image is current source | proposed genuine candidate | amplified difference. Use the loopback review-server URL: every change is then atomically saved in the ignored private workspace. Direct file preview is view-only because browsers do not persist it reliably.</p>
  </div>
  <main id="gallery" data-density="large">${cards}
    <p class="empty" id="empty">No items match these filters.</p>
  </main>
  <script>
    (() => {
      const cards = Array.from(document.querySelectorAll('.review-card'));
      const statusFilter = document.querySelector('#status-filter');
      const reviewFilter = document.querySelector('#review-filter');
      const density = document.querySelector('#density');
      const gallery = document.querySelector('#gallery');
      const progress = document.querySelector('#progress');
      const empty = document.querySelector('#empty');
      const saveStatus = document.querySelector('#save-status');
      const bulkDecision = document.querySelector('#bulk-decision');
      const applyBulk = document.querySelector('#apply-bulk');
      const clearMarks = document.querySelector('#clear-marks');
      const exportReviews = document.querySelector('#export-reviews');
      const reportSha256 = ${JSON.stringify(reportSha256)};
      const serverBacked = location.protocol === 'http:' && location.hostname === '127.0.0.1';
      let persistenceReady = false;
      let saveQueue = Promise.resolve();
      const matchesStatus = (status, filter) => filter === 'all'
        || status === filter
        || (filter === 'owner_review' && status.startsWith('owner_review_'));
      const items = () => cards.map((card) => ({
        currentToken: card.id.slice(5),
        matchStatus: card.dataset.status,
        reviewDecision: card.dataset.review || 'unreviewed',
        ownerApproved: card.dataset.ownerApproved === 'true',
      }));
      const setSaveStatus = (message, state) => {
        saveStatus.textContent = message;
        saveStatus.dataset.state = state;
      };
      const setEditingEnabled = (enabled) => {
        cards.forEach((card) => {
          if (card.dataset.ownerApproved !== 'true') card.querySelector('.decision').disabled = !enabled;
        });
        bulkDecision.disabled = !enabled;
        applyBulk.disabled = !enabled;
        clearMarks.disabled = !enabled;
        exportReviews.disabled = !enabled;
      };
      const update = () => {
        let visible = 0;
        let reviewed = 0;
        cards.forEach((card) => {
          const state = card.dataset.review || '';
          if (state) reviewed += 1;
          const show = matchesStatus(card.dataset.status, statusFilter.value)
            && (reviewFilter.value === 'all' || state === reviewFilter.value);
          card.hidden = !show;
          if (show) visible += 1;
        });
        progress.textContent = reviewed + ' reviewed · ' + visible + ' shown';
        empty.classList.toggle('visible', visible === 0);
      };
      const persist = () => {
        if (!persistenceReady) return Promise.resolve();
        setSaveStatus('Saving…', 'saving');
        saveQueue = saveQueue.catch(() => undefined).then(async () => {
          const response = await fetch('/api/review-state', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reportSha256, items: items() }),
          });
          if (!response.ok) throw new Error('save_failed');
          const saved = await response.json();
          setSaveStatus('Saved to private file · ' + saved.reviewedCount + ' reviewed', 'saved');
        }).catch(() => {
          setSaveStatus('Save failed — stop reviewing and restart the local server', 'error');
        });
        return saveQueue;
      };
      cards.forEach((card) => {
        const select = card.querySelector('.decision');
        const ownerApproved = card.dataset.ownerApproved === 'true';
        const state = ownerApproved ? 'correct' : '';
        select.value = state;
        card.dataset.review = state;
        if (!ownerApproved) {
          select.addEventListener('change', () => {
            card.dataset.review = select.value;
            update();
            void persist();
          });
        }
      });
      statusFilter.addEventListener('change', update);
      reviewFilter.addEventListener('change', update);
      density.addEventListener('change', () => { gallery.dataset.density = density.value; });
      document.querySelector('#next-unreviewed').addEventListener('click', () => {
        const target = cards.find((card) => !card.hidden && !card.dataset.review);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      applyBulk.addEventListener('click', () => {
        const targets = cards.filter((card) => !card.hidden && card.dataset.ownerApproved !== 'true');
        const label = bulkDecision.options[bulkDecision.selectedIndex].textContent;
        if (targets.length === 0 || !confirm('Mark all ' + targets.length + ' shown items as “' + label + '”? Existing marks in this filtered view will be replaced.')) return;
        targets.forEach((card) => {
          card.dataset.review = bulkDecision.value;
          card.querySelector('.decision').value = bulkDecision.value;
        });
        update();
        void persist();
      });
      exportReviews.addEventListener('click', () => {
        const link = document.createElement('a');
        link.href = '/api/export';
        link.download = '';
        document.body.appendChild(link);
        link.click();
        link.remove();
      });
      clearMarks.addEventListener('click', () => {
        if (!confirm('Clear every local checklist mark for this report?')) return;
        cards.forEach((card) => {
          if (card.dataset.ownerApproved === 'true') return;
          card.dataset.review = '';
          card.querySelector('.decision').value = '';
        });
        update();
        void persist();
      });
      const hydrate = async () => {
        setEditingEnabled(false);
        if (!serverBacked) {
          setSaveStatus('View only — open the loopback review-server URL to save decisions', 'error');
          update();
          return;
        }
        try {
          const response = await fetch('/api/review-state', { cache: 'no-store' });
          if (!response.ok) throw new Error('load_failed');
          const state = await response.json();
          if (state.reportSha256 !== reportSha256 || state.itemCount !== cards.length) {
            throw new Error('state_mismatch');
          }
          cards.forEach((card) => {
            if (card.dataset.ownerApproved === 'true') return;
            const decision = state.decisions[card.id.slice(5)] || '';
            card.dataset.review = decision;
            card.querySelector('.decision').value = decision;
          });
          persistenceReady = true;
          setEditingEnabled(true);
          setSaveStatus('Saved to private file · ' + state.reviewedCount + ' reviewed', 'saved');
          update();
        } catch {
          setSaveStatus('Could not load private review state — do not mark items', 'error');
        }
      };
      update();
      void hydrate();
    })();
  </script>
</body>
</html>
`;
}

function ownerApprovalJson(reportSha256: string, decisions: MatchDecision[]): string {
  const mappings = decisions
    .filter((decision) => decision.status === "confirmed_replacement" && decision.genuineToken !== null)
    .map((decision) => ({
      currentToken: decision.currentToken,
      genuineToken: decision.genuineToken!,
    }))
    .sort((left, right) => left.currentToken.localeCompare(right.currentToken, "en"));
  return `${JSON.stringify({
    schemaVersion: 1,
    reportSha256,
    ownerDecision: "approved_all_confirmed_replacements",
    count: mappings.length,
    mappings,
  }, null, 2)}\n`;
}

async function resolveOwnerApprovedTokens(
  outputDirectory: string,
  reportSha256: string,
  decisions: MatchDecision[],
  recordApproval: boolean,
): Promise<Set<string>> {
  const approvalPath = resolve(outputDirectory, "owner-approved-confirmed-replacements.json");
  const expected = ownerApprovalJson(reportSha256, decisions);
  if (recordApproval) {
    await writeAtomic(approvalPath, expected);
  } else {
    let existing: Buffer;
    try {
      existing = await readFile(approvalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw new ScanOriginalRecoveryError("owner_approval_unreadable");
    }
    if (existing.toString("utf8") !== expected) {
      throw new ScanOriginalRecoveryError("owner_approval_report_mismatch");
    }
  }
  return new Set(decisions
    .filter((decision) => decision.status === "confirmed_replacement")
    .map((decision) => decision.currentToken));
}

async function writeReviewAids(
  outputDirectory: string,
  decisions: MatchDecision[],
  currentByToken: Map<string, CurrentImage>,
  genuineByToken: Map<string, GenuineImage>,
  limit: number,
  reportSha256: string,
  ownerApprovedTokens: Set<string>,
): Promise<number> {
  const selected = decisions
    .filter((decision) => decision.genuineToken !== null && decision.status !== "exact_bytes_already_genuine")
    .sort((left, right) => {
      const priority = (status: MatchStatus): number => ({
        confirmed_replacement: 0,
        confirmed_visual_equivalent_no_change: 1,
        owner_review_quality: 2,
        owner_review_ambiguous: 3,
        owner_review_probable: 4,
        unmatched: 5,
        exact_bytes_already_genuine: 6,
      })[status];
      return priority(left.status) - priority(right.status)
        || left.currentToken.localeCompare(right.currentToken, "en");
    })
    .slice(0, limit);
  const reviewDirectory = resolve(outputDirectory, "review");
  await mkdir(reviewDirectory, { recursive: true });
  const expectedAidNames = new Set(selected.map((decision) => `${decision.currentToken}.jpg`));
  for (const entry of await readdir(reviewDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/^current-\d{4}\.jpg$/u.test(entry.name) && !expectedAidNames.has(entry.name)) {
      await rm(resolve(reviewDirectory, entry.name));
    }
    if (/^contact-sheet-\d{3}\.jpg$/u.test(entry.name)) {
      await rm(resolve(reviewDirectory, entry.name));
    }
  }
  const indexLines = [
    "# Scan original recovery visual review",
    "",
    "Each aid shows current AppSheet-derived source, proposed genuine candidate, and an amplified pixel-difference view. Labels are opaque tokens; use the private JSON report for mappings.",
    "",
  ];
  for (const decision of selected) {
    const current = currentByToken.get(decision.currentToken);
    const genuine = decision.genuineToken ? genuineByToken.get(decision.genuineToken) : undefined;
    if (!current || !genuine) continue;
    const filename = `${decision.currentToken}.jpg`;
    await writeReviewAid(resolve(reviewDirectory, filename), decision, current, genuine);
    indexLines.push(`- ${decision.currentToken}: ${decision.status} — [review aid](${filename})`);
  }
  const contactSheetNames: string[] = [];
  for (let offset = 0; offset < selected.length; offset += 12) {
    const page = selected.slice(offset, offset + 12);
    const cells = await Promise.all(page.map(async (decision) => ({
      token: decision.currentToken,
      bytes: await sharp(resolve(reviewDirectory, `${decision.currentToken}.jpg`))
        .resize(420, 210, { fit: "contain", background: "#ffffff" })
        .jpeg({ quality: 84 })
        .toBuffer(),
    })));
    const rows = Math.ceil(cells.length / 3);
    const sheet = await sharp({
      create: { width: 1260, height: rows * 210, channels: 3, background: "#ffffff" },
    }).composite(cells.map((cell, index) => ({
      input: cell.bytes,
      left: (index % 3) * 420,
      top: Math.floor(index / 3) * 210,
    }))).jpeg({ quality: 86 }).toBuffer();
    const sheetName = `contact-sheet-${String(contactSheetNames.length + 1).padStart(3, "0")}.jpg`;
    await writeAtomic(resolve(reviewDirectory, sheetName), sheet);
    contactSheetNames.push(sheetName);
  }
  if (contactSheetNames.length > 0) {
    indexLines.splice(4, 0,
      "## Contact sheets",
      "",
      ...contactSheetNames.map((name, index) => `- [Contact sheet ${index + 1}](${name})`),
      "",
      "## Individual aids",
      "",
    );
  }
  const remaining = selected.filter((decision) =>
    !ownerApprovedTokens.has(decision.currentToken) && decision.status !== "unmatched");
  const deferredUnmatched = selected.filter((decision) => decision.status === "unmatched");
  indexLines.splice(4, 0,
    "## Scrollable galleries",
    "",
    "- [All review items](gallery.html)",
    `- [Remaining current-focus items (${remaining.length})](remaining.html)`,
    `- [Deferred unmatched items (${deferredUnmatched.length})](deferred-unmatched.html)`,
    "",
  );
  indexLines.push("");
  await Promise.all([
    writeAtomic(resolve(reviewDirectory, "index.md"), `${indexLines.join("\n")}\n`),
    writeAtomic(
      resolve(reviewDirectory, "gallery.html"),
      reviewGalleryHtml(selected, reportSha256, ownerApprovedTokens),
    ),
    writeAtomic(
      resolve(reviewDirectory, "remaining.html"),
      reviewGalleryHtml(remaining, reportSha256, new Set(), "Remaining scan recovery review"),
    ),
    writeAtomic(
      resolve(reviewDirectory, "deferred-unmatched.html"),
      reviewGalleryHtml(
        deferredUnmatched,
        reportSha256,
        new Set(),
        "Deferred unmatched scan review",
      ),
    ),
  ]);
  return selected.length;
}

export async function buildScanOriginalRecoveryReport(
  options: ScanOriginalRecoveryOptions,
): Promise<{
  report: RecoveryReport;
  aggregate: ScanOriginalRecoveryAggregate;
  currentByToken: Map<string, CurrentImage>;
  genuineByToken: Map<string, GenuineImage>;
  decisions: MatchDecision[];
}> {
  const projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
  if (!Number.isInteger(options.workers) || options.workers < 1) {
    throw new ScanOriginalRecoveryError("workers_must_be_positive");
  }
  const catalogPath = resolve(options.catalogPath);
  const currentRoot = resolve(options.currentRoot);
  const genuineRoot = resolve(options.genuineRoot);
  const outputDirectory = options.writeReport
    ? assertPrivateOutput(options.outputDirectory, projectRoot)
    : resolve(options.outputDirectory);
  if (!isWithin(currentRoot, resolve(projectRoot, "legacy"))
    || !isWithin(genuineRoot, resolve(projectRoot, "legacy"))) {
    throw new ScanOriginalRecoveryError("inputs_must_be_legacy_read_only");
  }
  const [catalogBytes, currentWalk, genuineWalk] = await Promise.all([
    readFile(catalogPath).catch(() => { throw new ScanOriginalRecoveryError("catalog_unreadable"); }),
    walkReadOnly(resolve(currentRoot, "scans")),
    walkReadOnly(genuineRoot),
  ]);
  const catalog = parseCatalog(JSON.parse(catalogBytes.toString("utf8")));
  const mediaById = new Map(catalog.media.map((media) => [media.id, media]));
  const scanByMediaId = new Map(catalog.scans.map((scan) => [scan.mediaId, scan]));
  if (mediaById.size !== catalog.media.length || scanByMediaId.size !== catalog.scans.length
    || catalog.media.length !== catalog.scans.length) {
    throw new ScanOriginalRecoveryError("catalog_scan_relationship_not_one_to_one");
  }
  const currentOrderByScan = currentOrder(catalog.scans, mediaById);
  const referencedRelativePaths = new Set(catalog.media.map((media) => {
    if (!media.objectKey.startsWith("scans/") || media.objectKey.includes("\\")) {
      throw new ScanOriginalRecoveryError("unsafe_current_object_key");
    }
    return media.objectKey.slice("scans/".length);
  }));
  const currentFileByRelative = new Map(currentWalk.files.map((file) => [file.relativePath, file]));
  const orderedMedia = catalog.media.slice().sort((left, right) => left.id.localeCompare(right.id, "en"));
  const current = await mapLimit(orderedMedia, options.workers, async (media, index): Promise<CurrentImage> => {
    const relativePath = media.objectKey.slice("scans/".length);
    const file = currentFileByRelative.get(relativePath);
    const scan = scanByMediaId.get(media.id);
    if (!file || !scan || file.byteSize !== media.byteSize) {
      throw new ScanOriginalRecoveryError("current_source_precondition_failed");
    }
    const { sha256, features } = await hashAndExtractFeatures(
      file.path,
      relativePath,
      file.byteSize,
      "current",
      outputDirectory,
      options.writeReport,
    );
    if (media.sha256 !== null && media.sha256 !== sha256) {
      throw new ScanOriginalRecoveryError("current_source_hash_mismatch");
    }
    const order = currentOrderByScan.get(scan.id);
    if (!order) throw new ScanOriginalRecoveryError("current_order_missing");
    return {
      token: `current-${String(index + 1).padStart(4, "0")}`,
      scan,
      media,
      path: file.path,
      relativePath,
      sha256,
      features,
      orderIndex: order.index,
      songScanCount: order.count,
    };
  });

  const genuineImageFlags = await mapLimit(genuineWalk.files, options.workers, async (file) => (
    IMAGE_EXTENSIONS.has(extname(file.relativePath).toLocaleLowerCase("en"))
      || await hasImageSignature(file.path)
  ));
  const genuineImageFiles = genuineWalk.files.filter((_file, index) => genuineImageFlags[index]);
  const genuineImageRelativePaths = new Set(genuineImageFiles.map((file) => file.relativePath));
  const genuineOrderByPath = genuineOrder(genuineImageFiles);
  const genuineResults = await mapLimit(genuineImageFiles, options.workers, async (file, index) => {
    try {
      const { sha256, features } = await hashAndExtractFeatures(
        file.path,
        file.relativePath,
        file.byteSize,
        "genuine",
        outputDirectory,
        options.writeReport,
      );
      const order = genuineOrderByPath.get(file.relativePath)!;
      return {
        ok: true as const,
        image: {
          token: `genuine-${String(index + 1).padStart(4, "0")}`,
          path: file.path,
          relativePath: file.relativePath,
          directory: dirname(file.relativePath),
          filename: basename(file.relativePath),
          byteSize: file.byteSize,
          sha256,
          features,
          folderAssociation: associateFolder(basename(dirname(file.relativePath)), catalog.songs),
          orderIndex: order.index,
          directoryImageCount: order.count,
        } satisfies GenuineImage,
      };
    } catch {
      return {
        ok: false as const,
        failure: {
          token: `genuine-${String(index + 1).padStart(4, "0")}`,
          relativePath: file.relativePath,
        },
      };
    }
  });
  const genuine = genuineResults.filter((item): item is Extract<typeof item, { ok: true }> => item.ok).map((item) => item.image);
  const decodeFailures = genuineResults.filter((item): item is Extract<typeof item, { ok: false }> => !item.ok).map((item) => item.failure);
  const currentHashGroups = groupByHash(current);
  const genuineHashGroups = groupByHash(genuine);
  const evaluations = new Map<string, CandidateEvaluation[]>();

  for (const currentItem of current) {
    const exactTokens = new Set((genuineHashGroups.get(currentItem.sha256) ?? []).map((item) => item.token));
    const rough = genuine.map((genuineItem) => ({
      genuine: genuineItem,
      rough: exactTokens.has(genuineItem.token) ? 0 : roughComparison(currentItem.features, genuineItem.features),
      associated: genuineItem.folderAssociation.songIds.includes(currentItem.scan.songId),
    })).sort((left, right) => left.rough - right.rough || left.genuine.token.localeCompare(right.genuine.token, "en"));
    const pool = new Map<string, GenuineImage>();
    for (const item of rough.slice(0, 14)) pool.set(item.genuine.token, item.genuine);
    for (const item of rough) {
      if (item.associated || exactTokens.has(item.genuine.token)) pool.set(item.genuine.token, item.genuine);
    }
    const detailed = [...pool.values()].map((genuineItem): CandidateEvaluation => {
      const exactBytes = genuineItem.sha256 === currentItem.sha256;
      const visual = exactBytes
        ? {
            score: 1,
            roughDistance: 0,
            pHashDistance: 0,
            dHashDistance: 0,
            correlation: 1,
            edgeCorrelation: 1,
            ssim: 1,
            currentVariant: "exact_bytes",
            genuineVariant: "exact_bytes",
            rotationDegrees: 0,
            strength: "ultra" as const,
          }
        : detailedComparison(currentItem.features, genuineItem.features);
      return {
        currentToken: currentItem.token,
        genuineToken: genuineItem.token,
        exactBytes,
        existingCurrentHashConflict: (currentHashGroups.get(genuineItem.sha256) ?? [])
          .some((item) => item.token !== currentItem.token),
        visual,
        association: associationEvidence(currentItem, genuineItem),
        quality: qualityEvidence(currentItem, genuineItem),
      };
    }).sort(evaluationSort);
    evaluations.set(currentItem.token, detailed);
  }

  const { decisions, lockedGenuine } = decideMatches(current, genuine, evaluations);
  if (options.experimentalUnmatched) {
    refineUnmatchedWithRegistration(
      current,
      genuine,
      evaluations,
      decisions,
      lockedGenuine,
    );
  }
  const currentByToken = new Map(current.map((item) => [item.token, item]));
  const genuineByToken = new Map(genuine.map((item) => [item.token, item]));
  await mapLimit(
    decisions.filter((decision) => decision.status === "confirmed_replacement"),
    Math.min(2, options.workers),
    async (decision) => {
      const currentItem = currentByToken.get(decision.currentToken);
      const genuineItem = decision.genuineToken ? genuineByToken.get(decision.genuineToken) : undefined;
      if (!currentItem || !genuineItem || !decision.evaluation) {
        throw new ScanOriginalRecoveryError("confirmed_match_missing");
      }
      const [currentBytes, genuineBytes] = await Promise.all([
        estimateDerivativeBytes(currentItem.path),
        estimateDerivativeBytes(genuineItem.path),
      ]);
      decision.evaluation.quality.estimatedCurrentDerivativeBytes = currentBytes;
      decision.evaluation.quality.estimatedGenuineDerivativeBytes = genuineBytes;
    },
  );

  const conflicts = conflictGroups(evaluations);
  const statusCount = (status: MatchStatus): number => decisions.filter((decision) => decision.status === status).length;
  const replacements = decisions.filter((decision) => decision.status === "confirmed_replacement");
  const estimated = replacements.reduce((totals, decision) => {
    const currentItem = currentByToken.get(decision.currentToken)!;
    const genuineItem = genuineByToken.get(decision.genuineToken!)!;
    totals.currentSource += currentItem.media.byteSize;
    totals.genuineSource += genuineItem.byteSize;
    totals.currentDerivative += decision.evaluation?.quality.estimatedCurrentDerivativeBytes ?? 0;
    totals.genuineDerivative += decision.evaluation?.quality.estimatedGenuineDerivativeBytes ?? 0;
    return totals;
  }, { currentSource: 0, genuineSource: 0, currentDerivative: 0, genuineDerivative: 0 });
  const confirmed = decisions.filter((decision) => decision.lockedStage !== null);
  const confirmedCurrentUnique = new Set(confirmed.map((decision) => decision.currentToken)).size === confirmed.length;
  const confirmedGenuineUnique = new Set(confirmed.map((decision) => decision.genuineToken)).size === confirmed.length;
  const confirmedGenuineHashes = confirmed.map((decision) => genuineByToken.get(decision.genuineToken!)!.sha256);
  const confirmedGenuineHashesUnique = new Set(confirmedGenuineHashes).size === confirmedGenuineHashes.length;
  const confirmedReplacementHashCollisionFree = replacements.every((decision) => !decision.evaluation?.existingCurrentHashConflict);
  const nonImageExtensions: Record<string, number> = {};
  const genuineNonImages = genuineWalk.files.filter((item) => !genuineImageRelativePaths.has(item.relativePath));
  for (const file of genuineNonImages) {
    const extension = extname(file.relativePath).toLocaleLowerCase("en") || "(none)";
    nonImageExtensions[extension] = (nonImageExtensions[extension] ?? 0) + 1;
  }
  const unmatchedGenuineTokens = genuine.filter((item) => !lockedGenuine.has(item.token)).map((item) => item.token);
  const stagingScanCount = options.stagingScanCount ?? catalog.scans.length;
  const baseAggregate: Omit<ScanOriginalRecoveryAggregate, "mode" | "reportSha256" | "reviewAidsWritten"> = {
    schemaVersion: 1,
    catalogScans: catalog.scans.length,
    stagingOnlyScansExcluded: Math.max(0, stagingScanCount - catalog.scans.length),
    currentFiles: currentWalk.files.length,
    currentDirectories: currentWalk.directories,
    currentSymlinks: currentWalk.symlinks,
    currentSpecialFiles: currentWalk.special,
    currentReferencedFiles: current.length,
    currentUnreferencedFiles: currentWalk.files.filter((file) => !referencedRelativePaths.has(file.relativePath)).length,
    currentBytes: current.reduce((total, item) => total + item.media.byteSize, 0),
    genuineFiles: genuineWalk.files.length,
    genuineDirectories: genuineWalk.directories,
    genuineSymlinks: genuineWalk.symlinks,
    genuineSpecialFiles: genuineWalk.special,
    genuineImageCandidates: genuineImageFiles.length,
    genuineNonImageFiles: genuineNonImages.length,
    genuineBytes: genuineWalk.files.reduce((total, file) => total + file.byteSize, 0),
    genuineImageBytes: genuineImageFiles.reduce((total, file) => total + file.byteSize, 0),
    genuineDecodeFailures: decodeFailures.length,
    currentDuplicateHashGroups: duplicateGroups(current).length,
    genuineDuplicateHashGroups: duplicateGroups(genuine).length,
    exactAlreadyGenuine: statusCount("exact_bytes_already_genuine"),
    confirmedReplacements: replacements.length,
    confirmedVisualEquivalentNoChange: statusCount("confirmed_visual_equivalent_no_change"),
    ownerReviewQuality: statusCount("owner_review_quality"),
    ownerReviewAmbiguous: statusCount("owner_review_ambiguous"),
    ownerReviewProbable: statusCount("owner_review_probable"),
    unmatchedCurrent: statusCount("unmatched"),
    unmatchedGenuineImages: unmatchedGenuineTokens.length,
    manyToOneConflicts: conflicts.manyToOne.length,
    oneToManyConflicts: conflicts.oneToMany.length,
    confirmedOneToOne: confirmedCurrentUnique && confirmedGenuineUnique,
    estimatedChanges: {
      sourceFilesActivated: replacements.length,
      formerSourceFilesRemovedFromActiveUse: replacements.length,
      currentSourceBytesRemovedFromActiveUse: estimated.currentSource,
      genuineSourceBytesActivated: estimated.genuineSource,
      currentDerivativeBytesEstimated: estimated.currentDerivative,
      genuineDerivativeBytesEstimated: estimated.genuineDerivative,
      privateR2BytesAddedEstimated: estimated.genuineSource + estimated.genuineDerivative,
      formerBytesRetainedAsHistoryEstimated: estimated.currentSource + estimated.currentDerivative,
      netActiveBytesEstimated: estimated.genuineSource + estimated.genuineDerivative
        - estimated.currentSource - estimated.currentDerivative,
    },
  };

  const currentInventory = current.map((item) => ({
    token: item.token,
    scanId: item.scan.id,
    songId: item.scan.songId,
    mediaId: item.media.id,
    relativePath: item.relativePath,
    byteSize: item.media.byteSize,
    sha256: item.sha256,
    width: item.features.width,
    height: item.features.height,
    format: item.features.format,
    sharpness: item.features.sharpness,
    borderInkRatio: item.features.borderInkRatio,
    contentCoverage: item.features.contentCoverage,
  }));
  const currentUnreferencedFiles = currentWalk.files
    .filter((file) => !referencedRelativePaths.has(file.relativePath))
    .map((file) => ({ relativePath: file.relativePath, byteSize: file.byteSize }));
  const genuineInventory = genuine.map((item) => ({
    token: item.token,
    relativePath: item.relativePath,
    directory: item.directory,
    byteSize: item.byteSize,
    sha256: item.sha256,
    width: item.features.width,
    height: item.features.height,
    format: item.features.format,
    sharpness: item.features.sharpness,
    borderInkRatio: item.features.borderInkRatio,
    contentCoverage: item.features.contentCoverage,
    folderAssociation: item.folderAssociation,
  }));
  const genuineNonImageInventory = genuineNonImages.map((file, index) => ({
    token: `non-image-${String(index + 1).padStart(4, "0")}`,
    relativePath: file.relativePath,
    byteSize: file.byteSize,
    extension: extname(file.relativePath).toLocaleLowerCase("en") || "(none)",
  }));
  const report: RecoveryReport = {
    schemaVersion: 1,
    methodVersion: options.experimentalUnmatched
      ? "scan-original-recovery-v2"
      : "scan-original-recovery-v1",
    inputs: {
      catalogSha256: createHash("sha256").update(catalogBytes).digest("hex"),
      currentInventorySha256: sha256Json({ currentInventory, currentUnreferencedFiles }),
      genuineInventorySha256: sha256Json({ genuineInventory, genuineNonImageInventory }),
      catalogPath,
      currentRoot,
      genuineRoot,
    },
    aggregate: baseAggregate,
    invariants: {
      everyCatalogScanHasOneCurrentFile: current.length === catalog.scans.length,
      confirmedCurrentUnique,
      confirmedGenuineUnique,
      confirmedGenuineHashesUnique,
      confirmedReplacementHashCollisionFree,
      legacyInputsWritten: false,
      cloudContacted: false,
    },
    inventories: {
      current: currentInventory,
      currentUnreferencedFiles,
      genuineImages: genuineInventory,
      genuineNonImages: genuineNonImageInventory,
      genuineNonImageExtensions: Object.fromEntries(Object.entries(nonImageExtensions).sort()),
      genuineDecodeFailures: decodeFailures,
    },
    decisions: decisions.map((decision) => ({
      ...decision,
      evaluation: decision.evaluation ? stableEvaluation(decision.evaluation) : null,
      alternatives: decision.alternatives.map(stableEvaluation),
    })),
    conflicts,
    duplicateGroups: {
      current: duplicateGroups(current),
      genuine: duplicateGroups(genuine),
    },
    unmatchedGenuineTokens,
  };
  return {
    report,
    aggregate: { ...baseAggregate, mode: options.writeReport ? "write-report" : "dry-run" },
    currentByToken,
    genuineByToken,
    decisions,
  };
}

export async function runScanOriginalRecovery(
  options: ScanOriginalRecoveryOptions,
): Promise<ScanOriginalRecoveryAggregate> {
  const projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
  const outputDirectory = assertPrivateOutput(options.outputDirectory, projectRoot);
  const result = await buildScanOriginalRecoveryReport(options);
  if (!result.report.invariants.everyCatalogScanHasOneCurrentFile
    || !result.report.invariants.confirmedCurrentUnique
    || !result.report.invariants.confirmedGenuineUnique
    || !result.report.invariants.confirmedGenuineHashesUnique
    || !result.report.invariants.confirmedReplacementHashCollisionFree) {
    throw new ScanOriginalRecoveryError("recovery_invariant_failed");
  }
  const reportJson = `${JSON.stringify(result.report, null, 2)}\n`;
  const reportSha256 = createHash("sha256").update(reportJson).digest("hex");
  let reviewAidsWritten = 0;
  if (options.writeReport) {
    const ownerApprovedTokens = await resolveOwnerApprovedTokens(
      outputDirectory,
      reportSha256,
      result.decisions,
      options.ownerApproveConfirmedReplacements ?? false,
    );
    await Promise.all([
      writeAtomic(resolve(outputDirectory, "match-report.json"), reportJson),
      writeAtomic(resolve(outputDirectory, "match-report.md"), reportMarkdown(result.report)),
    ]);
    if (options.writeReview) {
      reviewAidsWritten = await writeReviewAids(
        outputDirectory,
        result.decisions,
        result.currentByToken,
        result.genuineByToken,
        options.reviewLimit,
        reportSha256,
        ownerApprovedTokens,
      );
    }
  }
  return { ...result.aggregate, reportSha256, reviewAidsWritten };
}

function parseArguments(arguments_: string[]): ScanOriginalRecoveryOptions {
  let catalogPath = DEFAULT_CATALOG;
  let currentRoot = DEFAULT_CURRENT_ROOT;
  let genuineRoot = DEFAULT_GENUINE_ROOT;
  let outputDirectory = DEFAULT_OUTPUT;
  let workers = 4;
  let writeReport = false;
  let writeReview = false;
  let reviewLimit = 160;
  let stagingScanCount: number | undefined;
  let experimentalUnmatched = false;
  let ownerApproveConfirmedReplacements = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === "--catalog" && next) {
      catalogPath = resolve(next);
      index += 1;
    } else if (argument === "--current-root" && next) {
      currentRoot = resolve(next);
      index += 1;
    } else if (argument === "--genuine-root" && next) {
      genuineRoot = resolve(next);
      index += 1;
    } else if (argument === "--output" && next) {
      outputDirectory = resolve(next);
      index += 1;
    } else if (argument === "--workers" && next) {
      workers = Number(next);
      index += 1;
    } else if (argument === "--review-limit" && next) {
      reviewLimit = Number(next);
      index += 1;
    } else if (argument === "--staging-scan-count" && next) {
      stagingScanCount = Number(next);
      index += 1;
    } else if (argument === "--write-report") {
      writeReport = true;
    } else if (argument === "--write-review") {
      writeReview = true;
    } else if (argument === "--experimental-unmatched") {
      experimentalUnmatched = true;
    } else if (argument === "--owner-approve-confirmed-replacements") {
      ownerApproveConfirmedReplacements = true;
    } else {
      throw new ScanOriginalRecoveryError("invalid_argument");
    }
  }
  if (writeReview && !writeReport) throw new ScanOriginalRecoveryError("review_requires_report");
  if (ownerApproveConfirmedReplacements && !writeReport) {
    throw new ScanOriginalRecoveryError("owner_approval_requires_report");
  }
  if (!Number.isInteger(reviewLimit) || reviewLimit < 0 || reviewLimit > 500) {
    throw new ScanOriginalRecoveryError("invalid_review_limit");
  }
  if (stagingScanCount !== undefined && (!Number.isInteger(stagingScanCount) || stagingScanCount < 0)) {
    throw new ScanOriginalRecoveryError("invalid_staging_scan_count");
  }
  return {
    catalogPath,
    currentRoot,
    genuineRoot,
    outputDirectory,
    workers,
    writeReport,
    writeReview,
    reviewLimit,
    stagingScanCount,
    experimentalUnmatched,
    ownerApproveConfirmedReplacements,
  };
}

async function main(): Promise<void> {
  const aggregate = await runScanOriginalRecovery(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(aggregate)}\n`);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const code = error instanceof ScanOriginalRecoveryError
      ? error.code
      : "scan_original_recovery_failed";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
