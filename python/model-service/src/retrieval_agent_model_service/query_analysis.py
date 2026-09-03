from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import ServiceError


CONTENT_POS = frozenset({"NOUN", "PROPN", "VERB", "ADJ"})
NOUN_POS = frozenset({"NOUN", "PROPN"})
CHINESE_DIGITS = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _positive_integer(text: str) -> int | None:
    """把阿拉伯数字或常见中文数字转换成受首轮 Top-K 上限约束的正整数。"""
    if text.isdecimal():
        value = int(text)
    elif text == "十":
        value = 10
    elif "十" in text:
        tens_text, ones_text = text.split("十", 1)
        tens = 1 if not tens_text else CHINESE_DIGITS.get(tens_text)
        ones = 0 if not ones_text else CHINESE_DIGITS.get(ones_text)
        if tens is None or ones is None:
            return None
        value = tens * 10 + ones
    else:
        value = CHINESE_DIGITS.get(text, 0)
    return value if 1 <= value <= 50 else None


@dataclass(frozen=True)
class DomainLexicon:
    """版本化查询词典；只合并原文短语和识别功能词/连接词，不提供同义词改写。"""
    version: str
    phrases: tuple[str, ...]
    function_terms: frozenset[str]
    and_operators: frozenset[str]
    or_operators: frozenset[str]
    separate_markers: frozenset[str]

    @classmethod
    def load(cls, path: Path | None) -> DomainLexicon:
        # 无词典是明确支持的退化模式，此时后续候选只接受名词和专名。
        if path is None:
            return cls("none", (), frozenset(), frozenset(), frozenset(), frozenset())
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ServiceError(500, "NLP_LEXICON_INVALID", "Unable to read the query domain lexicon.") from error
        operators = value.get("booleanOperators") if isinstance(value, dict) else None
        fields = {
            "phrases": value.get("phrases") if isinstance(value, dict) else None,
            "functionTerms": value.get("functionTerms") if isinstance(value, dict) else None,
            "and": operators.get("and") if isinstance(operators, dict) else None,
            "or": operators.get("or") if isinstance(operators, dict) else None,
            "separateMarkers": value.get("separateMarkers") if isinstance(value, dict) else None,
        }
        if (
            not isinstance(value, dict)
            or value.get("schemaVersion") != 1
            or not isinstance(value.get("version"), str)
            or not value["version"].strip()
            or any(not isinstance(items, list) or not all(isinstance(item, str) and item.strip() for item in items) for items in fields.values())
        ):
            raise ServiceError(500, "NLP_LEXICON_INVALID", "The query domain lexicon schema is invalid.")
        return cls(
            value["version"], tuple(dict.fromkeys(fields["phrases"])),
            frozenset(fields["functionTerms"]), frozenset(fields["and"]),
            frozenset(fields["or"]), frozenset(fields["separateMarkers"]),
        )


