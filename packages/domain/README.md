# @retrieval-agent/domain

检索条件、候选资格、证据与合法状态转移。确认结果与重放分别通过 `domain/result`、`domain/replay` 导出，两个子入口可供浏览器直接使用，不加载服务端 Controller。

公共入口、依赖和构建脚本由 [package.json](package.json) 声明。产品语义见 [产品规格](../../docs/PRODUCT_REQUIREMENTS.md)，组件关系见 [架构说明](../../docs/ARCHITECTURE.md)。
