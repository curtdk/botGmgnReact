# Helius 监控系统更新 - 2026-02-17

## 📋 更新内容

### 1. 切换 mint 时清空数据 ✅

**问题**: 当 GMGN 页面切换到新的 mint 时，之前的 Helius 指标数据仍然显示在 SidePanel 中，造成混淆。

**解决方案**:
- 在 `HeliusIntegration.js` 中，当检测到 mint 切换时，发送 `HELIUS_METRICS_CLEAR` 消息到 SidePanel
- 在 `App.jsx` 中处理 `HELIUS_METRICS_CLEAR` 消息，清空 `heliusMetrics` 和 `heliusStats` 状态

**实施细节**:

1. **HeliusIntegration.js** - 添加清空方法:
```javascript
sendClearMetrics() {
  try {
    console.log('[Helius集成] 清空 SidePanel 指标');
    chrome.runtime.sendMessage({
      type: 'HELIUS_METRICS_CLEAR'
    }).catch(err => {
      // 忽略 SidePanel 未打开的错误
    });
  } catch (err) {
    // 忽略错误
  }
}
```

2. **HeliusIntegration.js** - 在切换 mint 时调用:
```javascript
// 停止旧的监控器
if (this.monitor) {
  console.log('[Helius集成] 切换到新 mint，停止旧监控');
  this.monitor.stop();

  // 清空 SidePanel 数据
  this.sendClearMetrics();
}
```

3. **App.jsx** - 处理清空消息:
```javascript
} else if (request.type === 'HELIUS_METRICS_CLEAR') {
  // [新增] 清空 Helius 指标
  console.log('[SidePanel] 清空 Helius 指标');
  setHeliusMetrics(null);
  setHeliusStats(null);
}
```

**效果**:
- ✅ 切换到新 mint 时，SidePanel 的 Helius 指标面板立即消失
- ✅ 新 mint 的数据加载完成后，显示新的指标
- ✅ 避免旧数据和新数据混淆

---

### 2. 移除固定 20 秒等待，改为等待 GMGN 数据加载完成 ✅

**问题**:
- 固定 20 秒等待不够灵活
- 如果 GMGN 数据在 10 秒内加载完成，还要等待 10 秒
- 如果 GMGN 数据需要 30 秒才能加载完成，20 秒后就开始批量获取，导致数据不完整

**解决方案**:
- 移除固定 20 秒等待
- 监听 GMGN 分页数据加载完成事件 `GMGN_TRADES_LOADED`
- 当收到事件后，立即开始批量获取缺失的交易

**实施细节**:

1. **content/index.jsx** - 分发加载完成事件:
```javascript
// 标记全量历史已获取
if (!hasFetchedFullTradesHistory) {
    hasFetchedFullTradesHistory = true;
    console.log('[GMGN Content] Full trades history synced.');

    // 分发 GMGN 分页数据加载完成事件
    window.dispatchEvent(new CustomEvent('GMGN_TRADES_LOADED', {
        detail: { mint: currentMint }
    }));
    console.log('[GMGN Content] Dispatched GMGN_TRADES_LOADED event');
}
```

2. **HeliusIntegration.js** - 监听加载完成事件:
```javascript
// 监听 GMGN 分页数据加载完成事件
window.addEventListener('GMGN_TRADES_LOADED', (event) => {
  if (!this.monitor) return;

  console.log('[Helius集成] 收到 GMGN 分页数据加载完成通知');

  // 通知监控器可以开始批量获取了
  if (this.monitor.onGmgnDataLoaded) {
    this.monitor.onGmgnDataLoaded();
  }
});
```

3. **HeliusMonitor.js** - 替换等待逻辑:

**之前**:
```javascript
// 4. 开始 20 秒等待期
await this.waitForCollection();
```

**现在**:
```javascript
// 4. 等待 GMGN 分页数据加载完成
await this.waitForGmgnData();
```

