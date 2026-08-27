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

    @property
    def passed(self) -> bool:
        return all(check.passed for check in self.blocking_checks)

    def to_mapping(self) -> Mapping[str, Any]:
        return {
            "caseId": self.case_id,
            "traceId": self.trace_id,
            "passed": self.passed,
            "blockingChecks": [asdict(check) for check in self.blocking_checks],
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


def _candidate_display_ids(states: tuple[Mapping[str, Any], ...]) -> set[str]:
    result: set[str] = set()
    for state in states:
        candidates = state.get("candidates", [])
        if not isinstance(candidates, list):
            continue
        for candidate in candidates:
            if isinstance(candidate, Mapping) and isinstance(candidate.get("displayId"), str):
                result.add(candidate["displayId"])
    return result


def _frozen_allowlists(states: tuple[Mapping[str, Any], ...]) -> tuple[set[str], set[str]]:
    if not states:
        return set(), set()
    pack = states[-1].get("frozenEvidence")
    if not isinstance(pack, Mapping):
        return set(), set()
    display_ids: set[str] = set()
    evidence_ids: set[str] = set()
    candidates = pack.get("candidates", [])
    if not isinstance(candidates, list):
        return display_ids, evidence_ids
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        display_id = candidate.get("displayId")
        if isinstance(display_id, str):
            display_ids.add(display_id)
        raw_evidence = candidate.get("evidenceIds", [])
        if isinstance(raw_evidence, list):
            evidence_ids.update(item for item in raw_evidence if isinstance(item, str))
    return display_ids, evidence_ids


def evaluate_trace(case: EvalCase, trace: ProductTrace) -> EvaluationResult:
    states = _state_events(trace)
    sequences = [event.get("sequence") for event in trace.events]
    sequence_valid = sequences == list(range(len(sequences)))
    exposed = (
        set(trace.model_visible_display_ids)
        | set(trace.ui_visible_display_ids)
        | set(trace.final_display_ids)
        | _candidate_display_ids(states)
    )
    leaked = sorted(exposed & case.forbidden_display_ids)
    frozen_display_ids, frozen_evidence_ids = _frozen_allowlists(states)
    unknown_final_ids = sorted(set(trace.final_display_ids) - frozen_display_ids)
    unknown_evidence_ids = sorted(set(trace.final_evidence_ids) - frozen_evidence_ids)
    candidate_count = len(set(trace.ui_visible_display_ids))
    termination = states[-1].get("termination") if states else None
    termination_valid = case.expected_termination is None or termination == case.expected_termination

    final_ids = set(trace.final_display_ids)
    relevant_hits = len(final_ids & case.relevant_display_ids)
    recall = relevant_hits / len(case.relevant_display_ids) if case.relevant_display_ids else float(not final_ids)
    precision = relevant_hits / len(final_ids) if final_ids else float(not case.relevant_display_ids)

    checks = (
        ScoredCheck("event_sequence_contiguous", sequence_valid, f"sequences={sequences}"),
        ScoredCheck("authorization_no_leak", not leaked, f"forbidden_exposed={leaked}"),
        ScoredCheck("final_display_refs_frozen", not unknown_final_ids, f"unknown={unknown_final_ids}"),
        ScoredCheck("final_evidence_refs_frozen", not unknown_evidence_ids, f"unknown={unknown_evidence_ids}"),
        ScoredCheck("candidate_limit", candidate_count <= case.max_candidates, f"count={candidate_count}, max={case.max_candidates}"),
        ScoredCheck("expected_termination", termination_valid, f"actual={termination!r}, expected={case.expected_termination!r}"),
    )
    return EvaluationResult(
        case_id=case.case_id,
        trace_id=trace.trace_id,
        blocking_checks=checks,
        metrics={"precision": precision, "recall": recall},
    )
