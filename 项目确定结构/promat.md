
# 组件 / 对象 中文名称对照表

## UI 组件

| 中文名 | 代码名 | 文件 | 作用 |
|--------|--------|------|------|
| **实时交易列表** | `RecentTradesList` | `App.jsx` | 显示 WS 实时交易，支持分数筛选三态（正常/检查中/屏蔽），金额列随单位切换 |
| **用户列表行** | `UserListItem` | `App.jsx` | 渲染用户榜单每一行，`React.memo` 优化，支持 SOL/USDT 金额切换 |

## 状态变量（App.jsx）

| 中文名 | 代码名 | 类型 | 作用 |
|--------|--------|------|------|
| **单位切换** | `metricsUnit` | `'SOL' \| 'USDT'` | 控制全局金额单位，影响四大指标 + 实时交易列表 + 用户列表 |
| **SOL单价** | `solUsdtPrice` | `number` | 切换到 USDT 时从 Binance 拉取的 SOL/USDT 价格，用于乘法换算 |
| **分数阈值** | `minScore` | `number` | Score< 阈值，实时交易列表和用户列表共用，0=不过滤 |
| **实时交易** | `recentTrades` | `array` | 来自 heliusMetrics，每条带 score 字段（getMetrics 实时附加）|

## 核心函数

| 中文名 | 代码名 | 位置 | 作用 |
|--------|--------|------|------|
| **单位切换按钮** | `handleMetricsUnitToggle()` | `App.jsx` | 点击 SOL/USDT 按钮，调 Binance API 拉 SOL 价格，写入 solUsdtPrice |
| **四大指标格式化** | `fmtMetric(solVal)` | `App.jsx` | 将 SOL 值转为当前单位字符串，四大指标专用 |
| **用户列表金额转换** | `toDisp(solVal)` | `UserListItem` 内 | 将 SOL 值按当前单位格式化，用于成本/下注/落袋/浮亏列 |
| **交易金额格式化** | `fmtSol(v)` | `RecentTradesList` 内 | 将 SOL 值格式化，USDT 模式下自动乘以 solUsdtPrice |
| **快速评分** | `_scheduleQuickScore()` | `HeliusMonitor.js` | 500ms debounce，WS 新地址无评分时触发，消除"检查中"状态 |

## 后端引擎对象

| 中文名 | 代码名 | 文件 | 作用 |
|--------|--------|------|------|
| **交易引擎** | `MetricsEngine` | `MetricsEngine.js` | 维护 traderStats / recentTrades，提供 getMetrics() |
| **Helius监控** | `HeliusMonitor` | `HeliusMonitor.js` | WS 实时监听 + GMGN holder 快照 + 评分调度 |
| **评分引擎** | `ScoringEngine` | `ScoringEngine.js` | 调 BossLogic 计算 scoreMap，输出 score/status/reasons |
| **庄家规则** | `BossLogic` | `BossLogic.js` | 9条规则计算单个用户分数，部分依赖 GMGN holder 快照 |

## 核心数据对象

| 中文名 | 代码名 | 说明 |
|--------|--------|------|
| **交易员档案** | `traderStats[address]` | 每个地址的全量数据：WS统计 + GMGN快照 + 评分结果 |
| **实时交易记录** | `recentTrades[i]` | 每条交易：signature/address/action/solAmount/score |
| **散户集合** | `filteredUsers` | score < scoreThreshold 的地址 Set，控制用户列表可见性 |
| **评分结果集** | `scoreMap` | calculateScores 返回，Map<address, {score, status, reasons}> |

---

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

---

## 开始/停止 + Mint 锁定机制

### 核心状态变量（App.jsx）

