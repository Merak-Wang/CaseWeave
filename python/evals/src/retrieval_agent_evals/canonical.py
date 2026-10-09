"""Versioned title + abstract input shared by local experimental consumers.

This module is pure: it reads no files, calls no services, and never substitutes
body text for a missing title or abstract.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Mapping

PROJECTION_VERSION = "canonical-title-abstract-v1"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _text_field(row: Mapping[str, Any], source_name: str, adapted_name: str) -> str:
    # A present source field is authoritative, including an invalid empty value.
    value = row[source_name] if source_name in row else row.get(adapted_name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{source_name}/{adapted_name} must contain nonempty text")
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


@dataclass(frozen=True)
class CanonicalTicketView:
    title: str
    abstract: str
    text: str
    content_hash: str
    projection_version: str = PROJECTION_VERSION

    def as_payload(self) -> dict[str, str]:
        return {"projection_version": self.projection_version,
                "title": self.title, "abstract": self.abstract}


def canonical_ticket_view(row: Mapping[str, Any]) -> CanonicalTicketView:
    if not isinstance(row, Mapping):
        raise TypeError("canonical ticket input must be a mapping")
    title = _text_field(row, "large_model_title", "title")
    abstract = _text_field(row, "large_model_abstract", "summary")
    fingerprint = {"abstract": abstract, "projection": PROJECTION_VERSION, "title": title}
    return CanonicalTicketView(
        title, abstract, f"【标题】{title}\n【摘要】{abstract}",
        hashlib.sha256(_json(fingerprint).encode("utf-8")).hexdigest())


def canonical_ticket_text(row: Mapping[str, Any]) -> str:
    return canonical_ticket_view(row).text


def canonical_content_hash(row: Mapping[str, Any]) -> str:
    return canonical_ticket_view(row).content_hash


def canonical_embedding_identity(
    row: Mapping[str, Any], *, model: str, revision: str, dimensions: int,
    normalization: str = "l2", pooling: str = "last_token", instruction: str = ""
) -> dict[str, Any]:
    if not model or not revision:
        raise ValueError("embedding model and revision must be explicit")
    if type(dimensions) is not int or dimensions < 1:
        raise ValueError("embedding dimensions must be positive")
    if normalization != "l2" or pooling != "last_token":
        raise ValueError("canonical embedding requires last_token pooling and l2 normalization")
    view = canonical_ticket_view(row)
    return {"schema_version": 1, "projection_version": PROJECTION_VERSION,
            "content_hash": view.content_hash,
            "text_hash": hashlib.sha256(view.text.encode("utf-8")).hexdigest(),
            "model": model, "revision": revision, "dimensions": dimensions,
            "normalization": normalization, "pooling": pooling,
            "instruction": instruction, "input_type": "document"}


def canonical_embedding_cache_key(row: Mapping[str, Any], **identity: Any) -> str:
    return hashlib.sha256(_json(canonical_embedding_identity(row, **identity)).encode("utf-8")).hexdigest()
