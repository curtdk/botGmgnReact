# Helius 庄家检测与数据整合 - 操作指南

## 📋 系统概述

本系统将 HeliusMonitor（Helius 实时监控）与 contentManager（GMGN 数据管理）进行了深度整合，实现了统一的庄家检测和散户数据统计功能。

### 核心特性

- ✅ **统一庄家检测**：HeliusMonitor 使用全部数据源（GMGN + Helius + WebSocket）进行庄家检测
- ✅ **只统计散户**：自动过滤庄家交易，只计算散户的已落袋、本轮下注等指标
- ✅ **实时数据同步**：HeliusMonitor 和 contentManager 数据实时同步
- ✅ **保留现有功能**：contentManager 的插件列表、地址短名称、小花标记等功能完全保留

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    HeliusMonitor (主数据层)                  │
│  - 收集所有数据源(GMGN + Helius + WebSocket)                │
│  - 执行庄家检测(BossDetector)                                │
│  - 计算散户指标(已落袋、本轮下注等)                         │
│  - 管理完整的交易历史和用户状态                             │
└────────────────────┬────────────────────────────────────────┘
                     │ 数据分发
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                 contentManager (UI 展示层)                   │
│  - 接收 HeliusMonitor 的数据                                │
│  - 插件列表展示                                             │
│  - 地址短名称管理                                           │
│  - 主页面小花标记                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 使用步骤

### 步骤 1: 打开 GMGN Token 页面

1. 访问 GMGN 网站：https://gmgn.ai/
2. 选择一个代币（Token）并进入其详情页面
3. 确保 URL 格式为：`https://gmgn.ai/sol/token/[mint地址]`

### 步骤 2: 打开 Chrome 扩展 SidePanel

1. 点击浏览器右上角的扩展图标
2. 找到 GMGN 扩展并点击
3. 或者使用快捷键打开 SidePanel

### 步骤 3: 启用 Helius 监控

1. 在 SidePanel 中找到 **"Helius 实时监控"** 区域
2. 点击 **"启用监控"** 开关
3. 系统会自动开始初始化

### 步骤 4: 等待数据加载

系统会按以下顺序加载数据：

1. **初始化缓存** (1-2秒)
2. **连接 WebSocket** (实时监听新交易)
3. **获取初始 Signatures** (从 Helius API)
4. **等待 GMGN 分页数据** (自动获取所有历史交易)
5. **批量获取缺失交易** (补充 Helius 数据)
6. **执行庄家检测** (分析所有用户)
7. **首次计算指标** (计算散户数据)
8. **进入实时模式** ✅

### 步骤 5: 查看实时指标

在 SidePanel 的 **"Helius 实时指标"** 区域，您可以看到：

- **已落袋**：散户已退出用户的实现盈亏
- **本轮下注**：散户当前持有者的买入总额
- **本轮成本**：散户当前持有者的净成本
- **浮盈浮亏**：散户当前持有者的未实现盈亏
- **当前价格**：代币当前价格
- **活跃用户**：散户当前持有者数量
- **已退出**：散户已退出用户数量
- **跳过庄家**：被过滤的庄家交易数量 ⭐

---

## 🔍 验证功能

### 验证 1: 检查控制台日志

打开浏览器开发者工具（F12），查看控制台：

#### 预期日志（按顺序）：

```
[Helius集成] 初始化...
[Helius集成] 检测到 Mint: [mint地址]
[HeliusMonitor] 启动监控...
[Helius集成] 收到 X 个 holder 数据
[MetricsEngine] 更新了 X 个用户信息
[MetricsEngine] 开始庄家检测...
[MetricsEngine] 庄家检测完成: 检测到庄家: X 个, 总庄家数: X 个, 散户数: Y 个
[Helius集成] 庄家检测完成: 庄家=X, 总用户=Z
[Helius集成] 分发数据给 contentManager: Z 个用户
[GMGN Content] 收到 HeliusMonitor 数据: Z 个用户
[GMGN Content] contentManager 已更新: Z 个用户
```

#### 交易处理日志：

```
[MetricsEngine] ⏭️  跳过庄家交易: [地址]... (sig: [签名]...)
[MetricsEngine] ✓ 处理交易: [地址]... (sig: [签名]...)
```

### 验证 2: 检查 SidePanel 显示

确认以下信息正确显示：

- ✅ **跳过庄家** 数量大于 0（说明庄家过滤正在工作）
- ✅ **活跃用户** 数量接近 contentManager 的散户数量
- ✅ **已落袋、本轮下注** 等指标只反映散户数据

