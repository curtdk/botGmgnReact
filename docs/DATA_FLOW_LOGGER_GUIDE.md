# 数据流日志系统使用指南

## 概述

数据流日志系统用于追踪和验证数据来源，确保 HeliusMonitor 是唯一的数据获取源，contentManager 只负责接收和展示数据。

## 功能特点

1. **独立日志文件**：日志可以导出为文本文件，方便查看和分析
2. **开关控制**：可以随时启用/禁用日志记录，节省性能
3. **中文日志**：所有日志内容使用中文，便于理解
4. **数据来源追踪**：清晰记录每个数据的来源和流向
5. **统计信息**：提供日志统计，快速了解数据流情况

## 使用方法

### 1. 启用日志

1. 打开 Chrome 扩展的 SidePanel
2. 找到"📋 数据流日志"区域
3. 勾选"启用日志"复选框

### 2. 查看日志

有两种方式查看日志：

#### 方式一：控制台查看（推荐）
1. 打开 Chrome 开发者工具（F12）
2. 切换到 Console 标签
3. 日志会以彩色格式显示，不同来源使用不同颜色：
   - 🟢 HeliusMonitor（绿色）
   - 🔵 HeliusIntegration（蓝色）
   - 🟠 contentManager（橙色）
   - 🟣 hook.js（紫色）

#### 方式二：SidePanel 查看
1. 点击"查看日志"按钮
2. 弹出日志查看器，显示日志统计信息

### 3. 导出日志

1. 点击"导出"按钮
2. 日志会自动下载为文本文件
3. 文件名格式：`数据流日志_YYYY-MM-DDTHH-MM-SS.txt`

### 4. 清空日志

1. 点击"清空"按钮
2. 所有日志记录将被清除

## 日志内容说明

### 关键日志事件

#### 1. HeliusMonitor 自动启动
```
[HeliusIntegration] HeliusMonitor 自动启动
检测到 mint 页面，自动启动 HeliusMonitor
```
**说明**：验证 HeliusMonitor 在检测到 mint 页面时自动启动

#### 2. 接收 GMGN Holder 数据
```
[HeliusIntegration] 接收 GMGN Holder 数据
从 hook.js 接收到 X 个 holder 数据
```
**说明**：HeliusIntegration 从 hook.js 接收到 holder 数据

#### 3. 传递数据到 HeliusMonitor
```
[HeliusIntegration] 传递数据到 HeliusMonitor
将 X 个 holder 传递给 HeliusMonitor.metricsEngine
```
**说明**：HeliusIntegration 将数据传递给 HeliusMonitor 处理

#### 4. 接收 GMGN Trade 数据
```
[HeliusIntegration] 接收 GMGN Trade 数据
从 hook.js 接收到 X 个交易数据
```
**说明**：HeliusIntegration 从 hook.js 接收到交易数据

#### 5. 传递交易到 HeliusMonitor
```
[HeliusIntegration] 传递交易到 HeliusMonitor
将新交易 XXXXXXXX... 传递给 HeliusMonitor.signatureManager
```
**说明**：每个新交易都会被传递给 HeliusMonitor

#### 6. 分发数据到 contentManager
```
[HeliusIntegration] 分发数据到 contentManager
将 X 个用户数据分发给 contentManager
```
**说明**：HeliusMonitor 处理完数据后，通过 HeliusIntegration 分发给 contentManager

#### 7. contentManager 接收数据
```
[contentManager] 接收 HeliusMonitor 数据
从 HeliusIntegration 接收到 X 个用户数据（只接收，不获取）
```
**说明**：contentManager 只接收数据，不主动获取数据

#### 8. 更新数据并发送给 UI
```
[HeliusIntegration] 更新数据并发送给 UI
更新 dataMap 并将 X 个用户数据发送给 UI
```
**说明**：HeliusIntegration 直接管理 dataMap，更新数据后直接发送给 UI（不再通过 contentManager）

#### 9. 跳过庄家交易
```
[HeliusMonitor] 跳过庄家交易
跳过庄家 XXXXXXXX... 的交易，不计入指标计算
```
**说明**：HeliusMonitor 在处理交易时，识别出庄家地址，跳过该交易，不计入"已落袋"等指标

#### 10. 处理散户交易
```
[HeliusMonitor] 处理散户交易
处理散户 XXXXXXXX... 的交易，计入指标计算
```
**说明**：HeliusMonitor 处理散户交易，计入"已落袋"、"本轮下注"等指标

