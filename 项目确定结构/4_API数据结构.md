# API 数据结构

## 概述

本项目主要使用两个 API：
1. **GMGN API** - 获取 holder 和 trade 数据
2. **Helius API** - 实时监听链上交易（WebSocket）

## 1. GMGN API

### 1.1 Holder API

**接口**: 未公开（通过拦截 GMGN 网站请求获取）

**请求方式**: GET

**响应结构**:
```javascript
{
  data: {
    list: [
      {
        // 原始字段（可能的字段名）
        owner: "8F5pDmMVfKVQUU2TtjehFDkKqMKKQpxr2TTaYxwK6bFG",  // 或 address, wallet_address
        amount: "1000000000000",           // 持仓数量（字符串，最小单位）
        ui_amount: 1000000,                // 持仓数量（浮点数）
        holding_share_pct: 5.2,            // 持仓占比 (%)
        total_buy_u: 100,                  // 总买入金额 (USD)
        usd_value: 520,                    // 当前价值 (USD)
        netflow_usd: 50,                   // 净流入金额 (USD)
        created_at: 1234567890,            // 创建时间戳

        // 资金来源信息
        native_transfer: {
          name: "Binance",                 // 来源名称
          from_address: "Binance地址",     // 资助地址
          amount: "1000000000",            // 转账金额
          timestamp: 1234567890,           // 时间戳
          tx_hash: "交易哈希",             // 交易哈希
          block_timestamp: 1234567890      // 区块时间戳
        }
      }
    ]
  }
}
```

### 1.2 Normalize 后的数据结构

经过 `normalize()` 函数处理后，统一为以下格式：

```javascript
{
  owner: "8F5pDmMVfKVQUU2TtjehFDkKqMKKQpxr2TTaYxwK6bFG",
  amount: "1000000000000",
  ui_amount: 1000000,
  usd_value: 520,
  total_buy_u: 100,
  netflow_amount: 50,
  holding_share_pct: 5.2,
  created_at: 1234567890,
  funding_account: "Binance地址",
  native_transfer: {
    name: "Binance",
    from_address: "Binance地址",
    amount: "1000000000",
    timestamp: 1234567890,
    tx_hash: "交易哈希"
  },
  status: "散户"
}
```

### 1.3 字段映射规则

```javascript
// api.js normalize() 函数
const owner = x.owner || x.address || x.wallet_address;
const amount = String(x.amount || x.balance || '0');
const ui_amount = parseFloat(x.ui_amount || x.uiAmount || x.amount_cur || 0);
const usd_value = parseFloat(x.usd_value || x.value || x.amount_usd || 0);
const total_buy_u = parseFloat(x.total_buy_u || x.buy_volume_cur || 0);
const holding_share_pct = parseFloat(x.holding_share_pct || x.amount_percentage || 0);
const netflow_amount = parseFloat(x.netflow_usd || 0);
const created_at = x.created_at || x.open_timestamp || 0;
const from_address = (x.native_transfer && x.native_transfer.from_address) || x.funder || '';
```

### 1.4 Trade API

**接口**: 未公开（通过拦截 GMGN 网站请求获取）

**请求方式**: GET

**响应结构**:
```javascript
{
  data: {
    list: [
      {
        signature: "交易签名",
        owner: "交易者地址",
        action: "buy" | "sell",
        amount: 1000000,              // 代币数量
        sol_amount: 1.5,              // SOL 数量
        price: 0.0000015,             // 价格
        timestamp: 1234567890,        // 时间戳
        tx_hash: "交易哈希"
      }
    ]
  }
}
```

## 2. Helius API

### 2.1 Transaction API

**接口**: `v0/addresses/{mint}/transactions`

**请求方式**: GET

**响应结构**:
```javascript
[
  {
    description: "",
    type: "SWAP",
    source: "PUMP_FUN",
    fee: 1005000,
    feePayer: "交易发起人地址",
    signature: "交易签名",
    slot: 396430764,
    timestamp: 1769583235,

    // 代币转移记录
    tokenTransfers: [
      {
        fromTokenAccount: "发送方 Token Account",
        toTokenAccount: "接收方 Token Account",
        fromUserAccount: "发送方钱包地址",
        toUserAccount: "接收方钱包地址",
        tokenAmount: 13451405.645718,
        mint: "代币 Mint 地址",
        tokenStandard: "Fungible"
      }
    ],

    // SOL 转移记录
    nativeTransfers: [
      {
        fromUserAccount: "发送方钱包地址",
        toUserAccount: "接收方钱包地址",
        amount: 684444444  // Lamports
      }
    ],

    // 账户余额变动（核心字段）
    accountData: [
      {
        account: "交易发起人地址",
        nativeBalanceChange: -704079081,  // SOL 净变动（负数=支出，正数=收入）
        tokenBalanceChanges: []
      },
      {
        account: "Token Account 地址",
        nativeBalanceChange: 2074080,
        tokenBalanceChanges: [
          {
            userAccount: "交易发起人地址",
            tokenAccount: "Token Account 地址",
            rawTokenAmount: {
              tokenAmount: "13451405645718",
              decimals: 6
            },
            mint: "代币 Mint 地址"
          }
        ]
      }
    ]
  }
]
```

