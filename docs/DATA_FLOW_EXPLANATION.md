# Helius 监控系统 - 数据流和计算方法详解

## 📊 数据来源和处理流程

### 1. 三个数据来源

系统从三个不同的来源收集 **transaction signatures**（交易签名）：

#### 来源 1: 初始 API (getSignaturesForAddress)
- **位置**: `DataFetcher.fetchHistorySigs()`
- **数据**: 只有 signature（字符串）
- **特点**:
  - 获取历史所有交易的 signatures
  - 支持增量获取（通过 until 参数）
  - 从 IndexedDB 缓存加载已有的 signatures

```javascript
// 返回的数据格式
[
  "5Kx7abc...",  // signature 字符串
  "3Hy9def...",
  ...
]
```

#### 来源 2: WebSocket (logsNotification)
- **位置**: `HeliusMonitor.connectWs()`
- **数据**: 只有 signature（字符串）
- **特点**:
  - 实时推送新交易的 signatures
  - 订阅特定 mint 地址的交易

```javascript
// WebSocket 消息格式
{
  method: 'logsNotification',
  params: {
    result: {
      value: {
        signature: "5Kx7abc..."  // 只有 signature
      }
    }
  }
}
```

#### 来源 3: GMGN 插件 (token_trades)
- **位置**: `hook.js` → `HeliusIntegration.js`
- **数据**: 只有 tx_hash（等同于 signature）
- **特点**:
  - 从 GMGN API 的 token_trades 接口获取
  - 包含分页数据
  - 只提取 tx_hash 字段

```javascript
// GMGN token_trades 返回的数据格式
{
  data: {
    history: [
      {
        tx_hash: "5Kx7abc...",  // 只提取这个字段
        timestamp: 1234567890,
        // ... 其他字段被忽略
      },
      ...
    ]
  }
}
```

---

### 2. Signature 存储（SignatureManager）

**关键点**: 所有三个来源提供的都只是 **signature**，没有完整的交易详情。

```javascript
// SignatureManager 存储格式
Map<signature, {
  hasData: false,           // 初始为 false，表示只有 signature，没有交易详情
  isProcessed: false,       // 是否已计算过
  sources: Set(['plugin']), // 数据来源
  timestamp: 1234567890,    // 首次发现时间
  txData: null              // 初始为 null，后续通过 API 获取
}>
```

**处理流程**:

1. **hook.js 捕获 GMGN 数据**:
```javascript
// 第 96-117 行
if (this._url.includes('/token_trades/')) {
  const json = JSON.parse(this.responseText);
  const trades = json.data?.history || json.data || [];
  const signatures = [];

  trades.forEach(trade => {
    if (trade.tx_hash) {
      signatures.push(trade.tx_hash);  // 只提取 tx_hash
    }
  });

  // 分发事件
  window.dispatchEvent(new CustomEvent('HOOK_SIGNATURES_EVENT', {
    detail: { signatures, source: 'plugin' }
  }));
}
```

2. **HeliusIntegration.js 接收并存储**:
```javascript
// 第 42-52 行
window.addEventListener('HOOK_SIGNATURES_EVENT', (event) => {
  const { signatures, source } = event.detail;

  signatures.forEach(sig => {
    // 只存储 signature，hasData=false, txData=null
    this.monitor.signatureManager.addSignature(sig, source);
  });
});
```

3. **SignatureManager.addSignature()**:
```javascript
// 第 37-59 行
addSignature(sig, source) {
  if (!this.signatures.has(sig)) {
    this.signatures.set(sig, {
      hasData: false,      // 关键：初始为 false
      isProcessed: false,
      sources: new Set([source]),
      timestamp: Date.now(),
      txData: null         // 关键：初始为 null
    });
  }
}
```

---

### 3. 获取完整交易详情（fetchParsedTxs）

**关键点**: GMGN 数据和 fetchParsedTxs 获取的数据**完全不同**。

