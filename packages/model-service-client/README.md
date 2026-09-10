# @retrieval-agent/model-service-client

同一 Python 模型服务的 TypeScript HTTP 客户端：主入口提供 embedding/rerank 与握手，`/protocol` 提供线协议，`/ranking` 提供排名、候选边界校验和可取消的索引准备。按实际能力选择子入口；排名与 embedding 的超时、响应校验和生命周期各自保留。

公共入口、依赖和构建脚本由 [package.json](package.json) 声明。产品语义见 [产品规格](../../docs/PRODUCT_REQUIREMENTS.md)，组件关系见 [架构说明](../../docs/ARCHITECTURE.md)。
