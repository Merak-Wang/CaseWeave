from pathlib import Path
import json

import pytest

from retrieval_agent_model_service.container import prepare_models, model_paths, validate_bind


def fixture(tmp_path):
    import hashlib
    source = tmp_path / "import" / "tiny"
    source.mkdir(parents=True)
    (source / "model.safetensors").write_bytes(b"pinned weights")
    digest = hashlib.sha256(b"pinned weights").hexdigest()
    manifest = {"schemaVersion": 2, "dependencies": {"tiny": {
        "source": {"type": "huggingface", "repoId": "test/tiny", "revision": "a" * 40},
        "localPath": "models/tiny", "activation": {"type": "always"},
        "files": [{"path": "model.safetensors", "sha256": digest}],
    }}, "embedding": {"dependency": "tiny"}, "reranker": {"dependency": "optional"}}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    return path, tmp_path / "store", tmp_path / "import"


def test_bind_requires_explicit_container_opt_in():
    validate_bind("127.0.0.1", False)
    validate_bind("0.0.0.0", True)
    with pytest.raises(SystemExit, match="allow-container-bind"):
        validate_bind("0.0.0.0", False)
    with pytest.raises(SystemExit):
        validate_bind("192.168.1.1", True)


def test_import_is_verified_atomic_and_reused(tmp_path):
    manifest, store, source = fixture(tmp_path)
    with pytest.raises(SystemExit, match="prepare"):
        model_paths(manifest, store, False)
    prepare_models(manifest, store, source, False, False)
    paths = model_paths(manifest, store, False)
    assert paths["embedding"].is_dir()
    weight = paths["embedding"] / "model.safetensors"
    before = weight.stat().st_mtime_ns
    prepare_models(manifest, store, source, False, False)
    assert weight.stat().st_mtime_ns == before
    assert (source / "tiny/model.safetensors").read_bytes() == b"pinned weights"
    weight.write_bytes(b"corrupt")
    with pytest.raises(SystemExit, match="checksum"):
        model_paths(manifest, store, False)


def test_partial_import_never_becomes_ready(tmp_path):
    manifest, store, source = fixture(tmp_path)
    (source / "tiny/model.safetensors").write_bytes(b"partial")
    with pytest.raises(SystemExit, match="checksum"):
        prepare_models(manifest, store, source, False, False)
    with pytest.raises(SystemExit, match="prepare"):
        model_paths(manifest, store, False)


def test_missing_model_does_not_download_without_explicit_preparation(tmp_path):
    manifest, store, _ = fixture(tmp_path)
    with pytest.raises(SystemExit, match="download"):
        prepare_models(manifest, store, None, False, False)


def test_rejects_escaping_manifest_files(tmp_path):
    manifest, store, source = fixture(tmp_path)
    value = json.loads(manifest.read_text())
    value["dependencies"]["tiny"]["files"][0]["path"] = "../escape"
    manifest.write_text(json.dumps(value))
    with pytest.raises(SystemExit, match="relative"):
        prepare_models(manifest, store, source, False, False)
