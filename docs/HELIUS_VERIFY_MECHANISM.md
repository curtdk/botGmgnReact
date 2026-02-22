# HeliusMonitor 定期校验机制 - 优化方案

## 校验逻辑说明

### 目的
确保不遗漏任何 signatures,即使 WebSocket 断开或插件捕获失败。

### 校验原理

**每30秒执行一次**:
1. 调用 Helius API `getSignaturesForAddress` 获取最新的 1000 个 signatures
2. 对比当前 SignatureManager 中已有的 signatures
3. 如果发现新的 signatures,添加并标记来源为 'verify'
4. 自动获取遗漏交易的详细数据

### 为什么是30秒?

- **太短 (如5秒)**: API 调用频繁,可能触发限流
- **太长 (如5分钟)**: 可能遗漏较多交易,用户体验差
- **30秒**: 平衡性能和实时性,及时发现遗漏

## 实现代码

### 修改文件: HeliusMonitor.js

```javascript
constructor(mintAddress) {
  // ... 现有代码 ...

  // 定期校验
  this.verifyInterval = null;
  this.lastVerifyTime = null;
}

async start() {
  // ... 现有启动代码 ...

  // 启动定期校验 (每 30 秒)
  this.verifyInterval = setInterval(() => {
    if (!this.isStopped && this.isInitialized) {
      this.verifySignatures();
    }
  }, 30 * 1000);  // 30秒

  console.log('[校验] 定期校验已启动 (间隔: 30秒)');
}

/**
 * 定期校验 signatures 完整性
 * 只获取最新的 signatures,不是全部历史
 */
async verifySignatures() {
  if (this.isStopped) return;

  const startTime = Date.now();
  console.log('[校验] 开始校验 signatures...');

  try {
    // 只获取最新的 1000 个 signatures (不是全部历史)
    const latestSigs = await this.dataFetcher.fetchSignatures(this.mint, {
      limit: 1000
    });

    if (this.isStopped) return;

    // 检查是否有新的 signatures
    let newCount = 0;
    const newSigs = [];

    latestSigs.forEach(sig => {
      if (!this.signatureManager.signatures.has(sig)) {
        this.signatureManager.addSignature(sig, 'verify');
        newSigs.push(sig);
        newCount++;
      }
    });

    if (newCount > 0) {
      console.log(`[校验] ⚠️  发现 ${newCount} 个遗漏的 signatures`);
      console.log(`[校验] 正在补充遗漏的交易数据...`);

      // 获取遗漏交易的详细数据
      const txs = await this.dataFetcher.fetchParsedTxs(newSigs, this.mint);

      if (this.isStopped) return;

      // 处理遗漏的交易
      for (const tx of txs) {
        if (this.isStopped) return;

        const sig = tx.transaction.signatures[0];
        this.signatureManager.markAsReceived(sig, tx);

        // 立即计算
        await this.processTransaction(tx, sig, 'verify');
      }

      console.log(`[校验] ✓ 已补充 ${newCount} 个遗漏的交易`);
    } else {
      console.log(`[校验] ✓ 没有遗漏 (耗时: ${Date.now() - startTime}ms)`);
    }

    this.lastVerifyTime = Date.now();

  } catch (error) {
    if (this.isStopped) return;
    console.error('[校验] 校验失败:', error.message);
  }
}

stop() {
  console.log('[系统] 正在停止监控...');

  // 1. 设置停止标志（最先执行）
  this.isStopped = true;

  // ... 现有清理代码 ...

  // 清理校验定时器
  if (this.verifyInterval) {
    clearInterval(this.verifyInterval);
    this.verifyInterval = null;
  }

  console.log('[系统] 监控已完全停止');
}

/**
 * 获取校验状态
 */
getVerifyStatus() {
  return {
    enabled: !!this.verifyInterval,
    lastVerifyTime: this.lastVerifyTime,
    timeSinceLastVerify: this.lastVerifyTime
      ? Date.now() - this.lastVerifyTime
      : null
  };
}
```

## 校验流程图

