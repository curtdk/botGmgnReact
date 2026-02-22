# GMGN API 数据结构说明 (完整版)

本文档基于 `dataweb/token_holders.json` 和 `dataweb/token_trades.json` 的实际返回结构，对**所有字段**进行详细中文注释说明。

## 1. 持仓者列表 (Token Holders)
**文件**: `token_holders.json`
**字段映射**: `data.list` (数组中的单个对象)

```json
{
  "address": "...",               // 钱包地址 (Owner Address)
  "account_address": "...",       // Token 账户地址 (ATA - Associated Token Account)
  "addr_type": 0,                 // 地址类型 (0: 普通钱包, 1: 开发者/创建者?, 2: 合约/LP池子?)
  
  "native_balance": "5931333516600", // SOL 余额 (单位: Lamports, 1 SOL = 1e9 Lamports)
  "balance": 1011819951.439,      // Token 余额 (浮点数, 已处理精度)
  "amount_cur": 1011819951.439,   // 当前持仓数量 (同 balance)
  "usd_value": 2372.26,           // 当前持仓总价值 (USD)
  
  "amount_percentage": 1.0239,    // 持仓占比 (单位: %, 1.0239 即 1.0239%)
  
  "accu_amount": 0,               // 累计买入数量 (可能用于计算成本)
  "accu_cost": 0,                 // 累计买入花费 (USD)
  "cost": 0,                      // 当前持仓的总成本 (USD)
  "cost_cur": 0,                  // 当前持仓成本 (USD, 通常同 cost)
  
  "sell_amount_cur": 0,           // 当前卖出数量 (Token)
  "sell_amount_percentage": 0,    // 卖出数量占比 (%)
  "sell_volume_cur": 0,           // 当前卖出交易额 (USD)
  
  "buy_volume_cur": 0,            // 当前买入交易额 (USD)
  "buy_amount_cur": 0,            // 当前买入数量 (Token)
  
  "netflow_usd": 0,               // 净流入资金 (USD) = 买入USD - 卖出USD
  "netflow_amount": 0,            // 净流入数量 (Token) = 买入量 - 卖出量
  
  "buy_tx_count_cur": 0,          // 当前买入交易次数
  "sell_tx_count_cur": 0,         // 当前卖出交易次数
  
  "current_buy_amount": 0,        // (同 buy_amount_cur)
  "current_sell_amount": 0,       // (同 sell_amount_cur)
  "current_transfer_in_amount": 0,// 当前转入数量 (非交易)
  "current_transfer_out_amount": 0,// 当前转出数量 (非交易)
  
  "history_bought_cost": 0,       // 历史总买入成本 (USD) -> **核心字段**：计算总投入
  "history_bought_fee": 0,        // 历史买入产生的手续费 (USD/SOL估值)
  "history_sold_income": 0,       // 历史总卖出收入 (USD) -> **核心字段**：计算总回笼
  "history_sold_fee": 0,          // 历史卖出产生的手续费
  
  "history_transfer_in_cost": 0,  // 历史转入成本估值 (USD)
  "history_transfer_out_income": 0,// 历史转出收入估值 (USD)
  "history_transfer_out_fee": 0,  // 历史转出费用
  
  "transfer_in_count": 0,         // 转入次数
  "transfer_out_count": 0,        // 转出次数
  
  "wallet_tag_v2": "TOP1",        // 钱包标签 (如 TOP1, TOP2, Smart, Whale)
  
  "profit": 0,                    // 总利润 (USD) = (当前价值 + 卖出收入) - (买入成本)
  "total_cost": 0,                // 总成本 (USD)
  "profit_change": null,          // 利润变化率 (可能是今日变化)
  
  "realized_profit": 0,           // 已实现利润 (USD) = 卖出收入 - 对应部分的成本
  "realized_pnl": null,           // 已实现盈亏率 (ROI)
  "unrealized_profit": 0,         // 未实现利润 (USD) = 当前价值 - 剩余持仓成本
  "unrealized_pnl": null,         // 未实现盈亏率 (ROI)
  
  "avg_cost": null,               // 平均买入成本 (USD/Token)
  "avg_sold": null,               // 平均卖出价格 (USD/Token)
  
  "transfer_in": false,           // 是否是通过转账进入的 (非买入)
  "is_new": false,                // 是否是新钱包
  "is_suspicious": false,         // 是否可疑
  "is_on_curve": false,           // 是否在 Bonding Curve 上 (Pump.fun 特有)
  
  "start_holding_at": 1768546266, // 开始持仓时间戳 (秒)
  "end_holding_at": null,         // 结束持仓时间戳 (如果清仓了)
  "last_block": 393829773,        // 最后更新区块高度
  "last_active_timestamp": 1768546266, // 最后活跃时间戳
  
  "native_transfer": {            // **核心字段**: 资金来源 (第一笔 SOL 转入)
      "name": "MAYHEM",           // 来源钱包名称 (如 CEX 名)
      "from_address": "Gyg...",   // 来源钱包地址
      "amount": "6000",           // 转入金额 (可能是 Lamports)
      "timestamp": 1762954490,    // 转入时间戳
      "tx_hash": "..."            // 交易哈希
  },
  
  "token_transfer": {             // 最近一次 Token 转账信息
      "name": null,               // 转账方名称
      "address": "",              // 相关地址
      "timestamp": 0,
      "tx_hash": "",
      "type": "transfer_in"       // 类型: transfer_in, transfer_out
  },
  "token_transfer_in": { ... },   // 最近一次转入详情 (结构同上)
  "token_transfer_out": { ... },  // 最近一次转出详情 (结构同上)
  
  "tags": [],                     // 用户标签数组
  "maker_token_tags": [           // 针对该 Token 的标签
      "top_holder",               // 前排持仓
      "sniper",                   // 狙击手 (开盘买入)
      "creator"                   // 创建者
  ],
  
  "name": "MAYHEM Vault",         // 钱包名称/备注
  "avatar": "http://...",         // 头像 URL
  "twitter_username": null,       // Twitter 用户名
  "twitter_name": null,           // Twitter 昵称
  "created_at": 1762911952        // 钱包创建时间 (第一笔交易时间)
}
```

