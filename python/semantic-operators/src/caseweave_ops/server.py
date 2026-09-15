"""提供常驻 FastAPI 传输层，回调和身份只能由可信宿主提供。

单个 WebSocket 只拥有本连接中的运行作业，不拥有产品任务生命周期。工作连接断开
会取消当前计算，持久化宿主再从 MySQL 状态和算子产物恢复；浏览器页面不得直连
此接口。
"""
from __future__ import annotations
import asyncio
import hmac
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from .rpc import Bridge
from .store import ArtifactStore


def create_app(state_path: str | Path, token: str = "") -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        # 产物库与服务生命周期一致，服务退出时统一关闭 SQLite 连接。
        app.state.artifacts = ArtifactStore(state_path)
        try: yield
        finally: app.state.artifacts.close()

    app = FastAPI(title="CaseWeave semantic operators", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.get("/health")
    async def health():
        return {"status": "ready", "protocol": "caseweave-operators-v1", "transport": "websocket"}

    @app.websocket("/v1/operators")
    async def operators(socket: WebSocket):
        # 从子协议中拆出鉴权令牌，同时保留正式协议名用于协商。
        protocols = socket.headers.get("sec-websocket-protocol", "").split(",")
        protocols = [p.strip() for p in protocols]
        supplied = next((p[5:] for p in protocols if p.startswith("auth.")), "")
        # 拒绝带 Origin 的浏览器直连；外部调用必须经过公开且有权限校验的 TaskHost。
        if socket.headers.get("origin") or (token and not hmac.compare_digest(token, supplied)):
            await socket.close(code=1008)
            return
        await socket.accept(subprotocol="caseweave-operators-v1" if "caseweave-operators-v1" in protocols else None)
        # Bridge 的同步 send 只入队，独立 writer 负责串行写 Socket，避免并发发送冲突。
        outgoing = asyncio.Queue()

        class SocketBridge(Bridge):
            def send(self, value): outgoing.put_nowait(value)

        bridge = SocketBridge(app.state.artifacts)
        async def writer():
            while True: await socket.send_json(await outgoing.get())
        sending = asyncio.create_task(writer())
        try:
            while True:
                text = await socket.receive_text()
                # 在解析 JSON 前限制单帧大小，避免超大输入占用不可控内存。
                if len(text.encode("utf-8")) > 16 * 1024 * 1024:
                    await socket.close(code=1009); break
                try:
                    if not await bridge.handle(json.loads(text)): break
                except (ValueError, TypeError, KeyError):
                    bridge.send({"type": "error", "error": "invalid_frame"})
        except WebSocketDisconnect: pass
        finally:
            # 连接断开即取消其全部作业并回收发送任务，后续恢复由持久化宿主负责。
            await bridge.close()
            sending.cancel()
            await asyncio.gather(sending, return_exceptions=True)

    return app


def main():
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser(description="Persistent CaseWeave operator service")
    parser.add_argument("--state", default=".cache/semantic-operators/artifacts.sqlite")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8013)
    args = parser.parse_args()
    uvicorn.run(create_app(args.state, os.environ.get("CASEWEAVE_OPERATORS_TOKEN", "")), host=args.host, port=args.port)


if __name__ == "__main__": main()
