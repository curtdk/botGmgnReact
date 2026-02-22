# Score< 过滤问题调试日志增强

## 问题描述

用户报告了两个问题:
1. **过滤不准确**: 选择 Score< 10 时,分数等于 20 的用户也显示出来
2. **指标不更新**: 切换 Score< 阈值后,📊 Helius 实时指标没有变化

## 日志分析

从用户提供的日志 `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/dataweb/浏览器日志.html` 中可以看到:

### 关键日志片段

```
[184] 02:17:54 [HeliusIntegration] 发送数据到 Sidepanel
    发送 6 个过滤后的用户数据到 Sidepanel UI
    数据: {
      "totalUsers": 7,
      "filteredUsers": 6,
      "whaleCount": 0,
      "retailCount": 6,
      "scoreThreshold": 10
    }

[193] 02:17:55 [HeliusMonitor] 步骤4: 过滤用户
    根据阈值 10 过滤，保留 7 个用户
    数据: {
      "filteredCount": 7,
      "threshold": 10
    }
```

### 问题分析

1. **过滤数量不一致**:
   - HeliusMonitor 说保留了 7 个用户 (filteredCount: 7)
   - HeliusIntegration 说发送了 6 个用户 (filteredUsers: 6)
   - 这说明有 1 个用户在某个环节被过滤掉了

2. **缺少分数详情**:
   - 日志中没有显示每个用户的实际分数
   - 无法确认是否真的有分数 >= 10 的用户被发送到 UI

3. **无法追踪数据流**:
   - 无法看到从 ScoringEngine → HeliusMonitor → HeliusIntegration → UI 的完整数据流
   - 无法确认每个环节的数据是否正确

## 修复方案

### 修复 1: 增强 ScoringEngine 日志

**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/ScoringEngine.js:98-108`

**修改内容**:
```javascript
const avgScore = Array.from(scoreMap.values()).reduce((sum, s) => sum + s.score, 0) / scoreMap.size;

// 详细日志：显示所有用户的分数
const allUserScores = Array.from(scoreMap.entries()).map(([address, data]) => ({
  address: address.substring(0, 8) + '...',
  score: data.score,
  status: data.status,
  reasons: data.reasons.join(', ')
}));

console.log('[ScoringEngine] 所有用户分数详情:', allUserScores);

console.log('[ScoringEngine] 分数计算完成', {
  totalUsers: scoreMap.size,
  whaleCount: whaleAddresses.size,
  retailCount: scoreMap.size - whaleAddresses.size,
  avgScore: avgScore.toFixed(2),
  scoreDistribution: scoreDistribution
});
```

**效果**:
- ✅ 显示每个用户的地址、分数、状态、评分原因
- ✅ 可以确认分数计算是否正确
- ✅ 可以看到哪些用户被评为庄家/散户

### 修复 2: 增强 HeliusIntegration 日志

**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js:696-728`

**修改内容**:
```javascript
sendDataToSidepanel() {
  if (!this.monitor) return;

  const userInfo = this.monitor.metricsEngine.userInfo;
  const filteredUsers = this.monitor.metricsEngine.filteredUsers;

  // 只发送过滤后的用户（score < threshold）
  const holdersData = Object.values(userInfo)
    .filter(info => filteredUsers.has(info.owner))
    .map(info => ({
      ...info,
      status: info.status || '散户',
      score: info.score || 0,
      score_reasons: info.score_reasons || []
    }));

  // 统计庄家和散户数量
  const whaleCount = holdersData.filter(h => h.status === '庄家').length;
  const retailCount = holdersData.filter(h => h.status === '散户').length;

  // 详细日志：显示每个用户的分数
  const userScores = holdersData.map(h => ({
    address: h.owner ? h.owner.substring(0, 8) + '...' : 'unknown',
    score: h.score,
    status: h.status
  }));

  console.log('[HeliusIntegration] 发送给 UI 的用户分数详情:', userScores);

  // 记录日志
  dataFlowLogger.log(
    'HeliusIntegration',
    '发送数据到 Sidepanel',
    `发送 ${holdersData.length} 个过滤后的用户数据到 Sidepanel UI`,
    {
      totalUsers: Object.keys(userInfo).length,
      filteredUsers: holdersData.length,
      whaleCount: whaleCount,
      retailCount: retailCount,
      scoreThreshold: this.monitor.scoreThreshold,
      userScores: userScores  // ← 新增：显示每个用户的分数
    }
  );
  // ...
}
```

**效果**:
- ✅ 显示发送给 UI 的每个用户的地址、分数、状态
- ✅ 可以确认是否有分数 >= threshold 的用户被发送
- ✅ 可以追踪数据从后端到 UI 的流转

## 验证测试

### 测试步骤

1. 打开 GMGN mint 页面
2. 打开 Sidepanel
3. 点击"持有人启动"
4. 等待数据加载完成
5. 切换 Score< 下拉框到 10
6. 打开浏览器控制台
7. 查看日志输出

### 预期日志输出

#### 1. ScoringEngine 日志

