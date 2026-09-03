from __future__ import annotations

import pytest

from retrieval_agent_model_service.errors import ServiceError
from retrieval_agent_model_service.policy import plan_knowledge_assessment, update_candidate_ranking


def candidate(ref: str, rank: int) -> dict:
    return {"ref": ref, "rank": rank, "displayId": ref.upper(), "title": ref}


def state() -> dict:
    return {
        "candidates": [candidate("c1", 1), candidate("c2", 2)],
        "excludedCandidateRefs": [],
        "promotedEvidence": [],
        "gaps": [{"kind": "coverage", "status": "unknown", "evidenceRefs": [], "evaluator": "system"}],
        "task": {"completenessRequirement": "top_k", "countPolicy": "explicit", "requestedCount": 2},
        "budget": {
            "searchesUsed": 1, "maxSearches": 4, "modelStepsUsed": 0, "maxRounds": 8,
            "wallClockElapsedMs": 0, "maxLatencyMs": 120_000, "promotionsUsed": 0,
            "maxPromotions": 3, "evidenceTokensUsed": 0, "maxEvidenceTokens": 1_500,
        },
        "progress": {"noProgressStreak": 0, "newCandidateRefs": ["c1", "c2"], "newEvidenceIds": []},
        "snapshot": {
            "capabilities": {"l3DetailsRead": True},
            "fieldCatalog": [
                {"key": "summary", "accessLevel": "L2", "valueKind": "text"},
                {"key": "source.raw", "accessLevel": "L3", "valueKind": "raw_json"},
            ],
        },
        "lastPage": {"completeness": "exhaustive", "boundary": {"resultPagesExhausted": True}},
    }


def test_candidate_ranking_preserves_history_and_revises_active_order() -> None:
    result = update_candidate_ranking({
        "previousHistory": [candidate("c1", 1)],
        "previousObservations": [{
            "searchEventId": "e1", "stage": "initial_hybrid", "queryFingerprint": "q1",
            "ranking": [{"ref": "c1", "rank": 1}],
        }],
        "page": [candidate("c2", 1), candidate("c1", 2)],
        "searchEventId": "e2", "stage": "repair_search", "queryFingerprint": "q2", "excludedRefs": ["c1"],
    })
    assert [item["ref"] for item in result["history"]] == ["c1", "c2"]
    assert [item["ref"] for item in result["active"]] == ["c2"]
    assert [item["rank"] for item in result["active"]] == [1]


def test_knowledge_policy_accepts_only_known_non_excluded_candidates() -> None:
    result = plan_knowledge_assessment(state(), {
        "decision": "accept_current_top_k", "evaluator": "model",
        "selectedCandidateRefs": ["c1", "c2"], "excludedCandidateRefs": [],
        "gaps": [], "nextAction": "accept_current_top_k",
    }, {"noProgressLimit": 2})
    assert result["version"] == "knowledge-assessment-v1"
    assert result["patch"]["allowedActions"][0]["kind"] == "freeze"
    assert result["patch"]["selectedCandidateRefs"] == ["c1", "c2"]

    with pytest.raises(ServiceError) as caught:
        plan_knowledge_assessment(state(), {
            "decision": "continue", "evaluator": "model", "selectedCandidateRefs": ["forged"],
            "excludedCandidateRefs": [], "gaps": [], "nextAction": "promote",
        }, {"noProgressLimit": 2})
    assert caught.value.code == "CANDIDATE_NOT_FOUND"


def test_continue_plan_remains_reassessable_until_the_selected_action_runs() -> None:
    result = plan_knowledge_assessment(state(), {
        "decision": "continue", "evaluator": "model",
        "selectedCandidateRefs": ["c1", "c2"], "excludedCandidateRefs": [],
        "gaps": [], "nextAction": "vector_search",
    }, {"noProgressLimit": 2})

    assert [action["kind"] for action in result["patch"]["allowedActions"]] == [
        "repair_search", "assess", "read_state",
    ]


def test_l3_requires_a_candidate_specific_open_depth_gap() -> None:
    with pytest.raises(ServiceError) as caught:
        plan_knowledge_assessment(state(), {
            "decision": "continue", "evaluator": "model",
            "selectedCandidateRefs": ["c1", "c2"], "excludedCandidateRefs": [],
            "gaps": [{
                "kind": "coverage", "status": "unknown", "evidenceRefs": [],
                "evaluator": "model", "description": "semantic recall is not proven",
            }],
            "nextAction": "read_l3_details",
        }, {"noProgressLimit": 2})
    assert caught.value.code == "INVALID_TRANSITION"

    result = plan_knowledge_assessment(state(), {
        "decision": "continue", "evaluator": "model",
        "selectedCandidateRefs": ["c1", "c2"], "excludedCandidateRefs": [],
        "gaps": [{
            "kind": "depth", "status": "open", "evidenceRefs": ["c2"],
            "evaluator": "model", "description": "L2 summary is insufficient for c2",
        }],
        "nextAction": "read_l3_details",
    }, {"noProgressLimit": 2})

    assert [action["kind"] for action in result["patch"]["allowedActions"]] == [
        "read_l3_details", "assess", "read_state",
    ]
    assert result["patch"]["allowedActions"][0]["candidateAllowlist"] == ["c2"]
    assert result["patch"]["allowedActions"][0]["fieldAllowlist"] == ["source.raw"]
    assert result["patch"]["gaps"] == [
        {"kind": "coverage", "status": "unknown", "evidenceRefs": [], "evaluator": "system"},
        {
            "kind": "depth", "status": "open", "evidenceRefs": ["c2"],
            "evaluator": "model", "description": "L2 summary is insufficient for c2",
        },
    ]
