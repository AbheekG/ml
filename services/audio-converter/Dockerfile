FROM python:3.13.14-slim-trixie@sha256:bffeb7bd6a85767587059c6ba23e1e9122078e3aa3fa836099171b9bb5a9bb00 AS runtime-base

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ffmpeg=7:7.1.5-0+deb13u1 \
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