#### 11. 计算指标完成
```
[HeliusMonitor] 计算指标完成
指标计算完成：只计算散户交易，跳过庄家交易
数据: {
  散户交易数: 150,
  跳过庄家交易数: 5,
  已落袋: "12.5000 SOL",
  本轮下注: "45.2000 SOL",
  本轮成本: "38.7000 SOL",
  浮盈浮亏: "6.5000 SOL",
  活跃用户: 145,
  已退出用户: 5
}
```
**说明**：指标计算完成，显示详细统计信息，确认只计算了散户交易

## 验证数据流

### 正确的数据流

```
hook.js (拦截 GMGN API)
    ↓
HeliusIntegration (接收数据)
    ↓
HeliusMonitor (处理数据、计算指标)
    ↓
HeliusIntegration (更新 dataMap 并发送给 UI)
    ↓
UI (SidePanel 直接接收数据)
```

**注意**：ContentScoreManager 已被移除，HeliusIntegration 现在直接管理数据并发送给 UI。

### 验证步骤

1. **启用日志**
2. **打开一个 GMGN mint 页面**
3. **观察日志输出**，应该看到以下顺序：
   - `[HeliusIntegration] HeliusMonitor 自动启动`
   - `[HeliusIntegration] 接收 GMGN Holder 数据`
   - `[HeliusIntegration] 传递数据到 HeliusMonitor`
   - `[HeliusIntegration] 接收 GMGN Trade 数据`
   - `[HeliusIntegration] 传递交易到 HeliusMonitor`
   - `[HeliusMonitor] 跳过庄家交易`（如果有庄家）
   - `[HeliusMonitor] 处理散户交易`（每个散户交易）
   - `[HeliusMonitor] 计算指标完成`（显示统计信息）
   - `[HeliusIntegration] 更新数据并发送给 UI`

4. **检查日志统计**
   - 点击"查看日志"按钮
   - 查看"来源"统计
   - 应该看到：
     - `HeliusIntegration=X`（数据接收、传递和发送）
     - `HeliusMonitor=Y`（数据处理和指标计算）
   - **不应该看到 contentManager 的日志**（已被移除）

## 常见问题

### Q1: 日志太多，影响性能怎么办？
A: 日志系统默认最多保存 1000 条记录，超过会自动删除最旧的。测试完成后可以关闭日志开关。

### Q2: 如何确认数据流正确？
A: 查看日志，应该只看到：
- HeliusIntegration 接收数据
- HeliusMonitor 处理数据
- HeliusIntegration 发送数据给 UI

不应该看到 contentManager 的日志（已被移除）。

### Q3: 日志文件在哪里？
A: 点击"导出"按钮后，日志文件会自动下载到浏览器的默认下载目录。

### Q4: 可以在生产环境使用吗？
A: 可以，但建议只在需要调试时启用。日常使用时关闭日志以节省性能。

## 调试技巧

1. **使用控制台过滤**：在 Chrome 控制台中输入 `数据流日志` 可以过滤出所有日志
2. **查看彩色日志**：不同来源使用不同颜色，便于快速识别
3. **导出日志分析**：对于复杂问题，导出日志文件后用文本编辑器分析
4. **对比统计信息**：查看不同来源的日志数量，判断数据流是否正常

## 示例日志输出

```
[数据流日志] 14:23:45 [HeliusIntegration] HeliusMonitor 自动启动
    检测到 mint 页面，自动启动 HeliusMonitor
    数据: {"mint":"7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr","apiEnabled":true}

[数据流日志] 14:23:46 [HeliusIntegration] 接收 GMGN Holder 数据
    从 hook.js 接收到 150 个 holder 数据
    数据: {"count":150,"hasMonitor":true}

[数据流日志] 14:23:46 [HeliusIntegration] 传递数据到 HeliusMonitor
    将 150 个 holder 传递给 HeliusMonitor.metricsEngine
    数据: {"count":150}

[数据流日志] 14:23:47 [HeliusIntegration] 分发数据到 contentManager
    将 150 个用户数据分发给 contentManager
    数据: {"userCount":150,"whaleCount":5,"retailCount":145}

[数据流日志] 14:23:47 [contentManager] 接收 HeliusMonitor 数据
    从 HeliusIntegration 接收到 150 个用户数据（只接收，不获取）
    数据: {"userCount":150,"whaleCount":5,"retailCount":145}

[数据流日志] 14:23:47 [contentManager] 更新本地数据
    更新 contentManager.dataMap，共 150 个用户
    数据: {"dataMapSize":150}
```

## 总结

数据流日志系统帮助你：
1. ✅ 验证 HeliusMonitor 是唯一的数据获取源
2. ✅ 确认 HeliusIntegration 直接管理数据并发送给 UI
3. ✅ 追踪数据流向，发现潜在问题
4. ✅ 提供详细的调试信息
5. ✅ 验证指标计算只包含散户交易

