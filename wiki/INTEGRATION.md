# 文件 Wiki 调用契约

命令端口：[scripts/wiki-store.mjs](../scripts/wiki-store.mjs)，专家共用 [只读实现](../packages/agent-plugin/src/wiki-store.js)，文件修改与后台学习共用 [发布实现](../packages/agent-plugin/src/wiki-publisher.js)。阅读器使用 Node.js 内置库，无数据库、网络、模型调用或原库权限。DSH 主 Agent 在快查后获得领域目录；专家按分派接收固定 release 下至多 3 条知识，具体正文与引用进入角色 ContextManifest。自动学习机制见 [知识设计](../docs/design/KNOWLEDGE.md)，对照方法见 [评测策略](../docs/EVALUATION_STRATEGY.md)。

## 公共命令

在项目根目录运行：

```powershell
node scripts/wiki-store.mjs verify
node scripts/wiki-store.mjs catalog
node scripts/wiki-store.mjs search --query "副卡和跨域相关工单" --phase post-fast-query
node scripts/wiki-store.mjs search --query "副卡和跨域相关工单" --domain primary-secondary-card --phase post-fast-query
node scripts/wiki-store.mjs read --id primary-secondary-card-cross-domain
node scripts/wiki-store.mjs search --query "副卡和跨域相关工单" --phase first-pass
node --test scripts/wiki-store.spec.mjs
python scripts/wiki-build.spec.py
python scripts/verify-wiki-artifacts.py
```

最后一个 search 返回空数组：首轮快查不得利用 Wiki 语义扩写。此处是知识搜索端口的阶段约束，调用方仍需保证首轮不直接调用 read 或另行注入知识。

`verify-wiki-artifacts.py` 将可读 Markdown 与 `curation.json` 指定的离线发布版本比对，并通过运行时读取器独立验证当前发布。文件增量与自动学习条目不需要生成离线 Markdown 副本。报告分别列出离线 `releaseId` 和当前 `runtimeReleaseId`；当前发布损坏或只能回退时检查失败。`--private` 额外核对离线来源绑定，私有路径不写入输出。

## 导入端口

```javascript
import { openWiki } from './scripts/wiki-store.mjs'

// 每任务打开一次，持有固定 release；根目录由可信宿主配置。
const wiki = await openWiki(configuredPublishedWikiRoot)
const domains = wiki.catalog()
const hints = wiki.search(userQuery, { phase: 'post-fast-query', limit: 8 })
const scopedHints = wiki.search(userQuery, { phase: 'post-fast-query', domainIds: selectedDomainIds })
const entry = wiki.read(selectedKnowledgeId)
// 将 entry.reference、releaseId、实际可见正文记入任务 ContextManifest。
// entry 作为数据块，不能拼接为 system 指令或赋予工具权限。
```

`catalog()` 只返回领域 ID、说明与条目引用。`search()` 为可替换的关键词导航，匹配数不是相关性分数；例如“跨域”可能同时找到副卡和发票条目，Agent 必须依据领域和问题选择，不能全部灌入上下文。`read()` 仅接受清单中的条目 ID。所有返回值复制后交给调用方，不允许调用方改写已加载的发布快照。

稳定引用形如 `wiki:enterprise-retrieval-v2:primary-secondary-card-cross-domain@2`。任务持久化 releaseId；回放可用 `openWiki(root, { releaseId })` 读取对应不可变 release。无指定版本的缺库返回空目录，允许零样本继续；当前发布损坏时尝试上一完整发布并带 warning，没有可用历史则抛错。指定 release 不可用时明确拒绝，不以新内容冒充旧引用。

## 文件修改与发布

通过结构化文件编辑正文和范围，运行发布命令后，后续任务才会读取新版本：

