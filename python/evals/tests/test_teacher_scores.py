"""Synthetic transport mocks only; never call a real model or load project secrets."""
import copy
import hashlib
import json
import math
from uuid import UUID
import pytest
from retrieval_agent_evals import teacher, probe_teacher as probe
from retrieval_agent_evals.teacher_transport import TeacherConfig, TransportResult, label_pair_evidence


MODEL = "deepseek-v4.1-flash"
ROW = {"ticket_id": "synthetic-local-id", "title": "Synthetic ticket title", "summary": "Synthetic abstract",
       "body": "Synthetic local-only body", "business_id": "synthetic-id", "vectors": [1, 0], "group_hash": "synthetic-hash"}
CONDITION = {"query": "Synthetic test condition", "labeling_guidance": "Synthetic boundary", "candidate_count": 1}


def pair(y=-1.0, n=-2.0, answer="Y"):
    return {"model": MODEL, "choices": [{"message": {"content": answer}, "logprobs": {"content": [
        {"token": answer, "logprob": -0.2, "top_logprobs": [
            {"token": "Y", "logprob": y, "bytes": [89]}, {"token": "N", "logprob": n, "bytes": [78]}]}]}}]}


def result(payload, validator=None, error=None, usage=True):
    value = validator(payload) if validator and not error else payload
    return TransportResult(payload=payload, value=value, error_code=error, elapsed_ms=2,
        attempts=[{"http_status": 400 if error else 200, "error_code": error, "latency_ms": 2,
                   "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2} if usage else None}])


def label(**kwargs):
    return teacher._label_one(ROW, CONDITION, endpoint="https://synthetic.invalid/v1/chat/completions",
        model=MODEL, api_key="synthetic-key", session_id=None, **kwargs)


def test_valid_pair_is_reported_conditional_score_and_stable_softmax():
    evidence = label_pair_evidence(pair(-1000, -1001))
    assert evidence["available"] and evidence["score"] == pytest.approx(1 / (1 + math.exp(-1)))
    assert evidence["reported_uncalibrated"] and evidence["is_probability"] is False
    assert evidence["raw_distribution_verified"] is False and evidence["tokenizer_independently_verified"] is False


@pytest.mark.parametrize("mutation,reason", [
    ("yes_sentinel", "unavailable_sentinel"), ("no_sentinel", "unavailable_sentinel"),
    ("answer_sentinel", "unavailable_sentinel"), ("other_sentinel", "unavailable_sentinel"),
    ("missing", "missing_label"), ("nan", "label_logprob_invalid"), ("inf", "label_logprob_invalid"),
    ("bool", "label_logprob_invalid"), ("positive", "label_logprob_invalid"),
    ("duplicate", "duplicate_label"), ("bytes", "label_token_bytes_invalid"),
    ("multi_position", "answer_position_invalid")])
def test_unavailable_values_are_never_tiny_finite_scores(mutation, reason):
    payload = pair()
    position = payload["choices"][0]["logprobs"]["content"][0]
    entries = position["top_logprobs"]
    if mutation in {"yes_sentinel", "no_sentinel"}:
        entries[mutation == "no_sentinel"]["logprob"] = -9999
    elif mutation == "answer_sentinel": position["logprob"] = -9999
    elif mutation == "other_sentinel": entries.append({"token": "X", "logprob": -9999})
    elif mutation == "missing": entries.pop()
    elif mutation in {"nan", "inf", "bool", "positive"}:
        entries[1]["logprob"] = {"nan": float("nan"), "inf": float("inf"), "bool": True, "positive": 0.1}[mutation]
    elif mutation == "duplicate": entries.append(copy.deepcopy(entries[0]))
    elif mutation == "bytes": entries[1]["bytes"] = [89]
    elif mutation == "multi_position": payload["choices"][0]["logprobs"]["content"].append({"token": "!"})
    evidence = label_pair_evidence(payload)
    assert not evidence["available"] and evidence["score"] is None and evidence["label"] is None
    assert evidence["unavailable_reason"] == reason
    assert probe.label_pair_score(payload) is None
    summary = probe.logprobs_summary(payload)
    assert summary["pair_normalization_available"] is False and summary["score_kind"] == "unavailable"


def test_actual_teacher_consumes_valid_pair_once_and_sends_only_required_projection(monkeypatch):
    calls = []
    def request(endpoint, headers, body, **kwargs):
        calls.append((headers, body, kwargs))
        return result(pair(), kwargs.get("validator"))
    monkeypatch.setattr(teacher, "request_json", request)
    row = label(score_mode="logprobs_pair")
    assert len(calls) == 1 and row["label"] == 1
    assert row["teacher"]["score_provenance"] == "logprobs_pair" and row["teacher"]["fallback_used"] is False
    assert row["teacher"]["p_yes"] == pytest.approx(1 / (1 + math.exp(-1)))
    assert row["teacher"]["reported_model_matches_requested"] is True and row["teacher"]["is_probability"] is False
    assert calls[0][1]["top_logprobs"] == 20 and calls[0][2]["policy"].max_attempts == 1
    ticket = json.loads(calls[0][1]["messages"][1]["content"])
    assert set(ticket) == {"ticket"} and set(ticket["ticket"]) == {"title", "abstract"}
    assert "synthetic-id" not in calls[0][1]["messages"][1]["content"]


@pytest.mark.parametrize("unavailable", ["sentinel", "missing"])
def test_actual_teacher_falls_back_once_to_short_json_uncalibrated(monkeypatch, unavailable):
    calls = []
    first = pair(n=-9999) if unavailable == "sentinel" else pair()
    if unavailable == "missing": first["choices"][0]["logprobs"]["content"][0]["top_logprobs"].pop()
    def request(endpoint, headers, body, **kwargs):
        calls.append((copy.deepcopy(headers), body, kwargs))
        payload = first if len(calls) == 1 else {"model": MODEL, "choices": [{"message": {"content": '{"label":"no","confidence":0.7}'}}]}
        return result(payload, kwargs.get("validator"))
    monkeypatch.setattr(teacher, "request_json", request)
    row = label(score_mode="logprobs_pair")
    assert len(calls) == 2 and row["label"] == 0 and row["attempts"] == 2
    assert calls[0][0] == calls[1][0] and UUID(calls[0][0]["x-opencode-session"]).version == 5
    assert all(c[2]["policy"].max_attempts == 1 for c in calls)
    assert "logprobs" not in calls[1][1] and calls[1][1]["max_tokens"] == 128
    assert row["teacher"]["score_provenance"] == "reported_json"
    assert row["teacher"]["confidence_kind"] == "reported_uncalibrated" and row["teacher"]["is_probability"] is False
    assert row["teacher"]["fallback_reason"] == ("unavailable_sentinel" if unavailable == "sentinel" else "missing_label")
    assert len(set(row["attempt_prompt_sha256"])) == 2
    assert row["attempt_usage"] == [{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}] * 2


def test_fallback_failure_keeps_unknown_and_missing_usage(monkeypatch):
    calls = []
    def request(endpoint, headers, body, **kwargs):
        calls.append(body)
        return result(pair(n=-9999)) if len(calls) == 1 else result({}, error="HTTP_400", usage=False)
    monkeypatch.setattr(teacher, "request_json", request)
    row = label(score_mode="logprobs_pair")
    assert len(calls) == 2 and row["label"] is None and row["label_source"] is None
    assert row["teacher_error"]["fallback_reason"] == "unavailable_sentinel"
    assert row["teacher_error"]["attempt_usage"][1] is None


@pytest.mark.parametrize("reported", [None, "other-model"])
def test_model_identity_mismatch_is_unknown_without_fallback(monkeypatch, reported):
    calls = []
    def request(*args, **kwargs):
        calls.append(1)
        payload = pair()
        payload["model"] = reported
        return result(payload)
    monkeypatch.setattr(teacher, "request_json", request)
    row = label(score_mode="logprobs_pair")
    assert calls == [1] and row["label"] is None and row["teacher_error"]["error"] == "TEACHER_MODEL_MISMATCH"


def test_cache_binds_score_mode_target_and_actual_consumer_selection(monkeypatch, tmp_path):
    (tmp_path / "manifest.json").write_text(json.dumps(CONDITION), encoding="utf-8")
    data = (json.dumps(ROW) + "\n").encode()
    (tmp_path / "candidates.jsonl").write_bytes(data)
    config = TeacherConfig("https://synthetic.invalid/v1/chat/completions", MODEL, "synthetic-key")
    monkeypatch.setattr(teacher, "load_teacher_config", lambda _: config)
    calls = []
    def request(endpoint, headers, body, **kwargs):
        calls.append(body)
        payload = pair() if body.get("logprobs") else {"model": MODEL, "choices": [{"message": {"content": '{"label":"yes","confidence":0.8}'}}]}
        return result(payload, kwargs.get("validator"))
    monkeypatch.setattr(teacher, "request_json", request)
    def run(mode):
        return teacher.label_condition(tmp_path, tmp_path / "unused-synthetic.env", workers=1, score_mode=mode,
            verified_endpoint_fingerprint=config.public_identity()["endpoint_fingerprint"],
            reviewed_candidates_sha256=hashlib.sha256(data).hexdigest())
    run("reported_json")
    run("reported_json")
    assert len(calls) == 1
    metadata = run("logprobs_pair")
    assert len(calls) == 2 and metadata["score_mode"] == "logprobs_pair" and metadata["pii_safety_automatically_verified"] is False
    run("logprobs_pair")
    assert len(calls) == 2
    before = teacher._teacher_material(ROW, CONDITION, MODEL, target_fingerprint="synthetic-a")["cache_key"]
    after = teacher._teacher_material(ROW, CONDITION, MODEL, target_fingerprint="synthetic-b")["cache_key"]
    assert before != after


def test_score_mode_rejects_before_any_request_and_content_gate_still_required(monkeypatch, tmp_path):
    monkeypatch.setattr(teacher, "request_json", lambda *a, **k: pytest.fail("must not call model"))
    with pytest.raises(ValueError, match="TEACHER_SCORE_MODE_INVALID"):
        label(score_mode="invented")
    (tmp_path / "manifest.json").write_text(json.dumps(CONDITION), encoding="utf-8")
    (tmp_path / "candidates.jsonl").write_text(json.dumps(ROW) + "\n", encoding="utf-8")
    config = TeacherConfig("https://synthetic.invalid/v1/chat/completions", MODEL, "synthetic-key")
    monkeypatch.setattr(teacher, "load_teacher_config", lambda _: config)
    with pytest.raises(Exception, match="INPUT_CONTENT_CONFIRMATION_REQUIRED"):
        teacher.label_condition(tmp_path, tmp_path / "unused-synthetic.env", score_mode="logprobs_pair",
            verified_endpoint_fingerprint=config.public_identity()["endpoint_fingerprint"])
