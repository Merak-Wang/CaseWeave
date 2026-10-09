import hashlib
import json

import httpx
import pytest

from retrieval_agent_evals import teacher, teacher_transport


def label_synthetic_condition(condition_dir, env_file, **kwargs):
    config = teacher.load_teacher_config(env_file)
    return teacher.label_condition(condition_dir, env_file,
        verified_endpoint_fingerprint=config.public_identity()["endpoint_fingerprint"],
        content_gate=lambda payload: True, **kwargs)


def test_retry_usage_keeps_one_entry_per_physical_request(monkeypatch):
    sent = []
    request = httpx.Request("POST", "https://unit.test/chat/completions")
    responses = [
        httpx.Response(429, headers={"Retry-After": "0"}, request=request),
        httpx.Response(200, json={"model": "deepseek-v4.1-flash", "usage": {"prompt_tokens": 3, "completion_tokens": 2},
                                  "choices": [{"message": {"content": '{"label":"yes","confidence":0.8}'}}]}, request=request),
    ]

    def fake_post(request):
        sent.append(json.loads(request.content))
        return responses.pop(0)

    monkeypatch.setattr(teacher, "request_json", lambda endpoint, headers, body, **kwargs:
        teacher_transport.request_json(endpoint, headers, body, **kwargs, http_transport=httpx.MockTransport(fake_post)))
    result = teacher._label_one(
        {"ticket_id": "t1", "title": "退款", "summary": "退款处理", "body": "退款记录"},
        {"query": "退款", "labeling_guidance": "只包含预存款退款"},
        endpoint="https://unit.test/chat/completions", model="deepseek-v4.1-flash", api_key="fake", session_id=None,
    )
    assert result["attempts"] == 2
    assert len(result["attempt_seconds"]) == 2
    assert result["attempt_usage"] == [None, {"prompt_tokens": 3, "completion_tokens": 2}]
    assert "只包含预存款退款" in sent[0]["messages"][0]["content"]


def test_explicit_legacy_baseline_accepts_optional_confidence(monkeypatch):
    request = httpx.Request("POST", "https://unit.test/chat/completions")
    response = httpx.Response(200, json={"model": "deepseek-v4.1-flash", "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        "choices": [{"message": {"content": '{"label":"relevant","reason":"符合业务边界"}'}}]}, request=request)
    monkeypatch.setattr(teacher, "request_json", lambda endpoint, headers, body, **kwargs:
        teacher_transport.request_json(endpoint, headers, body, **kwargs, http_transport=httpx.MockTransport(lambda _: response)))
    result = teacher._label_one(
        {"ticket_id": "t1", "title": "退款", "summary": "退款处理", "body": "退款记录"},
        {"query": "退款", "labeling_guidance": "只包含预存款退款"},
        endpoint="https://unit.test/chat/completions", model="deepseek-v4.1-flash", api_key="fake", session_id=None, text_mode="legacy_full_body",
    )
    assert result["label"] == 1
    assert result["teacher"]["confidence"] is None
    assert result["teacher"]["confidence_kind"] == "not_provided"


def test_limit_prefix_can_resume_by_removing_limit_without_relabeling_cached_rows(tmp_path, monkeypatch):
    condition_dir = tmp_path / "condition"
    condition_dir.mkdir()
    rows = [{"ticket_id": f"t{i}", "title": "标题", "summary": "摘要", "body": "正文"} for i in range(3)]
    (condition_dir / "candidates.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    (condition_dir / "manifest.json").write_text(json.dumps({"condition_id": "C01", "candidate_count": 3,
        "query": "测试问题", "labeling_guidance": "保持原有业务边界"}), encoding="utf-8")
    env_file = tmp_path / ".env"
    env_file.write_text("RETRIEVAL_AGENT_BROWSER_LLM_MODEL=deepseek-v4.1-flash\n"
                        "RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL=https://unit.test/v1\n"
                        "RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV=TEST_API_KEY\nTEST_API_KEY=fake\n", encoding="utf-8")
    calls = []

    def fake_label(row, condition, **kwargs):
        calls.append(row["ticket_id"])
        assert condition["labeling_guidance"] == "保持原有业务边界"
        return {**row, "label": 1, "label_source": "deepseek-v4.1-flash", "attempts": 1,
                "attempt_seconds": [0.01], "attempt_usage": [{"prompt_tokens": 1, "completion_tokens": 1}],
                "teacher": {"prompt_sha256": "fixture", "reported_model_matches_requested": True}}

    monkeypatch.setattr(teacher, "_label_one", fake_label)
    label_synthetic_condition(condition_dir, env_file, workers=1, limit=1)
    assert calls == ["t0"]
    label_synthetic_condition(condition_dir, env_file, workers=1)
    assert calls == ["t0", "t1", "t2"]
    assert len(teacher.read_jsonl(condition_dir / "labeled.jsonl")) == 3
    metadata = json.loads((condition_dir / "label_manifest.json").read_text(encoding="utf-8"))
    assert metadata["label_status"] == "complete"
    assert metadata["physical_requests"] == 3

