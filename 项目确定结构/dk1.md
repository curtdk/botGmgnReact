



核心数据流

WS 新交易 → processTransaction() → updateTraderState()
  → traderStats[address] 创建/更新（无 score，只有 netSolSpent 等）
  → recentTrades.unshift({ ..., label: status, [无 score 字段] })

GMGN Hook 持仓 → updateHolderData()
  → calculateScores() → scoreMap
  → scoreMap 写入 traderStats[address].score / .status
  → filterUsersByScore() → filteredUsers
  → recalculateMetrics()

---

## 实时交易列表 Score< 筛选 — 已实现架构

### 核心对象关系

```
traderStats[address] {
  // WS 交易累积字段
  netSolSpent, totalBuySol, totalSellSol, netTokenReceived,
  totalGasFee, status, ...

  // GMGN holder 快照字段（updateHolderData 写入）
  funding_account, ui_amount, usd_value, sol_balance,
  total_buy_u, rank, native_transfer, ...

  // 评分结果（calculateScores 写入）
  score,          // number | undefined（未评分时为 undefined）
  status,         // '庄家' | '散户' | 手动标记
  score_reasons   // 各规则命中明细
}

recentTrades[i] {
  signature, address, action, tokenAmount, solAmount, rawTimestamp,
  label,   // 来自 traderStats[address].status（updateTraderState 时写入）
  score    // 来自 traderStats[address].score（getMetrics() 实时附加）
}

filteredUsers: Set<address>   // score < scoreThreshold 的地址集合
scoreThreshold: number        // Score< 阈值（用户在设置中配置）
minScore: number              // App.jsx state，同步自 scoreThreshold
```

### 数据流（三种情况）

**情况 A（绝大多数）：已知地址（traderStats 有 score）**
```
WS 新交易 → handleNewSignature()
  → processTransaction() → recentTrades 更新
  → getMetrics() 读取 traderStats[addr].score（已有值）
  → onMetricsUpdate() → UI 立即显示
  → 按 score 直接判断：>= minScore 屏蔽 / < minScore 正常显示
```

**情况 B（少量）：在 traderStats 但 score=undefined**
```
WS 新交易 → handleNewSignature()
  → getMetrics() → score: undefined → UI 显示"检查中"
  → 检测到 traderStats[addr].score === undefined
  → _scheduleQuickScore()（500ms debounce）
    → calculateScores(traderStats 现有数据)
    → 写入 score/status/score_reasons
    → filterUsersByScore() → filteredUsers 更新
    → recalculateMetrics() → UI 自动更新（检查中 消除）
```

**情况 C（极少量）：全新地址，traderStats 完全没有**
```
WS 新交易 → 显示"检查中"
  → 等待 GMGN holder 快照轮询
  → updateHolderData() → calculateScores（含完整 holder 数据）
  → 真实 score 写入 → recalculateMetrics() → UI 自动更新
```

### BossLogic 评分规则（快速评分时的行为）

| 规则 | 需要 holder 快照 | 快速评分结果 |
|------|-----------------|-------------|
| 1. 无资金来源 | 否（检查 funding_account 是否为空） | **触发**（funding_account=undefined → score += weight≈10） |
| 2. 大额买入 | 是（total_buy_u） | 返回 0 |
| 3. 时间聚集 | 否（native_transfer.timestamp） | 可触发 |
| 4. 高 Gas | 否（max_gas_fee） | 可触发 |
| 5. 持仓价值 | 是（usd_value） | 返回 0 |
| 6. SOL余额 | 是（sol_balance） | 返回 0 |
| 7. 排名 | 是（rank） | 返回 0 |
| 8. 分散买入 | 是（native_transfer 数量） | 返回 0 |
| 9. 隐藏中转 | 否（sig 指令检测） | 可触发 |

→ 无 holder 快照的新地址快速评分结果：**score ≈ 10**（规则1触发），`updateHolderData()` 到来后覆盖为真实分数。

### 修改过的文件

| 文件 | 位置 | 改动 |
|------|------|------|
| `src/helius/MetricsEngine.js` | `getMetrics()` | recentTrades 附加 live score |
| `src/helius/HeliusMonitor.js` | `handleNewSignature()` | 检测无分地址触发快速评分 |
| `src/helius/HeliusMonitor.js` | 新增 `_scheduleQuickScore()` | 500ms debounce 快速评分 |
| `src/sidepanel/App.jsx` | `RecentTradesList` 组件 | minScore prop + 三态显示 |
| `src/sidepanel/App.jsx` | 调用处 | 传入 `minScore={minScore}` |

### RecentTradesList 三态显示逻辑

```js
// score 筛选（minScore=0 时不过滤）
const visibleTrades = minScore > 0
    ? trades.filter(t => t.score === undefined || t.score < minScore)
    : trades;

// 标签列渲染
const isPending = t.score === undefined;
// 检查中（灰色斜体）/ 正常标签
{isPending ? '检查中' : (t.label || '散户')}
```