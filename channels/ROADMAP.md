# Channels 渠道体系 — 后续开发计划（ROADMAP）

> 状态：2026-08 生成。基于 M0–M6 已落地，规划剩余工作与发布路径。
> 覆盖：WeChat iLink 首个外部渠道（当前焦点）+ 多渠道抽象的未来扩展。

---

## 一、当前进度（已完成，尚未推远程）

| 里程碑 | 内容 | 测试 |
|--------|------|------|
| **M0** | `channels/` 骨架 + OneBots 嵌入式网关（登录/轮询/收发/typing/notify）| 5/5 |
| **M1** | **MemoryStore 记忆层**（soul.md / global 长期记忆 / sessions+结晶 / active）| 8/8 |
| **M2** | **OneBotChannel 核心**（事件订阅 / 单用户 admin / slash 会话路由 / 聚合回复 / typing）| 6 场景 |
| **M3** | **灵魂引导**（无 soul → 开放引导 → 提炼 soulDraft → 写 soul.md）| +1 |
| **E2E** | 真实 HTTP mock iLink + 真组件全链路测试；buildSendMsg 双重 msg 真 bug 修复 | 全 34/34 |
| **M5** | **保活**（24h 窗口、到期前固定文案提醒、防重复；`meta.last_user_activity`）| ✅ |
| **M6** | **管理面**：ChannelStore + ChannelRuntime + `/api/channels` 管理 API + 前端 `ChannelManagerView`（添加/扫码/绑定/编辑/启停/删除）| 后端 34/34；前端 build ✅ |

**已知边界**：对话当前为 **echo**（`createBackendLlm` 占位，未接真实 miochat LLM）。

---

## 二、后续计划（按优先级 P0 / P1 / P2）

### P0 — 打通可运行闭环（目标：一个真 AI 的微信助手）

| # | 项 | 内容 | 验收 |
|---|----|------|------|
| 1 | **M4｜真实 LLM 接入** | `createBackendLlm` 接 `lib/chat/llm`：用 `soul + global 长期记忆 + session chat` 组装 messages，走 adapter/结晶 | 微信发消息 → **真实 AI 回复** |
| 2 | **结晶接入** | 对接 `CrystallizationService`：超水位结晶 → 更新 `session.crystal` + 沉淀 `longterm.md`；`/context /memory` 读真实数据 | 微信聊久后能"记住" |
| 3 | **真机联调（M7）** | iOS 微信实际扫码绑定 ClawBot → 收发消息 → 验证保活 | 真实微信账号全链路可用 |
| 4 | **M1.5｜媒体收发** | 图片/语音/文件：`getuploadurl` CDN + AES-128-ECB + 转码；`MessageItemType` 图/音/文件处理 | 微信发图→AI（echo/LLM）看到并回图 |

### P1 — 渠道体系成熟

| # | 项 | 内容 |
|---|----|------|
| 5 | **渠道抽象固化** | 把 `channels/` 分层（OneBots 协议层 / Channel 会话层 / Memory 记忆层 / ChannelStore+Runtime 管理层）写成架构文档，作为新渠道模板 |
| 6 | **第二渠道打样** | 提议：飞书 `lark`（官方 openclaw-lark 可参考）或 Telegram——**用同一条抽象跑通第二个渠道**，验证抽象复用而非重写 |
| 7 | **管理面增强** | 多账号；保活状态/到期倒计时展示；二维码有效期 UI；运行时失败重试状态 |

### P2 — 发布与运维

| # | 项 | 内容 |
|---|----|------|
| 8 | **推远程 + 同步 production** | 后端 master + 前端 master → production（当前 14 提交未推）|
| 9 | **后端启动集成** | ChannelRuntime 随服务启停自动加载已绑定渠道（init 时 start 所有 status=running）|
| 10 | **部署/监控** | PM2 配置、日志、断线重试监控 |
| 11 | **与 memory 工具打通** | 微信渠道的 global 长期记忆与 `memory 工具 scope:'global'` 统一（决策：复用统一机制）|

---

## 三、关键待决策/风险

1. **真实 LLM 接入方式**（P0-1）：走 `VirtualLLMClient` 同款 client 对象（渠道无关），还是直接调 adapter 单次 chat？→ 倾向复用 VirtualLLMClient 范式，保持渠道无关。
2. **iLink 可行性风险**：仅 iOS 微信；一账号一 bot；依赖 24h 保活；协议无官方文档（字段来自官方插件逆向，可能有版本漂移）→ M7 真机验证兜底。
3. **多账号**：一个账号只占一个 bot 实例，多账号需各自扫码绑定（ChannelStore 天然支持多 channel）。

---

## 四、建议执行顺序（短期冲刺）

1. **M4 真实 LLM**（让对话变真 AI）→ 2. **真机联调**（扫码绑定实际上手）→ 3. **媒体** →
4. **推远程 + 同步 production** → 5. **第二渠道打样**（验证抽象）→ 6. 发布/运维收尾。

> 每一步仍遵循：mock 单测 / 集成测试先行 → 本地提交 → review 后再推。