| 变量 | 类型 | 说明 |
|------|------|------|
| `isStarted` | `boolean` | 是否已点击"开始"，控制所有业务数据的接收和处理 |
| `startedMint` | `string` | 点击"开始"时锁定的代币地址 |
| `startStage` | `string` | 当前阶段描述（"就绪" / "获取数据中..." / "运行中 · 实时监听" 等） |
| `hookUrlReady` | `null \| true \| false` | `null`=待检查 / `true`=Hook可用 / `false`=无缓存 |
| `isStartedRef` | `useRef` | `isStarted` 的 ref 版，防止定时器/消息闭包读取旧值 |
| `startedMintRef` | `useRef` | `startedMint` 的 ref 版，同上 |
| `pageMintRef` | `useRef` | `pageMint` 的 ref 版，供 `handleStorageChange` 闭包内使用 |

### 核心函数（App.jsx）

| 函数 | 触发 | 行为 |
|------|------|------|
| `handleStart()` | 点击"▶ 开始" | 锁定 `startedMint = pageMint`，发 `LOCK_MINT` 到 content script，启动 Helius，触发全量刷新 |
| `handleStop()` | 点击"⏹ 停止" | 清空 `startedMint`，发 `UNLOCK_MINT` 到 content script，停止所有定时器，停止 Helius |
| `initPageLogic(mint)` | URL 变化检测到新 mint | 若已启动（`isStartedRef.current = true`）则直接 `return`（不中断业务）；未启动才重置状态 |

### 业务守卫（App.jsx 消息处理）

| 消息类型 | 守卫条件 | 守卫作用 |
|----------|----------|---------|
| `UI_RENDER_DATA` | `request.mint !== startedMintRef.current` | 拦截其他 mint 的 holder 数据，不更新用户列表 |
| `HELIUS_METRICS_UPDATE` | `request.mint !== startedMintRef.current` | 拦截其他 mint 的四大指标和实时交易列表 |
| `HELIUS_STATS_UPDATE` | `request.mint !== startedMintRef.current` | 拦截其他 mint 的 sig 统计 |
| `HELIUS_METRICS_CLEAR` | `isStartedRef.current === true` | 已启动时忽略清空指令（页面切换触发的 clear 不影响启动中的 mint） |
| `handleFullRefresh` | `isStartedRef.current === false` | 未启动时不发起全量刷新 |
| `runHookRefresh` | `isStartedRef.current === false` | 未启动时不执行 Hook 定时刷新 |

### lockedMint 锁定机制（HeliusIntegration.js）

**全局属性** `this.lockedMint`（初始为 `null`）

| 消息 | 来源 | 效果 |
|------|------|------|
| `LOCK_MINT { mint }` | ���边栏 `handleStart()` → `chrome.tabs.sendMessage` | `lockedMint = mint`，阻止 MutationObserver 触发的自动切换 |
| `UNLOCK_MINT` | 侧边栏 `handleStop()` → `chrome.tabs.sendMessage` | `lockedMint = null`，恢复自动切换 |

**checkAndInitMonitor() 守卫逻辑**：
```
检测到新 mint（MutationObserver 触发）
  ↓
if (lockedMint && newMint !== lockedMint)
  → 记录日志"忽略切换"，直接 return（不切换 monitor）
  ↓ 否则正常启动新 monitor
```

### 数据流向（已启动状态）

```
[页面跳转到 MintB]
  ↓ MutationObserver 触发 checkAndInitMonitor(MintB)
  ↓ lockedMint = MintA → 守卫拦截 → return（不切换 monitor）

[GMGN 页面发来 MintB 的 holder 数据]
  ↓ sendDataToSidepanel() 带 mint: MintA
  ↓ 侧边栏 UI_RENDER_DATA 守卫：mint 不匹配 → 丢弃

[MetricsEngine 发来 MintA 四大指标]
  ↓ HELIUS_METRICS_UPDATE 带 mint: MintA → 通过守卫 → 正常更新

[用户点击停止]
  ↓ UNLOCK_MINT → lockedMint = null
  ↓ 下次 MutationObserver 触发时可正常切换到新 mint
```

### Hook URL 自动检测（未启动时）

