# syntax=docker/dockerfile:1
ARG KLOCGIT_IMAGE_TARGET
FROM rust:1.90-bookworm AS build
WORKDIR /source
RUN --mount=type=secret,id=proxy_ca \
    certificate=/etc/ssl/certs/ca-certificates.crt; \
    if [ -f /run/secrets/proxy_ca ]; then certificate=/run/secrets/proxy_ca; fi; \
    apt-get -o Acquire::https::CaInfo="$certificate" update && \
    apt-get -o Acquire::https::CaInfo="$certificate" install -y --no-install-recommends libssl-dev pkg-config cmake && \
    rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY crates/engine ./crates/engine
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/proxy_ca; fi; \
    cargo build --release --locked -p klocgit-engine --bin klocgit-host --bin klocgit-engine

FROM python:3.12-slim-bookworm AS analysis
RUN --mount=type=secret,id=proxy_ca \
    certificate=/etc/ssl/certs/ca-certificates.crt; \
    if [ -f /run/secrets/proxy_ca ]; then certificate=/run/secrets/proxy_ca; fi; \
    apt-get -o Acquire::https::CaInfo="$certificate" update && \
    apt-get -o Acquire::https::CaInfo="$certificate" install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /source/target/release/klocgit-host /usr/local/bin/klocgit-host
COPY --from=build /source/target/release/klocgit-engine /usr/local/bin/klocgit-engine
COPY crates/engine/container-entrypoint.sh /usr/local/bin/container-entrypoint
ENV KLOCGIT_HOST_PORT=43191
ENTRYPOINT ["/bin/sh", "/usr/local/bin/container-entrypoint"]

FROM node:24-bookworm-slim AS node
FROM golang:1.23-bookworm AS go
FROM analysis AS evaluation
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin"
RUN --mount=type=secret,id=proxy_ca \
    certificate=/etc/ssl/certs/ca-certificates.crt; \
    if [ -f /run/secrets/proxy_ca ]; then certificate=/run/secrets/proxy_ca; fi; \
    apt-get -o Acquire::https::CaInfo="$certificate" update && \
    apt-get -o Acquire::https::CaInfo="$certificate" install -y --no-install-recommends gcc libc6-dev util-linux passwd && \
    rm -rf /var/lib/apt/lists/* && /usr/sbin/useradd --uid 10001 --create-home klocgit
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; export PIP_CERT=/run/secrets/proxy_ca; fi; \
    node /usr/local/lib/node_modules/npm/bin/npm-cli.js install --prefix /opt/node-tools vitest@3.2.4 typescript@5.9.3 pyright@1.1.407 && \
    pip install --no-cache-dir pytest==8.4.2
ENV PYTHONDONTWRITEBYTECODE=1
USER root

FROM ${KLOCGIT_IMAGE_TARGET} AS runtime
