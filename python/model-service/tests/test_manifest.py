from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from retrieval_agent_model_service.errors import ServiceError
from retrieval_agent_model_service.manifest import load_manifest, verify_weights


def manifest() -> dict[str, object]:
    return {
        "schemaVersion": 2,
        "dependencies": {
            "embedding-model": {
                "source": {
                    "type": "huggingface",
                    "repoId": "test/embedding",
                    "revision": "1" * 40,
                },
                "files": [{"path": "model.safetensors", "sha256": "a" * 64}],
            },
            "reranker-model": {
                "source": {
                    "type": "huggingface",
                    "repoId": "test/reranker",
                    "revision": "2" * 40,
                },
                "files": [{"path": "model.safetensors", "sha256": "b" * 64}],
            },
        },
        "embedding": {
            "dependency": "embedding-model",
            "dimensions": 1024,
            "pooling": "last_token",
            "normalization": "l2",
            "maxTokens": 512,
            "queryInstruction": "retrieve tickets",
        },
        "reranker": {
            "dependency": "reranker-model",
            "scoreKind": "yes_probability",
            "maxTokens": 512,
            "instruction": "judge tickets",
        },
    }


def test_loads_versioned_model_semantics(tmp_path: Path) -> None:
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest()), encoding="utf-8")

    loaded = load_manifest(path)

    assert loaded.embedding.dimensions == 1024
    assert loaded.embedding.model == "test/embedding"
    assert loaded.embedding.revision == "1" * 40
    assert loaded.embedding.weight_sha256 == "a" * 64
    assert loaded.embedding.pooling == "last_token"
    assert loaded.embedding.normalization == "l2"
    assert loaded.reranker.score_kind == "yes_probability"


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("embedding", "pooling", "mean"),
        ("embedding", "dependency", "missing-model"),
        ("reranker", "scoreKind", "random_head"),
        ("reranker", "maxTokens", 0),
    ],
)
def test_rejects_unsupported_or_incomplete_identity(
    tmp_path: Path, section: str, field: str, value: object
) -> None:
    data = manifest()
    assert isinstance(data[section], dict)
    data[section][field] = value
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(ServiceError, match="manifest|Model|Unsupported"):
        load_manifest(path)


def test_rejects_dependency_without_pinned_weight_checksum(tmp_path: Path) -> None:
    data = manifest()
    dependencies = data["dependencies"]
    assert isinstance(dependencies, dict)
    embedding = dependencies["embedding-model"]
    assert isinstance(embedding, dict) and isinstance(embedding["files"], list)
    embedding["files"][0]["sha256"] = "not-a-sha"
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(ServiceError, match="checksum"):
        load_manifest(path)


def test_verifies_the_exact_weight_file(tmp_path: Path) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    weight_path = model_path / "model.safetensors"
    weight_path.write_bytes(b"known weights")
    expected = hashlib.sha256(b"known weights").hexdigest()

    verify_weights(model_path, expected)

    with pytest.raises(ServiceError) as raised:
        verify_weights(model_path, "0" * 64)
    assert raised.value.code == "MODEL_REVISION_MISMATCH"