### 验证 3: 检查插件列表

1. 打开 GMGN 页面的插件列表（点击扩展图标）
2. 确认地址分类正确：
   - 🐋 庄家标记
   - 🌸 散户标记（小花）
3. 确认地址短名称正常显示

### 验证 4: 对比数据一致性

在控制台执行以下命令：

```javascript
// 查看 HeliusMonitor 的庄家数量
window.__heliusIntegration.monitor.metricsEngine.whaleAddresses.size

// 查看 contentManager 的庄家数量
Array.from(contentManager.statusMap.entries()).filter(([_, status]) => status === '庄家').length

// 两者应该相等
```

---

## 🎯 庄家检测策略

系统使用 3 种主要策略检测庄家：

### 策略 1: 无资金来源检测 ✅ (默认启用)

如果钱包没有可识别的资金来源（`funding_account` 为空），标记为庄家。

**原理**：正常散户的钱包通常有明确的资金来源（如交易所、其他钱包），而庄家可能使用新创建的钱包。

### 策略 2: 同源账户聚类 ❌ (默认禁用)

如果 N≥5 个钱包都从同一个地址获得初始资金，标记为庄家。

**配置**：
- `same_source_n`: 阈值（默认 5）
- `same_source_exclude`: 排除的资金来源地址（逗号分隔）

### 策略 3: 时间聚类 ❌ (默认禁用)

如果 N≥5 个钱包在 J 秒内完成首次购买，标记为庄家。

**配置**：
- `time_cluster_n`: 阈值（默认 5）
- `time_cluster_j`: 时间窗口（默认 1 秒）

### 手动分类

用户可以手动标记地址为"庄家"或"散户"，手动分类的优先级最高，不会被自动检测覆盖。

---

## 📊 数据流程

### 完整数据流

```
1. GMGN API (token_holders, token_trades)
   ↓
2. hook.js (拦截 XHR/fetch)
   ↓
3. HOOK_HOLDERS_EVENT / HOOK_FETCH_XHR_EVENT
   ↓
4. HeliusIntegration (接收数据)
   ↓
5. MetricsEngine.updateUsersInfo() (存储用户信息)
   ↓
6. MetricsEngine.detectWhales() (执行庄家检测)
   ↓
7. MetricsEngine.whaleAddresses (更新庄家地址集合)
   ↓
8. processTransaction() (处理交易时过滤庄家)
   ↓
9. getMetrics() (计算散户指标)
   ↓
10. HELIUS_DATA_UPDATE (分发数据给 contentManager)
    ↓
11. contentManager (更新 UI)
```

### 数据获取优先级

1. **GMGN trade 分页数据** (优先级最高)
   - 循环获取所有分页
   - 包含完整的交易信息
   - 减少 Helius API 调用

2. **实时数据**
   - WebSocket 实时接收新交易
   - GMGN 定期刷新

3. **Helius 完善全部数据** (优先级最低)
   - 只获取缺失的交易
   - 优先从 IndexedDB 缓存加载
   - 批量调用 Helius API

---

## ⚙️ 配置选项

### 修改庄家检测配置

在控制台执行：

```javascript
// 启用同源账户聚类检测
window.__heliusIntegration.monitor.metricsEngine.updateBossConfig({
  enable_same_source: true,
  same_source_n: 5,
  same_source_exclude: '地址1,地址2'
});

// 启用时间聚类检测
window.__heliusIntegration.monitor.metricsEngine.updateBossConfig({
  enable_time_cluster: true,
  time_cluster_n: 5,
  time_cluster_j: 1
});

// 重新执行检测
const result = window.__heliusIntegration.monitor.metricsEngine.detectWhales();
console.log('检测结果:', result);
```

### 查看当前配置

```javascript
console.log(window.__heliusIntegration.monitor.metricsEngine.bossConfig);
```

---

## 🐛 常见问题

### Q1: 为什么"跳过庄家"数量为 0？

**可能原因**：
1. 庄家检测尚未执行（等待 holder 数据加载）
2. 当前代币没有检测到庄家
3. 只启用了"无资金来源"策略，但所有用户都有资金来源

**解决方法**：
- 等待数据完全加载
- 启用更多检测策略（同源账户聚类、时间聚类）
- 检查控制台日志确认检测是否执行

### Q2: 指标数据不准确？

**可能原因**：
1. 数据尚未完全加载
2. 庄家检测结果不准确
3. 缓存数据过期

