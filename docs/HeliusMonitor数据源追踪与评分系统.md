# HeliusMonitor 数据源追踪与评分系统

## 系统概述

HeliusMonitor 是一个综合的数据处理和评分系统，用于分析 Solana 代币的持有者和交易数据，识别潜在的庄家行为。

## 数据源

### 1. GMGN API 数据

#### Holder 数据（持有者信息）
```javascript
{
  owner: "钱包地址",                    // 持有者地址
  funding_account: "资金来源地址",      // 资金来源（用于判断同源）
  native_transfer: {                    // SOL 转账信息
    from: "来源地址",
    amount: 数值,                       // SOL 数量
    timestamp: 时间戳
  },
  trace: [                              // 资金追踪链
    {
      from: "地址",
      amount: 数值,
      timestamp: 时间戳
    }
  ],
  created_at: 时间戳,                   // 首次交易时间
  open_timestamp: 时间戳,               // 开仓时间
  total_buy_u: 数值,                    // 总买入金额（USD）
  sol_balance: 数值,                    // SOL 余额
  ui_amount: 数值,                      // 持有代币数量
  holding_share_pct: 数值,              // 持仓占比
  wallet_age: 字符串,                   // 钱包年龄
  source_text: 字符串                   // 来源描述
}
```

#### Trade 数据（交易信息）
```javascript
{
  owner: "交易者地址",
  event: "buy" | "sell",               // 交易类型
  sol_amount: 数值,                     // SOL 数量
  token_amount: 数值,                   // Token 数量
  timestamp: 时间戳,                    // 交易时间
  signature: "交易签名"
}
```

### 2. Helius API 数据（可选）

当启用 Helius API 时，系统会通过 WebSocket 实时获取链上交易数据：
- 交易签名
- 交易详情
- 账户变化

## 数据流程

### 完整数据流

```
1. GMGN 页面刷新
   ↓
2. hook.js 拦截 API 响应
   ↓
3. 触发 HOOK_HOLDERS_EVENT / HOOK_FETCH_XHR_EVENT
   ↓
4. HeliusIntegration.hookHolderHandler 接收数据
   ↓
5. HeliusMonitor.updateHolderData(holders)
   ├─ 5.1 MetricsEngine.updateUsersInfo(holders)
   │      └─ 存储用户信息到 userInfo
   ├─ 5.2 ScoringEngine.calculateScores()
   │      ├─ 收集统计数据（资金来源分组、时间聚类等）
   │      └─ 计算每个用户的分数
   ├─ 5.3 存储分数到 userInfo
   │      └─ userInfo[address].score = finalScore
   │      └─ userInfo[address].score_reasons = reasons
   │      └─ userInfo[address].status = '庄家' | '散户'
   ├─ 5.4 过滤用户（score < scoreThreshold）
   ├─ 5.5 更新庄家地址列表
   └─ 5.6 重新计算指标
   ↓
6. HeliusIntegration.distributeDataToContentManager()
   ├─ 从 monitor.metricsEngine.userInfo 获取数据
   ├─ 包含 score, status, score_reasons
   └─ 发送 UPDATE_PLUGIN_DATA 消息
   ↓
7. 插件页面（App.jsx）接收数据
   ↓
8. 显示用户列表和详细信息
```

### 数据处理组件

#### 1. HeliusIntegration
- **职责**：数据接收和分发的中心
- **输入**：GMGN API 数据（holders, trades）
- **输出**：处理后的数据发送给插件页面
- **关键方法**：
  - `hookHolderHandler()` - 接收 holder 数据
  - `hookFetchXhrHandler()` - 接收 trade 数据
  - `updateGmgnHolders()` - 处理 holder 数据并触发评分
  - `distributeDataToContentManager()` - 分发数据给 UI

#### 2. HeliusMonitor
- **职责**：协调所有数据处理组件
- **组件**：
  - SignatureManager - 管理交易签名
  - MetricsEngine - 计算指标
  - ScoringEngine - 计算评分
  - DataFetcher - 获取链上数据
  - CacheManager - 缓存管理
- **关键方法**：
  - `updateHolderData()` - 更新 holder 数据并触发评分
  - `updateTradeData()` - 更新 trade 数据
  - `recalculateMetrics()` - 重新计算指标

#### 3. MetricsEngine
- **职责**：存储用户信息和计算指标
- **数据结构**：
  - `userInfo` - 用户完整信息（包括 score, status, score_reasons）
  - `traderStats` - 交易统计
  - `filteredUsers` - 过滤后的用户（score < threshold）
  - `whaleAddresses` - 庄家地址集合
- **关键方法**：
  - `updateUsersInfo()` - 更新用户信息
  - `getMetrics()` - 计算指标（只计算过滤后的散户）

#### 4. ScoringEngine
- **职责**：计算用户的庄家倾向分数
- **输入**：
  - `userInfo` - 用户信息
  - `config` - 评分配置
  - `manualScores` - 手动标记
  - `statusThreshold` - 状态判断阈值
