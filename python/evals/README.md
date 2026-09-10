# CaseWeave Evals

独立的 Python 评测工具，消费产品轨迹和评测样本；不承担生产 Agent 决策，不向运行时注入 Gold。

真实任务从仓库根运行 `pnpm accept:task --query "自然语言"`，消费运行中工作台的公开 API；可用 `--expect` 指定验收端独立的工单 ID 期望。本包提供数据读取和评分器，评分前需将输入转换为各评分器声明的轨迹格式。

环境与入口见 [pyproject.toml](pyproject.toml)。验收方法统一见 [评测策略](../../docs/EVALUATION_STRATEGY.md)，实际命令见 [开发说明](../../docs/DEVELOPMENT.md)。自检、受控样例和真实 Agent 质量的结论分别记录。
