# 工单检索业务 Wiki

业务 Wiki 为工单查询 Agent 提供领域概念、歧义说明和取证方向，在快查后按任务需要读取。知识有明确适用范围，可以被当前证据否定，不替代工单事实。

随仓库提供的导入基线是 `enterprise-retrieval-v2`，17 个领域、38 个条目。当前实际发布以 [current.json](current.json) 和 `node scripts/wiki-store.mjs catalog` 为准：文件修改或后台学习会生成后续版本。导入正文解释专有名词与业务对象、业务关系、典型场景、证据的判断作用、适用边界及具体反例。场景均明确标为解释性示例，不冒充真实工单。来源路径、来源 ID、原文件哈希和行段集中在仓库外的私有来源目录管理，不进入正文、编辑文件、发布 JSON 或 Git。文件发布与自动学习的调用方式见 [接入说明](INTEGRATION.md)。

这些知识是有适用范围的参考，不能替代工单证据、不能扩大用户条件，也不证明已独立核验当前企业政策。条目覆盖范围以领域目录与各条目声明为准。

## 按领域阅读

| 知识库 | 主要用途 |
| --- | --- |
| [主副卡与跨域](domains/primary-secondary-card/index.md) | 跨域歧义、名额占用、关联停机 |
| [融合业务与返销](domains/convergence/index.md) | 群组关系、变更取消、二次业务、权益恢复 |
| [eSIM 与一号双终端](domains/esim/index.md) | 独立号与共享号、激活、补换卡、销户边界 |
| [携号转网](domains/portability/index.md) | 携入携出方向、交互与订单状态 |
| [宽带包年](domains/broadband/index.md) | 到期续费、转包月、预约资费冲突 |
| [自动顺延](domains/renewal/index.md) | 固网与移网差异、通知和生效 |
| [销户与复装](domains/cancellation/index.md) | 预约、正式销户、复机和权益恢复 |
| [过户](domains/ownership-transfer/index.md) | 客户与账户、单成员范围、合约继承 |
| [靓号](domains/prestige-number/index.md) | 预存、低消、协议期及退出费用 |
| [费用争议](domains/fees/index.md) | 费用类型、应收与实收、取消与返销 |
| [发票与收据](domains/invoices/index.md) | 可开票额度、数电票版本、跨域和票据类型 |
| [实名与服务受限](domains/identity-service-status/index.md) | 非实名与风险限制、申请与最终复通 |
| [业务权限故障](domains/business-access/index.md) | 菜单、按钮、业务范围的差别 |
| [无纸化与受理单](domains/paperless/index.md) | 单据种类、签署、查无结果及状态 |
| [套餐变更与降档](domains/package-change/index.md) | 受理阶段、预估费用与实际出账 |
| [渠道佣金支撑](domains/channel-incentives/index.md) | 计算与到账、奖励规则、首充与累充；仅明确相关任务使用 |
| [通用取证](domains/cross-domain-evidence/index.md) | 同码不同因、在途与历史状态 |

## 文件职责

```text
wiki/
  README.md                     阅读入口
  SECURITY.md                   脱敏与隔离边界
  INTEGRATION.md                调用契约与命令
  curation.json                 脱敏知识内容；包含术语、场景、证据与反例，不含来源映射
  domains/<domain>/
    expert.json                 专家参考配置；不授予工具权限
    index.md                    领域目录
    concepts/*.md               生成的可读 Wiki
  release-report.json           发布规模与验证范围，不含原库盘点明细
  releases/<release>/
    manifest.json               发布清单与各条目哈希
    entries/*.json              不可变正文、知识元数据与边界，不含原始来源信息
  current.json                  当前发布指针
```

私有区通过 `--private` 由本地管理员提供，其中 `provenance/README.md` 按领域导航，`source-catalog.json` 管理来源文件，`curation-sources.json` 管理编辑映射，`<release>/entries/<knowledge-id>.json` 保存逐条追溯。知识 ID、revision 和发布内容哈希将来源与脱敏正文关联。具体原库位置只保存在私有区。私有区必须位于项目仓库之外；运行端不访问此区。

文件加载器只读取发布指针及指定发布目录，不递归遍历原库、私有区或可编辑正文。正文复制到 release 后才成为模型可读内容，编辑可读 Markdown 本身不会改变已固定的任务版本。维护时修改 `curation.json`，选择新 releaseId，再运行构建与校验；原始资料变化需重新盘点并重新审阅有关条目。

读取器拒绝包含私有来源字段的旧格式条目；不能将来源审计文件挂载为运行时知识库。

DSH 主 Agent 在快查后读取领域目录，专家按分派获取固定版本知识，实际可见条目进入 ContextManifest。数据库任务支持从复核结果自动学习并发布知识增量。知识是否改善检索效果，需要使用相同数据和模型进行对照评估。
