# ContentScoreManager 集成到 HeliusMonitor 实施总结

## 实施完成时间
2026-02-20

## 实施目标
将 ContentScoreManager 的评分和庄家检测逻辑移入 HeliusMonitor 体系，实现基于分数的庄家倾向系统。

---

## 已完成的工作

### 1. 创建 ScoringEngine.js ✅
**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/ScoringEngine.js`

**功能**:
- 复用 BossLogic.js 的 8 个评分规则
- 实现两阶段处理：统计收集 → 评分计算
- 处理手动标记 +10 分
- 基于分数阈值判断用户状态（庄家/散户）

**核心方法**:
- `calculateScores(userInfo, traderStats, config, manualScores, statusThreshold)`: 计算所有用户的分数
- `collectStatistics(userInfo, config)`: 收集统计数据

**日志输出**:
```
[ScoringEngine] 开始计算分数 { userCount, manualScoreCount, statusThreshold }
[ScoringEngine] 统计数据收集完成 { fundingGroups, timeClusteredUsers, sourceTimeClusteredUsers }
[ScoringEngine] 分数计算完成 { totalUsers, whaleCount, avgScore }
```

---

### 2. 修改 HeliusMonitor.js ✅
**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/HeliusMonitor.js`

**新增属性**:
- `scoringEngine`: ScoringEngine 实例
- `scoreThreshold`: Score< 过滤阈值（默认 100）
- `statusThreshold`: 状态判断阈值（默认 50）
- `manualScores`: 手动标记对象
- `bossConfig`: 评分配置对象

**新增方法**:
- `updateHolderData(holders)`: 更新 holder 数据并执行评分
- `filterUsersByScore(scoreMap)`: 根据分数阈值过滤用户
- `recalculateMetrics()`: 重新计算指标
- `setScoreThreshold(threshold)`: 设置 Score< 过滤阈值
- `setStatusThreshold(threshold)`: 设置状态判断阈值
- `setManualScore(address, status)`: 设置手动标记
- `setBossConfig(config)`: 设置评分配置

**日志输出**:
```
[HeliusMonitor] 更新 holder 数据并执行评分 { holderCount }
[HeliusMonitor] 过滤用户 { total, filtered, threshold }
[HeliusMonitor] 重新计算指标
[HeliusMonitor] 设置 Score< 阈值
[HeliusMonitor] 设置状态判断阈值
[HeliusMonitor] 设置手动标记 { address, status }
[HeliusMonitor] 设置评分配置
```

---

### 3. 修改 MetricsEngine.js ✅
**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/MetricsEngine.js`

**新增属性**:
- `filteredUsers`: 过滤后的用户地址集合（Set）

**修改方法**:
- `getMetrics()`: 只计算过滤后的用户（score < threshold）

**新增方法**:
- `setFilteredUsers(userSet)`: 设置过滤后的用户列表
- `updateWhaleAddresses(whaleSet)`: 更新庄家地址列表

**日志输出**:
```
[MetricsEngine] 设置过滤用户列表 { count }
[MetricsEngine] 更新庄家地址列表 { count }
[MetricsEngine] 计算指标完成 { 散户交易数, 跳过庄家交易数, 过滤后用户数, ... }
```

---

### 4. 修改 HeliusIntegration.js ✅
**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js`

**新增属性**:
- `scoreThreshold`: Score< 过滤阈值（默认 100）
- `statusThreshold`: 状态判断阈值（默认 50）

**修改方法**:
- `init()`: 加载 boss_config, score_threshold, status_threshold
- `hookHolderHandler()`: 调用 HeliusMonitor.updateHolderData() 执行评分

**新增方法**:
- `getDefaultConfig()`: 返回默认评分配置
- `setupConfigListener()`: 监听配置变化并更新 HeliusMonitor

**日志输出**:
```
[Helius集成] 开关状态: 启用/禁用
[Helius集成] Score< 阈值: 100
[Helius集成] 状态判断阈值: 50
[Helius集成] 评分配置已更新
[Helius集成] Score< 阈值已更新
[Helius集成] 状态判断阈值已更新
```

---

### 5. 更新 UI 组件 ✅
**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/sidepanel/App.jsx`

**新增状态**:
- `statusThreshold`: 状态判断阈值（默认 50）

**UI 改进**:
1. **状态阈值配置**: 在 Score< 筛选器旁边添加"状态≥"配置
   - 下拉选择：10, 20, 30, 40, 50, 60, 70, 80, 90, 100
   - 提示：分数 >= 此阈值显示为庄家，< 此阈值显示为散户
   - 自动保存到 Chrome storage

2. **分数显示增强**:
   - 鼠标悬停在分数上显示评分原因（tooltip）
   - 光标变为 help 样式

3. **配置持久化**:
   - 初始化时从 Chrome storage 加载 score_threshold 和 status_threshold
   - 修改时自动保存到 Chrome storage

---

## 数据流

```
GMGN Holder 数据
  ↓
HeliusIntegration.hookHolderHandler
  ↓
HeliusMonitor.updateHolderData(holders)
  ├─→ 1. metricsEngine.updateUsersInfo(holders)
  ├─→ 2. scoringEngine.calculateScores() [计算分数]
  ├─→ 3. 将分数存储到 userInfo
  ├─→ 4. filterUsersByScore() [过滤用户]
  ├─→ 5. metricsEngine.updateWhaleAddresses()
  ├─→ 6. metricsEngine.setFilteredUsers()
  └─→ 7. recalculateMetrics()
       ↓
  metricsEngine.getMetrics() [只计算过滤后的用户]
