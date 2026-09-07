# MioChat Channel Architecture v1.0（实施基线修订）

> 作者：高坂桐乃 ｜ 状态：**实施基线评审中**
> 日期：2026-08-31
> 范围：Channel 层的存储迁移、Trigger 系统引用、Prefix Cache 稳定化
> 前置：Trigger 系统 P1 已实现（`lib/triggers/`，含 WakeProtocol / TriggerRegistry / trigger_manage 工具 / slash 命令）；openai-image img2img 补丁已就位（待生效）

---

## 0. 三大改动总览

| # | 改动 | 核心收益 | 状态 |
|---|------|----------|------|
| A | **存储迁移**：会话消息从 JSON 文件 → Prisma/SQLite 块级存储 | 消除 O(n²) 写放大、双渠道并发丢更新、重启丢回复 | 设计完成 |
| B | **Trigger 系统**：事件驱动 LLM 唤醒（cron/script/webhook） | Agent 具备事件响应能力，不再仅靠定时轮询 | 文件版 P1 已实现，DB/安全待收口 |
| C | **Prefix Cache 实验**：稳定核心工具集 + 内部调度器 | 验证缓存成本与工具成功率的权衡 | 待 A/B spike |

三项使用独立 feature flag 分批上线；数据库迁移、Trigger 切换和工具路由不得绑定
为不可独立回滚的一次性发布。

---

## A. 存储迁移（JSON → Prisma/SQLite）

### A.1 现状痛点