**解决方法**：
- 等待"进入实时模式"日志出现
- 调整庄家检测策略
- 清除缓存并重新加载

### Q3: 如何手动标记庄家？

**方法**：
```javascript
// 标记为庄家
contentManager.setStatus('地址', '庄家');
contentManager.saveStatus();

// 标记为散户
contentManager.setStatus('地址', '散户');
contentManager.saveStatus();

// 重新分发数据
window.__heliusIntegration.distributeDataToContentManager();
```

### Q4: 如何查看详细的用户信息？

**方法**：
```javascript
// 查看所有用户信息
console.table(window.__heliusIntegration.monitor.metricsEngine.userInfo);

// 查看特定用户
console.log(window.__heliusIntegration.monitor.metricsEngine.userInfo['地址']);

// 查看庄家列表
console.log(Array.from(window.__heliusIntegration.monitor.metricsEngine.whaleAddresses));
```

### Q5: 系统性能如何？

**性能优化**：
- ✅ 使用 Set 数据结构，庄家查询 O(1) 时间复杂度
- ✅ GMGN 提供大部分数据，减少 Helius API 调用
- ✅ IndexedDB 缓存，避免重复获取
- ✅ 批量处理交易，提高效率

**预期性能**：
- 初始化时间：5-15 秒（取决于交易数量）
- 实时处理延迟：< 1 秒
- 内存占用：< 50MB（1000 个用户）

---

## 📝 技术细节

### 关键文件

1. **MetricsEngine.js** - 核心指标计算引擎
   - 数据结构：`userInfo`, `whaleAddresses`, `traderStats`
   - 方法：`updateUsersInfo()`, `detectWhales()`, `processTransaction()`

2. **BossDetector.js** - 庄家检测器
   - 静态方法：`detectWhales()`
   - 3 种检测策略实现

3. **HeliusIntegration.js** - 集成层
   - 事件监听：`HOOK_HOLDERS_EVENT`, `HOOK_FETCH_XHR_EVENT`
   - 数据分发：`distributeDataToContentManager()`

4. **index.jsx** - contentManager 主文件
   - 事件监听：`HELIUS_DATA_UPDATE`
   - UI 更新逻辑

5. **HeliusMonitor.js** - 监控协调器
   - 方法：`updateWhaleAddresses()`
   - 协调各组件工作

### 数据结构

#### userInfo (MetricsEngine)
```javascript
{
  [address]: {
    owner: "地址",
    ui_amount: 持仓数量,
    holding_share_pct: 持仓占比,
    total_buy_u: 总买入金额,
    funding_account: "资金来源地址",
    first_buy_time: 首次购买时间戳,
    // ... 其他 GMGN holder 字段
  }
}
```

#### statusMap (HeliusIntegration)
```javascript
{
  [address]: "庄家" | "散户"
}
```

#### whaleAddresses (MetricsEngine)
```javascript
Set([
  "庄家地址1",
  "庄家地址2",
  // ...
])
```

---

## 🎓 最佳实践

### 1. 首次使用

- 等待数据完全加载（看到"进入实时模式"日志）
- 观察"跳过庄家"数量，确认过滤正常工作
- 对比 contentManager 和 HeliusMonitor 的数据一致性

### 2. 日常使用

- 定期检查控制台日志，确认系统正常运行
- 关注"跳过庄家"数量变化
- 手动标记明显的庄家/散户地址

### 3. 性能优化

- 避免频繁刷新页面
- 使用缓存数据（自动）
- 只在必要时启用多个检测策略

### 4. 数据分析

- 对比"已落袋"和"本轮下注"，判断散户盈亏情况
- 观察"活跃用户"和"已退出"数量变化
- 分析"浮盈浮亏"，判断当前持有者的盈利状态

---

## 📞 技术支持

如遇到问题，请提供以下信息：

1. **控制台日志**（完整的初始化和错误日志）
2. **Token 地址**（Mint 地址）
3. **问题描述**（具体现象和预期行为）
4. **系统信息**（浏览器版本、扩展版本）

---

## 🔄 更新日志

### v1.0.0 (2026-02-19)

- ✅ 实现 HeliusMonitor 和 contentManager 数据整合
- ✅ 实现统一庄家检测（3 种策略）
- ✅ 实现庄家交易过滤
- ✅ 实现散户指标计算
- ✅ 实现数据实时同步
- ✅ 保留 contentManager 所有 UI 功能

---

**祝您使用愉快！** 🎉
