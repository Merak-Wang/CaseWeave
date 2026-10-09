from dataclasses import FrozenInstanceError
import pytest
from retrieval_agent_evals.canonical import (
    PROJECTION_VERSION, canonical_ticket_view, canonical_ticket_text,
    canonical_content_hash, canonical_embedding_cache_key,
)


def record(**updates):
    return {"title": "合成标题", "summary": "合成摘要", "body": "正文只属于旧对照", **updates}


def test_canonical_uses_only_two_fields_and_is_immutable():
    view = canonical_ticket_view(record())
    assert view.text == "【标题】合成标题\n【摘要】合成摘要"
    assert view.projection_version == PROJECTION_VERSION
    assert view.as_payload() == {"projection_version": PROJECTION_VERSION,
                                 "title": "合成标题", "abstract": "合成摘要"}
    with pytest.raises(FrozenInstanceError):
        view.title = "changed"


def test_source_fields_take_precedence_over_adapted_fields():
    row = record(large_model_title="原字段标题", large_model_abstract="原字段摘要")
    assert canonical_ticket_text(row) == "【标题】原字段标题\n【摘要】原字段摘要"
    with pytest.raises(ValueError):
        canonical_ticket_text(record(large_model_title=""))


@pytest.mark.parametrize("field,value", [("title", ""), ("summary", " \t "),
                                         ("title", None), ("summary", 123)])
def test_missing_text_never_falls_back_to_body(field, value):
    with pytest.raises(ValueError):
        canonical_ticket_text(record(**{field: value}))


def test_body_metadata_and_identity_do_not_contaminate_content_hash():
    a = record(ticket_id="synthetic-a", metadata={"x": 1})
    b = record(ticket_id="synthetic-b", body="different", metadata={"x": 2})
    assert canonical_content_hash(a) == canonical_content_hash(b)
    assert canonical_content_hash(a) != canonical_content_hash(record(summary="changed"))


def test_full_text_is_preserved_and_line_endings_are_canonical():
    long = "合成" * 5000
    view = canonical_ticket_view(record(summary=long))
    assert view.abstract == long and len(view.text) > 10000
    assert canonical_content_hash(record(title="A\r\nB")) == canonical_content_hash(record(title="A\nB"))


def test_embedding_cache_identity_includes_every_semantic_dependency():
    args = {"model": "synthetic-model", "revision": "revision-a", "dimensions": 8,
            "instruction": "instruction-a"}
    first = canonical_embedding_cache_key(record(), **args)
    for field, changed in [("model", "another-model"), ("revision", "revision-b"),
                           ("dimensions", 16), ("instruction", "instruction-b")]:
        assert canonical_embedding_cache_key(record(), **{**args, field: changed}) != first
    assert canonical_embedding_cache_key(record(body="other body"), **args) == first
    with pytest.raises(ValueError):
        canonical_embedding_cache_key(record(), **{**args, "normalization": "none"})
