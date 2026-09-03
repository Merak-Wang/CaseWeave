from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import sys

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
        total = path.stat().st_size
        completed = 0
        last_bucket = -1
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                digest.update(chunk)
                completed += len(chunk)
                percent = 100 if total == 0 else min(100, int(completed * 100 / total))
                bucket = percent // 5
                if sys.stderr.isatty():
                    width = 24
                    filled = min(width, round(percent / 100 * width))
                    sys.stderr.write(
                        f"\r\x1b[2KVerifying {relative_path} "
                        f"[{'#' * filled}{'-' * (width - filled)}] {percent}%"
                    )
                    sys.stderr.flush()
                elif bucket != last_bucket:
                    print(f"Verifying {relative_path}: {percent}%", file=sys.stderr, flush=True)
                    last_bucket = bucket
        if sys.stderr.isatty():
            sys.stderr.write("\n")
        if digest.hexdigest() != expected_checksum:
            raise SystemExit(f"downloaded file does not match the manifest checksum: {path}")


def main() -> None:
    args = parser().parse_args()
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    print(
        f"Downloading {args.repo_id}@{args.revision} to {args.destination} "
        "(Hugging Face reports per-file progress below)...",
        flush=True,
    )
    snapshot_download(
        repo_id=args.repo_id,
        revision=args.revision,
        local_dir=args.destination,
    )
    print("Download complete; verifying pinned files...", flush=True)
    verify_files(args.destination, args.file)
    print("Pinned model dependency ready.", flush=True)


if __name__ == "__main__":
    main()