#### GMGN 提供的数据
```javascript
{
  tx_hash: "5Kx7abc..."  // 只有这一个字段被使用
}
```

#### fetchParsedTxs 获取的完整数据
```javascript
{
  transaction: {
    signatures: ["5Kx7abc..."],
    message: {
      accountKeys: [
        { pubkey: "feePayer地址" },  // 交易发起者
        ...
      ]
    }
  },
  meta: {
    err: null,                    // 交易是否失败
    preBalances: [1000000000],    // 交易前 SOL 余额（lamports）
    postBalances: [900000000],    // 交易后 SOL 余额（lamports）
    preTokenBalances: [           // 交易前代币余额
      {
        owner: "feePayer地址",
        mint: "代币地址",
        uiTokenAmount: {
          uiAmount: 0             // 交易前代币数量
        }
      }
    ],
    postTokenBalances: [          // 交易后代币余额
      {
        owner: "feePayer地址",
        mint: "代币地址",
        uiTokenAmount: {
          uiAmount: 1000          // 交易后代币数量
        }
      }
    ]
  },
  blockTime: 1234567890
}
```

**获取流程**:

1. **HeliusMonitor.fetchMissingTransactions()**:
```javascript
// 第 195-217 行
async fetchMissingTransactions() {
  // 获取所有 hasData=false 的 signatures
  const missingSigs = this.signatureManager.getMissingSignatures();

  // 1. 先从 IndexedDB 缓存加载
  const cachedTxs = await this.cacheManager.loadTransactionsBySignatures(missingSigs);
  cachedTxs.forEach(tx => {
    const sig = tx.transaction.signatures[0];
    this.signatureManager.markHasData(sig, tx);  // 标记 hasData=true, 存储 txData
  });

  // 2. 获取仍然缺失的
  const stillMissing = this.signatureManager.getMissingSignatures();

  // 3. 批量调用 fetchParsedTxs
  const txs = await this.dataFetcher.fetchParsedTxs(stillMissing, this.mint);
  txs.forEach(tx => {
    const sig = tx.transaction.signatures[0];
    this.signatureManager.markHasData(sig, tx);  // 标记 hasData=true, 存储 txData
  });
}
```

2. **DataFetcher.fetchParsedTxs()**:
```javascript
// 第 108-146 行
async fetchParsedTxs(signatures, mintAddress) {
  const CONCURRENCY = 5;
  let allTxs = [];

  for (let i = 0; i < signatures.length; i += CONCURRENCY) {
    const batchSigs = signatures.slice(i, i + CONCURRENCY);

    const promises = batchSigs.map(async (sig) => {
      // 调用 Helius RPC API
      const result = await this.call('getTransaction', [
        sig,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
        }
      ]);

      // 立即缓存到 IndexedDB
      if (result && mintAddress && this.cacheManager) {
        await this.cacheManager.saveTransaction(sig, mintAddress, result);
      }
      return result;
    });

    const results = await Promise.all(promises);
    allTxs.push(...results.filter(tx => tx));
  }

  return allTxs;  // 返回完整的交易详情
}
```

3. **SignatureManager.markHasData()**:
```javascript
// 第 64-81 行
markHasData(sig, txData) {
  const entry = this.signatures.get(sig);

  if (!entry.hasData) {
    entry.hasData = true;      // 标记为已有数据
    entry.txData = txData;     // 存储完整的交易详情
  }
}
```

---

### 4. 指标计算（MetricsEngine）

**关键点**: 计算使用的是 fetchParsedTxs 获取的**完整交易详情**，不是 GMGN 的原始数据。

#### 计算流程

1. **HeliusMonitor.performInitialCalculation()**:
```javascript
// 第 222-250 行
async performInitialCalculation() {
  // 获取所有 hasData=true 且 isProcessed=false 的交易
  const readySignatures = this.signatureManager.getReadySignatures();

  // 按时间倒排序（从旧到新）
  readySignatures.sort((a, b) => a.timestamp - b.timestamp);

  // 逐个处理
  for (const item of readySignatures) {
    // 使用完整的 txData 进行计算
    this.metricsEngine.processTransaction(item.txData, this.mint);
    this.signatureManager.markProcessed(item.sig);
  }
}
```

