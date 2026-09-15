# 查询理解、检索与数据底座

本文说明查询计划、MySQL 字面检索、Milvus 向量召回及索引一致性。运行命令见 [开发与运行](../DEVELOPMENT.md)，查询语义见 [产品规格](../PRODUCT_REQUIREMENTS.md)，验证场景见 [评测策略](../EVALUATION_STRATEGY.md)。

主要实现入口为 [语义计划契约](../../packages/contracts/src/semantic-operators.ts)、[Python 规划器](../../python/semantic-operators/src/caseweave_ops/planner.py) 和 [数据库 Provider](../../packages/provider-database/src/provider.ts)。数据库当前物理表以 [store.ts 的 DDL](../../packages/provider-database/src/store.ts) 为事实源：`ra_generation`/`ra_ticket`/独立字段投影、`ra_index`/job/checkpoint/cache、原子 publication、每路 search_run/search_hit。它们存来源与检索产物；确认、反馈和合法转移仍由 Controller 和权威任务状态维护，不能用 SQL 命中直接替代 Agent 判断。

当前字段映射 `normalized-fields-v2` 遍历完整原始字段值，不沿用旧 searchText 的 256 值上限；NULL 保持未知，生成字段能力显式引用生成策略。NFKC 小写规范化与二进制 LOCATE 实现任意字面子串基线。可选 bigram 倒排只做必要条件，后置精确谓词始终保留；正向必要 gram 中选择最窄的 posting，超过语料 10% 时回退精确扫描，避免宽条件强制 join 的实测退化。OR 只使用全部分支共同需要的 gram，NOT 不提供正向剪枝。扫描及加速均用 keyset 全集枚举；最终排序页宽与向量工单 Top-K 分离。

索引使用 `field-codepoints-v3`：ESFT 摘要与完整 raw_dialogue，360 Unicode 字符分片、保留全部尾部；problem_description 是客户轮次的派生副本，避免重复索引。模型身份包含 revision/维度/归一化/距离、切片版本；每个命中复核 ticket/contentHash/sourceVersion/片段位置及哈希。SQL 生成授权且满足硬条件的工单集合。整个不可变索引集合均可用时直接执行一次 Milvus 分组搜索；受限范围按 SQL ID 游标流式交集，每批最多 1,000 个 ID、最多四批并发，只保留合并后的工单 Top-K。任一批失败不把剩余批次冒充完整向量结果。更新和删除生成新的不可变来源/集合，复用相同内容 embedding；完全就绪后单一发布指针切换，滞后索引不能混入当前 SQL 版本。

## 模型服务部署边界

模型服务支持独立容器部署。完整容器部署同时提供 Node/DSH 应用容器；源码运行也可使用宿主 Node/DSH 连接模型服务。实现为 [容器入口](../../python/model-service/src/retrieval_agent_model_service/container.py)、[Compose](../../config/model-service/compose.yml) 和 [Node 管理入口](../../scripts/model-container.mjs)。沿用 models.v1/RAG 协议、固定模型 revision、1024 维 L2 embedding 和已发布 SQL/Milvus 索引身份；部署设备不重建索引，CPU/GPU 数值差异与候选变化须通过预先定义容差对照。

运行镜像与模型发布分离：锁文件安装运行库，spaCy 来自固定 wheel；Qwen 权重/config/tokenizer 在显式准备时逐文件校验，经 staging 原子发布至 manifest/启用角色寻址目录。服务只读加载完整发布，下载与向量缓存分别持久保存；正常启动不联网补包或使用半成品模型。容器内的全接口监听必须显式启用，宿主端口只发布到回环。GPU 配置显式请求 CUDA，失败不回退 CPU；Node 的 container/external 模式也不回退宿主 Python。停止 Node 不获得停止外部服务的所有权。

