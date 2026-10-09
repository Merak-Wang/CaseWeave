import json

import pytest

from retrieval_agent_evals.experiment import freeze_candidate_split, write_condition, validate_group_holdout


def test_split_is_128_by_128_and_identical_body_never_crosses_roles():
    rows = [{"ticket_id": str(i), "body": f"body {i}"} for i in range(300)]
    rows[5]["body"] = rows[4]["body"]
    split = freeze_candidate_split(rows)
    train = {row["ticket_id"] for row in split if row["split"] == "train"}
    test = {row["ticket_id"] for row in split if row["split"] == "test"}
    assert len(train) == len(test) == 128
    train_bodies = {row["body"] for row in split if row["split"] == "train"}
    test_bodies = {row["body"] for row in split if row["split"] == "test"}
    assert not train_bodies & test_bodies
    assert not ({"4", "5"} <= train | test)


def test_write_condition_keeps_union_and_frozen_candidate_file(tmp_path):
    rows = [{"ticket_id": str(i), "body": str(i), "hybrid_score": 1 - i / 300} for i in range(300)]
    manifest = write_condition(tmp_path, {"condition_id": "q1"}, rows)
    assert manifest["recall_union_count"] == 300
    assert manifest["candidate_count"] == 256
    assert manifest["train_count"] == manifest["test_count"] == 128
    assert len((tmp_path / "recall_union.jsonl").read_text().splitlines()) == 300
    assert len((tmp_path / "candidates.jsonl").read_text().splitlines()) == 256
    assert json.loads((tmp_path / "manifest.json").read_text())["test_role"].startswith("frozen")


def test_seeded_group_split_is_reproducible_and_explicit_legacy_is_available():
    rows = [{"ticket_id": str(i), "body": f"synthetic group {i}"} for i in range(20)]
    first = freeze_candidate_split(rows, size=16, seed=7)
    assert first == freeze_candidate_split(rows, size=16, seed=7)
    assert [r["split"] for r in first] != [r["split"] for r in freeze_candidate_split(rows, size=16, seed=8)]
    assert sum(r["split"] == "train" for r in first) == 8
    legacy = freeze_candidate_split(rows, size=16, split_mode="legacy_rank_interleaved")
    assert [r["split"] for r in legacy] == ["test", "train"] * 8
    assert all(r["split_mode"] == "group_seeded" for r in first)


def test_business_and_canonical_alias_chain_has_one_representative():
    rows = [
        {"ticket_id": "a", "group_id": "business-1", "title": "same", "summary": "canonical", "body": "raw-a"},
        {"ticket_id": "b", "group_id": "business-1", "title": "different", "summary": "canonical", "body": "raw-b"},
        {"ticket_id": "c", "title": "different", "summary": "canonical", "body": "raw-c"},
        {"ticket_id": "d", "title": "independent", "summary": "canonical", "body": "raw-d"},
    ]
    split = freeze_candidate_split(rows, size=2)
    assert [r["ticket_id"] for r in split] == ["a", "d"]
    assert validate_group_holdout(split)["group_count"] == 2
    with pytest.raises(ValueError, match="independent candidate groups"):
        freeze_candidate_split(rows, size=3)
    with pytest.raises(ValueError, match="crosses train/test"):
        validate_group_holdout([{**rows[0], "split": "train"}, {**rows[1], "split": "test"}])
    with pytest.raises(ValueError, match="crosses train/test"):
        validate_group_holdout([{**rows[1], "split": "train"}, {**rows[2], "split": "test"}])


def test_legacy_body_normalization_and_missing_text_guard():
    rows = [{"ticket_id": "1", "body": "Ａ  B", "split": "train"},
            {"ticket_id": "2", "body": "A\tB", "split": "test"}]
    with pytest.raises(ValueError, match="crosses train/test"):
        validate_group_holdout(rows)
    with pytest.raises(ValueError, match="text is required"):
        validate_group_holdout([{"ticket_id": "3", "split": "test"}])
    with pytest.raises(ValueError, match="must be train or test"):
        validate_group_holdout([{"ticket_id": "3", "body": "synthetic", "split": "validation"}])


def test_manifest_records_seed_group_contract_and_full_union(tmp_path):
    rows = [{"ticket_id": str(i), "body": f"synthetic {i}"} for i in range(8)]
    rows.append({"ticket_id": "alias", "body": rows[0]["body"]})
    manifest = write_condition(tmp_path, {}, rows, size=8, seed=11)
    assert manifest["split_seed"] == 11 and manifest["split_mode"] == "group_seeded"
    assert manifest["group_holdout_verified"] and manifest["group_count"] == 8
    assert manifest["group_duplicate_exclusions_before_split"] == 1
    assert manifest["recall_union_count"] == 9
