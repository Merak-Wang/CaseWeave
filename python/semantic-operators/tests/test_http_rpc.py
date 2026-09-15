import asyncio
import json
import os
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path
import httpx
import pytest
from caseweave_ops import *
from conftest import record, decisions


def test_real_http_adapter_serialization_with_mock_transport():
    seen=[]
    async def handler(request):
        body=json.loads(request.content); seen.append(body)
        return httpx.Response(200,json={"id":"provider-123","choices":[{"finish_reason":"tool_calls","message":{"reasoning_content":"not-retained",
            "tool_calls":[{"function":{"name":"submit_result","arguments":"{\"value\": 1}"}}]}}],
            "usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":60}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            model=OpenAICompatibleModel("https://model.example/v1","configured-flash",client=client)
            return await model.generate({"messages":[{"role":"user","content":"x"}],"schema":{"type":"object"}})
    reply=asyncio.run(run())
    assert reply.payload=={"value":1} and reply.usage==Usage(100,20,60)
    assert "max_tokens" not in seen[0] and "budget" not in seen[0]
    assert "not-retained" not in repr(reply)


def test_http_429_is_not_an_application_quota():
    async def handler(request):return httpx.Response(429,headers={"retry-after":"2"})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            model=OpenAICompatibleModel("https://model.example/v1","m",client=client)
            with pytest.raises(ProviderError) as e: await model.generate({"messages":[],"schema":{}})
            assert e.value.status==429 and e.value.retry_after=="2"
    asyncio.run(run())


def test_actual_stdio_python_subprocess_with_scripted_host(tmp_path):
    root=Path(__file__).resolve().parents[1]
    env={**os.environ,"PYTHONPATH":str(root/"src")}
    p=subprocess.Popen([sys.executable,"-m","caseweave_ops.rpc","--state",str(tmp_path/"rpc.sqlite")],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding="utf-8",env=env)
    def send(v):p.stdin.write(json.dumps(v,ensure_ascii=False)+"\n");p.stdin.flush()
    rows=[record(str(i)) for i in range(5)]
    send({"type":"run","job":"j","scope":{"task_id":"t","input_revision":1,"snapshot":"s","authorization":"host-auth"},
          "knowledge":{"release":"w","entries":[]},"model_identity":"scripted-dsh-host-test",
          "op":"sem_filter","source_handle":"trusted-set","instruction":"x","params":{"batch_size":2}})
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
        assert frames[-1]["metrics"]["reported_prompt_tokens"]==300
        assert sum(v.get("method")=="llm.generate" for v in frames)==3
    finally:
        if p.poll() is None:p.kill();p.wait()


def test_existing_embedding_wire_identity_is_checked():
    async def handler(request):
        req=json.loads(request.content)
        assert req["requireCompleteInput"] is True and req["inputType"]=="query"
        return httpx.Response(200,json={"requestId":req["requestId"],"protocolVersion":"p1","model":"m","revision":"r1",
          "dimensions":2,"normalization":"l2","inputComplete":True,"data":[{"index":0,"embedding":[1,0]}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            model=ExistingEmbeddingService("http://local.example","m","r1",2,"p1","identity",client=client)
            assert await model.embed_queries(["q"])==[[1.0,0.0]]
            model.revision="different"
            with pytest.raises(ValueError):await model.embed_queries(["q"])
    asyncio.run(run())
