from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from .errors import ServiceError


VECTOR_CACHE_FORMAT_VERSION = "float32-le-v1"
VECTOR_CHECKPOINT_FORMAT_VERSION = "float32-le-partial-v1"


def _valid_vectors(vectors: np.ndarray, rows: int, dimensions: int) -> bool:
    if vectors.shape != (rows, dimensions) or not np.isfinite(vectors).all():
        return False
    if rows == 0:
        return True
    norms = np.linalg.norm(vectors, axis=1)
    return bool(np.all(np.abs(norms - 1) <= 0.02))


class VectorCacheStore:
    """Crash-safe final cache plus resumable append-only preparation checkpoint."""

    def __init__(self, root: Path | None, key: str, identity: dict[str, Any]) -> None:
        self.root = root
        self.key = key
        self.identity = identity
        self.rows = len(identity["documents"])
        self.dimensions = identity["dimensions"]
        self._checkpoint_rows = 0

    def _path(self, suffix: str) -> Path:
        if self.root is None:
            raise RuntimeError("vector cache path requested without a cache directory")
        return self.root / f"{self.key}{suffix}"

    def load_final(self) -> np.ndarray | None:
        if self.root is None:
            return None
        try:
            metadata = json.loads(self._path(".json").read_text(encoding="utf-8"))
            data = self._path(".f32").read_bytes()
            expected = {
                **self.identity,
                "formatVersion": VECTOR_CACHE_FORMAT_VERSION,
                "rowCount": self.rows,
                "dataSha256": hashlib.sha256(data).hexdigest(),
            }
            if metadata != expected or len(data) != self.rows * self.dimensions * 4:
                return None
            vectors = np.frombuffer(data, dtype="<f4").reshape(self.rows, self.dimensions).copy()
            return vectors if _valid_vectors(vectors, self.rows, self.dimensions) else None
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return None

    def load_checkpoint(self) -> np.ndarray:
        empty = np.empty((0, self.dimensions), dtype=np.float32)
        if self.root is None:
            return empty
        try:
            metadata = json.loads(self._path(".partial.json").read_text(encoding="utf-8"))
            completed = metadata.get("completedRows")
            expected = {
                **self.identity,
                "formatVersion": VECTOR_CHECKPOINT_FORMAT_VERSION,
                "rowCount": self.rows,
                "completedRows": completed,
            }
            if metadata != expected or isinstance(completed, bool) or not isinstance(completed, int):
                return empty
            if completed < 0 or completed > self.rows:
                return empty
            data_path = self._path(".partial.f32")
            expected_bytes = completed * self.dimensions * 4
            if data_path.stat().st_size < expected_bytes:
                return empty
            with data_path.open("r+b") as stream:
                stream.truncate(expected_bytes)
            data = data_path.read_bytes()
            vectors = np.frombuffer(data, dtype="<f4").reshape(completed, self.dimensions).copy()
            if not _valid_vectors(vectors, completed, self.dimensions):
                return empty
            self._checkpoint_rows = completed
            return vectors
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return empty

    def append_checkpoint(self, vectors: np.ndarray) -> None:
        if self.root is None or len(vectors) == 0:
            return
        values = np.asarray(vectors, dtype="<f4")
        if not _valid_vectors(values, len(values), self.dimensions):
            raise ServiceError(500, "INVALID_VECTOR", "Refusing to checkpoint malformed document vectors.")
        completed = self._checkpoint_rows + len(values)
        if completed > self.rows:
            raise ServiceError(500, "INVALID_VECTOR", "Vector checkpoint exceeds the declared corpus.")
        self.root.mkdir(parents=True, exist_ok=True)
        data_path = self._path(".partial.f32")
        mode = "r+b" if data_path.exists() else "w+b"
        with data_path.open(mode) as stream:
            stream.truncate(self._checkpoint_rows * self.dimensions * 4)
            stream.seek(0, os.SEEK_END)
            stream.write(values.tobytes(order="C"))
            stream.flush()
            os.fsync(stream.fileno())
        self._checkpoint_rows = completed
        self._write_json_atomic(self._path(".partial.json"), {
            **self.identity,
            "formatVersion": VECTOR_CHECKPOINT_FORMAT_VERSION,
            "rowCount": self.rows,
            "completedRows": completed,
        })

    def publish(self, vectors: np.ndarray) -> None:
        values = np.asarray(vectors, dtype="<f4")
        if not _valid_vectors(values, self.rows, self.dimensions):
            raise ServiceError(500, "INVALID_VECTOR", "Refusing to publish a malformed vector cache.")
        if self.root is None:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        data = values.tobytes(order="C")
        metadata = {
            **self.identity,
            "formatVersion": VECTOR_CACHE_FORMAT_VERSION,
            "rowCount": self.rows,
            "dataSha256": hashlib.sha256(data).hexdigest(),
        }
        data_handle, data_name = tempfile.mkstemp(prefix=f"{self.key}.", suffix=".tmp", dir=self.root)
        try:
            with os.fdopen(data_handle, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(data_name, self._path(".f32"))
            self._write_json_atomic(self._path(".json"), metadata)
        finally:
            try:
                os.unlink(data_name)
            except FileNotFoundError:
                pass
        self.clear_checkpoint()

    def clear_checkpoint(self) -> None:
        if self.root is None:
            return
        for suffix in (".partial.f32", ".partial.json"):
            try:
                self._path(suffix).unlink()
            except FileNotFoundError:
                pass

    def _write_json_atomic(self, target: Path, value: dict[str, Any]) -> None:
        if self.root is None:
            return
        handle, temporary = tempfile.mkstemp(prefix=f"{self.key}.", suffix=".tmp", dir=self.root)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(value, stream, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
