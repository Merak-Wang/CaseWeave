from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _text_tuple(value: object, field: str) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{field} must be a string array")
    return tuple(value)


@dataclass(frozen=True)
class EvalCase:
    case_id: str
    relevant_display_ids: frozenset[str]
    forbidden_display_ids: frozenset[str]
    max_candidates: int
    expected_termination: str | None = None
    expected_verdicts: Mapping[str, str] = field(default_factory=dict)
    require_facts: bool = False

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> EvalCase:
        case_id = _required_text(value.get("caseId"), "caseId")
        relevant = frozenset(_text_tuple(value.get("relevantDisplayIds", []), "relevantDisplayIds"))
        forbidden = frozenset(_text_tuple(value.get("forbiddenDisplayIds", []), "forbiddenDisplayIds"))
        if relevant & forbidden:
            raise ValueError("relevant and forbidden display ids must not overlap")
        max_candidates = value.get("maxCandidates", 20)
        if not isinstance(max_candidates, int) or isinstance(max_candidates, bool) or max_candidates < 0:
            raise ValueError("maxCandidates must be a non-negative integer")
        termination = value.get("expectedTermination")
        if termination is not None:
            termination = _required_text(termination, "expectedTermination")
        return cls(case_id, relevant, forbidden, max_candidates, termination,
                   value.get("expectedVerdicts", {}), value.get("requireFacts", False))


@dataclass(frozen=True)
class ProductTrace:
    trace_id: str
    events: tuple[Mapping[str, Any], ...]
    model_visible_display_ids: tuple[str, ...]
    ui_visible_display_ids: tuple[str, ...]
    final_display_ids: tuple[str, ...]
    final_evidence_ids: tuple[str, ...]
    final_citations: tuple[Mapping[str, Any], ...] = ()
    source_evidence: tuple[Mapping[str, Any], ...] = ()
    final_verdicts: Mapping[str, str] = field(default_factory=dict)
    final_answer: str = ""
    facts_passed: bool | None = None

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> ProductTrace:
        trace_id = _required_text(value.get("traceId"), "traceId")
        raw_events = value.get("events")
        if not isinstance(raw_events, list) or any(not isinstance(event, Mapping) for event in raw_events):
            raise ValueError("events must be an object array")
        return cls(
            trace_id=trace_id,
            events=tuple(raw_events),
            model_visible_display_ids=_text_tuple(value.get("modelVisibleDisplayIds", []), "modelVisibleDisplayIds"),
            ui_visible_display_ids=_text_tuple(value.get("uiVisibleDisplayIds", []), "uiVisibleDisplayIds"),
            final_display_ids=_text_tuple(value.get("finalDisplayIds", []), "finalDisplayIds"),
            final_evidence_ids=_text_tuple(value.get("finalEvidenceIds", []), "finalEvidenceIds"),
            final_citations=tuple(value.get("finalCitations", [])),
            source_evidence=tuple(value.get("sourceEvidence", [])),
            final_verdicts=value.get("finalVerdicts", {}),
            final_answer=value.get("finalAnswer", ""),
            facts_passed=value.get("factsPassed"),
        )
