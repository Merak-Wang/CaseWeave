FROM ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 AS uv
FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY pyproject.toml uv.lock ./
COPY python/evals/pyproject.toml python/evals/README.md ./python/evals/
COPY python/model-service/pyproject.toml python/model-service/README.md ./python/model-service/
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --project python/model-service --group runtime --no-dev --no-install-workspace
COPY python/model-service/src ./python/model-service/src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --project python/model-service --group runtime --no-dev --no-editable \
    && /app/.venv/bin/python -c "import shutil, pathlib, zh_core_web_sm; shutil.copytree(pathlib.Path(zh_core_web_sm.__file__).parent / 'zh_core_web_sm-3.8.0', '/opt/spacy/zh_core_web_sm-3.8.0')"
COPY architecture/model-manifest.json ./architecture/model-manifest.json
COPY config/query-domain-lexicon.json ./config/query-domain-lexicon.json
ENV PATH="/app/.venv/bin:$PATH" HF_HOME=/cache/huggingface XDG_CACHE_HOME=/cache OMP_NUM_THREADS=4
RUN mkdir -p /models /cache && chown -R 10001:10001 /models /cache
USER 10001:10001
EXPOSE 8012
ENTRYPOINT ["python", "-m", "retrieval_agent_model_service.container"]
CMD ["serve"]
