"""显式本地调用入口；未指定 --live 和模型配置时绝不发起远程请求。"""
from __future__ import annotations
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from .types import Scope, Knowledge, canonical
from .store import ArtifactStore
from .model import Runtime, OpenAICompatibleModel
from .search import JsonlBackend
from .dispatch import invoke_rows


async def run(args):
    # 用显式开关保护真实模型调用，离线演示必须走标注好的测试替身。
    if not args.live:
        raise ValueError("Remote execution requires --live; use examples/offline_demo.py for the labelled test double")
    base = os.environ.get("CASEWEAVE_LLM_BASE_URL")
    model = os.environ.get("CASEWEAVE_LLM_MODEL")
    if not base or not model:
        raise ValueError("Set CASEWEAVE_LLM_BASE_URL and CASEWEAVE_LLM_MODEL; no default provider is silently selected")
    # 所有输入、Wiki、参数和状态路径均来自命令行，不暗选默认数据或 Provider。
    source = JsonlBackend(args.input)
    knowledge = json.loads(Path(args.wiki).read_text(encoding="utf-8")) if args.wiki else {"release": "empty", "entries": []}
    params = json.loads(Path(args.params).read_text(encoding="utf-8")) if args.params else {}
    store = ArtifactStore(args.state)
    transport = OpenAICompatibleModel(base, model, os.environ.get("CASEWEAVE_LLM_API_KEY", ""))
    runtime = Runtime(Scope(args.task, 1, args.snapshot, "local-file-owner"), transport, store,
                      Knowledge(knowledge["release"], tuple(knowledge.get("entries", []))))
    try:
        # 算子结果按 NDJSON 逐条输出，结束后追加本次任务的可观测计量。
        async for value in invoke_rows(args.op, runtime, source.records(), args.instruction, params):
            print(canonical(value), flush=True)
        print(canonical({"type": "metrics", "value": store.metrics(args.task)}), flush=True)
    finally:
        # 正常完成和异常退出都关闭网络连接与本地产物库。
        await transport.aclose()
        store.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--op", choices=["sem_filter", "sem_topk", "sem_map", "sem_extract", "sem_agg"], default="sem_filter")
    p.add_argument("--input", required=True)
    p.add_argument("--instruction", required=True)
    p.add_argument("--wiki")
    p.add_argument("--params")
    p.add_argument("--state", default=".caseweave/operator-artifacts.sqlite")
    p.add_argument("--task", required=True)
    p.add_argument("--snapshot", required=True)
    p.add_argument("--live", action="store_true")
    args = p.parse_args()
    try: asyncio.run(run(args))
    except Exception as exc:
        # 错误保持机器可读 JSON，并用非零退出码交给调用方处理。
        print(canonical({"error": type(exc).__name__, "message": str(exc)}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__": main()
