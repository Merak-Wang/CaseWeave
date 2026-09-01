from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import ServiceError


@dataclass(frozen=True)
class ModelManifest:
    model: str
    revision: str
    weight_sha256: str
    max_tokens: int
    dimensions: int | None = None
    instruction: str | None = None
    pooling: str | None = None
    normalization: str | None = None
    score_kind: str | None = None


@dataclass(frozen=True)
class RetrievalModelManifest:
    embedding: ModelManifest
    reranker: ModelManifest


def _identity(dependencies: Any, dependency_id: Any) -> tuple[str, str, str]:
    if not isinstance(dependencies, dict) or not isinstance(dependency_id, str):
        raise ServiceError(500, "MANIFEST_INVALID", "Model dependency reference is invalid.")
    dependency = dependencies.get(dependency_id)
    if not isinstance(dependency, dict):
        raise ServiceError(500, "MANIFEST_INVALID", "Model dependency does not exist.")
    source = dependency.get("source")
    files = dependency.get("files")
    if not isinstance(source, dict) or source.get("type") != "huggingface" or not isinstance(files, list):
        raise ServiceError(500, "MANIFEST_INVALID", "Model dependency source or files are invalid.")
    model = source.get("repoId")
    revision = source.get("revision")
    weight = next(
        (item for item in files if isinstance(item, dict) and item.get("path") == "model.safetensors"),
        None,
    )
    weight_sha256 = weight.get("sha256") if isinstance(weight, dict) else None
    if (
        not isinstance(model, str)
        or not model.strip()
        or not isinstance(revision, str)
        or re.fullmatch(r"[0-9a-f]{40}", revision) is None
        or not isinstance(weight_sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", weight_sha256) is None
    ):
        raise ServiceError(500, "MANIFEST_INVALID", "Model dependency identity or checksum is invalid.")
    return model, revision, weight_sha256


def _model(value: Any, dependencies: Any, *, embedding: bool) -> ModelManifest:
    if not isinstance(value, dict):
        raise ServiceError(500, "MANIFEST_INVALID", "Model manifest entry is invalid.")
    instruction_key = "queryInstruction" if embedding else "instruction"
    required = ["dependency", "maxTokens", instruction_key]
    required.extend(["dimensions", "pooling", "normalization"] if embedding else ["scoreKind"])
    if any(key not in value for key in required):
        raise ServiceError(500, "MANIFEST_INVALID", "Model manifest is missing required fields.")
    dimensions = value.get("dimensions")
    if embedding and (not isinstance(dimensions, int) or dimensions < 1):
        raise ServiceError(500, "MANIFEST_INVALID", "Embedding dimensions are invalid.")
    max_tokens = value.get("maxTokens")
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens < 1:
        raise ServiceError(500, "MANIFEST_INVALID", "Model token limit is invalid.")
    strings = [value.get("dependency"), value.get(instruction_key)]
    if any(not isinstance(item, str) or not item.strip() for item in strings):
        raise ServiceError(500, "MANIFEST_INVALID", "Model identity or instruction is invalid.")
    model, revision, weight_sha256 = _identity(dependencies, value["dependency"])
    if embedding and (value.get("pooling") != "last_token" or value.get("normalization") != "l2"):
        raise ServiceError(500, "MANIFEST_INVALID", "Unsupported embedding pooling or normalization.")
    if not embedding and value.get("scoreKind") != "yes_probability":
        raise ServiceError(500, "MANIFEST_INVALID", "Unsupported reranker score kind.")
    return ModelManifest(
        model=model,
        revision=revision,
        weight_sha256=weight_sha256,
        max_tokens=max_tokens,
        dimensions=dimensions if embedding else None,
        instruction=value[instruction_key],
        pooling=value.get("pooling") if embedding else None,
        normalization=value.get("normalization") if embedding else None,
        score_kind=value.get("scoreKind") if not embedding else None,
    )


def load_manifest(path: Path) -> RetrievalModelManifest:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ServiceError(500, "MANIFEST_INVALID", "Unable to read model manifest.") from error
    if not isinstance(data, dict) or data.get("schemaVersion") != 2:
        raise ServiceError(500, "MANIFEST_INVALID", "Unsupported model manifest schema.")
    return RetrievalModelManifest(
        embedding=_model(data.get("embedding"), data.get("dependencies"), embedding=True),
        reranker=_model(data.get("reranker"), data.get("dependencies"), embedding=False),
    )


def verify_weights(model_path: Path, expected_sha256: str) -> None:
    weight_path = model_path / "model.safetensors"
    if not weight_path.is_file():
        raise ServiceError(500, "MODEL_FILES_MISSING", f"Missing model weights under {model_path}.")
    digest = hashlib.sha256()
    with weight_path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest().lower() != expected_sha256.lower():
        raise ServiceError(500, "MODEL_REVISION_MISMATCH", f"Model weights do not match the manifest for {model_path.name}.")