def test_short_teacher_sends_only_canonical_title_and_abstract(monkeypatch):
    sent = []
    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"model": "deepseek-v4.1-flash", "usage": {
            "prompt_tokens": 2, "completion_tokens": 1}, "choices": [{"message": {
            "content": '{"label":"no","confidence":0.7}'}}]})
    monkeypatch.setattr(teacher, "request_json", lambda endpoint, headers, body, **kwargs:
        teacher_transport.request_json(endpoint, headers, body, **kwargs, http_transport=httpx.MockTransport(handler)))
    result = teacher._label_one({"ticket_id": "synthetic", "title": "虚构标题", "summary": "虚构摘要",
        "body": "SYNTHETIC_BODY_MUST_NOT_BE_SENT"}, {"query": "虚构查询"},
        endpoint="https://fixture.invalid/chat/completions", model="deepseek-v4.1-flash", api_key="fixture", session_id=None)
    assert result["label"] == 0
    assert result["teacher"]["p_yes"] == pytest.approx(0.3)
    assert result["teacher"]["score_kind"] == "self_reported_predicted_label_score"
    assert "reason" not in result["teacher"] and "raw_response" not in result["teacher"]
    assert "SYNTHETIC_BODY_MUST_NOT_BE_SENT" not in json.dumps(sent)
    assert sent[0]["max_tokens"] == 128
    assert result["attempts"] == len(sent) == 1


def test_short_teacher_missing_score_stays_error_and_never_becomes_negative(monkeypatch):
    async def no_wait(_seconds):
        return None
    monkeypatch.setattr(teacher_transport.asyncio, "sleep", no_wait)
    count = 0
    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"label":"no"}'}}]})
    monkeypatch.setattr(teacher, "request_json", lambda endpoint, headers, body, **kwargs:
        teacher_transport.request_json(endpoint, headers, body, **kwargs, http_transport=httpx.MockTransport(handler)))
    result = teacher._label_one({"ticket_id": "synthetic", "title": "虚构标题", "summary": "虚构摘要"},
        {"query": "虚构查询"}, endpoint="https://fixture.invalid/chat/completions",
        model="deepseek-v4.1-flash", api_key="fixture", session_id=None)
    assert result["label"] is None and result["label_source"] is None
    assert result["teacher_error"]["error"] == "LABEL_SCHEMA_INVALID"
    assert result["teacher_error"]["attempts"] == count == 3
    assert "raw_response" not in result["teacher_error"]


@pytest.mark.parametrize("changed", ["query", "guidance", "title", "abstract", "model", "prompt_version"])
def test_cache_identity_changes_force_relabel_but_same_identity_reuses(tmp_path, monkeypatch, changed):
    condition_dir = tmp_path / "condition"
    condition_dir.mkdir()
    row = {"ticket_id": "same-id", "title": "虚构标题", "summary": "虚构摘要", "body": "虚构旧正文"}
    condition = {"candidate_count": 1, "query": "虚构查询", "labeling_guidance": "虚构边界"}
    env_file = tmp_path / ".env"
    env_file.write_text("# synthetic configuration supplied in process only\n", encoding="utf-8")
    configured_model = ["deepseek-v4.1-flash"]
    monkeypatch.setattr(teacher, "load_teacher_config", lambda *_: teacher_transport.TeacherConfig(
        "https://fixture.invalid/chat/completions", configured_model[0], "fixture-key"))
    calls = []
    def fake_label(item, cond, **kwargs):
        calls.append(item["ticket_id"])
        return {**item, "label": 1, "label_source": "deepseek-v4.1-flash", "attempts": 1,
                "attempt_seconds": [0.01], "attempt_usage": [{"prompt_tokens": 1, "completion_tokens": 1}],
                "teacher": {"prompt_sha256": "synthetic", "reported_model_matches_requested": True}}
    monkeypatch.setattr(teacher, "_label_one", fake_label)
    def save():
        (condition_dir / "manifest.json").write_text(json.dumps(condition), encoding="utf-8")
        (condition_dir / "candidates.jsonl").write_text(json.dumps(row) + "\n", encoding="utf-8")
    save()
    # Old ID-only cache must never be trusted by the new projection / prompt.
    (condition_dir / "labeled.jsonl").write_text(json.dumps({**row, "label": 0,
        "label_source": "deepseek-v4.1-flash", "teacher": {"prompt_sha256": "legacy"}}) + "\n", encoding="utf-8")
    label_synthetic_condition(condition_dir, env_file, workers=1)
    label_synthetic_condition(condition_dir, env_file, workers=1)
    assert calls == ["same-id"]
    if changed == "query":
        condition["query"] += "新要求"
    elif changed == "guidance":
        condition["labeling_guidance"] += "新边界"
    elif changed == "title":
        row["title"] += "新内容"
    elif changed == "abstract":
        row["summary"] += "新内容"
    elif changed == "model":
        configured_model[0] += "-alternative"
    else:
        monkeypatch.setattr(teacher, "PROMPT_VERSION", teacher.PROMPT_VERSION + "-alternative")
    save()
    metadata = label_synthetic_condition(condition_dir, env_file, workers=1)
    assert calls == ["same-id", "same-id"]
    assert metadata["physical_requests"] == 1  # Prior identity is a separate experiment.
    assert teacher.read_jsonl(condition_dir / "labeled.jsonl")[0]["label"] == 1


