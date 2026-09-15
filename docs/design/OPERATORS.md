# Python 语义算子

新任务的原句向量召回和 `query_plan` 并行执行。规划器输出关键词、完整自然语言业务判据、语义改写、结果目标和算子步骤。关键词以 OR 枚举字面全集，向量保持有限召回；二者都只是候选。业务 AND/OR/NOT、否定、主体和时序由算子按原句与用户补充判断，检索表达不修改最终要求。

## 执行与职责

核心实现在 [caseweave_ops](../../python/semantic-operators/src/caseweave_ops)，接入由 [SemanticOperators](../../packages/agent-plugin/src/semantic-operators.ts) 负责。新任务先做规划与检索，第一批强判断立即交付，随后对当前候选区域选样和推断；后续由 DSH 主 Agent 按缺口调用。计划是有类型的执行建议，不是任意代码或 SQL。

| 算子 | 输入与产物 | 边界 |
| --- | --- | --- |
| sem_search | 关键词或语义表达 → 流式候选 | 字面全集不被向量 Top-K 截断 |
| sem_filter | 完整判据与记录 → accept/exclude/undetermined | 引用验证后直接更新确认状态，缺证先未决 |
| sem_topk | 指令、候选、k → 有比较依据的顺序 | 排名不自动确认相关 |
| sem_map | 记录、对象 schema → 有来源的对象 | 不改业务工单，严格验证 schema |
| sem_extract | 记录、对象 schema → 字段及引用 | 非空字段必须有逐字段来源 |
| sem_join | 显式对或指定 blocking 字段 → 候选对与关系判断 | 阻塞遗漏单独评价，不冒充无损连接 |
| sem_agg | 有限来源 → 分层归纳与来源链 | 服务当前检索，不自动开展下游统计 |

普通算子判断无需主 Agent 逐条再判。主 Agent 处理未决、补证、分歧、进一步搜索与停止。定向 `ticket_read` 取得新字段后会对指定候选调用过滤。批宽是上下文调度参数，不是累计调用上限。

条件补充进入新输入代次后，先执行新计划的关键词与语义召回，再复核新候选；搜索去重身份绑定任务、代次、快照和授权。`sem_filter.params.required_fields` 声明必须实际读取并引用的字段，规划器从 Provider 字段目录选择。来源性质 `origin=source` 只描述出处，不能证明读过原始对话；旧计划 `require_source=true` 按对话要求处理。已知摘要与原文冲突也会要求对话证据，主 Agent 与算子准入共用该要求。

Python 通过 Host 回调取得授权记录、搜索结果和 DSH 模型响应，不持有生产数据库或模型凭据。独立算子请求记录实际指令、Wiki、证据和用量，不反复附加主 Agent 的整个历史。

## FastAPI 与 stdio

两种传输共用 `run`、资源 `request/response`、流式 `result`、`done` 和 `cancel` 协议。

- 设置 `CASEWEAVE_OPERATORS_URL` 后，Node 连接内部 WebSocket `/v1/operators`。FastAPI 常驻进程复用执行工件库，并发等待模型及 Provider I/O；`/health` 用于就绪检查。
- 未设置 URL 时，源码工作区启动 UTF-8 stdio worker。可用 `CASEWEAVE_PYTHON` 指定已装依赖的 Python，否则使用锁定 uv workspace 并保留环境内其他包。
- 完整 Compose 包含独立算子容器，共享私有工件卷，不向宿主发布端口。`CASEWEAVE_OPERATORS_TOKEN` 可配置双方共享令牌；服务拒绝浏览器 Origin。跨机访问使用受控网络与 TLS。

FastAPI 的收益是进程复用和并发调度，不能仅凭服务 ready 声称模型推理加速。性能比较需要固定模型、数据、缓存状态与并发。

## 一致性与计量

缓存身份包含任务、输入代次、快照、授权、模型、判据、Wiki 版本和记录内容。SQLite 存执行工件与断点，MySQL 仍是任务权威。Host 检查版本、正文哈希、引文偏移、Wiki 可见性、实际 DSH 请求和当前输入代次；缓存输出仍需通过这些检查。取消、断线和补充后旧结果不得进入新状态，重复结果不重复改变确认集合。

