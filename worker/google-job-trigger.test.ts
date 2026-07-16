import { describe, expect, it, vi } from "vitest";
import {
  GoogleJobTriggerError,
  exchangeAccessJwtForGoogleToken,
  triggerGoogleCloudRunJob,
  validGoogleJobTriggerConfig,
} from "./google-job-trigger";

const config = {
  workloadIdentityProvider: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/music-library/providers/cloudflare-access",
  projectId: "music-library-audio-staging",
  region: "asia-south1",
  jobName: "music-audio-processor",
};

describe("Google Cloud Run keyless trigger", () => {
  it("accepts only bounded fixed-resource configuration", () => {
    expect(validGoogleJobTriggerConfig(config)).toBe(true);
    expect(validGoogleJobTriggerConfig({ ...config, region: "example.invalid/path" })).toBe(false);
    expect(validGoogleJobTriggerConfig({ ...config, workloadIdentityProvider: "projects/123" })).toBe(false);
  });

  it("exchanges the Access assertion without placing it in a URL or loggable error", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("subject_token")).toBe("header.payload.signature");
      expect(body.get("audience")).toBe(config.workloadIdentityProvider);
      return Response.json({ access_token: "google-access-token-long-enough" });
    });
    await expect(exchangeAccessJwtForGoogleToken(
      config.workloadIdentityProvider,
      "header.payload.signature",
      fetcher,
    )).resolves.toBe("google-access-token-long-enough");
  });

  it("uses the short-lived token to request the fixed Job with an explicit empty body", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://sts.googleapis.com/v1/token") {
        return Response.json({ access_token: "google-access-token-long-enough" });
      }
      expect(String(input)).toBe("https://asia-south1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/music-library-audio-staging/jobs/music-audio-processor:run");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer google-access-token-long-enough",
      );
      expect(init?.body).toBe("{}");
      return Response.json({ name: "namespaces/project/operations/operation-1", metadata: {} });
    });
    await expect(triggerGoogleCloudRunJob(
      config,
      "header.payload.signature",
      fetcher,
    )).resolves.toEqual({ operationName: "namespaces/project/operations/operation-1" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns bounded error codes without reflecting Google response bodies", async () => {
    const fetcher = vi.fn(async () => new Response(
      "private upstream diagnostic that must not be logged",
      { status: 403 },
    ));
    const error = await exchangeAccessJwtForGoogleToken(
      config.workloadIdentityProvider,
      "header.payload.signature",
      fetcher,
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(GoogleJobTriggerError);
    expect(error).toMatchObject({ code: "google_identity_exchange_rejected", status: 403 });
    expect(String(error)).not.toContain("private upstream diagnostic");
  });

  it("rejects malformed successful responses", async () => {
    await expect(exchangeAccessJwtForGoogleToken(
      config.workloadIdentityProvider,
      "header.payload.signature",
      async () => Response.json({ access_token: 42 }),
    )).rejects.toMatchObject({ code: "google_identity_exchange_invalid_response" });
  });
});