def test_body_changes_affect_only_explicit_legacy_identity():
    row = {"ticket_id": "synthetic", "title": "虚构标题", "summary": "虚构摘要", "body": "旧虚构正文"}
    condition = {"query": "虚构查询"}
    short = teacher._teacher_material(row, condition, "deepseek-v4.1-flash")
    legacy = teacher._teacher_material(row, condition, "deepseek-v4.1-flash", "legacy_full_body")
    row["body"] = "新虚构正文"
    assert teacher._teacher_material(row, condition, "deepseek-v4.1-flash")["cache_key"] == short["cache_key"]
    assert teacher._teacher_material(row, condition, "deepseek-v4.1-flash", "legacy_full_body")["cache_key"] != legacy["cache_key"]


@pytest.fixture
def gated_condition(tmp_path, monkeypatch):
    config = teacher_transport.TeacherConfig("https://fixture.invalid/chat/completions", "deepseek-v4.1-flash", "fixture-key")
    monkeypatch.setattr(teacher, "load_teacher_config", lambda *_: config)
    directory = tmp_path / "synthetic"
    directory.mkdir()
    condition = {"candidate_count": 1, "query": "虚构查询", "labeling_guidance": "虚构边界"}
    row = {"ticket_id": "synthetic", "title": "虚构标题", "summary": "虚构摘要", "body": "SYNTHETIC_BODY_NOT_SENT"}
    (directory / "manifest.json").write_text(json.dumps(condition), encoding="utf-8")
    (directory / "candidates.jsonl").write_text(json.dumps(row) + "\n", encoding="utf-8")
    return directory, tmp_path / ".env", config, row


@pytest.mark.parametrize("gate_case,expected", [
    ("missing_target", "TARGET_CONFIRMATION_REQUIRED"),
    ("wrong_target", "TARGET_CONFIRMATION_REQUIRED"),
    ("missing_content", "INPUT_CONTENT_CONFIRMATION_REQUIRED"),
    ("wrong_content", "INPUT_CONTENT_CONFIRMATION_MISMATCH"),
    ("rejected_content", "INPUT_CONTENT_GATE_REJECTED"),
    ("failed_content", "INPUT_CONTENT_GATE_FAILED"),
])
def test_input_gate_blocks_before_requests_or_label_file_mutation(gated_condition, monkeypatch, gate_case, expected):
    directory, env_file, config, _ = gated_condition
    monkeypatch.setattr(teacher, "_label_one", lambda *_args, **_kwargs: pytest.fail("must not send"))
    kwargs = {}
    if gate_case != "missing_target":
        kwargs["verified_endpoint_fingerprint"] = ("wrong" if gate_case == "wrong_target" else
            config.public_identity()["endpoint_fingerprint"])
    if gate_case == "wrong_content":
        kwargs["reviewed_candidates_sha256"] = "wrong"
    elif gate_case == "rejected_content":
        kwargs["content_gate"] = lambda payload: False
    elif gate_case == "failed_content":
        def fail(payload):
            raise RuntimeError("fixture-secret-do-not-emit")
        kwargs["content_gate"] = fail
    with pytest.raises(teacher_transport.TeacherConfigurationError) as error:
        teacher.label_condition(directory, env_file, **kwargs)
    assert str(error.value) == expected
    assert not (directory / "labeled.jsonl").exists()
    assert not (directory / "label_manifest.json").exists()


