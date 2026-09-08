"""Offline serving and explicit, resumable preparation of immutable model releases."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys

from .cli import validate_bind


def _relative(value: str) -> Path:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts or "\\" in value or ":" in value:
        raise SystemExit(f"Model files must use safe relative paths: {value}")
    return Path(*path.parts)


def _plan(manifest: Path, store: Path, reranker: bool):
    data = json.loads(manifest.read_text(encoding="utf-8"))
    roles = ["embedding", *(["reranker"] if reranker else [])]
    dependencies = {}
    for role in roles:
        dependency = data["dependencies"][data[role]["dependency"]]
        local = _relative(dependency["localPath"])
        if len(local.parts) < 2 or local.parts[0] != "models":
            raise SystemExit("Model localPath must be relative to models/")
        for item in dependency["files"]:
            _relative(item["path"])
        dependencies[role] = (dependency, Path(*local.parts[1:]))
    identity = hashlib.sha256(json.dumps({"manifest": data, "roles": roles}, sort_keys=True).encode()).hexdigest()
    return store / "releases" / identity, dependencies


def _verify(directory: Path, dependency: dict) -> dict:
    files = {}
    for spec in dependency["files"]:
        path = directory / _relative(spec["path"])
        if not path.is_file():
            raise SystemExit(f"Missing model file {path}; run model:container prepare --download or --import=PATH")
        digest = _hash(path)
        if spec.get("sha256") and digest != spec["sha256"]:
            raise SystemExit(f"Model checksum mismatch: {path}; restore the pinned file and prepare again")
        files[spec["path"]] = digest
    return files


def _hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


@contextmanager
def _preparation_lock(store: Path):
    store.mkdir(parents=True, exist_ok=True)
    with (store / ".prepare.lock").open("a+b") as stream:
        if os.name == "nt":
            import msvcrt
            stream.write(b"0")
            stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def model_paths(manifest: Path, store: Path, reranker: bool) -> dict[str, Path]:
    release, dependencies = _plan(manifest, store, reranker)
    receipt_path = release / "verified.json"
    if not receipt_path.is_file():
        raise SystemExit("Models are not prepared; run pnpm model:container prepare --download or --import=PATH")
    receipt = json.loads(receipt_path.read_text())
    paths = {}
    for role, (dependency, local) in dependencies.items():
        directory = release / local
        files = _verify(directory, dependency)
        if receipt.get(role) != files:
            raise SystemExit(f"Model checksum receipt mismatch for {role}; restore pinned files")
        paths[role] = directory
    return paths


def prepare_models(manifest: Path, store: Path, import_root: Path | None, download: bool, reranker: bool) -> None:
    release, dependencies = _plan(manifest, store, reranker)
    with _preparation_lock(store):
        if release.exists():
            model_paths(manifest, store, reranker)
            print(f"Reused verified models: {release}", flush=True)
            return
        staging = store / "staging" / release.name
        staging.mkdir(parents=True, exist_ok=True)
        receipt = {}
        for role, (dependency, local) in dependencies.items():
            destination = staging / local
            destination.mkdir(parents=True, exist_ok=True)
            source = import_root / local if import_root else None
            if source is not None and source.is_dir():
                _verify(source, dependency)
                for item in dependency["files"]:
                    relative = _relative(item["path"])
                    target = destination / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source / relative, target)
                print(f"Imported pinned {role} from {source}", flush=True)
            elif download:
                from huggingface_hub import snapshot_download
                identity = dependency["source"]
                print(f"Downloading {identity['repoId']}@{identity['revision']}; partial files remain in staging", flush=True)
                snapshot_download(repo_id=identity["repoId"], revision=identity["revision"],
                                  local_dir=destination, allow_patterns=[item["path"] for item in dependency["files"]])
            else:
                raise SystemExit(f"Missing import for {role}; provide --import=PATH or explicitly allow --download")
            receipt[role] = _verify(destination, dependency)
        (staging / "verified.json").write_text(json.dumps(receipt, sort_keys=True) + "\n")
        release.parent.mkdir(parents=True, exist_ok=True)
        staging.rename(release)
        print(f"Published verified models: {release}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "serve", "check", "health"])
    parser.add_argument("--manifest", type=Path, default=Path("/app/architecture/model-manifest.json"))
    parser.add_argument("--store", type=Path, default=Path("/models"))
    parser.add_argument("--import-root", type=Path)
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    reranker = os.getenv("RETRIEVAL_AGENT_RERANKER_ENABLED", "false").lower() in ("1", "true", "yes", "on")
    if args.command == "health":
        from urllib.request import urlopen
        with urlopen("http://127.0.0.1:8012/health/ready", timeout=3) as response:
            if json.load(response).get("ready") is not True:
                raise SystemExit(1)
        return
    if args.command == "prepare":
        prepare_models(args.manifest, args.store, args.import_root, args.download, reranker)
        return
    paths = model_paths(args.manifest, args.store, reranker)
    if args.command == "check":
        print(json.dumps({role: str(path) for role, path in paths.items()}))
        return
    from .cli import main as serve
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    sys.argv = ["retrieval-agent-model-service", "--manifest", str(args.manifest),
                "--embedding-path", str(paths["embedding"]),
                "--spacy-path", "/opt/spacy/zh_core_web_sm-3.8.0",
                "--domain-lexicon", "/app/config/query-domain-lexicon.json",
                "--vector-cache-dir", "/cache/vectors", "--host", "0.0.0.0", "--allow-container-bind",
                "--device", os.getenv("RETRIEVAL_AGENT_MODEL_DEVICE", "cpu"),
                "--checkpoint-every-batches", os.getenv("RETRIEVAL_AGENT_INDEX_CHECKPOINT_BATCHES", "8"),
                "--max-batch-size", os.getenv("RETRIEVAL_AGENT_MODEL_MAX_BATCH_SIZE", "16"),
                "--max-total-tokens", os.getenv("RETRIEVAL_AGENT_MODEL_MAX_TOTAL_TOKENS", "8192")]
    if reranker:
        sys.argv.extend(["--enable-reranker", "--reranker-path", str(paths["reranker"])])
    serve()


if __name__ == "__main__":
    main()
