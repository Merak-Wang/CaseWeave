# 开发与运行

完整容器部署适合单机试用；源码入口供开发、集成与排障使用。产品概览见 [README](../README.md)，测试范围见 [评测与验收](EVALUATION_STRATEGY.md)。

默认数据库工作台位于 `/retrieval`。MySQL 保存任务、命令、事件与结果版本，DSH 执行主 Agent 和领域专家。关闭浏览器不取消后台任务；再次连接时重新校验访问资格。

终态显示确认数量、检索说明、逐项确认理由和下载。未判定工单保留在检索过程中。普通终态补充在同任务内发起复核；新查询可使用“新任务：……”明确新建。CSV 只交付确认集合。

兼容同步入口 `POST /api/retrieval-agent/export` 接收 `{ sessionId, retrievalId, resultRevision, candidateRefs? }`。resultRevision 来自已重新授权的 presentation.result；省略 candidateRefs 下载全部确认工单，显式传入只允许确认子集。旧版本请求返回 409，未确认引用返回 400，来源失效/撤权会终止下载。当前每页读 100 条，CSV 响应默认最大 50 MB；持久 CSV/JSONL/Markdown 工件走下方“工作台、报告与持久下载验收”中的任务接口。

## 一键容器部署

首次使用在仓库根目录运行 Windows `./setup.cmd` 或 Linux/Git Bash `bash setup.sh`。Windows 入口通过 [setup.ps1](../setup.ps1) 定位 Git for Windows 自带的 Bash，两边执行同一个 [setup.sh](../setup.sh)。需要已启动的 Linux Docker 引擎、Compose v2.20+ 和 Git；向导不依赖宿主 Node、pnpm、Python 或 uv。

