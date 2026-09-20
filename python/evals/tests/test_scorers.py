from retrieval_agent_evals import EvalCase, ProductTrace, evaluate_trace
import pytest


def state_event(sequence: int, *, candidates: list[str], frozen: list[tuple[str, list[str]]] | None, termination: str) -> dict:
    state = {
        "candidates": [{"displayId": display_id} for display_id in candidates],
        "termination": termination,
    }
    if frozen is not None:
        state["frozenEvidence"] = {
            "candidates": [
                {"displayId": display_id, "evidenceIds": evidence_ids}
                for display_id, evidence_ids in frozen
            ]
        }
    return {
        "eventId": f"event-{sequence}",
        "sequence": sequence,
        "type": "retrieval/state-recorded",
        "data": {"state": state},
    }


def test_valid_trace_passes_zero_tolerance_checks_and_reports_metrics() -> None:
    case = EvalCase.from_mapping({
        "caseId": "case-1",
        "relevantDisplayIds": ["INC-1"],
        "forbiddenDisplayIds": ["INC-SECRET"],
        "maxCandidates": 5,
        "expectedTermination": "sufficient",
    })
    trace = ProductTrace.from_mapping({
        "traceId": "trace-1",
        "events": [state_event(0, candidates=["INC-1", "INC-2"], frozen=[("INC-1", ["ev-1"])], termination="sufficient")],
        "modelVisibleDisplayIds": ["INC-1", "INC-2"],
        "uiVisibleDisplayIds": ["INC-1", "INC-2"],
        "finalDisplayIds": ["INC-1"],
        "finalEvidenceIds": ["ev-1"],
        "finalCitations": [{"displayId": "INC-1", "evidenceId": "ev-1", "quote": "原始对话"}],
        "sourceEvidence": [{"displayId": "INC-1", "evidenceId": "ev-1", "text": "原始对话"}],
    })

    result = evaluate_trace(case, trace)

    assert result.passed
    assert result.metrics == {"precision": 1.0, "recall": 1.0}


@pytest.mark.parametrize("mutation", ["empty", "wrong_set", "wrong_ticket_evidence", "no_citations"])
def test_review_mutations_cannot_pass(mutation):
    case = EvalCase.from_mapping({"caseId": mutation, "relevantDisplayIds": ["INC-1"]})
    value = {
        "traceId": mutation,
        "events": [state_event(0, candidates=["INC-1", "INC-2"],
            frozen=[("INC-1", ["ev-1"]), ("INC-2", ["ev-2"])], termination="sufficient")],
        "finalDisplayIds": ["INC-1"], "finalEvidenceIds": ["ev-1"],
    }
    if mutation == "empty":
        value.update(events=[], finalDisplayIds=[], finalEvidenceIds=[])
    elif mutation == "wrong_set":
        value.update(finalDisplayIds=["INC-2"], finalEvidenceIds=["ev-2"])
    elif mutation == "wrong_ticket_evidence":
        value["finalEvidenceIds"] = ["ev-2"]
    else:
        value["finalEvidenceIds"] = []
    assert not evaluate_trace(case, ProductTrace.from_mapping(value)).passed


def test_authorization_leak_is_blocking_even_when_retrieval_metrics_are_perfect() -> None:
    case = EvalCase.from_mapping({
        "caseId": "case-leak",
        "relevantDisplayIds": ["INC-1"],
        "forbiddenDisplayIds": ["INC-SECRET"],
    })
    trace = ProductTrace.from_mapping({
        "traceId": "trace-leak",
        "events": [state_event(0, candidates=["INC-1"], frozen=[("INC-1", [])], termination="sufficient")],
        "modelVisibleDisplayIds": ["INC-1", "INC-SECRET"],
        "uiVisibleDisplayIds": ["INC-1"],
        "finalDisplayIds": ["INC-1"],
        "finalEvidenceIds": [],
    })

    result = evaluate_trace(case, trace)

    assert result.metrics == {"precision": 1.0, "recall": 1.0}
    assert not result.passed
    assert next(check for check in result.blocking_checks if check.name == "authorization_no_leak").detail == "forbidden_exposed=['INC-SECRET']"