非全集任务的零结果由 Agent 按已核实范围及覆盖说明结束，不要求逐个排除范围外的宽召回候选；存在条件、证据或专家分歧缺口时仍拒绝完成。

过滤判断走现有 Controller；派生算子写 `operatorArtifacts`，不自动确认。报告、下载与重放引用同一确认集合和结果版本。

计划通过结构和完整语义契约校验后才写入成功缓存。缓存命中经 `llm.reuse` 回传原实际请求回执，Host 重验当前任务范围和请求内容。派生产物只记录本次调用使用的 manifest；Top-K 使用实际 `sem_topk_compare` 请求，分层聚合保留叶工单版本、内容哈希、字段、片段和中间摘要回执，最终引文逐段与实际送达内容核对。聚合摘要本身不成为新的原始事实。

算子判断准入时同时产生带输入代次的判断事件。反馈回执消费同代次、同工单的有效处置，不要求主 Agent 重复判断，也不因后续算子事件较多而丢失对应反馈。

调用、输入/输出 token、缓存 token、QPM、TPM 和耗时仅计量，无累计中止阈值。供应商缺失用量保留未知；适配器调用数不冒充供应商内部重试数。取消、权限、上下文容量、协议或服务故障、无进展循环仍须明确未完成。

## 默认过滤算法

调用链为 `pre-step / task-worker / sem_filter tool → SemanticOperators.filter → PythonOperatorBridge → rpc.execute → dispatch.invoke_rows → sem_filter → clustered_filter → cluster_filter`。默认传入整个当前候选集合；128 条的特征页和最多 8 条的模型包只控制 I/O/上下文，不截断算法区域。

数字内核 [cluster.py](../../python/semantic-operators/src/caseweave_ops/cluster.py) 只处理位置 ID、归一化特征、标签与未判集合；[filter_adapter.py](../../python/semantic-operators/src/caseweave_ops/filter_adapter.py) 管分批正文/特征、模型和结果适配。权限、来源、输入代次和迟到更正继续由 Host 管理，原文与 Wiki 仍送至现有 DSH 路由。没有新增预算或证据管理工具。

1. 第一批先强判断，其余正文进入临时 SQLite，特征写 float32 memmap。Provider 读取现有分片向量，记录特征为归一化分片向量均值再归一化；没有特征或必需原文缺失时走强判断/未决。
2. MiniBatchKMeans 对整个候选区域分组，区域内随机选样。已有同判据强标签优先复用；默认 SimVote，可选择 UniVote 或实际拟合的局部 LogisticRegression。
3. 先冻结未判记录的正/负预测区域，再分别均匀无放回抽取独立检验样本。检验之前确定样本数，按超几何分布反演未检记录的分歧数上界；每次检验分配 `delta/(t*(t+1))`。
4. 上界满足该区域容许值时，仅对未调用强模型的剩余记录产生 `basis=proxy`。否则只拆分未解决区域，或直接强判断。过程以未判集合减少推进，不设调用次数、深度、累计 token 或时间截止。
5. 样本反例保留自己的强判断；Unknown 仍未决，在检验中视为分歧而非负标签。代理不训练自己。当前 Host 强判断覆盖旧缓存；撤销需要重新强判断；更正强判断会重新打开既有代理结果，迟到输出拒收，下一次过滤使用当前反馈。

默认 accept/reject 分歧容许值都是 **0**、跨检验 `delta=.01`。这通常接近全量判断，可能增加模型包数；小量抽样不能证明整簇没有稀有反例。该统计检验只约束相对固定强标签的分歧，依赖抽样与固定总体假设，**不是业务正确率或全局召回保证**。1% 容许值与局部分类器的组合仅在显式计算实验中使用，Host 不接受这些宽容许值的代理产物。

通过的代理携带独立检验结果与本条来源位置，不伪造逐条模型 manifest。Controller 直接准入；页面、报告、CSV/JSONL 和重放保留代理身份。主 Agent 按未决、业务边界和搜索缺口继续工作，不为旧清单协议重判所有代理。

