from retrieval_agent_evals import mongo_source
from retrieval_agent_evals.mongo_source import adapt_document, readable_body
from datetime import datetime
import json
import sys
import types


def test_plain_role_dialogue_remains_byte_for_byte_unchanged() -> None:
    body = "【客户】：需要查询\n【坐席】：已帮您处理。"
    assert readable_body(body)[0] == body


def test_known_agent_event_keeps_intent_visible_text_and_following_plain_text() -> None:
    body = (
        "【机器人】：你好呀！"
        '{"type":6666,"info":{"sessionId":"x","workflowState":{},'
        '"intentInfo":{"text":"查找订单退款","recognizedIntentName":"退款"},'
        '"text":"你好呀！已检索到相关记录"}}'
        "后续说明仍是业务文本"
    )
    actual, counts = readable_body(body)
    assert "你好呀" not in actual
    assert "识别意图（模型提取）" in actual
    assert "查找订单退款" in actual
    assert "已检索到相关记录" in actual
    assert "后续说明仍是业务文本" in actual
    assert "sessionId" not in actual
    assert counts["jsonEvents"] == 1


def test_unknown_and_invalid_json_are_preserved() -> None:
    unknown = '【专家】：{"type":"business","info":{"reason":"业务条件"}}'
    malformed = '【客户】：{"ticket": "保留未完成的业务对象'
    assert readable_body(unknown)[0] == unknown
    assert readable_body(malformed)[0] == malformed


def test_adaptation_preserves_complete_body_separately() -> None:
    raw = "【机器人】：您好！{\"type\":1,\"info\":{\"sessionId\":\"s\",\"text\":\"完成\"}}"
    row = adapt_document({
        "_id": "source-1", "group_id": "ticket-1", "large_model_title": "标题",
        "large_model_abstract": "摘要", "origin_conversation": raw,
        "create_time": "2026-09-10 19:45:28.0", "traind_id": "training-label",
    })
    assert row["ticket_id"] == "ticket-1"
    assert row["source_document_id"] == "source-1"
    assert row["raw_body"] == raw
    assert row["body"] == "【机器人】：完成"


def test_numeric_id_and_datetime_are_adapted_without_guessing_timezone() -> None:
    row = adapt_document({
        "group_id": 41, "large_model_title": "标题", "large_model_abstract": "摘要",
        "origin_conversation": "plain", "create_time": datetime(2026, 9, 10, 12, 30),
    })
    assert row["ticket_id"] == "41"
    assert row["created_at"] == "2026-09-10T12:30:00"


def test_export_mongo_uses_custom_mapping_and_scans_until_full_unique_valid_limit(tmp_path, monkeypatch):
    docs = [
        {"_id": 1, "key": "A", "heading": "ha", "abstract": "sa", "conversation": "body a", "time": "2026-09-10T05:00:00"},
        {"_id": 2, "key": "A", "heading": "dup", "abstract": "dup", "conversation": "body dup", "time": "2026-09-09T05:00:00"},
        {"_id": 3, "key": "B", "heading": "hb", "abstract": "sb", "conversation": "  ", "time": "2026-09-08T05:00:00"},
        {"_id": 4, "key": "C", "heading": "hc", "abstract": "sc", "conversation": "body c", "time": "2026-09-07T05:00:00"},
        {"_id": 5, "key": "D", "heading": "hd", "abstract": "sd", "conversation": "body d", "time": "2026-09-06T05:00:00"},
    ]

    class Cursor:
        def sort(self, field, direction):
            assert field == "time" and direction == -1
            return self

        def batch_size(self, size):
            assert size == 200
            return iter(docs)

    class Collection:
        def estimated_document_count(self):
            return 500

        def find(self, query, projection):
            assert "heading" in projection and "conversation" in projection
            return Cursor()

    class Database:
        def __getitem__(self, name):
            assert name == "output_fields_date"
            return Collection()

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        def __getitem__(self, key):
            assert key == "testdb"
            return Database()

        def close(self):
            pass

    fake_pymongo = types.SimpleNamespace(DESCENDING=-1, MongoClient=Client)
    monkeypatch.setitem(sys.modules, "pymongo", fake_pymongo)
    monkeypatch.setattr(mongo_source, "DATABASE", "testdb")
    monkeypatch.setattr(mongo_source, "COLLECTION", "output_fields_date")
    monkeypatch.setattr(mongo_source, "SORT_FIELD", "time")
    output = tmp_path / "tickets.jsonl"
    manifest = mongo_source.export_mongo("mongodb://fake", output, 2, field_map={
        "ticket_id": "key", "title": "heading", "summary": "abstract", "body": "conversation", "created_at": "time",
    })
    rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert [row["ticket_id"] for row in rows] == ["A", "C"]
    assert manifest["selection"]["returned"] == 2
    assert manifest["selection"]["scanned"] == 4
    assert manifest["selection"]["collectionCountEstimate"] == 500
    assert manifest["duplicateTicketIds"] == 1
    assert manifest["missingRequired"] == {"body": 1}
    assert manifest["complete"] is True


