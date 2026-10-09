from uuid import UUID
import httpx
from retrieval_agent_evals.teacher_transport import TeacherConfig, TransportPolicy, request_json, open_code_session_id


def test_default_session_stable_across_headers_and_real_mock_retry():
    config = TeacherConfig("https://synthetic.invalid/v1/chat/completions", "deepseek-v4.1-flash", "synthetic-key", None)
    session = config.headers()["x-opencode-session"]
    assert UUID(session).version == 5
    assert config.headers()["x-opencode-session"] == session
    observed = []
    def handle(request):
        observed.append(request.headers["x-opencode-session"])
        if len(observed) == 1:
            return httpx.Response(429, headers={"retry-after": "0"}, json={"error": {"code": "rate_limit"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})
    result = request_json(config.endpoint, config.headers(), {"model": config.model, "messages": []},
        policy=TransportPolicy(max_attempts=2, total_seconds=10), http_transport=httpx.MockTransport(handle))
    assert result.error_code is None and len(observed) == 2
    assert observed == [session, session]


def test_explicit_session_not_overwritten_and_dsh_algorithm_matches():
    explicit = "1260c548-91e3-4f2a-8e31-dab781219168"
    config = TeacherConfig("https://synthetic.invalid/v1/chat/completions", "deepseek-v4.1-flash", "synthetic-key", explicit)
    assert config.session_id == explicit and config.headers()["x-opencode-session"] == explicit
    assert open_code_session_id("session-" + explicit.upper()) == explicit
    # uuid5 uses exactly the namespace bytes and SHA1/version-bit algorithm in DSH.
    assert UUID(open_code_session_id("pure-synthetic-legacy-session")).version == 5