```powershell
node scripts/wiki-store.mjs checkout --id esim-forms --out .tmp/esim-edit.json
# 编辑该 JSON 中 changes[0].entry 的 bodyMarkdown、scope、evidenceChecklist、limitations 等。
node scripts/wiki-store.mjs publish --delta .tmp/esim-edit.json
node scripts/wiki-store.mjs verify
node scripts/wiki-store.mjs rollback --release enterprise-retrieval-v2
```

输出目录需存在；checkout 不覆盖已有草稿。草稿携带 baseRelease；publish 自动递增条目版本、校验内容/引用、合并不同条目修改并原子发布，同条及被替代条目的过时修改会报 conflict。可用 `operation: deactivate` 与条目 id 停用错误知识，不附 entry。清单 `retired` 保留停用身份、版本和替代关系，正文退出当前目录，恢复时版本继续递增。以上命令支持 `--wiki` 指定隔离 Wiki。回退生成新发布并保留历史，不改写旧文件。运行时模型只能提交受限条目内容，不能调用这些 CLI 或写任意文件。

数据库 profile 默认从复核结果排入持久学习作业，独立 DSH 提炼/校验通过后自动发布，无人工审批；公开任务快照的 learning 字段提供排队/运行/发布/跳过/拒绝/失败状态。新任务的目录和实际专家请求会消费新条目，已开始的任务固定自己的 release。`RETRIEVAL_AGENT_WIKI_LEARNING=0` 可用于冻结 Wiki 对照，读取仍正常；无 Wiki 对照使用不存在的独立根目录并关闭学习。两者是实验配置，不把生产自动发布改为人工步骤。

含私有来源元数据的旧格式不进入运行时读取窗口。停用的旧版本应显式记录无法加载的原因，不能用最新正文冒充旧引用。

## 数据与权限

v2 发布 JSON 包含 `schemaVersion/id/revision/domain/kind/scope/bodyMarkdown/evidenceChecklist/limitations/status/supersedes` 等字段。正文清单和知识元数据共同构成该版本。`sourceRefs`、来源路径、原始文件哈希和行号只保存在库外私有区；读取器拒绝带旧来源字段的条目。原始出处通过 releaseId、知识 ID、revision 和发布文件哈希在私有台账中关联。

`expert.json` 是后续 DSH 专家装配的参考配置，`toolGrants` 为空，不提供 prompt 覆盖。它目前不是可执行 Agent 或 DSH 已识别的注册文件。实际加载器只消费 release manifest 和 entry JSON，避免运行时自行读取可修改的专家指令文件。

## 本地重建

```powershell
# 以下变量由本地管理员设置，具体保密路径不写进仓库。
python scripts/wiki-intake.py --source $env:WIKI_SOURCE_ROOT --private $env:WIKI_PRIVATE_ROOT
python scripts/build-retrieval-wiki.py --source $env:WIKI_SOURCE_ROOT --private $env:WIKI_PRIVATE_ROOT
node scripts/wiki-store.mjs verify
```

私有根目录中需要已有 `source-inventory.json` 以及 `provenance/curation-sources.json`。后者以知识 ID 记录所用来源与行段；缺失时构建失败，不从脱敏正文伪造出处。私有 `provenance/<release>/entries/` 为每条记录来源、版本、发布哈希和各类内容的证据身份，术语解释与构造示例不冒充原始案例。

相同输入可重复构建；相同 releaseId 的不同正文或不同私有来源记录均被拒绝。离线编译器用于初始企业材料提炼，当前指针若已进入后续发布则拒绝覆盖；最终指针切换也使用共享发布锁。初始发布之后的文件改动通过上方 checkout/publish 端口，自动学习复用同一增量发布器。基线条目 revision 为 2，后续修改自动递增。

上线接线验收仍应证明：快查后实际模型收到指定条目 → 引用进入 ContextManifest → 条件修订后重新检查先验适用性 → 没有匹配知识仍可继续；真实检索质量另用同数据、同模型的无 Wiki / 固定 Wiki 对照验证。
