"""当前宿主 stdio 的真实子进程和一次规划回调。"""
import json
import os
import subprocess
import sys
from pathlib import Path


def test_actual_stdio_query_plan_callback(tmp_path):
    root = Path(__file__).resolve().parents[1]
    process = subprocess.Popen([sys.executable, "-m", "caseweave_ops.server", "--stdio",
        "--state", str(tmp_path / "rpc.sqlite")], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        env={**os.environ, "PYTHONPATH": str(root / "src")})
    def send(value):
        process.stdin.write(json.dumps(value, ensure_ascii=False) + "\n")
        process.stdin.flush()
    context = {"fixed_orchestration": True, "fixed_goal": {"mode": "all", "count": None},
               "full_user_text": "账号权限异常", "search_fields": [], "evidence_fields": []}
    send({"type": "run", "job": "plan", "scope": {"task_id": "t", "input_revision": 1,
        "snapshot": "s", "authorization": "host"}, "knowledge": {"release": "none", "entries": []},
        "model_identity": "local-contract", "op": "query_plan", "instruction": "账号权限异常",
        "params": {"confirmed_context": json.dumps(context, ensure_ascii=False)}})
    calls = 0
    try:
        while True:
            frame = json.loads(process.stdout.readline())
            if frame["type"] == "request":
                assert frame["method"] == "llm.generate"
                calls += 1
                send({"type": "response", "id": frame["id"], "payload": {"payload": {
                    "keywords": ["账号", "权限"], "instruction": "账号权限异常",
                    "retrieval_expressions": ["账号权限异常"], "structured_conditions": [],
                    "require_source": False, "required_fields": []}, "usage": {}}})
            elif frame["type"] == "error":
                raise AssertionError(frame)
            elif frame["type"] == "done":
                break
        assert calls == 1
        send({"type": "shutdown"})
        process.stdin.close()
        assert process.wait(timeout=10) == 0
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