`handleStorageChange` 监听 `chrome.storage.onChanged`：
```
hook.js 写入 gmgn_hook_url_<mint>
  ↓ handleStorageChange 检测到对应 key 变化
  ↓ isStarted = false 时：setHookUrlReady(true)，日志"✓ 已自动检测到"
  ↓ 状态栏从"· 待检查"变为"✓ Hook可用"
```

### 状态栏显示逻辑

```
hookUrlReady === null   → "· 待检查"  （灰色，插件刚打开或页面切换后）
hookUrlReady === true   → "✓ Hook可用" （绿色，可以点击开始）
hookUrlReady === false  → "⚠ 请刷新页面" （橙色，无缓存且未自动检测到）

startStage：跟随业务阶段动态变化
  就绪 → 检查 Hook URL... → 获取数据中... → 运行中 · 实时监听
```

---

## 数据流日志系统（dataFlowLogger）

### 日志来源（Logger.js 颜色分类）

| 来源标识 | 颜色 | 含义 |
|----------|------|------|
| `GMGN-Hook` | 紫色 | GMGN 页面 hook 拦截的 holder/trades 数据 |
| `Helius-WS` | 青色 | Helius WebSocket 实时新 signature |
| `Helius-API` | 蓝色 | Helius RPC API 拉取 sig 列表和交易详情 |
| `HeliusMonitor` | 绿色 | 内部评分/计算完成汇总 |
| `UI-发送` | 橙色 | 向 Sidepanel 发送 holder 数据或 metrics |
| `锁定控制` | 红色 | mint 锁定/解锁/忽略切换事件 |

### 关键日志节点

| 来源 | 事件 | 位置 | 关键字段 |
|------|------|------|---------|
| `GMGN-Hook` | `Holders 接收` | `hookHolderHandler` | 数量、锁定mint、monitor状态 |
| `GMGN-Hook` | `Trades 接收` | `hookFetchXhrHandler` | 总条数、新增条数、锁定mint |
| `GMGN-Hook` | `⚠ 丢弃` | 两个 handler | monitor 未启动时 |
| `Helius-API` | `Sig 列表` | `fetchInitialSignatures` | 总数、缓存数、新增数 |
| `Helius-API` | `Tx 批量拉取` | `fetchMissingTransactions` | 缓存/API/总需数量 |
| `Helius-WS` | `新 Sig` | `ws.onmessage` | 每条 WS 实时签名 |
| `HeliusMonitor` | `评分完成` | `updateHolderData` | holders数/庄家/散户/显示数 |
| `UI-发送` | `Holders 推送` | `sendDataToSidepanel` | 用户数、庄家/散户、锁定mint |
| `UI-发送` | `Metrics 推送` | `sendMetricsToUI` | processed数、锁定mint |
| `锁定控制` | `锁定 Mint` | `LOCK_MINT` 处理 | 锁定的 mint 地址 |
| `锁定控制` | `解锁 Mint` | `UNLOCK_MINT` 处理 | 原锁定的 mint 地址 |
| `锁定控制` | `忽略切换` | `checkAndInitMonitor` | 被忽略的 mint + 当前锁定 mint |
| `锁定控制` | `Monitor 启动` | `checkAndInitMonitor` | 新启动的 mint |

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/utils/Logger.js` | 新增 6 个来源颜色（GMGN-Hook / Helius-WS / Helius-API / UI-发送 / 锁定控制 / HeliusMonitor） |
| `src/content/HeliusIntegration.js` | 添加 `lockedMint`，处理 LOCK/UNLOCK_MINT，清理旧日志，添加 10 个关键日志节点 |
| `src/helius/HeliusMonitor.js` | `updateHolderData` 8条步骤日志 → 1条汇总，添加 WS/API 日志节点 |
| `src/sidepanel/App.jsx` | 开始/停止按钮，状态栏，业务守卫，LOCK_MINT/UNLOCK_MINT 消息发送 |