# Helius API 数据结构说明

本文档记录了使用 Helius API 获取的交易（Transaction）和持有者（Holder）数据结构，并附带关键字段的中文注释，用于辅助开发指标计算功能。

## 1. 交易数据结构 (Transaction / Activity)

**接口**: `v0/addresses/{mint}/transactions`
**用途**: 获取代币的交易历史，用于分析买卖行为、计算盈亏等。

以下是单条交易记录的示例（已简化，保留关键字段）：

```json
{
  "description": "", // 交易描述（有时为空）
  "type": "SWAP", // 交易类型：SWAP (交换), TRANSFER (转账) 等
  "source": "PUMP_FUN", // 交易来源：PUMP_FUN, RAYDIUM, JUPITER 等
  "fee": 1005000, // 交易手续费 (Lamports)
  "feePayer": "HnnBghrfotzpjrtXxpbBHTEKdgjMZv8RGZL7wsYeRVB9", // **交易发起人**（通常是Trader）
  "signature": "cae8G9MyNhnwRAh3p5NKy4akGJeQc8hC4ayu46jFCzkuefQ7xYWEuE7ujiustHLeEkLkPSnTd3SMV1wKxZ3GAM5", // 交易签名 (Tx Hash)
  "slot": 396430764, // 区块高度
  "timestamp": 1769583235, // 交易时间戳 (秒)
  
  // 代币转移记录 (用于判断买入/卖出的代币数量)
  "tokenTransfers": [
    {
      "fromTokenAccount": "GzxYFTDg8VPGHmPNjvu6sAD98Sq51zyiWpHYu4jQwRnA",
      "toTokenAccount": "Exi7YiHzMN7LNX79JhxhDXH9iU3a1mmpsVYr5EkuXNMf",
      "fromUserAccount": "D2rU4Yi2wkityNsHsLKJUmzJmWbM1Fforu94gHcdVUD2",
      "toUserAccount": "HnnBghrfotzpjrtXxpbBHTEKdgjMZv8RGZL7wsYeRVB9", // 接收代币的用户
      "tokenAmount": 13451405.645718, // **代币变动数量**
      "mint": "9svdK1bjBBuk1tqmeqSHrVSaD6M5wqLEsvFmG9SFpump", // 代币 Mint 地址
      "tokenStandard": "Fungible"
    }
  ],

  // SOL 转移记录 (通常用于展示转账流向，但计算净投入建议使用 accountData)
  "nativeTransfers": [
    {
      "fromUserAccount": "HnnBghrfotzpjrtXxpbBHTEKdgjMZv8RGZL7wsYeRVB9", // 发送 SOL 的用户
      "toUserAccount": "D2rU4Yi2wkityNsHsLKJUmzJmWbM1Fforu94gHcdVUD2", // 接收 SOL 的用户 (例如 AMM 池)
      "amount": 684444444 // SOL 数量 (Lamports)
    }
    // ... 可能包含多条转账（含手续费、小费等）
  ],

  // 账户余额变动数据 (**核心字段：用于计算 SOL 净买入/卖出额**)
  "accountData": [
    {
      // 交易发起人 (Trader) 的 SOL 余额变动
      "account": "HnnBghrfotzpjrtXxpbBHTEKdgjMZv8RGZL7wsYeRVB9",
      "nativeBalanceChange": -704079081, // **SOL 净变动 (Lamports)**。负数表示支出 (买入)，正数表示收入 (卖出)。
      "tokenBalanceChanges": [] // 此处通常为空，因为代币在 Token Account 中
    },
    {
      // 交易发起人的 Token Account 变动
      "account": "Exi7YiHzMN7LNX79JhxhDXH9iU3a1mmpsVYr5EkuXNMf",
      "nativeBalanceChange": 2074080, // Token Account 的 SOL 租金变动 (如果有)
      "tokenBalanceChanges": [
        {
          "userAccount": "HnnBghrfotzpjrtXxpbBHTEKdgjMZv8RGZL7wsYeRVB9", // 关联的 User
          "tokenAccount": "Exi7YiHzMN7LNX79JhxhDXH9iU3a1mmpsVYr5EkuXNMf",
          "rawTokenAmount": {
            "tokenAmount": "13451405645718", // **代币余额变动** (最小单位)
            "decimals": 6
          },
          "mint": "9svdK1bjBBuk1tqmeqSHrVSaD6M5wqLEsvFmG9SFpump"
        }
      ]
    }
  ]
}
```

### 字段解析与计算逻辑

1.  **判断买卖方向 (Action)**:
    *   **买入 (BUY)**: `feePayer` 的 `nativeBalanceChange` 为**负数** (支出 SOL)，且代币余额变动为**正数** (获得 Token)。
    *   **卖出 (SELL)**: `feePayer` 的 `nativeBalanceChange` 为**正数** (收到 SOL)，且代币余额变动为**负数** (支出 Token)。

2.  **获取 SOL 金额**:
    *   直接使用 `accountData` 中 `feePayer` 对应的 `nativeBalanceChange` 的绝对值。
    *   单位转换: `SOL = nativeBalanceChange / 10^9`。

3.  **获取 Token 金额**:
    *   遍历 `accountData`，查找 `tokenBalanceChanges` 中 `userAccount` 为 `feePayer` 且 `mint` 为目标代币的记录。
    *   单位转换: `Token = rawTokenAmount.tokenAmount / 10^decimals`。

---

## 2. 持有者数据结构 (Holders)

**接口**: `getTokenLargestAccounts` (RPC) 或其他资产接口
**用途**: 获取当前代币持有者列表，用于计算"本轮下注"（当前持有者的投入）。

示例数据：

```json
{
  "address": "GzxYFTDg8VPGHmPNjvu6sAD98Sq51zyiWpHYu4jQwRnA", // Token Account 地址 (注意：这不是 User Wallet 地址，是 ATA)
  "amount": "704339037781629", // 持仓数量 (最小单位字符串)
  "decimals": 6, // 精度
  "uiAmount": 704339037.781629, // **持仓数量 (浮点数)**
  "uiAmountString": "704339037.781629" // 持仓数量 (格式化字符串)
}
```

### 注意事项
*   `address` 字段返回的是 **Token Account (ATA)** 地址，而不是用户的 **Wallet Address**。
*   要获取对应的 Wallet Address，通常需要解析该 Token Account 的信息 (通过 `getAccountInfo` 解析 Owner)，或者使用支持返回 Owner 的接口 (如 `getProgramAccounts` 或 Helius DAS API)。
*   在计算指标时，如果需要将持有者与其交易历史关联，必须通过 Owner (Wallet Address) 进行匹配。

## 3. 指标计算实现 (基于 SOL)

脚本 `scripts/test_helius_data.js` 已实现了基于上述逻辑的简单计算：

*   **已落袋 (Realized PnL)**: 筛选出余额极低（已清仓）的用户，计算其 `(卖出 SOL 总额 - 买入 SOL 总额)`。
*   **本轮下注 (Current Bet)**: 筛选出当前仍持有代币的用户，计算其 `买入 SOL 总额`。
*   **本轮成本 (Current Cost)**: `本轮下注 - 已落袋` (根据需求文档公式)。
*   **浮盈浮亏 (Floating PnL)**: `当前持有者净投入` (`买入 SOL - 卖出 SOL`) 的相反数（即当前价值 - 成本，若简化为净流出则为负数）。

**备注**: 由于测试仅使用了 10 条交易数据，计算结果仅供逻辑验证，真实数据需拉取更长的交易历史。
