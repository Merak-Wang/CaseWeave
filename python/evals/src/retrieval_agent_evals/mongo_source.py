"""从只读 Mongo 集合导出带来源映射的生产工单评测集。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping


DATABASE = "iop_ai_data"
COLLECTION = "output_fields_date"
SORT_FIELD = "create_time"
FIELD_MAP = {
    "ticket_id": "group_id",
    "title": "large_model_title",
    "summary": "large_model_abstract",
    "body": "origin_conversation",
    "created_at": "create_time",
}
SOURCE_FIELDS = (
    "question", "content", "answer", "solution", "description", "error_msg",
    "business_name", "business_label_full", "first_business_label",
    "second_business_label", "first_root_label", "second_root_label",
    "third_root_label", "root_label_full", "group_id", "group_name", "msg_id",
    "group_type", "channel_field", "channel_line", "channel_name",
    "province_name", "city_name", "team_line", "last_team_line", "traind_id",
    "user_business_line_one", "user_business_line_two",
)
ROLE_HEADER = re.compile(r"(?m)^【([^】]+)】[:：]")
GREETING_ONLY = re.compile(r"^\s*(?:您好|你好|嗨|早上好|下午好|晚上好)[呀啊！!，,。\s]*$")
FIXED_BOT_GREETING = re.compile(r"^\s*你好呀！\s*")


def readable_body(raw: str) -> tuple[str, dict[str, int]]:
    """按原角色/事件顺序抽取可见话语；机器事件原文始终留在 raw_body。"""
    decoder = json.JSONDecoder()
    counters = Counter()
    result: list[str] = []

    def is_greeting(text: str, role: str) -> bool:
        return role == "机器人" and bool(GREETING_ONLY.fullmatch(text.strip()))

    def clean_bot_greeting(text: str, role: str) -> str:
        if role != "机器人":
            return text
        cleaned = FIXED_BOT_GREETING.sub("", text)
        if cleaned != text:
            counters["filteredGreetings"] += 1
        if not cleaned.strip() or is_greeting(cleaned, role):
            counters["filteredGreetings"] += bool(cleaned.strip())
            return ""
        return cleaned

    matches = list(ROLE_HEADER.finditer(raw))
    if not matches:
        return raw, {"plainRecords": 1}
    if raw[:matches[0].start()].strip():
        result.append(raw[:matches[0].start()])
        counters["plainPrefixes"] += 1
    adapted_events = 0
    body_changed = False
    for index, match in enumerate(matches):
        role = match.group(1)
        end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
        segment = raw[match.end():end]
        cursor = 0
        chunks: list[tuple[str, Any]] = []
        changed = False
        while cursor < len(segment):
            brace = segment.find("{", cursor)
            if brace < 0:
                chunks.append(("text", segment[cursor:]))
                break
            chunks.append(("text", segment[cursor:brace]))
            try:
                event, object_end = decoder.raw_decode(segment, brace)
            except json.JSONDecodeError:
                chunks.append(("text", segment[brace:]))
                break
            info = event.get("info") if isinstance(event, dict) else None
            bot_role = role == "机器人" or "智能体" in role
            recognized = isinstance(info, dict) and event.get("type") is not None and (
                bot_role or any(key in info for key in ("workflowState", "sessionId", "tokenUsageList", "answerTimeStart"))
            )
            if not recognized:
                chunks.append(("text", segment[brace:object_end]))
                cursor = object_end
                continue
            changed = True
            adapted_events += 1
            counters["jsonEvents"] += 1
            chunks.append(("event", info))
            cursor = object_end
        if not changed:
            text = clean_bot_greeting(segment, role)
            body_changed |= text != segment
            if text.strip():
                result.append(raw[match.start():match.end()] + text if text != segment else raw[match.start():end])
            counters["plainRecords"] += 1
            continue
        prefix = raw[match.start():match.end()]
        first_text = True
        for kind, value in chunks:
            if kind == "text":
                if not value.strip():
                    continue
                value = clean_bot_greeting(value, role)
                if not value.strip():
                    continue
                result.append((prefix if first_text else "【" + role + "】：") + value)
                first_text = False
            else:
                intent = value.get("intentInfo")
                if isinstance(intent, dict) and isinstance(intent.get("text"), str) and intent["text"].strip():
                    result.append(prefix + "【识别意图（模型提取）】" + intent["text"])
                    counters["intentTexts"] += 1
                text = value.get("text")
                if isinstance(text, str) and text.strip():
                    text = clean_bot_greeting(text, role)
                    if text.strip():
                        result.append(prefix + text)
                        counters["visibleTexts"] += 1
        counters["roleSegments"] += 1
    if not adapted_events and not body_changed:
        return raw, {"plainRecords": 1}
    if not result:
        return "", dict(counters)
    return "\n".join(result), dict(counters)


def adapt_document(document: Mapping[str, Any], field_map: Mapping[str, str] | None = None) -> dict[str, Any]:
    """将原始字段映射到评测契约；缺失留空并由 manifest 明示。"""
    field_map = field_map or FIELD_MAP
    text = lambda key: document.get(key) if isinstance(document.get(key), str) else ""
    raw_id = document.get(field_map["ticket_id"])
    ticket_id = raw_id if isinstance(raw_id, str) else str(raw_id) if raw_id is not None else ""
    raw_time = document.get(field_map["created_at"])
    created_at = raw_time if isinstance(raw_time, str) else raw_time.isoformat() if hasattr(raw_time, "isoformat") else ""
    raw_body = text(field_map["body"])
    body, _ = readable_body(raw_body)
    return {
        "ticket_id": ticket_id,
        "source_document_id": str(document.get("_id", "")),
        "title": text(field_map["title"]),
        "summary": text(field_map["summary"]),
        "body": body,
        "raw_body": raw_body,
        "created_at": created_at,
        "source_fields": {key: document.get(key) for key in SOURCE_FIELDS if document.get(key) not in (None, "")},
    }


def export_documents(documents: Iterable[Mapping[str, Any]], output: Path, *, requested: int,
                     collection_count: int, sort_field: str = SORT_FIELD) -> dict[str, Any]:
    """流式写入 canonical JSONL，同时累计字段缺失与身份重复画像。"""
    output.parent.mkdir(parents=True, exist_ok=True)
    missing = Counter()
    ids = set()
    duplicates = 0
    count = 0
    dates: list[str] = []
    digest = hashlib.sha256()
    with output.open("w", encoding="utf-8", newline="\n") as stream:
        for raw in documents:
            row = adapt_document(raw)
            count += 1
            for name in FIELD_MAP:
                if not row[name].strip():
                    missing[name] += 1
            if row["ticket_id"] in ids:
                duplicates += 1
            ids.add(row["ticket_id"])
            if row["created_at"]:
                dates.append(row["created_at"])
            line = json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
            stream.write(line)
            digest.update(line.encode("utf-8"))
            if count % 500 == 0:
                stream.flush()
    manifest = {
        "source": {"database": DATABASE, "collection": COLLECTION},
        "selection": {"sortField": sort_field, "direction": "descending", "requested": requested,
                      "returned": count, "collectionCount": collection_count},
        "fieldMap": FIELD_MAP,
        "sourceFields": list(SOURCE_FIELDS),
        "missingRequired": {name: missing[name] for name in FIELD_MAP},
        "uniqueTicketIds": len(ids) - (1 if "" in ids else 0),
        "duplicateTicketIds": duplicates,
        "timeRange": {"newest": dates[0] if dates else None, "oldest": dates[-1] if dates else None},
        "exportedAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "records": count,
        "ticketsSha256": digest.hexdigest(),
    }
    manifest_path = output.with_suffix(".manifest.json")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def export_mongo(uri: str, output: Path, limit: int = 20_000, *, field_map: Mapping[str, str] | None = None,
                 query: Mapping[str, Any] | None = None, require_body: bool = True,
                 title_abstract_only: bool = False) -> dict[str, Any]:
    """按时间倒序流读，跳过缺字段和重复工单，直到收齐有效唯一工单。"""
    from pymongo import DESCENDING, MongoClient

    client = MongoClient(uri, serverSelectionTimeoutMS=10_000, connectTimeoutMS=5_000,
                         appname="caseweave-eval-readonly")
    collection = client[DATABASE][COLLECTION]
    try:
        count = collection.estimated_document_count()
        mapping = dict(field_map or FIELD_MAP)
        projection = {**{field: 1 for field in (*mapping.values(), *SOURCE_FIELDS)}, "_id": 1}
        if title_abstract_only:
            # 实验核心只传输标题摘要与轻量来源字段；未取的原文保留空值，不替造。
            for field in (mapping["body"], "question", "content", "answer", "solution", "description", "error_msg"):
                projection.pop(field, None)
        documents = collection.find(dict(query or {}), projection).sort(SORT_FIELD, DESCENDING).batch_size(200)
        output.parent.mkdir(parents=True, exist_ok=True)
        seen: set[str] = set()
        missing = Counter()
        body_counts = Counter()
        duplicates = 0
        scanned = 0
        dates: list[str] = []
        raw_chars = readable_chars = source_ids = 0
        digest = hashlib.sha256()
        with output.open("w", encoding="utf-8", newline="\n") as stream:
            for raw in documents:
                scanned += 1
                row = adapt_document(raw, mapping)
                required = ("ticket_id", "title", "summary", "body") if require_body else ("ticket_id", "title", "summary")
                absent = [key for key in required if not row[key].strip()]
                for key in absent:
                    missing[key] += 1
                if absent:
                    continue
                if row["ticket_id"] in seen:
                    duplicates += 1
                    continue
                seen.add(row["ticket_id"])
                source_ids += bool(row["source_document_id"])
                raw_chars += len(row["raw_body"])
                readable_chars += len(row["body"])
                body_counts.update(readable_body(row["raw_body"])[1])
                if row["created_at"]:
                    dates.append(row["created_at"])
                line = json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
                stream.write(line)
                digest.update(line.encode("utf-8"))
                if len(seen) % 500 == 0:
                    stream.flush()
                if len(seen) == limit:
                    break
        manifest = {
            "source": {"database": DATABASE, "collection": COLLECTION},
            "selection": {"sortField": SORT_FIELD, "direction": "descending", "requested": limit,
                          "returned": len(seen), "scanned": scanned, "collectionCountEstimate": count,
                          "query": dict(query or {}), "requireBody": require_body,
                          "projection": "title_abstract_metadata" if title_abstract_only else "full_evidence"},
            "identityField": mapping["ticket_id"], "fieldMap": mapping,
            "sourceFields": [field for field in SOURCE_FIELDS if field in projection],
            "missingRequired": dict(missing),
            "duplicateTicketIds": duplicates,
            "sourceDocumentIdsPresent": source_ids,
            "bodyAdaptation": {"strategy": "role-event-visible-text-v1", "counts": dict(body_counts),
                               "rawCharacters": raw_chars, "readableCharacters": readable_chars},
            "timeRange": {"newest": dates[0] if dates else None, "oldest": dates[-1] if dates else None},
            "exportedAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "records": len(seen), "complete": len(seen) == limit,
            "ticketsSha256": digest.hexdigest(),
        }
        output.with_suffix(".manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return manifest
    finally:
        client.close()


def adapt_snapshot(snapshot: Path, output: Path, uri: str, limit: int = 20_000) -> dict[str, Any]:
    """改用group_id去重原快照，必要时仅补取尾部文档并关联Mongo _id。"""
    from pymongo import DESCENDING, MongoClient

    rows = (json.loads(line) for line in snapshot.open(encoding="utf-8") if line.strip())
    chosen: list[dict[str, Any]] = []
    groups = set()
    body_counts = Counter()
    missing = Counter()
    raw_count = 0
    body_hashes = set()
    triple_hashes = set()
    duplicate_bodies = duplicate_triples = 0
    for old in rows:
        raw_count += 1
        source = dict(old.get("source_fields", {}))
        source.setdefault("traind_id", old.get("ticket_id", ""))
        raw_body = old.get("raw_body", old.get("body", ""))
        group_id = source.get("group_id") or ""
        mongo_doc = {"group_id": group_id, "large_model_title": old.get("title", ""),
                     "large_model_abstract": old.get("summary", ""),
                     "origin_conversation": raw_body, "create_time": old.get("created_at", ""),
                     **source}
        adapted = adapt_document(mongo_doc)
        adapted["source_document_id"] = old.get("source_document_id", "")
        if any(not adapted[name].strip() for name in ("ticket_id", "title", "summary", "raw_body", "created_at")):
            for key in ("ticket_id", "title", "summary", "raw_body", "created_at"):
                missing[key] += not bool(adapted[key].strip())
            continue
        if group_id in groups:
            continue
        groups.add(group_id)
        body_counts.update(readable_body(adapted["raw_body"])[1])
        bh = hashlib.sha256(adapted["raw_body"].encode()).digest()
        th = hashlib.sha256((adapted["title"] + "\0" + adapted["summary"] + "\0" + adapted["raw_body"]).encode()).digest()
        duplicate_bodies += bh in body_hashes
        duplicate_triples += th in triple_hashes
        body_hashes.add(bh)
        triple_hashes.add(th)
        chosen.append(adapted)
        if len(chosen) == limit:
            break
    snapshot_selected = len(chosen)

    client = MongoClient(uri, serverSelectionTimeoutMS=10_000, connectTimeoutMS=5_000,
                         appname="caseweave-eval-readonly")
    collection = client[DATABASE][COLLECTION]
    try:
        # 只读ID与时间索引，仅传输小型身份投影以补齐来源身份。
        identities: dict[tuple[str, str], str] = {}
        if any(not row["source_document_id"] for row in chosen[:raw_count]):
            identity_rows = collection.find({}, {"_id": 1, "group_id": 1, "create_time": 1}).sort(SORT_FIELD, DESCENDING).limit(raw_count)
            for row in identity_rows:
                identities.setdefault((row.get("group_id", ""), row.get("create_time", "")), str(row["_id"]))
        supplement = collection.find({},
            {field: 1 for field in ("_id", *FIELD_MAP.values(), *SOURCE_FIELDS)}).sort(SORT_FIELD, DESCENDING)
        if raw_count:
            supplement = supplement.skip(raw_count)
        scanned_supplement = 0
        for raw in supplement:
            if len(chosen) >= limit:
                break
            scanned_supplement += 1
            adapted = adapt_document(raw)
            if any(not adapted[name].strip() for name in ("ticket_id", "title", "summary", "raw_body", "created_at")):
                for key in ("ticket_id", "title", "summary", "raw_body", "created_at"):
                    missing[key] += not bool(adapted[key].strip())
                continue
            if adapted["ticket_id"] in groups:
                continue
            groups.add(adapted["ticket_id"])
            adapted["source_document_id"] = str(raw["_id"])
            body_counts.update(readable_body(adapted["raw_body"])[1])
            bh = hashlib.sha256(adapted["raw_body"].encode()).digest()
            th = hashlib.sha256((adapted["title"] + "\0" + adapted["summary"] + "\0" + adapted["raw_body"]).encode()).digest()
            duplicate_bodies += bh in body_hashes
            duplicate_triples += th in triple_hashes
            body_hashes.add(bh)
            triple_hashes.add(th)
            chosen.append(adapted)
        for row in chosen:
            if not row["source_document_id"]:
                row["source_document_id"] = identities.get((row["ticket_id"], row["created_at"]), "")
        output.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        raw_chars = readable_chars = 0
        with output.open("w", encoding="utf-8", newline="\n") as stream:
            for index, row in enumerate(chosen, start=1):
                raw_chars += len(row["raw_body"])
                readable_chars += len(row["body"])
                line = json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
                stream.write(line)
                digest.update(line.encode())
                if index % 500 == 0:
                    stream.flush()
        manifest = {
            "source": {"database": DATABASE, "collection": COLLECTION},
            "inputSnapshot": str(snapshot), "inputSnapshotRecords": raw_count,
            "selection": {"sortField": SORT_FIELD, "direction": "descending", "requested": limit,
                          "returned": len(chosen), "fromSnapshot": snapshot_selected,
                          "supplementScanned": scanned_supplement,
                          "removedRawDocuments": raw_count - snapshot_selected},
            "identityField": "group_id", "fieldMap": FIELD_MAP,
            "missingRequired": dict(missing),
            "duplicateBodies": duplicate_bodies, "duplicateTitleSummaryBody": duplicate_triples,
            "bodyAdaptation": {"strategy": "role-event-visible-text-v1", "counts": dict(body_counts),
                               "rawCharacters": raw_chars, "readableCharacters": readable_chars},
            "sourceDocumentIdsPresent": sum(bool(row["source_document_id"]) for row in chosen),
            "timeRange": {"newest": chosen[0]["created_at"] if chosen else None,
                          "oldest": chosen[-1]["created_at"] if chosen else None},
            "records": len(chosen), "complete": len(chosen) == limit, "ticketsSha256": digest.hexdigest(),
        }
        output.with_suffix(".manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return manifest
    finally:
        client.close()


def main() -> int:
    global DATABASE, COLLECTION, SORT_FIELD
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".cache/evals/production-v1/tickets.adapted.jsonl"))
    parser.add_argument("--limit", type=int, default=20_000)
    parser.add_argument("--adapt-snapshot", type=Path)
    parser.add_argument("--mapping-json", type=Path)
    parser.add_argument("--database", default=DATABASE)
    parser.add_argument("--collection", default=COLLECTION)
    parser.add_argument("--time-field", default=SORT_FIELD)
    parser.add_argument("--since", help="包含的创建时间下界，格式须与 Mongo 时间字段一致")
    parser.add_argument("--until", help="排除的创建时间上界，格式须与 Mongo 时间字段一致")
    parser.add_argument("--filter-json", type=Path, help="额外的只读 Mongo 查询条件")
    parser.add_argument("--title-abstract-only", action="store_true", help="只下载标题摘要和轻量来源字段，不下载原文")
    parser.add_argument("--allow-missing-body", action="store_true", help="仅要求身份、标题和摘要非空，保留缺失原文")
    args = parser.parse_args()
    uri = os.environ["CASEWEAVE_MONGO_URI"]
    mapping = dict(FIELD_MAP)
    custom_mapping = json.loads(args.mapping_json.read_text(encoding="utf-8")) if args.mapping_json else {}
    mapping.update(custom_mapping)
    DATABASE, COLLECTION, SORT_FIELD = args.database, args.collection, args.time_field
    if "created_at" not in custom_mapping:
        mapping["created_at"] = SORT_FIELD
    if args.adapt_snapshot:
        manifest = adapt_snapshot(args.adapt_snapshot, args.output, uri, args.limit)
    else:
        query = json.loads(args.filter_json.read_text(encoding="utf-8")) if args.filter_json else {}
        # 时间范围先交给索引筛选；标题摘要非空在服务器筛选和适配后共同核对。
        time_bounds = {}
        if args.since:
            time_bounds["$gte"] = args.since
        if args.until:
            time_bounds["$lt"] = args.until
        if time_bounds:
            query[SORT_FIELD] = time_bounds
        for field in (mapping["title"], mapping["summary"]):
            query[field] = {"$type": "string", "$regex": r"\S"}
        manifest = export_mongo(uri, args.output, args.limit, field_map=mapping, query=query, require_body=not (args.allow_missing_body or args.title_abstract_only),
                                title_abstract_only=args.title_abstract_only)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0 if manifest.get("complete", manifest.get("records") == args.limit) else 1


if __name__ == "__main__":
    raise SystemExit(main())
