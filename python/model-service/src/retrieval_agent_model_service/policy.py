from __future__ import annotations

from copy import deepcopy
from typing import Any

from .errors import ServiceError


CANDIDATE_RANKING_VERSION = "candidate-ranking-v1"
KNOWLEDGE_ASSESSMENT_VERSION = "knowledge-assessment-v1"
_ACTION_KINDS = {
    "search", "search_next", "repair_search", "assess", "read_l3_details", "request_clarification",
    "freeze", "read_state",
}


def _invalid(message: str, code: str = "INVALID_REQUEST") -> ServiceError:
    return ServiceError(400, code, message)


def _array(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise _invalid(f"{label} must be an array.")
    return value


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid(f"{label} must be an object.")
    return value


def _strings(value: Any, label: str) -> list[str]:
    result = _array(value, label)
    if not all(isinstance(item, str) and item for item in result):
        raise _invalid(f"{label} is invalid.")
    return result


def _candidate(value: Any) -> dict[str, Any]:
    candidate = _object(value, "candidate")
    if not isinstance(candidate.get("ref"), str) or not candidate["ref"]:
        raise _invalid("candidate ref is invalid.")
    rank = candidate.get("rank")
    if isinstance(rank, bool) or not isinstance(rank, int) or rank < 1:
        raise _invalid("candidate rank is invalid.")
    return deepcopy(candidate)


def _observation(value: Any) -> dict[str, Any]:
    observation = _object(value, "ranking observation")
    if not all(isinstance(observation.get(key), str) and observation[key] for key in ("searchEventId", "stage", "queryFingerprint")):
        raise _invalid("ranking observation identity is invalid.")
    ranking = _array(observation.get("ranking"), "ranking observation rows")
    for row in ranking:
        if not isinstance(row, dict) or not isinstance(row.get("ref"), str) or not row["ref"]:
            raise _invalid("ranking observation row is invalid.")
        rank = row.get("rank")
        if isinstance(rank, bool) or not isinstance(rank, int) or rank < 1:
            raise _invalid("ranking observation rank is invalid.")
    return deepcopy(observation)


def _same_observation(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return (
        left["queryFingerprint"] == right["queryFingerprint"]
        and left["stage"] == right["stage"]
        and len(left["ranking"]) == len(right["ranking"])
        and all(
            item["ref"] == right["ranking"][index]["ref"] and item["rank"] == right["ranking"][index]["rank"]
            for index, item in enumerate(left["ranking"])
        )
    )


def update_candidate_ranking(raw: Any) -> dict[str, Any]:
    value = _object(raw, "candidate ranking input")
    previous = [_candidate(item) for item in _array(value.get("previousHistory"), "previous history")]
    page = [_candidate(item) for item in _array(value.get("page"), "candidate page")]
    observations = [_observation(item) for item in _array(value.get("previousObservations"), "previous observations")]
    stage = value.get("stage")
    if stage not in {"initial_hybrid", "repair_search", "next_page", "baseline"}:
        raise _invalid("search stage is invalid.")
    if not isinstance(value.get("searchEventId"), str) or not value["searchEventId"]:
        raise _invalid("search event id is invalid.")
    if not isinstance(value.get("queryFingerprint"), str) or not value["queryFingerprint"]:
        raise _invalid("query fingerprint is invalid.")
    excluded_refs = set(_strings(value.get("excludedRefs"), "excluded refs"))
    history: list[dict[str, Any]] = []
    seen: set[str] = set()
    for candidate in [*previous, *page]:
        if candidate["ref"] in seen:
            continue
        seen.add(candidate["ref"])
        history.append(candidate)
    next_observation = {
        "searchEventId": value["searchEventId"],
        "stage": stage,
        "queryFingerprint": value["queryFingerprint"],
        "ranking": [{"ref": item["ref"], "rank": item["rank"]} for item in page],
    }
    if not any(_same_observation(item, next_observation) for item in observations):
        observations.append(next_observation)
    scores: dict[str, float] = {}
    known = {candidate["ref"] for candidate in history}
    for observation in observations:
        weight = 1.25 if observation["stage"] == "repair_search" else 1.0
        for item in observation["ranking"]:
            if item["ref"] in known:
                scores[item["ref"]] = scores.get(item["ref"], 0.0) + weight / (60 + item["rank"])
    first_seen = {candidate["ref"]: index for index, candidate in enumerate(history)}
    active = [deepcopy(candidate) for candidate in history if candidate["ref"] not in excluded_refs]
    active.sort(key=lambda item: (-scores.get(item["ref"], 0.0), first_seen[item["ref"]]))
    for rank, candidate in enumerate(active, start=1):
        candidate["rank"] = rank
    return {
        "version": CANDIDATE_RANKING_VERSION,
        "history": history,
        "observations": observations,
        "active": active,
    }


def _action(kind: str, candidates: list[str] | None = None, fields: list[str] | None = None, max_tokens: int = 0) -> dict[str, Any]:
    if kind not in _ACTION_KINDS:
        raise _invalid("policy attempted to create an unknown action.", "PROTOCOL_MISMATCH")
    return {
        "kind": kind,
        "candidateAllowlist": candidates or [],
        "fieldAllowlist": fields or [],
        "maxTokens": max_tokens,
    }


def _unique_known_refs(raw: Any, known: set[str], label: str) -> list[str]:
    refs = list(dict.fromkeys(_strings(raw, label)))
    if any(ref not in known for ref in refs):
        raise _invalid(f"{label} references a candidate outside the active ranking.", "CANDIDATE_NOT_FOUND")
    return refs


def _semantic_gaps(state: dict[str, Any], raw_gaps: Any) -> list[dict[str, Any]]:
    candidates = [_candidate(item) for item in _array(state.get("candidates"), "state candidates")]
    evidence = _array(state.get("promotedEvidence"), "promoted evidence")
    known_evidence = {candidate["ref"] for candidate in candidates}
    for item in evidence:
        if isinstance(item, dict) and isinstance(item.get("evidenceId"), str):
            known_evidence.add(item["evidenceId"])
    result: list[dict[str, Any]] = []
    for raw in _array(raw_gaps, "assessment gaps"):
        gap = _object(raw, "assessment gap")
        if gap.get("kind") == "coverage":
            continue
        if gap.get("evaluator") != "model":
            raise _invalid("The model may submit only evaluator=model semantic gaps.")
        refs = _strings(gap.get("evidenceRefs"), "gap evidence refs")
        if any(ref not in known_evidence for ref in refs):
            raise _invalid("A semantic gap references evidence outside the current state.")
        description = gap.get("description")
        if description is not None and (not isinstance(description, str) or not description.strip() or len(description) > 500):
            raise _invalid("Semantic gap description is invalid.")
        result.append({**deepcopy(gap), "evidenceRefs": list(dict.fromkeys(refs))})
    return result


def _budget_number(budget: dict[str, Any], primary: str, fallback: str | None = None) -> float:
    value = budget.get(primary, budget.get(fallback) if fallback else None)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _invalid("retrieval budget is invalid.")
    return float(value)


def _can_search(state: dict[str, Any], no_progress_limit: int) -> bool:
    budget = _object(state.get("budget"), "retrieval budget")
    progress = _object(state.get("progress"), "retrieval progress")
    return (
        _budget_number(budget, "searchesUsed") < _budget_number(budget, "maxSearches")
        and _budget_number(budget, "modelStepsUsed", "roundsUsed") < _budget_number(budget, "maxRounds")
        and _budget_number(budget, "wallClockElapsedMs", "latencyMs") < _budget_number(budget, "maxLatencyMs")
        and _budget_number(progress, "noProgressStreak") < no_progress_limit
    )


def _pages_exhausted(state: dict[str, Any]) -> bool:
    page = state.get("lastPage")
    if not isinstance(page, dict):
        return False
    boundary = page.get("boundary")
    if isinstance(boundary, dict) and isinstance(boundary.get("resultPagesExhausted"), bool):
        return boundary["resultPagesExhausted"]
    return page.get("completeness") == "exhaustive" and page.get("nextCursor") is None


def _l3_fields(state: dict[str, Any]) -> list[str]:
    snapshot = state.get("snapshot")
    if not isinstance(snapshot, dict):
        return []
    capabilities = snapshot.get("capabilities")
    if not isinstance(capabilities, dict) or capabilities.get("l3DetailsRead") is not True:
        return []
    catalog = snapshot.get("fieldCatalog", [])
    if not isinstance(catalog, list):
        raise _invalid("snapshot field catalog is invalid.")
    return [
        item["key"] for item in catalog
        if isinstance(item, dict) and item.get("accessLevel") == "L3"
        and item.get("valueKind") == "raw_json" and isinstance(item.get("key"), str)
    ]


def _depth_gap_candidate_refs(model_gaps: list[dict[str, Any]], candidate_refs: list[str]) -> list[str]:
    requested = {
        ref
        for gap in model_gaps
        if gap.get("kind") == "depth" and gap.get("status") in {"open", "unknown"}
        for ref in gap.get("evidenceRefs", [])
    }
    return [ref for ref in candidate_refs if ref in requested]


def _require_shape(assessment: dict[str, Any], evaluator: str, next_action: str) -> None:
    if assessment.get("evaluator") != evaluator or assessment.get("nextAction") != next_action:
        raise _invalid(f"knowledge assessment requires evaluator={evaluator}, nextAction={next_action}.")


def plan_knowledge_assessment(raw_state: Any, raw_assessment: Any, raw_config: Any) -> dict[str, Any]:
    state = _object(raw_state, "retrieval state")
    assessment = _object(raw_assessment, "knowledge assessment")
    config = _object(raw_config, "knowledge assessment config")
    no_progress_limit = config.get("noProgressLimit")
    if isinstance(no_progress_limit, bool) or not isinstance(no_progress_limit, int) or no_progress_limit < 1:
        raise _invalid("no progress limit is invalid.")
    state_candidates = [_candidate(item) for item in _array(state.get("candidates"), "state candidates")]
    known = {candidate["ref"] for candidate in state_candidates}
    selected = _unique_known_refs(assessment.get("selectedCandidateRefs"), known, "selectedCandidateRefs")
    newly_excluded = _unique_known_refs(assessment.get("excludedCandidateRefs"), known, "excludedCandidateRefs")
    if any(ref in newly_excluded for ref in selected):
        raise _invalid("A candidate cannot be selected and excluded in the same assessment.")
    previous_excluded = _strings(state.get("excludedCandidateRefs"), "state excluded refs")
    excluded_refs = list(dict.fromkeys([*previous_excluded, *newly_excluded]))
    excluded = set(excluded_refs)
    candidates = [deepcopy(candidate) for candidate in state_candidates if candidate["ref"] not in excluded]
    for rank, candidate in enumerate(candidates, start=1):
        candidate["rank"] = rank
    if any(ref not in {candidate["ref"] for candidate in candidates} for ref in selected):
        raise _invalid("Final selection cannot contain an excluded candidate.")
    model_gaps = _semantic_gaps(state, assessment.get("gaps"))
    state_gaps = _array(state.get("gaps"), "state gaps")
    system_gaps = [deepcopy(gap) for gap in state_gaps if isinstance(gap, dict) and gap.get("evaluator") == "system"]
    gaps = [*system_gaps, *model_gaps]
    open_gap = any(
        gap.get("kind") not in {"coverage", "boundary"} and gap.get("status") in {"open", "unknown"}
        for gap in gaps
    )
    task = _object(state.get("task"), "retrieval task")
    budget = _object(state.get("budget"), "retrieval budget")
    last_page = state.get("lastPage") if isinstance(state.get("lastPage"), dict) else None
    candidate_refs = [candidate["ref"] for candidate in candidates]
    actions = [_action("read_state")]
    termination = "active"
    decision = assessment.get("decision")

    if decision == "present_current_top_k":
        _require_shape(assessment, "model", "present_current_top_k")
        if task.get("completenessRequirement") != "top_k" or not candidates or last_page is None or last_page.get("nextCursor") is None:
            raise _invalid("Only a Top-K task with another result page can present the current batch.", "INVALID_TRANSITION")
        search_open = _can_search(state, no_progress_limit)
        actions = [
            _action("assess", candidate_refs),
            *([_action("search_next"), _action("repair_search")] if search_open else []),
            *([_action("request_clarification", candidate_refs)] if len(candidates) >= 2 else []),
            *actions,
        ]
    elif decision == "accept_current_top_k":
        _require_shape(assessment, "model", "accept_current_top_k")
        if task.get("completenessRequirement") != "top_k" or not selected or open_gap:
            raise _invalid("Current task, selection, or open semantic gaps prevent Top-K acceptance.", "INVALID_TRANSITION")
        explicit_satisfied = task.get("countPolicy") == "explicit" and (
            len(selected) == task.get("requestedCount") or _pages_exhausted(state)
        )
        if task.get("countPolicy") == "explicit" and not explicit_satisfied:
            raise _invalid("The explicit count is not satisfied while more results remain.", "INVALID_TRANSITION")
        actions.insert(0, _action("freeze", selected))
    elif decision == "return_partial":
        _require_shape(assessment, "system", "finish_partial")
        if not selected:
            raise _invalid("A partial result requires at least one authorized candidate.", "INVALID_TRANSITION")
        actions.insert(0, _action("freeze", selected))
    elif decision == "no_result":
        _require_shape(assessment, "system", "finish_no_result")
        if selected or candidates or not _pages_exhausted(state):
            raise _invalid("No-result requires an exhausted expression and no candidates.", "INVALID_TRANSITION")
        actions.insert(0, _action("freeze"))
    elif decision == "needs_clarification":
        _require_shape(assessment, "model", "clarify")
        if len(candidates) < 2 or not any(gap.get("kind") in {"ambiguity", "boundary", "constraint"} and gap.get("status") in {"open", "unknown"} for gap in gaps):
            raise _invalid("Clarification requires two candidates and an open ambiguity, boundary, or constraint gap.", "INVALID_TRANSITION")
        actions.insert(0, _action("request_clarification", candidate_refs))
        termination = "needs_clarification"
    elif decision == "continue":
        next_action = assessment.get("nextAction")
        _require_shape(assessment, "model", next_action)
        search_open = _can_search(state, no_progress_limit)
        actions.insert(0, _action("assess", candidate_refs))
        if next_action == "continue_ranking":
            if not search_open or last_page is None or last_page.get("nextCursor") is None:
                raise _invalid("Current Provider ranking cannot continue.", "INVALID_TRANSITION")
            actions.insert(0, _action("search_next"))
        elif next_action in {"keyword_search", "vector_search"}:
            if not search_open:
                raise _invalid("Search budget is exhausted.", "INVALID_TRANSITION")
            actions.insert(0, _action("repair_search"))
        elif next_action == "read_l3_details":
            fields = _l3_fields(state)
            depth_refs = _depth_gap_candidate_refs(model_gaps, candidate_refs)
            if not fields or not depth_refs:
                raise _invalid(
                    "L3 detail requires an unresolved depth gap that cites current candidates.",
                    "INVALID_TRANSITION",
                )
            actions.insert(0, _action("read_l3_details", depth_refs, fields))
        elif next_action == "clarify":
            if len(candidates) < 2:
                raise _invalid("Current ranking cannot support differential clarification.", "INVALID_TRANSITION")
            actions.insert(0, _action("request_clarification", candidate_refs))
        else:
            raise _invalid("Continue assessment must select an executable next action.")
    else:
        raise _invalid("knowledge assessment decision is invalid.")

    progress = _object(state.get("progress"), "retrieval progress")
    return {
        "version": KNOWLEDGE_ASSESSMENT_VERSION,
        "patch": {
            "phase": "assessed",
            "candidates": candidates,
            "excludedCandidateRefs": excluded_refs,
            "selectedCandidateRefs": selected,
            "lastAssessment": {
                **deepcopy(assessment),
                "selectedCandidateRefs": selected,
                "excludedCandidateRefs": newly_excluded,
                "gaps": model_gaps,
            },
            "gaps": gaps,
            "allowedActions": actions,
            "termination": termination,
            "progress": {**deepcopy(progress), "newCandidateRefs": [], "newEvidenceIds": []},
        },
    }
