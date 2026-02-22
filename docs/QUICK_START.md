# 🚀 快速开始 - Helius 浏览器监控系统

## 3 步开始使用

### 1️⃣ 加载插件

```bash
# 在 Chrome 浏览器中
1. 打开 chrome://extensions/
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择: /www/wwwroot/py/pumpfunbot/gmgn-extension-react
```

### 2️⃣ 打开 GMGN 页面

访问任意代币页面，例如：
```
https://gmgn.ai/sol/token/GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
```

### 3️⃣ 打开控制台查看

按 `F12` 打开控制台，你将看到：

```
============================================================
[Helius集成] 检测到 Mint: GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
============================================================

--- 启动 Helius 浏览器监控系统 ---
目标代币 (Mint): GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood

[WebSocket] 已连接，开始订阅实时日志...
[SignatureManager] 开始 20 秒等待期...
```

## 📊 查看实时指标

等待约 20-30 秒后，你将看到：

```
============================================================
📊 实时指标更新
============================================================
💰 已落袋: 12.3456 SOL
🎯 本轮下注: 45.6789 SOL
💵 本轮成本: 33.3333 SOL
📈 浮盈浮亏: 5.4321 SOL
💲 当前价格: 0.0000038612 SOL/Token
👥 活跃用户: 234
🚪 已退出: 156
✅ 已处理: 1290 笔交易
============================================================
```

## 🔍 调试命令

在控制台输入以下命令：

```javascript
// 查看监控器
window.__heliusIntegration.getMonitor()

// 查看统计
window.__heliusIntegration.getMonitor().getStats()

// 查看指标
window.__heliusIntegration.getMonitor().getMetrics()
```

## 📖 完整文档

详细文档请查看: [docs/HELIUS_TESTING_GUIDE.md](./HELIUS_TESTING_GUIDE.md)

## ✅ 核心特性

- ✅ 自动检测 mint 页面并启动监控
- ✅ 20 秒智能等待策略
- ✅ 多数据源整合（API + WebSocket + 插件）
- ✅ 每个交易只计算一次
- ✅ 实时更新指标
- ✅ IndexedDB 持久化缓存
- ✅ 控制台详细输出

## 🎯 关键指标

| 指标 | 说明 |
|------|------|
| 已落袋 | 已退出用户的实现盈亏 |
| 本轮下注 | 当前持有者的买入总额 |
| 本轮成本 | 当前持有者的净成本 |
| 浮盈浮亏 | 当前持有者的未实现盈亏 |
| 当前价格 | 最新交易价格 |
| 活跃用户 | 当前持有代币的用户数 |
| 已退出 | 已卖出全部代币的用户数 |

## 🐛 遇到问题？

1. 检查控制台是否有错误信息
2. 确认 URL 格式正确（包含 `/sol/token/`）
3. 查看完整文档: [HELIUS_TESTING_GUIDE.md](./HELIUS_TESTING_GUIDE.md)
