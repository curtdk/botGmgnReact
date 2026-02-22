# Helius 批量 API 测试结果

## 测试日期
2026-02-19

## 测试 Mint
7CzCAKDXLzJCMooZpct3pZm7YBu5GLTsmfCzowwLpump

## 测试 Signatures
- 4cj4ixhH8QnFJwC32vQP319eBDncqatwHshjFguwko1r2XBSW3VMT6WGebZkrZsXx9iEvsPs9FoJghmoTcfWSCAw
- 3M64Y74vBSjivaaEsYcYr2GxVZLairXYZUHvtH9nRMKJAW64DXp5kdGGz9nWqudRWaCix511Rra8smssMaWFVBTN
- 3xGPPxk6xU4Xfb8cP4Jj7q1c3ZsAmf12JuTtuBFAHB3Akt4Qh7DFL6Nk2kqFwkipKq4QxZNPYJKPc2xeg5zuJ4og

## 测试结果

### 1. 特殊批量方法 - ❌ 不支持

测试了以下方法,全部返回 "Method not found":
- `getTransactions`
- `getMultipleTransactions`
- `getTransactionBatch`
- `batchGetTransaction`
- `getTransactionsBatch`
- `getParsedTransactions`
- `getMultipleParsedTransactions`

**结论**: Helius 没有提供特殊的批量获取交易方法。

### 2. JSON-RPC 批量请求 - ⚠️ 需要付费计划

测试标准的 JSON-RPC 批量请求格式(在一个 HTTP 请求中发送多个 `getTransaction` 调用):

```javascript
// 批量请求格式
[
  { jsonrpc: "2.0", id: 1, method: "getTransaction", params: [...] },
  { jsonrpc: "2.0", id: 2, method: "getTransaction", params: [...] },
  { jsonrpc: "2.0", id: 3, method: "getTransaction", params: [...] }
]
```

**返回错误**:
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32403,
    "message": "Batch requests are only available for paid plans. Please upgrade if you would like to gain access"
  }
}
```

**结论**: JSON-RPC 批量请求是支持的,但需要 Helius 付费计划。

## 当前 API Key 状态

API Key: `2304ce34-8d7d-4b15-a6cf-25722d048b45`

- 类型: 免费计划
- 批量请求: ❌ 不支持

## 建议

### 选项 1: 保持当前实现 (免费计划)

如果继续使用免费计划,保持当前的 [DataFetcher.js](../src/helius/DataFetcher.js) 实现:

```javascript
async fetchParsedTxs(signatures, mintAddress) {
  const CONCURRENCY = 5; // 并发数
  // 每次获取 5 个交易,串行批次
}
```

**优点**:
- 无需修改代码
- 免费使用

**缺点**:
- 性能较慢(每个交易单独请求)
- 受限流限制

### 选项 2: 升级到付费计划 + 使用批量请求

升级 Helius 到付费计划后,修改 DataFetcher.js 使用 JSON-RPC 批量请求:

```javascript
async fetchParsedTxs(signatures, mintAddress) {
  const BATCH_SIZE = 100; // 每批 100 个

  for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
    const batchSigs = signatures.slice(i, i + BATCH_SIZE);

    // 构建批量请求
    const batchRequest = batchSigs.map((sig, index) => ({
      jsonrpc: '2.0',
      id: i + index,
      method: 'getTransaction',
      params: [sig, { encoding: "jsonParsed", ... }]
    }));

    // 一次 HTTP 请求获取所有交易
    const response = await fetch(RPC_URL, {
      method: 'POST',
      body: JSON.stringify(batchRequest)
    });

    const results = await response.json();
    // 处理结果...
  }
}
```

**优点**:
- 大幅提升性能(预计 5-10x)
- 减少 HTTP 请求次数
- 减少限流风险

**缺点**:
- 需要付费(查看 Helius 定价)
- 需要修改代码

### 选项 3: 优化当前实现

在免费计划下,优化并发控制:

```javascript
async fetchParsedTxs(signatures, mintAddress) {
  const CONCURRENCY = 10; // 提高并发数到 10
  // 使用 Promise.allSettled 处理失败
}
```

**优点**:
- 免费
- 小幅性能提升

**缺点**:
- 可能触发限流
- 性能提升有限

## 最终建议

**如果预算允许**: 升级到 Helius 付费计划,使用 JSON-RPC 批量请求,性能提升显著。

**如果使用免费计划**: 保持当前实现,或适当提高并发数(从 5 提高到 8-10)。

## 相关文件

- 测试脚本:
  - [test-helius-batch-node.js](../test-helius-batch-node.js)
  - [test-alternative-methods.js](../test-alternative-methods.js)
  - [test-jsonrpc-batch.js](../test-jsonrpc-batch.js)
- 当前实现: [src/helius/DataFetcher.js](../src/helius/DataFetcher.js)
