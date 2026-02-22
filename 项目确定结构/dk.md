1.数据获取 正常


SignatureManager 的状态管理
每个 sig 有两个关键状态：

状态	含义
hasData: true	有完整交易数据（来自 GMGN trade 数据）
hasData: false	只有 sig，没有详细数据（来自 WebSocket 或初始获取）
isProcessed: true	已经计算过，不再重复处理
启用 Helius API 后的完整流程

HeliusMonitor.start()
  1. 连接 WebSocket（实时收集新 sig，hasData=false）
  2. fetchInitialSignatures()（获取链上历史 sig，hasData=false）
  3. waitForGmgnData()（等待 GMGN_TRADES_LOADED 事件）
       ↑ 由 EXECUTE_TRADES_REFRESH 分页完成后触发
       ↑ 此时 GMGN trade 数据已通过 processFetchedTrades 写入
       ↑ 这些 sig 的 hasData=true（有完整数据，不需要 API）
  4. fetchMissingTransactions()
       → getMissingSignatures()  找出所有 hasData=false 的 sig
       → 先查本地缓存
       → 剩余的批量调用 Helius API（每批 100 个）
       → 获取到数据后 markHasData(sig, tx)
去重保证
addSignature(sig, source, gmgnData) 内部逻辑：

sig 已存在 → 只更新来源，不重复添加
sig 已存在但 hasData=false，现在有 GMGN 数据 → 更新为 hasData=true（不再需要 API 获取）
sig 不存在 → 新建记录
所以三个数据源（GMGN Holder、GMGN Trade、Helius WebSocket）的 sig 会自动合并去重，Helius API 只补充那些 GMGN 数据里没有的 sig 的详细信息。



数据结构差异与处理
GMGN trade 数据格式：


{ event: 'buy'|'sell', quote_amount: 1.5, base_amount: 100000, maker: '地址', tx_hash: '...' }
Helius API 数据格式：


{ transaction: { signatures: [...], message: { accountKeys: [...] } }, meta: { preBalances, postBalances, preTokenBalances, postTokenBalances } }

processTransaction(txWrapper)
  ├─ type === 'gmgn'   → processGmgnTransaction()
  │    解析 event/quote_amount/base_amount
  │    → solChange = -(quoteAmount)  [买入] 或 +(quoteAmount)  [卖出]
  │    → tokenChange = +(baseAmount) [买入] 或 -(baseAmount)   [卖出]
  │
  └─ type === 'helius' → processHeliusTransaction()
       解析 preBalances/postBalances/preTokenBalances/postTokenBalances
       → solChange = (postSol - preSol) / 1e9
       → tokenChange = postToken - preToken
两者最终都调用同一个方法：


updateTraderState(user, solChange, tokenChange, sig, timestamp, source)
  → 写入 traderStats[user].netSolSpent / netTokenReceived / totalBuySol / totalSellSol



  例子：用户 ABC1...XYZ 的两笔交易
第一笔：GMGN trade 数据（买入）
原始数据：


// SignatureManager 中存储
txData = {
  type: 'gmgn',
  data: {
    maker: 'ABC1...XYZ',
    event: 'buy',
    quote_amount: '1.5',    // 花了 1.5 SOL
    base_amount: '100000',  // 得到 100000 Token
    tx_hash: 'sig001...',
    timestamp: 1708435200
  }
}
处理过程：


processTransaction → processGmgnTransaction
  event = 'buy'
  solChange   = -1.5      (买入，SOL 减少)
  tokenChange = +100000   (买入，Token 增加)
  → updateTraderState('ABC1...XYZ', -1.5, +100000)
写入 traderStats：


traderStats['ABC1...XYZ'] = {
  netSolSpent:      1.5,    // 净成本 += 1.5
  totalBuySol:      1.5,    // 累计买入 += 1.5
  totalSellSol:     0,
  netTokenReceived: 100000  // 持仓 += 100000
}
第二笔：Helius API 数据（卖出一半）
原始数据：


txData = {
  type: 'helius',
  data: {
    transaction: {
      signatures: ['sig002...'],
      message: { accountKeys: [{ pubkey: 'ABC1...XYZ' }] }
    },
    meta: {
      preBalances:       [5_000_000_000],  // 5.0 SOL (lamports)
      postBalances:      [6_500_000_000],  // 6.5 SOL (lamports)
      preTokenBalances:  [{ owner: 'ABC1...XYZ', mint: 'MINT...', uiTokenAmount: { uiAmount: 100000 } }],
      postTokenBalances: [{ owner: 'ABC1...XYZ', mint: 'MINT...', uiTokenAmount: { uiAmount: 50000 } }]
    }
  }
}
处理过程：


