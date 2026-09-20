from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Mapping

from .models import EvalCase, ProductTrace


@dataclass(frozen=True)
class ScoredCheck:
    name: str
    passed: bool
    detail: str


@dataclass(frozen=True)
class EvaluationResult:
    case_id: str
    trace_id: str
    blocking_checks: tuple[ScoredCheck, ...]
    metrics: Mapping[str, float]
    business_checks: tuple[ScoredCheck, ...]

    @property
    def engineering_passed(self) -> bool:
        return all(check.passed for check in self.blocking_checks)

    @property
    def task_success(self) -> bool:
        return self.engineering_passed and all(check.passed for check in self.business_checks)

    @property
    def passed(self) -> bool:
        return self.task_success

    def to_mapping(self) -> Mapping[str, Any]:
        return {
            "caseId": self.case_id,
            "traceId": self.trace_id,
            "passed": self.passed,
            "engineeringPassed": self.engineering_passed,
            "taskSuccess": self.task_success,
            "blockingChecks": [asdict(check) for check in self.blocking_checks],
            "businessChecks": [asdict(check) for check in self.business_checks],
            "metrics": dict(self.metrics),
        }


def _state_events(trace: ProductTrace) -> tuple[Mapping[str, Any], ...]:
    result = []
    for event in trace.events:
        if event.get("type") != "retrieval/state-recorded":
            continue
        data = event.get("data")
        state = data.get("state") if isinstance(data, Mapping) else None
        if isinstance(state, Mapping):
            result.append(state)
    return tuple(result)


def _candidate_display_ids(trace: ProductTrace, states: tuple[Mapping[str, Any], ...]) -> set[str]:
    result: set[str] = set()
    for state in states:
        candidates = state.get("candidates", [])
        if not isinstance(candidates, list):
            continue
        for candidate in candidates:
            if isinstance(candidate, Mapping) and isinstance(candidate.get("displayId"), str):
                result.add(candidate["displayId"])
    for event in trace.events:
        if event.get("type") != "retrieval/search-completed":
            continue
        data = event.get("data")
        page = data.get("page") if isinstance(data, Mapping) else None
        candidates = page.get("candidates", []) if isinstance(page, Mapping) else []
        if isinstance(candidates, list):
            result.update(
                candidate["displayId"]
                for candidate in candidates
                if isinstance(candidate, Mapping) and isinstance(candidate.get("displayId"), str)
            )
    return result


def _frozen_references(trace: ProductTrace, states: tuple[Mapping[str, Any], ...]) -> dict[str, set[str]]:
    pack = None
    for event in trace.events:
        if event.get("type") == "retrieval/evidence-frozen" and isinstance(event.get("data"), Mapping):
            candidate = event["data"].get("pack")
            if isinstance(candidate, Mapping):
                pack = candidate
    if pack is None and states:
        candidate = states[-1].get("frozenEvidence")
        if isinstance(candidate, Mapping):
            pack = candidate
    if not isinstance(pack, Mapping):
        return {}
    references: dict[str, set[str]] = {}
    candidates = pack.get("candidates", [])
    if not isinstance(candidates, list):
        return references
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        display_id = candidate.get("displayId")
        raw_evidence = candidate.get("evidenceIds", [])
        if isinstance(display_id, str) and isinstance(raw_evidence, list):
            references[display_id] = {item for item in raw_evidence if isinstance(item, str)}
    return references


