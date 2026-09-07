# MioChat Trigger Architecture v0.5

> 状态：Registry 数据库化与长驻哨兵进程已实现；脚本按 AdminOnly 受信任代码运行
> 日期：2026-08-31
> 依赖：[`session-persistence.md`](./session-persistence.md)
> 可执行 schema：[`session-persistence-schema.prisma`](./session-persistence-schema.prisma)

## 1. 目标与边界

Trigger 把“事件 → 唤醒指定 Channel 会话”定义为系统原语，统一支持 cron、script
和后续 webhook。唤醒仍通过向目标 session 追加一条带明确系统标记的 user 消息并
进入 `_processChat`，不引入特殊 LLM 身份。

当前已实现：

- `TriggerRegistry` Prisma CRUD、软删除与执行审计；
- `TriggerRunner` 长驻子进程、PID 生命周期和 stdout `@WAKE@` 协议；
- `WakeInjector` 冷却、日限额和会话注入；
- `sentinel` 与 `/triggers`；
- cron 仅负责纯时间任务；sentinel 脚本自行循环/等待条件。

仍待实现：

- payload 白名单、长度上限和全局熔断；
- webhook。

## 2. 分层

```text
lib/triggers/
  TriggerRegistry.js   Trigger 与 Execution 的存储接口
  TriggerRunner.js     script 子进程与 @WAKE@ 解析
  WakeInjector.js      限频、目标解析、消息注入
  WakeProtocol.js      stdout 协议
channels/triggers/
  index.js             挂载 ChannelRuntime
  webhook/             P2
lib/chat/persistence/
  SessionPersistence.js
```

`TriggerRegistry` 保持现有公开方法，因此工具层和 SlashHandler 无需感知存储切换。
正常 `database` 模式只写 Prisma；脚本正文仍是文件资产。

## 3. Schema 与删除语义

Trigger 与 Session 共用一套关系图。权威 schema 位于
`session-persistence-schema.prisma`，本文件不复制模型，也不再用固定表数量约束
职责划分。

删除规则：

- once 唤醒成功后设置 `Trigger.deletedAt`，不物理删除；
- 所有默认查询排除 `deletedAt IS NOT NULL`；
- `TriggerExecution` 保存不可变 `triggerKey`，`triggerId` 为可空外键；
- 后台清理 Trigger 时 `TriggerExecution.triggerId` 置空，审计仍可按 triggerKey 查询；
- Channel/Session 删除时目标外键置空，并由服务事务性 disable Trigger；
- Trigger 不得级联删除 Execution。

## 4. 唤醒协议

脚本在 stdout 输出一行：

```text
@WAKE@ {"wake":true,"reason":"...","data":{}}
```

允许字段只有：

- `wake`: boolean，必需；
- `reason`: string，最大 2 KiB；
- `data`: JSON object，序列化后最大 16 KiB；
- `source`: string，可选，最大 128 字符；
- `firedAt`: ISO datetime，可选。

未知字段丢弃。非法 JSON、超限 payload 或非 object data 都只记录失败审计，不进入
LLM prompt。

每个脚本必须实现两个一级运行参数：`test` 和 `loop`。缺少参数或参数不是这两个
值时，脚本必须立即以非零码退出。`test` 只做一次快速可用性检查并退出；后台启动
只传 `loop`，由脚本自行循环、等待和重试。系统的 `sentinel(action="run")` 只传
`test`，不会用调试模式启动后台循环。

标准流程：

1. 加载未删除且 enabled 的 Trigger，并启动对应的长驻 script 子进程；
2. 脚本自行循环/等待条件，在 stdout 输出一条 `@WAKE@`；
3. 检查 trigger 冷却和日预算；
4. 校验并规范化 payload；
5. 精确查找 `channelId + agentId` 对应的运行实例；
6. 插值 promptTemplate；
7. 通过 SessionPersistence 立即落盘 user 消息，再进入 Channel session FIFO；
8. 写 TriggerExecution；
9. 停止当前脚本进程；persistent 重新拉起，once 设置 deletedAt。

任何一步失败都必须记录 Execution，且不得 fallback 到任意 Channel。

## 5. 目标路由

Trigger 创建时必须绑定 `agentId`，正常情况下同时绑定 `channelId` 和 `sessionId`。

- `channelId` 缺失：只允许迁移期旧数据，自动 disable 并要求重新绑定；
- `sessionId` 缺失：创建时可解析 agent active session 并将结果固化，运行时不动态漂移；
- Channel 未运行：记录 `target_unavailable`，不选择第一个 active channel，并停止/禁用
  当前哨兵，待 Channel 恢复后由用户重新 enable；