## 2. 交易记录 (Token Trades)
**文件**: `token_trades.json`
**字段映射**: `data.history` (数组中的单个对象)

```json
{
  "maker": "45C...",              // 交易发起者 (钱包地址)
  "base_amount": "1587284.29",    // 基础资产交易数量 (即 Token 数量)
  "quote_amount": "0.0444",       // 报价资产交易数量 (即 SOL 数量)
  "amount_usd": "6.1289",         // 交易总价值 (USD) -> **核心字段**
  "price_usd": "0.00000386",      // Token 单价 (USD)
  
  "timestamp": 1767849010,        // 交易时间戳 (秒)
  "event": "buy",                 // 交易事件类型 ("buy" 买入, "sell" 卖出)
  "tx_hash": "3Sv...",            // 链上交易哈希 (Transaction Hash)
  "id": "Mzky...",                // 系统内部唯一 ID (Base64编码)
  "is_open_or_close": 1,          // 仓位状态标识 (1: 开仓/活跃?)
  "token_address": "GnV...",      // 交易的 Token 合约地址
  
  "maker_tags": [],               // 发起者全局标签
  "maker_token_tags": [           // 发起者针对该 Token 的标签
      "creator",                  // 创建者
      "top_holder"                // 前排持仓
  ],
  "maker_event_tags": [],         // 事件标签 (如 "snipe")
  
  "quote_address": "So111...",    // 报价资产合约地址 (通常是 WSOL)
  "quote_symbol": "",             // 报价资产符号 (如 SOL)
  
  "total_trade": 1,               // 该用户在该 Token 上的总交易次数
  "balance": "1587284.29",        // 交易完成后的 Token 余额 (快照)
  
  "history_bought_amount": "...", // 历史累计买入 Token 数量 (快照)
  "history_sold_income": "0",     // 历史累计卖出获得的 USD (快照)
  "history_sold_amount": "0",     // 历史累计卖出 Token 数量 (快照)
  
  "realized_profit": "0",         // 已实现利润 (USD) (快照)
  "unrealized_profit": "0",       // 未实现利润 (USD) (快照)
  
  "maker_name": "",               // 发起者名称
  "maker_twitter_username": "",   // Twitter 用户名
  "maker_twitter_name": "",       // Twitter 昵称
  "maker_avatar": "",             // 头像 URL
  "maker_ens": "",                // ENS 域名
  
  "priority_fee": "0.000029",     // 优先费 (Priority Fee, SOL) -> **核心字段**: 用于检测 High Gas
  "tip_fee": "0.000114",          // 贿赂小费 (Jito Tip, SOL)
  
  "gas_usd": "",                  // Gas 费 (USD估值, 可能为空)
  "gas_native": "",               // Gas 费 (SOL, 可能为空)
  "dex_usd": "",                  // 平台/DEX 费用 (USD)
  "dex_native": ""                // 平台/DEX 费用 (SOL)
}
```


GMGN 数据映射：
maker → 交易者地址
event → "buy" 或 "sell"
quote_amount → SOL 数量
base_amount → Token 数量