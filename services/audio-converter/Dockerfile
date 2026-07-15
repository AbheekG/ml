FROM python:3.13.14-slim-bookworm@sha256:9d7f287598e1a5a978c015ee176d8216435aaf335ed69ac3c38dd1bbb10e8d64 AS runtime-base

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ffmpeg=7:5.1.9-0+deb12u1 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 audio-processor \
    && useradd \
        --uid 10001 \
        --gid 10001 \
        --home-dir /nonexistent \
        --no-create-home \
        --shell /usr/sbin/nologin \
        audio-processor \
    && install \
        --directory \
        --mode 0700 \
        --owner 10001 \
        --group 10001 \
        /var/lib/music-audio

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/music-audio

COPY --chown=10001:10001 audio_converter /opt/music-audio/audio_converter

USER 10001:10001
WORKDIR /var/lib/music-audio

FROM runtime-base AS verification

COPY --chown=10001:10001 scripts/verify_runtime_fixture.py /opt/music-audio/verify_runtime_fixture.py

ENTRYPOINT ["python", "/opt/music-audio/verify_runtime_fixture.py"]

FROM runtime-base AS runtime

ENTRYPOINT ["python", "-m", "audio_converter.hosted_entrypoint"]
