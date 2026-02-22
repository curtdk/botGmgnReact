# Helius 监控系统 - 详细测试与排查文档

## 📋 目录

1. [完整流程图](#完整流程图)
2. [详细步骤与控制台输出](#详细步骤与控制台输出)
3. [关键参数说明](#关键参数说明)
4. [问题排查指南](#问题排查指南)
5. [数据验证清单](#数据验证清单)

---

## 🔄 完整流程图

```
用户打开 GMGN mint 页面
    ↓
background.js 检测 URL 变化
    ↓
发送 TAB_URL_CHANGED 消息
    ↓
content/index.jsx 接收消息
    ├─→ 清空旧数据 (contentManager.clearData())
    ├─→ 重置标志 (hasFetchedFullTradesHistory = false)
    └─→ 发送 MINT_CHANGED 消息到 SidePanel
    ↓
HeliusIntegration.js 检测 mint 变化
    ├─→ 停止旧监控器 (如果存在)
    ├─→ 发送 HELIUS_METRICS_CLEAR 到 SidePanel
    └─→ 创建新监控器 (new HeliusMonitor(mint))
    ↓
HeliusMonitor.start() 启动
    ├─→ 1. 初始化 IndexedDB 缓存
    ├─→ 2. 连接 WebSocket
    ├─→ 3. 获取初始 signature 列表 (getSignaturesForAddress)
    ├─→ 4. 等待 GMGN 分页数据加载完成
    │       ↓
    │   content/index.jsx 执行 EXECUTE_TRADES_REFRESH
    │       ├─→ 循环获取所有分页 (do-while nextCursor)
    │       ├─→ hook.js 捕获每页数据
    │       ├─→ 提取 tx_hash 并分发 HOOK_SIGNATURES_EVENT
    │       ├─→ 分发 HOOK_FETCH_XHR_EVENT (完整数据)
    │       └─→ 完成后分发 GMGN_TRADES_LOADED 事件
    │       ↓
    │   HeliusIntegration.js 收到 GMGN_TRADES_LOADED
    │       └─→ 调用 monitor.onGmgnDataLoaded()
    │       ↓
    │   HeliusMonitor.waitForGmgnData() 完成
    ├─→ 5. 批量获取缺失的交易
    │       ├─→ 从 IndexedDB 加载缓存
    │       └─→ 批量调用 getTransaction API
    ├─→ 6. 首次计算 (按时间倒排序)
    │       ├─→ 获取所有 hasData=true, isProcessed=false 的交易
    │       ├─→ 按 timestamp 从旧到新排序
    │       ├─→ 逐个处理并标记 isProcessed=true
    │       └─→ 计算 8 个指标
    └─→ 7. 进入实时模式
            ├─→ WebSocket 收到新交易 → 立即处理
            └─→ 每次处理后更新指标并发送到 SidePanel
```

---

## 📝 详细步骤与控制台输出

### 步骤 1: 用户打开 GMGN mint 页面

**操作**: 在浏览器中访问 `https://gmgn.ai/sol/token/[mint地址]`

**预期控制台输出**:
```
[GMGN Content] TAB_URL_CHANGED: Mint changed: GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
[GMGN Content] Clearing data for new mint
```

**关键参数**:
- `mint`: 从 URL 提取的 mint 地址（32-44 个字符的 Base58 字符串）

**验证点**:
- ✅ 控制台显示 `TAB_URL_CHANGED` 消息
- ✅ mint 地址正确提取
- ✅ 旧数据被清空

---

### 步骤 2: HeliusIntegration 初始化

**触发**: HeliusIntegration.checkAndInitMonitor() 检测到新 mint

**预期控制台输出**:
```
============================================================
[Helius集成] 检测到 Mint: GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
============================================================
```

**关键参数**:
- `this.currentMint`: 当前监控的 mint 地址
- `this.monitor`: HeliusMonitor 实例

**验证点**:
- ✅ 显示分隔线和 mint 地址
- ✅ 如果有旧监控器，显示 `[Helius集成] 切换到新 mint，停止旧监控`
- ✅ 如果有旧监控器，显示 `[Helius集成] 清空 SidePanel 指标`

---

### 步骤 3: HeliusMonitor 启动

**触发**: `await this.monitor.start()`

**预期控制台输出**:
```
--- 启动 Helius 浏览器监控系统 ---
目标代币 (Mint): GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
[CacheManager] 数据库初始化成功
```

**关键参数**:
- `this.mint`: 目标代币地址
- `this.cacheManager`: IndexedDB 缓存管理器
- `this.signatureManager`: Signature 状态管理器
- `this.metricsEngine`: 指标计算引擎
- `this.dataFetcher`: RPC 数据获取器

**验证点**:
- ✅ 显示启动消息
- ✅ IndexedDB 初始化成功

---

### 步骤 4: 连接 WebSocket

**触发**: `this.connectWs()`

**预期控制台输出**:
```
[WebSocket] 连接中...
[WebSocket] 已连接，开始订阅实时日志...
```

**关键参数**:
- `WSS_URL`: `wss://mainnet.helius-rpc.com/?api-key=...`
- `this.ws`: WebSocket 实例
- 订阅参数: `{ "mentions": [mint] }`

**验证点**:
- ✅ WebSocket 连接成功
- ✅ 订阅请求已发送

---

### 步骤 5: 获取初始 signature 列表

**触发**: `await this.fetchInitialSignatures()`

**预期控制台输出**:
```
[初始化] 获取 signature 列表...
[历史] 正在获取交易签名列表 (GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood)...
[缓存] 发现本地缓存 856 条签名。将增量拉取 (直到: 5Kx7...)
[历史] 增量获取新签名: 378 条
[初始化] 添加了 1234 个 signatures 到管理器
```

**关键参数**:
- `allSigs`: 所有 signatures（缓存 + 新获取）
- `cachedSigs`: 从 IndexedDB 加载的缓存 signatures
- `newSigs`: 新获取的 signatures

**验证点**:
- ✅ 显示缓存数量（如果有）
- ✅ 显示新获取数量
- ✅ 总数 = 缓存 + 新获取
- ✅ 所有 signatures 添加到 SignatureManager，来源标记为 'initial'

---

### 步骤 6: 等待 GMGN 分页数据加载完成

**触发**: `await this.waitForGmgnData()`

**预期控制台输出**:
```
[等待] 等待 GMGN 分页数据加载完成...
[SignatureManager] 开始等待期...
[等待] 5秒 | 总数: 1234 | 有数据: 856 | 需获取: 378
[等待] 10秒 | 总数: 1456 | 有数据: 1200 | 需获取: 256
```

**同时，content/index.jsx 执行分页获取**:
```
[GMGN Content] Executing EXECUTE_TRADES_REFRESH
[GMGN Content] Fetching trades page 1...
[GMGN Content] Page 1: 100 trades, 100 new
[GMGN Content] Fetching trades page 2...
[GMGN Content] Page 2: 100 trades, 100 new
...
[GMGN Content] Last batch details (Reason: End of Pages). Count: 56, New: 56
[GMGN Content] Full trades history synced.
[GMGN Content] Dispatched GMGN_TRADES_LOADED event
```

**HeliusIntegration 收到事件**:
```
[Helius集成] 收到 GMGN 分页数据加载完成通知
[等待] 收到 GMGN 数据加载完成通知
[等待] GMGN 数据加载完成，耗时 12.3 秒
```

**关键参数**:
- `hasFetchedFullTradesHistory`: 标记是否已获取全量历史
- `nextCursor`: 分页游标
- `pageCount`: 已获取页数
- `gmgnDataPromise`: 等待 GMGN 数据加载完成的 Promise

**验证点**:
- ✅ 每 5 秒显示一次进度
- ✅ 总数逐渐增加（WebSocket 和插件数据）
- ✅ 有数据数量逐渐增加（插件提供完整数据）
- ✅ 看到 `Full trades history synced.`
- ✅ 看到 `Dispatched GMGN_TRADES_LOADED event`
- ✅ 看到 `收到 GMGN 数据加载完成通知`
- ✅ 显示实际等待时间

**数据来源验证**:
- 初始 API: getSignaturesForAddress 返回的 signatures
- WebSocket: logsNotification 实时推送的 signatures
- GMGN 插件: token_trades 接口返回的 tx_hash

---

### 步骤 7: 批量获取缺失的交易

**触发**: `await this.fetchMissingTransactions()`

**预期控制台输出**:
```
[获取] 需要获取 256 个交易...
[CacheManager] 从缓存加载了 128/256 个交易
[获取] 128 个来自缓存，128 个需要 API
[获取] 进度: 100 / 128
[获取] 进度: 128 / 128
```

**关键参数**:
- `missingSigs`: 需要获取的 signatures（hasData=false）
- `cachedTxs`: 从 IndexedDB 加载的交易
- `stillMissing`: 仍然缺失的 signatures
- `CHUNK_SIZE`: 批量大小（100）

**验证点**:
- ✅ 显示需要获取的总数
- ✅ 显示缓存命中数量
- ✅ 显示需要 API 获取的数量
- ✅ 显示批量获取进度
- ✅ 缓存数 + API 数 = 总需获取数

---

### 步骤 8: 首次计算（按时间倒排序）

**触发**: `await this.performInitialCalculation()`

**预期控制台输出**:
```
[首次计算] 开始处理所有交易...
[首次计算] 将处理 1456 个交易（按时间倒排序）
[首次计算] 完成！处理了 1456 个交易

========== 指标统计 ==========
已落袋: 12.3456 SOL
本轮下注: 45.6789 SOL
本轮成本: 33.3333 SOL
浮盈浮亏: 5.4321 SOL
当前价格: 0.0000038612 SOL/Token
活跃用户: 234
已退出用户: 156
已处理交易: 1456
==============================
```

**关键参数**:
- `readySignatures`: 有数据但未处理的 signatures
- 排序: 按 `timestamp` 从旧到新
- 每个交易处理后标记 `isProcessed=true`

**验证点**:
- ✅ 显示将处理的交易数量
- ✅ 显示"按时间倒排序"
- ✅ 显示完成消息
- ✅ 显示 8 个指标
- ✅ 已处理数 = 总交易数

---

### 步骤 9: 进入实时模式

**触发**: `this.isInitialized = true`

**预期控制台输出**:
```
[系统] 进入实时模式，开始监听新交易...

[Helius集成] 监控已启动！
```

**实时更新示例**:
```
[实时] 获取新交易: 5Kx7...
[实时] 处理新交易: 5Kx7...

============================================================
📊 实时指标更新
============================================================
🎯 当前 Mint: GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
💰 已落袋: 12.4567 SOL
🎯 本轮下注: 46.1234 SOL
💵 本轮成本: 33.6789 SOL
📈 浮盈浮亏: 5.6789 SOL
💲 当前价格: 0.0000039123 SOL/Token
👥 活跃用户: 235
🚪 已退出: 156
✅ 已处理: 1457 笔交易
============================================================

📋 Signature 统计:
   总数: 1457
   有数据: 1457 (100.0%)
   需获取: 0 (0.0%)
   已处理: 1457 (100.0%)
   未处理: 0
   来源分布:
     - 初始 API: 1234 (84.7%)
     - WebSocket: 123 (8.4%)
     - GMGN插件: 100 (6.9%)
```

**关键参数**:
- `this.isInitialized`: 是否已初始化
- `this.isWaitingForGmgn`: 是否在等待 GMGN 数据

**验证点**:
- ✅ 显示进入实时模式
- ✅ WebSocket 收到新交易时立即处理
- ✅ 每次处理后更新指标
- ✅ 指标发送到 SidePanel
- ✅ SidePanel 显示实时更新

---

## 🔑 关键参数说明

### SignatureManager 状态

每个 signature 跟踪以下状态：

```javascript
{
  hasData: boolean,        // 是否已获得交易详情
  isProcessed: boolean,    // 是否已计算过
  sources: Set<string>,    // 数据来源 ['initial', 'websocket', 'plugin']
  timestamp: number,       // 首次发现时间
  txData: object | null    // 交易详情
}
```

**hasData 标志**:
- `false`: 只有 signature，没有交易详情，需要通过 API 获取
- `true`: 已有交易详情，无需 API 获取

**isProcessed 标志**:
- `false`: 未计算过，需要处理
- `true`: 已计算过，跳过处理

**sources 来源**:
- `initial`: 从 getSignaturesForAddress API 获取
- `websocket`: 从 WebSocket logsNotification 获取
- `plugin`: 从 GMGN token_trades 接口获取

### 指标计算

**8 个关键指标**:

1. **已落袋 (yiLuDai)**: 已退出用户的实现盈亏
   - 计算: Σ(卖出收入 - 买入成本) for 已退出用户
   - 已退出: `netTokenReceived < 1`

2. **本轮下注 (benLunXiaZhu)**: 当前持有者的买入总额
   - 计算: Σ(买入总额) for 当前持有者

3. **本轮成本 (benLunChengBen)**: 当前持有者的净成本
   - 计算: 本轮下注 - 当前持有者的卖出收入

4. **浮盈浮亏 (floatingPnL)**: 当前持有者的未实现盈亏
   - 计算: Σ(持仓价值 - 净成本) for 当前持有者
   - 持仓价值 = netTokenReceived × currentPrice

5. **当前价格 (currentPrice)**: 最新交易价格
   - 计算: |solChange| / |tokenChange|

6. **活跃用户 (activeCount)**: 当前持有代币的用户数
   - 计算: 持仓 > 1 Token 的用户数

7. **已退出 (exitedCount)**: 已卖出全部代币的用户数
   - 计算: 持仓 < 1 Token 的用户数

8. **已处理 (totalProcessed)**: 已处理的交易总数
   - 计算: 累计处理的交易笔数

---

## 🔍 问题排查指南

### 问题 1: 打开新 mint 页面，一直不出现 Helius 实时指标

**可能原因**:

#### 1.1 HeliusIntegration 没有初始化

**检查步骤**:
1. 打开控制台
2. 输入: `window.__heliusIntegration`
3. 如果返回 `undefined`，说明 HeliusIntegration 没有初始化

**解决方案**:
- 检查 `content/index.jsx` 是否正确导入了 `HeliusIntegration.js`
- 检查是否有 JavaScript 错误阻止了初始化

**预期输出**:
```javascript
HeliusIntegration {
  monitor: HeliusMonitor {...},
  currentMint: "GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood",
  isInitialized: true
}
```

#### 1.2 getMintFromPage() 没有正确提取 mint

**检查步骤**:
1. 打开控制台
2. 输入: `window.__heliusIntegration.currentMint`
3. 如果返回 `null`，说明没有提取到 mint

**解决方案**:
- 检查 URL 格式是否正确: `https://gmgn.ai/sol/token/[mint地址]`
- 检查 `getMintFromPage()` 函数是否正确

**预期输出**:
```
"GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood"
```

#### 1.3 GMGN_TRADES_LOADED 事件没有触发

**检查步骤**:
1. 打开控制台
2. 查找: `[GMGN Content] Full trades history synced.`
3. 查找: `[GMGN Content] Dispatched GMGN_TRADES_LOADED event`
4. 如果没有这些消息，说明分页获取没有完成

**解决方案**:
- 检查 `content/index.jsx` 中的 `EXECUTE_TRADES_REFRESH` 是否执行
- 检查是否有网络错误
- 检查 `hasFetchedFullTradesHistory` 标志

**预期输出**:
```
[GMGN Content] Full trades history synced.
[GMGN Content] Dispatched GMGN_TRADES_LOADED event
```

#### 1.4 HeliusMonitor 启动失败

**检查步骤**:
1. 打开控制台
2. 查找: `[Helius集成] 启动失败:`
3. 查看错误信息

**常见错误**:
- IndexedDB 初始化失败
- WebSocket 连接失败
- API 调用失败

**解决方案**:
- 检查浏览器是否支持 IndexedDB
- 检查网络连接
- 检查 Helius API key 是否有效

#### 1.5 事件监听没有正确设置

**检查步骤**:
1. 打开控制台
2. 查找: `[Helius集成] Hook 事件监听已设置`
3. 如果没有这条消息，说明事件监听没有设置

**解决方案**:
- 检查 `HeliusIntegration.setupHookListeners()` 是否被调用
- 检查是否有 JavaScript 错误

**预期输出**:
```
[Helius集成] Hook 事件监听已设置
```

---

### 问题 2: 指标显示不正确

**可能原因**:

#### 2.1 数据来源不完整

**检查步骤**:
1. 打开控制台
2. 查看 Signature 统计
3. 检查来源分布

**预期**:
- 初始 API: 应该占大部分（70-90%）
- WebSocket: 应该有一些（5-15%）
- GMGN插件: 应该有一些（5-15%）

**如果某个来源为 0**:
- 初始 API = 0: `fetchInitialSignatures()` 失败
- WebSocket = 0: WebSocket 连接失败或没有新交易
- GMGN插件 = 0: hook.js 没有捕获数据或 HeliusIntegration 没有监听事件

#### 2.2 交易没有被处理

**检查步骤**:
1. 打开控制台
2. 查看: `已处理: X / 总数: Y`
3. 如果 X < Y，说明有交易没有被处理

**解决方案**:
- 检查 `isProcessed` 标志
- 检查 `performInitialCalculation()` 是否执行
- 检查是否有错误

#### 2.3 数据重复计算

**检查步骤**:
1. 打开控制台
2. 查看: `已处理: X / 总数: Y`
3. 如果 X > Y，说明有数据被重复计算

**解决方案**:
- 检查 `isProcessed` 标志是否正确设置
- 检查 `markProcessed()` 是否被调用

---

### 问题 3: 切换 mint 后，旧指标仍然显示

**检查步骤**:
1. 切换到新 mint
2. 打开控制台
3. 查找: `[Helius集成] 清空 SidePanel 指标`
4. 查找: `[SidePanel] 清空 Helius 指标`

**如果没有这些消息**:
- `sendClearMetrics()` 没有被调用
- SidePanel 没有接收到 `HELIUS_METRICS_CLEAR` 消息

**解决方案**:
- 检查 `HeliusIntegration.checkAndInitMonitor()` 中是否调用了 `sendClearMetrics()`
- 检查 `App.jsx` 中是否处理了 `HELIUS_METRICS_CLEAR` 消息

---

## ✅ 数据验证清单

### 启动阶段

- [ ] 看到 `[Helius集成] 检测到 Mint: xxx`
- [ ] 看到 `--- 启动 Helius 浏览器监控系统 ---`
- [ ] 看到 `[CacheManager] 数据库初始化成功`
- [ ] 看到 `[WebSocket] 已连接，开始订阅实时日志...`
- [ ] 看到 `[初始化] 添加了 X 个 signatures 到管理器`

### 等待阶段

- [ ] 看到 `[等待] 等待 GMGN 分页数据加载完成...`
- [ ] 每 5 秒看到进度更新
- [ ] 看到 `[GMGN Content] Full trades history synced.`
- [ ] 看到 `[GMGN Content] Dispatched GMGN_TRADES_LOADED event`
- [ ] 看到 `[Helius集成] 收到 GMGN 分页数据加载完成通知`
- [ ] 看到 `[等待] GMGN 数据加载完成，耗时 X.X 秒`

### 获取阶段

- [ ] 看到 `[获取] 需要获取 X 个交易...`
- [ ] 看到 `[CacheManager] 从缓存加载了 X/Y 个交易`
- [ ] 看到 `[获取] X 个来自缓存，Y 个需要 API`
- [ ] 看到批量获取进度

### 计算阶段

- [ ] 看到 `[首次计算] 开始处理所有交易...`
- [ ] 看到 `[首次计算] 将处理 X 个交易（按时间倒排序）`
- [ ] 看到 `[首次计算] 完成！处理了 X 个交易`
- [ ] 看到指标统计输出

### 实时阶段

- [ ] 看到 `[系统] 进入实时模式，开始监听新交易...`
- [ ] 看到 `[Helius集成] 监控已启动！`
- [ ] 看到实时指标更新
- [ ] SidePanel 显示 Helius 实时指标面板
- [ ] SidePanel 显示当前 Mint 地址

### 数据验证

- [ ] 总数 = 初始 API + WebSocket + GMGN插件
- [ ] 有数据 + 需获取 = 总数
- [ ] 已处理 + 未处理 = 总数
- [ ] 已处理 = 总数（首次计算完成后）
- [ ] 活跃用户 + 已退出 = 总用户数
- [ ] 本轮成本 = 本轮下注 - 当前持有者的卖出收入

---

## 📊 完整控制台输出示例

```
[GMGN Content] TAB_URL_CHANGED: Mint changed: GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood

============================================================
[Helius集成] 检测到 Mint: GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
============================================================

--- 启动 Helius 浏览器监控系统 ---
目标代币 (Mint): GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
[CacheManager] 数据库初始化成功
[WebSocket] 连接中...
[WebSocket] 已连接，开始订阅实时日志...
[初始化] 获取 signature 列表...
[历史] 正在获取交易签名列表 (GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood)...
[缓存] 发现本地缓存 856 条签名。将增量拉取 (直到: 5Kx7...)
[历史] 增量获取新签名: 378 条
[初始化] 添加了 1234 个 signatures 到管理器

[等待] 等待 GMGN 分页数据加载完成...
[SignatureManager] 开始等待期...

[GMGN Content] Executing EXECUTE_TRADES_REFRESH
[GMGN Content] Fetching trades page 1...
[Helius集成] 从 token_trades 提取了 100 个 tx_hash
[GMGN Content] Page 1: 100 trades, 100 new

[等待] 5秒 | 总数: 1334 | 有数据: 956 | 需获取: 378

[GMGN Content] Fetching trades page 2...
[Helius集成] 从 token_trades 提取了 100 个 tx_hash
[GMGN Content] Page 2: 100 trades, 100 new

[等待] 10秒 | 总数: 1434 | 有数据: 1156 | 需获取: 278

[GMGN Content] Last batch details (Reason: End of Pages). Count: 56, New: 56
[Helius集成] 从 token_trades 提取了 56 个 tx_hash
[GMGN Content] Full trades history synced.
[GMGN Content] Dispatched GMGN_TRADES_LOADED event

[Helius集成] 收到 GMGN 分页数据加载完成通知
[等待] 收到 GMGN 数据加载完成通知
[等待] GMGN 数据加载完成，耗时 12.3 秒

[获取] 需要获取 256 个交易...
[CacheManager] 从缓存加载了 128/256 个交易
[获取] 128 个来自缓存，128 个需要 API
[获取] 进度: 100 / 128
[获取] 进度: 128 / 128

[首次计算] 开始处理所有交易...
[首次计算] 将处理 1490 个交易（按时间倒排序）
[首次计算] 完成！处理了 1490 个交易

========== 指标统计 ==========
已落袋: 12.3456 SOL
本轮下注: 45.6789 SOL
本轮成本: 33.3333 SOL
浮盈浮亏: 5.4321 SOL
当前价格: 0.0000038612 SOL/Token
活跃用户: 234
已退出用户: 156
已处理交易: 1490
==============================

[系统] 进入实时模式，开始监听新交易...

[Helius集成] 监控已启动！

============================================================
📊 实时指标更新
============================================================
🎯 当前 Mint: GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood
💰 已落袋: 12.3456 SOL
🎯 本轮下注: 45.6789 SOL
💵 本轮成本: 33.3333 SOL
📈 浮盈浮亏: 5.4321 SOL
💲 当前价格: 0.0000038612 SOL/Token
👥 活跃用户: 234
🚪 已退出: 156
✅ 已处理: 1490 笔交易
============================================================

📋 Signature 统计:
   总数: 1490
   有数据: 1490 (100.0%)
   需获取: 0 (0.0%)
   已处理: 1490 (100.0%)
   未处理: 0
   来源分布:
     - 初始 API: 1234 (82.8%)
     - WebSocket: 0 (0.0%)
     - GMGN插件: 256 (17.2%)

```

---

## 🎯 总结

这份文档提供了完整的测试流程和排查指南。按照以下步骤进行测试：

1. **打开 GMGN mint 页面**
2. **打开控制台（F12）**
3. **按照"数据验证清单"逐项检查**
4. **对照"完整控制台输出示例"验证每个步骤**
5. **如果遇到问题，参考"问题排查指南"**

关键验证点：
- ✅ 所有步骤的控制台输出都正确
- ✅ 数据来源分布合理
- ✅ 指标计算正确
- ✅ SidePanel 显示正确
- ✅ 切换 mint 时数据正确清空

如果所有验证点都通过，说明系统运行正常！

---

## 🐛 指标更新问题调试 (2026-02-19)

### 问题描述

用户报告 Helius 实时指标在第一次更新后便不再更新，即使 GMGN 已经获取到了新的 sig 也没有及时更新上去。

### 修改内容

#### 1. 增强日志记录 (HeliusIntegration.js)

**Hook 事件处理器** (line ~101-130):
- 添加交易接收日志: `Hook 事件收到 ${trades.length} 个交易`
- 添加每个交易的 isNew 状态日志
- 添加新交易统计日志

**processNewGmgnTrades()** (line ~428-484):
- 添加处理开始/完成日志
- 添加每个交易的状态检查日志 (hasData, isProcessed)
- 统计并显示处理/跳过的交易数量
- 添加 displayMetrics 调用日志

**sendMetricsToUI()** (line ~489-509):
- 添加消息发送日志
- 改进错误处理和日志记录

#### 2. 添加 Sig 处理总数显示 (App.jsx)

在 Helius 实时指标区域添加了 totalProcessed 显示 (line ~934):

```jsx
已处理: {heliusStats.isProcessed}/{heliusStats.total} | Sig处理总数: {heliusMetrics.totalProcessed}
```

**说明**:
- `已处理`: SignatureManager 中已标记为处理的 signature 数量
- `total`: SignatureManager 中的总 signature 数量  
- `Sig处理总数`: MetricsEngine 实际处理并计算过的交易总数

### 调试流程

使用这些日志，可以追踪完整的数据流:

1. **GMGN Hook 事件** → 查看收到多少交易，哪些是新交易
2. **processNewGmgnTrades** → 查看每个交易的处理状态
3. **sendMetricsToUI** → 确认指标是否发送到 UI
4. **UI 更新** → 查看 totalProcessed 是否增加

### 可能的问题原因

基于代码分析，可能的原因包括:

1. **新交易未被识别为新**:
   - 检查 `isNew` 判断逻辑
   - 可能是 GMGN 重复发送相同的交易

2. **交易状态不正确**:
   - `hasData` 为 false: GMGN 数据未正确存储
   - `isProcessed` 为 true: 交易已被处理过

3. **Monitor 未初始化**:
   - `isInitialized` 为 false 时不会处理新交易

4. **消息发送失败**:
   - SidePanel 未打开
   - Chrome 消息传递错误

### 下一步测试

1. 重新加载扩展
2. 打开 GMGN token 页面
3. 启用 Helius 监控
4. 观察控制台日志，特别关注:
   - `[Helius集成] Hook 事件收到 X 个交易`
   - `[Helius集成] 交易 xxx... isNew=true/false`
   - `[Helius集成] processNewGmgnTrades 开始处理 X 个新交易`
   - `[Helius集成] 交易状态 xxx...: hasData=true/false, isProcessed=true/false`
   - `[Helius集成] ✓ 处理新 GMGN 交易` 或 `✗ 无法处理交易`
   - `[Helius集成] processNewGmgnTrades 完成: 处理=X, 跳过=Y`
   - `[Helius集成] 发送指标到 UI: totalProcessed=X`
5. 根据日志输出确定具体问题所在

### 相关文件

- [HeliusIntegration.js](../src/content/HeliusIntegration.js) - 主要修改
- [App.jsx](../src/sidepanel/App.jsx) - UI 显示修改
- [MetricsEngine.js](../src/helius/MetricsEngine.js) - totalProcessed 计算
- [SignatureManager.js](../src/helius/SignatureManager.js) - Signature 状态管理

