# CaseWeave Evals

独立的 Python 评测工具，消费产品轨迹和评测样本；不承担生产 Agent 决策，不向运行时注入 Gold。

## 生产工单语义算子实验

Mongo 适配器将生产数据规范为每行包含 `ticket_id/title/summary/body/created_at/source_fields` 的 JSONL。摘要、标题和工单原文是必需字段。文档向量只使用标题和摘要：拼接后按 480 token、重叠 48 无损分块，所有块向量取均值并归一化，生成 `tickets.title-summary.npz`（`ticket_ids`、`vectors`）。可读工单原文仍用于混合检索字面匹配、教师判断与神经基线，不送入向量模型。查询向量另生成 `queries.npz`（`condition_ids`、`vectors`），使用同一 Qwen3-Embedding-0.6B revision 的 query 指令。

Mongo 连接串只从环境变量 `CASEWEAVE_MONGO_URI` 读取，不放入命令行、配置文件或日志。默认只读 `iop_ai_data.output_fields_date`，按 `create_time` 倒序流读，跳过标题、摘要、处理后正文为空的记录，并按 `group_id` 保留最新的唯一工单，直到达到 `--limit` 个有效样本；集合大小仅记录为估算值。输出 manifest 记录字段缺失、重复、扫描数、时间范围和数据哈希。`body` 是按原角色和事件顺序提取的可读正文，`raw_body` 保留 Mongo 原始对话，`source_document_id` 保留来源文档身份。

在 PowerShell 中通过当前进程环境传入由凭据管理器提供的 URI 后运行：

```powershell
$env:CASEWEAVE_MONGO_URI = '<Mongo connection URI>'
uv run --project python/evals python -m retrieval_agent_evals.mongo_source --output .cache/evals/production-v1/tickets.adapted.jsonl --limit 20000
```

默认字段映射为 `ticket_id=group_id`、`title=large_model_title`、`summary=large_model_abstract`、`body=origin_conversation`、`created_at=create_time`。其他集合可用 JSON 文件覆盖规范字段到 Mongo 字段的映射，并指定数据库、集合及排序时间字段，例如 `--mapping-json mapping.json --database support --collection tickets --time-field created_at`。映射 JSON 形如 `{"ticket_id":"case_id","title":"title","summary":"abstract","body":"conversation","created_at":"created_at"}`。`--limit` 表示按排序后的候选前缀最多导出多少有效唯一工单；它不是分页偏移量，重新导出会从最新记录开始重建文件。

先画像 Mongo 结果并由实验负责人把两个自定义聚类条件和两个自然语言 query 冻结到 `queries.json`。每条 query 需要 `condition_id/query/keywords/labeling_guidance`；聚类条件要把簇定义、成员边界写进 `query` 和 `labeling_guidance`。下面命令准备评测文件，不会自动调用伪标签模型：

```powershell
uv run --project python/evals python -m retrieval_agent_evals.embedding_worker tickets --dataset .cache/evals/production-v1/tickets.adapted.jsonl --output .cache/evals/production-v1/tickets.title-summary.npz --tokenizer models/Qwen3-Embedding-0.6B --service-url http://127.0.0.1:28012
uv run --project python/evals python -m retrieval_agent_evals.embedding_worker queries --queries .cache/evals/production-v1/queries.json --output .cache/evals/production-v1/queries.npz --service-url http://127.0.0.1:28012
uv run --project python/evals python -m retrieval_agent_evals.hybrid retrieve --dataset .cache/evals/production-v1/tickets.adapted.jsonl --embeddings .cache/evals/production-v1/tickets.title-summary.npz --query-embeddings .cache/evals/production-v1/queries.npz --queries .cache/evals/production-v1/queries.json --output .cache/evals/production-v1/conditions --vector-top-k 2048 --limit 256
```

检索将每个条件下全部关键词字面 OR 命中，与向量 top 2048 合并去重；按 `0.5 × (distinct bigram coverage + cosine)` 排序，保存完整 `recall_union.jsonl`，从前 256 个不同原文工单建立交错且固定的 128 train / 128 test。完全相同的原文会在切分前去重。每个条件输出 `manifest.json`、`candidates.jsonl` 和完整召回并集；split 冻结后才可做教师标注。

