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

export async function exchangeAccessJwtForGoogleToken(
  workloadIdentityProvider: string,
  accessJwt: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  if (!PROVIDER_PATTERN.test(workloadIdentityProvider) || accessJwt.length < 20) {
    throw new GoogleJobTriggerError("google_trigger_not_configured");
  }
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
    throw new GoogleJobTriggerError("google_identity_exchange_rejected", response.status);
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