**新的 waitForGmgnData 方法**:
```javascript
async waitForGmgnData() {
  console.log('[等待] 等待 GMGN 分页数据加载完成...');
  this.signatureManager.startWaitPeriod();
  this.isWaitingForGmgn = true;

  const startTime = Date.now();

  // 设置回调，当 GMGN 数据加载完成时调用
  const gmgnDataPromise = new Promise((resolve) => {
    this.gmgnDataLoadedResolve = resolve;
  });

  // 进度更新
  const progressInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const stats = this.signatureManager.getStats();

    console.log(`[等待] ${(elapsed / 1000).toFixed(0)}秒 | ` +
                `总数: ${stats.total} | 有数据: ${stats.hasData} | ` +
                `需获取: ${stats.needFetch}`);
  }, 5000);

  // 设置 onGmgnDataLoaded 回调
  this.onGmgnDataLoaded = () => {
    console.log('[等待] 收到 GMGN 数据加载完成通知');
    if (this.gmgnDataLoadedResolve) {
      this.gmgnDataLoadedResolve();
    }
  };

  // 等待 GMGN 数据加载完成
  await gmgnDataPromise;
  clearInterval(progressInterval);

  const duration = Date.now() - startTime;
  console.log(`[等待] GMGN 数据加载完成，耗时 ${(duration / 1000).toFixed(1)} 秒`);

  this.signatureManager.endWaitPeriod();
  this.isWaitingForGmgn = false;
}
```

**效果**:
- ✅ 如果 GMGN 数据在 10 秒内加载完成，立即开始批量获取（节省 10 秒）
- ✅ 如果 GMGN 数据需要 30 秒，会等待 30 秒直到完成（确保数据完整）
- ✅ 控制台显示实际等待时间
- ✅ 更灵活、更准确

---

## 🔍 测试验证

### 测试场景 1: 切换 mint

1. 打开 GMGN mint 页面 A
2. 等待 Helius 指标显示
3. 切换到 mint 页面 B
4. **预期**: SidePanel 的 Helius 指标立即消失
5. **预期**: 控制台显示 `[Helius集成] 清空 SidePanel 指标`
6. **预期**: 新 mint 的数据加载完成后，显示新的指标

### 测试场景 2: GMGN 数据快速加载（< 20 秒）

1. 打开一个交易量较少的 mint 页面
2. 观察控制台输出
3. **预期**: 看到 `[GMGN Content] Full trades history synced.`
4. **预期**: 看到 `[GMGN Content] Dispatched GMGN_TRADES_LOADED event`
5. **预期**: 看到 `[Helius集成] 收到 GMGN 分页数据加载完成通知`
6. **预期**: 看到 `[等待] GMGN 数据加载完成，耗时 X.X 秒`（X < 20）
7. **预期**: 立即开始批量获取，不等待 20 秒

### 测试场景 3: GMGN 数据慢速加载（> 20 秒）

1. 打开一个交易量很大的 mint 页面
2. 观察控制台输出
3. **预期**: 看到多次 `[等待] X秒 | 总数: XXX | 有数据: XXX | 需获取: XXX`
4. **预期**: 等待时间超过 20 秒
5. **预期**: 直到看到 `[GMGN Content] Full trades history synced.`
6. **预期**: 然后立即开始批量获取

---

## 📊 控制台输出示例

### 正常流程

```
============================================================
[Helius集成] 检测到 Mint: xxx
============================================================

--- 启动 Helius 浏览器监控系统 ---
[WebSocket] 已连接，开始订阅实时日志...
[初始化] 获取 signature 列表...
[初始化] 添加了 1234 个 signatures 到管理器

[等待] 等待 GMGN 分页数据加载完成...
[SignatureManager] 开始等待期...

[等待] 5秒 | 总数: 1234 | 有数据: 856 | 需获取: 378
[等待] 10秒 | 总数: 1456 | 有数据: 1200 | 需获取: 256

[GMGN Content] Full trades history synced.
[GMGN Content] Dispatched GMGN_TRADES_LOADED event
[Helius集成] 收到 GMGN 分页数据加载完成通知
[等待] 收到 GMGN 数据加载完成通知
[等待] GMGN 数据加载完成，耗时 12.3 秒

[获取] 需要获取 256 个交易...
[获取] 128 个来自缓存，128 个需要 API
[获取] 进度: 100 / 128
[获取] 进度: 128 / 128

[首次计算] 开始处理所有交易...
[首次计算] 将处理 1456 个交易（按时间倒排序）
[首次计算] 完成！处理了 1456 个交易

============================================================
📊 实时指标更新
============================================================
💰 已落袋: 12.3456 SOL
🎯 本轮下注: 45.6789 SOL
...
```