## 论文对照与改造

| 机制 | CSV 对照 `algorithm=csv` | CaseWeave 默认 `algorithm=cluster` |
| --- | --- | --- |
| 分组 | KMeans，未解决集合跨簇汇总后重新分组 | 分批 MiniBatchKMeans，失败区域局部二分 |
| 选样 | 按区域比例选样，并设最小 pilot 数 | 优先复用真实强标签，补充区域 pilot |
| 推断 | UniVote / shifted-cosine SimVote，阈值直接推断 | 投票或实际局部拟合，预测后独立检验 |
| 检验 | 无独立检验 | 固定样本、有限总体单侧上界，失败补判 |
| 交付 | Python 对照用；Host 不准入未检 CSV 代理 | 通过检验的未调用记录流式进入权威状态 |

阅读基于 [CSV Algorithms 1–3](https://arxiv.org/html/2603.04799v1) 和 [固定 optimized_filter.py](https://github.com/Anto-an/CSV_SemanticFilter/blob/ae4d35048dc9226672e2bbfd1686f0f3dc6cb122/operators/filter/optimized_filter.py)。SimVote 使用 `(cos+1)/2` 权重，不改称 softmax。论文 Algorithm 1 的全局未决汇总，与该固定代码的局部递归及深度截止并不相同；这里的对照采用论文控制流，并保留来源/Unknown/首批输出适配，不能称逐行复现。生产独立固定样本检验也不是论文原保证或 BARGAIN 的序贯检验。

`sem_filter_reference` 保留原“固定批次内排序再全部强判断”实现；默认入口不经过该路径。`feedback.py` 中旧弱评分/门控保留作 reference 实验，默认执行真正的数字内核。

## 其他算子完成边界

- `sem_topk`：保留 heap 默认基线，新增 `strategy=quick`。对照 [LOTUS 固定 quick 实现](https://github.com/lotus-data/lotus/blob/136ae4f4a344a2f75d89f811e516dfcb0de30e46/lotus/sem_ops/sem_topk.py) 的主元比较/分区机制，项目版用 quickselect 后排序入选项，未照搬原实现。访问全体输入与活动分区，不先截成向量 Top-K。Unknown 明示算法未完整完成；比较器不满足全序时不声称全局语义最优。
- `sem_join`：SQLite 倒排 blocking 索引生成候选对后语义判断，公共工具支持字段 blocking；显式 pairs 保留 reference。无命中输出零候选对及召回未知，不能把少生成配对计作无损收益。当前没有学习式 blocking 或领域 recall 结论。
- `sem_map/sem_extract`：本地 Schema 引用正确定位 payload，输出存储绑定 Schema 和输入观察身份。仅复用相同输入的有效结果，回传原批次请求记录；不按簇复制具体金额、日期或状态。
- `sem_agg`：上层默认只读子摘要、完整性和来源 ID，实际叶来源关系放在结果/请求适配中。必要原文可由已有 `ticket_read` 定向补读；自动事实缺口补读策略仍未实现。最终引文物化仍为 O(N)，没有百万规模内存结论。
- `sem_search`：关键词不等待改写 embedding；Python API 保留 q0 并增加强反馈的数值 Rocchio 扩召，撤销反馈不再参与更新，JSONL 向量扫描按记录页及查询块计算。Host 当前仍按关键词/自然语言改写召回，数值反馈扩召尚未沿真实 Provider 默认接通，明确保留 reference 状态。

CPU 内核与磁盘适配避免正文全量列表及 N×N 相似矩阵；ID/标签仍为 O(N)。Host 的候选与恢复 DTO 仍可能完整水合，本改造不代表端到端百万工单内存或并发压测已完成。

## 验证

命令见 [开发与运行](../DEVELOPMENT.md)。`semantic-operators.spec.ts` 用公开 DSH 输入、真实 Python 和受控模型检验接线；`semantic-boundary-real.spec.ts` 用公开 HTTP、指定真实数据和模型检查独立样例。单测、接线、实际模型质量分别报告，工程通过不能外推全库质量。