### 2.2 买卖判断逻辑

```javascript
// 买入 (BUY)
// - feePayer 的 nativeBalanceChange 为负数（支出 SOL）
// - 代币余额变动为正数（获得 Token）

// 卖出 (SELL)
// - feePayer 的 nativeBalanceChange 为正数（收到 SOL）
// - 代币余额变动为负数（支出 Token）
```

### 2.3 WebSocket API

**接口**: `wss://atlas-mainnet.helius-rpc.com/?api-key={API_KEY}`

**订阅消息**:
```javascript
{
  jsonrpc: "2.0",
  id: 1,
  method: "transactionSubscribe",
  params: [
    {
      accountInclude: ["代币 Mint 地址"]
    },
    {
      commitment: "confirmed",
      encoding: "jsonParsed",
      transactionDetails: "full",
      showRewards: false,
      maxSupportedTransactionVersion: 0
    }
  ]
}
```

**接收消息**:
```javascript
{
  jsonrpc: "2.0",
  method: "transactionNotification",
  params: {
    subscription: 1,
    result: {
      // 与 Transaction API 相同的数据结构
      transaction: { ... },
      meta: { ... }
    }
  }
}
```

## 3. 数据处理流程

### 3.1 GMGN Holder 数据处理

```
GMGN API 响应
    ↓
index.jsx 拦截 (EXECUTE_HOOK_REFRESH)
    ↓
提取 items (json.data.list / json.data / json.list / json)
    ↓
Normalize (统一字段名)
    items = items.map(x => ({
      ...x,
      owner: x.owner || x.address || x.wallet_address
    }))
    ↓
HeliusIntegration.updateGmgnHolders(items)
    ↓
HeliusMonitor.updateHolderData(items)
    ↓
MetricsEngine.updateUsersInfo(items)
    ↓
存储到 userInfo
```

### 3.2 Helius Transaction 数据处理

```
Helius WebSocket 推送
    ↓
HeliusMonitor.handleTransaction(tx)
    ↓
解析交易数据
    - 判断买卖方向
    - 提取 SOL 金额
    - 提取 Token 金额
    ↓
MetricsEngine.processTransaction(tx)
    ↓
更新 traderStats
```

## 4. 数据字段对照表

### 4.1 地址字段

| API | 字段名 | 说明 |
|-----|--------|------|
| GMGN | `owner` | 用户钱包地址 |
| GMGN | `address` | 用户钱包地址（备用） |
| GMGN | `wallet_address` | 用户钱包地址（备用） |
| Helius | `feePayer` | 交易发起人地址 |
| Helius | `userAccount` | 用户钱包地址 |

### 4.2 持仓字段

| API | 字段名 | 说明 |
|-----|--------|------|
| GMGN | `ui_amount` | 持仓数量（浮点数） |
| GMGN | `amount` | 持仓数量（字符串，最小单位） |
| GMGN | `holding_share_pct` | 持仓占比 (%) |
| GMGN | `total_buy_u` | 总买入金额 (USD) |
| GMGN | `usd_value` | 当前价值 (USD) |

### 4.3 时间字段

| API | 字段名 | 说明 |
|-----|--------|------|
| GMGN | `created_at` | 创建时间戳 |
| GMGN | `timestamp` | 时间戳 |
| Helius | `timestamp` | 交易时间戳 |
| Helius | `slot` | 区块高度 |

## 5. 注意事项

### 5.1 字段名不一致

GMGN API 可能返回不同的字段名，需要在 normalize 中统一：
- 地址: `owner` / `address` / `wallet_address`
- 持仓: `ui_amount` / `uiAmount` / `amount_cur`
- 价值: `usd_value` / `value` / `amount_usd`

### 5.2 数据类型转换

- 金额字段可能是字符串或数字，需要统一转换为数字
- 时间戳统一为秒级（不是毫秒）

### 5.3 数据来源标识

每个用户信息都有 `data_source` 字段，标识数据来源：
- "GMGN Holder API" - 来自 GMGN holder 接口
- "GMGN Trade API" - 来自 GMGN trade 接口
- "Helius WebSocket" - 来自 Helius 实时推送

### 5.4 资金来源处理

`native_transfer` 对象可能不存在，需要安全访问：
```javascript
const funding_account = (x.native_transfer && x.native_transfer.from_address) || x.funder || '';
```
