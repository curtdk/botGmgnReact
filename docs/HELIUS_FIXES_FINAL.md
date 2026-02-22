# HeliusMonitor 修复总结 - WebSocket 状态和数据来源

## 修复的问题

### 问题 1: WebSocket 状态在切换 mint 时没有重置 ✅

**症状**:
- 切换 mint 页面时,WebSocket 状态仍显示"已连接"
- 关闭监控开关时,WebSocket 状态没有清空

**修复**:

#### 1. HeliusIntegration.js
修改 `sendClearMetrics()` 方法,同时清空 WebSocket 状态:

```javascript
sendClearMetrics() {
  // 清空指标
  chrome.runtime.sendMessage({
    type: 'HELIUS_METRICS_CLEAR'
  }).catch(() => {});

  // 同时清空 WebSocket 状态
  chrome.runtime.sendMessage({
    type: 'HELIUS_WS_STATUS',
    status: {
      connected: false,
      lastConnectTime: null,
      reconnectCount: 0,
      error: null
    }
  }).catch(() => {});
}
```

**调用时机**:
- 离开 mint 页面
- 切换到新 mint
- 关闭监控开关

#### 2. App.jsx
修改 `toggleHeliusMonitor()` 方法,关闭时清空所有状态:

```javascript
const toggleHeliusMonitor = (enabled) => {
  setHeliusMonitorEnabled(enabled);

  // 如果关闭,清空状态
  if (!enabled) {
    setHeliusMetrics(null);
    setHeliusStats(null);
    setHeliusMint(null);
    setHeliusWsStatus({
      connected: false,
      lastConnectTime: null,
      reconnectCount: 0,
      error: null
    });
    setHeliusVerifyStatus({
      lastVerifyTime: null,
      timeSinceLastVerify: null
    });
  }
  // ...
}
```

### 问题 2: 数据来源需要分为两组显示 ✅

**需求**:
- **Signature 来源**: 这个 signature 从哪里获取 (初始/WS/插件/校验)
- **详细信息来源**: 交易详情从哪里获取 (API/缓存/插件/WS)

**修复**:

#### 1. SignatureManager.js
修改 `getStats()` 方法,添加详细信息来源统计:

```javascript
getStats() {
  let total = 0;
  let hasData = 0;
  let isProcessed = 0;
  const bySources = { initial: 0, websocket: 0, plugin: 0, verify: 0 };
  const byDataSource = { api: 0, cache: 0, plugin: 0, websocket: 0 };

  for (const [sig, entry] of this.signatures.entries()) {
    total++;
    if (entry.hasData) hasData++;
    if (entry.isProcessed) isProcessed++;

    // 统计 signature 来源
    entry.sources.forEach(src => {
      if (bySources[src] !== undefined) {
        bySources[src]++;
      }
    });

    // 统计详细信息来源
    if (entry.hasData && entry.txData) {
      const dataType = entry.txData.type; // 'gmgn', 'helius', 'cache', 'websocket'
      if (dataType === 'gmgn') {
        byDataSource.plugin++;
      } else if (dataType === 'helius') {
        byDataSource.api++;
      } else if (dataType === 'cache') {
        byDataSource.cache++;
      } else if (dataType === 'websocket') {
        byDataSource.websocket++;
      }
    }
  }

  return {
    total,
    hasData,
    needFetch: total - hasData,
    isProcessed,
    notProcessed: total - isProcessed,
    bySources,        // Signature 来源
    byDataSource      // 详细信息来源
  };
}
```

#### 2. App.jsx
修改 UI 显示,分两行显示:

```jsx
{heliusStats && (
  <>
    <div style={{ gridColumn: '1 / -1', fontSize: '10px', color: styles.colors.textSecondary }}>
      已处理: {heliusStats.isProcessed}/{heliusStats.total}
    </div>
    <div style={{ gridColumn: '1 / -1', fontSize: '9px', color: styles.colors.textSecondary, marginTop: '2px' }}>
      Sig来源: 初始={heliusStats.bySources.initial} WS={heliusStats.bySources.websocket} 插件={heliusStats.bySources.plugin} 校验={heliusStats.bySources.verify || 0}
    </div>
    {heliusStats.byDataSource && (
      <div style={{ gridColumn: '1 / -1', fontSize: '9px', color: styles.colors.textSecondary }}>
        详情来源: API={heliusStats.byDataSource.api} 缓存={heliusStats.byDataSource.cache} 插件={heliusStats.byDataSource.plugin} WS={heliusStats.byDataSource.websocket}
      </div>
    )}
  </>
)}
```

