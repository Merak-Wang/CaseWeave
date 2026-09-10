# CaseWeave Model Service

Python/FastAPI 检索计算与模型服务，提供当前查询分析、排名、embedding 和可选 reranker 能力。产品领域状态与判断职责由 TypeScript domain/Agent 侧负责。

环境与入口由 [pyproject.toml](pyproject.toml) 及源码维护。运行命令统一见仓库 [开发说明](../../docs/DEVELOPMENT.md)，模型身份由 [model manifest](../../architecture/model-manifest.json) 声明。

支持宿主 uv 开发入口和 Linux x86_64 容器入口。容器的构建、首次模型准备、CPU/GPU 启动、停止与镜像迁移统一使用根 `pnpm model:container`；详见开发说明的“Python 模型服务容器部署”。镜像不包含业务数据或 Qwen 权重，准备后只读离线加载模型。

模型容量、批次与运行策略通过配置声明，更换模型或运行设备后应核验向量、索引身份和查询结果。验证方法见 [评测策略](../../docs/EVALUATION_STRATEGY.md)。