| # | 痛点 | 严重度 |
|---|------|--------|
| 1 | 每条消息触发整个 session JSON 全量重写，O(n²) 写放大 | 🔴 |
| 2 | stringify/parse 同步操作阻塞事件循环 | 🔴 |
| 3 | web + wechat 双渠道实例并发读写同一 session JSON → 丢更新 | 🔴 |
| 4 | 回复未完成时重启 → assistantMsg 整条丢失 | 🟠 |
| 5 | crystal 单槽覆盖，历史结晶不可回溯 | 🟡 |
| 6 | global/*.md 的 update/delete 靠子串匹配 | 🟡 |

### A.2 权威设计与 Schema

Session Persistence 的权威设计移至
[`session-persistence.md`](./session-persistence.md)，可执行且经过校验的 schema spike
位于 [`session-persistence-schema.prisma`](./session-persistence-schema.prisma)。本文件
不再复制 Prisma 模型，也不再用固定表数量约束职责划分。

核心语义：

- `Message` 是一条完整逻辑消息，`content` 为权威 JSON；
- `MessageChunk` 是追加式流事件，不是独立聊天消息；
- `ToolCall` 是可重建的审计投影；
- 终止原因使用 Message status，不创建 `round_end` 伪消息；
- 结晶通过 `coversThroughSeq` 和 `archivedAt` 建立可回溯版本链。

### A.3 落盘节点

| # | 时机 | 动作 |
|---|------|------|
| 1 | 用户消息到达 | 事务内分配 seq 并 INSERT final user Message |
| 2 | LLM 启动前 | INSERT streaming assistant placeholder |
| 3 | 语义块 flush | APPEND MessageChunk + revision 乐观锁更新 Message |
| 4 | toolcall 开始/完成 | UPSERT ToolCall，并同步权威 Message.content |
| 5 | complete / abort / error | 更新 assistant 最终 content 与 status |
| 6 | 服务重启 | 将遗留 streaming 标记为 aborted_by_restart |
| 7 | 结晶完成 | INSERT Crystal + 标记被覆盖消息 archivedAt |

### A.4 并发安全

WAL 与 busy timeout 已由现有 PrismaManager 配置，只负责锁竞争。会话 seq 必须在
数据库事务内通过 `nextSeq` 原子分配；流式快照通过 `revision` 乐观锁防止旧 flush
覆盖新内容。进程内 FIFO 仅作为优化，不作为正确性前提。

### A.5 迁移与回滚

正常升级在重启 init 中从 `legacy` 直接切到 `database`；shadow 模式只保留作显式诊断。
所有 Agent、Channel、
session、archive、soul、global memory、meta、Trigger、Execution 和脚本引用都必须
进入 manifest 并逐源校验；任一源 blocked/failed 时不得切主。迁移器不重命名或
删除旧文件；迁移前快照作为回滚输入保留。

---

## B. Trigger 系统（Registry 数据库化已实现）

> 本节引用 `lib/triggers/` 的已有实现，不重复设计。详细设计见 `docs/architecture/trigger-system.md`。

- **唤醒协议**：向绑定 session 追加 user 消息（首行 `system：trigger 系统监测到事件...`），身份随 session，LLM 无关
- **脚本契约**：stdout `@WAKE@ {json}` 标志行，语言不限
- **生命周期**：once（唤醒即删）/ persistent（长期运行）
- **管理工具**：`sentinel`（create/update/list/remove/enable/disable/run/logs）+ `/triggers` slash 命令
- **当前存储**：JSON 文件；DB adapter、软删除与审计外键语义待实施

---

## C. Prefix Cache 实验

### C.1 问题

工具 schema 可能占用较多输入 token，且工具注册、启停和 hash 变化可能缩短可复用
前缀。但当前文档没有真实基线，不能预先断言缓存成本、命中率或工具选择精度。

### C.2 候选方案：稳定核心工具集 + mio_meta

实验组注入一个小型、版本化的核心工具集，其余低风险能力通过调度器发现和调用。
核心集合并非“永不变化”，任何 schema 变更都必须显式版本化并重新测量。

```
候选核心工具列表：
  ├── mio_meta               ← 万能调度器（{tool, params} → 路由到任意已注册工具）
  ├── bash                   ← 终端
  ├── read / write           ← 文件读写
  ├── memory                 ← 记忆 CRUD
  ├── search                 ← 搜索
  ├── Skill                  ← 技能按需加载
  └── cron                   ← 定时任务

具体工具数和 token 数以运行时序列化结果为准。
```

**mio_meta 内部逻辑**：
1. 接收 `{tool: string, params: object}`
2. 从 allowlist 和内部工具注册表解析目标
3. 获取目标参数 schema 并校验
4. 直接调用现有 `runTool(toolCall, user, parentEvent)`
5. 保留 adminOnly/channelOnly、审批、超时和 hook 上下文

禁止通过 `/api/plugins/:pluginName/tools/:toolName/debug` 调度。该端点面向管理员调试，
其身份和执行路径不适合作为 LLM 运行时权限边界。

### C.3 A/B 指标

| 指标 | 采集方式 |
|------|----------|
| 工具 schema token | 记录最终序列化请求的工具部分 token |
| cache hit/miss | 使用现有 LLMCallLog 的 cacheHitTokens/cacheMissTokens |
| 工具一次成功率 | 首次调用参数合法且任务成功的比例 |
| 额外模型轮次 | 因发现 schema、参数纠错或重试增加的调用数 |
| 端到端成本/延迟 | 按完整任务比较，而不是只比较首个请求 |

### C.4 配套措施

- **能力发现**：提供固定摘要和按需 schema 查询，避免把所有动态工具名写入固定前缀
- **工具可见性**：如需新增 `webOnly`，必须与现有 `channelOnly` 分开定义并在装配与执行两侧同时校验
- **权限**：mio_meta 默认只路由 allowlist；高危或交互式工具继续直接暴露或禁止代理
- **回滚**：通过独立 feature flag 恢复现有全量工具装配

### C.5 风险与缓解

| 风险 | 缓解 |
|------|------|
| LLM 不知道 mio_meta 能调什么 | 固定能力摘要 + 按需 schema discovery |
| 参数 schema 缺失导致额外轮次 | 对高频工具保留直接 schema，按任务集测量 |
| 代理绕过权限与审批 | 只调用内部 runTool 并传递原 parentEvent |
| 万能代理扩大攻击面 | allowlist、审计、递归调用禁止、结果大小限制 |

---

## D. 实施计划

### Phase 1：设计与 Schema Spike（当前）
1. 独立 Session Persistence 文档
2. 可执行 Prisma schema 与关系校验
3. 明确消息/块、删除、并发和迁移语义
4. 建立验收标准与 feature flag 切换方案

### Phase 2：Session Persistence 实现（预估 3–5 工程日）
1. SessionPersistence 服务与兼容 facade
2. BaseChannel/llm.js 生命周期接入
3. 幂等迁移、shadow 比对与回滚
4. 并发、崩溃恢复和结晶测试

### Phase 3：Prefix Cache 实验（预估 1–2 工程日）
1. 调度器直接复用内部 `runTool()`，禁止调用 debug HTTP endpoint
2. 从低风险 allowlist 开始，不默认暴露任意工具
3. 对比 cache tokens、工具成功率、额外调用轮次和总成本

### Phase 4：Trigger 系统增强（预估 1–2 工程日）
1. TriggerExecution 表与存储层对接
2. idleOnly 标志（防止任务中途触发维护类事件）
3. 哨兵脚本目录迁移到 channels-data/triggers/scripts/
4. 桐乃自建哨兵（78,400 盯盘）

### 发布策略

Schema 可随版本部署，但 Session、Trigger 和 Prefix Cache 分别由独立 feature flag
切换。每一步必须能回到上一存储/路由模式。

---

## E. 决策记录

| # | 决策 | 日期 |
|---|------|------|
| D1 | 唤醒身份随 session | 8/31 |
| D2 | 脚本语言不限，stdout 契约 | 8/31 |
| D3 | Trigger 表进 app.db | 8/31 |
| D4 | webhook P2 | 8/31 |
| D5 | 会话消息 Prisma/SQLite 块级 | 8/31 |
| D6 | 稳定核心工具集 + mio_meta 先走 allowlist A/B 实验 | 8/31 |
| D7 | 工具可见性需要独立的 webOnly/channelOnly 双向执行校验 | 8/31 |
| D8 | 所有存量实例全量迁移并逐源验证，不遗留文件态孤岛 | 9/1 |
