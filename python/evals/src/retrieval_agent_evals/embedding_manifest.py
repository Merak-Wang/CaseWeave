"""Keep embedding provenance separate from a same-stem source dataset manifest."""
import json
from pathlib import Path


def manifest_path(output: Path, *, legacy: bool = False) -> Path:
    current = output.with_suffix(".embedding.manifest.json")
    return output.with_suffix(".manifest.json") if legacy and not current.exists() else current


def write_manifest(output: Path, data: dict) -> None:
    manifest_path(output).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