教师标签显式复用本机 `.env` 已有 `RETRIEVAL_AGENT_BROWSER_LLM_*` 设置，CLI 会拒绝非 DS V4.1 Flash 模型。每个成功标签保存模型返回标签、理由、自报置信度、提示哈希、原始文本响应和用量；物理重试与时延独立计量，缺失用量保留为空。标题、摘要与原文都会提供给教师，冲突时按原文判定。教师 CLI 的 `--limit N` 只标注候选文件前 N 条，不是批次偏移；限量运行后移除 `--limit` 重新执行，会跳过已经成功缓存的标签并补齐其余候选。执行标签调用是显式步骤：

```powershell
uv run --project python/evals python -m retrieval_agent_evals.teacher --condition .cache/evals/production-v1/conditions/<condition-id> --env-file .env --workers 8
uv run --project python/evals python -m retrieval_agent_evals.run_methods --condition .cache/evals/production-v1/conditions/<condition-id> --embeddings .cache/evals/production-v1/tickets.title-summary.npz --query-embeddings .cache/evals/production-v1/queries.npz --output .cache/evals/production-v1/results/<condition-id>.json
```

`run_methods` 只用 128 条 train 伪标签拟合传统分类与反馈方法；NameGMM / spherical K-means 只用 train 向量和 query anchor。128 条 test 只用于最后评分，绝不调阈值或选参。输出的 accuracy、precision、recall、F1、balanced accuracy、coverage、confusion、预测和耗时全部针对 DS V4.1 Flash 伪标签一致性，不是人工真值质量。检索指标只覆盖完整候选并集及已抽取的 256 条；没有全库人工 qrels 时不报告全库 Recall。置信度不是校准概率，query 条件是否合理需结合实验画像另外复核。
神经基线使用各自已有的本地 Python 环境运行 worker，结果写入 `conditions/<condition-id>/neural/{laya,julia,gliner}/predictions.jsonl`。例如：

```powershell
$env:PYTHONPATH = 'python/evals/src'
<模型环境Python> -m retrieval_agent_evals.neural_worker --method laya --condition-dir .cache/evals/production-v1/conditions/<condition-id> --model <本地Laya模型路径> --output .cache/evals/production-v1/conditions/<condition-id>/neural/laya
```

将 `--method`、模型环境和模型路径分别替换为 `julia` 或 `gliner` 对应配置。统一报告使用 `uv run --project python/evals python -m retrieval_agent_evals.report_experiment --conditions-root .cache/evals/production-v1/conditions --results-root .cache/evals/production-v1/results --output .cache/evals/production-v1/report`；缺失结果会明确标记，不会补造分数。

### 在固定候选集上追加零样本方法

下面的零样本实验复用相同的四个128条测试集、标题+摘要向量和query向量，不重跑Mongo、教师或神经基线。八种方法、固定业务描述和所有输入哈希先冻结到 `zero-shot/protocol.json`。预测阶段只读取 `candidates.jsonl`筛出测试工单，再向算子传入测试向量和固定锚点；不读取训练向量或伪标签。`dual_description_margin` 对每条工单独立预测；七种 `*_test_batch` 方法只在该条件的128条无标签测试批次内形成结构，属于transductive结果。两类结果单独标注，不作为等价的逐票独立能力。

描述向量只嵌入固定业务定义文本，使用当前固定模型和query instruction。随后先冻结协议并预测；四条件预测文件全部完成后，才能运行评分入口读取教师伪标签。评分器只合并已缓存的Laya、Julia、GLiNER基线，不触发新模型调用。

```powershell
uv run --project python/evals python -m retrieval_agent_evals.embedding_worker queries --queries .cache/evals/production-v1/zero-shot/class_descriptions.json --output .cache/evals/production-v1/zero-shot/description_embeddings.npz --service-url http://127.0.0.1:28012
uv run --project python/evals python -m retrieval_agent_evals.run_zero_shot freeze
uv run --project python/evals python -m retrieval_agent_evals.run_zero_shot predict
uv run --project python/evals python -m retrieval_agent_evals.report_zero_shot
```