- **输出**：
  - `scoreMap` - 每个用户的分数和原因
  - `whaleAddresses` - 庄家地址集合
- **关键方法**：
  - `calculateScores()` - 计算所有用户的分数
  - `collectStatistics()` - 收集统计数据

## 评分规则

### 8 个评分规则

#### 1. 无资金来源 (rule_no_source)
- **数据源**：`holder.funding_account`
- **条件**：没有资金来源地址
- **分数**：+10 分
- **原因**：`"无来源"`

#### 2. 同源 (rule_same_source)
- **数据源**：`holder.funding_account`
- **条件**：多个用户来自同一个资金来源
- **分数**：+10 分
- **原因**：`"同源(N)"` - N 是同源用户数量

#### 3. 时间聚类 (rule_time_cluster)
- **数据源**：`holder.created_at` 或 `holder.open_timestamp`
- **条件**：N 个用户在 J 秒内开仓
- **分数**：+10 分
- **原因**：`"时间聚集"`

#### 4. 资金来源时间聚类 (rule_source_time)
- **数据源**：`holder.native_transfer.timestamp`
- **条件**：多个用户的资金转入时间接近
- **分数**：+10 分
- **原因**：`"来源时间聚类"`

#### 5. 金额相似 (rule_amount_sim)
- **数据源**：`holder.total_buy_u`
- **条件**：多个用户的买入金额相似
- **分数**：+10 分
- **原因**：`"金额相似"`

#### 6. SOL 余额相似 (rule_sol_balance)
- **数据源**：`holder.sol_balance`
- **条件**：多个用户的 SOL 余额相似
- **分数**：+10 分
- **原因**：`"余额相似"`

#### 7. Gas 费用相似 (rule_gas)
- **数据源**：交易 gas 费用
- **条件**：多个用户的 gas 费用相似
- **分数**：+10 分
- **原因**：`"Gas相似"`

#### 8. 大额持仓 (rule_large_holding)
- **数据源**：`holder.holding_share_pct`, `holder.total_buy_u`
- **条件**：持仓占比高或买入金额大
- **分数**：+10 分
- **原因**：`"大额持仓"`

### 手动标记

- **数据源**：用户手动标记
- **分数**：+10 分
- **原因**：`"手动标记(+10)"`
- **存储**：Chrome storage (`manual_scores_${mintAddress}`)

### 状态判断

- **状态阈值** (statusThreshold): 默认 50 分
- **判断规则**:
  - 分数 >= statusThreshold → 庄家
  - 分数 < statusThreshold → 散户

### 过滤规则

- **过滤阈值** (scoreThreshold): 默认 100 分
- **过滤规则**: 只显示和计算 score < scoreThreshold 的用户
- **影响范围**:
  - UI 显示的用户列表
  - 指标计算（已落袋、本轮下注等）

## 用户详情显示

### 显示的数据源

当点击用户列表中的用户时，详情面板会显示以下信息：

#### 📋 基本信息
- owner - 钱包地址
- status - 状态（庄家/散户）
- score - 评分

#### 💰 持仓信息
- amount - 持有代币数量
- holding_pct - 持仓占比
- buy_u - 总买入金额
- netflow - 净流入

#### 🔗 资金来源
- funding_account - 资金来源地址
- source_text - 来源描述
- wallet_age - 钱包年龄
- sol_balance - SOL 余额

#### ⏰ 时间信息
- created_at - 创建时间
- open_timestamp - 开仓时间

#### 💸 SOL 转账信息
- from - 来源地址
- amount - 转账金额
- timestamp - 转账时间

#### 🔍 Trace 信息
- 显示资金追踪链（最多显示前 5 条）
- 每条包含：来源地址、金额、时间

#### 🎯 庄家得分详情
- 总分数
- 评分原因列表

#### 💾 完整数据
- 点击可复制完整的 JSON 数据到剪贴板

## 配置说明

### 默认配置

```javascript
{
  enable_no_source: true,           // 启用"无资金来源"规则
  weight_no_source: 10,             // 权重 10 分
  enable_same_source: false,        // 禁用"同源"规则
  same_source_n: 5,                 // 同源用户数阈值
  same_source_exclude: '',          // 排除的资金来源地址
  weight_same_source: 10,           // 权重 10 分
  enable_time_cluster: false,       // 禁用"时间聚类"规则
  time_cluster_n: 5,                // 聚类用户数阈值
  time_cluster_j: 1,                // 时间窗口（秒）
  weight_time_cluster: 10,          // 权重 10 分
  rule_gas: {
    enabled: false,
    threshold: 0.01,
    weight: 10
  },
  rule_amount_sim: {
    enabled: false,
    count: 5,
    range: 100,
    weight: 10
  },
  rule_large_holding: {
    enabled: false,
    top_pct: 10,
    min_usd: 1000,
    logic: 'OR',
    weight: 10
  },
  rule_sol_balance: {
    enabled: false,
    count: 3,
    range: 0.1,
    weight: 10
  },
  rule_source_time: {
    enabled: false,
    diff_sec: 10,
    count: 2,
    weight: 10
  }
}
```

