# 庄家评分计算详细说明

## 数据源

评分系统使用以下数据源：

### 1. Holder 数据（来自 GMGN API）
```javascript
{
  owner: "地址",                    // 用户钱包地址
  funding_account: "来源地址",      // 资金来源地址
  native_transfer: {                // SOL 转账信息
    timestamp: 时间戳,
    from: "来源地址"
  },
  created_at: 时间戳,               // 首次交易时间
  open_timestamp: 时间戳,           // 开仓时间
  total_buy_u: 数值,                // 总买入金额（USD）
  sol_balance: 数值,                // SOL 余额
  // ... 其他字段
}
```

### 2. Trade 数据（来自 GMGN API）
```javascript
{
  owner: "地址",                    // 交易者地址
  event: "buy" | "sell",           // 交易类型
  sol_amount: 数值,                 // SOL 数量
  token_amount: 数值,               // Token 数量
  timestamp: 时间戳,                // 交易时间
  // ... 其他字段
}
```

## 评分规则（8个规则）

### 规则 1: 无来源 (rule_no_source)
- **数据源**: `holder.funding_account`
- **条件**: 没有资金来源地址
- **分数**: +10 分
- **原因**: "无来源(+10)"

### 规则 2: 同源 (rule_same_source)
- **数据源**: `holder.funding_account`
- **条件**: 多个用户来自同一个资金来源
- **分数**: +10 分
- **原因**: "同源(+10)"
- **计算**: 统计每个 funding_account 的用户数量，如果 >= 阈值则触发

### 规则 3: 时间聚类 (rule_time_cluster)
- **数据源**: `holder.created_at` 或 `holder.open_timestamp`
- **条件**: N 个用户在 J 秒内开仓
- **分数**: +10 分
- **原因**: "时间聚类(+10)"
- **计算**:
  1. 按时间排序所有用户
  2. 滑动窗口检查：如果 N 个用户的时间差 <= J 秒，则这 N 个用户都触发

### 规则 4: 资金来源时间聚类 (rule_source_time)
- **数据源**: `holder.native_transfer.timestamp`
- **条件**: 多个用户的资金转入时间接近
- **分数**: +10 分
- **原因**: "来源时间聚类(+10)"
- **计算**: 如果两个用户的资金转入时间差 <= 阈值秒，则互相关联

### 规则 5: 金额相似 (rule_amount_sim)
- **数据源**: `holder.total_buy_u`
- **条件**: 多个用户的买入金额相似
- **分数**: +10 分
- **原因**: "金额相似(+10)"
- **计算**:
  1. 将金额分桶（例如每 100 USD 一个桶）
  2. 如果某个桶的用户数 >= 阈值，则这些用户都触发

### 规则 6: SOL 余额相似 (rule_sol_balance)
- **数据源**: `holder.sol_balance`
- **条件**: 多个用户的 SOL 余额相似
- **分数**: +10 分
- **原因**: "余额相似(+10)"
- **计算**: 类似金额相似，按余额分桶

### 规则 7: 大额交易 (rule_large_trade)
- **数据源**: `trade.sol_amount`
- **条件**: 单笔交易金额超过阈值
- **分数**: +10 分
- **原因**: "大额交易(+10)"

### 规则 8: 快速进出 (rule_quick_flip)
- **数据源**: `trade` 数据
- **条件**: 买入后快速卖出
- **分数**: +10 分
- **原因**: "快速进出(+10)"
- **计算**: 如果买入后在 X 秒内卖出，则触发

## 手动标记

- **数据源**: 用户手动标记
- **分数**: +10 分
- **原因**: "手动标记(+10)"
- **存储**: Chrome storage (`manual_scores_${mintAddress}`)

## 评分流程