使用日志系统可以确保系统架构正确，数据流清晰，避免重复获取数据浪费 API 调用。

## 架构变更说明

**v2.0 架构（当前）**：
- ✅ 移除了 ContentScoreManager
- ✅ HeliusIntegration 直接管理 dataMap 和 statusMap
- ✅ HeliusMonitor 是唯一的数据处理中心
- ✅ 数据流更简洁：hook.js → HeliusIntegration → HeliusMonitor → HeliusIntegration → UI

**优势**：
- 更清晰的数据来源
- 减少中间层
- 更容易追踪数据流
- 更好的性能

## 验证指标计算（只计算散户）

### 目的

确认"已落袋"、"本轮下注"、"本轮成本"、"浮盈浮亏"等指标只计算散户交易，不包含庄家交易。

### 验证步骤

1. **启用日志**
2. **打开一个有庄家的 mint 页面**
3. **观察日志输出**，重点关注：

#### 关键日志 1：跳过庄家交易
```
[数据流日志] 14:23:47 [HeliusMonitor] 跳过庄家交易
    跳过庄家 ABC12345... 的交易，不计入指标计算
    数据: {
      "address": "ABC12345...",
      "signature": "XYZ789...",
      "skippedCount": 1,
      "source": "GMGN"
    }
```

**验证点**：
- ✅ 看到"跳过庄家交易"日志
- ✅ skippedCount 在增加
- ✅ 庄家地址被正确识别

#### 关键日志 2：处理散户交易
```
[数据流日志] 14:23:48 [HeliusMonitor] 处理散户交易
    处理散户 DEF67890... 的交易，计入指标计算
    数据: {
      "address": "DEF67890...",
      "signature": "UVW456...",
      "event": "buy",
      "solChange": "-0.500000",
      "tokenChange": "1000.00",
      "processedCount": 1,
      "source": "GMGN"
    }
```

**验证点**：
- ✅ 看到"处理散户交易"日志
- ✅ processedCount 在增加
- ✅ 散户交易被正确处理

#### 关键日志 3：计算指标完成
```
[数据流日志] 14:23:50 [HeliusMonitor] 计算指标完成
    指标计算完成：只计算散户交易，跳过庄家交易
    数据: {
      "散户交易数": 150,
      "跳过庄家交易数": 5,
      "已落袋": "12.5000 SOL",
      "本轮下注": "45.2000 SOL",
      "本轮成本": "38.7000 SOL",
      "浮盈浮亏": "6.5000 SOL",
      "活跃用户": 145,
      "已退出用户": 5
    }
```

**验证点**：
- ✅ 散户交易数 = 处理的交易总数
- ✅ 跳过庄家交易数 > 0（如果有庄家）
- ✅ 指标只基于散户交易计算
- ✅ 总交易数 = 散户交易数 + 跳过庄家交易数

### 验证公式

```
总交易数 = 散户交易数 + 跳过庄家交易数
已落袋 = Σ(已退出散户的 卖出SOL - 买入SOL)
本轮下注 = Σ(当前持有散户的 买入SOL)
本轮成本 = 本轮下注 - Σ(当前持有散户的 卖出SOL)
浮盈浮亏 = Σ(当前持有散户的 持仓价值 - 净成本)
```

### 示例验证

假设有以下交易：
- 散户 A：买入 1 SOL，卖出 1.5 SOL（已退出）→ 已落袋 +0.5 SOL
- 散户 B：买入 2 SOL，持有中 → 本轮下注 +2 SOL
- 庄家 C：买入 10 SOL → **跳过，不计入任何指标**
- 散户 D：买入 1 SOL，卖出 0.5 SOL，持有中 → 本轮下注 +1 SOL，本轮成本 +0.5 SOL

**日志验证**：
1. 看到 3 条"处理散户交易"（A, B, D）
2. 看到 1 条"跳过庄家交易"（C）
3. 最终统计：
   - 散户交易数 = 3
   - 跳过庄家交易数 = 1
   - 已落袋 = 0.5 SOL（只有 A）
   - 本轮下注 = 3 SOL（B + D）

### 常见问题

**Q: 如何确认庄家被正确识别？**
A: 查看"跳过庄家交易"日志，检查地址是否在庄家列表中。

**Q: 如果没有看到"跳过庄家交易"日志？**
A: 可能该 mint 没有庄家交易，或者庄家检测策略没有识别出来。

**Q: 散户交易数 + 跳过庄家交易数 ≠ 总交易数？**
A: 可能有失败的交易被跳过，检查控制台是否有"跳过失败交易"的日志。

**Q: 指标计算是否准确？**
A: 通过日志可以看到每笔散户交易的 solChange 和 tokenChange，可以手动验证计算是否正确。