### 切换 mint

```
[Helius集成] 切换到新 mint，停止旧监控
[Helius集成] 清空 SidePanel 指标
[系统] 监控已停止

============================================================
[Helius集成] 检测到 Mint: yyy
============================================================

--- 启动 Helius 浏览器监控系统 ---
...
```

---

## 🎯 关键改进

1. **更智能的等待策略**
   - 之前: 固定等待 20 秒
   - 现在: 等待 GMGN 数据实际加载完成
   - 优势: 更快（数据少时）或更完整（数据多时）

2. **更清晰的数据隔离**
   - 之前: 切换 mint 时，旧数据仍显示
   - 现在: 切换 mint 时，立即清空旧数据
   - 优势: 避免混淆，用户体验更好

3. **更准确的控制台输出**
   - 显示实际等待时间
   - 显示 GMGN 数据加载完成通知
   - 更容易调试和监控

---

## 📁 修改的文件

1. `src/content/HeliusIntegration.js`
   - 添加 `sendClearMetrics()` 方法
   - 添加 `GMGN_TRADES_LOADED` 事件监听
   - 在切换 mint 时调用 `sendClearMetrics()`

2. `src/content/index.jsx`
   - 在分页获取完成后分发 `GMGN_TRADES_LOADED` 事件

3. `src/helius/HeliusMonitor.js`
   - 移除 `WAIT_DURATION` 常量
   - 替换 `waitForCollection()` 为 `waitForGmgnData()`
   - 添加 `onGmgnDataLoaded` 回调
   - 添加 `gmgnDataLoadedResolve` Promise resolver
   - 更新 `isWaitingPeriod` 为 `isWaitingForGmgn`

4. `src/sidepanel/App.jsx`
   - 添加 `HELIUS_METRICS_CLEAR` 消息处理

---

## ✅ 构建状态

```bash
npm run build
```

**结果**: ✅ 成功，无错误

---

## 🚀 使用说明

### 正常使用

1. 加载插件到 Chrome
2. 打开 GMGN mint 页面
3. 观察控制台和 SidePanel
4. 等待 GMGN 数据加载完成（不再是固定 20 秒）
5. 查看实时指标

### 切换 mint

1. 在 GMGN 页面切换到新的 mint
2. **观察**: SidePanel 的 Helius 指标立即消失
3. **观察**: 控制台显示清空消息
4. **观察**: 新 mint 的数据加载完成后，显示新的指标

---

## 🐛 问题排查

### 问题 1: 切换 mint 后，旧指标仍然显示

**检查**:
1. 控制台是否显示 `[Helius集成] 清空 SidePanel 指标`
2. SidePanel 控制台是否显示 `[SidePanel] 清空 Helius 指标`

**解决**:
- 确保 HeliusIntegration.js 正确调用了 `sendClearMetrics()`
- 确保 App.jsx 正确处理了 `HELIUS_METRICS_CLEAR` 消息

### 问题 2: 等待时间过长

**检查**:
1. 控制台是否显示 `[GMGN Content] Full trades history synced.`
2. 控制台是否显示 `[GMGN Content] Dispatched GMGN_TRADES_LOADED event`
3. 控制台是否显示 `[Helius集成] 收到 GMGN 分页数据加载完成通知`

**解决**:
- 确保 content/index.jsx 正确分发了 `GMGN_TRADES_LOADED` 事件
- 确保 HeliusIntegration.js 正确监听了该事件
- 确保 HeliusMonitor.js 的 `onGmgnDataLoaded` 回调被正确设置

### 问题 3: 立即开始批量获取，没有等待

**检查**:
1. 是否在 GMGN 数据加载完成之前就开始批量获取

**解决**:
- 确保 `waitForGmgnData()` 方法正确等待 Promise
- 确保 `gmgnDataLoadedResolve` 被正确调用

---

## 📝 总结

这次更新主要解决了两个问题：

1. **数据隔离**: 切换 mint 时清空旧数据，避免混淆
2. **灵活等待**: 移除固定 20 秒等待，改为等待 GMGN 数据实际加载完成

这两个改进使得 Helius 监控系统更加智能、准确和用户友好。
