import asyncio
import json
import pytest
from caseweave_ops.runtime import ModelRequestError, Runtime, ArtifactStore, ModelReply, Usage, SamplingLimitReached
from caseweave_ops.types import Scope, Knowledge
from caseweave_ops import invoke_rows
from conftest import source, collect
from test_learning_sets import numeric_port
from caseweave_ops.filter import DECISION_SCHEMA


class Port:
    identity = "retry-test"
    def __init__(self, responses): self.responses, self.requests = iter(responses), []
    async def generate(self, request):
        self.requests.append(request)
        response = next(self.responses)
        if isinstance(response, Exception): raise response
        return ModelReply(response, Usage(3, 2, 1))


def no_delay(monkeypatch):
    async def wait_for(waiter, timeout):
        waiter.close()
        raise asyncio.TimeoutError()
    monkeypatch.setattr("caseweave_ops.runtime.asyncio.wait_for", wait_for)


def test_transport_failure_then_success_gets_new_receipt_and_counts_both(tmp_path, monkeypatch):
    port = Port([ModelRequestError("TRANSPORT", "temporarily unavailable", True, usage=Usage(7, 2, 1)), {"ok": True}])
    store = ArtifactStore(tmp_path / "retry.sqlite")
    rt = Runtime(Scope("t", 1, "s", "a"), port, store, Knowledge("w"))
    result = asyncio.run(rt.call("sem_filter", "x", {}, {"type": "object"}))
    calls = store.db.execute("select id,status from calls order by started").fetchall()
    assert len(calls) == 2 and [c[1] for c in calls] == ["error", "ok"]
    assert calls[0][0] != calls[1][0] == result.manifest_id
    assert store.metrics("t")["reported_prompt_tokens"] == 10
    cached = asyncio.run(rt.call("sem_filter", "x", {}, {"type": "object"}))
    assert cached.cache_hit and len(port.requests) == 2


def test_persistent_and_nonretryable_failures_are_recorded_and_raised(tmp_path, monkeypatch):
    for retryable, expected in [(True, 3), (False, 1)]:
        store = ArtifactStore(tmp_path / f"{retryable}.sqlite")
        port = Port([ModelRequestError("TRANSPORT", "failed", retryable) for _ in range(3)])
        rt = Runtime(Scope("t", 1, "s", "a"), port, store, Knowledge("w"))
        with pytest.raises(ModelRequestError): asyncio.run(rt.call("sem_filter", "x", {}, {"type": "object"}))
        assert len(port.requests) == expected
        assert store.db.execute("select count(*) from calls").fetchone()[0] == expected


def test_cancel_during_backoff_stops_retry(tmp_path, monkeypatch):
    scope = Scope("t", 1, "s", "a")
    async def pause(waiter, timeout):
        waiter.close()
        scope.cancelled.set()
        await asyncio.sleep(0)
        return True
    monkeypatch.setattr("caseweave_ops.runtime.asyncio.wait_for", pause)
    store = ArtifactStore(tmp_path / "cancel.sqlite")
    port = Port([ModelRequestError("TRANSPORT", "failed", True), {"ok": True}])
    rt = Runtime(scope, port, store, Knowledge("w"))
    with pytest.raises(asyncio.CancelledError): asyncio.run(rt.call("sem_filter", "x", {}, {"type": "object"}))
    assert len(port.requests) == 1


def test_only_query_operations_retry(tmp_path, monkeypatch):
    store = ArtifactStore(tmp_path / "report.sqlite")
    port = Port([ModelRequestError("TRANSPORT", "failed", True)])
    rt = Runtime(Scope("t", 1, "s", "a"), port, store, Knowledge("w"))
    with pytest.raises(ModelRequestError): asyncio.run(rt.call("report", "x", {}, {"type": "object"}))
    assert len(port.requests) == 1


def test_retry_uses_shared_sampling_budget_across_restart(tmp_path, monkeypatch):
    path = tmp_path / "budget.sqlite"
    store = ArtifactStore(path)
    scope = Scope("t", 1, "s", "a")
    for _ in range(127):
        ident = store.begin("t", scope.key, "sem_filter", {"input_revision": 1}, sampling_scope=scope)
        store.finish(ident, "error", Usage(), "prior_failure")
    port = Port([ModelRequestError("TRANSPORT", "failed", True), {"ok": True}])
    rt = Runtime(scope, port, store, Knowledge("w"))
    result = asyncio.run(rt.call("sem_filter", "x", {}, {"type": "object"}, sampling=True, use_cache=False))
    assert result.payload == {"ok": True} and len(port.requests) == 2
    assert store.sampling_calls(scope) == 128
    rows = store.db.execute("select id,request_json,status from calls order by started").fetchall()
    manifests = [json.loads(row[1]) for row in rows[-2:]]
    assert [item["retry_attempt"] for item in manifests] == [0, 1]
    assert manifests[1]["retry_of"] == rows[-2][0]
    assert store.db.execute("select count(*) from calls").fetchone()[0] == 129
    resumed = ArtifactStore(path)
    rt.store = resumed
    with pytest.raises(SamplingLimitReached): asyncio.run(rt.call("sem_filter", "x", {"new": True}, {"type": "object"}, sampling=True, use_cache=False))
    assert len(port.requests) == 2 and resumed.sampling_calls(scope) == 128