```

---

## 关键特性

### 1. 基于分数的庄家倾向系统
- ✅ 不是固定的庄家/散户分类
- ✅ 每个用户有一个分数（0-100+）
- ✅ 基于分数阈值判断状态

### 2. 8 个评分规则
1. 无来源（无 funding_account）
2. 同源（相同 funding_account）
3. 时间聚集（创建时间接近）
4. Low Gas（Gas 费用异常低）
5. 金额相似（买入金额接近）
6. 大额持仓（持仓量大或排名靠前）
7. SOL 余额相似（余额接近）
8. 同源时间聚类（资金来源时间接近）

### 3. 手动标记 +10 分
- ✅ 用户可以手动标记为庄家
- ✅ 手动标记增加 10 分
- ✅ 持久化到 Chrome storage

### 4. 灵活的过滤和计算
- ✅ Score< 阈值控制显示和计算范围
- ✅ 只计算分数低于阈值的用户
- ✅ 实时响应阈值变化

### 5. 可配置的状态判断
- ✅ 状态≥阈值判断庄家/散户
- ✅ 默认 50 分为庄家
- ✅ 可通过 UI 调整

---

## 测试指南

详细的测试指南请参考：[SCORING_TEST_LOG.md](./SCORING_TEST_LOG.md)

### 快速测试步骤

1. **打开 GMGN mint 页面**
2. **打开控制台**，查看日志输出
3. **检查配置加载**：
   ```
   [Helius集成] Score< 阈值: 100
   [Helius集成] 状态判断阈值: 50
   ```
4. **检查评分计算**：
   ```
   [ScoringEngine] 分数计算完成 { totalUsers, whaleCount, avgScore }
   ```
5. **检查用户过滤**：
   ```
   [HeliusMonitor] 过滤用户 { total, filtered, threshold }
   ```
6. **检查指标计算**：
   ```
   [MetricsEngine] 计算指标完成 { 过滤后用户数, ... }
   ```
7. **测试 UI**：
   - 查看用户列表中的分数
   - 鼠标悬停查看评分原因
   - 修改 Score< 阈值，观察列表变化
   - 修改状态≥阈值，观察状态变化
   - 手动标记用户，观察分数增加 10 分

---

## 配置说明

### Chrome Storage 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `boss_config` | Object | 见 getDefaultConfig() | 评分规则配置 |
| `score_threshold` | Number | 100 | Score< 过滤阈值 |
| `status_threshold` | Number | 50 | 状态判断阈值 |
| `manual_scores_{mint}` | Object | {} | 手动标记（按 mint 地址存储） |

### 评分配置示例

```javascript
{
  enable_no_source: true,
  weight_no_source: 10,
  enable_same_source: false,
  same_source_n: 5,
  same_source_exclude: '',
  weight_same_source: 10,
  enable_time_cluster: false,
  time_cluster_n: 5,
  time_cluster_j: 1,
  weight_time_cluster: 10,
  rule_gas: { enabled: false, threshold: 0.01, weight: 10 },
  rule_amount_sim: { enabled: false, count: 5, range: 100, weight: 10 },
  rule_large_holding: { enabled: false, top_pct: 10, min_usd: 1000, logic: 'OR', weight: 10 },
  rule_sol_balance: { enabled: false, count: 3, range: 0.1, weight: 10 },
  rule_source_time: { enabled: false, diff_sec: 10, count: 2, weight: 10 }
}
```

---

## 已知限制

1. **评分规则配置**: 目前只能通过代码修改默认配置，未来可以添加 UI 配置界面
2. **手动标记持久化**: 按 mint 地址存储，切换 mint 后需要重新标记
3. **实时更新**: 修改状态阈值后需要重新接收 holder 数据才会重新评分

---

## 后续优化建议

1. **添加评分规则配置 UI**: 允许用户在 SidePanel 中配置评分规则
2. **添加分数分布图表**: 可视化显示用户分数分布
3. **添加评分历史记录**: 记录用户分数变化历史
4. **优化手动标记**: 支持批量标记、导入导出
5. **添加预设配置**: 提供多种预设评分配置（保守、中等、激进）

---

## 文件清单

### 新建文件
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/ScoringEngine.js`
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/SCORING_TEST_LOG.md`
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/IMPLEMENTATION_SUMMARY.md` (本文件)

### 修改文件
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/HeliusMonitor.js`
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/MetricsEngine.js`
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js`
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/sidepanel/App.jsx`

### 复用文件
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/BossLogic.js` (未修改，被 ScoringEngine 引用)

---

## 总结

本次实施成功将 ContentScoreManager 的评分和庄家检测逻辑集成到 HeliusMonitor 体系中，实现了：

✅ **统一数据中心**: HeliusMonitor 成为唯一的数据处理中心
✅ **基于分数的庄家倾向系统**: 不是固定分类，而是分数评估
✅ **手动标记 +10 分**: 用户可以手动调整分数
✅ **灵活的过滤和计算**: Score< 阈值控制显示和计算范围
✅ **可配置的状态判断**: 基于分数阈值判断庄家/散户
✅ **完整的日志记录**: 便于测试和调试

架构简化的同时保持了评分系统的灵活性和可扩展性。
