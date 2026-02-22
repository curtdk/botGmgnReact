# 庄家判定逻辑说明 (BOSS_LOGIC)

本文档详细说明 GMGN 扩展程序中“庄家智能筛选”功能的判定逻辑、评分规则以及数据字段来源。

## 1. 核心逻辑概述

系统通过分析 Token Holder 列表数据（以及交易历史），对每个用户进行多维度评分。
*   **评分 (Score)**：每个规则对应一定的权重分，满足条件即加分。
*   **判定 (Status)**：如果启用了某项规则，且用户满足该规则，则自动标记为“庄家”。
*   **手动优先**：用户手动标记的状态（庄/散）优先级高于自动判定。

## 2. 数据字段映射

由于 API 返回字段可能变化，系统进行了标准化映射，以供 SidePanel 显示和逻辑计算。

| 标准字段 (Internal) | 来源字段 (API JSON) | 说明 |
| :--- | :--- | :--- |
| `owner` / `address` | `address` | 钱包地址 |
| `total_buy_u` | `history_bought_cost` | 历史累计买入金额 (USD) |
| `netflow_amount` | `netflow_usd` | 净流量金额 (USD) |
| `holding_share_pct` | `amount_percentage` | 持仓占比 (如 1 表示 100% 或 1%) |
| `ui_amount` | `amount_cur` | 当前持仓数量 (Token) |
| `sol_balance` | `native_balance` | SOL 余额 (API 返回 lamports，系统除以 1e9) |
| `funding_account` | `native_transfer.from_address` | 资金来源地址 (第一笔转入) |

## 3. 七大评分规则详解

### 1. 无资金来源 (No Source)
*   **逻辑**：检查用户的资金来源地址 (`funding_account`) 是否为空。
*   **含义**：通常意味着资金来自中心化交易所 (CEX) 提币、混币器或创世空投，难以追踪，具有隐匿性。
*   **配置**：`weight_no_source` (权重), `enable_no_source` (开关)。

### 2. 同源账户 (Same Source / 老鼠仓)
*   **逻辑**：统计所有 Holder 中，有多少个用户的 `funding_account` 是相同的。
*   **条件**：同源用户数量 >= `same_source_n` (默认 5)。
*   **含义**：大量账户由同一地址分发资金，极有可能是庄家控制的“老鼠仓”群组。
*   **配置**：`same_source_n` (阈值), `weight_same_source` (权重)。

### 3. 时间聚类 (Time Cluster)
*   **逻辑**：对所有 Holder 的创建时间 (`created_at`) 进行排序，检测是否存在短时间内的批量创建行为。
*   **条件**：在 `time_cluster_j` 秒内，创建了 > `time_cluster_n` 个账户。
*   **含义**：脚本批量生成的账户，用于分仓或刷量。
*   **配置**：`time_cluster_j` (窗口秒数), `time_cluster_n` (数量), `weight_time_cluster` (权重)。

### 4. Gas 费用异常 (High Gas)
*   **逻辑**：检查用户交易记录中的 `max_gas_fee`。
*   **条件**：单笔交易 Gas 费 > `rule_gas.threshold` (如 0.01 SOL)。
*   **含义**：为了抢跑 (Snipe) 或确保交易成功，使用了极高的优先费，通常是专业脚本或狙击手。
*   **配置**：`threshold` (阈值), `weight` (权重)。

### 5. 金额相似群组 (Amount Similarity)
*   **逻辑**：统计所有 Holder 的总买入金额 (`total_buy_u`)，将金额相近的用户归为一组。
*   **条件**：在 `range` (如 ±100 USD) 范围内的用户数量 >= `count`。
*   **含义**：脚本批量买入，金额通常固定或在小范围内波动。
*   **配置**：`range` (范围), `count` (数量), `weight` (权重)。

### 6. 大额持仓 (Large Holding)
*   **逻辑**：筛选持仓量大且排名靠前的用户。
*   **条件**：(排名在前 `top_pct` %) `AND/OR` (持仓价值 > `min_usd`)。
*   **含义**：传统的“大户”或“鲸鱼”。
*   **配置**：`top_pct` (前百分比), `min_usd` (最小金额), `logic` (且/或), `weight` (权重)。

### 7. SOL 余额关联 (SOL Balance Similarity)
*   **逻辑**：统计所有 Holder 的 SOL 余额 (`sol_balance`)。
*   **条件**：在 `range` (如 ±0.1 SOL) 范围内的用户数量 >= `count`。
*   **含义**：批量分发资金后，剩余的 SOL 余额往往非常接近。
*   **配置**：`range` (范围), `count` (数量), `weight` (权重)。

## 4. 总结
系统通过上述规则计算每个用户的总得分 (`score`) 和得分原因 (`score_reasons`)。
*   SidePanel 列表会显示 `Score` 列。
*   点击用户详情，可查看具体的得分原因 (如 `同源(12)`, `HighGas(0.05)`).
*   若启用了对应规则，用户会被自动标记为 `庄家` (Status: Boss)。