class SpacyQueryAnalyzer:
    """常驻 spaCy 词性/依存分析器，并可用版本化领域词典合并原文短语。"""

    def __init__(self, model_path: Path, lexicon_path: Path | None) -> None:
        self.model_path = model_path.resolve()
        self.lexicon = DomainLexicon.load(lexicon_path.resolve() if lexicon_path else None)
        self._nlp: Any = None
        self._matcher: Any = None
        self._lock = threading.Lock()
        self._spacy_version = "unloaded"
        self._pipeline_version = "unloaded"

    def load(self) -> None:
        # 模型在服务启动时加载一次；请求处理阶段不会重复创建管线或启动子进程。
        try:
            import spacy
            from spacy.matcher import PhraseMatcher
        except ImportError as error:
            raise ServiceError(500, "RUNTIME_MISSING", "Install the model-service runtime dependency group.") from error
        if not self.model_path.is_dir():
            raise ServiceError(500, "NLP_MODEL_FILES_MISSING", "The configured spaCy pipeline directory is missing.")
        try:
            self._nlp = spacy.load(self.model_path)
        except Exception as error:
            raise ServiceError(500, "NLP_MODEL_LOAD_FAILED", "Unable to load the configured spaCy pipeline.") from error
        required = {"tagger", "parser"}
        if not required.issubset(self._nlp.pipe_names):
            raise ServiceError(500, "NLP_PIPELINE_INCOMPATIBLE", "The spaCy pipeline must provide POS tagging and dependency parsing.")
        self._matcher = PhraseMatcher(self._nlp.vocab, attr="ORTH")
        if self.lexicon.phrases:
            # ORTH 保证只匹配用户输入中的连续原文，不做 lemma 或同义词扩展。
            self._matcher.add("DOMAIN_PHRASE", [self._nlp.make_doc(phrase) for phrase in self.lexicon.phrases])
        self._spacy_version = spacy.__version__
        self._pipeline_version = str(self._nlp.meta.get("version", "unknown"))
        self.analyze("卫星终端离线")

    def descriptor(self) -> dict[str, Any]:
        return {
            "engine": "spacy",
            "engineVersion": self._spacy_version,
            "pipeline": self.model_path.name,
            "pipelineVersion": self._pipeline_version,
            "lexiconVersion": self.lexicon.version,
            "loaded": self._nlp is not None,
            "components": list(self._nlp.pipe_names) if self._nlp is not None else [],
        }

    @staticmethod
    def _span_value(span: Any, source: str) -> dict[str, Any]:
        return {
            "text": span.text,
            "start": span.start_char,
            "end": span.end_char,
            "source": source,
            "pos": list(dict.fromkeys(token.pos_ for token in span)),
        }

    def _candidate_spans(self, doc: Any) -> list[dict[str, Any]]:
        # 领域短语优先占用 token，避免“实名认证”与“实名/认证”同时进入关键词集合。
        domain_spans = [doc[start:end] for _, start, end in self._matcher(doc)] if self._matcher is not None else []
        domain_spans.sort(key=lambda span: (span.start_char, -(span.end_char - span.start_char)))
        selected_domain: list[Any] = []
        occupied: set[int] = set()
        for span in domain_spans:
            indexes = set(range(span.start, span.end))
            if occupied.isdisjoint(indexes):
                selected_domain.append(span)
                occupied.update(indexes)
        # 有词典时允许内容词；无词典时收紧到 NOUN/PROPN，减少通用动词、形容词带来的噪声。
        allowed_pos = CONTENT_POS if self.lexicon.phrases else NOUN_POS
        result = [self._span_value(span, "domain_lexicon") for span in selected_domain]
        for token in doc:
            if (
                token.i in occupied
                or token.pos_ not in allowed_pos
                or token.is_stop
                or token.is_punct
                or token.is_space
                or token.text in self.lexicon.function_terms
            ):
                continue
            result.append(self._span_value(doc[token.i:token.i + 1], "pos"))
        result.sort(key=lambda item: (item["start"], -(item["end"] - item["start"])))
        return list({(item["start"], item["end"]): item for item in result}.values())

    def _boolean(self, doc: Any, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
        # 只在版本化运算符两侧都存在候选时建立逻辑，左右项取距离连接词最近的合格表面词。
        for token in doc:
            operator = "and" if token.text in self.lexicon.and_operators else (
                "or" if token.text in self.lexicon.or_operators else None
            )
            if operator is None:
                continue
            left = [item for item in candidates if item["end"] <= token.idx]
            right = [item for item in candidates if item["start"] >= token.idx + len(token.text)]
            if not left or not right:
                continue
            return {
                "operator": operator,
                "terms": [left[-1]["text"], right[0]["text"]],
                "grouping": "separate_sets" if any(marker in doc.text for marker in self.lexicon.separate_markers) else "single_set",
            }
        return None

    @staticmethod
    def _dependency_triples(doc: Any) -> list[dict[str, str]]:
        """从受限依存结构生成解释用三元组；三元组不会反向扩充首轮关键词。"""
        triples: list[dict[str, str]] = []
        for predicate in doc:
            if predicate.pos_ not in {"VERB", "ADJ"}:
                continue
            subjects = [child for child in predicate.children if child.dep_.startswith("nsubj")]
            objects = [child for child in predicate.children if child.dep_ in {"dobj", "obj", "attr", "xcomp"}]
            for subject in subjects:
                for item in objects:
                    triples.append({"subject": subject.text, "predicate": predicate.text, "object": item.text, "source": "dependency"})
        return triples

    def analyze(self, query: str) -> dict[str, Any]:
        if self._nlp is None:
            raise ServiceError(503, "NOT_READY", "spaCy query analysis is not ready.", retryable=True)
        if not isinstance(query, str) or not query.strip() or len(query) > 2_000:
            raise ServiceError(400, "INVALID_REQUEST", "Query analysis input is invalid.")
        with self._lock:
            # 当前中文管线不是线程安全契约的一部分，用锁保证同一常驻实例上的确定性调用。
            doc = self._nlp(query)
        candidates = self._candidate_spans(doc)
        boolean = self._boolean(doc, candidates)
        # 显式 AND/OR 存在时只把其左右项交给关键词通道；否则使用全部合格 POS/领域候选。
        keywords = boolean["terms"] if boolean is not None else [item["text"] for item in candidates]
        keywords = list(dict.fromkeys(keywords))[:8]
        # 没有可用表面词不是查询失败：完整原始 query 仍交给多语言向量通道。
        triples = self._dependency_triples(doc)
        if boolean is not None:
            triples.insert(0, {
                "subject": boolean["terms"][0], "predicate": boolean["operator"],
                "object": boolean["terms"][1], "source": "coordination",
            })
        entities = [
            {"text": entity.text, "label": entity.label_, "start": entity.start_char, "end": entity.end_char}
            for entity in doc.ents
        ]
        requested_count = next((
            value for entity in doc.ents
            if entity.label_ == "CARDINAL" and entity.end < len(doc) and doc[entity.end].tag_ == "M"
            if (value := _positive_integer(entity.text)) is not None
        ), None)
        visible_tokens = [token for token in doc if not token.is_space]
        # 将 spaCy 的全局 token.i 映射为响应 tokens 数组下标，使 TypeScript 可以独立校验 head 边界。
        visible_indexes = {token.i: index for index, token in enumerate(visible_tokens)}
        tokens = [
            {
                "text": token.text, "start": token.idx, "end": token.idx + len(token.text),
                "lemma": token.lemma_, "pos": token.pos_, "tag": token.tag_, "dep": token.dep_,
                "head": visible_indexes.get(token.head.i, visible_indexes[token.i]),
                "isStop": token.is_stop, "entityType": token.ent_type_,
            }
            for token in visible_tokens
        ]
        # 响应同时携带检索输入和完整 provenance；协议封装由 FastAPI endpoint 追加版本与 requestId。
        return {
            # spaCy 的 doc.lang 是内部 StringStore 哈希；线协议需要可读、可重放的语言代码。
            "language": doc.lang_,
            "keywords": keywords,
            "candidates": candidates,
            "tokens": tokens,
            "entities": entities,
            "triples": triples[:8],
            **({"requestedCount": requested_count} if requested_count is not None else {}),
            **({"boolean": boolean} if boolean is not None else {}),
        }
