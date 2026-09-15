# @retrieval-agent/query-understanding

新自然语言任务由 `buildSemanticTicketRequest` 创建 schemaVersion 10 的原句向量请求，Python planner 随后补充完整自然语言判据和检索表达。旧分析/AST 接口仅供显式结构化调用、旧 Session 和契约测试使用。

公共入口、依赖和构建脚本由 [package.json](package.json) 声明。产品语义见 [产品规格](../../docs/PRODUCT_REQUIREMENTS.md)，组件关系见 [架构说明](../../docs/ARCHITECTURE.md)。
