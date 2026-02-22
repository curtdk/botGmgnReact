# Helius 浏览器监控系统 - 测试与使用文档

## 📋 概述

这是一个浏览器版的多数据源 Signature 管理系统，用于监控 Solana 代币交易并计算实时指标。

## 🎯 核心功能

1. **多数据源整合**: 整合初始 API 获取、WebSocket 实时监听、GMGN 插件数据
2. **智能去重**: 每个 signature 只处理一次，避免重复计算
3. **20 秒策略**: 先收集数据，再批量获取，最后计算
4. **实时更新**: 新交易立即处理并更新指标
5. **持久化缓存**: 使用 IndexedDB 减少 API 调用

## 🚀 如何测试

### 步骤 1: 安装插件

1. 打开 Chrome 浏览器
2. 进入 `chrome://extensions/`
3. 开启"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择项目目录: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react`

### 步骤 2: 打开 GMGN 页面

1. 访问 GMGN 网站: https://gmgn.ai
2. 打开任意代币的 mint 页面，例如:
   ```
   https://gmgn.ai/sol/token/GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
   ```

### 步骤 3: 打开浏览器控制台

1. 按 `F12` 或右键点击"检查"
2. 切换到 "Console" 标签页
3. 你将看到以下输出：

## 📊 控制台输出说明

### 初始化阶段

```
[Helius集成] 初始化...
[Helius集成] Hook 事件监听已设置
[Helius集成] 已就绪，等待 mint 页面...
============================================================
[Helius集成] 检测到 Mint: GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
============================================================

--- 启动 Helius 浏览器监控系统 ---
目标代币 (Mint): GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
```

### 缓存初始化

```
[CacheManager] 数据库初始化成功
```

### WebSocket 连接

```
[WebSocket] 连接中...
[WebSocket] 已连接，开始订阅实时日志...
```

### 获取 Signatures

```
[历史] 正在获取交易签名列表 (GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood)...
[缓存] 发现本地缓存 1234 条签名。将增量拉取 (直到: 3Svd8JV...)
[历史] 增量获取新签名: 56 条
[初始化] 添加了 1290 个 signatures 到管理器
```

### 20 秒等待期

```
[SignatureManager] 开始 20 秒等待期...
[等待] 20秒 | 总数: 1290 | 有数据: 0 | 需获取: 1290
[等待] 15秒 | 总数: 1290 | 有数据: 45 | 需获取: 1245
[等待] 10秒 | 总数: 1290 | 有数据: 120 | 需获取: 1170
[等待] 5秒 | 总数: 1290 | 有数据: 230 | 需获取: 1060
[等待] 0秒 | 总数: 1290 | 有数据: 350 | 需获取: 940
[SignatureManager] 等待期结束，耗时 20.0 秒
```

### 插件数据输入

```
[GMGN Hook] 提取了 50 个 tx_hash
[Helius集成] 收到 50 个 signatures (来源: plugin)
```

### 批量获取

```
[获取] 需要获取 940 个交易...
[CacheManager] 从缓存加载了 500/940 个交易
[获取] 500 个来自缓存，440 个需要 API
[获取] 进度: 100 / 440
[获取] 进度: 200 / 440
[获取] 进度: 300 / 440
[获取] 进度: 400 / 440
[获取] 进度: 440 / 440
```

### 首次计算

```
[首次计算] 开始处理所有交易...
[首次计算] 将处理 1290 个交易（按时间倒排序）
[首次计算] 完成！处理了 1290 个交易

========== 指标统计 ==========
已落袋: 12.3456 SOL
本轮下注: 45.6789 SOL
本轮成本: 33.3333 SOL
浮盈浮亏: 5.4321 SOL
当前价格: 0.0000038612 SOL/Token
活跃用户: 234
已退出用户: 156
已处理交易: 1290
==============================

[系统] 进入实时模式，开始监听新交易...
```

### 实时更新

```
[实时] 获取新交易: 4zLUapo...
[实时] 处理新交易: 4zLUapo...

============================================================
📊 实时指标更新
============================================================
💰 已落袋: 12.4567 SOL
🎯 本轮下注: 45.8901 SOL
💵 本轮成本: 33.4334 SOL
📈 浮盈浮亏: 5.5432 SOL
💲 当前价格: 0.0000038700 SOL/Token
👥 活跃用户: 235
🚪 已退出: 156
✅ 已处理: 1291 笔交易
============================================================

📋 Signature 统计:
   总数: 1291
   有数据: 1291
   需获取: 0
   已处理: 1291
   未处理: 0
   来源分布: 初始=1290, WS=1, 插件=50
```

## 🔍 关键指标说明

### 交易指标

- **已落袋 (yiLuDai)**: 已退出用户的实现盈亏（卖出收入 - 买入成本）
- **本轮下注 (benLunXiaZhu)**: 当前持有者的买入总额
- **本轮成本 (benLunChengBen)**: 当前持有者的净成本（买入 - 卖出）
- **浮盈浮亏 (floatingPnL)**: 当前持有者的未实现盈亏（当前价值 - 成本）
- **当前价格 (currentPrice)**: 最新交易价格（SOL/Token）

