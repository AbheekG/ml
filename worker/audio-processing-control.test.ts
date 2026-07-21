import { describe, expect, it } from "vitest";
import {
  audioProcessingDerivativeObjectKey,
  buildAudioProcessingCapabilityUrl,
  createAudioProcessingCapabilityToken,
  createAudioProcessingLeaseToken,
  hashAudioProcessingToken,
  normalizeProcessorTransferOrigin,
  parseAudioProcessingFailure,
  parseBearerToken,
  processorTokenMatches,
  verifyAudioProcessingCapabilityToken,
} from "./audio-processing-control";

describe("audio processing control-plane helpers", () => {
  it("creates opaque URL-safe lease tokens and stores only their hashes", async () => {
    const token = createAudioProcessingLeaseToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await hashAudioProcessingToken(token)).toMatch(/^[a-f0-9]{64}$/u);
    expect(await processorTokenMatches(token, token)).toBe(true);
    expect(await processorTokenMatches(`${token}x`, token)).toBe(false);
    expect(await processorTokenMatches(null, token)).toBe(false);
  });

  it("requires an exact bearer header and strict safe failure/retry bodies", () => {
    expect(parseBearerToken("Bearer secret-token")).toBe("secret-token");
    expect(parseBearerToken("bearer secret-token")).toBeNull();
    expect(parseBearerToken("Bearer token with spaces")).toBeNull();
    expect(parseAudioProcessingFailure({ errorCode: "source_decode_failed" }))
      .toEqual({ errorCode: "source_decode_failed" });
    expect(parseAudioProcessingFailure({ errorCode: "Private file failed" })).toBeNull();
    expect(parseAudioProcessingFailure({ errorCode: "safe", detail: "private" })).toBeNull();
  });

  it("accepts only an explicit HTTPS origin and creates distinct scoped resources", () => {
    const origin = normalizeProcessorTransferOrigin("https://app.example.invalid");
    expect(origin).toBe("https://app.example.invalid");
    expect(normalizeProcessorTransferOrigin("http://app.example.invalid")).toBeNull();
    expect(normalizeProcessorTransferOrigin("https://app.example.invalid/path")).toBeNull();
    expect(normalizeProcessorTransferOrigin("https://user@app.example.invalid")).toBeNull();

    const source = buildAudioProcessingCapabilityUrl(origin!, "job-1", "source");
    const derivative = buildAudioProcessingCapabilityUrl(
      origin!, "job-1", "derivative",
    );
    expect(source).toBe(
      "https://app.example.invalid/api/processing/jobs/job-1/source",
    );
    expect(derivative).not.toBe(source);
    expect(source).not.toContain("recordings/");
  });

  it("cryptographically prevents changing one capability into another operation", async () => {
    const lease = createAudioProcessingLeaseToken();
    const processor = "processor-test-token-with-at-least-32-characters";
    const source = await createAudioProcessingCapabilityToken(
      lease, "job-1", 2, "source", processor,
    );
    const derivative = await createAudioProcessingCapabilityToken(
      lease, "job-1", 2, "derivative", processor,
    );
    expect(source).not.toBe(derivative);
    expect(await verifyAudioProcessingCapabilityToken(
      source, "job-1", 2, "source", processor,
    )).toBe(lease);
    expect(await verifyAudioProcessingCapabilityToken(
      source, "job-1", 2, "derivative", processor,
    )).toBeNull();
    expect(await verifyAudioProcessingCapabilityToken(
      source, "job-1", 3, "source", processor,
    )).toBeNull();
  });

  it("derives one immutable private object key per safe job attempt", () => {
    expect(audioProcessingDerivativeObjectKey("job_1-safe", 3))
      .toBe("recordings/playback/pending/job_1-safe/attempt-3.mp3");
    expect(audioProcessingDerivativeObjectKey("unsafe/job", 1)).toBeNull();
    expect(audioProcessingDerivativeObjectKey("job", 0)).toBeNull();
  });
});
