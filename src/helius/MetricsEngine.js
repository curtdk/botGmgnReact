/**
 * MetricsEngine v2 - 指标计算引擎
 *
 * 核心变化（v2）：
 *  引入"持仓轮次"概念，精确区分历史持仓和当前持仓：
 *    - 历史持仓（completedRounds）：已清仓过的买卖周期
 *    - 当前持仓（currentRound）：最近一轮未清仓的买卖交易
 *
 *  四大指标新定义：
 *    本轮下注  = Σ(currentRound.buySOL - currentRound.sellSOL) for 当前持仓用户
 *    已落袋    = Σ(completedRound.sellSOL - completedRound.buySOL) for 所有历史持仓round
 *    浮盈浮亏  = 已落袋 + Σ(currentRound.sellSOL - currentRound.buySOL) for 当前持仓用户
 *             = 已落袋 - 本轮下注
 *    本轮成本  = 本轮下注 - 已落袋
 */

import dataFlowLogger from '../utils/Logger.js';

export default class MetricsEngine {
  constructor() {
    this.reset();
  }

  reset() {
    // 交易员完整档案（含轮次追踪）
    this.traderStats = {};
    // 每个用户的完整交易历史（全部笔记录）
    this.traderHistory = {};

    this.currentPrice = 0;
    this.lastProcessedSig = null;
    this.processedCount = 0;
    this.totalTransactions = 0;
    this.currentTransactionIndex = 0;

    // 庄家检测
    this.whaleAddresses = new Set();
    this.skippedWhaleCount = 0;

    // 过滤用户列表（score < threshold）
    this.filteredUsers = new Set();

    // 实时交易列表（最新在前，最多300条）
    this.recentTrades = [];

    // 防重复日志
    this.lastMetricsLog = null;
    this.lastMetricsLogTime = 0;

    // 庄家检测配置
    this.bossConfig = {
      enable_no_source: true,
      enable_same_source: false,
      enable_time_cluster: false,
      same_source_n: 5,
      same_source_exclude: '',
      time_cluster_n: 5,
      time_cluster_j: 1
    };
  }

  // ─────────────────────────────────────────────────────────
  // 初始化用户轮次结构
  // ─────────────────────────────────────────────────────────

  _initTrader(address) {
    this.traderStats[address] = {
      // 默认状态：评分系统后续确认为"散户"/"庄家"
      status: '普通',
      // 初始分数 -1 表示"未评分"（0 是真实评分结果，-1 是哨兵值）
      score: -1,
      // holder 快照状态：false = 尚未加载 GMGN holder 数据，true = 已加载
      // funding_account 只有在 has_holder_snapshot=true 后才可信
      has_holder_snapshot: false,
      // 全周期累计（用于参考/兼容旧逻辑）
      netSolSpent: 0,
      netTokenReceived: 0,
      totalBuySol: 0,
      totalSellSol: 0,

      // ── v2 轮次追踪 ──
      // 历史已完结轮次列表
      completedRounds: [],
      // 各历史轮次净流水之和 = Σ(sellSOL - buySOL) for 所有 completedRounds
      totalHistoricalNetFlow: 0,
      // 当前未完结轮次
      currentRound: {
        buySOL: 0,
        sellSOL: 0,
        txCount: 0,
        openTime: null
      }
    };
    this.traderHistory[address] = [];
  }

  // ─────────────────────────────────────────────────────────
  // 交易处理入口
  // ─────────────────────────────────────────────────────────

  /**
   * 统一交易处理入口：根据 txWrapper.type 路由到对应处理函数
   *
   * 数据来源有三种格式：
   *   · type='gmgn'   → GMGN API 返回的分页交易数据（含 maker/event/quote_amount/base_amount）
   *   · type='helius' → Helius RPC parsedTransaction 格式（含 meta.preBalances 等）
   *   · 无 type 字段  → 旧版兼容，直接按 Helius 格式处理
   *
   * @param {Object} txWrapper  - { type, data } 或直接传入 Helius tx 对象
   * @param {string} mintAddress - 当前监控的代币 mint 地址
   */
  processTransaction(txWrapper, mintAddress) {
    if (!txWrapper) return;

    if (txWrapper.type === 'gmgn') {
      this.processGmgnTransaction(txWrapper.data, mintAddress);
    } else if (txWrapper.type === 'helius') {
      this.processHeliusTransaction(txWrapper.data, mintAddress);
    } else {
      // 兼容旧格式（直接传入 Helius 数据）
      this.processHeliusTransaction(txWrapper, mintAddress);
    }
  }

  processTransactions(transactions, mintAddress) {
    transactions.forEach(tx => this.processTransaction(tx, mintAddress));
  }

  setTotalTransactions(total) {
    this.totalTransactions = total;
    this.currentTransactionIndex = 0;
  }

  // ─────────────────────────────────────────────────────────
  // Helius 格式交易处理
  // ─────────────────────────────────────────────────────────