def test_concurrent_retries_do_not_consume_additional_logical_quota(tmp_path, monkeypatch):
    class ConcurrentPort:
        identity = "concurrent-retry"
        def __init__(self): self.calls = 0
        async def generate(self, request):
            self.calls += 1
            number = self.calls
            await asyncio.sleep(0)
            if number <= 64: raise ModelRequestError("TRANSPORT", "temporary", True)
            return ModelReply({"ok": True})
    store = ArtifactStore(tmp_path / "concurrent.sqlite")
    port = ConcurrentPort()
    rt = Runtime(Scope("t", 1, "s", "a"), port, store, Knowledge("w"))
    async def run():
        return await asyncio.gather(*(rt.call("sem_filter", "x", {"i": i}, {"type": "object"}, sampling=True,
            use_cache=False) for i in range(128)), return_exceptions=True)
    results = asyncio.run(run())
    assert all(not isinstance(result, Exception) for result in results)
    assert store.sampling_calls(rt.scope) == 128
    assert port.calls == 192
    assert store.metrics("t")["failed_attempts"] == 64


def test_filter_cancels_and_settles_sibling_requests_after_retry_exhaustion(make_runtime):
    import numpy as np
    rt = make_runtime()
    numeric_port(rt, np.ones((2000, 2), dtype=np.float32), np.zeros(2000, dtype=np.int8))
    failing_ref = None
    async def fail(payload, request):
        nonlocal failing_ref
        ref = payload["records"][0]["ref"]
        if failing_ref is None: failing_ref = ref
        if ref == failing_ref: raise ModelRequestError("TRANSPORT", "unavailable", True)
        await asyncio.Event().wait()
    rt.model.handler = fail
    async def execute():
        return await collect(invoke_rows("sem_filter", rt, source([]), "predicate", {
            "batch_size": 1, "options": {"pool_size": 256, "sample_size": 64,
                "selection_size": 64, "concurrency": 4}}))
    with pytest.raises(ModelRequestError): asyncio.run(execute())
    metrics = rt.store.metrics(rt.scope.task_id)
    assert metrics["running"] == 0
    assert metrics["cancelled_attempts"] > 0


def test_missing_knowledge_ids_in_three_of_four_rows_retries_under_one_sampling_slot(tmp_path, monkeypatch):
    no_delay(monkeypatch)
    malformed = {"rows": [
        {"ref": "@r1", "label": "accept", "citations": [], "knowledge_ids": [], "reason": "ok"},
        {"ref": "@r2", "label": "exclude", "citations": [], "reason": "missing knowledge_ids"},
        {"ref": "@r3", "label": "undetermined", "citations": [], "reason": "missing knowledge_ids"},
        {"ref": "@r4", "label": "accept", "citations": [], "reason": "missing knowledge_ids"},
    ]}
    corrected = {"rows": [
        {"ref": f"@r{i}", "label": "undetermined", "citations": [], "knowledge_ids": [], "reason": "ok"}
        for i in range(1, 5)
    ]}
    port = Port([malformed, corrected])
    store = ArtifactStore(tmp_path / "output-schema.sqlite")
    scope = Scope("t", 123, "s", "a")
    runtime = Runtime(scope, port, store, Knowledge("w"))

    result = asyncio.run(runtime.call("sem_filter", "predicate", {"records": [1, 2, 3, 4]}, DECISION_SCHEMA,
        sampling=True, use_cache=False))

    calls = store.db.execute("select id,status,request_json,prompt,completion,cached from calls order by started").fetchall()
    assert result.payload == corrected and len(calls) == 2
    assert [call[1] for call in calls] == ["error", "ok"]
    requests = [json.loads(call[2]) for call in calls]
    assert [request["retry_attempt"] for request in requests] == [0, 1]
    assert requests[1]["retry_of"] == calls[0][0]
    assert store.sampling_calls(scope) == 1
    assert store.metrics("t")["llm_adapter_calls"] == 2
    assert (calls[0][3], calls[0][4], calls[0][5]) == (3, 2, 1)


def test_three_output_schema_failures_settle_with_usage_and_one_quota_slot(tmp_path, monkeypatch):
    no_delay(monkeypatch)
    malformed = {"rows": [
        {"ref": "@r1", "label": "accept", "citations": [], "reason": "missing knowledge_ids"},
    ]}
    port = Port([malformed, malformed, malformed])
    store = ArtifactStore(tmp_path / "output-schema-exhausted.sqlite")
    scope = Scope("t", 123, "s", "a")
    runtime = Runtime(scope, port, store, Knowledge("w"))

    with pytest.raises(ModelRequestError) as captured:
        asyncio.run(runtime.call("sem_filter", "predicate", {"records": [1]}, DECISION_SCHEMA,
            sampling=True, use_cache=False))

    error = captured.value
    calls = store.db.execute("select status,prompt,completion,cached,request_json from calls").fetchall()
    assert error.code == "OUTPUT_SCHEMA" and error.retryable and error.retries_handled
    assert error.usage == Usage(3, 2, 1)
    assert len(calls) == 3 and [call[0] for call in calls] == ["error"] * 3
    assert [json.loads(call[4])["retry_attempt"] for call in calls] == [0, 1, 2]
    assert all(call[1:4] == (3, 2, 1) for call in calls)
    assert store.sampling_calls(scope) == 1
