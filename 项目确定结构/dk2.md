python -m http.server 8899

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
本轮下注 / 本轮成本 / 已落袋 / 浮盈浮亏 计算链路：processTransaction    → updateTraderState(address, isBuy, solAmount, tokenAmount)   getMetrics
 

每次 getMetrics() 都是从 traderStats 实时聚合，无累积误差

processNewGmgnTrades 
sortedTrades.sort((a, b) => {
  const tDiff = (a.timestamp || 0) - (b.timestamp || 0);  // 时间戳升序（旧→新）


  updateTrades
  processNewGmgnTrades

  1.WS 与 EXECUTE_TRADES_REFRESH 的配合  中 首先ws 得到的是 sig  没有 具体tx 信息  同样  verifySignatures() 拉取最新 50/200/500 sigs ，  这里有没有去 使用 通过 gmgn trade 已经获取到的信息tx ，而不需要自己api 获取的环节  

  2.EXECUTE_HOLDERS_REFRESH — 每次都全量评分，可优化   优化很好 ，是否可以进一步 如果 有变化 ，是否是 只处理 有变化的用户的 评分。






  
  1.通过helius  API 获取 single， 一次获取 1000 条，然后呢第一次轮询。
  2. WS 接入从接入那个时刻开始获取 single，然后呢它也是一直在获取。
  上面这两个 single 呢都是没有具体的 tx 数据的，只是 single。 接下来呢，
  3. GMGN 直接抓取现有的 TX， 通过翻页，这个翻页呢，是先拿最新的，然后再一页一页的往后翻，翻到最旧的 也可能不到最旧的，有了这三条线以后呢，我要做一个拼接。
  
  一个标准信息数据 包含两部分 1. sig 2. tx  .
  1.helius api 获取 sig 也可以根据 sig 获取tx  ，一次可获取 1000 条， 第一次轮询翻页 查询全部的sig 
  2.ws 只能获取 sig  ,tx的补全 通过 helius api  和 gmgn hook 获取tx .  优先使用 gmgn hook 获取的tx  去补全 ws 的tx  ，缺少的用 helius api 获取tx 
  3. gmgn hook 获取 tx 
  首先是排序，每条线路都要有正常的一致的排序 配合最后的显示 最新的在最顶部输出，其中 helius API 的 single，它是一个非常的标准的一个排序 排名最高 可靠性最强，然后 WS 从它第一次获取拿到后再继续接收更新的。 GMGN hook TX 的获取呢，它最第一次的是通过翻页，翻页的话就是也是先拿最新的一页，再往后的获取呢，翻页过后是每一次读取当前第一页 没有有重复 就不在向一下页面继续获取, 并且操作以后通常数据也不是全部的，它有一些数据是它拿不到最前面的数据，所以会有遗漏，遗漏那部分呢，还是需要helius API 自己单独再获取一次 TX 。  这三组数据    helius API 是最慢最慢的，其次的是 WS， 最快的呢就是 GMGN hook 的 TX。 
  
  4.还有一个问题就是我计算数据的合计的时候比如4大参数，必须在全部填充的数据，而且排序准确的数据下面计算,只有这样的计算才准确才能够用。
  5.还有 由于很多sig  是同一秒 时间 所以 不建议 使用 建立 时间排序。 

  
6.为了完成上面目标我认为 我们要 1. 三组数据 排序都要正确。 2 .完成 tx 缺失 补全。3.形成一个 完整的 tx  并顺序准确。4，计算数据的时候需要计算到完全满足上面条件的数据，，没有完成就等到完成继续核算。
7.最终整合一组 完整的数据 进行 处理







  └─ SignatureManager.addSignature(tx_hash, 'plugin', trade)
    └─ SignatureManager.addSignatureBatch(rawSigs, 'initial')
      └─ SignatureManager.addSignature(sig, 'websocket')


  // ─────────────────────────────────────────────────────────
  // 首次计算
  // ─────────────────────────────────────────────────────────

  async performInitialCalculation() {

  /**
   * 处理新的 GMGN 交易（实时模式）
   */
  processNewGmgnTrades(trades) {


    ------------------评分

    我需要 在详细的知道系统中 账户评分 和使用 更新的流程体系。 我可以想到的。1. 所有的用户 都归集到了 traderStats   2. EXECUTE_HOLDERS_REFRESH  刷新 holder 获取到新据 就 自动触发 评分  根据 选项处理 自己可以处理的评分 比如无资金来源  然后立即更新 traderStats    用户的分数 。3. 当 EXECUTE_TRADES_REFRESH 刷新 trade  会 完善或建立 自己的 traderStats     并 进行评分 根据自己可以处理 的 并选中的 比如 无资金来源-隐藏中转   。 还是 另一种 体系。 实时交易列表刷新的时候 ，所有用户列表 traderStats   根据自己的信息  逐一 评分 ，没有检测完成的 就在 列表 标签字段 显示 待处理 解决了 马上更新。


        我需要 在详细的知道系统中 账户评分 和使用 更新的流程体系。 我可以想到的。1. 所有的用户 都归集到了 traderStats   EXECUTE_HOLDERS_REFRESH  EXECUTE_HOLDERS_REFRESH 跟新信息的时候 丰富 traderStats ， 实时交易列表刷新的时候 ，所有用户列表 traderStats   根据自己的信息  逐一 评分 ，没有检测完成的 就在 列表 标签字段 显示 待处理 解决了 马上更新。


_scheduleSlowScore() → 3s 后异步执行 detectHiddenRelays → 检测完成后重新评分 → 再次更新
（评分未超阈值就是散户）

已有 hiddenRelayCheckedAt 字段的用户 → 直接跳过，恢复缓存结果，不再翻页


短地址：contentManager.shortAddressMap 仍在用，chrome.storage.gmgn_short_map 不属于用户状态，保持不变 ✓