def test_mongo_cli_mapping_reaches_export_query_and_canonical_output(tmp_path, monkeypatch):
    docs = [{"_id": 7, "case": "C7", "name": "标题", "abstract": "摘要", "dialog": "原文", "created": "2026-09-01"}]

    class Cursor:
        def sort(self, field, direction):
            assert field == "created" and direction == -1
            return self

        def batch_size(self, size):
            return iter(docs)

    class Collection:
        def estimated_document_count(self):
            return 1

        def find(self, query, projection):
            assert {"case", "name", "abstract", "dialog", "created"}.issubset(projection)
            return Cursor()

    class Database:
        def __getitem__(self, name):
            assert name == "cases"
            return Collection()

    class Client:
        def __init__(self, uri, **kwargs):
            assert uri == "mongodb://unit-test"

        def __getitem__(self, name):
            assert name == "example"
            return Database()

        def close(self):
            pass

    monkeypatch.setitem(sys.modules, "pymongo", types.SimpleNamespace(DESCENDING=-1, MongoClient=Client))
    monkeypatch.setenv("CASEWEAVE_MONGO_URI", "mongodb://unit-test")
    mapping = tmp_path / "mapping.json"
    mapping.write_text(json.dumps({"ticket_id": "case", "title": "name", "summary": "abstract",
                                   "body": "dialog", "created_at": "created"}), encoding="utf-8")
    output = tmp_path / "canonical.jsonl"
    monkeypatch.setattr(sys, "argv", ["mongo_source", "--output", str(output), "--limit", "1",
        "--mapping-json", str(mapping), "--database", "example", "--collection", "cases", "--time-field", "created"])
    assert mongo_source.main() == 0
    row = json.loads(output.read_text(encoding="utf-8").strip())
    assert (row["ticket_id"], row["title"], row["summary"], row["body"]) == ("C7", "标题", "摘要", "原文")


def test_month_export_passes_indexed_range_and_keeps_missing_body(tmp_path, monkeypatch):
    queries = []
    monkeypatch.setattr(mongo_source, "COLLECTION", "output_fields_date")
    monkeypatch.setattr(mongo_source, "SORT_FIELD", "create_time")
    monkeypatch.setattr(mongo_source, "FIELD_MAP", {"ticket_id": "group_id", "title": "large_model_title", "summary": "large_model_abstract", "body": "origin_conversation", "created_at": "create_time"})
    docs = [{"_id": 1, "group_id": "A", "large_model_title": "标题",
             "large_model_abstract": "摘要", "create_time": "2026-10-01 10:00:00.0"}]

    class Cursor:
        def sort(self, field, direction):
            return self

        def batch_size(self, size):
            return iter(docs)

    class Collection:
        def estimated_document_count(self):
            return 9

        def find(self, query, projection):
            queries.append(query)
            assert "origin_conversation" not in projection
            assert "content" not in projection
            assert "user_business_line_two" in projection
            return Cursor()

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        def __getitem__(self, key):
            return {"output_fields_date": Collection()}

        def close(self):
            pass

    monkeypatch.setitem(sys.modules, "pymongo", types.SimpleNamespace(DESCENDING=-1, MongoClient=Client))
    query = {"create_time": {"$gte": "2026-09-09 00:00:00", "$lt": "2026-10-09 12:00:00"}}
    output = tmp_path / "month.jsonl"
    manifest = mongo_source.export_mongo("mongodb://fake", output, 1, query=query, require_body=False, title_abstract_only=True)
    assert queries == [query]
    assert manifest["records"] == 1
    assert manifest["selection"]["query"] == query
    assert json.loads(output.read_text(encoding="utf-8"))["body"] == ""