processTransaction → processHeliusTransaction
  feePayer    = 'ABC1...XYZ'
  preSol      = 5_000_000_000 / 1e9 = 5.0 SOL
  postSol     = 6_500_000_000 / 1e9 = 6.5 SOL
  solChange   = 6.5 - 5.0 = +1.5    (卖出，SOL 增加)
  preToken    = 100000
  postToken   = 50000
  tokenChange = 50000 - 100000 = -50000  (卖出，Token 减少)
  → updateTraderState('ABC1...XYZ', +1.5, -50000)
写入 traderStats（累积）：


traderStats['ABC1...XYZ'] = {
  netSolSpent:      0.0,    // 1.5 - 1.5 = 0（已回本）
  totalBuySol:      1.5,    // 不变
  totalSellSol:     1.5,    // 累计卖出 += 1.5
  netTokenReceived: 50000   // 100000 - 50000 = 50000（还持有一半）
}
最终指标计算

netTokenReceived = 50000 >= 1  →  仍在持仓（活跃用户）

本轮下注  = netSolSpent = 0.0 SOL（已完全回本）
浮盈浮亏  = 50000 × currentPrice - 0.0
已落袋    = 不计算（还没退出）
两种格式的核心差异只在解析阶段：GMGN 直接给 event/quote_amount/base_amount，Helius 需要从余额差值计算。解析完成后都变成 solChange/tokenChange，后续计算完全一致。



例子：GMGN Holder 数据进入系统
原始数据（来自 GMGN API）

// EXECUTE_HOOK_REFRESH 获取到的 holder 数据
holder = {
  owner: 'ABC1...XYZ',
  ui_amount: 500000,          // 当前持仓 50万 Token
  holding_share_pct: 3.5,     // 持仓占比 3.5%
  total_buy_u: 2.0,           // 历史总买入 2 SOL
  native_transfer: {
    from_address: 'FUND...111',  // 资金来源地址
    block_timestamp: 1708435200
  }
}
步骤1：updateUsersInfo → 写入 userInfo + traderStats

// userInfo 写入
userInfo['ABC1...XYZ'] = {
  owner: 'ABC1...XYZ',
  data_source: 'GMGN Holder API',
  data_mode: 'holder_based',
  has_holder_snapshot: true,
  ui_amount: 500000,
  holding_share_pct: 3.5,
  total_buy_u: 2.0,
  funding_account: 'FUND...111',
  first_buy_time: 1708435200,
  ...holderData  // 其余字段原样保留
}

// traderStats 初始化（用 Holder 快照作为基准）
traderStats['ABC1...XYZ'] = {
  netTokenReceived: 500000,  // 直接用 ui_amount，不从 0 开始算
  totalBuySol: 2.0,          // 用 total_buy_u
  totalSellSol: 0,
  netSolSpent: 0
}
步骤2：ScoringEngine.calculateScores → 计算分数

// 评分规则检查（以 bossConfig 为准）
规则1: 无资金来源？  → funding_account = 'FUND...111'，有来源 → +0
规则4: 高持仓占比？  → 3.5% > 阈值？ → 假设是 → +10
规则6: 早期买入？    → first_buy_time 较早 → +10

// 结果
scoreMap['ABC1...XYZ'] = { score: 20, reasons: ['高持仓(+10)', '早期买入(+10)'] }
步骤3：分数写回 userInfo

userInfo['ABC1...XYZ'].score = 20
userInfo['ABC1...XYZ'].score_reasons = ['高持仓(+10)', '早期买入(+10)']
userInfo['ABC1...XYZ'].status = 'score >= statusThreshold(50)?' → 20 < 50 → '散户'
步骤4：filterUsersByScore → 过滤

// scoreThreshold 默认 100
score(20) < 100 → 通过过滤 → 加入 filteredUsers Set
最终发送给 UI 的数据

{
  owner: 'ABC1...XYZ',
  status: '散户',
  score: 20,
  score_reasons: ['高持仓(+10)', '早期买入(+10)'],
  ui_amount: 500000,
  holding_share_pct: 3.5,
  funding_account: 'FUND...111',
  data_source: 'GMGN Holder API',
  // traderStats 合并进来
  netTokenReceived: 500000,
  totalBuySol: 2.0,
  totalSellSol: 0,
  netSolSpent: 0
}
关键点：Holder 数据的特殊性
与 trade 数据不同，holder 数据不走 processTransaction，而是直接写入 userInfo 和 traderStats：

