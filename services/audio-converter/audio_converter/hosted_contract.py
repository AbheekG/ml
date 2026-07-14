from __future__ import annotations

from dataclasses import asdict, dataclass, field as dataclass_field
from datetime import datetime
from typing import Mapping
from urllib.parse import urlparse

from .models import ProcessingPolicy
from .service import PreparationResult


HOSTED_CONTRACT_SCHEMA_VERSION = 1
FINAL_STATUSES = {
    "original_is_playback",
    "created_derivative",
    "verified_existing_derivative",
    "candidate_discarded_original_is_playback",
}


class HostedContractError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class HostedProcessingRequest:
    job_id: str
    policy_id: str
    source_sha256: str
    source_byte_size: int
    source_download_url: str = dataclass_field(repr=False)
    derivative_upload_url: str = dataclass_field(repr=False)


@dataclass(frozen=True)
class HostedJobClaim:
    lease_expires_at: datetime
    processing_request: HostedProcessingRequest
    result_url: str = dataclass_field(repr=False)
    failure_url: str = dataclass_field(repr=False)


def _required_string(payload: Mapping[str, object], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise HostedContractError(f"invalid_{key}")
    return value


def _sha256(value: object) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or value != value.lower()
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise HostedContractError("invalid_source_sha256")
    return value


def _job_scoped_https_url(
    value: object,
    field: str,
    allowed_transfer_origins: frozenset[str],
) -> str:
    if not isinstance(value, str) or len(value) > 4096:
        raise HostedContractError(f"invalid_{field}")
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise HostedContractError(f"invalid_{field}")
    origin = _url_origin(value)
    if origin not in allowed_transfer_origins:
        raise HostedContractError(f"untrusted_{field}")
    return value


def _transfer_resource_identity(value: str) -> tuple[str, str, str]:
    parsed = urlparse(value)
    return parsed.scheme, parsed.netloc, parsed.path


def _url_origin(value: str) -> str:
    parsed = urlparse(value)
    return f"{parsed.scheme.casefold()}://{parsed.netloc.casefold()}"


def _lease_expiration(value: object) -> datetime:
    if (
        not isinstance(value, str)
        or not 20 <= len(value) <= 64
        or "T" not in value
        or not value.endswith("Z")
    ):
        raise HostedContractError("invalid_lease_expires_at")
    try:
        parsed = datetime.fromisoformat(f"{value[:-1]}+00:00")
    except ValueError as error:
        raise HostedContractError("invalid_lease_expires_at") from error
    if parsed.utcoffset() is None:
        raise HostedContractError("invalid_lease_expires_at")
    return parsed


def parse_hosted_processing_request(
    payload: object,
    *,
    allowed_transfer_origins: frozenset[str],
    policy: ProcessingPolicy = ProcessingPolicy(),
) -> HostedProcessingRequest:
    if not allowed_transfer_origins:
        raise HostedContractError("transfer_origin_allowlist_required")
    if not isinstance(payload, dict):
        raise HostedContractError("invalid_processing_request")
    allowed_keys = {
        "schemaVersion",
        "jobId",
        "policyId",
        "sourceSha256",
        "sourceByteSize",
        "sourceDownloadUrl",
        "derivativeUploadUrl",
    }
    if set(payload) != allowed_keys:
        raise HostedContractError("invalid_processing_request_fields")
    if payload.get("schemaVersion") != HOSTED_CONTRACT_SCHEMA_VERSION:
        raise HostedContractError("unsupported_processing_schema")
    job_id = _required_string(payload, "jobId")
    if len(job_id) > 100 or any(
        character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
        for character in job_id
    ):
        raise HostedContractError("invalid_jobId")
    policy_id = _required_string(payload, "policyId")
    if policy_id != policy.policy_id:
        raise HostedContractError("unsupported_processing_policy")
    source_byte_size = payload.get("sourceByteSize")
    if not isinstance(source_byte_size, int) or isinstance(source_byte_size, bool) or source_byte_size <= 0:
        raise HostedContractError("invalid_source_byte_size")
    source_download_url = _job_scoped_https_url(
        payload.get("sourceDownloadUrl"),
        "source_download_url",
        allowed_transfer_origins,
    )
    derivative_upload_url = _job_scoped_https_url(
        payload.get("derivativeUploadUrl"),
        "derivative_upload_url",
        allowed_transfer_origins,
    )
    if _transfer_resource_identity(source_download_url) == _transfer_resource_identity(
        derivative_upload_url
    ):
        raise HostedContractError("processing_transfer_urls_must_differ")
    return HostedProcessingRequest(
        job_id=job_id,
        policy_id=policy_id,
        source_sha256=_sha256(payload.get("sourceSha256")),
        source_byte_size=source_byte_size,
        source_download_url=source_download_url,
        derivative_upload_url=derivative_upload_url,
    )


def parse_hosted_job_claim(
    payload: object,
    *,
    allowed_transfer_origins: frozenset[str],
    expected_callback_origin: str,
    policy: ProcessingPolicy = ProcessingPolicy(),
) -> HostedJobClaim:
    if not allowed_transfer_origins:
        raise HostedContractError("transfer_origin_allowlist_required")
    if not isinstance(payload, dict):
        raise HostedContractError("invalid_job_claim")
    allowed_keys = {
        "schemaVersion",
        "leaseExpiresAt",
        "processingRequest",
        "resultUrl",
        "failureUrl",
    }
    if set(payload) != allowed_keys:
        raise HostedContractError("invalid_job_claim_fields")
    if payload.get("schemaVersion") != HOSTED_CONTRACT_SCHEMA_VERSION:
        raise HostedContractError("unsupported_job_claim_schema")

    processing_request = parse_hosted_processing_request(
        payload.get("processingRequest"),
        allowed_transfer_origins=allowed_transfer_origins,
        policy=policy,
    )
    result_url = _job_scoped_https_url(
        payload.get("resultUrl"),
        "result_url",
        allowed_transfer_origins,
    )
    failure_url = _job_scoped_https_url(
        payload.get("failureUrl"),
        "failure_url",
        allowed_transfer_origins,
    )
    if (
        _url_origin(result_url) != expected_callback_origin
        or _url_origin(failure_url) != expected_callback_origin
    ):
        raise HostedContractError("unexpected_callback_origin")

    resource_identities = {
        _transfer_resource_identity(processing_request.source_download_url),
        _transfer_resource_identity(processing_request.derivative_upload_url),
        _transfer_resource_identity(result_url),
        _transfer_resource_identity(failure_url),
    }
    if len(resource_identities) != 4:
        raise HostedContractError("job_claim_urls_must_differ")

    return HostedJobClaim(
        lease_expires_at=_lease_expiration(payload.get("leaseExpiresAt")),
        processing_request=processing_request,
        result_url=result_url,
        failure_url=failure_url,
    )


def build_hosted_processing_result(
    request: HostedProcessingRequest,
    preparation: PreparationResult,
) -> dict[str, object]:
    if preparation.status not in FINAL_STATUSES:
        raise HostedContractError("processing_result_not_final")
    if preparation.original.sha256 != request.source_sha256:
        raise HostedContractError("processed_source_hash_mismatch")
    if preparation.original.byte_size != request.source_byte_size:
        raise HostedContractError("processed_source_size_mismatch")

    uses_derivative = preparation.status in {
        "created_derivative",
        "verified_existing_derivative",
    }
    discarded_candidate = (
        preparation.status == "candidate_discarded_original_is_playback"
    )
    if uses_derivative != (preparation.derivative is not None):
        raise HostedContractError("invalid_processing_result_media")
    if uses_derivative and (
        preparation.validation is None or not preparation.validation.accepted
    ):
        raise HostedContractError("unverified_processing_derivative")
    if discarded_candidate and (
        preparation.validation is None
        or preparation.validation.accepted
        or preparation.validation.reason != "oversized_mp3_saving_not_material"
    ):
        raise HostedContractError("invalid_discarded_processing_candidate")
    if not uses_derivative and not discarded_candidate and preparation.validation is not None:
        raise HostedContractError("unexpected_processing_validation")

    return {
        "schemaVersion": HOSTED_CONTRACT_SCHEMA_VERSION,
        "jobId": request.job_id,
        "policyId": request.policy_id,
        "status": preparation.status,
        "playbackKind": "derivative" if uses_derivative else "original",
        "original": asdict(preparation.original),
        "derivative": asdict(preparation.derivative) if preparation.derivative else None,
        "decision": asdict(preparation.decision),
        "validation": asdict(preparation.validation) if preparation.validation else None,
    }
