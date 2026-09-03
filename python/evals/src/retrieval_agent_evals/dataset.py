from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


@dataclass(frozen=True)
class BronzeQrel:
    ticket_id: str
    relevance: int
    evidence_fields: tuple[str, ...]


@dataclass(frozen=True)
class BronzeCase:
    case_id: str
    split: str
    context: str
    target: str
    query: str
    qrels: tuple[BronzeQrel, ...]
    expected_actions: tuple[str, ...]

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> BronzeCase:
        raw_qrels = value.get("qrels")
        if not isinstance(raw_qrels, list):
            raise ValueError("qrels must be an array")
        qrels: list[BronzeQrel] = []
        for raw in raw_qrels:
            if not isinstance(raw, Mapping):
                raise ValueError("each qrel must be an object")
            fields = raw.get("evidenceFields", [])
            if not isinstance(fields, list) or any(not isinstance(field, str) for field in fields):
                raise ValueError("evidenceFields must be a string array")
            ticket_id = raw.get("ticketId")
            relevance = raw.get("relevance")
            if not isinstance(ticket_id, str) or not ticket_id or not isinstance(relevance, int):
                raise ValueError("qrel ticketId/relevance is invalid")
            qrels.append(BronzeQrel(ticket_id, relevance, tuple(fields)))
        actions = value.get("expectedActions")
        if not isinstance(actions, list) or any(not isinstance(action, str) for action in actions):
            raise ValueError("expectedActions must be a string array")
        required = {name: value.get(name) for name in ("caseId", "split", "context", "target", "query")}
        if any(not isinstance(item, str) or not item for item in required.values()):
            raise ValueError("Bronze case identity and task fields must be non-empty strings")
        return cls(
            case_id=required["caseId"],
            split=required["split"],
            context=required["context"],
            target=required["target"],
            query=required["query"],
            qrels=tuple(qrels),
            expected_actions=tuple(actions),
        )


def legacy_bronze_root() -> Path:
    return Path(__file__).resolve().parents[4] / "data" / "evals" / "legacy-bronze-v1"


def load_legacy_bronze_cases(root: Path | None = None) -> tuple[BronzeCase, ...]:
    path = (root or legacy_bronze_root()) / "cases.jsonl"
    cases = tuple(
        BronzeCase.from_mapping(json.loads(line))
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    )
    if len({case.case_id for case in cases}) != len(cases):
        raise ValueError("Bronze case ids must be unique")
    return cases


def verify_legacy_bronze_manifest(root: Path | None = None) -> Mapping[str, Any]:
    dataset_root = root or legacy_bronze_root()
    manifest = json.loads((dataset_root / "manifest.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256((dataset_root / "cases.jsonl").read_bytes()).hexdigest()
    if digest != manifest.get("migratedCasesSha256"):
        raise ValueError("legacy Bronze cases hash does not match its manifest")
    cases = load_legacy_bronze_cases(dataset_root)
    if len(cases) != manifest.get("caseCount"):
        raise ValueError("legacy Bronze case count does not match its manifest")
    split_counts = {split: sum(case.split == split for case in cases) for split in {case.split for case in cases}}
    if split_counts != manifest.get("splitCounts"):
        raise ValueError("legacy Bronze split counts do not match its manifest")
    qrels_path = dataset_root / "qrels.jsonl"
    if hashlib.sha256(qrels_path.read_bytes()).hexdigest() != manifest.get("migratedQrelsSha256"):
        raise ValueError("legacy Bronze qrels hash does not match its manifest")
    return manifest