def test_explicit_content_gate_sees_actual_canonical_material_and_cache_consumer(gated_condition, monkeypatch):
    directory, env_file, config, _ = gated_condition
    calls, gate_inputs = [], []
    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        return httpx.Response(200, json={"model": config.model, "usage": {"prompt_tokens": 4, "completion_tokens": 2},
            "choices": [{"message": {"content": '{"label":"yes","confidence":0.8}'}}]})
    monkeypatch.setattr(teacher, "request_json", lambda endpoint, headers, body, **kwargs:
        teacher_transport.request_json(endpoint, headers, body, **kwargs, http_transport=httpx.MockTransport(handler)))
    def content_gate(payload):
        gate_inputs.append(payload)
        return True
    for _ in range(2):
        metadata = teacher.label_condition(directory, env_file, workers=1,
            verified_endpoint_fingerprint=config.public_identity()["endpoint_fingerprint"], content_gate=content_gate)
    assert len(calls) == metadata["physical_requests"] == 1
    assert len(gate_inputs) == 2
    material = json.dumps(gate_inputs, ensure_ascii=False)
    assert "SYNTHETIC_BODY_NOT_SENT" not in material and "fixture-key" not in material
    assert gate_inputs[0]["query"] == "虚构查询" and gate_inputs[0]["labeling_guidance"] == "虚构边界"
    assert gate_inputs[0]["tickets"][0]["abstract"] == "虚构摘要"
    assert metadata["input_content_confirmation"] == "explicit_content_gate_accepted"
    assert metadata["pii_safety_automatically_verified"] is False
    row = teacher.read_jsonl(directory / "labeled.jsonl")[0]
    assert row["label"] == 1 and row["attempts"] == 1 and row["teacher"]["cache_key"]
    assert row["teacher"]["score_kind"] == "self_reported_predicted_label_score"


def test_matching_candidate_hash_confirms_only_bytes_and_still_requires_verified_target(gated_condition, monkeypatch):
    directory, env_file, config, row = gated_condition
    checksum = hashlib.sha256((directory / "candidates.jsonl").read_bytes()).hexdigest()
    monkeypatch.setattr(teacher, "_label_one", lambda item, cond, **kwargs: {
        **item, "label": 0, "label_source": "deepseek-v4.1-flash", "teacher": {"prompt_sha256": "synthetic"},
        "attempt_seconds": [0.01], "attempt_usage": [None]})
    with pytest.raises(teacher_transport.TeacherConfigurationError, match="TARGET_CONFIRMATION_REQUIRED"):
        teacher.label_condition(directory, env_file, reviewed_candidates_sha256=checksum)
    metadata = teacher.label_condition(directory, env_file,
        verified_endpoint_fingerprint=config.public_identity()["endpoint_fingerprint"], reviewed_candidates_sha256=checksum)
    assert metadata["input_content_confirmation"] == "candidate_bytes_confirmed"
    assert metadata["candidate_bytes_sha256"] == checksum
    assert metadata["pii_safety_automatically_verified"] is False


def test_untrusted_reported_model_is_not_persisted_as_metadata(monkeypatch):
    secret = "fixture-secret-do-not-emit"
    monkeypatch.setattr(teacher, "request_json", lambda endpoint, headers, body, **kwargs:
        teacher_transport.request_json(endpoint, headers, body, **kwargs, http_transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"model": secret, "choices": [{"message": {
                "content": '{"label":"no","confidence":0.7}'}}]}))))
    row = teacher._label_one({"ticket_id": "synthetic", "title": "虚构标题", "summary": "虚构摘要"},
        {"query": "虚构查询"}, endpoint="https://fixture.invalid/chat/completions",
        model="deepseek-v4.1-flash", api_key="fixture", session_id=None)
    assert row["label"] is None and row["label_source"] is None
    assert row["teacher_error"]["error"] == "TEACHER_MODEL_MISMATCH"
    assert secret not in json.dumps(row)


def test_teacher_cli_sanitizes_unexpected_content_gate_failures(monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["teacher", "--condition", "synthetic"])
    def fail(*_args, **_kwargs):
        raise RuntimeError("fixture-secret-do-not-emit")
    monkeypatch.setattr(teacher, "label_condition", fail)
    assert teacher.main() == 2
    assert json.loads(capsys.readouterr().out) == {"error_code": "TEACHER_INTERNAL_ERROR"}
