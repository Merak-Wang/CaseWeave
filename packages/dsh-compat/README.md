# @retrieval-agent/dsh-compat

固定 DSH 0.1.5-rc.2 的事件注册、Session 重放与 OpenCode 会话请求头兼容接线。`opencode-pi-ai` 复用上游适配器、配置和凭证，将每次推理的 Session 身份映射为稳定 UUID；上游原生支持并通过同一请求级验收后移除此兼容入口。

`./migration` 提供离线 `migrateSessionDirectory(root, write = false)`。只转换包含已支持 CaseWeave 事件的 V0 日志，通过上游格式转换器后重新校验 V3；检索事件身份和内容不变。原文件保留，新文件沿用原压缩方式，压缩头单独成帧。仅在旧 Host 已停止时写入；不自动迁入 MySQL。无法无损处理的业务版本和原生时序返回 `refused`。源码 CLI 与升级/回退操作见 [开发与运行](../../docs/DEVELOPMENT.md#dsh-升级与历史会话)。

公共入口、依赖和构建脚本由 [package.json](package.json) 声明。产品语义见 [产品规格](../../docs/PRODUCT_REQUIREMENTS.md)，组件关系见 [架构说明](../../docs/ARCHITECTURE.md)。
