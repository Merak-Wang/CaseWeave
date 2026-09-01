from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re

from huggingface_hub import snapshot_download


def file_spec(value: str) -> tuple[Path, str | None]:
    name, separator, checksum = value.partition("=")
    path = Path(name)
    if not name or path.is_absolute() or ".." in path.parts:
        raise argparse.ArgumentTypeError("model dependency files must be safe relative paths")
    if separator and re.fullmatch(r"[0-9a-f]{64}", checksum) is None:
        raise argparse.ArgumentTypeError("model dependency checksum must be a lowercase SHA-256")
    return path, checksum if separator else None


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Download one pinned Retrieval Agent model snapshot")
    result.add_argument("--repo-id", required=True)
    result.add_argument("--revision", required=True)
    result.add_argument("--destination", type=Path, required=True)
    result.add_argument("--file", action="append", type=file_spec, required=True)
    return result


def verify_files(destination: Path, files: list[tuple[Path, str | None]]) -> None:
    for relative_path, expected_checksum in files:
        path = destination / relative_path
        if not path.is_file():
            raise SystemExit(f"downloaded snapshot has no required file: {path}")
        if expected_checksum is None:
            continue
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_checksum:
            raise SystemExit(f"downloaded file does not match the manifest checksum: {path}")


def main() -> None:
    args = parser().parse_args()
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=args.repo_id,
        revision=args.revision,
        local_dir=args.destination,
    )
    verify_files(args.destination, args.file)


if __name__ == "__main__":
    main()