  /**
   * 处理 Helius RPC 返回的 parsedTransaction 格式
   *
   * 解析步骤：
   *   1. 读取 meta.err → 链上失败交易直接跳过
   *   2. accountKeys[0].pubkey → feePayer（付款人/交易发起方）
   *   3. SOL 变化 = (postBalance - preBalance) / 1e9 + fee
   *      · 负值 = 买入（花费 SOL）
   *      · 正值 = 卖出（收到 SOL）
   *   4. Token 变化 = postTokenBalance - preTokenBalance
   *      · 正值 = 买入（收到 Token）
   *      · 负值 = 卖出（付出 Token）
   *   5. 调用 updateTraderState 更新用户轮次和4大参数
   */
  processHeliusTransaction(tx, mintAddress) {
    if (!tx || !tx.transaction) return;

    const meta = tx.meta;
    if (!meta) return;

    const signature = tx.transaction.signatures[0];

    if (meta.err) {
      return;
    }

    const feePayer = tx.transaction.message.accountKeys[0].pubkey;

    if (this.isWhaleAddress(feePayer)) {
      this.skippedWhaleCount++;
      return;
    }

    // 解析 SOL 变化（去掉手续费得到实际 swap 金额）
    const preSol = meta.preBalances[0];
    const postSol = meta.postBalances[0];
    const txFee = (meta.fee || 0) / 1e9;
    const solChange = (postSol - preSol) / 1e9 + txFee;

    // 解析代币变化
    const findBal = (balances) => {
      const b = (balances || []).find(b => b.owner === feePayer && b.mint === mintAddress);
      return b ? (b.uiTokenAmount.uiAmount || 0) : 0;
    };
    const preToken = findBal(meta.preTokenBalances);
    const postToken = findBal(meta.postTokenBalances);
    const tokenChange = postToken - preToken;

    const rawTimestamp = tx.timestamp ? tx.timestamp * 1000 : Date.now();
    const timestamp = tx.timestamp ? new Date(rawTimestamp).toLocaleString('zh-CN') : '未知';

    this.currentTransactionIndex++;
    if (this.totalTransactions > 0) {
    }

    this.updateTraderState(feePayer, solChange, tokenChange, signature, timestamp, 'Helius API', rawTimestamp);

    if (tokenChange !== 0 && Math.abs(solChange) > 0.000001) {
      this.currentPrice = Math.abs(solChange) / Math.abs(tokenChange);
    }

    this.lastProcessedSig = signature;
    this.processedCount++;
  }

  // ─────────────────────────────────────────────────────────
  // GMGN 格式交易处理
  // ─────────────────────────────────────────────────────────

  /**
   * 处理 GMGN API 分页接口返回的交易数据（token_trades 格式）
   *
   * 字段映射：
   *   · maker        → 用户钱包地址（feePayer）
   *   · event        → 'buy' | 'sell'
   *   · quote_amount → SOL 数量（字符串，需 parseFloat）
   *   · base_amount  → Token 数量（字符串，需 parseFloat）
   *   · timestamp    → Unix 时间戳（秒）
   *
   * SOL/Token 符号约定（与 Helius 格式统一）：
   *   · 买入: solChange < 0（花出SOL）, tokenChange > 0（收到Token）
   *   · 卖出: solChange > 0（收到SOL）, tokenChange < 0（付出Token）
   */
  processGmgnTransaction(trade, _mintAddress) {
    if (!trade) return;

    const maker = trade.maker;

    if (this.isWhaleAddress(maker)) {
      this.skippedWhaleCount++;
      return;
    }

    const event = trade.event;
    const quoteAmount = parseFloat(trade.quote_amount);
    const baseAmount = parseFloat(trade.base_amount);
    const rawTimestamp = trade.timestamp ? trade.timestamp * 1000 : Date.now();
    const timestamp = trade.timestamp ? new Date(rawTimestamp).toLocaleString('zh-CN') : '未知';

    let solChange, tokenChange;
    if (event === 'buy') {
      solChange = -quoteAmount;
      tokenChange = baseAmount;
    } else if (event === 'sell') {
      solChange = quoteAmount;
      tokenChange = -baseAmount;
    } else {
      return;
    }

    this.updateTraderState(maker, solChange, tokenChange, trade.tx_hash, timestamp, 'GMGN API', rawTimestamp);

    if (tokenChange !== 0 && Math.abs(solChange) > 0.000001) {
      this.currentPrice = Math.abs(solChange) / Math.abs(tokenChange);
    }

    this.lastProcessedSig = trade.tx_hash;
    this.processedCount++;
  }

  // ─────────────────────────────────────────────────────────
  // 核心：更新用户状态 + 轮次追踪
  // ─────────────────────────────────────────────────────────