首批目标 Windows/WSL 2、Linux x86_64、NVIDIA GPU 或显式 CPU，其他架构不在当前支持承诺内。依赖/Compose 参数参考 [uv 官方 Docker 指南](https://docs.astral.sh/uv/guides/integration/docker/) 和 [Docker GPU reservation](https://docs.docker.com/compose/how-tos/gpu-support/)，具体冻结版本由 Dockerfile/uv.lock 维护。部署命令、旧宿主路径消费者与退出条件见 [开发说明](../DEVELOPMENT.md)。

## 1. 查询规划与语义判据

新任务使用 schemaVersion 10 的自然语言契约，入口为 `buildSemanticTicketRequest`。Host 立即启动原句向量召回，并通过 DSH 调用 Python `query_plan`；后者接收原句、用户补充、字段目录、任务时刻与固定版本 Wiki，输出 `keywords`、`instruction`、`retrieval_expressions`、`goal` 和步骤。

关键词只用于 OR 宽召回，业务布尔关系留在完整自然语言判据中。普通检索由 `sem_filter` 进行有证据的三态判断，缺原文时保留未决并由 Agent 定向取证。指定 ID 必须保持完整身份；时间、字段和业务排除不得被改写为更宽的确认条件。语义改写是搜索先验，不是事实或新增要求。

Python 负责语义计算，Host 负责身份、来源、当前输入代次、实际 DSH 请求、合法转移和结果发布。详细接口、恢复与常驻 FastAPI 服务见 [Python 算子](OPERATORS.md)。

旧 `QueryPlan` AST 继续服务显式结构化 Provider 请求、旧 Session 重放和相应契约测试；新自然语言入口不依赖 spaCy 编译 AST。旧调用者退出及历史任务迁移后才删除该兼容入口。不得让模型生成任意 SQL，结构化字段执行继续使用白名单和参数绑定。

## 2. 需要覆盖的自然语言

以下为研究后构造的验收样例，并非 ESFT 已有的真实业务查询记录。借鉴工单系统对布尔关系、时间与空值的表达能力，不照搬它们各自的语法或默认运算优先级。[Zendesk 检索参考](https://support.zendesk.com/hc/en-us/articles/4408886879258-Zendesk-Support-search-reference)、[Jira JQL 运算符](https://support.atlassian.com/jira-service-management-cloud/docs/jql-operators/)。

| 自然语言 | 应保留的含义/检查点 |
| --- | --- |
| 帮我找副卡和跨域有关工单 | 关键词默认 OR，任一主题出现即召回；原句向量召回；两路并集再判相关 |
| 必须同时包含副卡与跨域 / 副卡 AND 跨域 | 宽召回后按明确交集跨字段核实，保留原有括号、字段和否定范围 |
| 找副卡绑定失败或者解绑后仍共享流量的工单 | 明确括号为两类业务分支；保留副卡共同范围，歧义时展示解释 |
| 宽带断网的，或者手机因为欠费停机的 | `(宽带 AND 断网) OR (手机 AND 欠费停机原因)`，不拉平为词袋 |
| 找副卡不能上网，排除欠费导致的 | 欠费是原因排除；“已缴清欠费仍不能上网”不能因出现欠费而被机械排除 |
| 只要正文包含“跨域融合”、且不出现“测试单”的 | 引号短语和明确字面排除同时生效；词边界不得跨字段拼接 |
| 上个月创建、现在仍未解决的上海宽带工单 | 创建时间半开区间 + 当前状态 + 地区；字段缺失不能猜 |
| 处理结论为空，或者明确写了待回访的 | 空值与正文表达两个分支；空处理结论不自动等于未解决 |
| 最近由已解决变成重新打开的 | 依赖状态历史；当前静态状态字段不足以支持 |
| 找与工单 X 同类的副卡计费问题，不要 X 自己 | 先按 ID 受控读取作为相似查询依据，再排除该身份 |
| 副卡跨域相关的全部工单，先看最近几条 | 全量目标与显示排序/页宽分开，不将“先看”解释为截断 |

相对日期在任务创建时固定时区和锚点；继续任务不随午夜漂移，明确新日期要求才修订。SQL 的 NULL 不是 false：否定条件不自动接受未知字段，用户明确“也包括未知”时才加入 unknown 分支。真实业务字段映射以后接入，不给当前 JSONL 编造这些属性。

## 3. 关键词全匹配与 MySQL

定义 `contains(ticket, term)` 为：规范化后的 term 连续出现在该工单任一允许搜索的字段中。不同 term 可以出现在不同字段；一个 term 自身不能由两个字段尾首拼出来。规范化版本化，以 NFKC、明确的大小写策略为初始基线，不默认做同义替换或删改业务标点。

宽召回逻辑为 `OR_k (OR_field literal_contains(field, k))`；显式结构化 Provider 请求仍支持 AND 和嵌套布尔条件。空值字段不匹配；用单独的文本字段投影或字段表表达，避免字符串无分隔拼接造成假命中。SQL 由编译器绑定参数，LIKE 路径需转义 `%`、`_` 和 escape 字符；可先用明确排序规则下的 INSTR/LOCATE 实现正确性对照，实际排序规则和 Unicode 行为需要 MySQL 集成验收。

MySQL ngram 支持中文，但 token 长度、停用词、短语与空格处理会影响命中，不能直接承诺等价于任意子串包含。[MySQL 8.4 ngram 官方说明](https://dev.mysql.com/doc/refman/8.4/en/fulltext-search-ngram.html)。本项目据此采用：

1. 在当前 19,587 条数据建立完整字面匹配基线；此时扫描性能实测，不先声称足够快。
2. 结构过滤走可用普通索引；正文建立物化规范化投影，避免每次读取和解析 JSONL。
3. 评估 ngram FULLTEXT 或 MySQL 内的 gram 倒排表作候选加速。只有证明候选是正确集合的超集，才可加精确复核；单字、停用词等不安全表达回退到精确路径。加速先漏掉的数据不能靠后置过滤找回来。
4. `NOT`、复杂 OR 和窄范围查询分别看执行计划与基线；不把全文自然语言模式当业务布尔解释器。

关键词操作按稳定查询版本枚举全部匹配 ID，可分批写候选关系和输出 L1 视窗。使用稳定 keyset 游标、唯一约束和可恢复进度；Top-K 排序只影响阅读优先级。若容量/故障中断，报告“枚举未完成”及游标，不伪造全集。

## 4. Milvus 语义召回与融合

首轮向量输入保持用户原句。查询 embedding 使用与索引一致的模型/revision、向量维度、归一化及距离约定；缓存键包含这些身份。后续可并行发多个经 Agent 解释的搜索表达，避免仅把首句反复执行。

关键词全集以 SQL 批次保存命中，保留逐条身份、通道、字面资格与来源哈希，进度按批推送。Python `sem_search` 逐页消费当前字面游标后再切换检索表达，防止另一向量排名覆盖尚未完成的关键词枚举。

用户回答按补充语义处理：举例、引文、用户所在地不自动产生地域硬筛选。新的自然语言计划沿用候选和来源，以输入代次隔离旧判断；执行条件或有价值的搜索方向变化时再检索，不重复原始快查。旧 spaCy HTTP 分析接口仍用于其显式调用者，保留 UTF-16 来源位置和历史协议校验，但不再作为生产自然语言规划的前置步骤。

Milvus 可先执行元数据过滤再 ANN，也提供迭代过滤，适合不同选择性与表达复杂度；选择要实测。[Milvus filtered search](https://milvus.io/docs/filtered-search.md)。推入索引的共同条件是可执行用户硬条件和访问范围；“副卡/跨域”作为提取的关键词假设，不默认强加到向量分支。

索引初始采用摘要向量与来源正文片段向量两类表示，比较单摘要基线的遗漏和成本。长正文按字段/对话结构切片，保存片段位置、内容哈希和截断情况；不要把全文静默截成 embedding 模型的前 512 tokens。片段 Top-K 需聚合成工单候选并保留命中片段；过采样/分组避免同一长工单垄断候选。具体切片大小、K、ANN 参数和重排范围见实验后配置，不固定进产品要求。

合并按 `(datasetId, ticketId)` 去重，来源版本冲突先核对；保留每路命中理由、片段、原始分数及查询身份。字面通道只提供集合资格，每条命中的融合贡献相同（当前为 1/61），不把 ID 枚举顺序当相关性名次；向量通道使用真实返回名次的倒数贡献（当前为 1/(60+rank)）。SQL 的排序索引负责读取窗口，稳定 ID 仅作同分分页次序，融合分数不删除关键词全集；可选 reranker 只重排需要优先处理的窗口，不能将窗口外候选无理由排除。各通道分数不可未经校准直接当相关概率。

单路失败时已取得结果继续进入候选库，显式标记缺失通道并安排重试/替代动作。未执行向量时不能显示“双路已完成”。快查零候选也不是无条件终止信号，Agent 仍可核对解析、数据能力和后续扩搜价值。

## 5. 数据 schema 与索引生命周期

下表为逻辑模型，建表/索引 DDL 在落地时维护，避免文档假装已有 migrations。

| 数据结构 | 关键内容 |
| --- | --- |
| dataset_generation | 来源文件/业务水位、schema、映射和规范化版本、导入状态 |
| ticket / ticket_version | 稳定工单 ID、不可变版本、L0/L1、可检索字段与原文引用 |
| searchable_field / chunk | 字段、规范化文本、片段位置与哈希；不把推断元数据当来源事实 |
| index_generation | Milvus collection/alias、embedding 与 chunk 配置、导入水位、发布状态 |
| indexing_job / outbox | 增量变更、去重键、重试、删除墓碑和执行进度 |

JSONL 先导入相同规范化模型，文件 Provider 保留为确定性对照。开发版本按不可变 dataset generation 查询；未来业务数据采用版本/水位与短事务，不能为一次 3 分钟检索保持整库长事务。

MySQL 工单是事实源；索引异步构建，按 sourceVersion 幂等 upsert/delete，完成校验后发布 generation。任务固定可查询的数据/索引版本组合，标识向量是否落后于 SQL。已发布新代不自动使所有旧任务失效：保留的旧来源和旧索引仍可查询，输出前将涉及的工单与当前发布版本逐项核对存在、内容版本和当前访问资格；相关工单改变、删除或撤权时明确拒绝，无关新增或索引切换不改变旧引用。Milvus 自身的一致性选项不能自动保证与 MySQL 同步。[Milvus consistency](https://milvus.io/docs/consistency.md)。索引滞后时保留 SQL 结果和缺口，不虚称语义覆盖完整；新代索引切换不改变旧证据身份。

向量返回 ID 必须回 MySQL/Provider 核对存在、版本、当前资格和可访问字段。索引中的镜像权限或状态只作预过滤，不成为最终授权依据。当前同数据范围仍需要后端任务与数据访问边界；业务库不接受模型任意写操作。

## 在线存储与资源边界

数据库快照保存版本、授权绑定和字段目录，不持有整代工单正文。`ra_ticket_access` 保存可索引的访问属性和 L0/L1 投影，`ra_search_candidate` 保存两路并集及可索引排序，`ra_provider_candidate` 保存已发出的稳定引用。初始化为旧代补齐缺失投影；查询、恢复和进度只读取当前窗口，原文与向量片段身份核对按工单 ID 读取。`ra_search_hit` 继续保留通道审计。

关键词全部枚举在 SQL 内执行，ID 批次最多 500 条；`searchMaxScan` 对数据库路径限制每批物化的 ID 数，不再以授权库总条数拒绝窄条件查询或截断结果全集。文件 Provider 仍以此限制一次内存扫描，主 Agent 和专家共用同一配置。批次与取消约束不等于 SQL 扫描耗时保证，窄过滤、复杂授权和实际数据规模仍需测量。

进度查询走排序索引的有限窗口，不在 Node 中重复排序累计全集。搜索尚未稳定时不提供排名续页游标；完成后游标绑定查询和最后排序键。旧数据库快照保留原复合版本哈希及引用算法；读取合法旧排名游标时明确提示排序升级，从新顺序的首项重新枚举，由稳定引用去重，避免沿旧偏移跳过工单。

相同查询通过数据库连接级互斥协调不同 Provider 实例，锁连接与执行查询的连接池分开，避免所有执行连接都被锁占用。已完成结果复用固定集合；中断尝试仅重建该查询的派生候选与通道审计，不沿用残留向量分数。此互斥不持有业务工单的长事务或写锁。

## 6. 性能与验证

性能分解为解析、SQL 首批/全部枚举、embedding 排队/计算、Milvus、合并、证据读取。常驻模型、批量 embedding、连接池、索引预热、限并发和取消传播分别计时；给后台建索引和交互请求不同的队列优先级。冷启动/模型下载与已就绪在线查询单独计量。

跨字段查询应覆盖声明的可检索正文。例如标题与摘要未同时出现两个词时，问题描述或处理记录仍可能提供匹配。字面命中不是相关性标签；默认数据的字段与来源边界见 [数据说明](../../data/README.md)。

验收重点：跨字段 AND、嵌套 OR/NOT、空值和日期、字面原因区分、关键词全集与分页一致、SQL/文件匹配一致、Milvus 真实调用、陈旧索引与删除、单路失败、千级候选内存/首屏、取消后的模型服务占用。加速效果必须同时报告命中集合差异与延迟，不用“变快了”掩盖漏检。
