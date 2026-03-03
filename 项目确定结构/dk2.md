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


processNewGmgnTrades
引擎注入：调用 metricsEngine.processTransaction。这是“计算大脑”，它会根据这笔交易更新该地址的 SOL 消耗、代币余量、并判断其是否为“庄家”。

HOOK_HOLDERS_EVENT

/www/wwwroot/gmgn-extension-react/src/content/HeliusIntegration.js
/www/wwwroot/gmgn-extension-react/src/content/index.jsx
HOOK_FETCH_XHR_EVENT 
上面两个文件 都监听  HOOK_FETCH_XHR_EVENT  是不是 重复了。 这个监听 我记得 主要是 记录 url  方便  ,后面 开启 定时刷新 获取 gmgn trade  holds 数据用的。 



/www/wwwroot/gmgn-extension-react/src/content/HeliusIntegration.js
HOOK_SIGNATURES_EVENT  这个看到 监听 了 但是没有看到 谁发送

 
HOOK_HOLDERS_EVENT  被收到 触发 updateHolderData ，我看到 HOOK_HOLDERS_EVENT  只有在 EXECUTE_HOOK_REFRESH 得到时候 被发送 。EXECUTE_TRADES_REFRESH 的时候 并没有 触发 ，另外 lastTradesUrlRef  EXECUTE_TRADES_REFRESH 这名字很容易判断 就是处理 /token_trades 信息的 。可是 lastGmgnUrlRef  

另外 EXECUTE_HOOK_REFRESH   /token_holders 把  EXECUTE_TRADES_REFRESH  就是处理 /token_trades 的信息   可是 EXECUTE_HOOK_REFRESH  lastGmgnUrlRef  是处理 /token_holders 信息的 名称 不对称不好辨认 ，都根据  /token_holders  改一下 名字 ，统一 好区分。
/www/wwwroot/gmgn-extension-react/src/content/index.jsx 


EXECUTE_HOLDERS_REFRESH
EXECUTE_TRADES_REFRESH





