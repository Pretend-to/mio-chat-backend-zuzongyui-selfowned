---
name: trigger-sentinel-author
description: 掌握 MioChat 后台条件哨兵（Sentinel）编写与部署技能。当用户需要对行情走势、价格突破、指标异常、系统状态、文件变更或外部事件进行后台自动巡逻并在条件达成时唤醒 Agent 时使用。
---

# Trigger 哨兵与后台事件监控专家 (Trigger Sentinel Author)

本技能指导 AI Agent（如桐乃及其他助手）掌握 MioChat 核心 Sentinel 系统的设计哲学，并使用 `sentinel` 工具自主编写、部署和管理后台条件监控哨兵。

---

## 1. 核心设计哲学与唤醒机制

Sentinel 系统的核心使命是：**让 Agent 拥有在后台自主监控并随时“带着证据醒来”的能力**。

### 核心铁律与角色区分
1. **`sentinel` vs `cron` 的绝对界限**：
   - **`sentinel`（条件监控探针）**：平时在后台静默跑脚本，**零 Token 消耗**；仅当外部条件满足并在 stdout 输出 `@WAKE@` 时，才将证据注入会话唤醒 Agent。
   - **`cron`（纯时间闹钟）**：无外部条件，到点直接触发 LLM 回复。**严禁使用 cron 轮询监控外部状态！**
2. **唤醒 = 向绑定会话追加一条标准的系统事件注入消息**；
3. **身份随 Session**：唤醒消息注入哪个会话，就由该会话绑定的 Agent 自然接收并处理。

---

## 2. 标准两步工作流（铁律）

创建哨兵时，**必须严格执行以下两步流**，严禁在工具参数中直接塞大段代码：

### 第一步：编写独立的巡检脚本文件并落盘
使用文件工具在 `channels-data/triggers/scripts/` 目录下创建脚本文件（如 `btc_watcher.js`）。
* **动态参数读取**：脚本运行时的上下文参数必须通过 `process.env.TRIGGER_PARAMS` 读取解析（JSON 格式），实现脚本逻辑与阈值配置解耦。
* **`@WAKE@` 标准契约**：满足唤醒条件时，脚本最后一行必须输出：
  ```text
   @WAKE@ {"wake": true, "reason": "【事件原因描述】", "data": { ...关键证据与明细... }}
  ```

脚本应在自身进程内完成循环、等待、重试和资源清理；检测到条件后输出一条
`@WAKE@` 并退出。`sentinel` 会记录 PID，收到唤醒后停止当前进程；`persistent`
模式会重新启动脚本继续监听，`once` 模式则结束生命周期。

所有哨兵脚本都必须读取第一个运行参数：

- `test`：只执行一次快速检查并退出，用于 `sentinel(action="run")` 验证脚本可用性和回显结果；
- `loop`：正式后台运行，脚本自行循环/等待条件；
- 缺少参数或参数不是 `test`/`loop`：必须立即报错并以非零码退出。

系统启动后台哨兵时只会传入 `loop`，调试试跑只会传入 `test`。不要把运行参数
放到 `TRIGGER_PARAMS` 中，也不要让脚本在没有运行参数时默认进入后台循环。

#### Node.js 编写范例（推荐，原生支持 fetch 与 process.env）
```javascript
// channels-data/triggers/scripts/btc_watcher.js
const runMode = process.argv[2];
if (runMode !== 'test' && runMode !== 'loop') {
  console.error('usage: btc_watcher.js test|loop');
  process.exit(64);
}

const params = JSON.parse(process.env.TRIGGER_PARAMS || '{}');
const targetPrice = params.targetPrice || 80000;
const symbol = params.symbol || 'BTCUSDT';

async function checkOnce() {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    const data = await res.json();
    const currentPrice = parseFloat(data.price);

    if (currentPrice >= targetPrice) {
      console.log('@WAKE@ ' + JSON.stringify({
        wake: true,
        reason: `${symbol} 当前价格 ${currentPrice} 已突破预设警戒线 ${targetPrice}!`,
        data: { currentPrice, targetPrice, timestamp: Date.now() }
      }));
      return true;
    }
    console.log(`[巡检正常] ${symbol} 当前价格 ${currentPrice}，未达到目标 ${targetPrice}`);
    return false;
  } catch (err) {
    console.error('[巡检异常]', err.message);
    return false;
  }
}

if (runMode === 'test') {
  await checkOnce();
  process.exit(0);
}

while (true) {
  if (await checkOnce()) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
}
```

