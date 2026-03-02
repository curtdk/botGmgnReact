IndexedDB:signatures  transactions 表（Helius 解析的 tx，fetchParsedTxs 自动缓存）

SignatureManager 内存（sig 元数据）
MetricsEngine traderStats（计算结果）
recentTrades 数组（实时交易显示）

WS：hasData=false → 立刻去 Helius RPC 拉完整 tx → 用 helius 格式处理
GMGN：hasData=true（trade 对象即数据） → 直接用 gmgn 格式处理，不拉 RPC


四大参数计算：1. helius sig  排序， 2， 有hasData=false  就停止，计算之前的，补全后继续计算

但 4 大参数的过滤比 recentTrades 多一层。源码 getMetrics() 第 326-330 行：
Object.entries(this.traderStats).forEach(([address, stats]) => {
  // 第一层：score 过滤（recentTrades 没有这层！）
  if (this.filteredUsers.size > 0 && !this.filteredUsers.has(address)) return;
  // 第二层：庄家过滤
  if (this.whaleAddresses.has(address)) return;

  当前只有这一个条件：
finalScore >= statusThreshold（默认 50）→ 加入 whaleAddresses


  两条数据在 traderStats 汇合

traderStats[address] = {
  // ← 来自 processTransaction（交易历史）
  totalBuySol, totalSellSol,
  currentRound, completedRounds,
  netSolSpent, netTokenReceived,

  // ← 来自 updateUserInfo（Holder 快照）
  funding_account,
  ui_amount,
  total_buy_u,
  sol_balance,
  native_transfer,
  holding_share_pct,
  ...
}
