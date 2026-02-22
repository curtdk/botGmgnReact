# HeliusMonitor 数据来源追踪和 WebSocket 状态监控改进方案

## 当前状态

### 数据来源的三个方向

1. **初始 (Initial)**:
   - 只执行一次
   - 通过 `fetchHistorySigs()` 获取历史 signatures
   - 来源: Helius RPC `getSignaturesForAddress`

2. **WebSocket (WS)**:
   - 实时监听新交易
   - 通过 `logsSubscribe` 订阅 mint 地址
   - 来源: Helius WebSocket

3. **插件 (Plugin/GMGN)**:
   - 从 GMGN 页面捕获
   - 通过 hook.js 拦截 XHR 请求
   - 来源: GMGN API `/token_trades/`

### 当前统计显示

SidePanel 已经显示:
```
已处理: 428/428 | 来源: 初始=6 WS=411 插件=401
```

## 需要改进的功能

### 1. WebSocket 连接状态监控

**问题**: 如果 WebSocket 断开,用户不知道,可能会遗漏实时交易

**解决方案**: 添加 WS 状态追踪和 UI 显示

#### 修改文件: HeliusMonitor.js

添加状态追踪:

```javascript
constructor(mintAddress) {
  // ... 现有代码 ...

  // WebSocket 状态
  this.wsStatus = {
    connected: false,
    lastConnectTime: null,
    lastDisconnectTime: null,
    reconnectCount: 0,
    error: null
  };

  // 状态更新回调
  this.onWsStatusChange = null;
}

connectWs() {
  // ... 现有代码 ...

  this.ws.onopen = () => {
    if (this.isStopped) return;

    console.log('[WebSocket] 已连接，开始订阅实时日志...');

    // 更新状态
    this.wsStatus.connected = true;
    this.wsStatus.lastConnectTime = Date.now();
    this.wsStatus.error = null;
    this.notifyWsStatusChange();

    // ... 现有订阅代码 ...
  };

  this.ws.onclose = () => {
    if (this.isStopped) {
      console.log('[WebSocket] 实例已停止，不重连');
      return;
    }

    console.log('[WebSocket] 连接断开，3秒后重连...');

    // 更新状态
    this.wsStatus.connected = false;
    this.wsStatus.lastDisconnectTime = Date.now();
    this.wsStatus.reconnectCount++;
    this.notifyWsStatusChange();

    // ... 现有重连代码 ...
  };

  this.ws.onerror = (err) => {
    if (this.isStopped) return;

    console.error('[WebSocket] 错误:', err);

    // 更新状态
    this.wsStatus.error = err.message || 'WebSocket 连接错误';
    this.notifyWsStatusChange();
  };
}

// 新增：通知状态变化
notifyWsStatusChange() {
  if (this.onWsStatusChange) {
    this.onWsStatusChange(this.wsStatus);
  }
}

// 新增：获取 WS 状态
getWsStatus() {
  return {
    ...this.wsStatus,
    uptime: this.wsStatus.connected && this.wsStatus.lastConnectTime
      ? Date.now() - this.wsStatus.lastConnectTime
      : 0
  };
}
```

#### 修改文件: HeliusIntegration.js

传递 WS 状态到 SidePanel:

```javascript
async startMonitor(mint) {
  // ... 现有代码 ...

  // 设置 WS 状态回调
  this.monitor.onWsStatusChange = (status) => {
    chrome.runtime.sendMessage({
      type: 'HELIUS_WS_STATUS',
      status: status
    }).catch(() => {});
  };

  // ... 现有代码 ...
}
```

#### 修改文件: App.jsx (SidePanel)

显示 WS 状态:

```jsx
const [heliusWsStatus, setHeliusWsStatus] = useState({
  connected: false,
  lastConnectTime: null,
  reconnectCount: 0,
  error: null
});

// 在 message listener 中添加
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'HELIUS_WS_STATUS') {
    setHeliusWsStatus(msg.status);
  }
  // ... 其他消息处理 ...
});

// UI 显示
{heliusMonitorEnabled && (
  <div style={{
    padding: '8px',
    backgroundColor: heliusWsStatus.connected ? '#10b98120' : '#ef444420',
    borderRadius: '4px',
    marginBottom: '8px'
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: heliusWsStatus.connected ? '#10b981' : '#ef4444'
      }}></span>
      <span style={{ fontSize: '12px' }}>
        WebSocket: {heliusWsStatus.connected ? '已连接' : '未连接'}
      </span>
      {heliusWsStatus.reconnectCount > 0 && (
        <span style={{ fontSize: '10px', color: '#6b7280' }}>
          (重连 {heliusWsStatus.reconnectCount} 次)
        </span>
      )}
    </div>
    {heliusWsStatus.error && (
      <div style={{ fontSize: '10px', color: '#ef4444', marginTop: '4px' }}>
        错误: {heliusWsStatus.error}
      </div>
    )}
  </div>
)}
```

### 2. 详细信息中显示数据来源

**问题**: 用户想知道每条交易数据来自哪个来源

**解决方案**: 在交易详情中显示来源标记