2. **MetricsEngine.processTransaction()**:
```javascript
// 第 29-69 行
processTransaction(tx, mintAddress) {
  // tx 是完整的交易详情，包含 transaction 和 meta
  const meta = tx.meta;
  const feePayer = tx.transaction.message.accountKeys[0].pubkey;

  // 1. 解析 SOL 变化
  const preSol = meta.preBalances[0];      // 交易前 SOL 余额
  const postSol = meta.postBalances[0];    // 交易后 SOL 余额
  const solChange = (postSol - preSol) / 1e9;  // 单位转换为 SOL

  // 2. 解析代币变化
  const findBal = (balances) => {
    const b = balances.find(b => b.owner === feePayer && b.mint === mintAddress);
    return b ? b.uiTokenAmount.uiAmount || 0 : 0;
  };

  const preToken = findBal(meta.preTokenBalances);   // 交易前代币余额
  const postToken = findBal(meta.postTokenBalances); // 交易后代币余额
  const tokenChange = postToken - preToken;

  // 3. 更新交易者状态
  this.updateTraderState(feePayer, solChange, tokenChange);

  // 4. 更新价格
  if (tokenChange !== 0 && Math.abs(solChange) > 0.000001) {
    this.currentPrice = Math.abs(solChange) / Math.abs(tokenChange);
  }
}
```

3. **MetricsEngine.updateTraderState()**:
```javascript
// 第 85-110 行
updateTraderState(user, solChange, tokenChange) {
  if (!this.traderStats[user]) {
    this.traderStats[user] = {
      netSolSpent: 0,        // 净 SOL 花费
      netTokenReceived: 0,   // 净代币收到
      totalBuySol: 0,        // 买入总额
      totalSellSol: 0        // 卖出总额
    };
  }
  const stats = this.traderStats[user];

  // 买入：SOL 减少，代币增加
  if (solChange < -0.000001 && tokenChange > 0) {
    const cost = Math.abs(solChange);
    stats.netSolSpent += cost;
    stats.totalBuySol += cost;
    stats.netTokenReceived += tokenChange;
  }
  // 卖出：SOL 增加，代币减少
  else if (solChange > 0.000001 && tokenChange < 0) {
    const revenue = solChange;
    stats.netSolSpent -= revenue;
    stats.totalSellSol += revenue;
    stats.netTokenReceived += tokenChange;
  }
}
```

4. **MetricsEngine.getMetrics()**:
```javascript
// 第 115-153 行
getMetrics() {
  let yiLuDai = 0;           // 已落袋
  let benLunXiaZhu = 0;      // 本轮下注
  let currentHoldersRealized = 0;  // 当前持有者的卖出收入
  let floatingPnL = 0;       // 浮盈浮亏
  let exitedCount = 0;       // 已退出用户数
  let activeCount = 0;       // 活跃用户数

  Object.values(this.traderStats).forEach(stats => {
    const isExited = stats.netTokenReceived < 1;  // 持仓 < 1 视为已退出

    if (isExited) {
      // 已退出用户：计算实现盈亏
      yiLuDai += (stats.totalSellSol - stats.totalBuySol);
      exitedCount++;
    } else {
      // 当前持有者
      benLunXiaZhu += stats.totalBuySol;
      currentHoldersRealized += stats.totalSellSol;
      activeCount++;

      // 浮盈浮亏 = 持仓价值 - 净成本
      const value = stats.netTokenReceived * this.currentPrice;
      const cost = stats.netSolSpent;
      floatingPnL += (value - cost);
    }
  });

  const benLunChengBen = benLunXiaZhu - currentHoldersRealized;

  return {
    yiLuDai,           // 已落袋 = Σ(卖出收入 - 买入成本) for 已退出用户
    benLunXiaZhu,      // 本轮下注 = Σ(买入总额) for 当前持有者
    benLunChengBen,    // 本轮成本 = 本轮下注 - 当前持有者的卖出收入
    floatingPnL,       // 浮盈浮亏 = Σ(持仓价值 - 净成本) for 当前持有者
    currentPrice: this.currentPrice,
    activeCount,
    exitedCount,
    totalProcessed: this.processedCount
  };
}
```

