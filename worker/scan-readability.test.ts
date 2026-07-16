import { describe, expect, it } from "vitest";
import {
  createScanReadabilityDerivative,
  MAX_SCAN_IMAGE_BINDING_BYTES,
  scanReadabilityObjectKey,
  ScanReadabilityError,
} from "./scan-readability";

function fakeImages(options: {
  sourceWidth?: number;
  sourceHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  rejectSource?: boolean;
} = {}): Pick<ImagesBinding, "info" | "input"> {
  let infoCalls = 0;
  const output = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  return {
    async info() {
      infoCalls += 1;
      if (infoCalls === 1) {
        if (options.rejectSource) throw new Error("bad image");
        return {
          format: "image/png",
          fileSize: 8,
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
      const transformer = {
        transform() {
          return transformer;
        },
        async output() {
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
    expect(scanReadabilityObjectKey("media-1")).toBe("scans/readability/media-1.jpg");
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
});