#### 修改文件: MetricsEngine.js

在 traderHistory 中记录来源:

```javascript
updateTraderState(user, solChange, tokenChange, signature, timestamp = '未知', source = '未知') {
  // ... 现有代码 ...

  // 记录历史
  if (!this.traderHistory[user]) {
    this.traderHistory[user] = [];
  }

  this.traderHistory[user].push({
    signature,
    timestamp,
    source,  // 记录来源
    solChange,
    tokenChange,
    // ... 其他字段 ...
  });
}
```

#### 修改文件: App.jsx (SidePanel)

在详细信息中显示来源:

```jsx
// 在交易列表中添加来源标记
{traderHistory.map((tx, index) => (
  <div key={index} style={{
    padding: '4px 8px',
    borderBottom: '1px solid #e5e7eb',
    fontSize: '11px'
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span>{tx.timestamp}</span>
      <span style={{
        padding: '2px 6px',
        borderRadius: '3px',
        backgroundColor:
          tx.source === 'initial' ? '#3b82f620' :
          tx.source === 'websocket' ? '#10b98120' :
          '#f59e0b20',
        color:
          tx.source === 'initial' ? '#3b82f6' :
          tx.source === 'websocket' ? '#10b981' :
          '#f59e0b',
        fontSize: '9px'
      }}>
        {tx.source === 'initial' ? '初始' :
         tx.source === 'websocket' ? 'WS' :
         '插件'}
      </span>
    </div>
    <div>
      SOL: {tx.solChange.toFixed(4)} |
      Token: {tx.tokenChange.toFixed(2)}
    </div>
  </div>
))}
```

### 3. 确保不遗漏 Signatures 的机制

**问题**: 依靠 WS 和插件可能会遗漏一些 signatures

**解决方案**: 添加定期校验机制

#### 修改文件: HeliusMonitor.js

添加定期校验:

```javascript
constructor(mintAddress) {
  // ... 现有代码 ...

  // 定期校验
  this.verifyInterval = null;
}

async start() {
  // ... 现有启动代码 ...

  // 启动定期校验 (每 5 分钟)
  this.verifyInterval = setInterval(() => {
    if (!this.isStopped) {
      this.verifySignatures();
    }
  }, 5 * 60 * 1000);
}

/**
 * 定期校验 signatures 完整性
 */
async verifySignatures() {
  console.log('[校验] 开始校验 signatures 完整性...');

  try {
    // 重新获取最新的 signatures
    const { allSigs } = await this.dataFetcher.fetchHistorySigs(this.mint);

    // 检查是否有新的 signatures
    let newCount = 0;
    allSigs.forEach(sig => {
      if (!this.signatureManager.signatures.has(sig)) {
        this.signatureManager.addSignature(sig, 'verify');
        newCount++;
      }
    });

    if (newCount > 0) {
      console.log(`[校验] 发现 ${newCount} 个遗漏的 signatures，正在补充...`);

      // 获取遗漏的交易数据
      const missingSigs = Array.from(this.signatureManager.signatures.keys())
        .filter(sig => !this.signatureManager.signatures.get(sig).hasData);

      if (missingSigs.length > 0) {
        await this.fetchMissingTransactions();
      }
    } else {
      console.log('[校验] 没有遗漏的 signatures');
    }
  } catch (error) {
    console.error('[校验] 校验失败:', error);
  }
}

stop() {
  // ... 现有清理代码 ...

  // 清理校验定时器
  if (this.verifyInterval) {
    clearInterval(this.verifyInterval);
    this.verifyInterval = null;
  }

  // ... 其他清理 ...
}
```

## 实施顺序

1. **HeliusMonitor.js** - 添加 WS 状态追踪和定期校验
2. **HeliusIntegration.js** - 传递 WS 状态到 SidePanel
3. **App.jsx** - 显示 WS 状态和数据来源标记
4. **MetricsEngine.js** - 确保 source 字段正确传递

## 测试验证

### 测试 1: WebSocket 状态显示

1. 打开 GMGN token 页面
2. 启动 Helius 监控
3. **预期**: 看到 "WebSocket: 已连接" 绿色指示器

### 测试 2: WebSocket 断开提示

1. 断开网络连接
2. **预期**: 看到 "WebSocket: 未连接" 红色指示器
3. 恢复网络
4. **预期**: 自动重连,显示 "WebSocket: 已连接"

### 测试 3: 数据来源标记

1. 查看交易详情
2. **预期**: 每条交易显示来源标记 (初始/WS/插件)

### 测试 4: 定期校验

1. 运行监控 5 分钟以上
2. **预期**: 控制台显示 "[校验] 开始校验 signatures 完整性..."
3. 如果有遗漏,显示补充信息

## 关键文件

- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/HeliusMonitor.js`
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js`
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/sidepanel/App.jsx`
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/MetricsEngine.js`

## 预期效果

- ✅ 实时显示 WebSocket 连接状态
- ✅ 断开时有明确的红色警告
- ✅ 每条交易数据显示来源标记
- ✅ 定期校验确保不遗漏 signatures
- ✅ 用户可以清楚知道数据的完整性
