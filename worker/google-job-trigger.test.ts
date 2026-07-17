import { describe, expect, it, vi } from "vitest";
import {
  GoogleJobTriggerError,
  exchangeAccessJwtForGoogleToken,
  triggerGoogleCloudRunJob,
  validateGoogleWorkloadSubjectToken,
  validGoogleJobTriggerConfig,
} from "./google-job-trigger";

const config = {
  workloadIdentityProvider: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/music-library/providers/cloudflare-access",
  projectId: "music-library-audio-staging",
  region: "asia-south1",
  jobName: "music-audio-processor",
};

const encodeJwtSegment = (value: unknown) => btoa(JSON.stringify(value))
  .replace(/\+/gu, "-")
  .replace(/\//gu, "_")
  .replace(/=+$/gu, "");

function accessJwt(claims?: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1_000);
  return [
    encodeJwtSegment({ alg: "RS256", typ: "JWT" }),
    encodeJwtSegment(claims ?? { iat: now - 60, nbf: now - 60, exp: now + 3_600 }),
    "signature",
  ].join(".");
}

describe("Google Cloud Run keyless trigger", () => {
  it("accepts only bounded fixed-resource configuration", () => {
    expect(validGoogleJobTriggerConfig(config)).toBe(true);
    expect(validGoogleJobTriggerConfig({ ...config, region: "example.invalid/path" })).toBe(false);
    expect(validGoogleJobTriggerConfig({ ...config, workloadIdentityProvider: "projects/123" })).toBe(false);
  });

  it("exchanges the Access assertion without placing it in a URL or loggable error", async () => {
    const assertion = accessJwt();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("subject_token")).toBe(assertion);
      expect(body.get("audience")).toBe(config.workloadIdentityProvider);
      return Response.json({ access_token: "google-access-token-long-enough" });
    });
    await expect(exchangeAccessJwtForGoogleToken(
      config.workloadIdentityProvider,
      assertion,
      fetcher,
    )).resolves.toBe("google-access-token-long-enough");
  });

  it("rejects Google-incompatible assertion timing before contacting STS", async () => {
    const now = 2_000_000_000;
    const cases = [
      {
        token: "header.payload.signature",
        code: "google_subject_token_invalid",
      },
      {
        token: accessJwt({ iat: now - 60, exp: now + 86_341 }),
        code: "google_subject_token_lifetime_unsupported",
      },
      {
        token: accessJwt({ iat: now + 1, nbf: now + 1, exp: now + 3_601 }),
        code: "google_subject_token_not_yet_valid",
      },
      {
        token: accessJwt({ iat: now - 3_600, exp: now }),
        code: "google_subject_token_expired",
      },
      {
        token: accessJwt({ iat: now - 3_600, exp: now + 59 }),
        code: "google_subject_token_near_expiry",
      },
    ];

    for (const testCase of cases) {
      expect(() => validateGoogleWorkloadSubjectToken(testCase.token, now))
        .toThrow(expect.objectContaining({ code: testCase.code }));
    }

    expect(() => validateGoogleWorkloadSubjectToken(
      accessJwt({ iat: now - 60, nbf: now, exp: now + 86_340 }),
      now,
    )).not.toThrow();

    const fetcher = vi.fn(async () => Response.json({ access_token: "unused-access-token-value" }));
    await expect(exchangeAccessJwtForGoogleToken(
      config.workloadIdentityProvider,
      accessJwt({ iat: now - 60, exp: now + 86_341 }),
      fetcher,
    )).rejects.toMatchObject({ code: "google_subject_token_lifetime_unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the short-lived token to request the fixed Job with an explicit empty body", async () => {
    const assertion = accessJwt();
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
      assertion,
      fetcher,
    )).resolves.toEqual({ operationName: "namespaces/project/operations/operation-1" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("classifies rejection status without reflecting Google response bodies", async () => {
    const cases = [
      [400, "google_identity_exchange_bad_request"],
      [401, "google_identity_exchange_unauthorized"],
      [403, "google_identity_exchange_forbidden"],
      [429, "google_identity_exchange_rate_limited"],
      [503, "google_identity_exchange_server_error"],
      [418, "google_identity_exchange_rejected"],
    ] as const;

    for (const [status, code] of cases) {
      const fetcher = vi.fn(async () => new Response(
        "private upstream diagnostic that must not be logged",
        { status },
      ));
      const error = await exchangeAccessJwtForGoogleToken(
        config.workloadIdentityProvider,
        accessJwt(),
        fetcher,
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(GoogleJobTriggerError);
      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toContain("private upstream diagnostic");
    }
  });

  it("rejects malformed successful responses", async () => {
    await expect(exchangeAccessJwtForGoogleToken(
      config.workloadIdentityProvider,
      accessJwt(),
      async () => Response.json({ access_token: 42 }),
    )).rejects.toMatchObject({ code: "google_identity_exchange_invalid_response" });
  });
});