### 配置存储

- **位置**：Chrome storage
- **键名**：
  - `boss_config` - 评分配置
  - `score_threshold` - Score< 过滤阈值
  - `status_threshold` - 状态判断阈值
  - `manual_scores_${mintAddress}` - 手动标记

## 调试日志

### 关键日志

#### 1. 数据接收
```
[HeliusIntegration] 接收 GMGN Holder 数据 { count: 56 }
[HeliusIntegration] 传递数据到 HeliusMonitor { count: 56 }
```

#### 2. 评分计算
```
[HeliusMonitor] 更新 holder 数据并执行评分 { holderCount: 56 }
[HeliusMonitor] 步骤1完成: updateUsersInfo { userInfoCount: 56 }
[HeliusMonitor] 步骤2开始: calculateScores { bossConfigKeys: 8, statusThreshold: 50 }
[ScoringEngine] 开始计算分数 { userCount: 56, configKeys: [...], enableNoSource: true }
[ScoringEngine] 第一个用户示例 { address: "EMSiyp5K...", hasFundingAccount: false }
[ScoringEngine] 用户评分详情 [1/3]: { address: "EMSiyp5K...", score: 10, reasons: ["无来源"], status: "散户" }
[ScoringEngine] 分数计算完成 { totalUsers: 56, whaleCount: 3, retailCount: 53, avgScore: "15.71" }
[HeliusMonitor] 步骤3完成: 存储分数 { updatedCount: 56 }
[HeliusMonitor] 步骤4完成: 过滤用户 { filteredCount: 53 }
[HeliusMonitor] 步骤7完成: 重新计算指标
```

#### 3. 数据分发
```
[HeliusIntegration] 数据已分发给插件页面 { holderCount: 56, whaleCount: 3, retailCount: 53 }
```

### 日志优化

- **防重复日志**：指标计算日志只有在数据变化或超过 5 秒时才记录
- **详细评分日志**：显示前 3 个用户的详细评分信息
- **分数分布统计**：显示各分数段的用户数量

## 常见问题

### 1. 分数没有显示

**可能原因**：
- bossConfig 配置为空或所有规则都禁用
- holder 数据中所有用户都有 funding_account（无法触发"无资金来源"规则）
- Monitor 未启动

**解决方法**：
- 检查日志中的 `[ScoringEngine] 开始计算分数` 是否出现
- 检查 `enableNoSource` 和 `weightNoSource` 的值
- 检查第一个用户的 `hasFundingAccount` 值

### 2. 页面黑屏

**可能原因**：
- mint 参数为 undefined
- owner 参数为 undefined
- React 组件崩溃

**解决方法**：
- 已添加参数验证，防止 undefined.slice() 错误
- 检查浏览器控制台的错误信息

### 3. Monitor 未启动

**可能原因**：
- 不在 mint 页面
- mint 地址变化导致 Monitor 重启
- 旧的数据请求返回时 Monitor 已停止

**解决方法**：
- 确认当前在 GMGN mint 页面
- 等待 Monitor 自动启动（每 5 秒检查一次）
- 刷新页面重新初始化

## 文件结构

```
src/
├── content/
│   ├── HeliusIntegration.js    # 数据接收和分发中心
│   ├── BossLogic.js             # 评分规则逻辑
│   └── index.jsx                # Content script 入口
├── helius/
│   ├── HeliusMonitor.js         # 监控协调器
│   ├── MetricsEngine.js         # 指标计算引擎
│   ├── ScoringEngine.js         # 评分引擎
│   ├── SignatureManager.js      # 签名管理
│   ├── DataFetcher.js           # 数据获取
│   └── CacheManager.js          # 缓存管理
└── sidepanel/
    └── App.jsx                  # 插件 UI
```

## 更新日志

### 2026-02-20

#### 修复
- ✅ 修复 `window.__contentManager` undefined 错误
- ✅ 修复 mint 参数验证，防止 undefined.slice() 错误
- ✅ 修复 owner 参数保护，防止 undefined.slice() 错误
- ✅ 修复页面黑屏问题

#### 优化
- ✅ 添加防重复日志机制
- ✅ 添加详细评分日志（显示前 3 个用户）
- ✅ 添加分数分布统计
- ✅ 添加配置调试日志

#### 增强
- ✅ 增强用户详情显示，添加所有数据源信息
- ✅ 添加 Trace 信息显示
- ✅ 添加完整数据复制功能
- ✅ 优化详情面板布局和样式

## 参考文档

- [评分计算详细说明](SCORING_CALCULATION_LOG.md)
- [持有人启动问题诊断](HOLDER_STARTUP_ISSUE.md)
- [持有人启动修复说明](HOLDER_STARTUP_FIX.md)
