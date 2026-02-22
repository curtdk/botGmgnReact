# ContentScoreManager 集成测试日志检查点

## 测试前准备

1. 打开 Chrome 开发者工具控制台
2. 打开 GMGN mint 页面（例如：https://gmgn.ai/sol/token/xxx）
3. 确保 Helius API 调用开关已启用

## 关键日志检查点

### 1. 配置加载（HeliusIntegration.init）

**预期日志**：
```
[Helius集成] 开关状态: 启用/禁用
[Helius集成] Score< 阈值: 100
[Helius集成] 状态判断阈值: 50
```

**检查项**：
- ✅ 配置是否正确加载
- ✅ 阈值是否符合预期

---

### 2. Holder 数据接收（HeliusIntegration.hookHolderHandler）

**预期日志**：
```
[Helius集成] 收到 X 个 holder 数据
[HeliusIntegration] 接收 GMGN Holder 数据
[HeliusIntegration] 传递数据到 HeliusMonitor
```

**检查项**：
- ✅ holder 数据数量是否正确
- ✅ 是否成功传递给 HeliusMonitor

---

### 3. 评分计算（ScoringEngine.calculateScores）

**预期日志**：
```
[ScoringEngine] 开始计算分数 { userCount: X, manualScoreCount: Y, statusThreshold: 50 }
[ScoringEngine] 统计数据收集完成 { fundingGroups: X, timeClusteredUsers: Y, sourceTimeClusteredUsers: Z }
[ScoringEngine] 分数计算完成 { totalUsers: X, whaleCount: Y, avgScore: Z }
```

**检查项**：
- ✅ 用户数量是否正确
- ✅ 庄家数量是否合理
- ✅ 平均分数是否合理

---

### 4. 用户过滤（HeliusMonitor.filterUsersByScore）

**预期日志**：
```
[HeliusMonitor] 过滤用户 { total: X, filtered: Y, threshold: 100 }
```

**检查项**：
- ✅ 过滤前用户总数
- ✅ 过滤后用户数量
- ✅ 过滤阈值是否正确

---

### 5. 指标计算（MetricsEngine.getMetrics）

**预期日志**：
```
[HeliusMonitor] 计算指标完成
[MetricsEngine] 计算指标完成 {
  散户交易数: X,
  跳过庄家交易数: Y,
  过滤后用户数: Z,
  已落袋: X.XXXX SOL,
  本轮下注: X.XXXX SOL,
  本轮成本: X.XXXX SOL,
  浮盈浮亏: X.XXXX SOL,
  活跃用户: X,
  已退出用户: Y
}
```

**检查项**：
- ✅ 过滤后用户数是否与步骤4一致
- ✅ 指标计算是否只包含过滤后的用户
- ✅ 跳过的庄家交易数是否合理

---

### 6. 配置更新（HeliusIntegration.setupConfigListener）

**测试步骤**：
1. 在 SidePanel 中修改 Score< 阈值
2. 在 SidePanel 中修改状态≥阈值

**预期日志**：
```
[Helius集成] Score< 阈值已更新: X
[HeliusMonitor] 设置 Score< 阈值: X
[HeliusMonitor] 重新计算指标

[Helius集成] 状态判断阈值已更新: X
[HeliusMonitor] 设置状态判断阈值: X
```

**检查项**：
- ✅ 阈值更新是否触发重新计算
- ✅ UI 是否实时更新

---

### 7. 手动标记（HeliusMonitor.setManualScore）

**测试步骤**：
1. 在插件列表中勾选某个用户的复选框（标记为庄家）
2. 取消勾选（标记为散户）

**预期日志**：
```
[HeliusMonitor] 设置手动标记: { address: 'xxx', status: '庄家' }
```

**检查项**：
- ✅ 手动标记是否保存到 Chrome storage
- ✅ 用户分数是否增加 10 分
- ✅ 用户状态是否更新

---

### 8. UI 显示验证

**检查项**：
- ✅ 用户列表中是否显示分数
- ✅ 鼠标悬停在分数上是否显示评分原因
- ✅ Score< 筛选器是否正常工作
- ✅ 状态≥阈值配置是否显示
- ✅ 修改阈值后列表是否实时更新

---

## 数据流完整性验证

### 完整数据流日志序列

```
1. [Helius集成] 收到 X 个 holder 数据
2. [HeliusIntegration] 传递数据到 HeliusMonitor
3. [HeliusMonitor] 更新 holder 数据并执行评分
4. [ScoringEngine] 开始计算分数
5. [ScoringEngine] 统计数据收集完成
6. [ScoringEngine] 分数计算完成
7. [HeliusMonitor] 过滤用户
8. [MetricsEngine] 设置过滤用户列表
9. [MetricsEngine] 更新庄家地址列表
10. [HeliusMonitor] 重新计算指标
11. [MetricsEngine] 计算指标完成
```

**检查项**：
- ✅ 日志顺序是否正确
- ✅ 数据是否在各组件间正确传递
- ✅ 没有错误或警告日志

---

## 常见问题排查

### 问题1：分数全部为 0

**可能原因**：
- boss_config 未正确加载
- 评分规则未启用

**检查**：
- 查看 `[ScoringEngine] 开始计算分数` 日志中的 config
- 确认至少有一个评分规则启用

### 问题2：过滤后用户数为 0

**可能原因**：
- scoreThreshold 设置过低（所有用户分数都 >= threshold）
- 没有用户数据

**检查**：
- 查看 `[HeliusMonitor] 过滤用户` 日志
- 确认 threshold 值是否合理

### 问题3：指标计算不正确

**可能原因**：
- filteredUsers 未正确设置
- whaleAddresses 未正确更新

**检查**：
- 查看 `[MetricsEngine] 设置过滤用户列表` 日志
- 查看 `[MetricsEngine] 更新庄家地址列表` 日志

---

## 测试完成后

请将以下信息提供给开发者：

1. **完整的控制台日志**（从页面加载到数据显示）
2. **UI 截图**（显示分数、阈值配置、用户列表）
3. **遇到的任何错误或异常**
4. **实际行为与预期行为的差异**

---

## 预期结果总结

✅ **配置加载**：正确加载 boss_config, score_threshold, status_threshold
✅ **数据接收**：成功接收 GMGN holder 数据
✅ **评分计算**：为每个用户计算分数和状态
✅ **用户过滤**：根据 Score< 阈值过滤用户
✅ **指标计算**：只计算过滤后的用户
✅ **UI 显示**：显示分数、评分原因、阈值配置
✅ **配置更新**：实时响应阈值变化
✅ **手动标记**：支持手动标记并增加 10 分
