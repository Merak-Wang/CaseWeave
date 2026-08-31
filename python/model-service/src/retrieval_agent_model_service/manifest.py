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


def _model(value: Any, *, embedding: bool) -> ModelManifest:
    if not isinstance(value, dict):
        raise ServiceError(500, "MANIFEST_INVALID", "Model manifest entry is invalid.")
    instruction_key = "queryInstruction" if embedding else "instruction"
    required = ["model", "revision", "weightSha256", "maxTokens", instruction_key]
    required.extend(["dimensions", "pooling", "normalization"] if embedding else ["scoreKind"])
    if any(key not in value for key in required):
        raise ServiceError(500, "MANIFEST_INVALID", "Model manifest is missing required fields.")
    dimensions = value.get("dimensions")
    if embedding and (not isinstance(dimensions, int) or dimensions < 1):
        raise ServiceError(500, "MANIFEST_INVALID", "Embedding dimensions are invalid.")
    max_tokens = value.get("maxTokens")
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens < 1:
        raise ServiceError(500, "MANIFEST_INVALID", "Model token limit is invalid.")
    strings = [value.get("model"), value.get("revision"), value.get("weightSha256"), value.get(instruction_key)]
    if any(not isinstance(item, str) or not item.strip() for item in strings):
        raise ServiceError(500, "MANIFEST_INVALID", "Model identity or instruction is invalid.")
    if re.fullmatch(r"[0-9a-fA-F]{64}", value["weightSha256"]) is None:
        raise ServiceError(500, "MANIFEST_INVALID", "Model weight checksum is invalid.")
    if embedding and (value.get("pooling") != "last_token" or value.get("normalization") != "l2"):
        raise ServiceError(500, "MANIFEST_INVALID", "Unsupported embedding pooling or normalization.")
    if not embedding and value.get("scoreKind") != "yes_probability":
        raise ServiceError(500, "MANIFEST_INVALID", "Unsupported reranker score kind.")
    return ModelManifest(
        model=value["model"],
        revision=value["revision"],
        weight_sha256=value["weightSha256"].lower(),
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
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        raise ServiceError(500, "MANIFEST_INVALID", "Unsupported model manifest schema.")
    return RetrievalModelManifest(
        embedding=_model(data.get("embedding"), embedding=True),
        reranker=_model(data.get("reranker"), embedding=False),
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