def test_broken_sequence_and_unfrozen_references_fail_closed() -> None:
    case = EvalCase.from_mapping({"caseId": "case-broken", "relevantDisplayIds": [], "forbiddenDisplayIds": []})
    trace = ProductTrace.from_mapping({
        "traceId": "trace-broken",
        "events": [state_event(1, candidates=["INC-1"], frozen=None, termination="partial")],
        "finalDisplayIds": ["INC-1"],
        "finalEvidenceIds": ["ev-forged"],
    })

    result = evaluate_trace(case, trace)

    assert not result.passed
    failed = {check.name for check in result.blocking_checks if not check.passed}
    assert {"event_sequence_contiguous", "final_display_refs_frozen", "final_evidence_refs_frozen"} <= failed


def test_v9_granular_events_do_not_require_repeated_full_state_snapshots() -> None:
    case = EvalCase.from_mapping({"caseId": "case-v9", "relevantDisplayIds": ["INC-1"], "forbiddenDisplayIds": []})
    trace = ProductTrace.from_mapping({
        "traceId": "trace-v9",
        "events": [
            {
                "eventId": "search-0", "sequence": 0, "type": "retrieval/search-completed",
                "data": {"page": {"candidates": [{"displayId": "INC-1"}]}},
            },
            {
                "eventId": "frozen-1", "sequence": 1, "type": "retrieval/evidence-frozen",
                "data": {"pack": {"candidates": [{"displayId": "INC-1", "evidenceIds": ["ev-1"]}]}},
            },
            {"eventId": "stopped-2", "sequence": 2, "type": "retrieval/stopped", "data": {"reason": "top_k_accepted"}},
        ],
        "uiVisibleDisplayIds": ["INC-1"],
        "finalDisplayIds": ["INC-1"],
        "finalEvidenceIds": ["ev-1"],
        "finalCitations": [{"displayId": "INC-1", "evidenceId": "ev-1", "quote": "原始对话"}],
        "sourceEvidence": [{"displayId": "INC-1", "evidenceId": "ev-1", "text": "原始对话"}],
    })

    result = evaluate_trace(case, trace)

    assert result.passed
    assert result.metrics == {"precision": 1.0, "recall": 1.0}


@pytest.mark.parametrize("termination,expected", [("no_result", True), ("partial", False), ("active", False)])
def test_empty_answer_requires_completed_execution(termination, expected):
    case = EvalCase.from_mapping({"caseId": "empty-answer"})
    trace = ProductTrace.from_mapping({"traceId": "empty-answer", "events": [
        state_event(0, candidates=[], frozen=[], termination=termination)]})
    assert evaluate_trace(case, trace).task_success is expected


def test_unknown_cannot_be_scored_as_exclude_and_facts_need_external_review():
    case = EvalCase.from_mapping({"caseId": "unknown", "expectedVerdicts": {"INC-1": "undetermined"}, "requireFacts": True})
    value = {"traceId": "unknown", "events": [state_event(0, candidates=[], frozen=[], termination="no_result")],
             "finalVerdicts": {"INC-1": "exclude"}, "finalAnswer": "证据不足。"}
    assert not evaluate_trace(case, ProductTrace.from_mapping(value)).passed
    value.update(finalVerdicts={"INC-1": "undetermined"}, factsPassed=True)
    assert evaluate_trace(case, ProductTrace.from_mapping(value)).passed


@pytest.mark.parametrize("mutation", ["swapped", "fabricated", "missing"])
def test_citation_pairs_and_actual_source_content(mutation):
    case = EvalCase.from_mapping({"caseId": "quotes", "relevantDisplayIds": ["INC-1", "INC-2"]})
    citations = [{"displayId": f"INC-{i}", "evidenceId": f"ev-{i}", "quote": f"原文{i}"} for i in (1, 2)]
    sources = [{"displayId": c["displayId"], "evidenceId": c["evidenceId"], "text": c["quote"]} for c in citations]
    value = {"traceId": "quotes", "events": [state_event(0, candidates=["INC-1", "INC-2"],
        frozen=[("INC-1", ["ev-1"]), ("INC-2", ["ev-2"])], termination="sufficient")],
        "finalDisplayIds": ["INC-1", "INC-2"], "finalEvidenceIds": ["ev-1", "ev-2"],
        "finalCitations": citations, "sourceEvidence": sources}
    assert evaluate_trace(case, ProductTrace.from_mapping(value)).passed
    if mutation == "swapped":
        citations[0]["evidenceId"], citations[1]["evidenceId"] = "ev-2", "ev-1"
    elif mutation == "fabricated":
        citations[0]["quote"] = "不存在的承诺"
    else:
        value.update(finalCitations=[], sourceEvidence=[])
    assert not evaluate_trace(case, ProductTrace.from_mapping(value)).passed
