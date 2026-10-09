import json

import httpx

from retrieval_agent_evals.probe_teacher import run_baseline
from retrieval_agent_evals.teacher_transport import TeacherConfig, TransportPolicy, request_json, safe_provider_error


def test_provider_error_accepts_only_fixed_enums_and_never_messages():
    secret = "fixture-secret-do-not-emit"
    assert safe_provider_error({"error": {"code": "invalid_request", "type": "invalid_request_error",
        "param": "model", "message": secret, "debug": secret}}) == {
        "code": "invalid_request", "type": "invalid_request_error", "param": "model"}
    assert safe_provider_error({"error": {"code": secret, "type": secret, "param": secret, "message": secret}}) is None
    assert safe_provider_error({"error": {"code": [], "type": {}, "param": True}}) is None


def test_http400_diagnostic_is_bounded_single_call_and_discards_body():
    secret = "fixture-secret-do-not-emit"
    count = 0
    def handler(_request):
        nonlocal count
        count += 1
        return httpx.Response(400, json={"error": {"code": "invalid_request", "type": "invalid_request_error",
            "param": "messages", "message": secret}, "raw": secret})
    result = request_json("https://fixture.invalid/chat/completions", {"Authorization": secret},
        {"model": "deepseek-v4.1-flash"}, policy=TransportPolicy(max_attempts=1),
        diagnose_errors=True, http_transport=httpx.MockTransport(handler))
    assert result.error_code == "HTTP_400" and count == len(result.attempts) == 1
    assert result.payload is None and result.value is None
    assert result.attempts[0]["provider_error"] == {"code": "invalid_request", "type": "invalid_request_error", "param": "messages"}
    assert secret not in json.dumps(result.metrics()) and secret not in repr(result)


def test_baseline_requests_only_required_protocol_fields_with_no_optional_capabilities():
    calls = []
    config = TeacherConfig("https://fixture.invalid/chat/completions", "deepseek-v4.1-flash", "fixture-secret")
    def requester(endpoint, headers, body, policy, diagnose_errors):
        assert set(body) == {"model", "messages", "stream", "max_tokens"}
        assert policy.max_attempts == 1 and diagnose_errors is True
        calls.append(body)
        return request_json(endpoint, headers, body, policy=policy, diagnose_errors=diagnose_errors,
            http_transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"model": config.model,
                "usage": {"prompt_tokens": 2, "completion_tokens": 1},
                "choices": [{"message": {"content": "yes", "reasoning_content": "fixture-secret"}}]})))
    result = run_baseline(config, requester=requester, total_seconds=1)
    assert result["calls"] == len(calls) == 1
    assert result["http_request_accepted"] is True and result["minimal_chat_response_observed"] is True
    assert result["optional_parameters_requested"] is False and result["capabilities_verified"] is False
    assert "fixture-secret" not in json.dumps(result) and "fixture.invalid" not in json.dumps(result)
