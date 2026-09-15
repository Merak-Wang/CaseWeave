FROM ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 AS uv
FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY pyproject.toml uv.lock ./
COPY python/evals/pyproject.toml python/evals/README.md ./python/evals/
COPY python/model-service/pyproject.toml python/model-service/README.md ./python/model-service/
COPY python/semantic-operators/pyproject.toml python/semantic-operators/README.md ./python/semantic-operators/
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --package caseweave-semantic-operators --no-dev --no-install-workspace
COPY python/semantic-operators/src ./python/semantic-operators/src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --package caseweave-semantic-operators --no-dev --no-editable
RUN mkdir -p /app/.cache && chown -R 1000:1000 /app/.cache
ENV PATH="/app/.venv/bin:$PATH"
USER 1000:1000
EXPOSE 8013
CMD ["python", "-m", "caseweave_ops.server", "--host", "0.0.0.0"]