  /**
   * 核心方法：根据单笔交易的 SOL/Token 变化，更新用户的交易统计和持仓轮次。
   *
   * 轮次（Round）追踪规则：
   *   · 每次买入：累加 currentRound.buySOL、txCount；首次买入记录 openTime
   *   · 每次卖出：累加 currentRound.sellSOL、txCount
   *   · 清仓判断：卖出后 netTokenReceived < 1 → 视为清仓，关闭当前轮次：
   *       - 将 currentRound 压入 completedRounds[]
   *       - 本轮 net = sellSOL - buySOL（正=盈利，负=亏损）
   *       - 累加 totalHistoricalNetFlow
   *       - 重置 currentRound = {buySOL:0, sellSOL:0, txCount:0, openTime:null}
   *
   * 跳过条件（return 不处理）：
   *   · solChange 和 tokenChange 同号或接近 0：非标准 swap，跳过
   *   · 用户在 whaleAddresses 中：庄家地址，由上层调用方负责过滤
   *
   * @param {string} user         - 钱包地址
   * @param {number} solChange    - SOL 净变化（负=买入，正=卖出）
   * @param {number} tokenChange  - Token 净变化（正=买入，负=卖出）
   * @param {string} signature    - 交易签名
   * @param {string} timestamp    - 格式化时间字符串
   * @param {string} source       - 数据来源（'GMGN API' / 'Helius API' 等）
   * @param {number} rawTimestamp - Unix 毫秒时间戳
   */
  updateTraderState(user, solChange, tokenChange, signature, timestamp = '未知', source = '未知', rawTimestamp = Date.now()) {
    if (!this.traderStats[user]) {
      this._initTrader(user);
    }

    const stats = this.traderStats[user];
    const round = stats.currentRound;
    let action = '';

    // ── 买入：SOL减少，Token增加 ──
    if (solChange < -0.000001 && tokenChange > 0) {
      const cost = Math.abs(solChange);
      stats.totalBuySol += cost;
      stats.netTokenReceived += tokenChange;
      stats.netSolSpent += cost;

      // 轮次追踪
      round.buySOL += cost;
      round.txCount++;
      if (!round.openTime) round.openTime = rawTimestamp;

      action = '买入';

    // ── 卖出：SOL增加，Token减少 ──
    } else if (solChange > 0.000001 && tokenChange < 0) {
      const revenue = solChange;
      stats.totalSellSol += revenue;
      stats.netTokenReceived += tokenChange; // tokenChange 是负值
      stats.netSolSpent -= revenue;

      // 轮次追踪
      round.sellSOL += revenue;
      round.txCount++;

      action = '卖出';

    } else {
      return; // 既不买也不卖，跳过
    }

    // ── 记录交易历史 ──
    this.traderHistory[user].push({
      signature,
      timestamp,
      rawTimestamp,
      solChange,
      tokenChange,
      action,
      source,
      tokenBalanceAfter: stats.netTokenReceived,
      netCostAfter: stats.netSolSpent
    });

    // ── 判断轮次是否结束（token余额清零）──
    // 卖出后余额 < 1 视为清仓，关闭当前轮次
    if (action === '卖出' && stats.netTokenReceived < 1) {
      const closedRound = {
        buySOL: round.buySOL,
        sellSOL: round.sellSOL,
        netFlow: round.sellSOL - round.buySOL, // 正=盈利，负=亏损
        txCount: round.txCount,
        openTime: round.openTime,
        closeTime: rawTimestamp
      };
      stats.completedRounds.push(closedRound);
      stats.totalHistoricalNetFlow += closedRound.netFlow;

      // 重置当前轮次
      stats.currentRound = { buySOL: 0, sellSOL: 0, txCount: 0, openTime: null };

    }

    // ── 添加到实时交易列表 ──
    this.recentTrades.unshift({
      signature,
      address: user,
      action,
      tokenAmount: Math.abs(tokenChange),
      solAmount: Math.abs(solChange),
      rawTimestamp,
      label: stats.status || null
    });
    if (this.recentTrades.length > 300) {
      this.recentTrades.length = 300;
    }

    // ════════════════════════════════════════════════════════════════
    // 【新交易入库日志】每笔交易处理完毕后输出：
    //   · 用户历史持仓轮次（completedRounds）
    //   · 用户当前持仓轮次（currentRound）
    //   · 全局 4大参数 实时快照 + 计算规则说明
    // ════════════════════════════════════════════════════════════════
    {
      const D = '─'.repeat(58);
      const addrShort = `${user.slice(0, 8)}...${user.slice(-6)}`;
      const solStr = Math.abs(solChange).toFixed(6);
      const tokenStr = Math.abs(tokenChange).toFixed(0);

      // 当前最新的 round（可能已被关闭并重置）
      const updatedRound = stats.currentRound;
      const hist = stats.completedRounds;

      // ── 历史持仓轮次明细 ──
      let histLines;
      if (hist.length === 0) {
        histLines = '    （首次参与，无历史清仓记录）';
      } else {
        histLines = hist.map((r, i) =>
          `    历史轮${i + 1}: ` +
          `买入=${r.buySOL.toFixed(6)} SOL  卖出=${r.sellSOL.toFixed(6)} SOL  ` +
          `净流水=${r.netFlow >= 0 ? '+' : ''}${r.netFlow.toFixed(6)} SOL  ` +
          `交易次数=${r.txCount}`
        ).join('\n');
        histLines += `\n    历史净流水合计: ${stats.totalHistoricalNetFlow >= 0 ? '+' : ''}${stats.totalHistoricalNetFlow.toFixed(6)} SOL`;
      }

      // ── 当前持仓轮次 ──
      let curLine;
      if (updatedRound.buySOL === 0 && updatedRound.txCount === 0) {
        curLine = '    （已清仓，当前无持仓轮次）';
      } else {
        const netCost = updatedRound.buySOL - updatedRound.sellSOL;
        curLine =
          `    买入=${updatedRound.buySOL.toFixed(6)} SOL  ` +
          `卖出=${updatedRound.sellSOL.toFixed(6)} SOL  ` +
          `净成本=${netCost.toFixed(6)} SOL  ` +
          `交易次数=${updatedRound.txCount}`;
      }

      // ── 全局 4大参数 快照（遍历所有已知用户，忽略庄家地址）──
      let snapYiLuDai = 0;    // 已落袋
      let snapXiazhu = 0;     // 本轮下注
      let snapNetFlow = 0;    // 持仓用户当前净流水（负值）
      let snapActiveCount = 0;
      let snapExitedCount = 0;
      for (const [addr, s] of Object.entries(this.traderStats)) {
        if (this.whaleAddresses.has(addr)) continue;
        // filteredUsers 非空时只统计在列表内的用户（评分后才过滤）
        if (this.filteredUsers.size > 0 && !this.filteredUsers.has(addr)) continue;
        if (s.totalHistoricalNetFlow !== 0) {
          snapYiLuDai += s.totalHistoricalNetFlow;
          snapExitedCount += s.completedRounds.length;
        }
        const r = s.currentRound;
        if (r.buySOL > 0 || r.txCount > 0) {
          snapXiazhu  += r.buySOL - r.sellSOL;
          snapNetFlow += r.sellSOL - r.buySOL;
          snapActiveCount++;
        }
      }
      const snapFuYing   = snapYiLuDai + snapNetFlow;
      const snapChengBen = snapXiazhu - snapYiLuDai;

      console.log(
        `\n╔${'═'.repeat(60)}╗\n` +
        `║ 【新交易入库】 ${addrShort}  ${action}  ${solStr} SOL / ${tokenStr} Token\n` +
        `╠${'═'.repeat(60)}╣\n` +
        `║ sig: ${(signature || '?').slice(0, 30)}...  来源: ${source}\n` +
        `║ 时间: ${timestamp}\n` +
        `╚${'═'.repeat(60)}╝\n` +
        `${D}\n` +
        `  ▶ 用户历史持仓（已完结轮次，共 ${hist.length} 轮）\n` +
        `${histLines}\n` +
        `${D}\n` +
        `  ▶ 用户当前持仓轮次\n` +
        `${curLine}\n` +
        `${D}\n` +
        `  ▶ 全局 4大参数 实时快照\n` +
        `    计算规则:\n` +
        `      本轮下注 = Σ( 当前轮买入 - 当前轮卖出 ) for 所有持仓用户（${snapActiveCount}人）\n` +
        `      已落袋   = Σ( 历史轮次净流水 ) for 所有历史清仓用户（${snapExitedCount}轮）\n` +
        `      浮盈浮亏 = 已落袋 + Σ( 当前轮卖出 - 当前轮买入 ) for 持仓用户\n` +
        `               = 已落袋 - 本轮下注（持仓用户净流出视角）\n` +
        `      本轮成本 = 本轮下注 - 已落袋\n` +
        `    ──────────────────────────────────────────\n` +
        `    本轮下注 = ${snapXiazhu.toFixed(6)} SOL\n` +
        `    已落袋   = ${snapYiLuDai >= 0 ? '+' : ''}${snapYiLuDai.toFixed(6)} SOL\n` +
        `    浮盈浮亏 = ${snapFuYing >= 0 ? '+' : ''}${snapFuYing.toFixed(6)} SOL\n` +
        `    本轮成本 = ${snapChengBen.toFixed(6)} SOL\n` +
        `${'═'.repeat(60)}`
      );
    }
    // ════════════════════════════════════════════════════════════════
  }

