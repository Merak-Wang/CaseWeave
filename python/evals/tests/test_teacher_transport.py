import asyncio
import json
import logging

import httpx
import pytest

from retrieval_agent_evals import teacher_transport as transport


ENDPOINT = "https://fixture-private-host.invalid/chat/completions"
SECRET = "fixture-credential-do-not-log"


def test_retry_counts_physical_requests_and_whitelists_usage():
    sent = []
    def handler(request):
        sent.append(request)
        if len(sent) == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": SECRET})
        return httpx.Response(200, json={"usage": {"prompt_tokens": 4, "completion_tokens": 2, "Authorization": SECRET},
                                        "choices": []})
    result = transport.request_json(ENDPOINT, {"Authorization": SECRET}, {"private": SECRET},
                                    http_transport=httpx.MockTransport(handler))
    assert result.error_code is None
    assert result.metrics()["calls"] == len(sent) == 2
    assert result.attempts[0]["usage"] is None
    assert result.attempts[1]["usage"] == {"prompt_tokens": 4, "completion_tokens": 2}
    assert SECRET not in json.dumps(result.metrics())
    assert SECRET not in repr(result)


def test_http_failures_and_http_library_logs_never_expose_secrets(caplog, capsys):
    count = 0
    def handler(request):
        nonlocal count
        count += 1
        logging.getLogger("httpx").info("request %s %s", request.url, SECRET)
        logging.getLogger("httpcore.connection").debug("private %s", SECRET)
        return httpx.Response(503, headers={"Retry-After": "0"}, text=SECRET + ENDPOINT)
    caplog.set_level(logging.DEBUG)
    result = transport.request_json(ENDPOINT, {"Authorization": SECRET}, {"private": SECRET},
                                    http_transport=httpx.MockTransport(handler))
    output = capsys.readouterr()
    safe = json.dumps(result.metrics()) + repr(result) + caplog.text + output.out + output.err
    assert result.error_code == "HTTP_503"
    assert result.metrics()["calls"] == count == 3
    assert result.payload is None
    assert SECRET not in safe and ENDPOINT not in safe


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_nontransient_status_does_not_retry(status):
    count = 0
    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(status, text=SECRET)
    result = transport.request_json(ENDPOINT, {}, {}, http_transport=httpx.MockTransport(handler))
    assert count == 1
    assert result.error_code == f"HTTP_{status}"


def test_total_timeout_bounds_slow_response():
    async def handler(request):
        await asyncio.sleep(0.2)
        return httpx.Response(200, json={})
    result = transport.request_json(ENDPOINT, {}, {}, policy=transport.TransportPolicy(total_seconds=0.02),
                                    http_transport=httpx.MockTransport(handler))
    assert result.error_code == "TOTAL_TIMEOUT"
    assert result.metrics()["calls"] == 1
    assert result.elapsed_ms < 300


def test_connection_timeout_is_classified_without_exception_text(monkeypatch):
    async def no_wait(_seconds):
        return None
    monkeypatch.setattr(transport.asyncio, "sleep", no_wait)
    count = 0
    def handler(request):
        nonlocal count
        count += 1
        raise httpx.ConnectTimeout(SECRET + ENDPOINT, request=request)
    result = transport.request_json(ENDPOINT, {}, {}, http_transport=httpx.MockTransport(handler))
    assert result.error_code == "CONNECT_TIMEOUT"
    assert result.metrics()["calls"] == count == 3
    assert SECRET not in json.dumps(result.metrics())


def test_output_schema_retry_preserves_attempt_usage(monkeypatch):
    async def no_wait(_seconds):
        return None
    monkeypatch.setattr(transport.asyncio, "sleep", no_wait)
    def validator(_payload):
        raise transport.TeacherOutputError("LABEL_SCHEMA_INVALID")
    result = transport.request_json(ENDPOINT, {}, {}, validator=validator,
        http_transport=httpx.MockTransport(lambda _: httpx.Response(200, json={
            "usage": {"prompt_tokens": 3, "completion_tokens": 1}, "choices": SECRET})))
    assert result.error_code == "LABEL_SCHEMA_INVALID"
    assert result.metrics()["calls"] == 3
    assert all(a["usage"]["prompt_tokens"] == 3 for a in result.attempts)
    assert result.payload is None
    assert SECRET not in json.dumps(result.metrics())


def test_unexpected_validator_exception_is_sanitized():
    def validator(_):
        raise ValueError(SECRET)
    result = transport.request_json(ENDPOINT, {}, {}, validator=validator,
        http_transport=httpx.MockTransport(lambda _: httpx.Response(200, json={})))
    assert result.error_code == "CLIENT_ERROR"
    assert result.metrics()["calls"] == 1
    assert SECRET not in json.dumps(result.metrics())


def test_invalid_endpoint_has_no_phantom_call():
    result = transport.request_json("https://user:password@fixture.invalid/chat/completions", {}, {})
    assert result.error_code == "ENDPOINT_CONFIG_INVALID"
    assert result.metrics()["calls"] == 0


def test_redirect_is_not_followed_to_unknown_endpoint():
    count = 0
    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(302, headers={"Location": "https://unknown.invalid/"})
    result = transport.request_json(ENDPOINT, {}, {}, http_transport=httpx.MockTransport(handler))
    assert result.error_code == "HTTP_302"
    assert count == 1


def test_configuration_uses_existing_env_and_has_safe_identity(tmp_path, monkeypatch):
    keys = ["RETRIEVAL_AGENT_BROWSER_LLM_MODEL", "RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL",
            "RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV", "RETRIEVAL_AGENT_BROWSER_LLM_API",
            "RETRIEVAL_AGENT_BROWSER_LLM_SESSION_ID"]
    for key in keys:
        monkeypatch.delenv(key, raising=False)
    path = tmp_path / ".env"
    path.write_text("RETRIEVAL_AGENT_BROWSER_LLM_MODEL=deepseek-v4.1-flash\n"
                    "RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL=https://fixture-private-host.invalid\n"
                    "RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV=FIXTURE_TEACHER_KEY\n"
                    "FIXTURE_TEACHER_KEY=" + SECRET + "\n", encoding="utf-8")
    monkeypatch.setenv("FIXTURE_TEACHER_KEY", SECRET + "-environment")
    config = transport.load_teacher_config(path)
    assert config.api_key.endswith("-environment")
    identity = config.public_identity()
    assert identity["endpoint_category"] == "dns_unverified"
    assert len(identity["endpoint_fingerprint"]) == 64
    assert SECRET not in repr(config) + json.dumps(identity)
    assert "fixture-private-host.invalid" not in repr(config) + json.dumps(identity)