### 用户统计

- **活跃用户 (activeCount)**: 当前持有代币的用户数
- **已退出 (exitedCount)**: 已卖出全部代币的用户数
- **已处理 (totalProcessed)**: 已处理的交易总数

### Signature 统计

- **总数**: 发现的 signature 总数
- **有数据**: 已获得交易详情的 signature 数
- **需获取**: 还需要通过 API 获取的 signature 数
- **已处理**: 已计算过的 signature 数
- **未处理**: 还未计算的 signature 数
- **来源分布**: 各数据源提供的 signature 数量

## 🐛 调试技巧

### 1. 查看当前监控器状态

在控制台输入：
```javascript
window.__heliusIntegration.getMonitor()
```

### 2. 手动触发指标显示

```javascript
const monitor = window.__heliusIntegration.getMonitor();
if (monitor) {
  monitor.metricsEngine.printMetrics();
}
```

### 3. 查看 Signature 统计

```javascript
const monitor = window.__heliusIntegration.getMonitor();
if (monitor) {
  console.log(monitor.getStats());
}
```

### 4. 查看 IndexedDB 数据

1. 在 DevTools 中切换到 "Application" 标签
2. 展开 "IndexedDB"
3. 找到 "helius_cache" 数据库
4. 查看 "transactions" 和 "signatures" 对象存储

### 5. 清理缓存

```javascript
const monitor = window.__heliusIntegration.getMonitor();
if (monitor) {
  await monitor.cacheManager.cleanup(0); // 清理所有缓存
}
```

## ✅ 验证清单

### 功能验证

- [ ] 打开 mint 页面后自动启动监控
- [ ] 20 秒等待期正常工作
- [ ] 插件数据正确提取 tx_hash
- [ ] WebSocket 实时接收新交易
- [ ] 首次计算按时间倒排序
- [ ] 实时更新正常工作
- [ ] 指标计算准确
- [ ] 无重复处理（每个 signature 只计算一次）

### 性能验证

- [ ] API 调用减少 >50%（大部分数据来自插件/缓存）
- [ ] 初始加载时间 <30 秒
- [ ] 实时延迟 <1 秒
- [ ] 内存使用合理（<100MB）

### 持久化验证

- [ ] 刷新页面后从缓存加载数据
- [ ] 跨浏览器重启数据仍然存在
- [ ] IndexedDB 正常工作

## 🔧 常见问题

### Q1: 控制台没有输出？

**A**: 检查：
1. 插件是否正确加载
2. 是否在 mint 页面（URL 包含 `/sol/token/`）
3. 控制台是否过滤了日志（确保显示所有级别）

### Q2: 一直显示"等待 mint 页面"？

**A**: 检查：
1. URL 格式是否正确
2. `getMintFromPage()` 函数是否正常工作
3. 在控制台手动调用: `getMintFromPage()`

### Q3: WebSocket 连接失败？

**A**: 检查：
1. 网络连接是否正常
2. Helius API Key 是否有效
3. 是否被防火墙拦截

### Q4: 指标不更新？

**A**: 检查：
1. 是否有新交易发生
2. WebSocket 是否正常连接
3. 插件是否正确捕获数据

### Q5: API 调用过多？

**A**: 检查：
1. 缓存是否正常工作
2. 插件是否正确提供数据
3. 20 秒等待期是否正常

## 📝 测试场景

### 场景 1: 首次访问（无缓存）

1. 清除浏览器数据
2. 打开 mint 页面
3. 观察完整的初始化流程
4. 验证 20 秒等待策略
5. 验证首次计算

### 场景 2: 二次访问（有缓存）

1. 关闭并重新打开页面
2. 观察缓存加载
3. 验证 API 调用减少
4. 验证指标一致性

### 场景 3: 实时更新

1. 等待系统进入实时模式
2. 等待新交易发生
3. 观察实时处理
4. 验证指标更新

### 场景 4: 页面切换

1. 从一个 mint 切换到另一个 mint
2. 观察旧监控器停止
3. 观察新监控器启动
4. 验证数据隔离

## 🎓 进阶使用

### 自定义回调

```javascript
const monitor = window.__heliusIntegration.getMonitor();
if (monitor) {
  monitor.onMetricsUpdate = (metrics) => {
    // 自定义处理
    console.log('自定义指标处理:', metrics);
  };
}
```

### 导出数据

```javascript
const monitor = window.__heliusIntegration.getMonitor();
if (monitor) {
  const metrics = monitor.getMetrics();
  const stats = monitor.getStats();

  // 导出为 JSON
  const data = { metrics, stats };
  console.log(JSON.stringify(data, null, 2));
}
```

## 📞 支持

如有问题，请查看控制台输出的详细日志，或联系开发团队。
