from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Materialize the uv-locked spaCy pipeline under models/")
    result.add_argument("--destination", type=Path, required=True)
    result.add_argument("--expected-version", required=True)
    return result


def pipeline_version(path: Path) -> str | None:
    try:
        value = json.loads((path / "meta.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    version = value.get("version") if isinstance(value, dict) else None
    return version if isinstance(version, str) else None


def main() -> None:
    args = parser().parse_args()
    destination = args.destination.resolve()
    if destination.exists():
        if pipeline_version(destination) == args.expected_version:
            print(f"Reusing spaCy pipeline at {destination}")
            return
        raise SystemExit(f"existing spaCy pipeline has the wrong version: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}-", dir=destination.parent))
    try:
        import zh_core_web_sm

        if zh_core_web_sm.__version__ != args.expected_version:
            raise SystemExit("uv-locked spaCy pipeline package has an unexpected version")
        zh_core_web_sm.load().to_disk(temporary)
        if pipeline_version(temporary) != args.expected_version:
            raise SystemExit("serialized spaCy pipeline metadata is invalid")
        os.replace(temporary, destination)
        print(f"Materialized spaCy pipeline at {destination}")
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