- Session 不属于 Agent：记录 `target_mismatch` 并 disable Trigger。

## 6. 进程生命周期与主进程退出

当前实现使用 Node.js `child_process.spawn()`，不是 `exec()`。后台哨兵以独立进程组
启动，主进程在停止、删除、禁用和正常退出时同步终止对应进程组，并在运行态记录
PID、启动时间、最近退出和错误状态。

操作系统不会在 Node 主进程被 `SIGKILL` 强杀、机器断电或内核崩溃时替主进程执行
清理，因此这种极端情况下不能保证子进程自动停止；脚本自身也应做好父进程失联后
的退出策略。

## 7. 生命周期与计数

区分两个计数：

- `fireCount`：脚本/cron 实际执行次数；
- `wakeCount`：通过限频并成功注入会话的次数。

冷却依据最近一次成功 wake，而不是脚本执行。日预算按 Execution 的成功 wake 统计，
不能只加载最近固定 100 条后推断。

once 仅在消息成功落盘并进入处理队列后软删除。注入失败时保留 enabled 状态，由
冷却和重试策略处理。

## 8. Script 安全

子进程不是安全沙箱。`sentinel` 当前为 AdminOnly 工具，脚本按受信任的本地管理员
代码运行，以兼容 OpenCV、Python 虚拟环境和其他本地工具链；普通 `spawn()` 不应
被描述为不受信任代码隔离。

主进程仍限制 stdout/stderr 的单次缓存，并在收到第一条有效 `@WAKE@` 后停止当前
进程。脚本的内部循环没有固定超时；`sentinel(action="run")` 的调试试跑仍使用
短超时。

## 9. Webhook（P2）

```text
POST /channels/:channelId/triggers/:triggerId/hook
```

要求：secret 只存 hash、恒定时间比较、请求体大小限制、来源频控、payload 走同一
白名单。Webhook 只允许发起 wake，不能直接执行工具、Shell 或重启服务。

## 10. 数据迁移

从 `channels-data/triggers/triggers.json` 与 `executions.json` 导入：

- 使用稳定 id 保持 Trigger 主键；
- params/data 规范化为 JSON string；
- 旧 webhookSecret 明文不得直接写入新表，应 hash 后导入；
- 缺 channelId 的旧记录仍按 agent/session 路由语义保留 enabled 状态；精确 channel
  路由实施后再要求重新绑定；
- Execution 写 triggerKey 和原始 legacyJson，即使对应 Trigger 已不存在也可作为
  `triggerId=NULL` 的孤儿审计导入；
- `scripts/` 下的脚本进入 manifest 并校验 hash、权限、realpath 和 Trigger 引用，
  脚本正文继续由文件系统承载；
- 迁移账本复用 `LegacyMigration`，逐文件记录 hash 和状态；
- 自动迁移验证完成后直接使用 DB 权威数据，旧 JSON 只读保留。

## 11. 与 Session Persistence 的关系

Trigger 不自行拼装或写 session JSON。WakeInjector 调用 Channel 的统一注入入口，
底层由 SessionPersistence 完成 user Message 落盘和 assistant placeholder 创建。

TriggerExecution 与 Message 不建立强外键。审计记录保存 `sessionId` 与注入产生的
`messageId` 快照即可，避免删除聊天历史时破坏系统审计。

## 12. 验收标准

- 现有 WakeProtocol/Registry/Runner/Injector/tool 测试在 DB adapter 下继续通过；
- once 唤醒后 list 不可见，但 Execution 可查询；
- 已注册哨兵可通过 `sentinel(action="update")` 修改参数、提示模板、冷却和脚本路径；
  修改 `params`、`sessionId`、`mode` 或 `scriptPath` 时会重启进程以刷新启动环境；
- 删除 Trigger、Channel 或 Session 后历史 Execution 仍存在；
- 两个运行 Channel 属于不同 agent 时，永不发生 fallback 误投；
- payload 超限、脚本异常、超时、日预算和全局预算均有审计；
- 同一 Trigger 并发触发只允许一个请求越过冷却；
- persistent 哨兵每次唤醒后只有一个活动 PID，停止/禁用/删除不会遗留子进程；
- 迁移脚本重复执行不产生重复 Trigger 或 Execution。

## 13. 分期

- P1.1：Registry DB adapter、迁移与软删除（已完成）；精确路由待收口；
- P1.2：payload/环境/并发安全收口；脚本路径按 AdminOnly 受信任代码处理；
- P2：webhook；
- P3：管理面板和统计。

Trigger DB 化可跟随 Session schema 发布，但通过独立 feature flag 切换，不与
Prefix Cache 或 `mio_meta` 绑定上线。