#### Python 编写范例
```python
# channels-data/triggers/scripts/btc_watcher.py
import os, sys, json, time, urllib.request

run_mode = sys.argv[1] if len(sys.argv) > 1 else None
if run_mode not in ("test", "loop"):
    print("usage: btc_watcher.py test|loop", file=sys.stderr)
    sys.exit(64)

params = json.loads(os.environ.get('TRIGGER_PARAMS', '{}'))
target = params.get('targetPrice', 80000)

def check_once():
    req = urllib.request.Request('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
        price = float(data['price'])
        if price >= target:
            print('@WAKE@ ' + json.dumps({
                "wake": True,
                "reason": f"BTC 价格突破警戒线: {price}",
                "data": {"price": price, "target": target}
            }), flush=True)
            return True
        print(f"当前价格 {price}，未达标", flush=True)
        return False

if run_mode == "test":
    check_once()
else:
    while True:
        if check_once():
            sys.exit(0)
        time.sleep(300)
```

#### Bash 参数入口
```bash
#!/usr/bin/env bash
set -euo pipefail

case "${1-}" in
  test|loop) ;;
  *) echo "usage: watcher.sh test|loop" >&2; exit 64 ;;
esac

check_once() {
  # ...执行一次检查...
  # 满足条件时输出一条 @WAKE@，然后 return 0；否则 return 1。
}

if [[ "$1" == "test" ]]; then
  check_once || true
  exit 0
fi
while true; do
  check_once && exit 0
  sleep 300
done
```

---

### 第二步：调用 `sentinel` 工具启动监控
脚本落盘后，调用 `sentinel(action="create", ...)` 注册并激活探针：

```json5
sentinel({
  action: "create",
  id: "btc_price_alert",
  scriptPath: "channels-data/triggers/scripts/btc_watcher.js",
  params: {
    targetPrice: 80000,
    symbol: "BTCUSDT"
  },
  mode: "once",            // 突破提醒一次后自动销毁并留档
  promptTemplate: "【行情警报】{{payload.reason}}\n请告知用户最新行情与成交量，并简要提示风险。",
  cooldownSec: 1800
})
```

---

## 3. `sentinel` 工具参数规范

| 参数 | 类型 | 说明 | 推荐实践 |
|---|---|---|---|
| `action` | string | `"create"` / `"update"` / `"list"` / `"remove"` / `"enable"` / `"disable"` / `"run"` / `"logs"` | 操作指令 |
| `id` | string | 哨兵唯一英文标识（如 `sol_breakout`） | 必须语义清晰 |
| `scriptPath` | string | 已编写好的脚本路径（如 `channels-data/triggers/scripts/xxx.js`） | **必须先落盘文件再传路径** |
| `params` | object | 传给脚本运行时的参数对象 | 脚本内通过 `process.env.TRIGGER_PARAMS` 读取 |
| `mode` | string | `"once"` (单次报警) / `"persistent"` (持续监控) | **突破/一次性事件选 once；长期巡检选 persistent** |
| `promptTemplate` | string | 唤醒时的关注提示词模板 | 支持 `{{payload.reason}}` 或 `{{payload.data.key}}` 插值 |
| `cooldownSec` | number | 冷却时间（秒） | 默认 1800 秒（30分钟），防频繁重复触发 |
| `maxFiresPerDay` | number | 每日最大唤醒限额 | 默认 5 次，防死循环刷屏 |
| `restart` | boolean | `update` 时强制重启进程 | 修改 params、sessionId、mode、scriptPath 时自动重启 |

### 更新已注册哨兵

脚本文件可以先直接修改，再调用 `update` 让运行中的哨兵重新加载。修改
`params`、`sessionId`、`mode` 或 `scriptPath` 会自动重启；只修改提示词、冷却或
每日限额不会重启。也可以显式传 `restart: true`。

```json5
sentinel({
  action: "update",
  id: "btc_price_alert",
  params: { targetPrice: 81000, symbol: "BTCUSDT" },
  promptTemplate: "【行情警报】{{payload.reason}}\\n请提示风险。"
})
```

---

## 4. 生命周期选择策略（`mode`）

1. **`mode: "once"`（一次性预警）**：
   - **适用场景**：“到 80000 叫我”、“跌破 3000 提醒我”、“这个网页更新了告诉我”；
   - **行为**：一旦条件达成并成功唤醒 Agent 一次，触发器**自动从调度中移除销毁**，但**执行审计日志永久保留**，绝对不会产生二次骚扰。
2. **`mode: "persistent"`（持久性巡检）**：
   - **适用场景**：“每小时巡检服务器磁盘与内存”、“每天早晚检测数据一致性”；
   - **行为**：每次条件达成并唤醒后停止当前脚本，随后重新启动脚本继续监听；冷却和每日限额仍由主进程控制唤醒注入。

---

## 5. 调试与排错

当用户询问监控状态或遇到哨兵未唤醒时：
1. **查看列表**：调用 `sentinel(action="list")` 或微信回复 `/triggers ls`；
2. **试跑脚本**：调用 `sentinel(action="run", id="<id>")`，可直接查看脚本 stdout/stderr 输出与耗时，确认 `@WAKE@` 是否能够正确输出；
3. **查看审计**：调用 `sentinel(action="logs", id="<id>")`，核实是否因冷却（`cooldown_skipped`）或限额（`quota_exceeded`）被拦截。