## 修改的文件

1. ✅ `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js`
   - 修改 `sendClearMetrics()` 方法

2. ✅ `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/sidepanel/App.jsx`
   - 修改 `toggleHeliusMonitor()` 方法
   - 修改统计信息显示

3. ✅ `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/SignatureManager.js`
   - 修改 `getStats()` 方法

## UI 显示效果

### 修改前
```
已处理: 16/16 | 来源: 初始=14 WS=2 插件=14 校验=0
```

### 修改后
```
已处理: 16/16
Sig来源: 初始=14 WS=2 插件=14 校验=0
详情来源: API=10 缓存=2 插件=4 WS=0
```

## 数据来源说明

### Signature 来源 (bySources)
- **初始**: 通过 `getSignaturesForAddress` 初始化时获取
- **WS**: 通过 WebSocket `logsSubscribe` 实时监听
- **插件**: 从 GMGN 页面 hook 捕获的 tx_hash
- **校验**: 30秒定期校验补充的遗漏 signatures

### 详细信息来源 (byDataSource)
- **API**: 通过 Helius `getTransaction` API 获取
- **缓存**: 从 IndexedDB 缓存读取
- **插件**: 从 GMGN 页面 hook 捕获的完整交易数据
- **WS**: 从 WebSocket 消息中获取的交易详情

## 测试步骤

### 测试 1: WebSocket 状态重置

1. 启用 Helius 监控
2. 观察 WebSocket 状态 (应该是 🟢 已连接)
3. 切换到另一个 mint 页面
4. **预期**: WebSocket 状态先变为 🔴 未连接,然后重新连接
5. 关闭监控开关
6. **预期**: WebSocket 状态变为 🔴 未连接
7. 重新打开监控开关
8. **预期**: WebSocket 状态重新连接,显示 🟢 已连接

### 测试 2: 数据来源分组显示

1. 启用 Helius 监控
2. 等待数据加载
3. 查看统计信息
4. **预期**: 看到两行:
   - `Sig来源: 初始=X WS=X 插件=X 校验=X`
   - `详情来源: API=X 缓存=X 插件=X WS=X`
5. 观察数字变化
6. **预期**:
   - Sig来源的总和可能 > 总数 (因为一个 sig 可能有多个来源)
   - 详情来源的总和 = 已处理数

### 测试 3: 完整流程

1. 打开 GMGN token 页面 A
2. 启用 Helius 监控
3. 观察 WebSocket 状态和数据来源
4. 切换到 token 页面 B
5. **预期**:
   - WebSocket 状态先断开再重连
   - 数据来源重新计数
6. 关闭监控开关
7. **预期**: 所有状态清空
8. 重新打开监控开关
9. **预期**: 重新初始化,数据从头开始

## 关键改进

### 1. 状态管理更清晰
- ✅ 切换 mint 时自动重置状态
- ✅ 关闭监控时清空所有状态
- ✅ 重新打开时完全重启

### 2. 数据来源更透明
- ✅ 区分 Signature 来源和详细信息来源
- ✅ 用户可以清楚知道数据从哪里来
- ✅ 便于调试和验证数据完整性

### 3. 用户体验改善
- ✅ 状态显示更准确
- ✅ 不会出现"已连接"但实际已断开的情况
- ✅ 数据来源一目了然

## 总结

所有问题已修复:
- ✅ WebSocket 状态在切换 mint 时正确重置
- ✅ 关闭监控时清空所有状态
- ✅ 数据来源分为两组显示 (Signature 来源 + 详细信息来源)
- ✅ UI 显示清晰易懂
