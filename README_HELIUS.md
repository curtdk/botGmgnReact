# Helius 浏览器监控系统

多数据源 Signature 管理系统，用于监控 Solana 代币交易并计算实时指标。

## 🚀 快速开始

### 1. 加载插件
```
Chrome → chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序
```

### 2. 打开 GMGN 页面
```
https://gmgn.ai/sol/token/[mint地址]
```

### 3. 查看控制台
```
按 F12 → Console 标签
```

## 📊 实时指标

系统会在控制台显示：

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

## ✨ 核心特性

- ✅ 自动检测 mint 页面并启动监控
- ✅ 20 秒智能等待策略
- ✅ 多数据源整合（API + WebSocket + 插件）
- ✅ 每个交易只计算一次
- ✅ 实时更新指标
- ✅ IndexedDB 持久化缓存
- ✅ 控制台详细输出

## 📖 文档

- [快速开始](./docs/QUICK_START.md) - 3 步开始使用
- [测试指南](./docs/HELIUS_TESTING_GUIDE.md) - 详细测试文档
- [实施总结](./docs/IMPLEMENTATION_SUMMARY.md) - 完整实施说明

## 🔍 调试

在控制台输入：

```javascript
// 查看监控器
window.__heliusIntegration.getMonitor()

// 查看统计
window.__heliusIntegration.getMonitor().getStats()

// 查看指标
window.__heliusIntegration.getMonitor().getMetrics()
```

## 📁 项目结构

```
src/helius/              # 核心模块
├── SignatureManager.js  # Signature 状态管理
├── CacheManager.js      # IndexedDB 缓存
├── MetricsEngine.js     # 指标计算引擎
├── DataFetcher.js       # RPC 数据获取
└── HeliusMonitor.js     # 主监控器

src/content/
└── HeliusIntegration.js # 插件集成

docs/                    # 文档
├── QUICK_START.md
├── HELIUS_TESTING_GUIDE.md
└── IMPLEMENTATION_SUMMARY.md
```

## 🎯 关键指标说明

| 指标 | 说明 |
|------|------|
| 已落袋 | 已退出用户的实现盈亏 |
| 本轮下注 | 当前持有者的买入总额 |
| 本轮成本 | 当前持有者的净成本 |
| 浮盈浮亏 | 当前持有者的未实现盈亏 |
| 当前价格 | 最新交易价格 |
| 活跃用户 | 当前持有代币的用户数 |
| 已退出 | 已卖出全部代币的用户数 |

## 🐛 问题排查

1. 检查控制台是否有错误信息
2. 确认 URL 格式正确（包含 `/sol/token/`）
3. 查看 [测试指南](./docs/HELIUS_TESTING_GUIDE.md)

## 📝 技术栈

- 浏览器 WebSocket API
- IndexedDB
- Fetch API
- Chrome Extension APIs

## 🎓 设计特点

- **智能去重**: 每个 signature 只处理一次
- **批量优化**: 并发控制的批量获取
- **缓存策略**: IndexedDB 持久化
- **实时性**: WebSocket 事件驱动
- **可观测性**: 详细控制台输出