def evaluate_trace(case: EvalCase, trace: ProductTrace) -> EvaluationResult:
    states = _state_events(trace)
    sequences = [event.get("sequence") for event in trace.events]
    sequence_valid = sequences == list(range(len(sequences)))
    exposed = (
        set(trace.model_visible_display_ids)
        | set(trace.ui_visible_display_ids)
        | set(trace.final_display_ids)
        | _candidate_display_ids(trace, states)
    )
    leaked = sorted(exposed & case.forbidden_display_ids)
    references = _frozen_references(trace, states)
    frozen_display_ids = set(references)
    frozen_evidence_ids = set().union(*references.values()) if references else set()
    unknown_final_ids = sorted(set(trace.final_display_ids) - frozen_display_ids)
    unknown_evidence_ids = sorted(set(trace.final_evidence_ids) - frozen_evidence_ids)
    candidate_count = len(set(trace.ui_visible_display_ids))
    termination = states[-1].get("termination") if states else None
    for event in trace.events:
        if event.get("type") == "retrieval/stopped" and isinstance(event.get("data"), Mapping):
            termination = event["data"].get("reason")
    termination_valid = case.expected_termination is None or termination == case.expected_termination

    final_ids = set(trace.final_display_ids)
    relevant_hits = len(final_ids & case.relevant_display_ids)
    recall = relevant_hits / len(case.relevant_display_ids) if case.relevant_display_ids else float(not final_ids)
    precision = relevant_hits / len(final_ids) if final_ids else float(not case.relevant_display_ids)

    # 旧轨迹只支持按冻结归属检查 ID；正文引用另查工单、证据和原文片段的同一对应关系。
    used_evidence = set(trace.final_evidence_ids)
    missing_evidence = sorted(ticket for ticket in final_ids if not references.get(ticket, set()) & used_evidence)
    unrelated_evidence = used_evidence - set().union(*(references.get(ticket, set()) for ticket in final_ids))
    sources = {(item["displayId"], item["evidenceId"]): item["text"] for item in trace.source_evidence}
    citations_valid = all(
        item.get("displayId") in final_ids
        and item.get("evidenceId") in references.get(item.get("displayId"), set())
        and item.get("evidenceId") in used_evidence
        and isinstance(item.get("quote"), str) and bool(item["quote"].strip())
        and item["quote"] in sources.get((item.get("displayId"), item.get("evidenceId")), "")
        for item in trace.final_citations)
    if trace.final_citations or trace.source_evidence:
        citations_valid &= {c.get("displayId") for c in trace.final_citations} == final_ids
        citations_valid &= {c.get("evidenceId") for c in trace.final_citations} == used_evidence

    checks = (
        ScoredCheck("event_sequence_contiguous", sequence_valid, f"sequences={sequences}"),
        ScoredCheck("authorization_no_leak", not leaked, f"forbidden_exposed={leaked}"),
        ScoredCheck("final_display_refs_frozen", not unknown_final_ids, f"unknown={unknown_final_ids}"),
        ScoredCheck("final_evidence_refs_frozen", not unknown_evidence_ids, f"unknown={unknown_evidence_ids}"),
        ScoredCheck("final_evidence_belongs_to_ticket", not missing_evidence and not unrelated_evidence,
                    f"missing={missing_evidence}, unrelated={sorted(unrelated_evidence)}"),
        ScoredCheck("citation_content", citations_valid, "quotes must occur in the cited ticket evidence"),
        ScoredCheck("candidate_limit", candidate_count <= case.max_candidates, f"count={candidate_count}, max={case.max_candidates}"),
        ScoredCheck("expected_termination", termination_valid, f"actual={termination!r}, expected={case.expected_termination!r}"),
    )
    return EvaluationResult(
        case_id=case.case_id,
        trace_id=trace.trace_id,
        blocking_checks=checks,
        metrics={"precision": precision, "recall": recall},
        business_checks=(
            ScoredCheck("executed_to_completion", bool(trace.events) and termination in {"sufficient", "top_k_accepted", "no_result"},
                        f"termination={termination!r}"),
            ScoredCheck("correct_result_set", final_ids == case.relevant_display_ids and len(final_ids) == len(trace.final_display_ids),
                        f"missing={sorted(case.relevant_display_ids - final_ids)}, extra={sorted(final_ids - case.relevant_display_ids)}"),
            ScoredCheck("expected_verdicts", all(trace.final_verdicts.get(k) == v for k, v in case.expected_verdicts.items()),
                        "undetermined and exclude are distinct; missing decisions do not match"),
            ScoredCheck("source_content_available", not final_ids or bool(trace.final_citations) and bool(trace.source_evidence),
                        "legacy ID-only exports support engineering checks, not evidence-backed business success"),
            ScoredCheck("required_facts", not case.require_facts or bool(trace.final_answer.strip()) and trace.facts_passed is True,
                        "required facts need an answer and a separate external factual judgment"),
        ),
    )
