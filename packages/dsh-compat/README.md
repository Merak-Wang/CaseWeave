# @retrieval-agent/dsh-compat

固定 DSH 0.1.1-rc.2 的事件注册、Session 重放与 OpenCode 会话请求头兼容接线。`opencode-pi-ai` 复用上游适配器、配置和凭证，将每次推理的 Session 身份映射为稳定 UUID；上游原生支持并通过同一请求级验收后移除此兼容入口。

公共入口、依赖和构建脚本由 [package.json](package.json) 声明。产品语义见 [产品规格](../../docs/PRODUCT_REQUIREMENTS.md)，组件关系见 [架构说明](../../docs/ARCHITECTURE.md)。
