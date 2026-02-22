# 持有人启动页面黑屏问题修复

## 问题现象

1. 点击"持有人启动"后页面只显示黑底色
2. 控制台错误：
   - `Cannot read properties of undefined (reading 'slice')`
   - `Could not establish connection. Receiving end does not exist.`
   - `[Helius集成] Monitor 未启动，无法处理 holder 数据`

## 根本原因

### 1. Mint 切换导致 Monitor 停止

**日志分析**：
```
17:00:32 - Monitor 启动（mint: 6Hd7...pump）
17:00:52 - 收到 holder 数据但 hasMonitor: false
17:00:58 - Monitor 重新启动（mint: GNt8...pump）← 不同的 mint！
17:01:18 - 又收到 holder 数据但 hasMonitor: false
```

**问题**：
- 用户切换了不同的 mint 页面
- HeliusIntegration 每 5 秒检查一次 mint 地址
- 当检测到 mint 变化时，停止旧 Monitor 并启动新 Monitor
- 但旧的 holder 数据请求可能还在进行中
- 这些请求返回时，Monitor 已经是 null，导致数据无法处理

### 2. React 组件崩溃

**错误位置**：
- [App.jsx:491](src/sidepanel/App.jsx#L491) - `mint.slice(0,6)` 当 mint 是 undefined 时崩溃
- [App.jsx:1328](src/sidepanel/App.jsx#L1328) - `it.owner.slice(0, 4)` 当 owner 是 undefined 时崩溃

**原因**：
- 当 Monitor 停止时，可能发送了空数据或不完整数据
- React 组件没有对 undefined 值进行保护
- 导致 slice 方法调用失败，组件崩溃，页面黑屏

## 修复方案

### 修复 1: 添加 mint 参数验证

**文件**：[App.jsx:489](src/sidepanel/App.jsx#L489)

```javascript
const initPageLogic = (mint) => {
    if (!mint) {
        console.warn('[GMGN App] Init page called with invalid mint:', mint);
        return;
    }
    console.log('[GMGN App] Init page for mint:', mint);
    addLog(`检测到新代币: ${mint.slice(0,6)}...`);
    // ... 后续代码
}
```

**效果**：防止 mint 为 undefined 时调用 slice 导致崩溃

### 修复 2: 添加 owner 参数保护

**文件**：[App.jsx:1325](src/sidepanel/App.jsx#L1325)

```javascript
case 'address':
    style.fontFamily = 'monospace';
    style.title = it.owner || '';
    content = it.main_address_short || (it.owner ? it.owner.slice(0, 4) : 'N/A');
    break;
```

**效果**：防止 owner 为 undefined 时调用 slice 导致崩溃

### 修复 3: 优化日志（已完成）

**文件**：[MetricsEngine.js](src/helius/MetricsEngine.js)

- 添加防重复日志机制
- 只有当指标变化或距离上次日志超过5秒时才记录

### 修复 4: 添加详细评分日志（已完成）

**文件**：[ScoringEngine.js](src/helius/ScoringEngine.js)

- 显示前3个用户的详细评分信息
- 添加分数分布统计
- 显示庄家数、散户数、平均分数

## 建议的进一步优化

### 1. 改进 Monitor 生命周期管理

**问题**：当 mint 切换时，旧的数据请求可能还在进行中

**建议**：
```javascript
// HeliusIntegration.js
async checkAndInitMonitor() {
    const mint = getMintFromPage();

    // 如果 mint 变化，取消所有待处理的请求
    if (mint !== this.currentMint && this.monitor) {
        console.log('[Helius集成] Mint 变化，取消待处理请求');
        // 添加请求取消逻辑
        this.cancelPendingRequests();
        this.monitor.stop();
    }

    // ... 后续代码
}
```

### 2. 添加 React 错误边界

**建议**：在 App.jsx 中添加错误边界组件

```javascript
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, errorInfo) {
        console.error('[GMGN App] 组件错误:', error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{ padding: '20px', color: '#fff' }}>
                    <h2>出错了</h2>
                    <p>{this.state.error?.message}</p>
                    <button onClick={() => window.location.reload()}>
                        刷新页面
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

// 使用
<ErrorBoundary>
    <App />
</ErrorBoundary>
```

### 3. 改进数据验证

**建议**：在 HeliusIntegration 分发数据前验证数据完整性

```javascript
distributeDataToContentManager() {
    if (!this.monitor) return;

    const userInfo = this.monitor.metricsEngine.userInfo;
    const metrics = this.monitor.getMetrics();

    // 验证数据完整性
    const holdersData = Object.values(userInfo)
        .filter(info => info && info.owner) // 过滤无效数据
        .map(info => ({
            ...info,
            owner: info.owner || 'unknown',
            status: info.status || '散户',
            score: info.score || 0,
            score_reasons: info.score_reasons || []
        }));

    if (holdersData.length === 0) {
        console.warn('[HeliusIntegration] 没有有效的用户数据');
        return;
    }

    // 发送数据
    chrome.runtime.sendMessage({
        type: 'UPDATE_PLUGIN_DATA',
        data: {
            holders: holdersData,
            metrics: metrics
        }
    });
}
```

## 测试验证

### 测试场景 1: 正常启动

**操作**：
1. 打开 GMGN mint 页面
2. 点击"持有人启动"
3. 观察页面和日志

**预期**：
- ✅ 页面正常显示用户列表
- ✅ 不出现黑屏
- ✅ 日志显示正常的数据流

### 测试场景 2: Mint 切换

**操作**：
1. 在 mint A 页面启动监控
2. 切换到 mint B 页面
3. 点击"持有人启动"
4. 观察页面和日志

**预期**：
- ✅ Monitor 正确停止和重启
- ✅ 页面不出现黑屏
- ✅ 新 mint 的数据正确显示

### 测试场景 3: 快速切换

**操作**：
1. 快速在多个 mint 页面之间切换
2. 观察页面稳定性

**预期**：
- ✅ 页面不崩溃
- ✅ 最终显示当前 mint 的数据
- ✅ 没有数据混乱

## 总结

通过以下修复，解决了"持有人启动"页面黑屏问题：

1. ✅ 添加 mint 参数验证，防止 undefined.slice() 错误
2. ✅ 添加 owner 参数保护，防止 undefined.slice() 错误
3. ✅ 优化日志，减少重复输出
4. ✅ 添加详细评分日志，便于调试

**建议**：
- 考虑添加 React 错误边界
- 改进 Monitor 生命周期管理
- 加强数据验证
