FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f
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
RUN pnpm install --offline --frozen-lockfile --ignore-scripts && pnpm build
# Install the pinned DSH in the image; user profiles and credentials stay in a volume.
RUN mkdir -p /app/.cache /app/data/raw /app/data/tickets/esft /app/data/evals/esft-summary-v1 /app/output \
    && node scripts/wiki-store.mjs verify
ENV RETRIEVAL_AGENT_STORAGE=mysql_milvus \
    RETRIEVAL_AGENT_MODEL_SERVICE_MODE=external \
    RETRIEVAL_AGENT_RUNTIME_ROOT=/opt/retrieval-runtime \
    RETRIEVAL_AGENT_LOCAL_STATE_DIR=/app/.cache/local \
    RETRIEVAL_AGENT_MYSQL_URL=mysql://root@mysql:3306/retrieval_agent \
    RETRIEVAL_AGENT_MILVUS_URL=http://milvus:19530 \
    RETRIEVAL_AGENT_MODEL_SERVICE_URL=http://model-service:8012 \
    DSH_TELEMETRY_DISABLED=1
EXPOSE 3080
CMD ["node", "scripts/container-web.mjs"]
