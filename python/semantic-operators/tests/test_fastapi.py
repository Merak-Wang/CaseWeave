import json
from dataclasses import asdict
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from caseweave_ops.server import create_app
from conftest import record, decisions


def test_fastapi_parallel_jobs_and_host_callbacks(tmp_path):
    with TestClient(create_app(tmp_path / "api.sqlite", "host-secret")) as client:
        assert client.get("/health").json()["protocol"] == "caseweave-operators-v1"
        with client.websocket_connect("/v1/operators", subprotocols=["caseweave-operators-v1", "auth.host-secret"]) as ws:
            for task in ("first", "second"):
                ws.send_json({"type": "run", "job": task, "scope": {"task_id": task, "input_revision": 1, "snapshot": "s", "authorization": "trusted"},
                    "knowledge": {"release": "none", "entries": []}, "model_identity": "fixture", "op": "sem_filter", "instruction": "副卡",
                    "source_handle": task, "params": {"batch_size": 1}})
            outputs, done = {}, set()
            while len(done) < 2:
                frame = ws.receive_json()
                if frame["type"] == "request":
                    if frame["method"] == "rows.read":
                        answer = {"rows": [asdict(record(frame["job"]))], "next_cursor": None}
                    else:
                        answer = {"payload": decisions(json.loads(frame["payload"]["messages"][-1]["content"])), "usage": {}}
                    ws.send_json({"type": "response", "id": frame["id"], "payload": answer})
                elif frame["type"] == "result": outputs[frame["job"]] = frame["value"]["value"]
                elif frame["type"] == "done":
                    done.add(frame["job"])
                    assert frame["metrics"]["usage_missing_attempts"] == 1
                else: pytest.fail(str(frame))
            assert outputs["first"]["ref"] == "first"
            assert outputs["second"]["ref"] == "second"


@pytest.mark.parametrize("headers,protocols", [({}, []), ({"origin": "https://untrusted.example"}, ["auth.host-secret"])])
def test_fastapi_rejects_wrong_token_and_browser_origin(tmp_path, headers, protocols):
    with TestClient(create_app(tmp_path / "auth.sqlite", "host-secret")) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/v1/operators", headers=headers, subprotocols=protocols): pass
