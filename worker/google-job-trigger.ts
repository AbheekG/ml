export type GoogleJobTriggerConfig = {
  workloadIdentityProvider: string;
  projectId: string;
  region: string;
  jobName: string;
};

export type GoogleJobTriggerResult = {
  operationName: string | null;
};

export type GoogleJobTriggerErrorCode =
  | "google_trigger_not_configured"
  | "google_subject_token_invalid"
  | "google_subject_token_lifetime_unsupported"
  | "google_subject_token_not_yet_valid"
  | "google_subject_token_expired"
  | "google_subject_token_near_expiry"
  | "google_identity_exchange_bad_request"
  | "google_identity_exchange_unauthorized"
  | "google_identity_exchange_forbidden"
  | "google_identity_exchange_rate_limited"
  | "google_identity_exchange_server_error"
  | "google_identity_exchange_rejected"
  | "google_identity_exchange_invalid_response"
  | "google_job_trigger_rejected"
  | "google_job_trigger_invalid_response";

export class GoogleJobTriggerError extends Error {
  constructor(
    readonly code: GoogleJobTriggerErrorCode,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "GoogleJobTriggerError";
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const PROVIDER_PATTERN = /^\/\/iam\.googleapis\.com\/projects\/(\d+)\/locations\/global\/workloadIdentityPools\/([a-z0-9-]{4,32})\/providers\/([a-z0-9-]{4,32})$/u;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const REGION_PATTERN = /^[a-z]+-[a-z]+\d$/u;
const JOB_PATTERN = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_ACCESS_JWT_LENGTH = 32_768;
const MAX_SUBJECT_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const MIN_SUBJECT_TOKEN_REMAINING_SECONDS = 60;

export function validGoogleJobTriggerConfig(
  config: GoogleJobTriggerConfig,
): boolean {
  return PROVIDER_PATTERN.test(config.workloadIdentityProvider)
    && PROJECT_PATTERN.test(config.projectId)
    && REGION_PATTERN.test(config.region)
    && JOB_PATTERN.test(config.jobName);
}

function accessTokenFrom(value: unknown): string | null {
  if (
    typeof value !== "object"
    || value === null
    || !("access_token" in value)
    || typeof value.access_token !== "string"
    || value.access_token.length < 20
    || value.access_token.length > 16_384
  ) return null;
  return value.access_token;
}

function operationNameFrom(value: unknown): string | null | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("metadata" in value) && !("name" in value)) return undefined;
  if (!("name" in value) || value.name === undefined || value.name === null) return null;
  if (typeof value.name !== "string" || value.name.length > 2_000) return undefined;
  return value.name;
}

function decodeJwtPayload(accessJwt: string): Record<string, unknown> | null {
  if (accessJwt.length < 20 || accessJwt.length > MAX_ACCESS_JWT_LENGTH) return null;
  const segments = accessJwt.split(".");
  if (segments.length !== 3 || !segments.every((segment) => BASE64URL_PATTERN.test(segment))) {
    return null;
  }

  try {
    const payloadSegment = segments[1];
    if (!payloadSegment || payloadSegment.length % 4 === 1) return null;
    const padded = payloadSegment.replace(/-/gu, "+").replace(/_/gu, "/")
      .padEnd(Math.ceil(payloadSegment.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes)) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function integerTimestamp(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

export function validateGoogleWorkloadSubjectToken(
  accessJwt: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): void {
  const payload = decodeJwtPayload(accessJwt);
  const issuedAt = integerTimestamp(payload?.iat);
  const expiresAt = integerTimestamp(payload?.exp);
  const notBefore = payload?.nbf === undefined ? null : integerTimestamp(payload.nbf);
  if (
    !payload
    || issuedAt === null
    || expiresAt === null
    || (payload.nbf !== undefined && notBefore === null)
    || expiresAt <= issuedAt
  ) {
    throw new GoogleJobTriggerError("google_subject_token_invalid");
  }
  if (expiresAt - issuedAt > MAX_SUBJECT_TOKEN_LIFETIME_SECONDS) {
    throw new GoogleJobTriggerError("google_subject_token_lifetime_unsupported");
  }
  if (issuedAt > nowSeconds || (notBefore !== null && notBefore > nowSeconds)) {
    throw new GoogleJobTriggerError("google_subject_token_not_yet_valid");
  }
  if (expiresAt <= nowSeconds) {
    throw new GoogleJobTriggerError("google_subject_token_expired");
  }
  if (expiresAt - nowSeconds < MIN_SUBJECT_TOKEN_REMAINING_SECONDS) {
    throw new GoogleJobTriggerError("google_subject_token_near_expiry");
  }
}

function identityExchangeRejectionCode(status: number): GoogleJobTriggerErrorCode {
  if (status === 400) return "google_identity_exchange_bad_request";
  if (status === 401) return "google_identity_exchange_unauthorized";
  if (status === 403) return "google_identity_exchange_forbidden";
  if (status === 429) return "google_identity_exchange_rate_limited";
  if (status >= 500 && status <= 599) return "google_identity_exchange_server_error";
  return "google_identity_exchange_rejected";
}

export async function exchangeAccessJwtForGoogleToken(
  workloadIdentityProvider: string,
  accessJwt: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  if (!PROVIDER_PATTERN.test(workloadIdentityProvider) || accessJwt.length < 20) {
    throw new GoogleJobTriggerError("google_trigger_not_configured");
  }
  validateGoogleWorkloadSubjectToken(accessJwt);
  const response = await fetcher("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      audience: workloadIdentityProvider,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      subject_token: accessJwt,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    }).toString(),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleJobTriggerError(identityExchangeRejectionCode(response.status), response.status);
  }
  const token = accessTokenFrom(await response.json().catch(() => null));
  if (!token) {
    throw new GoogleJobTriggerError("google_identity_exchange_invalid_response", response.status);
  }
  return token;
}

export async function triggerGoogleCloudRunJob(
  config: GoogleJobTriggerConfig,
  accessJwt: string,
  fetcher: Fetcher = fetch,
): Promise<GoogleJobTriggerResult> {
  if (!validGoogleJobTriggerConfig(config)) {
    throw new GoogleJobTriggerError("google_trigger_not_configured");
  }
  const accessToken = await exchangeAccessJwtForGoogleToken(
    config.workloadIdentityProvider,
    accessJwt,
    fetcher,
  );
  const response = await fetcher(
    `https://${config.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${config.projectId}/jobs/${config.jobName}:run`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleJobTriggerError("google_job_trigger_rejected", response.status);
  }
  const operationName = operationNameFrom(await response.json().catch(() => null));
  if (operationName === undefined) {
    throw new GoogleJobTriggerError("google_job_trigger_invalid_response", response.status);
  }
  return { operationName };
}