没有 `.env` 时从 [.env.example](../.env.example) 创建；首次选择 CPU/GPU，再填写 Provider、模型、API 地址和密钥。只补充缺失项，已有值继续复用。主模型的密钥环境变量名自动设为 `RETRIEVAL_AGENT_MAIN_MODEL_API_KEY`，与应用 Compose 的实际转发字段一致。密钥隐藏输入，配置不作为 shell 脚本执行；特殊字符按 [Docker dotenv 规则](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#env-file-syntax) 保存，由 Compose 解析。宿主环境变量仍按 Compose 规则优先于 `.env`，修改配置文件后需注意已有环境变量的覆盖。

常用选项如下；Windows 将 `bash setup.sh` 换为 `./setup.cmd`，参数相同：

```bash
bash setup.sh start                          # 日常启动已有镜像及依赖服务
bash setup.sh stop                           # 停止当前项目，保留容器和数据卷
bash setup.sh status                         # 显示当前项目所有容器状态
bash setup.sh logs                           # 应用/模型服务最近 100 行日志
bash setup.sh --check                         # 只检查 Docker 和已有配置
bash setup.sh --gpu                           # 保存并使用 GPU 配置
bash setup.sh --cpu                           # 保存并使用 CPU 配置
bash setup.sh install --non-interactive       # 显式完整安装或升级
bash setup.sh --no-build                      # 复用现有应用/模型镜像
bash setup.sh --env-file .env.local --check    # 检查另一份配置
```

不带操作名时，没有 `.env` 才进入首次安装；已有 `.env` 默认日常 `start`。Windows 也可直接双击根 `start.cmd`。更新代码后的完整部署使用 `setup.cmd install`；只改应用时使用 `docker compose build app` 后 `setup.cmd start`。显式 CPU/GPU、检查或安装选项仍进入对应流程。日常 `start` 执行 `docker compose up -d --wait --no-build --pull never app`，启动 app 及 MySQL/Milvus/模型依赖，明确禁止自动构建和拉取镜像，不执行 model-prepare、app-prepare 或索引脚本。`stop` 使用 `compose stop --timeout 60`，给服务 60 秒退出时间；`status` 使用 `compose ps --all`，`logs` 读取有限日志。日常操作要求已有 `.env`，不会创建或修改配置，也不运行主模型配置向导；即使模型凭据待修复，仍可停止服务或查看状态/日志。已有 `.env` 但缺少镜像、数据或模型时应显式运行 `setup.cmd install`。

应用的 `pnpm install` / `pnpm build` 已在 Dockerfile 构建阶段执行。容器日常启动无需宿主构建；宿主源码修改后，需要重新构建应用镜像才能进入容器。关闭终端或浏览器不停止容器；电脑重启后先启动 Docker，再执行 `setup.cmd start` / `bash setup.sh start`。

端口在 `.env` 的 `RETRIEVAL_AGENT_*_PORT` 中设置。同一宿主运行多个实例时，使用不同 `COMPOSE_PROJECT_NAME` 和未占用端口；后续重启保留项目名以继续使用原卷。`--check` 不修改配置，不下载、启动或请求主模型 API。GPU 启动失败会退出，不能将其当作 CPU 成功。任何部署步骤失败均返回非零退出码，后续步骤停止；修复后重复运行，底层数据/模型准备脚本校验并复用有效文件和已完成进度。最后的健康检查只表示工作台启动，主模型 API 与业务查询应在公开工作台另行验证。

向导按顺序执行以下入口；需要逐步排障时，在已填写 `.env` 的仓库根目录执行：

```sh
docker compose build app model-service
docker compose run --rm --no-deps model-prepare prepare --download
docker compose up -d --wait mysql milvus model-service
docker compose run --rm --no-deps app-prepare
docker compose run --rm --no-deps app-prepare node scripts/database.mjs prepare
docker compose run --rm --no-deps app-prepare node scripts/database.mjs grams
docker compose run --rm --no-deps app-prepare node scripts/database.mjs verify
docker compose up -d --wait app
```

入口回归：`node --test --test-concurrency=1 scripts/setup.spec.mjs`，需要 Docker Compose CLI 和 Bash。测试使用真实 Compose 解析配置，以受控 Docker 执行器验证首次向导、密钥特殊字符、失败中止、重复运行、GPU 失败和只读检查，不创建业务容器或模型请求。

### 模型设置、内存与项目名称

工作台首页和任务追问输入框提供模型选择器，左下角“模型与供应商”打开管理面板。供应商目录、协议、模型发现、设置校验与凭据存储复用 DSH；支持 OpenAI 兼容地址、Responses、Anthropic 及 DSH 当前目录。Ollama 在容器中使用 host.docker.internal:11434/v1，未设密钥时自动使用其忽略的占位值。自定义模型应填实际服务的上下文容量。任务内切换影响后续步骤，正在生成的请求继续结束；新任务采用默认选择。OpenCode Go 按会话附加 x-opencode-session，已有其他 header 保留。密钥不会返回浏览器或写入 localStorage。

.env 的模型配置只作为启动种子；相同配置的重启不会覆盖页面里保存的设置。修改环境中的模型种子可显式更新默认值。首次升级会建立种子指纹；后续设置沿 DSH 私有状态卷保存。

MySQL 数据文件位于 mysql-data 卷，Milvus/etcd 位于 milvus-data 卷。内存包括数据库页缓存、索引、Node 会话、PyTorch 和 embedding 权重。MySQL 默认页缓存从 1G 调为 256M，可用 RETRIEVAL_AGENT_MYSQL_BUFFER_POOL 调整；它不是数据库容量限制。Performance Schema 保持启用，语句摘要和长历史各保留 1000 项，减少单机试用中的诊断内存；调节依据见 [MySQL 官方变量说明](https://dev.mysql.com/doc/refman/8.0/en/performance-schema-system-variables.html)。MySQL/Milvus 设置 60 秒优雅退出窗口。GPU embedding 已按硬件使用 BF16/FP16，首版默认不加载 reranker。不同精度会改变向量，不能为了省内存直接换精度而沿用未经核对的索引。

默认 Compose 项目名为 `retrieval-agent`。新安装使用默认卷配置；迁移已有项目时，通过 `RETRIEVAL_AGENT_VOLUME_PREFIX` 和 `RETRIEVAL_AGENT_EXISTING_VOLUMES=true` 显式指定原卷。先确认原卷身份，再停止旧容器并创建新容器。不要使用 `down -v`，也不要仅更改项目名后连接到空库。

应用镜像将固定 DSH runtime、依赖 fetch 与源码 build 分层，源码修改可复用下载缓存。日常 start 不触发这些构建层。构建耗时与资源占用取决于硬件和缓存状态。

## MySQL / Milvus 与持久任务入口

首次使用推荐根 [README 的完整容器步骤](../README.md#快速开始)。[应用 Dockerfile](../config/app/Dockerfile) 安装 Node 24.13.0、pnpm 10.28.2、workspace 锁文件与独立 [DSH runtime 锁文件](../config/app/runtime/pnpm-lock.yaml)，并以非 root 用户运行。下面的宿主命令用于源码开发；不要求完整容器路径的使用者安装宿主 Node/Python。

`.env.example` 的 `COMPOSE_FILE` 合并数据库、模型和应用配置，固定 `;` 分隔符，跨 Windows/Linux 使用同一文件；NVIDIA GPU 追加 `config/model-service/compose.gpu.yml`。`app-prepare` 与 `app` 共用具名 data/state/wiki/output 卷，默认模型仅 embedding；可选 reranker 先以 `RETRIEVAL_AGENT_RERANKER_ENABLED=true` 运行 model-prepare 下载，再启动同配置的模型服务。CPU 双模型比单 embedding 消耗更多内存，部署时应按所选模型测量常驻内存。

镜像升级前给现有 app/model 镜像添加明确备份标签，记录 `docker image inspect` 的 ID；对 MySQL 做一致性备份，并保存 Milvus、etcd、app-state、app-data、app-wiki 和模型/缓存卷。包含凭据的备份只保留在私有目录。更新源码后执行 `docker compose build app model-service`、`docker compose up -d --wait model-service app`，保留原 Compose 项目名和卷。回退时在 `.env` 指定 `RETRIEVAL_AGENT_APP_IMAGE` / `RETRIEVAL_AGENT_MODEL_IMAGE` 为已保存标签，再启动同一服务。镜像回退仅适用于 schema 仍兼容的版本；数据库不兼容升级必须使用匹配的一致性备份恢复。

首次完整安装需要完成数据和索引准备。`No published dataset` 表示尚无可服务的数据发布，应先运行 `database.mjs prepare`。准备脚本默认保留已有业务卷。

数据库快照不再采用 JSONL 演示 Provider 的 15 分钟失效期限。每次搜索、读取、SSE、报告与下载仍重新取得可信身份，检查授权绑定、来源与索引发布；只有这些身份保持一致才允许恢复同一快照和引用。旧数据库快照在恢复时迁移这项期限语义，不迁移已改变的来源、不自动恢复已被撤销的确认。旧 JSONL profile 保持原期限；工件自身的存储到期规则仍独立生效。

企业业务 Wiki 的离线读取不依赖数据库和模型：`node scripts/wiki-store.mjs catalog`、`node scripts/wiki-store.mjs verify`；搜索、指定领域与正文读取见 [知识库调用契约](../wiki/INTEGRATION.md)。启动默认 `RETRIEVAL_AGENT_WIKI_ROOT=<项目>/wiki`，可覆盖为其他已发布目录；缺库/坏库保持零样本路径。专家运行与 CLI 共用 agent-plugin 内的只读 Wiki 实现，原始/私有资料不属于运行时输入。

Wiki 文件修改使用 `node scripts/wiki-store.mjs checkout --id 条目ID --out 已存在目录/修改.json`，编辑正文后执行 `publish --delta 文件`；完整参数见 [调用契约](../wiki/INTEGRATION.md)。数据库 profile 默认启用学习，使用当前 DSH 主模型分别提炼与独立核验；确认下载不等待学习完成。`RETRIEVAL_AGENT_WIKI_LEARNING=0` 冻结学习，适合独立对照；JSONL Session profile 不运行持久学习。学习记录在 MySQL `ra_wiki_learning`，完整请求和发布来源映射保存在私有边界，不出现在专家条目。重新构建后重启 Host 才会加载这些入口。

需要运行中的 Docker Desktop、已安装的 workspace 依赖和本地模型。容器配置见 [compose.yml](../config/database/compose.yml)：MySQL 8.0.46、Milvus 2.6.14、etcd 3.5.23，镜像已按实际拉取的 digest 固定。仅绑定回环地址：MySQL `13306`、Milvus `19530`、健康检查 `9091`；etcd 不发布宿主端口。MySQL 和 Milvus 使用原命名卷，etcd 继续读取 `milvus-data` 内原 `/var/lib/milvus/etcd`，配置路径保留为 `embedEtcd.yaml`。Milvus 关闭内嵌 etcd，依赖独立 etcd 健康后启动，避免恢复旧成员时选主未稳导致 panic。

从旧内嵌配置升级时，先执行 `docker compose -f config/database/compose.yml stop milvus`，再 `pnpm db:up`；保持原卷和成员数据，不使用 `down -v` 或重新导入索引。`model:container up --with-database` 检测到旧内嵌容器会明确拒绝并提示此升级步骤，避免两个 etcd 进程同时打开同一数据目录。已经升级的服务继续沿原 `--no-recreate` 行为启动。

在仓库根执行以下步骤。已有数据和模型时无需重新下载：

```powershell
pnpm -r --if-present run build
pnpm db:up
uv run --frozen --project python/model-service --group runtime retrieval-agent-model-service --manifest architecture/model-manifest.json --embedding-path models/Qwen3-Embedding-0.6B --spacy-path models/zh_core_web_sm-3.8.0 --domain-lexicon config/query-domain-lexicon.json --vector-cache-dir .cache/retrieval-agent-vectors
```

模型服务保持运行，在另一个终端准备数据库并打开浏览器：

```powershell
pnpm db:prepare
node scripts/database.mjs grams
pnpm db:verify
pnpm start:database --no-open --port 3082
```

打开 `http://127.0.0.1:3082/retrieval` 使用持久任务工作台，DSH 原设置界面在同一 Host 的根路径。启动自动创建缺失的任务表和快照表，不自动导入业务数据、旧 Session 或重新构建向量。已有已发布数据时跳过 `db:prepare`/`grams`，只启动数据库、模型和 Host 即可。

工作台收到查询/补充后显示已保存回执；关闭或刷新页面只移除事件订阅，worker 继续执行。重启同一数据库/profile 后自动恢复未完成租约；通过任务 URL 或本浏览器的历史链接返回。取消停止后续工作，保存的输入仍保留。问题回复绑定 questionId，失效问题拒绝错答；相关性标记只作为 Agent 待复核反馈。来源/权限已变化则拒绝旧候选、报告和下载，保留已保存输入。CSV 下载按 SQL 当前 resultRevision 逐页重新核验。

`db:prepare` 读取现有 `data/tickets/esft/summary-train.jsonl`，版本化导入 MySQL，使用真实 Qwen3-Embedding-0.6B 创建 Milvus 索引，全部片段确认后发布。摘要及完整原始对话按 360 Unicode 字符切片，实际模型再次检查 token 上限，拒绝静默截断。作业每批 checkpoint；中断后重跑同一命令复用已确认片段和带模型身份的 embedding 缓存。构建未完成不会发布部分向量索引。首批构建明显长于查询，不计入已就绪查询延迟。

`grams` 创建可选的 bigram 候选表，完成前查询继续使用精确扫描；启用后仍用 LOCATE 精确复核。`db:verify` 在完整当前语料上逐组比较文件解释器、SQL 扫描和已就绪 gram 路径的 ID 集合，结果写入 `output/phase1/database-verify.json`。这验证字面语义，不是业务相关性 Recall。

| 管理或核验命令 | 行为 |
| --- | --- |
| `pnpm db:status` | 查看当前来源、索引、水位和字段能力 |
| `node scripts/database.mjs import --path=文件 --dataset=名称 --watermark=版本` | 只导入并发布 SQL 来源；新版本向量尚未就绪时通道明确失败，已命中的 SQL 候选保留；重复导入同一来源保留原索引 |
| `node scripts/database.mjs index --dataset=名称` | 为当前来源续建完整索引并发布 |
| `node scripts/database.mjs rollback --dataset=名称 --generation=来源ID --index=索引ID` | 校验来源、索引、水位、完成数后原子切换发布；旧 generation 保留供回退 |
| `node scripts/measure-database.mjs` | 从公开 Controller 测解析、首批候选、SQL、embedding 排队/计算/传输、Milvus、分页和 replay，保存 `output/phase1/public-fast-query.json`；不调用语义判断 Agent |
| `$env:RETRIEVAL_AGENT_DATABASE_TEST='1'; pnpm exec vitest run tests/database-vertical.spec.ts` | 真实 MySQL、Milvus、Qwen 夹具验收；未设置变量时此项跳过，不冒充实库通过 |

连接覆盖使用 `RETRIEVAL_AGENT_MYSQL_URL`、`RETRIEVAL_AGENT_MILVUS_URL`、可选 `RETRIEVAL_AGENT_MILVUS_TOKEN`、`RETRIEVAL_AGENT_MODEL_SERVICE_URL` 和 `RETRIEVAL_AGENT_DATASET_ID`。默认 MySQL URL 为本机开发容器 `mysql://root@127.0.0.1:13306/retrieval_agent`。导入、索引和发布是开发管理入口，不注册为模型可调用工具；检索 Provider 对业务工单只读。

下面的 JSONL 技术预览仍为已有 profile/旧 Session 的显式兼容入口。数据库模式由 `start:database` 设置 `RETRIEVAL_AGENT_STORAGE=mysql_milvus`，preset 选择 `taskPersistence: mysql`；普通 `pnpm start` 仍是 Session 技术预览，不保证后台持久恢复。退出条件是确认旧 profile 的实际消费者迁移、历史只读处置后再切换通用启动别名；不自动导入或双写旧 Session。两种后端的历史快照不能互换，数据库模式只信任 SQL 任务。

持久任务与数据库的定向检查：

```powershell
$env:RETRIEVAL_AGENT_DATABASE_TEST='1'
pnpm exec vitest run packages/agent-plugin/src/durable-service.spec.ts tests/database-vertical.spec.ts packages/product-host/src/index.spec.ts packages/product-api/src/service.spec.ts --maxWorkers=2
```

持久任务测试连接真实 MySQL，每个用例创建独立 `ra_phase2_test_*` 数据库，并在结束后校验名称、删除本例数据库；Host 替换仍在同一用例内共享该数据库。使用安装版 DSH loop、可控 Provider 和脚本模型验证租约、迟到结果、澄清/反馈、冷恢复与确认 CSV；不是主模型质量评测。database-vertical 另外调用真实 Milvus/Qwen 并验证新 Provider 实例恢复原快照。未设置环境变量时两类实库测试跳过。浏览器故障验收夹具 `tests/fixtures/phase2-delay-proxy.mjs` 只延迟转发真实 embedding 响应，供关闭/强制重启测试；日常模型地址保持 8012，不使用该延迟代理。

## 查询分析 HTTP 验收

查询分析的真实 HTTP 边界验收使用 `node scripts/verify-query-analysis.mjs http://127.0.0.1:8012`（也可用 `RETRIEVAL_AGENT_MODEL_SERVICE_URL`）。它复用已运行的 spaCy 模型服务，检查含 emoji 的 UTF-16 来源位置、用户所在地与明确地域限制，以及重复地名的操作符归属；结果写入 `output/query-analysis/acceptance.json`。不调用主 LLM，也不代表 Agent 业务语义质量。

## 上下文与专家验收

主 Agent 与领域专家的工作上下文默认上限为 **256K（262,144 tokens）**。若所选模型窗口或部署上限更小，扣除协议/输出余量后取较小值；显式 `contextTokenBudget` 仍为部署覆盖。工作视窗不填满配额：候选/原文仍按已有结构窗口选取，完整请求另由 DSH 请求测量与模型窗口校验。没有获取到模型窗口时，这只是工作配额，不宣称模型支持该容量。

工具错误返回字段、引用与可恢复动作供模型纠偏，不按连续错误总次数停止。maxRepeatedToolErrors 默认 4，仅针对相同工具、规范化参数和相同错误、且期间没有有效动作或新候选/证据/判断的重复循环；参数变化、有效动作或输入修订会重新开始检测。state_id 的计量变化不算进展。主 Agent 和专家都移除固定动作/请求次数截止，专家旧 maxActions 仅保留为历史规划字段，不限制执行。专家先共享分配候选的已授权来源，仍按实际模型请求记录可见性；按独立范围并行，缺失事实才补读，完成后集中提交简短的逐条报告。累计 token 保留，时间和累计调用数不能代替语义停止。

上下文与专家的定向检查：`pnpm exec vitest run packages/agent-plugin/src/experts.spec.ts packages/domain/src/experts.spec.ts packages/domain/src/context.spec.ts packages/provider-local/src/source.spec.ts packages/provider-local/src/provider.spec.ts --maxWorkers=2`。其中脚本模型经过安装版 DSH 验证千级历史、角色可见性、并行去重、Wiki 固定版本、分歧取证与独立专家待答；它不测业务精度。实际 MySQL 工件外置/恢复仍运行上方 durable-service 验收，较小语义模型需要单独配置路由，不会自动下载或替换用户模型。

## Wiki 发布与学习验收

Wiki 定向检查：`pnpm exec vitest run packages/agent-plugin/src/wiki-publisher.spec.ts packages/agent-plugin/src/wiki-learning.spec.ts`、`node --test scripts/wiki-store.spec.mjs`、`python scripts/wiki-build.spec.py`。真实 MySQL/公开 HTTP/安装版 DSH 的 A11 运行方式为设置 `RETRIEVAL_AGENT_DATABASE_TEST=1` 后执行 `pnpm exec vitest run packages/agent-plugin/src/durable-service.spec.ts -t "A11:" --maxWorkers=1`；这些场景使用脚本模型，覆盖文件修改后的实际专家输入、反馈复核、并发、恢复与反例替换，不证明语义质量。

额外设置 `RETRIEVAL_AGENT_WIKI_REAL_MODEL=1`，并将过滤名称改为 `"A11 real configured"`，可复用现有本地 DSH profile 中所选的真实模型。该入口使用独立临时 MySQL 数据库、空 Wiki 和两条合成工单，真实执行模型的查询、反馈复核、学习及下一任务专家消费；凭证只在进程内复用，失败轨迹也写入 `output/phase4-wiki/real-model.json`。它会实际调用已配置服务，不属于默认测试，也不代表真实业务集或约 27B 目标基底的质量验收。

## 工作台、报告与持久下载验收

仅调整工作台时，可通过本地预览使用同一构建的 HTML/脚本，并转发到已经运行的任务 Host。先在项目根目录执行：

```powershell
pnpm --filter @retrieval-agent/product-host build
$env:WORKBENCH_UPSTREAM='http://127.0.0.1:3086'
node scripts/preview-workbench.mjs
```

打开 `http://127.0.0.1:3088/retrieval`。端口可通过 `WORKBENCH_PREVIEW_PORT` 设置。预览仅监听回环地址、仅转发 `/api/retrieval-agent/`，保留浏览器的 Host/Origin 供正式服务核验；任务、证据和下载仍来自原 Host。源样式修改后重新构建并重启预览进程，再刷新浏览器。此入口不替代正式服务的构建/部署，也不包含业务模拟数据。

专家与知识界面专项：`pnpm exec vitest run packages/product-host/src/orchestration.spec.ts packages/agent-plugin/src/knowledge-view.spec.ts packages/product-host/src/workbench-content.spec.ts`。设置 `RETRIEVAL_AGENT_DATABASE_TEST=1` 后运行 `pnpm exec vitest run packages/agent-plugin/src/durable-service.spec.ts -t 'A9 UI|resumes an independent expert' --maxWorkers=1`，经过真实 MySQL、公开 HTTP 与安装版 DSH 验证并行分支、实际请求知识引用、固定版本正文、撤权和恢复；使用脚本模型，不证明业务质量。

额外设置 `RETRIEVAL_AGENT_ORCHESTRATION_BROWSER=1` 时，A9 UI 用例在并行专家执行期间保留浏览器入口，地址与本次 `completionFile` 写入 `output/orchestration/public-entry.json`。完成浏览器检查后，仅向该文件写入无换行 `done`，用例继续验证终态、重放和条件修订。这是可控任务夹具，不能把其中的展示数据当成真实模型产物。真实应用通过 `/tasks/:id/knowledge` 和 `/tasks/:id/knowledge/:entryId` 展示本任务固定 Wiki 版本，经当前访问资格校验。

数据库工作台默认显示 30 条确认工单，当前候选/历史候选在可选过程页分开分页；旧 `/export` CSV 入口保留兼容。首页、三类视图、证据侧栏及报告/工件路径见 [工作台设计](design/WORKBENCH.md)。`GET /report` 先返回结构化范围与代表性依据，申请 `kind=report` 的持久工件后使用当前 DSH 模型起草和独立校验。无需增加另一组模型凭证或改动业务工单。

定向确定性检查：

```powershell
pnpm exec vitest run packages/product-api/src/service.spec.ts packages/product-host/src/index.spec.ts --maxWorkers=2
$env:RETRIEVAL_AGENT_DATABASE_TEST='1'
pnpm exec vitest run packages/agent-plugin/src/durable-service.spec.ts -t 'phase5:' --maxWorkers=1
```

专项使用真实 MySQL、公开 HTTP 和安装版 DSH 的脚本模型，验证异步问题、全文 JSONL、报告起草/校验接线、重复命令、失效版本、撤权、租约恢复、工件损坏与到期。数据库工件使用 15 秒租约、7 天获取期限、50 MB 单文件资源上限；每次 Provider 读取不超过 100 条。它们是资源配置，不是语义停止条件。到期审计的自动清除尚未实现。

显式设置 `RETRIEVAL_AGENT_PHASE5_SCALE=1`，以 `-t 'A14 phase5 scale:'` 运行 1,234 条完整确认和交付规模专项；此脚本模型按实际可见摘要逐条提交判断，不评业务精度。规模来源明确配置一小时有效期，驱动最多等待三十分钟；两者仅保证专项有机会验证长任务交付，不改变生产默认期限、权限检查或模型停止要求。观察阶段只轮询持久终态标志，完成后从公开快照/窗口/工件接口检查完整 ID、正文、字节数和哈希；不能将此规模用例视为高频快照压力测试或 1～3 分钟性能达标。

显式设置 `RETRIEVAL_AGENT_PHASE5_REAL_MODEL=1`，以 `-t 'A14 phase5 real configured'` 使用当前配置的真实 DSH 模型，在两条合成工单上验证查询→读取原文→确认→报告起草→独立来源校验→Markdown 获取，证据写入 `output/phase5/real-model.json`。凭证仅在进程内复用；它不证明真实语料 Recall 或约 27B 基底质量。

浏览器人工操作夹具设置 `RETRIEVAL_AGENT_PHASE5_BROWSER=1`，运行 `-t 'A14 phase5 browser fixture'` 后读取 `output/phase5/browser-fixture.json` 的地址；完成后向其中 `completionFile` 指定的本次文件写入无换行的 `done`。夹具使用真实 MySQL/DSH 和受控业务资料；结束信号只终止本次夹具，不取消用户真实任务。规模专项可同时设置该变量保留临时工作台供查看，完成后向 `output/phase5/scale-browser-finished` 写入无换行 `done`；再次运行前移除这个由自己生成的结束信号。必须检查终态与下载，不能手填确认结果。

工作台浏览器回归使用正式 HTML、构建后的脚本、公共任务接口与实际文件保存。启动上述新鲜浏览器夹具后，在另一终端执行（将 `夹具URL` 替换为输出地址）：

```powershell
npx --yes --package @playwright/cli playwright-cli -s=workbench open '夹具URL' --browser chrome
node scripts/verify-workbench-browser.mjs --session=workbench --scenario=inputs --out=output/phase8/final-browser
node scripts/verify-workbench-browser.mjs --session=workbench --scenario=delivery --out=output/phase8/final-browser
node scripts/verify-workbench-browser.mjs --session=workbench --scenario=boundaries --out=output/phase8/final-browser
node scripts/verify-workbench-browser.mjs --session=workbench --scenario=files --out=output/phase8/final-browser
```

顺序分别为：丢回执重试、问题恢复/回复与可选反馈；报告引用、Markdown/CSV/完整 JSONL 保存、四种宽度与键盘；跨标签页条件修订及迟到报告/详情；损坏文件拒绝保存及工件状态。脚本中错误/加载等视图使用明确标注的响应故障注入，不能替代后台同场景验收。runner 将 CLI 的结构化结果保存为 JSON/log，任何断言失败、异常或缺少结果都返回非零退出码；不能只看 Playwright CLI 的退出码。

规模夹具完成后，在其 `scale-browser.json` 地址打开工作台，再用 `--scenario=scale` 检查 30 条 DOM、第二页滚动、迟到详情与全部 1,234 条下载。报告/文件输出固定在 `output/phase8`，截图在 `output/playwright`；`--out` 指定的是结构化检查记录目录。这些浏览器脚本消费受控夹具；真实 DeepSeek/ESFT 任务仍需在 `/retrieval` 操作并用 `accept:task --expect=独立期望` 单独验收。

已有可交付报告的任意真实任务可以使用 `--scenario=report-layout`，检查四种宽度的长哈希换行，以及引用展开后返回相同阅读位置和焦点。它不提交新输入，也不调用报告扩写模型。

## OpenCode Go 会话路由

当前固定的 DSH `0.1.5-rc.2` 已把 `sessionId` 传至 pi-ai，但原适配器没有发送 OpenCode Go 要求的 `x-opencode-session`。项目 bundle 现禁用默认 `llm-pi-ai` 组合行，装配 `@retrieval-agent/bundle/opencode-pi-ai` 兼容入口；仍使用同一 `llm-pi-ai` 设置、模型目录、凭证和上游请求实现。无需在设置中手填固定请求头。政策依据见 [上游讨论 #5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495)。

每次请求根据 DSH 的完整会话身份生成稳定 UUID：已有 UUID（含 `session-` 前缀）保留其 UUID，其他历史/自定义身份确定性映射为 UUID v5。续问、重试、恢复和带相同身份的压缩调用保持一致；新建/分叉/子会话使用其各自身份。仅 OpenCode provider 或解析后地址的精确 `opencode.ai` 主机启用，缺少会话身份时在发出请求前报错；同时查询不会修改或共用 provider 配置里的会话头。

更新后执行 `pnpm -r --if-present run build` 并重启 `pnpm start:database --no-open --port 3084`（JSONL 入口为 `pnpm start`）。已有 profile、模型、凭证与 Session 继续复用。定向验收为 `pnpm exec vitest run packages/dsh-compat/src/opencode-pi-ai.spec.ts`；`pnpm verify:install` 另检查发布包可解析、兼容入口实际装配且原适配器已禁用。

兼容实现仅在 dsh-compat 内包裹固定版本的 `PiAiAdapter.streamWithSnapshot`，覆盖普通与 prepared-call 两条入口；内部方法变化会明确拒绝启动，升级 DSH 时必须复核该接点。退出条件是上游原生适配器通过相同 HTTP 请求头测试与真实 Go 入口验证，然后一并移除 facade、bundle 导出和组合替换。仅修改本地 DSH 源码或缓存文件不会更新项目的发布包入口。

### DSH 升级与历史会话

DSH 版本及发布提交由 `provenance/baseline-manifest.json` 固定。Workspace 和独立启动器分别使用根目录及 `config/app/runtime/pnpm-lock.yaml`；源码启动器复制经过核验的运行时锁文件并冻结安装，已有设置和数据目录继续复用。不要单独更新全局 `dsh` 来替代项目运行时。

从 DSH `0.1.1-rc.2` 升级时，先停止使用同一 `DSH_HOME` 的全部 Host 并备份该目录。完成依赖安装和构建后，对旧 CaseWeave Session 显式执行：

```powershell
node scripts/migrate-dsh-sessions.mjs --home=.cache/retrieval-agent-local/dsh-home --check
node scripts/migrate-dsh-sessions.mjs --home=.cache/retrieval-agent-local/dsh-home --write
```

完整容器部署使用同一工具：先 `docker compose stop app`、备份 app-state 卷，再 `docker compose build app`；在应用保持停止时运行 `docker compose run --rm --no-deps app node scripts/migrate-dsh-sessions.mjs --home=/app/.cache/local/dsh-home --check`，核对拒绝项后将 `--check` 换为 `--write`。完成后通过正常 `start` 入口启动。使用部署配置中的原卷，不能另建空状态卷代替迁移。

自定义目录替换 `--home`。检查不写文件；写入逐会话发布 `session.v3.jsonl` 或 `.zstd`，保留原始 `session.jsonl`/`.zstd` 和校验回执。已迁移会话可重复执行。历史上先写用户消息、后开始步骤的会话，转换会在同一已开启轮次内前移已有的首个 `step/start`，同时重映射 DSH 引用；原消息顺序、时间戳、业务事件身份及内容保留。原始字节不修改。

工具对未支持的业务 schema、未知扩展、缺少可对应步骤等返回 `refused`，退出码为 1；其他可迁移会话仍可独立完成。拒绝项保留原文件，不生成猜测的步骤、结果或证据。升级后这些拒绝项不能作为已完成的新格式恢复结果。普通 DSH 会话交由上游原生迁移器处理。本操作只升级 DSH 日志，不导入或替换 MySQL 权威任务。

回退必须使用升级前的完整备份：新版继续运行后，新增事件只写 V3，旧程序读取保留的 V0 文件会得到过时状态。若旧文件在迁移后又被写入，校验回执会阻止继续迁移，需先恢复一致备份。

## Python 模型服务容器部署

容器路径使用宿主 Node.js/pnpm/DSH，以及 Docker Desktop 的 WSL 2 Linux x86_64 引擎；模型服务的 Python、uv、spaCy、PyTorch 和 CUDA 用户态库均在镜像中。Linux 主机需要 Docker Engine/Compose，GPU 还需要兼容的 NVIDIA 驱动及容器 GPU 配置。CPU 配置没有 GPU reservation，不要求 NVIDIA 设备。当前两条路径共用锁定的 cu128 wheel 镜像，CPU 也会携带 CUDA 库；这是保持同一依赖基线的体积取舍。

首次从源码准备（所有命令在仓库根执行）：

```powershell
pnpm model:container build
# 已有本地权重：只读导入，不修改原 models 目录
pnpm model:container prepare --import=./models
# 新机器没有权重时，改用下面一条；只由容器内程序联网下载
pnpm model:container prepare --download
pnpm model:container up --device=gpu --with-database
```

CPU 使用 `pnpm model:container up --device=cpu --with-database`。`--with-database` 对已有 MySQL/Milvus 使用 `--no-recreate`，不替换其容器；数据库端口、project name 和卷身份沿用原 Compose。普通 `up` 只管理模型服务。构建使用 [Dockerfile](../config/model-service/Dockerfile) 中固定 digest 的 Python 3.12.11 和 uv 0.12.10，`uv sync --frozen` 安装既有锁文件中的 Linux 运行依赖，启动时不安装包。构建上下文采用显式允许列表，不传入模型、业务工单、凭证、Session、宿主虚拟环境或缓存。

模型初始化按 [manifest](../architecture/model-manifest.json) 的固定 revision 和每个必需文件的 SHA-256 校验。`prepare` 将下载断点放在持久模型卷的 staging 中，进程锁串行准备，全部通过后原子发布至 manifest/角色身份目录；重复准备校验并复用。已有导入缺文件或校验失败时明确拒绝，不发布部分结果。日常服务只读挂载模型卷、设置离线加载；spaCy 管线由锁定 wheel 在构建时物化进镜像。缓存使用独立 `model-cache` 卷。可选 reranker 仍由 `RETRIEVAL_AGENT_RERANKER_ENABLED=true` 启用，须在准备和启动两步设置同一值。

宿主 Node.js 连接并使用 Docker 管理的服务：

```powershell
$env:RETRIEVAL_AGENT_MODEL_SERVICE_MODE='container'
$env:RETRIEVAL_AGENT_MODEL_CONTAINER_DEVICE='gpu' # CPU 对应 cpu
$env:RETRIEVAL_AGENT_UV_COMMAND='host-uv-must-not-run' # 可选验收哨兵
pnpm start:database --no-open --port 3084
```

模型 HTTP 仍为 `http://127.0.0.1:8012`。容器内通过显式 `--allow-container-bind` 监听 `0.0.0.0:8012`，宿主发布仅为 `127.0.0.1`；普通 Python CLI 保持回环默认。容器模式在 Compose 状态为 healthy 后核对 HTTP 就绪及所选 CPU/CUDA 设备身份，识别 starting、exited/restarting、unhealthy 和启动期限；失败打印日志且禁止回退宿主 Python。`Ctrl+C` 退出 Node.js 不停止 Docker 拥有的服务。已经 ready 的任意外部服务可用 `MODEL_SERVICE_MODE=external`；未就绪明确失败。默认 `host` 兼容本地 Python 开发、原 JSONL 启动器与模型调试命令，待这些实际消费者迁移并通过验收后才移除。

| 参数/操作 | 用途 |
| --- | --- |
| `RETRIEVAL_AGENT_MODEL_SERVICE_URL` / `RETRIEVAL_AGENT_MODEL_PORT` | 改宿主模型端口，例如 `http://127.0.0.1:18012` / `18012`；同时设置必须一致 |
| `RETRIEVAL_AGENT_MODEL_IMAGE` | 明确选择已构建或已导入的版本标签/digest；`up` 不自动拉取或构建 |
| `RETRIEVAL_AGENT_MODEL_START_TIMEOUT_MS` | 启动就绪观察期限，默认 600000；不影响 Agent 的语义停止 |
| `RETRIEVAL_AGENT_MODEL_MEMORY` / `MODEL_CPUS` / `MODEL_THREADS` | 全名均带 `RETRIEVAL_AGENT_` 前缀；默认 8g / 4 / 4 |
| `RETRIEVAL_AGENT_MODEL_MAX_BATCH_SIZE` / `MODEL_MAX_TOTAL_TOKENS` | 全名均带 `RETRIEVAL_AGENT_`；默认 16 / 8192，必须为正数 |
| `pnpm model:container status` / `logs` / `check` | 查看状态、最近日志、重新校验完整模型；check 不下载 |
| `pnpm model:container restart --device=gpu` | 重启并等待所选设备就绪，缓存和权重保留 |
| `pnpm model:container stop` | 只停止模型服务，不停止数据库、不删除任何卷 |

缺模型先执行 `prepare`；端口冲突先查看已有服务的所有权，或显式改端口。GPU 访问不可用时检查驱动和 Docker GPU 配置，或显式选择 CPU，不能把自动降级当作 GPU 验收。损坏模型不能就绪，应从可信备份恢复相同哈希文件；不要删除数据库、任务或整个缓存来处理模型问题。

镜像可用版本标签导出/导入，不需要镜像仓库：

```powershell
docker image tag retrieval-agent-model-service:0.1.0-cu128 retrieval-agent-model-service:saved-version
docker image save -o retrieval-agent-model-service-backup.tar retrieval-agent-model-service:saved-version
# 新机器导入镜像，然后导入原 models 或执行容器 prepare --download
docker image load -i retrieval-agent-model-service-backup.tar
$env:RETRIEVAL_AGENT_MODEL_IMAGE='retrieval-agent-model-service:saved-version'
pnpm model:container up --device=cpu
```

升级前保留上一个版本标签/digest；新版本显式 build/load、prepare、up，回退通过 `MODEL_IMAGE` 选回旧镜像并 up。不同 manifest/角色的模型发布并存，旧版本可继续校验读取。Node/DSH、数据准备、已发布索引、Wiki 和主模型凭证仍按原流程配置，模型容器化不提供这些业务配置。资源需求需结合模型配置和部署硬件评估。

定向检查：`node --test scripts/model-container.spec.mjs`、`pnpm model:test`、`pnpm exec vitest run tests/local-app.spec.ts tests/model-dependencies.spec.ts`。真实对照用 `node scripts/verify-model-container.mjs --url=http://127.0.0.1:8012 --out=output/phase7/host.json` 保存基线，再加 `--baseline=output/phase7/host.json --device=cpu --out=output/phase7/cpu.json` 检查容器。该入口只查询现有 publication，不导入/重建索引；保存向量数值、候选集合差异与预设容差，不替代公开 Agent 验收。`node scripts/verify-model-container-lifecycle.mjs` 准备两条小规模向量缓存并检查 HTTP 取消后继续推理；重启后加 `--after-restart` 必须命中磁盘缓存，两次通过 `MODEL_SERVICE_URL` 指向同一服务。

## JSONL 本地技术预览

需要 Node.js `>=22.19.0`、pnpm `10.28.2` 和 uv；版本依据根 [package.json](../package.json) 与 [uv workspace](../pyproject.toml)。在仓库根执行：

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm data:sync
pnpm build
pnpm retrieval-agent web
```

`pnpm build` 只编译代码。首次准备技术预览时，显式执行 `pnpm data:sync`，下载或复用锁定的 ESFT 数据、校验并构建派生数据；后续改代码无需重复同步数据。数据来源与目录见 [data/README.md](../data/README.md)。

数据许可、再分发和字段生成以 [data/manifest.json](../data/manifest.json) 为准。当前未能验证的时间、地域、状态字段保持缺失；条件检索可用声明这些字段的受控 fixture 验收，不能给现有语料编造属性。脱敏数据不等于生产权限或使用许可已经完成。

首次 `web` 会准备仓库专属 DSH runtime/profile，按模型 manifest 同步缺失依赖，复用或启动 Python 服务，并准备开发语料向量索引。这些步骤可能联网、下载模型并运行较长时间。构建产物、数据和模型已就绪后，后续启动复用它们。

```powershell
pnpm retrieval-agent web --no-open --port 3081
```

默认 Web 地址为 `http://127.0.0.1:3080`，模型服务为 `http://127.0.0.1:8012`。`pnpm start`、`pnpm app:serve` 是 Web 入口别名；`pnpm app:setup` 只准备本地 profile。浏览器中的 Agent 主模型通过 DSH 设置配置，真实任务需要可用的模型配置。

| 位置或环境变量 | 当前用途 |
|---|---|
| `.cache/retrieval-agent-local/` | 仓库专属 DSH runner、profile 与会话 |
| `.cache/retrieval-agent-vectors/` | 可复用的开发向量缓存 |
| `models/` | Git 忽略的模型文件，身份来自 `architecture/model-manifest.json` |
| `RETRIEVAL_AGENT_MODEL_SERVICE_URL` | 指向已有且 ready 的模型服务 |
| `RETRIEVAL_AGENT_AUTO_DOWNLOAD_MODEL=0` | 禁止启动器自动下载模型；缺失依赖时明确失败 |

`Ctrl+C` 退出启动器并清理它启动的子进程，持久 profile、Session 和缓存保留。外部模型服务由其原有管理入口负责停止。

索引预热保存 checkpoint 以便恢复，配置见 [index-preparation-config](../scripts/index-preparation-config.mjs)。DSH 固定版本由 [运行时清单](../provenance/baseline-manifest.json) 声明；凭据与用户设置保存在本地 profile。

## TypeScript 包与测试约定

包按实际运行环境、依赖方向和公开消费者划分；一个业务组件或实现文件不必独立发包。当前 13 个包及依赖以 [生成图](WORKSPACE_GRAPH.md) 为准。排名客户端已并入 `@retrieval-agent/model-service-client/ranking`；embedding/rerank 继续从主入口导入。两者连接同一 Python 服务，但各自保留响应校验、取消与长任务语义。仓库消费者与安装脚本同步迁移，不保留无消费者的旧排名包转发层。

- 使用现有 ESM / NodeNext、相对 `.js` 导入和 `package.json` 的 `exports`，类型导入用 `import type` / `type`。浏览器从现有的 `domain/result`、`domain/replay` 和 `product-api` 客户端子入口访问，避免加载服务端依赖。
- 公共 TypeScript 配置统一启用 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noUnusedLocals`、`noUnusedParameters` 等检查，应用到生产包、测试与浏览器夹具。不通过关闭检查或加无意义读取保留死代码；签名需要的未使用回调参数可使用 `_` 前缀。依据见 [TypeScript 配置参考](https://www.typescriptlang.org/tsconfig/)。
- 同一协议下的模块用包内目录与明确子入口组织，类型和实现就近维护。生产代码跨包不直接导入 `src`；跨包行为检查前先构建，独立打包/安装再确认真实发布入口。
- 包内 `*.spec.ts` / `*.spec.tsx` 覆盖组件和协议边界，根 `tests/` 覆盖跨包纵切；Vitest 两种扩展名都执行，测试不进入发布产物。按用户风险组织断言，不要求每个文件配一个测试，不为减少文件数合并不同边界。
- 复用 fixture 和参数化用例，独立触发各个失败条件。例如版本漂移测试使用正常的行号，乱序测试使用正常的版本，避免首个错误掩盖后续校验。授权、证据、条件修订、旧结果、幂等和恢复回归按实际边界保留。

## 编译与定向检查命令

下表只说明命令做什么。何时选择哪项检查由 [EVALUATION_STRATEGY.md](EVALUATION_STRATEGY.md) 定义，不要求每次依次执行全部命令。

| 现有命令 | 实际行为与限制 |
|---|---|
| `pnpm build` / `pnpm build:code` | 清理并重建 TypeScript 包，不下载或生成数据、模型与索引 |
| `pnpm typecheck` | 先构建一次跨包依赖，再检查包、根测试及浏览器夹具的类型；不准备数据或模型 |
| `pnpm typecheck:code` | 复用已构建的跨包产物，检查包、根测试及浏览器夹具的类型；不隐式构建 |
| `pnpm -r --if-present run typecheck` | 包级 `tsc --noEmit`；不重建跨包依赖产物 |
| `pnpm exec tsc -p tsconfig.tests.json --noEmit` | 检查根测试及包内测试类型 |
| `pnpm exec tsc -p tsconfig.browser.json --noEmit` | 检查浏览器夹具类型 |
| `pnpm exec vitest run packages/agent-plugin/src/service.spec.ts` | 运行指定相邻测试；路径可换成受影响的现有 spec |
| `pnpm test` | 运行默认行为/边界回归；不加载全量语料做假排名，实库专项需显式启用 |
| `pnpm model:test` | 通过 uv 运行 Python model-service 测试；环境未就绪时可能同步依赖 |
| `pnpm eval:self-test` | Python 评测数据与 scorer 自检，不执行真实 Agent 任务 |

跨包导入可能通过 package exports 读取 `lib/`。跨包源码变更后先显式 `pnpm build` 一次，再运行 `pnpm typecheck:code` 和所选行为检查；也可直接用 `pnpm typecheck` 完成构建与类型检查。单独 `--noEmit` 不能证明已有构建产物与源码一致。依赖开发语料的测试和运行入口要求事先显式准备数据，纯代码检查无需此步骤。

## 从用户入口独立验收

已有数据库工作台运行时，使用薄 HTTP 驱动提交真实自然语言任务：

```powershell
pnpm accept:task --url http://127.0.0.1:3084 --query "查找需要的工单" --out output/user-acceptance
```

驱动不导入生产模块，不注入 filters、判断或 Gold；检查重复提交、公开快照、页面声明字段的详情读取、终态和确认 CSV 的实际 ID/版本/哈希。`--expect 文件.json` 可提供独立期望 `{"confirmedIds":["工单编号"],"excludedIds":["不应交付的编号"]}`，期望只留在验收端。无期望时只说明协议与交付一致性，不能声称语义正确或找全。结果写入指定输出目录，退出码 0 表示语义完成终态及所选检查通过，1 表示检查失败，2 表示未完成或需要用户回答。

`--task 任务ID` 代替 `--query` 可检查已有任务，不取消或修改其查询；详情查看仍按正常用户操作记录阅读。默认观察 180 秒，`--timeout-ms` 可调整；超时/待答只取消本次驱动创建且尚未结束的任务，产品本身不会据此宣称完成。补充、反馈、问题回复、关闭/刷新与错误可见性仍按本次变更在真实浏览器独立操作，本脚本不宣称覆盖完整 A1–A14。

默认重放测试用小规模检查往返、迁移和旧版本拒绝。修改增量格式或压缩方式时，显式运行保留的 100 轮 / 2,000 候选规模检查：

```powershell
$env:RETRIEVAL_AGENT_REPLAY_SCALE='1'
pnpm exec vitest run packages/domain/src/patch.spec.ts
Remove-Item Env:RETRIEVAL_AGENT_REPLAY_SCALE
```

规模、实库和模型专项各自单独运行，避免并行负载把测试超时混成业务故障；这不替代专门的并发验收。完整语料完整性复用 `pnpm data:verify`，不在默认 Vitest 中重复扫描和假排序。

业务边界模型检查使用 `packages/agent-plugin/src/semantic-boundary-real.spec.ts`。配置下列连接变量并设置 `RETRIEVAL_AGENT_BOUNDARY_REAL_MODEL=1` 后，运行 `pnpm exec vitest run packages/agent-plugin/src/semantic-boundary-real.spec.ts --maxWorkers=1`。该检查通过 HTTP、TaskHost、DSH 和实际 Provider 验证原文场景，独立期望只留在验收端，任务使用隔离数据库。

`RETRIEVAL_AGENT_BOUNDARY_OUTPUT` 指定证据目录；`RETRIEVAL_AGENT_BOUNDARY_DSH_HOME`、`RETRIEVAL_AGENT_MYSQL_URL`、`RETRIEVAL_AGENT_MILVUS_URL`、`RETRIEVAL_AGENT_MODEL_SERVICE_URL` 可覆盖本机路径/端口。`RETRIEVAL_AGENT_BOUNDARY_REASONING=high` 仅修改该实验的推理档位；`RETRIEVAL_AGENT_BOUNDARY_EXPERT=1` 装配生产原生专家/零样本路径；`RETRIEVAL_AGENT_BOUNDARY_CASE=broad-topics` 单独观察普通主题查找是否无需提问而交付。没有精确语义标签的主题用例只证明完成行为，不能作为全部已确认工单的质量评分。默认测试跳过这些真实模型请求，检查产物写入指定输出目录。

`RETRIEVAL_AGENT_BOUNDARY_MODEL` 可在当前 Provider 上独立比较其他已发现模型。此选项通过运行中的工作台模型发现接口读取容量，默认 `http://127.0.0.1:3086/api/retrieval-agent/models`（可用 `RETRIEVAL_AGENT_BOUNDARY_DISCOVERY_URL` 覆盖），只修改实验进程内的模型声明与选择，并保存非敏感的 `model-discovery.json`；不会保存工作台设置。缺少已发现的上下文/输出容量时直接失败，不猜测容量。

## 数据、模型与发布工具

| 现有命令 | 当前用途 |
|---|---|
| `pnpm data:download` / `pnpm data:build` / `pnpm data:verify` | 分别下载原始数据、生成派生数据、校验数据；`data:sync` 组合三步 |
| `pnpm models:sync` | 同步当前启用的 manifest 依赖；可能下载模型 |
| `pnpm model:serve` / `pnpm model:serve:rerank` | 启动默认或启用重排的 Python 服务；启动前同步相应依赖 |
| `pnpm index:prepare` | 复用已构建的代码与已准备的开发数据，通过已有模型服务准备/复用向量索引；不隐式构建或下载 |
| `pnpm model:smoke` / `pnpm model:probe` | 已有真实模型服务的检索与协议诊断 |
| `pnpm model:eval` | 旧合成 Bronze 的 Provider-only 对照；不证明自然语言 Agent 任务质量 |
| `pnpm graph:workspace` / `pnpm verify:workspace` | 从实际 package.json 生成依赖图，检查未声明导入和 DSH 装配限制；不规定测试文件对应关系或依赖许可表 |
| `pnpm verify:release` | 复用已构建产物，打包并检查发布闭包、依赖及生产/评测隔离 |
| `pnpm verify:install` | 复用已构建产物和开发语料，在临时目录验证安装、组合、启动与卸载；可能安装锁定的 DSH/npm 依赖，不下载语料或模型 |

变更级检查优先选择上表中的定向命令；核心产品闭环按 A1—A14 选择受影响的公开纵切，具体场景由 [评测策略](EVALUATION_STRATEGY.md) 维护。`verify` 是工程检查聚合，包含 workspace、一次构建和类型检查、Vitest，不隐式执行全量语料假排名或发布检查。

包、依赖或安装行为改变时，在同次构建后选择 `verify:release` 和 `verify:install`；两者都不重复构建。`verify:all` 显式组合工程检查、Python 自检、发布闭包和安装检查，复用工程检查生成的产物。它不是日常定向检查入口，也不会自动准备数据或权重。

工程检查通过只证明对应代码、协议或受控场景；业务质量需使用真实任务、独立期望和明确的数据范围评估。

核心产品行为与评测场景见 [评测策略](EVALUATION_STRATEGY.md)，组件职责见 [架构说明](ARCHITECTURE.md)。
