"""Utilities for frozen, candidate-pool semantic-operator experiments."""
from __future__ import annotations

import hashlib
import json
import re
import random
import unicodedata
from pathlib import Path
from typing import Any, Mapping

from .canonical import canonical_content_hash


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _group_tokens(row: Mapping[str, Any]) -> set[str]:
    """Use business identity and the actual canonical model-input fingerprint."""
    identity = row.get("ticket_id")
    if identity is None or not str(identity).strip():
        raise ValueError("Candidate business ticket identity is required")
    tokens = {"identity:" + str(identity)}
    if row.get("group_id") is not None and str(row["group_id"]).strip():
        tokens.add("identity:" + str(row["group_id"]))
    if any(key in row for key in ("title", "summary", "large_model_title", "large_model_abstract")):
        tokens.add("canonical:" + canonical_content_hash(row))
    else:
        # Old body-only fixtures remain explicit in the projection manifest.
        body = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(row.get("body", "")))).strip()
        if not body:
            raise ValueError("Candidate text is required to verify group holdout")
        tokens.add("legacy_body:" + hashlib.sha256(body.encode()).hexdigest())
    return tokens


def _candidate_groups(candidates: list[Mapping[str, Any]]) -> list[list[int]]:
    parents = list(range(len(candidates)))
    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    owners = {}
    for i, row in enumerate(candidates):
        for token in _group_tokens(row):
            if token in owners:
                a, b = find(i), find(owners[token])
                parents[max(a, b)] = min(a, b)
            else:
                owners[token] = i
    groups = {}
    for i in range(len(candidates)):
        groups.setdefault(find(i), []).append(i)
    return sorted(groups.values(), key=lambda ids: ids[0])


def validate_group_holdout(rows: list[Mapping[str, Any]]) -> dict[str, Any]:
    if any(row.get("split") not in {"train", "test"} for row in rows):
        raise ValueError("Frozen split roles must be train or test")
    groups = _candidate_groups(rows)
    if any(len({rows[i]["split"] for i in group}) > 1 for group in groups):
        raise ValueError("Business identity or canonical text group crosses train/test holdout")
    return {"group_holdout_verified": True, "group_count": len(groups),
            "grouping": "business_ticket_id_or_group_id_and_canonical_title_abstract_else_legacy_body"}


def freeze_candidate_split(candidates: list[Mapping[str, Any]], *, size: int = 256,
                           seed: int = 0, split_mode: str = "group_seeded") -> list[dict[str, Any]]:
    """Freeze one highest-ranked representative per group before teacher labeling."""
    if type(size) is not int or size < 1 or type(seed) is not int:
        raise ValueError("Frozen size must be positive and split seed must be an integer")
    if split_mode not in {"group_seeded", "legacy_rank_interleaved"}:
        raise ValueError("Unknown frozen split mode")
    groups = _candidate_groups(candidates)
    if len(groups) < size:
        raise ValueError(f"Need {size} independent candidate groups, got {len(groups)}")
    chosen = groups[:size]
    positions = list(range(size))
    if split_mode == "group_seeded":
        random.Random(seed).shuffle(positions)
        train = set(positions[:size // 2])
    else:
        train = {i for i in positions if (i + 1) % 2 == 0}
    result = []
    for i, group in enumerate(chosen):
        tokens = sorted(set().union(*(_group_tokens(candidates[j]) for j in group)))
        result.append({**dict(candidates[group[0]]), "rank": group[0] + 1,
            "split": "train" if i in train else "test", "split_seed": seed,
            "split_mode": split_mode, "split_group_key": hashlib.sha256(json.dumps(tokens).encode()).hexdigest()})
    validate_group_holdout(result)
    return result


def write_condition(output: Path, condition: Mapping[str, Any], candidates: list[Mapping[str, Any]],
                    *, size: int = 256, seed: int = 0, split_mode: str = "group_seeded") -> dict[str, Any]:
    """Persist the full deduplicated retrieval union and its fixed 1:1 sample."""
    rows = freeze_candidate_split(candidates, size=size, seed=seed, split_mode=split_mode)
    output.mkdir(parents=True, exist_ok=True)
    union_path = output / "recall_union.jsonl"
    union_path.write_text("".join(json.dumps(dict(row), ensure_ascii=False) + "\n" for row in candidates), encoding="utf-8")
    data_path = output / "candidates.jsonl"
    data_path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    manifest = {
        **dict(condition),
        "candidate_count": len(rows),
        "split_seed": seed, "split_mode": split_mode,
        "group_duplicate_exclusions_before_split": len(candidates) - len(_candidate_groups(candidates)),
        **validate_group_holdout(rows),
        "recall_union_count": len(candidates),
        "exact_body_duplicate_exclusions_before_split": max(0, len(candidates) - len({hashlib.sha256(re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(row.get("body", "")))).strip().encode()).hexdigest() for row in candidates})) if all(row.get("body") for row in candidates) else None,
        "train_count": sum(row["split"] == "train" for row in rows),
        "test_count": sum(row["split"] == "test" for row in rows),
        "candidate_sha256": digest(data_path),
        "recall_union_sha256": digest(union_path),
        "label_status": "not_labeled",
        "test_role": "frozen held-out pseudo-label agreement only; never used for fitting or threshold selection",
        "quality_scope": "retrieved candidate pool; not full-corpus recall or human-adjudicated truth",
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def load_labeled_condition(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows = read_jsonl(path)
    validate_group_holdout(rows)
    train, test = [], []
    for row in rows:
        if row.get("label") not in (0, 1) or row.get("label_source") != "deepseek-v4.1-flash":
            raise ValueError(f"{row.get('ticket_id')}: expected a DS V4.1 Flash pseudo-label")
        (train if row["split"] == "train" else test).append(row)
    if len(train) != len(test):
        raise ValueError(f"Frozen train/test sizes differ: {len(train)} != {len(test)}")
    return train, test
