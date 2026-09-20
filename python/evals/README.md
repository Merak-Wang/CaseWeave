# CaseWeave Evals

独立的 Python 评测工具，消费产品轨迹和评测样本；不承担生产 Agent 决策，不向运行时注入 Gold。

批量集合评测统一从仓库根运行：

```powershell
pnpm eval --benchmark asset/real400-q10/CaseWeave-Real400-Q10 --target http://127.0.0.1:3088 --out .cache/evals/real400-active
```

`--benchmark` 指向解包根目录。先通过 `node scripts/database.mjs prepare --dataset=caseweave-real400-q10-v1 --path=asset/real400-q10/CaseWeave-Real400-Q10/data/public/tickets.jsonl` 导入并准备隔离数据索引；启动产品时设置 `RETRIEVAL_AGENT_DATASET_ID=caseweave-real400-q10-v1`。评测私有标签不导入产品。

运行中的产品设置 `RETRIEVAL_AGENT_FILTER_CONFIG={"algorithm":"active"}`；同条件逐条对照改为 `{"algorithm":"direct"}` 后重启同一产品实现。两组保持相同模型、数据/索引、Wiki 和并发，使用新任务避免跨任务标签污染。评测默认同时执行 1 个任务，`--concurrency` 调整外部任务并发；算子内部默认 4 个模型请求并发。`RETRIEVAL_AGENT_WIKI_LEARNING=0` 可冻结对照时的知识发布。

并行启动两个产品实例时，分别设置 `RETRIEVAL_AGENT_TASK_MYSQL_URL` 指向预先创建的独立任务库，并各用一个 `RETRIEVAL_AGENT_LOCAL_STATE_DIR`。工单库 `RETRIEVAL_AGENT_MYSQL_URL` 和向量索引可以共用。不同 Session 目录不能共享任务队列，否则后台工作进程会领取无法恢复的另一实例任务。使用同一实例依次切换策略时，无需拆分任务库。

`--tasks 'Q01,Q02'` 选择子集，省略时运行全部 10 项。`--epochs 3` 表示重复运行，结果按 epoch 分开评分。`--timeout` 是评测观察期限，超时取消该次任务并记为失败，不让产品据此宣布语义完成。`--rates rates.json` 可提供 `{"currency":"USD","input_per_million":0.0,"output_per_million":0.0}` 格式的实际约定单价；请填真实价格，省略时费用金额为空。

不指定 benchmark 时使用实施任务集，默认首批 CWSET-001、002、003、007、021、066；`--all` 选择全部 100 项。`--labels reviewed.jsonl` 接入独立复核标签。没有完整标签时精确全局指标为空，迁移线索不能当作完整 Gold。

输出：Inspect `.eval` 日志、`run_manifest.json`、`data_coverage.json`、`set_scores.json`、`set_summary.json`、`failures.json`、`efficiency.json`；Real400 的逐任务结果另含基于公开确认集合、事后独立评分的 `quality_work_curve`；轮询点可能漏掉中间变化，调用数与集合之间存在轮询时差。Real400 另含 `predictions.jsonl` 与原包规则的 `real400_scores.json`。日志中的 `mockllm/model` 仅为 Inspect 占位，不发生成请求；所有真实模型请求由 DSH 产品完成。请求/回执在产品 `.cache/semantic-operators/requests`，采样、拟合与检查在 `.cache/semantic-operators/artifacts.sqlite`。

Real400 的 4,000 个参考关系来自助手完整复核，尚无人类裁决；11 个关系为来源不足，保持独立类别。严格 precision 会惩罚无依据确认；集合分数不包含报告语义评级。`efficiency.json` 同时列出全部尝试和完成者时延、实际调用/token 与缺失回执数量，金额估算与真实账单分开。

环境与入口见 [pyproject.toml](pyproject.toml)。验收方法统一见 [评测策略](../../docs/EVALUATION_STRATEGY.md)，实际命令见 [开发说明](../../docs/DEVELOPMENT.md)。自检、受控样例和真实 Agent 质量的结论分别记录。