  // ─────────────────────────────────────────────────────────
  // 四大指标计算
  // ─────────────────────────────────────────────────────────

  /**
   * 实时计算四大指标并返回 metrics 对象。
   *
   * 计算逻辑（只统计 filteredUsers 且不在 whaleAddresses 中的用户）：
   *
   *   ① 已落袋 (yiLuDai):
   *      = Σ user.totalHistoricalNetFlow
   *      totalHistoricalNetFlow 在每次轮次关闭（清仓）时累加 (sellSOL - buySOL)
   *
   *   ② 本轮下注 (benLunXiaZhu):
   *      = Σ (currentRound.buySOL - currentRound.sellSOL)  for 持仓用户
   *      持仓用户 = currentRound.buySOL > 0 || currentRound.txCount > 0
   *
   *   ③ 浮盈浮亏 (fuYingFuKui):
   *      = yiLuDai + Σ(currentRound.sellSOL - currentRound.buySOL) for 持仓用户
   *      = yiLuDai - benLunXiaZhu （持仓用户净流出 = -本轮下注）
   *
   *   ④ 本轮成本 (benLunChengBen):
   *      = benLunXiaZhu - yiLuDai
   *
   * 过滤规则：
   *   · filteredUsers 非空时：只统计在 filteredUsers 中的地址（score < 阈值）
   *   · filteredUsers 为空时：统计全部用户（初始化完成前的过渡状态）
   *   · whaleAddresses 中的地址：始终排除
   *
   * @returns {Object} 含 yiLuDai / benLunXiaZhu / benLunChengBen / floatingPnL 等字段
   */
  getMetrics() {
    let yiLuDai = 0;        // 已落袋 = Σ历史轮次净流水
    let benLunXiaZhu = 0;   // 本轮下注 = Σ(当前轮次买入 - 当前轮次卖出) for 持仓用户
    let currentNetFlow = 0; // 当前持仓用户净流水之和 = Σ(sell - buy) for 持仓用户（负值）
    let activeCount = 0;
    let exitedRoundsCount = 0;
    const logXiaZhu = [];   // 本轮下注明细
    const logYiLuDai = [];  // 已落袋明细（含历史轮次）

    Object.entries(this.traderStats).forEach(([address, stats]) => {
      // 过滤：只计算 filteredUsers 中的用户（score < 阈值）
      if (this.filteredUsers.size > 0 && !this.filteredUsers.has(address)) return;
      // 跳过庄家
      if (this.whaleAddresses.has(address)) return;

      const s = address.slice(0, 6) + '..' + address.slice(-4);

      // ── 已落袋：所有历史轮次净流水之和 ──
      if (stats.totalHistoricalNetFlow !== 0) {
        yiLuDai += stats.totalHistoricalNetFlow;
        exitedRoundsCount += stats.completedRounds.length;
        // 每轮明细：buy - sell = net
        const roundLines = stats.completedRounds.map((r, i) =>
          `  轮${i + 1}: buy=${r.buySOL.toFixed(4)} - sell=${r.sellSOL.toFixed(4)} = ${r.netFlow >= 0 ? '+' : ''}${r.netFlow.toFixed(4)}`
        ).join('\n');
        logYiLuDai.push(`${s}: 历史${stats.completedRounds.length}轮\n${roundLines}\n  小计=${stats.totalHistoricalNetFlow >= 0 ? '+' : ''}${stats.totalHistoricalNetFlow.toFixed(4)} SOL`);
      }

      // ── 本轮下注：当前未完结轮次的净成本 ──
      const round = stats.currentRound;
      if (round.buySOL > 0 || round.txCount > 0) {
        const netCost = round.buySOL - round.sellSOL; // 正值 = 净投入
        benLunXiaZhu += netCost;
        currentNetFlow += round.sellSOL - round.buySOL; // 负值（当前用户净流出SOL）
        activeCount++;
        logXiaZhu.push(`${s}: buy=${round.buySOL.toFixed(4)} - sell=${round.sellSOL.toFixed(4)} = 净成本${netCost.toFixed(4)}`);
      }
    });

    // 浮盈浮亏 = 已落袋 + 当前持仓净流水
    //          = yiLuDai + currentNetFlow
    //          = yiLuDai - benLunXiaZhu（当 currentNetFlow = -benLunXiaZhu 时）
    const fuYingFuKui = yiLuDai + currentNetFlow;

    // 本轮成本 = 本轮下注 - 已落袋
    const benLunChengBen = benLunXiaZhu - yiLuDai;

    // ── 4大参数日志（值变化时写入 📋）──
    const metricsKey = `${yiLuDai.toFixed(4)}|${benLunXiaZhu.toFixed(4)}|${benLunChengBen.toFixed(4)}|${fuYingFuKui.toFixed(4)}`;
    const now = Date.now();
    if (this.lastMetricsLog !== metricsKey || now - this.lastMetricsLogTime > 5000) {
      this.lastMetricsLog = metricsKey;
      this.lastMetricsLogTime = now;
      // ── 汇总计算式：各用户数值拼成加法式 ──
      // logXiaZhu 每项格式: "addr: buy=X - sell=Y = 净成本Z"，提取净成本值
      const xiaZhuTerms = logXiaZhu.map(l => {
        const addr = l.split(':')[0].trim();
        const m = l.match(/净成本(-?[\d.]+)/);
        return m ? `${addr}(${parseFloat(m[1]) >= 0 ? '+' : ''}${parseFloat(m[1]).toFixed(4)})` : addr;
      });
      const xiaZhuFormula = xiaZhuTerms.length > 0
        ? xiaZhuTerms.join(' + ') + ` = ${benLunXiaZhu.toFixed(4)} SOL`
        : `(无持仓用户) = 0.0000 SOL`;

      // logYiLuDai 每项末行含 "小计=±X SOL"，提取小计值
      const yiLuDaiTerms = logYiLuDai.map(l => {
        const addr = l.split(':')[0].trim();
        const m = l.match(/小计=([+\-]?[\d.]+)/);
        return m ? `${addr}(${m[1]})` : addr;
      });
      const yiLuDaiFormula = yiLuDaiTerms.length > 0
        ? yiLuDaiTerms.join(' + ') + ` = ${yiLuDai >= 0 ? '+' : ''}${yiLuDai.toFixed(4)} SOL`
        : `(无历史清仓) = 0.0000 SOL`;

      const detail = [
        `【本轮下注】${benLunXiaZhu.toFixed(4)} SOL（${activeCount}人持仓）`,
        ...logXiaZhu.map(l => '  ' + l),
        `  ↳ 汇总式: ${xiaZhuFormula}`,
        `【已落袋】${yiLuDai.toFixed(4)} SOL（${exitedRoundsCount}轮历史）`,
        ...logYiLuDai,
        `  ↳ 汇总式: ${yiLuDaiFormula}`,
        `【浮盈浮亏】已落袋(${yiLuDai.toFixed(4)}) + 当前净流水(${currentNetFlow.toFixed(4)}) = ${fuYingFuKui.toFixed(4)} SOL`,
        `【本轮成本】本轮下注(${benLunXiaZhu.toFixed(4)}) - 已落袋(${yiLuDai.toFixed(4)}) = ${benLunChengBen.toFixed(4)} SOL`,
      ].join('\n');
      dataFlowLogger.log(
        '4大参数', '指标计算',
        `下注=${benLunXiaZhu.toFixed(4)} 落袋=${yiLuDai.toFixed(4)} 成本=${benLunChengBen.toFixed(4)} 浮盈亏=${fuYingFuKui.toFixed(4)}`,
        { detail }
      );
    }

    return {
      yiLuDai,
      benLunXiaZhu,
      benLunChengBen,
      floatingPnL: fuYingFuKui,
      currentPrice: this.currentPrice,
      activeCount,
      exitedCount: exitedRoundsCount,
      totalProcessed: this.processedCount,
      skippedWhaleCount: this.skippedWhaleCount,
      recentTrades: this.recentTrades.slice(0, 20000).map(t => ({
        ...t,
        score: this.traderStats[t.address]?.score,
        label: this.traderStats[t.address]?.status || null  // 实时刷新 label，反映最新评分结果
      }))
    };
  }