预测写入 `.cache/evals/production-v1/zero-shot/predictions/<condition>.json`；评分输出为 `zero-shot/REPORT.md` 与 `zero-shot/metrics.json`。common表只汇总 C01/Q01/Q02，同时报告384个条件判断的micro与三题等权macro指标；四条件表另列C02。跨条件重复工单在每个查询条件下分别计为一次判断。所有结果表示与DS V4.1 Flash伪标签的一致性，而非人工真值。C02测试集没有负伪标签，无法估计其负类质量。Laya、Julia和GLiNER使用原有三字段神经输入，零样本向量方法只使用标题与摘要，输入模态不同。

生产实验合并报告可从已有的指标、预测和清单只读重建，不会再次运行模型或标注：

```powershell
uv run --project python/evals python -m retrieval_agent_evals.report_combined
```

默认生成本地 `.cache/evals/production-v1/REPORT.md` 与 `consolidated_metrics.json`。重复的神经缓存基线以第一轮记录及其成本为准；后续只加入具有完整四条件预测与运行环境记录的新方法。总表保留各方法协议和标签预算，DS V4.1 Flash结果始终标记为伪标签一致性，不称为人工真值。

Jeff-Qwen3.5-0.8B 使用独立Python环境运行，复用固定test候选及查询、工单标题和摘要；不输入工单正文。模型不读取训练标签或测试标签，预测后合并报告才会用已保存的test伪标签评分。[Jeff官方仓库](https://github.com/firelex/jeff)说明仅支持英文；本实验是原中文工单的直接迁移测试，不用伪标签校准checkpoint。与由标题、摘要、正文判定的teacher相比，Jeff输入缺少正文，可能看不到摘要未覆盖的细节。确保独立环境已安装兼容的Torch/Transformers；通过 `PYTHONPATH` 导入本仓库评测代码，避免修改模型环境依赖：

```powershell
$jeffModel = '<本地Jeff-Qwen3.5-0.8B checkpoint目录>'
$jeffSource = '<Jeff官方源码仓库目录>\src'
$jeffPython = '<Jeff独立环境Python绝对路径>'
$env:PYTHONPATH = "python/evals/src;$jeffSource"
& $jeffPython -m retrieval_agent_evals.jeff_worker --conditions-root .cache/evals/production-v1/conditions --model $jeffModel --output-root .cache/evals/production-v1/conditions --source $jeffSource --audit --artifact-output .cache/evals/production-v1/jeff-token-audit.json
& $jeffPython -m retrieval_agent_evals.jeff_worker --conditions-root .cache/evals/production-v1/conditions --model $jeffModel --output-root .cache/evals/production-v1/conditions --source $jeffSource
uv run --project python/evals python -m retrieval_agent_evals.report_combined
```

worker 为每个test工单独立推理，保存至 `conditions/<condition-id>/neural/jeff_qwen35_08b/{predictions.jsonl,environment.json}`，逐票记录真实token长度及截断状态。总报告会从运行环境清单读取实际预算、截断数、模型revision和调用成本，不预设截断结果。报告仅在四个条件均有完整预测和完成状态时纳入Jeff；尚未运行或不完整时保留pending，不补零分。

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

`retrieval_agent_evals.anyjev_http.decide_batch(config, states, query, prior='none')` 提供基于
[AnyJev 官方算法](https://github.com/nokia-applied-research/AnyJev)的二元HTTP适配：两轮交换业务选项与输出标签映射，读取下一token的Y/N分数，按业务标签还原后做logmean聚合。

`prior='none'`默认只做轮换聚合；`batch`至少8条有效输入时使用无标签批次先验（强度0.75），排序后高度偏正的样本可能违反其类别分布假设；`content_free`额外使用N/A、空串和[MASK]六次校准请求（强度1）。每条两次判断，校准及实际重试均单独计量；缺少真实标签logprobs时返回`fallback_required`，不会编造分布。

生产可通过`semanticExecution.judgeMode=anyjev_l0`选择可信DSH Provider配置下的HTTP读取，`judgePrior=none|batch|content_free`控制先验；Runtime累计128次独立判断包含两轮和校准。默认`compact_binary`批8只输出yes/no与自报置信度，接口不支持logprobs时明确降级并记录，不能将该输出称为AnyJev L0。所有分数均未校准，不能替代独立人工业务标签。
