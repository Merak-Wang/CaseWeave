# 络寻 · CaseWeave

**企业会话与工单证据检索智能体**

把分散的会话、业务条件与工单证据组织起来，用自然语言查找、复核并交付有依据的结果。

络寻 · CaseWeave 面向工单查询人员和业务管理人员，以工单为检索和交付单位，将关联会话原文作为可追溯证据。输入需要查找的问题后，系统结合关键词和向量检索寻找线索，由 Agent 核查业务范围与证据，并持续展示检索进展。你可以随时补充条件、查看原文或反馈判断问题。

## 主要功能

- **自然语言检索**：支持主题、数量、包含与排除条件，结合跨字段关键词匹配和语义召回。
- **有依据的结果**：区分检索线索与确认工单，提供确认理由和可追溯引用；遇到歧义时按需核对原文。
- **持续运行的任务**：关闭页面或断线后，后台任务继续运行；返回工作台可恢复进展并继续补充。
- **报告与下载**：围绕当前确认集合生成检索报告，支持 CSV、JSONL 和 Markdown 工件。
- **领域知识辅助**：主 Agent 按需调用领域专家与版本化 Wiki；经校验的检索经验可用于后续任务。

当前版本适用于单机试用。检索效果取决于数据完整性、模型能力和查询范围；报告会说明已检查范围及未解决的问题。

## 快速开始

获取源码可用 Git 或下载源码包。Windows 直接运行 `start.cmd`：自动准备 WSL 2，缺少 Docker 时从官方下载并安装 Docker Desktop（含 Compose），未运行时自动启动；无需 Git Bash。Linux 需先安装 Docker 和 Compose v2.20 或以上版本。GPU 模式需要 NVIDIA GPU 及可用的容器 GPU 支持。

Node.js、pnpm、Python、uv 和项目依赖在镜像构建时自动安装，宿主无需另装。Windows 首次安装若要求管理员授权、接受 Docker 首次许可、开启虚拟化或重启，按系统提示完成后再次运行 `start.cmd` 即可继续；启动脚本不会自动重启电脑。

获取项目后进入项目目录：

```bash
git clone https://github.com/Merak-Wang/CaseWeave.git
cd CaseWeave
```

在项目根目录运行：

**Windows PowerShell**

```powershell
.\start.cmd
```

**Linux / Git Bash**

```bash
bash setup.sh
```

首次运行会创建本地配置，引导选择 CPU/GPU、供应商和主模型，并准备应用、检索模型、示例数据及索引。模型密钥以隐藏方式输入。首次安装需要联网，耗时和磁盘占用取决于下载速度与所选模型。

安装完成后打开 [检索工作台](http://127.0.0.1:3080/retrieval)。如有安装中断，修复问题后再次运行同一启动入口，准备流程会校验并复用有效文件；也可用 `setup.cmd install` 或 `bash setup.sh install` 显式重新检查完整准备流程。

配置、端口、数据卷及排障方法见 [部署与运行](docs/DEVELOPMENT.md#一键容器部署)。

## 使用工作台

1. 输入业务问题，或点击首页示例后继续编辑。需要限定时间、地区或排除场景时，一并写明。
2. 查看持续形成的确认结果。需要了解判断依据时，打开工单详情或检索过程。
3. 在任务中补充条件，或对具体工单提交“相关 / 不相关”反馈，Agent 会复核受影响的判断。
4. 查看检索报告，下载当前版本的确认工单。未判定线索保留在检索过程中，不计入交付集合。

首页提供两个可直接尝试的示例：

| 场景 | 检索问题 |
| --- | --- |
| 主副卡业务 | 找主副卡有关工单 |
| 宽带故障 | 找宽带故障有关工单 |

侧栏底部的“模型与供应商”可管理模型配置。任务运行时可主动停止；停止会保留已有结果，并说明尚未完成的范围。

## 日常运行

| 操作 | Windows | Linux / Git Bash |
| --- | --- | --- |
| 构建更新并启动（首次自动初始化） | 双击 `start.cmd` | `bash setup.sh start` |
| 停止 | `setup.cmd stop` | `bash setup.sh stop` |
| 查看状态 | `setup.cmd status` | `bash setup.sh status` |
| 查看日志 | `setup.cmd logs` | `bash setup.sh logs` |
| 检查配置 | `setup.cmd --check` | `bash setup.sh --check` |
| 重新检查完整安装 | `setup.cmd install` | `bash setup.sh install` |

每次启动先准备 Docker，再构建应用、Python 算子和模型服务，Docker 自动复用未变化的构建层，再更新有变化的容器并等待健康检查。已有安装复用模型、索引和数据卷，不重新执行下载或索引准备。构建失败时停止部署，现有容器继续保留。电脑重启后直接运行 `start.cmd`。

仅需复用现有镜像时可显式运行 `start.cmd --no-build`。普通 `docker compose restart` 仍会运行原容器中的旧代码；源码更新使用启动入口即可。模型服务升级及回退见 [部署与运行](docs/DEVELOPMENT.md#mysql--milvus-与持久任务入口)。

## 数据与运行边界

默认示例数据由 [数据清单](data/manifest.json) 管理，准备后包含 19,587 条工单。该数据缺少日期、地区和状态字段，涉及这些条件时系统会保留未知；生成的摘要和类别也不能替代原文事实。数据来源、字段和准备方法见 [数据说明](data/README.md)。

系统对业务工单只读，任务、反馈、报告和 Wiki 使用独立持久化存储。模型请求会包含完成检索所需的查询及工单片段，部署时应选择适合数据使用范围的供应商。凭据通过本地配置或模型管理面板设置。

## 技术与文档

应用使用 TypeScript / Node.js 和 DSH 运行 Agent，以 MySQL 保存工单与任务状态、Milvus 承载向量检索，Python 模型服务提供查询分析与 embedding，浏览器工作台提供交互入口。

- [交互式产品介绍](docs/project-introduction.html)：下载后用浏览器打开，体验检索流程与证据分层示意。
- [文档目录](docs/README.md)：按使用、部署和技术主题查阅。
- [产品规格](docs/PRODUCT_REQUIREMENTS.md)：查询条件、确认结果与交付语义。
- [架构说明](docs/ARCHITECTURE.md)：组件职责、数据流和恢复机制。
- [开发与运行](docs/DEVELOPMENT.md)：配置、源码运行和检查命令。
- [业务 Wiki](wiki/README.md)：领域知识及其适用边界。
