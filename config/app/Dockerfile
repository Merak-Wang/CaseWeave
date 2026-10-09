ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500
ARG MODEL_RUNTIME_IMAGE=retrieval-agent-model-service:0.1.0-cu128
FROM ${UV_IMAGE} AS uv
FROM ${MODEL_RUNTIME_IMAGE} AS model-runtime
FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS node-runtime
FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS operators
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock ./
COPY python/evals/pyproject.toml python/evals/README.md ./python/evals/
COPY python/model-service/pyproject.toml python/model-service/README.md ./python/model-service/
COPY python/semantic-operators/pyproject.toml python/semantic-operators/README.md ./python/semantic-operators/
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --package caseweave-semantic-operators --no-dev --no-install-workspace
COPY python/semantic-operators/src ./python/semantic-operators/src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --package caseweave-semantic-operators --no-dev --no-editable

FROM model-runtime
USER root
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home node \
    && mkdir -p /cache && chown node:node /cache
ENV CASEWEAVE_PYTHON=/opt/semantic-operators/venv/bin/python PYTHONDONTWRITEBYTECODE=1
ENV PNPM_HOME=/opt/pnpm
ENV PATH="/opt/pnpm:$PATH"
WORKDIR /app
RUN npm install --global pnpm@10.28.2
RUN mkdir -p /app/.cache /app/data /app/output /opt/retrieval-runtime/dsh-runner && chown node:node /app /app/.cache /app/data /app/output /opt/retrieval-runtime/dsh-runner
USER node
# Runtime dependencies change independently from application source.
COPY --chown=node:node config/app/runtime/ /opt/retrieval-runtime/dsh-runner/
RUN cd /opt/retrieval-runtime/dsh-runner && pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts
COPY --chown=node:node pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile --ignore-scripts
COPY --chown=node:node . .
RUN pnpm install --offline --frozen-lockfile --ignore-scripts && pnpm -r --if-present run build
COPY --from=operators /app/.venv/ /opt/semantic-operators/venv/
RUN /opt/semantic-operators/venv/bin/python -c 'import ssl, sqlite3, numpy, scipy, sklearn; import caseweave_ops.server' \
    && /app/.venv/bin/python -c 'import torch, transformers; import retrieval_agent_model_service.container'
# Install the pinned DSH in the image; user profiles and credentials stay in a volume.
RUN mkdir -p /app/.cache /app/data/raw /app/data/tickets/esft /app/data/evals/esft-summary-v1 /app/output \
    && node scripts/wiki-store.mjs verify
ENV RETRIEVAL_AGENT_STORAGE=mysql_milvus \
    RETRIEVAL_AGENT_MODEL_SERVICE_MODE=external \
    RETRIEVAL_AGENT_RUNTIME_ROOT=/opt/retrieval-runtime \
    RETRIEVAL_AGENT_LOCAL_STATE_DIR=/app/.cache/local \
    RETRIEVAL_AGENT_MYSQL_URL=mysql://root@mysql:3306/retrieval_agent \
    RETRIEVAL_AGENT_MILVUS_URL=http://milvus:19530 \
    RETRIEVAL_AGENT_MODEL_SERVICE_URL=http://127.0.0.1:8012 \
    DSH_TELEMETRY_DISABLED=1
EXPOSE 3080
ENTRYPOINT []
CMD ["node", "scripts/container-web.mjs"]
