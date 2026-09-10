from __future__ import annotations

from pathlib import Path

import pytest

from retrieval_agent_model_service.query_analysis import SpacyQueryAnalyzer


PROJECT_ROOT = Path(__file__).resolve().parents[3]
MODEL_PATH = PROJECT_ROOT / "models" / "zh_core_web_sm-3.8.0"
LEXICON_PATH = PROJECT_ROOT / "config" / "query-domain-lexicon.json"


@pytest.fixture(scope="module")
def analyzer() -> SpacyQueryAnalyzer:
    result = SpacyQueryAnalyzer(MODEL_PATH, LEXICON_PATH)
    result.load()
    return result


def test_extracts_exact_conjuncts_without_query_scaffolding(analyzer: SpacyQueryAnalyzer) -> None:
    result = analyzer.analyze("帮我找副卡和跨域有关工单")
    assert result["language"] == "zh"
    assert result["keywords"] == ["副卡", "跨域"]
    assert result["boolean"] == {
        "operator": "and", "terms": ["副卡", "跨域"], "grouping": "single_set",
    }
    assert result["triples"][0] == {
        "subject": "副卡", "predicate": "and", "object": "跨域", "source": "coordination",
    }


def test_removes_reduplicated_search_scaffolding(analyzer: SpacyQueryAnalyzer) -> None:
    result = analyzer.analyze("帮我找找主卡有关工单")
    assert result["keywords"] == ["主卡"]


def test_task_instruction_terms_stay_out_of_keywords(analyzer: SpacyQueryAnalyzer) -> None:
    # “历史、告诉、原因”是对结果的任务指令，不是工单内容；进入关键词通道会污染 AND 约束。
    result = analyzer.analyze("找 3 条副卡无法使用的历史工单，告诉我各自是什么原因")
    assert result["keywords"] == ["副卡无法"]


def test_coordination_hint_does_not_discard_other_business_topics(analyzer: SpacyQueryAnalyzer) -> None:
    result = analyzer.analyze("查找3条副卡解绑后仍合账缴费或发生扣费争议的工单")
    assert {"副卡解绑", "合账", "缴费", "扣费", "争议"}.issubset(result["keywords"])
    assert all(term in result["keywords"] for term in result["boolean"]["terms"])


def test_domain_lexicon_merges_multi_token_phrases(analyzer: SpacyQueryAnalyzer) -> None:
    result = analyzer.analyze("帮我找异地补卡和实名认证有关工单")
    assert result["keywords"] == ["异地补卡", "实名认证"]
    assert [item for item in result["candidates"] if item["source"] == "domain_lexicon"] == [
        {"text": "异地补卡", "start": 3, "end": 7, "source": "domain_lexicon", "pos": ["NOUN"]},
        {"text": "实名认证", "start": 8, "end": 12, "source": "domain_lexicon", "pos": ["ADV", "VERB"]},
    ]


def test_without_domain_lexicon_falls_back_to_nouns() -> None:
    analyzer = SpacyQueryAnalyzer(MODEL_PATH, None)
    analyzer.load()
    result = analyzer.analyze("卫星互联网终端离线")
    assert result["keywords"] == ["卫星", "互联网", "终端"]
    assert all(set(item["pos"]) <= {"NOUN", "PROPN"} for item in result["candidates"])


def test_no_usable_keyword_keeps_query_available_for_dense_retrieval(analyzer: SpacyQueryAnalyzer) -> None:
    result = analyzer.analyze("!!!")
    assert result["keywords"] == []
    assert result["candidates"] == []


def test_wire_offsets_use_utf16_after_supplementary_characters(analyzer: SpacyQueryAnalyzer) -> None:
    query = "🔎帮我找北京的副卡和跨域有关工单"
    result = analyzer.analyze(query)
    encoded = query.encode("utf-16-le")
    assert result["candidates"] and result["tokens"] and result["entities"]
    assert result["boolean"]["terms"] == ["副卡", "跨域"]
    for field in ("candidates", "tokens", "entities"):
        for item in result[field]:
            assert encoded[item["start"] * 2:item["end"] * 2].decode("utf-16-le") == item["text"]
