from __future__ import annotations

from dataclasses import asdict, dataclass
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
    source_download_url: str
    derivative_upload_url: str


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


def _job_scoped_https_url(value: object, field: str) -> str:
    if not isinstance(value, str):
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
    return value


def parse_hosted_processing_request(
    payload: object,
    *,
    policy: ProcessingPolicy = ProcessingPolicy(),
) -> HostedProcessingRequest:
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
    return HostedProcessingRequest(
        job_id=job_id,
        policy_id=policy_id,
        source_sha256=_sha256(payload.get("sourceSha256")),
        source_byte_size=source_byte_size,
        source_download_url=_job_scoped_https_url(payload.get("sourceDownloadUrl"), "source_download_url"),
        derivative_upload_url=_job_scoped_https_url(payload.get("derivativeUploadUrl"), "derivative_upload_url"),
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
    if uses_derivative != (preparation.derivative is not None):
        raise HostedContractError("invalid_processing_result_media")
    if uses_derivative and (
        preparation.validation is None or not preparation.validation.accepted
    ):
        raise HostedContractError("unverified_processing_derivative")

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
