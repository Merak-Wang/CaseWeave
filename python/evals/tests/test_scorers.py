from retrieval_agent_evals import EvalCase, ProductTrace, evaluate_trace


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
    })

    result = evaluate_trace(case, trace)

    assert result.passed
    assert result.metrics == {"precision": 1.0, "recall": 1.0}


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
    })

    result = evaluate_trace(case, trace)

    assert result.passed
    assert result.metrics == {"precision": 1.0, "recall": 1.0}