netTokenReceived 直接用 ui_amount（Holder 快照的准确值），不从交易累加
后续如果有新的 trade 进来，会在这个基准上增量更新（holder_based 模式）
如果之前已有 trade 数据（trade_calculated 模式），netTokenReceived 会被 Holder 快照覆盖为更准确的值

你说的对的部分：

先 GMGN 分页，再开 Helius API — 流程是：

fetchInitialSignatures() → Helius 链上获取全部 sig 列表
waitForGmgnData() → 等待 GMGN 分页数据（processFetchedTrades 把 GMGN trades 注入 SignatureManager，标记 hasData=true）
fetchMissingTransactions() → 只调用 API 获取 hasData=false 的 sig
减少 API 调用 — getMissingSignatures() 只返回没有数据的 sig，GMGN 已经提供数据的 sig 不会再调用 Helius API

sig 完整性 — Helius 自己从链上拉取完整 sig 列表，不依赖 GMGN 分页是否完整

需要纠正的一点：

"每次 Helius 实时指标的计算都是根据当前全部 trade 的 sig 数据重新计算"

这个说法只对首次计算成立：

首次计算（performInitialCalculation）：全量处理所有 getReadySignatures()，从旧到新逐笔计算
实时模式（进入 isInitialized=true 后）：是增量计算，每个新 sig 进来时单独调用 processTransaction，不重算历史
所以实时指标是在首次全量计算的基础上累加，而不是每次都重算全部。

整体流程确认：


GMGN 分页完成
    ↓
开启 Helius API
    ↓
fetchInitialSignatures (链上全量 sig)
    ↓
waitForGmgnData (GMGN 数据注入，hasData=true)
    ↓
fetchMissingTransactions (只 API 获取缺失的)
    ↓
performInitialCalculation (全量首次计算)
    ↓
实时模式 (增量计算新交易)
这个策略设计是合理的，GMGN 分页越完整，Helius API 调用越少。

你说的方向对，但有一个关键前提：sig 完整性重要，但顺序同样重要。

累加计算的前提：顺序正确

MetricsEngine 的计算是有状态的，比如：


用户 A：买入 100 → 卖出 50 → 买入 20
最终持仓 = 70
如果"卖出 50"这个 sig 晚到，被放在"买入 20"之后处理：


买入 100 → 买入 20 → 卖出 50
中间状态完全不同，PnL 计算会出错
系统现在的处理方式：

首次计算（performInitialCalculation）：getReadySignatures() 按 timestamp 升序排列，顺序是对的
实时模式：新 sig 来一个处理一个，顺序由 WebSocket 推送决定，通常是正确的（链上顺序）
定期校验（每 30 秒 verifySignatures）：补充漏掉的 sig，但补进来的 sig 是追加处理的，不会重排历史
所以你的策略是正确的：

先完成 GMGN 分页 → 再开 Helius API → 首次全量计算

这样能保证：

首次计算时 sig 尽量完整
按时间顺序处理，结果准确
潜在风险：如果有极少数历史 sig 在实时模式下才补进来（定期校验发现的），它们会被追加计算，可能轻微影响精度。但这种情况很少，且 GMGN 分页 + Helius 初始拉取基本能覆盖全部历史 sig。

结论：sig 完整性 + 处理顺序，两个都重要。你的策略（先分页再开 Helius）正好保证了这两点。

关键在于 updateTraderState 的计算模型：


// 买入
stats.netSolSpent += cost
stats.totalBuySol += cost
stats.netTokenReceived += tokenChange

// 卖出
stats.netSolSpent -= revenue
stats.totalSellSol += revenue
stats.netTokenReceived += tokenChange  // tokenChange 是负数
这是纯加减法累加，没有状态依赖。

举例验证：

用户 A：买 100 token → 卖 50 token → 买 20 token

不管哪个 sig 先处理，最终结果都是：


netTokenReceived = +100 - 50 + 20 = 70  ✓
totalBuySol = buy1 + buy2               ✓
totalSellSol = sell1                    ✓
加法交换律保证了顺序不影响最终结果。

结论：

只要 verifySignatures 把所有 sig 都补全了，最终计算结果一定是对的。

sig 完整性是唯一的关键，顺序不影响最终值（只影响 traderHistory 里的中间快照，但那只是日志，不参与最终计算）。

你的理解是正确的。