### 阶段 1: 收集统计数据
```javascript
collectStatistics(userInfo, config) {
  // 1. 资金来源分组
  fundingGroups: Map<来源地址, [用户地址]>

  // 2. 时间分组
  timeGroups: [{ time, owner }]

  // 3. 资金来源时间分组
  sourceTimeGroups: [{ time, owner, from }]

  // 4. 金额分桶
  amountBuckets: Map<桶索引, 用户数>

  // 5. 余额分桶
  balanceBuckets: Map<桶索引, 用户数>

  // 6. 时间聚类用户集合
  timeClusteredUsers: Set<用户地址>

  // 7. 资金来源时间聚类
  sourceTimeClusteredUsers: Map<用户地址, Set<关联用户>>
}
```

### 阶段 2: 计算每个用户的分数
```javascript
for (const [address, user] of Object.entries(userInfo)) {
  // 1. 调用 BossLogic.calculateUserScore()
  const { score, isBoss, reasons } = BossLogic.calculateUserScore(
    user, stats, config
  );

  // 2. 添加手动标记分数
  if (manualScores[address] === '庄家') {
    score += 10;
    reasons.push('手动标记(+10)');
  }

  // 3. 判断状态
  const isWhale = score >= statusThreshold;
  const status = isWhale ? '庄家' : '散户';

  // 4. 存储结果
  scoreMap.set(address, { score, reasons, isWhale, status });
}
```

## 状态判断

- **状态阈值** (statusThreshold): 默认 50 分
- **判断规则**:
  - 分数 >= statusThreshold → 庄家
  - 分数 < statusThreshold → 散户

## 过滤规则

- **过滤阈值** (scoreThreshold): 默认 100 分
- **过滤规则**: 只显示和计算 score < scoreThreshold 的用户
- **影响范围**:
  - UI 显示的用户列表
  - 指标计算（已落袋、本轮下注等）

## 日志示例

### 完整评分日志
```
[HeliusIntegration] 接收 GMGN holders 数据 { count: 14 }
[HeliusMonitor] 更新 holder 数据并执行评分 { holderCount: 14 }
[HeliusMonitor] 步骤1完成: updateUsersInfo { userInfoCount: 14 }
[HeliusMonitor] 步骤2开始: calculateScores { bossConfigKeys: 8, statusThreshold: 50 }

[ScoringEngine] 开始计算分数 { userCount: 14, manualScoreCount: 0, statusThreshold: 50 }
[ScoringEngine] 统计数据收集完成 {
  fundingGroups: 5,
  timeClusteredUsers: 8,
  sourceTimeClusteredUsers: 3
}

[ScoringEngine] 用户评分详情:
  - 地址: EMSiyp5K...
    分数: 20
    原因: ["无来源(+10)", "时间聚类(+10)"]
    状态: 散户

  - 地址: mrwqWBbd...
    分数: 30
    原因: ["同源(+10)", "时间聚类(+10)", "金额相似(+10)"]
    状态: 散户

  - 地址: FVRHswhm...
    分数: 60
    原因: ["同源(+10)", "时间聚类(+10)", "来源时间聚类(+10)", "金额相似(+10)", "余额相似(+10)", "大额交易(+10)"]
    状态: 庄家

[ScoringEngine] 分数计算完成 {
  totalUsers: 14,
  whaleCount: 3,
  avgScore: 35.7
}

[HeliusMonitor] 步骤3完成: 存储分数 { updatedCount: 14 }
[HeliusMonitor] 步骤4完成: 过滤用户 { filteredCount: 11, threshold: 100 }
[HeliusMonitor] 步骤7完成: 重新计算指标

[HeliusIntegration] 数据已分发给插件页面 {
  holderCount: 14,
  whaleCount: 3,
  retailCount: 11
}
```

## 验证方法

1. **检查数据源**: 确认 holder 数据包含必要字段
2. **检查配置**: 确认评分配置正确加载
3. **检查日志**: 查看每个用户的评分原因
4. **手动验证**:
   - 找两个来自同一来源的用户 → 应该有"同源(+10)"
   - 找时间接近的用户 → 应该有"时间聚类(+10)"
   - 找金额相似的用户 → 应该有"金额相似(+10)"