  printMetrics() {
    this.getMetrics();
  }

  /**
   * 增量日志：新交易处理后调用
   * 输出：新交易详情 + 该用户轮次状态 + 当前4大参数快照
   */
  printTradeUpdate(sig, user, action, solChange, tokenChange, source) {
    const stats = this.traderStats[user];
    if (!stats) return;

    const short = (a) => `${a.slice(0, 6)}..${a.slice(-4)}`;
    const solStr = solChange >= 0 ? `+${solChange.toFixed(4)}` : solChange.toFixed(4);
    const tokStr = tokenChange >= 0 ? `+${Math.abs(tokenChange).toFixed(0)}` : `-${Math.abs(tokenChange).toFixed(0)}`;

    // 用户轮次状态
    const cr = stats.currentRound;
    const hist = stats.completedRounds || [];
    const roundLines = hist.map((r, i) =>
      `    历史轮${i + 1}: buy=${r.buySOL.toFixed(4)} sell=${r.sellSOL.toFixed(4)} net=${r.netFlow >= 0 ? '+' : ''}${r.netFlow.toFixed(4)}`
    ).join('\n');
    const crLine = cr.buySOL > 0 || cr.txCount > 0
      ? `    当前轮次: buy=${cr.buySOL.toFixed(4)} sell=${cr.sellSOL.toFixed(4)} 净成本=${(cr.buySOL - cr.sellSOL).toFixed(4)} txCount=${cr.txCount}`
      : `    当前轮次: 无`;

    // 4大参数快照（不重复触发 dataFlowLogger）
    let yiLuDai = 0, benLunXiaZhu = 0, currentNetFlow = 0;
    Object.entries(this.traderStats).forEach(([addr, s]) => {
      if (this.filteredUsers.size > 0 && !this.filteredUsers.has(addr)) return;
      if (this.whaleAddresses.has(addr)) return;
      if (s.totalHistoricalNetFlow !== 0) yiLuDai += s.totalHistoricalNetFlow;
      const r = s.currentRound;
      if (r.buySOL > 0 || r.txCount > 0) {
        benLunXiaZhu += r.buySOL - r.sellSOL;
        currentNetFlow += r.sellSOL - r.buySOL;
      }
    });
    const fuYing = yiLuDai + currentNetFlow;
    const chengBen = benLunXiaZhu - yiLuDai;

    console.log(
      `[4大参数-追加] ── 新交易 ──\n` +
      `  sig=${sig?.slice(0, 12)}.. | addr=${short(user)} | ${action} | SOL=${solStr} | Token=${tokStr} | 来源=${source || '?'}\n` +
      `  用户状态(历史${hist.length}轮):\n` +
      (roundLines ? roundLines + '\n' : '') +
      crLine + '\n' +
      `  ── 当前4大参数快照 ──\n` +
      `  已落袋=${yiLuDai >= 0 ? '+' : ''}${yiLuDai.toFixed(4)}  本轮下注=${benLunXiaZhu.toFixed(4)}  本轮成本=${chengBen.toFixed(4)}  浮盈亏=${fuYing >= 0 ? '+' : ''}${fuYing.toFixed(4)}  SOL`
    );
  }

