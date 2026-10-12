# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS node
FROM golang:1.23-bookworm AS go
FROM python:3.12-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:/usr/local/lib/node_modules/npm/bin:/usr/local/bin:/usr/bin:/bin"
RUN --mount=type=secret,id=proxy_ca \
    certificate=/etc/ssl/certs/ca-certificates.crt; \
    if [ -f /run/secrets/proxy_ca ]; then certificate=/run/secrets/proxy_ca; fi; \
    apt-get -o Acquire::https::CaInfo="$certificate" update && \
    apt-get -o Acquire::https::CaInfo="$certificate" install -y --no-install-recommends gcc libc6-dev ca-certificates passwd && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --uid 10001 --create-home klocgit
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; export PIP_CERT=/run/secrets/proxy_ca; fi; \
    node /usr/local/lib/node_modules/npm/bin/npm-cli.js install --prefix /opt/node-tools vitest@3.2.4 typescript@5.9.3 pyright@1.1.407 && \
    pip install --no-cache-dir pytest==8.4.2
ENV PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