---

## 🔑 关键结论

### 1. GMGN trades 和 fetchParsedTxs 的数据不一样

| 数据源 | 提供的数据 | 用途 |
|--------|-----------|------|
| **GMGN trades** | 只有 `tx_hash`（signature） | 告诉系统"有这个交易" |
| **fetchParsedTxs** | 完整的交易详情（preBalances, postBalances, preTokenBalances, postTokenBalances） | 用于计算指标 |

### 2. 数据转换流程

```
GMGN trades (tx_hash)
    ↓
SignatureManager (hasData=false, txData=null)
    ↓
fetchParsedTxs (调用 Helius API)
    ↓
SignatureManager (hasData=true, txData=完整交易详情)
    ↓
MetricsEngine (使用 txData 计算指标)
```

### 3. 参与计算的数据来源

**最终参与计算的数据**:
- **来源**: Helius RPC API 的 `getTransaction` 方法
- **数据**: 完整的交易详情，包括：
  - `meta.preBalances` / `meta.postBalances`: SOL 余额变化
  - `meta.preTokenBalances` / `meta.postTokenBalances`: 代币余额变化
  - `transaction.message.accountKeys[0].pubkey`: 交易发起者地址

**GMGN trades 的作用**:
- 只提供 signature，告诉系统"有这个交易"
- 不直接参与计算
- 作用是补充 signature 列表，确保不遗漏任何交易

### 4. 计算方法

#### 每个交易的处理
```javascript
// 1. 提取 SOL 变化
solChange = (postSol - preSol) / 1e9

// 2. 提取代币变化
tokenChange = postToken - preToken

// 3. 判断买入还是卖出
if (solChange < 0 && tokenChange > 0) {
  // 买入：SOL 减少，代币增加
  netSolSpent += |solChange|
  totalBuySol += |solChange|
  netTokenReceived += tokenChange
}
else if (solChange > 0 && tokenChange < 0) {
  // 卖出：SOL 增加，代币减少
  netSolSpent -= solChange
  totalSellSol += solChange
  netTokenReceived += tokenChange
}

// 4. 更新价格
currentPrice = |solChange| / |tokenChange|
```

#### 指标计算
```javascript
// 遍历所有交易者
for (user in traderStats) {
  if (user.netTokenReceived < 1) {
    // 已退出用户
    yiLuDai += (user.totalSellSol - user.totalBuySol)
    exitedCount++
  } else {
    // 当前持有者
    benLunXiaZhu += user.totalBuySol
    currentHoldersRealized += user.totalSellSol
    activeCount++

    // 浮盈浮亏
    value = user.netTokenReceived * currentPrice
    cost = user.netSolSpent
    floatingPnL += (value - cost)
  }
}

benLunChengBen = benLunXiaZhu - currentHoldersRealized
```

---

## 📝 总结

1. **GMGN trades 只提供 signature**，不提供完整交易详情
2. **fetchParsedTxs 提供完整交易详情**，包含 SOL 和代币余额变化
3. **最终计算使用的是 fetchParsedTxs 的数据**，不是 GMGN 的原始数据
4. **GMGN 的作用是补充 signature 列表**，确保不遗漏交易
5. **所有三个数据源（初始 API、WebSocket、GMGN）都只提供 signature**
6. **真正的交易详情都是通过 Helius RPC API 获取的**

这就是为什么即使 GMGN 提供了 trades 数据，系统仍然需要调用 fetchParsedTxs 来获取完整的交易详情进行计算。