  printDetailedMetrics() {
    const traders = Object.entries(this.traderStats);
    if (traders.length === 0) return;

    let holdingCount = 0, historicalCount = 0;
    const userLines = [];

    traders.forEach(([address, stats]) => {
      const s = `${address.slice(0, 4)}..${address.slice(-4)}`;
      const cr  = stats.currentRound;
      const hist = stats.completedRounds || [];
      const isHolding = cr.buySOL > 0 || cr.txCount > 0;

      if (isHolding) holdingCount++;
      if (hist.length > 0) historicalCount++;

      // 只记录有实际交易记录的用户
      if (!isHolding && hist.length === 0) return;

      let line = `${s}`;

      // 历史持仓轮次
      if (hist.length > 0) {
        const histDetail = hist.map((r, i) =>
          `历史轮${i + 1}[buy=${r.buySOL.toFixed(4)} sell=${r.sellSOL.toFixed(4)} net=${r.netFlow.toFixed(4)}]`
        ).join(' ');
        line += ` | ${histDetail} 历史净流水=${stats.totalHistoricalNetFlow.toFixed(4)}SOL`;
      }

      // 当前持仓
      if (isHolding) {
        const net = cr.buySOL - cr.sellSOL;
        line += ` | 当前持仓: buy=${cr.buySOL.toFixed(4)} sell=${cr.sellSOL.toFixed(4)} net=${net.toFixed(4)}SOL txCount=${cr.txCount}`;
      } else {
        line += ` | 当前无持仓`;
      }

      userLines.push(line);
    });

  }

  // ─────────────────────────────────────────────────────────
  // 4大参数详细计算报告（console.log）
  // ─────────────────────────────────────────────────────────

