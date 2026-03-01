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

import BossDetector from './BossDetector.js';
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
      dataFlowLogger.log('HeliusMonitor', '跳过庄家交易',
        `庄家 ${feePayer.substring(0, 8)}... (sig: ${signature.substring(0, 8)}...)`,
        { address: feePayer, signature, skippedCount: this.skippedWhaleCount, source: 'Helius' }
      );
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

  processGmgnTransaction(trade, _mintAddress) {
    if (!trade) return;

    const maker = trade.maker;

    if (this.isWhaleAddress(maker)) {
      this.skippedWhaleCount++;
      dataFlowLogger.log('HeliusMonitor', '跳过庄家交易',
        `庄家 ${maker.substring(0, 8)}... (sig: ${trade.tx_hash.substring(0, 8)}...)`,
        { address: maker, signature: trade.tx_hash, skippedCount: this.skippedWhaleCount, source: 'GMGN' }
      );
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
  }

  // ─────────────────────────────────────────────────────────
  // 四大指标计算
  // ─────────────────────────────────────────────────────────

  getMetrics() {
    let yiLuDai = 0;        // 已落袋 = Σ历史轮次净流水
    let benLunXiaZhu = 0;   // 本轮下注 = Σ(当前轮次买入 - 当前轮次卖出) for 持仓用户
    let currentNetFlow = 0; // 当前持仓用户净流水之和 = Σ(sell - buy) for 持仓用户（负值）
    let activeCount = 0;
    let exitedRoundsCount = 0;

    const logXiaZhu = [];
    const logYiLuDai = [];

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
        logYiLuDai.push(`${s}: 历史${stats.completedRounds.length}轮 净流水=${stats.totalHistoricalNetFlow.toFixed(4)}`);
      }

      // ── 本轮下注：当前未完结轮次的净成本 ──
      const round = stats.currentRound;
      if (round.buySOL > 0 || round.txCount > 0) {
        const netCost = round.buySOL - round.sellSOL; // 正值 = 净投入
        benLunXiaZhu += netCost;
        currentNetFlow += round.sellSOL - round.buySOL; // 负值（当前用户净流出SOL）
        activeCount++;
        logXiaZhu.push(`${s}: buy=${round.buySOL.toFixed(4)} sell=${round.sellSOL.toFixed(4)} 净成本=${netCost.toFixed(4)}`);
      }
    });

    // 浮盈浮亏 = 已落袋 + 当前持仓净流水
    //          = yiLuDai + currentNetFlow
    //          = yiLuDai - benLunXiaZhu（当 currentNetFlow = -benLunXiaZhu 时）
    const fuYingFuKui = yiLuDai + currentNetFlow;

    // 本轮成本 = 本轮下注 - 已落袋
    const benLunChengBen = benLunXiaZhu - yiLuDai;

    // 日志
    const calcLog = [
      '=== 本轮下注（当前持仓净成本）===',
      ...logXiaZhu,
      `合计: ${benLunXiaZhu.toFixed(4)} SOL | 活跃用户: ${activeCount}`,
      '',
      '=== 已落袋（历史持仓净流水）===',
      ...logYiLuDai,
      `合计: ${yiLuDai.toFixed(4)} SOL | 历史轮次: ${exitedRoundsCount}`,
      '',
      `=== 浮盈浮亏 = 已落袋(${yiLuDai.toFixed(4)}) + 当前净流水(${currentNetFlow.toFixed(4)}) = ${fuYingFuKui.toFixed(4)} SOL ===`,
      `=== 本轮成本 = 本轮下注(${benLunXiaZhu.toFixed(4)}) - 已落袋(${yiLuDai.toFixed(4)}) = ${benLunChengBen.toFixed(4)} SOL ===`,
    ];

    const metricsKey = `${yiLuDai.toFixed(4)}|${benLunXiaZhu.toFixed(4)}|${benLunChengBen.toFixed(4)}|${fuYingFuKui.toFixed(4)}`;
    const now = Date.now();
    if (this.lastMetricsLog !== metricsKey || now - this.lastMetricsLogTime > 5000) {
      dataFlowLogger.log('HeliusMonitor', '指标计算完成', `已落袋=${yiLuDai.toFixed(4)} 本轮下注=${benLunXiaZhu.toFixed(4)} 本轮成本=${benLunChengBen.toFixed(4)} 浮盈浮亏=${fuYingFuKui.toFixed(4)}`,
        { yiLuDai: yiLuDai.toFixed(4), benLunXiaZhu: benLunXiaZhu.toFixed(4), benLunChengBen: benLunChengBen.toFixed(4), fuYingFuKui: fuYingFuKui.toFixed(4), activeCount, exitedRoundsCount }
      );
      dataFlowLogger.log('实时指标计算', 'METRICS_CALC', calcLog.join('\n'), {});
      this.lastMetricsLog = metricsKey;
      this.lastMetricsLogTime = now;
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
      recentTrades: this.recentTrades.slice(0, 150).map(t => ({
        ...t,
        score: this.traderStats[t.address]?.score
      }))
    };
  }

  printMetrics() {
    const m = this.getMetrics();
  }

  printDetailedMetrics() {

    Object.entries(this.traderStats).forEach(([address, stats]) => {
      const s = `${address.slice(0, 4)}...${address.slice(-4)}`;

      if (stats.completedRounds.length > 0) {
        stats.completedRounds.forEach((r, i) => {
        });
      }

      const r = stats.currentRound;
      if (r.buySOL > 0 || r.txCount > 0) {
        const netCost = r.buySOL - r.sellSOL;
      } else {
      }
    });

    const m = this.getMetrics();
  }

  // ─────────────────────────────────────────────────────────
  // Holder 快照 / 评分数据合并
  // ─────────────────────────────────────────────────────────

  updateUserInfo(holderData) {
    const owner = holderData.owner;
    if (!this.traderStats[owner]) {
      this._initTrader(owner);
    }

    const uiAmount = holderData.ui_amount || holderData.amount || 0;

    Object.assign(this.traderStats[owner], {
      owner,
      data_source: 'GMGN Holder API',
      ui_amount: holderData.ui_amount || holderData.amount,
      holding_share_pct: holderData.holding_share_pct,
      total_buy_u: holderData.total_buy_u,
      funding_account: holderData.native_transfer?.from_address || null,
      first_buy_time: holderData.native_transfer?.block_timestamp || null,
      has_holder_snapshot: true,
      last_holder_update: Date.now(),
      ...holderData
    });
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

  detectWhales(existingStatusMap = {}) {
    const result = BossDetector.detectWhales(
      this.traderStats,
      this.traderStats,
      this.bossConfig,
      existingStatusMap
    );

    this.whaleAddresses.clear();
    Object.entries(result.statusMap).forEach(([address, status]) => {
      if (status === '庄家') this.whaleAddresses.add(address);
    });

    return result;
  }
}
