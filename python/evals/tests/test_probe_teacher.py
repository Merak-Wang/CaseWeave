import json

import pytest

from retrieval_agent_evals import probe_teacher as probe
from retrieval_agent_evals.teacher_transport import TeacherConfig, TransportResult


def payload_with_scores(entries, answer="Y"):
    return {"choices": [{"message": {"content": answer},
                         "logprobs": {"content": [{"token": answer, "top_logprobs": entries}]}}]}


def test_pair_score_normalizes_stably_and_missing_label_is_unavailable():
    payload = payload_with_scores([{"token": "Y", "logprob": -1000, "bytes": [89]},
                                   {"token": "N", "logprob": -1001, "bytes": [78]}])
    assert probe.label_pair_score(payload) == pytest.approx(0.7310585786)
    summary = probe.logprobs_summary(payload)
    assert summary["labels_observed_as_single_tokens"] is True
    assert summary["pair_normalization_available"] is True
    assert summary["raw_distribution_verified"] is False
    assert summary["tokenizer_independently_verified"] is False
    missing = payload_with_scores([{"token": "Y", "logprob": -1}])
    assert probe.label_pair_score(missing) is None
    assert probe.logprobs_summary(missing)["pair_normalization_available"] is False


def test_leading_space_and_multiple_answer_tokens_are_not_verified_single_labels():
    payload = payload_with_scores([{"token": " Y", "logprob": -1}, {"token": " N", "logprob": -2}])
    assert probe.logprobs_summary(payload)["both_labels_at_answer_position"] is False
    payload["choices"][0]["logprobs"]["content"].append({"token": "!"})
    assert probe.label_pair_score(payload) is None


@pytest.mark.parametrize("content,expected", [
    ('{"label":"yes","confidence":0.8}', True),
    ('{"label":"no","confidence":0.6}', True),
    ('{"label":"yes","confidence":true}', False),
    ('{"label":"yes","confidence":0.5,"reason":"extra"}', False),
    ('{"label":"yes"}', False),
    ('{"label":"yes","confidence":NaN}', False),
    ('{"label":"unknown","confidence":0.5}', False),
])
def test_two_field_contract(content, expected):
    assert probe.two_field_json_valid({"choices": [{"message": {"content": content}}]}) is expected


def test_probe_outputs_only_safe_capability_summary_and_does_not_scan_batch_endpoints():
    secret = "fixture-secret-do-not-emit"
    endpoint = "https://fixture-private-host.invalid/chat/completions"
    config = TeacherConfig(endpoint, "deepseek-v4.1-flash", secret)
    calls = []
    def requester(url, headers, body, policy):
        calls.append((url, headers, body))
        assert policy.max_attempts == 1
        payload = {"model": config.model, "untrusted": secret,
                   "choices": [{"message": {"content": '{"label":"yes","confidence":0.9}',
                                            "reasoning_content": ""}}]}
        if body.get("logprobs"):
            payload = payload_with_scores([{"token": "Y", "logprob": -0.3}, {"token": "N", "logprob": -1.2}])
        return TransportResult(payload=payload, value=payload,
            attempts=[{"http_status": 200, "error_code": None, "latency_ms": 1.0,
                       "usage": {"prompt_tokens": 2, "completion_tokens": 1}}], elapsed_ms=1.0)
    result = probe.run_probe(config, requester=requester)
    serialized = json.dumps(result)
    assert len(calls) == result["calls"] == 3
    assert all(call[0] == endpoint for call in calls)
    assert secret not in serialized and endpoint not in serialized
    assert "reasoning_content" not in serialized
    assert result["batch_endpoint_probed"] is False and result["batch_support_verified"] is False
    assert result["synthetic_only"] is True and result["accuracy_evaluated"] is False
    enabled = result["probes"][2]
    assert enabled["thinking_parameter_accepted"] is True
    assert enabled["reasoning_channel_present"] is False
    assert enabled["actual_thinking_compute_mode_verified"] is False


def test_describe_target_does_not_make_requests(monkeypatch, capsys):
    config = TeacherConfig("https://fixture.invalid/chat/completions", "deepseek-v4.1-flash", "fixture-secret")
    monkeypatch.setattr(probe, "load_teacher_config", lambda _: config)
    monkeypatch.setattr("sys.argv", ["probe_teacher", "--describe-target"])
    monkeypatch.setattr(probe, "run_probe", lambda *_args, **_kwargs: pytest.fail("must not send"))
    assert probe.main() == 0
    output = capsys.readouterr().out
    assert "fixture.invalid" not in output and "fixture-secret" not in output


def test_fingerprint_must_match_before_network_request(monkeypatch, capsys):
    config = TeacherConfig("https://fixture.invalid/chat/completions", "deepseek-v4.1-flash", "fixture-secret")
    monkeypatch.setattr(probe, "load_teacher_config", lambda _: config)
    monkeypatch.setattr("sys.argv", ["probe_teacher", "--run", "--expected-endpoint-fingerprint", "mismatch"])
    monkeypatch.setattr(probe, "run_probe", lambda *_args, **_kwargs: pytest.fail("must not send"))
    assert probe.main() == 2
    assert json.loads(capsys.readouterr().out)["error_code"] == "TARGET_FINGERPRINT_CONFIRMATION_REQUIRED"


def test_output_path_is_validated_before_config_or_network(monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["probe_teacher", "--run", "--out", "outside-probe-root.json"])
    monkeypatch.setattr(probe, "load_teacher_config", lambda _: pytest.fail("must not read config"))
    monkeypatch.setattr(probe, "run_probe", lambda *_args, **_kwargs: pytest.fail("must not send"))
    assert probe.main() == 2
    assert json.loads(capsys.readouterr().out)["error_code"] == "LOCAL_PROBE_OUTPUT_PATH_INVALID"