  printCalculationReport() {
    // ════════════════════════════════════════════════════════════════════════
    // 【历史计算完整报告】在 Step3 全量历史计算结束后输出一次
    //   Part 0: 4大参数 计算规则说明
    //   Part 1: 全部参与计算的 trades 列表（时序从旧到新）
    //   Part 2: 各账户历史持仓 + 当前持仓状态
    //   Part 3: 4大参数 完整计算明细
    // ════════════════════════════════════════════════════════════════════════
    console.log(
      `\n╔${'═'.repeat(68)}╗\n` +
      `║  【4大参数 · 历史计算完整报告】\n` +
      `╠${'═'.repeat(68)}╣\n` +
      `║  计算规则说明（v2 轮次追踪体系）:\n` +
      `║\n` +
      `║  ① 本轮下注 = Σ( 当前轮买入SOL - 当前轮卖出SOL )  for 所有持仓用户\n` +
      `║              = 散户当前轮次的净资金投入量（正值=净买入）\n` +
      `║\n` +
      `║  ② 已落袋   = Σ( 历史轮次净流水 )  for 所有历史已清仓的轮次\n` +
      `║              = Σ( sellSOL - buySOL )  每完成一轮累加一次\n` +
      `║              > 0 : 该轮整体盈利（卖多买少）\n` +
      `║              < 0 : 该轮整体亏损（买多卖少）\n` +
      `║\n` +
      `║  ③ 浮盈浮亏 = 已落袋 + Σ( 当前轮卖出 - 当前轮买入 )  for 持仓用户\n` +
      `║              = 已落袋 - 本轮下注  （持仓用户净流出 = -本轮下注）\n` +
      `║              > 0 : 整体处于盈利状态\n` +
      `║              < 0 : 整体处于亏损状态\n` +
      `║\n` +
      `║  ④ 本轮成本 = 本轮下注 - 已落袋\n` +
      `║              = 持仓用户的净持仓成本（扣除历史盈利/亏损后的真实投入）\n` +
      `║\n` +
      `║  过滤规则: score >= 阈值 → 判定为庄家，不计入4大参数\n` +
      `║            filteredUsers 为空时统计全部用户\n` +
      `╚${'═'.repeat(68)}╝\n`
    );

    // ── Part 1：全部参与计算的 trades（按时间顺序从旧到新）──
    const allTrades = [];
    for (const [addr, history] of Object.entries(this.traderHistory)) {
      history.forEach(t => allTrades.push({ ...t, address: addr }));
    }
    allTrades.sort((a, b) => a.rawTimestamp - b.rawTimestamp);

    const lines1 = allTrades.map((t, i) => {
      const addrShort = t.address.slice(0, 6) + '..' + t.address.slice(-4);
      const solStr = t.solChange >= 0 ? `+${t.solChange.toFixed(4)}` : t.solChange.toFixed(4);
      const tokenStr = t.tokenChange >= 0 ? `+${Math.abs(t.tokenChange).toFixed(0)}` : `-${Math.abs(t.tokenChange).toFixed(0)}`;
      return `  [${i + 1}] ${t.timestamp} | sig=${t.signature?.slice(0, 8) || '?'}.. | addr=${addrShort} | ${t.action} | SOL=${solStr} | Token=${tokenStr}`;
    });
    console.log(`[4大参数] ═══ 参与计算的全部 trades（共 ${allTrades.length} 条）═══\n${lines1.join('\n')}`);

    // ── Part 2：各账户状态 ──
    const accountLines = [];
    for (const [address, stats] of Object.entries(this.traderStats)) {
      if (this.whaleAddresses.has(address)) continue;
      const cr = stats.currentRound;
      const hist = stats.completedRounds || [];
      const isHolding = cr.buySOL > 0 || cr.txCount > 0;
      if (!isHolding && hist.length === 0) continue;

      const addrShort = address.slice(0, 6) + '..' + address.slice(-4);
      let line = `  ${addrShort}  历史${hist.length}轮`;
      if (hist.length > 0) {
        const netSign = stats.totalHistoricalNetFlow >= 0 ? '+' : '';
        line += ` 净流水=${netSign}${stats.totalHistoricalNetFlow.toFixed(4)} SOL`;
        const roundDetail = hist.map((r, i) =>
          `    轮${i + 1}: buy=${r.buySOL.toFixed(4)} sell=${r.sellSOL.toFixed(4)} net=${r.netFlow >= 0 ? '+' : ''}${r.netFlow.toFixed(4)}`
        ).join('\n');
        line += `\n${roundDetail}`;
      }
      if (isHolding) {
        const net = cr.buySOL - cr.sellSOL;
        line += `\n  当前持仓: buy=${cr.buySOL.toFixed(4)} sell=${cr.sellSOL.toFixed(4)} 净成本=${net.toFixed(4)} SOL txCount=${cr.txCount}`;
      } else {
        line += `  当前无持仓`;
      }
      accountLines.push(line);
    }
    console.log(`[4大参数] ═══ 各账户状态（共 ${accountLines.length} 个账户）═══\n${accountLines.join('\n')}`);

    // ── Part 3：4大参数详细计算 ──
    let yiLuDai = 0;
    let benLunXiaZhu = 0;
    let currentNetFlow = 0;
    let activeCount = 0;
    const detailYiLuDai = [];
    const detailXiaZhu = [];

    for (const [address, stats] of Object.entries(this.traderStats)) {
      if (this.filteredUsers.size > 0 && !this.filteredUsers.has(address)) continue;
      if (this.whaleAddresses.has(address)) continue;

      const addrShort = address.slice(0, 6) + '..' + address.slice(-4);

      if (stats.totalHistoricalNetFlow !== 0) {
        yiLuDai += stats.totalHistoricalNetFlow;
        const roundLines = stats.completedRounds.map((r, i) =>
          `    轮${i + 1}: buy=${r.buySOL.toFixed(4)} sell=${r.sellSOL.toFixed(4)} net=${r.netFlow >= 0 ? '+' : ''}${r.netFlow.toFixed(4)}`
        ).join('\n');
        detailYiLuDai.push(`  ${addrShort}: 历史${stats.completedRounds.length}轮\n${roundLines}\n  小计=${stats.totalHistoricalNetFlow >= 0 ? '+' : ''}${stats.totalHistoricalNetFlow.toFixed(4)} SOL`);
      }

      const round = stats.currentRound;
      if (round.buySOL > 0 || round.txCount > 0) {
        const netCost = round.buySOL - round.sellSOL;
        benLunXiaZhu += netCost;
        currentNetFlow += round.sellSOL - round.buySOL;
        activeCount++;
        detailXiaZhu.push(`  ${addrShort}: buy=${round.buySOL.toFixed(4)} - sell=${round.sellSOL.toFixed(4)} = 净成本${netCost.toFixed(4)}`);
      }
    }

    const fuYingFuKui = yiLuDai + currentNetFlow;
    const benLunChengBen = benLunXiaZhu - yiLuDai;

    const part3Lines = [
      `[4大参数] ═══ 四大参数计算明细 ═══`,
      `【已落袋】= 历史所有轮次净流水之和`,
      ...(detailYiLuDai.length > 0 ? detailYiLuDai : ['  （无）']),
      `  → 已落袋 = ${yiLuDai >= 0 ? '+' : ''}${yiLuDai.toFixed(4)} SOL`,
      ``,
      `【本轮下注】= 当前持仓用户(buy-sell)之和（${activeCount}人持仓）`,
      ...(detailXiaZhu.length > 0 ? detailXiaZhu : ['  （无）']),
      `  → 本轮下注 = ${benLunXiaZhu.toFixed(4)} SOL`,
      ``,
      `【浮盈浮亏】= 已落袋(${yiLuDai.toFixed(4)}) + 当前净流水(${currentNetFlow.toFixed(4)}) = ${fuYingFuKui >= 0 ? '+' : ''}${fuYingFuKui.toFixed(4)} SOL`,
      `【本轮成本】= 本轮下注(${benLunXiaZhu.toFixed(4)}) - 已落袋(${yiLuDai.toFixed(4)}) = ${benLunChengBen.toFixed(4)} SOL`,
    ];
    console.log(part3Lines.join('\n'));
  }

