import { describe, expect, it } from "vitest";
import {
  createScanReadabilityDerivative,
  MAX_SCAN_IMAGE_BINDING_BYTES,
  scanCandidateHasMaterialSavings,
  scanJpegIsDirectlyUsable,
  stripScanJpegMetadata,
  scanReadabilityObjectKey,
  SCAN_OPTIONAL_CANDIDATE_MIN_SOURCE_BYTES,
  selectScanReadabilityRepresentation,
  ScanReadabilityError,
} from "./scan-readability";

function fakeImages(options: {
  sourceFormat?: string;
  sourceFileSize?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  outputBytes?: number;
  outputWidth?: number;
  outputHeight?: number;
  outputMetadata?: boolean;
  rejectSource?: boolean;
  rejectOutput?: boolean;
  onInput?: () => void;
} = {}): Pick<ImagesBinding, "info" | "input"> {
  let infoCalls = 0;
  const output = safeJpeg(options.outputBytes ?? 128, {
    width: options.outputWidth ?? 2400,
    height: options.outputHeight ?? 1350,
    metadata: options.outputMetadata,
  });
  return {
    async info() {
      infoCalls += 1;
      if (infoCalls === 1) {
        if (options.rejectSource) throw new Error("bad image");
        return {
          format: options.sourceFormat ?? "image/png",
          fileSize: options.sourceFileSize ?? 4,
          width: options.sourceWidth ?? 3200,
          height: options.sourceHeight ?? 1800,
        };
      }
      return {
        format: "image/jpeg",
        fileSize: output.byteLength,
        width: options.outputWidth ?? 2400,
        height: options.outputHeight ?? 1350,
      };
    },
    input() {
      options.onInput?.();
      const transformer = {
        transform() {
          return transformer;
        },
        async output() {
          if (options.rejectOutput) throw new Error("conversion failed");
          return {
            response: () => new Response(output),
            contentType: () => "image/jpeg",
            image: () => new Blob([output]).stream(),
          };
        },
        draw() {
          return transformer;
        },
      };
      return transformer;
    },
  } as Pick<ImagesBinding, "info" | "input">;
}

function safeJpeg(
  totalBytes = 128,
  options: {
    width?: number;
    height?: number;
    metadata?: boolean;
    progressive?: boolean;
  } = {},
): Uint8Array {
  const width = options.width ?? 1200;
  const height = options.height ?? 900;
  const header = [
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ...(options.metadata ? [0xff, 0xe1, 0x00, 0x04, 0x00, 0x00] : []),
    0xff, options.progressive ? 0xc2 : 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c,
    0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
  ];
  const bytes = new Uint8Array(Math.max(totalBytes, header.length + 2));
  bytes.set(header);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return bytes;
}