```javascript
[ScoringEngine] 所有用户分数详情: [
  {
    address: "AAAA8oj1...",
    score: 0,
    status: "散户",
    reasons: ""
  },
  {
    address: "DdZG8dw1...",
    score: 0,
    status: "散户",
    reasons: ""
  },
  {
    address: "4VTchjB1...",
    score: 20,
    status: "散户",
    reasons: "同源(+10), 时间聚类(+10)"
  },
  // ... 其他用户
]
```

#### 2. HeliusIntegration 日志

```javascript
[HeliusIntegration] 发送给 UI 的用户分数详情: [
  {
    address: "AAAA8oj1...",
    score: 0,
    status: "散户"
  },
  {
    address: "DdZG8dw1...",
    score: 0,
    status: "散户"
  },
  // 注意：分数为 20 的用户不应该出现在这里（因为 threshold = 10）
]
```

### 验证要点

1. **分数计算正确性**:
   - 检查 ScoringEngine 日志中每个用户的分数
   - 确认分数计算逻辑是否正确
   - 确认评分原因是否合理

2. **过滤逻辑正确性**:
   - 检查 HeliusIntegration 日志中发送的用户
   - 确认所有用户的分数都 < threshold
   - 如果有分数 >= threshold 的用户,说明过滤逻辑有问题

3. **数据一致性**:
   - 对比 ScoringEngine 和 HeliusIntegration 的用户列表
   - 确认过滤前后的用户数量是否一致
   - 确认没有用户在传递过程中丢失或增加

## 可能的问题原因

### 原因 1: 分数计算错误

**症状**: ScoringEngine 日志显示某些用户的分数 >= threshold,但这些用户仍然被发送到 UI

**可能原因**:
- BossLogic.js 的评分规则有问题
- 配置参数不正确
- 统计数据收集有误

**解决方案**:
- 检查 BossLogic.js 的 calculateUserScore 方法
- 检查 boss_config 配置
- 检查 collectStatistics 方法

### 原因 2: 过滤逻辑错误

**症状**: ScoringEngine 日志显示用户分数正确,但 HeliusIntegration 日志显示发送了不应该发送的用户

**可能原因**:
- filterUsersByScore 方法的条件错误 (应该是 `<` 而不是 `<=`)
- filteredUsers Set 没有正确更新
- sendDataToSidepanel 的过滤逻辑有误

**解决方案**:
- 检查 HeliusMonitor.filterUsersByScore (line 914-927)
- 检查 HeliusMonitor.setScoreThreshold (line 945-971)
- 检查 HeliusIntegration.sendDataToSidepanel (line 696-753)

### 原因 3: UI 端有额外数据源

**症状**: 后端日志显示发送的数据正确,但 UI 显示了额外的用户

**可能原因**:
- UI 端有其他地方在更新 items 数据
- 有多个消息源在发送 UI_RENDER_DATA
- UI 端有缓存或旧数据

**解决方案**:
- 检查 App.jsx 的 handleMessage 方法 (line 555-576)
- 检查是否有其他地方调用 setItems
- 清除浏览器缓存和 Chrome storage

### 原因 4: 指标计算使用了错误的用户列表

**症状**: 切换 Score< 阈值后,指标没有变化

**可能原因**:
- MetricsEngine.getMetrics 没有使用 filteredUsers
- recalculateMetrics 没有被调用
- 指标计算逻辑有误

**解决方案**:
- 检查 MetricsEngine.getMetrics 方法
- 确认 filteredUsers 被正确使用
- 确认 setScoreThreshold 调用了 recalculateMetrics

## 下一步行动

1. **重新测试**:
   - 刷新页面
   - 重新启动持有人监听
   - 切换 Score< 阈值
   - 导出新的日志

2. **分析新日志**:
   - 查看 ScoringEngine 的用户分数详情
   - 查看 HeliusIntegration 发送的用户分数详情
   - 对比两者,找出差异

3. **定位问题**:
   - 如果 ScoringEngine 的分数就不对,问题在评分逻辑
   - 如果 ScoringEngine 的分数对,但 HeliusIntegration 发送的不对,问题在过滤逻辑
   - 如果后端都对,但 UI 显示不对,问题在 UI 端

4. **修复问题**:
   - 根据定位结果,修复相应的代码
   - 重新测试验证

## 相关文档

- [Score过滤闪烁和状态阈值删除修复.md](./Score过滤闪烁和状态阈值删除修复.md)
- [ContentScoreManager集成完成总结.md](./ContentScoreManager集成完成总结.md)

## 总结

通过增强日志,我们可以:

1. ✅ **追踪完整数据流**: 从 ScoringEngine → HeliusMonitor → HeliusIntegration → UI
2. ✅ **显示每个用户的分数**: 可以确认分数计算和过滤是否正确
3. ✅ **快速定位问题**: 通过对比不同环节的日志,找出问题所在
4. ✅ **验证修复效果**: 修复后可以通过日志确认问题是否解决

**下一步**: 请用户重新测试并提供新的日志,我们将根据新日志进一步分析和修复问题。

---

**修改日期**: 2026-02-21
**修改者**: Claude Sonnet 4.5
