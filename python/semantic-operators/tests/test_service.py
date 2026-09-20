import asyncio
import json
import os
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from caseweave_ops import *
from caseweave_ops.server import create_app
from conftest import record, decisions

def test_actual_stdio_python_subprocess_with_scripted_host(tmp_path):
    root=Path(__file__).resolve().parents[1]
    env={**os.environ,"PYTHONPATH":str(root/"src")}
    p=subprocess.Popen([sys.executable,"-m","caseweave_ops.server","--stdio","--state",str(tmp_path/"rpc.sqlite")],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding="utf-8",env=env)
    def send(v):p.stdin.write(json.dumps(v,ensure_ascii=False)+"\n");p.stdin.flush()
    rows=[record(str(i)) for i in range(5)]
    send({"type":"run","job":"j","scope":{"task_id":"t","input_revision":1,"snapshot":"s","authorization":"host-auth"},
          "knowledge":{"release":"w","entries":[]},"model_identity":"scripted-dsh-host-test",
          "op":"sem_filter","source_handle":"trusted-set","instruction":"x","params":{"scope_mode":"candidates","batch_size":2}})
    frames=[]
    try:
        while True:
            line=p.stdout.readline()
            assert line, p.stderr.read()
            v=json.loads(line);frames.append(v)
            if v["type"]=="request":
                if v["method"]=="rows.read":
                    answer={"rows":[asdict(r) for r in rows],"next_cursor":None}
                elif v["method"]=="llm.generate":
                    payload=json.loads(v["payload"]["messages"][-1]["content"])
                    answer={"payload":decisions(payload),"usage":{"prompt_tokens":100,"completion_tokens":20,"cached_prompt_tokens":40}}
                else:raise AssertionError(v)
                send({"type":"response","id":v["id"],"payload":answer})
            elif v["type"]=="done":break
            elif v["type"]=="error":raise AssertionError(v)
        send({"type":"shutdown"});p.stdin.close()
        assert p.wait(timeout=10)==0
        outputs=[v for v in frames if v["type"]=="result"]
        assert len(outputs)==5
        assert frames[-1]["metrics"]["reported_prompt_tokens"]==600
        assert sum(v.get("method")=="llm.generate" for v in frames)==6
    finally:
        if p.poll() is None:p.kill();p.wait()


def test_fastapi_parallel_jobs_and_host_callbacks(tmp_path):
    with TestClient(create_app(tmp_path / "api.sqlite", "host-secret")) as client:
        assert client.get("/health").json()["protocol"] == "caseweave-operators-v1"
        with client.websocket_connect("/v1/operators", subprotocols=["caseweave-operators-v1", "auth.host-secret"]) as ws:
            for task in ("first", "second"):
                ws.send_json({"type": "run", "job": task, "scope": {"task_id": task, "input_revision": 1, "snapshot": "s", "authorization": "trusted"},
                    "knowledge": {"release": "none", "entries": []}, "model_identity": "fixture", "op": "sem_filter", "instruction": "副卡",
                    "source_handle": task, "params": {"scope_mode":"candidates","batch_size": 1}})
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
                    assert frame["metrics"]["usage_missing_attempts"] == 2
                else: pytest.fail(str(frame))
            assert outputs["first"]["ref"] == "first"
            assert outputs["second"]["ref"] == "second"


@pytest.mark.parametrize("headers,protocols", [({}, []), ({"origin": "https://untrusted.example"}, ["auth.host-secret"])])
def test_fastapi_rejects_wrong_token_and_browser_origin(tmp_path, headers, protocols):
    with TestClient(create_app(tmp_path / "auth.sqlite", "host-secret")) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/v1/operators", headers=headers, subprotocols=protocols): pass