describe("Scan readability derivatives", () => {
  it("fully decodes, bounds, and fingerprints a private JPEG derivative", async () => {
    const derivative = await createScanReadabilityDerivative(
      fakeImages(),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(derivative).toMatchObject({
      mimeType: "image/jpeg",
      width: 2400,
      height: 1350,
      policyId: "scan-jpeg-v1-2400-q85",
    });
    expect(derivative.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(scanReadabilityObjectKey("media-1")).toBe("scans/readability-v2/media-1.jpg");
  });

  it("strips metadata emitted by the image service before hashing the derivative", async () => {
    const derivative = await createScanReadabilityDerivative(
      fakeImages({ outputMetadata: true }),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(derivative.bytes.byteLength).toBe(128 - 6);
    expect(scanJpegIsDirectlyUsable(
      derivative.bytes,
      { width: derivative.width, height: derivative.height },
    )).toBe(true);
  });

  it("rejects undecodable and over-area source images", async () => {
    await expect(createScanReadabilityDerivative(
      fakeImages({ rejectSource: true }),
      new Uint8Array([1]),
    )).rejects.toEqual(expect.objectContaining({ code: "scan_image_decode_failed" }));

    await expect(createScanReadabilityDerivative(
      fakeImages({ sourceWidth: 10_001, sourceHeight: 10_000 }),
      new Uint8Array([1]),
    )).rejects.toEqual(expect.objectContaining({ code: "scan_image_dimensions_invalid" }));
  });

  it("rejects input beyond the binding limit before decoding", async () => {
    await expect(createScanReadabilityDerivative(
      fakeImages(),
      new Uint8Array(MAX_SCAN_IMAGE_BINDING_BYTES + 1),
    )).rejects.toBeInstanceOf(ScanReadabilityError);
  });

  it("selects a clean bounded JPEG directly without invoking lossy encoding", async () => {
    const source = safeJpeg();
    let inputCalls = 0;
    const selection = await selectScanReadabilityRepresentation(
      fakeImages({
        sourceFormat: "image/jpeg",
        sourceFileSize: source.byteLength,
        sourceWidth: 1200,
        sourceHeight: 900,
        onInput: () => { inputCalls += 1; },
      }),
      source,
      "image/jpeg",
    );
    expect(selection).toMatchObject({
      representationKind: "source",
      selectionBasis: "direct_safe_source",
      sourceWidth: 1200,
      sourceHeight: 900,
      candidateByteSize: null,
      derivative: null,
      policyId: "scan-readability-selection-v2",
    });
    expect(inputCalls).toBe(0);
  });

  it("accepts conventional progressive JPEGs and rejects metadata after scan data", () => {
    const progressive = safeJpeg(128, { progressive: true });
    expect(scanJpegIsDirectlyUsable(progressive, { width: 1200, height: 900 }))
      .toBe(true);
    const hiddenMetadata = progressive.slice();
    hiddenMetadata.set([0xff, 0xe1, 0x00, 0x04, 0x00, 0x00], hiddenMetadata.length - 8);
    expect(scanJpegIsDirectlyUsable(hiddenMetadata, { width: 1200, height: 900 }))
      .toBe(false);
  });

  it("losslessly removes pre-scan metadata while retaining decoded JPEG content", () => {
    const withMetadata = safeJpeg(256, { metadata: true });
    const stripped = stripScanJpegMetadata(withMetadata);
    expect(stripped.byteLength).toBe(withMetadata.byteLength - 6);
    expect(scanJpegIsDirectlyUsable(stripped, { width: 1200, height: 900 })).toBe(true);
    expect([...stripped.slice(-2)]).toEqual([0xff, 0xd9]);
  });

  it.each([
    ["PNG format", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", 1200, 900],
    ["oversized dimensions", safeJpeg(128, { width: 2500 }), "image/jpeg", 2500, 900],
    ["metadata or encoded orientation", safeJpeg(128, { metadata: true }), "image/jpeg", 1200, 900],
  ] as const)("requires normalization for %s", async (
    _label,
    source,
    sourceFormat,
    sourceWidth,
    sourceHeight,
  ) => {
    const selection = await selectScanReadabilityRepresentation(
      fakeImages({
        sourceFormat,
        sourceFileSize: source.byteLength,
        sourceWidth,
        sourceHeight,
      }),
      source,
      sourceFormat,
    );
    expect(selection.representationKind).toBe("derivative");
    expect(selection.selectionBasis).toBe("required_normalization");
    expect(selection.derivative).not.toBeNull();
  });

  it("retains an optional candidate only for combined material savings", async () => {
    const source = safeJpeg(SCAN_OPTIONAL_CANDIDATE_MIN_SOURCE_BYTES + 400_000);
    const selection = await selectScanReadabilityRepresentation(
      fakeImages({
        sourceFormat: "image/jpeg",
        sourceFileSize: source.byteLength,
        sourceWidth: 1200,
        sourceHeight: 900,
        outputBytes: 700_000,
      }),
      source,
      "image/jpeg",
    );
    expect(selection.representationKind).toBe("derivative");
    expect(selection.selectionBasis).toBe("optional_material_savings");
    expect(selection.candidateByteSize).toBe(700_000);
  });

  it("enforces both material-savings thresholds including exact boundaries", () => {
    expect(scanCandidateHasMaterialSavings(1_310_720, 1_048_576)).toBe(true);
    expect(scanCandidateHasMaterialSavings(2_000_000, 1_650_000)).toBe(false);
    expect(scanCandidateHasMaterialSavings(1_500_000, 1_237_857)).toBe(false);
  });

  it.each([
    ["insufficient absolute savings", 1_250_000],
    ["a candidate larger than its source", 1_600_000],
  ])("keeps the safe source when optional encoding has %s", async (_label, outputBytes) => {
    const source = safeJpeg(SCAN_OPTIONAL_CANDIDATE_MIN_SOURCE_BYTES + 400_000);
    const selection = await selectScanReadabilityRepresentation(
      fakeImages({
        sourceFormat: "image/jpeg",
        sourceFileSize: source.byteLength,
        sourceWidth: 1200,
        sourceHeight: 900,
        outputBytes,
      }),
      source,
      "image/jpeg",
    );
    expect(selection.representationKind).toBe("source");
    expect(selection.selectionBasis).toBe("direct_safe_source");
    expect(selection.candidateByteSize).toBe(outputBytes);
    expect(selection.derivative).toBeNull();
  });

  it("fails required normalization but safely ignores optional candidate failure", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await expect(selectScanReadabilityRepresentation(
      fakeImages({
        sourceFormat: "image/png",
        sourceFileSize: png.byteLength,
        sourceWidth: 1200,
        sourceHeight: 900,
        rejectOutput: true,
      }),
      png,
      "image/png",
    )).rejects.toMatchObject({ code: "scan_readability_generation_failed" });

    const jpeg = safeJpeg(SCAN_OPTIONAL_CANDIDATE_MIN_SOURCE_BYTES + 1);
    await expect(selectScanReadabilityRepresentation(
      fakeImages({
        sourceFormat: "image/jpeg",
        sourceFileSize: jpeg.byteLength,
        sourceWidth: 1200,
        sourceHeight: 900,
        rejectOutput: true,
      }),
      jpeg,
      "image/jpeg",
    )).resolves.toMatchObject({
      representationKind: "source",
      selectionBasis: "direct_safe_source",
      candidateByteSize: null,
    });
  });
});