```
每30秒触发
    ↓
调用 getSignaturesForAddress (limit: 1000)
    ↓
获取最新的 1000 个 signatures
    ↓
对比 SignatureManager 中已有的
    ↓
发现新的? ──→ 否 ──→ 记录日志: "没有遗漏"
    ↓
   是
    ↓
添加到 SignatureManager (来源: verify)
    ↓
调用 fetchParsedTxs 获取交易详情
    ↓
调用 processTransaction 计算指标
    ↓
记录日志: "已补充 X 个遗漏的交易"
```

## 数据来源标记

校验发现的 signatures 会被标记为 `verify` 来源:

```javascript
// SignatureManager 中的来源
this.sources = {
  initial: new Set(),    // 初始化时获取
  websocket: new Set(),  // WebSocket 实时
  plugin: new Set(),     // 插件捕获
  verify: new Set()      // 校验补充 (新增)
};
```

## 在 SidePanel 显示校验状态

### 修改文件: App.jsx

```jsx
const [heliusVerifyStatus, setHeliusVerifyStatus] = useState({
  lastVerifyTime: null,
  timeSinceLastVerify: null
});

// 定期更新校验状态
useEffect(() => {
  if (!heliusMonitorEnabled) return;

  const interval = setInterval(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'GET_HELIUS_VERIFY_STATUS'
        }, (response) => {
          if (response) {
            setHeliusVerifyStatus(response);
          }
        });
      }
    });
  }, 5000);  // 每5秒更新一次显示

  return () => clearInterval(interval);
}, [heliusMonitorEnabled]);

// UI 显示
{heliusMonitorEnabled && heliusVerifyStatus.lastVerifyTime && (
  <div style={{
    fontSize: '10px',
    color: '#6b7280',
    marginTop: '4px'
  }}>
    上次校验: {Math.floor(heliusVerifyStatus.timeSinceLastVerify / 1000)}秒前
  </div>
)}
```

### 修改文件: HeliusIntegration.js

添加消息处理:

```javascript
// 在 setupMessageListener 中添加
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_HELIUS_VERIFY_STATUS') {
    if (this.monitor) {
      sendResponse(this.monitor.getVerifyStatus());
    }
    return true;
  }
  // ... 其他消息处理 ...
});
```

## 性能影响

### API 调用频率

- **校验**: 每30秒调用一次 `getSignaturesForAddress` (limit: 1000)
- **成本**: 1 个 API 调用 / 30秒 = 120 个调用 / 小时
- **Helius 免费额度**: 通常足够

### 如果发现遗漏

- 假设每次发现 5 个遗漏的 signatures
- 需要调用 5 次 `getTransaction`
- 总计: 120 + 5*120 = 720 个调用 / 小时

### 优化建议

如果 API 调用过多,可以:
1. 增加间隔到 60 秒
2. 减少 limit 到 500
3. 只在 WebSocket 断开时启用校验

## 测试验证

### 测试 1: 正常情况

1. 启动监控
2. 等待 30 秒
3. **预期**: 控制台显示 "[校验] ✓ 没有遗漏"

### 测试 2: 模拟遗漏

1. 启动监控
2. 手动断开 WebSocket (在代码中临时禁用)
3. 等待有新交易产生
4. 等待 30 秒
5. **预期**: 控制台显示 "[校验] ⚠️  发现 X 个遗漏的 signatures"
6. **预期**: 自动补充遗漏的交易

### 测试 3: 性能测试

1. 运行监控 1 小时
2. 检查 API 调用次数
3. **预期**: 约 120 次 getSignaturesForAddress 调用

## 关键文件

- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/HeliusMonitor.js` - 主要修改
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/DataFetcher.js` - 使用 fetchSignatures
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js` - 消息处理
- `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/sidepanel/App.jsx` - UI 显示

## 总结

- ✅ 每30秒自动校验一次
- ✅ 只获取最新的 1000 个 signatures (不是全部历史)
- ✅ 自动补充遗漏的交易
- ✅ 标记来源为 'verify'
- ✅ 在 SidePanel 显示校验状态
- ✅ 性能影响可控
