# @retrieval-agent/product-api

工单窗口、详情、确认报告与 XLSX/CSV/JSONL 分页生成等应用服务。检索完成后生成绑定确认结果版本的简短报告；配置 DSH 模型且报告有引用时调用一次模型生成一至两段总结，引用和确认数量由产品数据生成。

XLSX 将所有单元格写成文字，保留工单长 ID、中文与换行，公式前缀不会执行。同步与持久工单导出默认上限均为 50,000,000 字节；超限整体失败，不静默截断。XLSX 单元格超过 32767 字符或行列超出 Excel 限制时明确报错，可用 JSONL 保留完整字段。

公共入口、依赖和构建脚本由 [package.json](package.json) 声明。产品语义见 [产品规格](../../docs/PRODUCT_REQUIREMENTS.md)，组件关系见 [架构说明](../../docs/ARCHITECTURE.md)。

Custom retrieval exports the ordinary final yes collection: teacher positives plus remaining tickets classified yes by the selected binary ensemble, or all no-feedback yes results when learning is disabled. No manual confirmation is required. Teacher/model origin and uncalibrated scores remain distinguishable; prediction origins do not force a separate candidate-only download. Current-task authorization, source identity, resultRevision and file checks remain in effect.