  // ─────────────────────────────────────────────────────────
  // Holder 快照 / 评分数据合并
  // ─────────────────────────────────────────────────────────

  updateUserInfo(holderData) {
    const owner = holderData.owner;
    if (!this.traderStats[owner]) {
      this._initTrader(owner);
    }

    const existing = this.traderStats[owner];
    const newFundingAccount = holderData.native_transfer?.from_address || null;

    // 如果之前是 trade-only 用户（无 has_holder_snapshot），现在首次获得 holder 快照：
    // 重置 has_hidden_relay，让 detectHiddenRelays 用新的 funding_account 信息重新评估
    // （trade-only 阶段的检测结果是基于"未知来源"做的，holder 快照可能改变判断依据）
    if (!existing.has_holder_snapshot && existing.has_hidden_relay !== undefined) {
      existing.has_hidden_relay = undefined;
      existing.hidden_relay_conditions = undefined;
    }

    // 排除 GMGN API 返回的 status 字段，避免覆盖评分系统管理的 status
    const { status: _apiStatus, ...holderDataRest } = holderData;
    Object.assign(this.traderStats[owner], {
      owner,
      data_source: 'GMGN Holder API',
      ui_amount: holderData.ui_amount || holderData.amount,
      holding_share_pct: holderData.holding_share_pct,
      total_buy_u: holderData.total_buy_u,
      funding_account: newFundingAccount,
      first_buy_time: holderData.native_transfer?.block_timestamp || null,
      has_holder_snapshot: true,
      last_holder_update: Date.now(),
      ...holderDataRest
    });
    // 新用户默认状态为"普通"（评分系统后续覆盖为"散户"/"庄家"）
    if (!this.traderStats[owner].status) {
      this.traderStats[owner].status = '普通';
    }
  }

  updateUsersInfo(holdersArray) {
    holdersArray.forEach(holder => this.updateUserInfo(holder));
  }

  // ─────────────────────────────────────────────────────────
  // 庄家/过滤 相关
  // ─────────────────────────────────────────────────────────

  updateWhaleAddresses(whaleAddresses) {
    this.whaleAddresses = whaleAddresses || new Set();
  }

  isWhaleAddress(address) {
    return this.whaleAddresses.has(address);
  }

  setFilteredUsers(userSet) {
    this.filteredUsers = userSet;
  }

  updateBossConfig(config) {
    Object.assign(this.bossConfig, config);
  }
}
