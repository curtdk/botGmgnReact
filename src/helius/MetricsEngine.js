/**
 * MetricsEngine v3 - 3大参数计算引擎（均价法）
 *
 * 算法核心：均价法（Average Cost Method）
 *   · 无"轮次"概念，所有历史交易全程累计
 *   · 每次买入更新持仓均价
 *   · 每次卖出用当时均价算出"卖出本金"，差值即为已落袋利润
 *
 * 三大参数定义：
 *   本轮下注  = Σ user.holdingCost = Σ(总买入金额 - 总卖出本金)
 *   已落袋利润 = Σ(总卖出金额 - 总卖出本金)
 *   本轮成本  = 本轮下注 - 已落袋利润  = Σ(总买入金额 - 总卖出金额)
 */

import dataFlowLogger from '../utils/Logger.js';

export default class MetricsEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.traderStats = {};
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
  // 初始化用户结构（均价法）
  // ─────────────────────────────────────────────────────────

  _initTrader(address) {
    this.traderStats[address] = {
      status: '普通',
      score: -1,
      has_holder_snapshot: false,

      // ── 均价法核心字段 ──
      totalBuyAmount: 0,      // 总买入金额(SOL) = Σ(buyQty × buyPrice)
      totalSellAmount: 0,     // 总卖出金额(SOL) = Σ(sellQty × sellPrice)
      totalSellPrincipal: 0,  // 总卖出本金(SOL) = Σ(sellQty × avgPrice_at_sell)
      holdingQty: 0,          // 当前持仓 Token 数量
      holdingCost: 0,         // 当前持仓成本(SOL) = totalBuyAmount - totalSellPrincipal
      avgPrice: 0,            // 当前均价(SOL/Token) = holdingCost / holdingQty
    };
    this.traderHistory[address] = [];
  }

  // ─────────────────────────────────────────────────────────
  // 交易处理入口
  // ─────────────────────────────────────────────────────────

  /**
   * 统一交易处理入口
   *   · type='gmgn'   → GMGN API 格式（maker/event/quote_amount/base_amount）
   *   · type='helius' → Helius RPC parsedTransaction 格式
   *   · 无 type 字段  → 旧版兼容，直接按 Helius 格式处理
   */
  processTransaction(txWrapper, mintAddress) {
    if (!txWrapper) return;

    if (txWrapper.type === 'gmgn') {
      this.processGmgnTransaction(txWrapper.data, mintAddress);
    } else if (txWrapper.type === 'helius') {
      this.processHeliusTransaction(txWrapper.data, mintAddress);
    } else {
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
   * 处理 Helius RPC parsedTransaction 格式
   *   solChange < 0, tokenChange > 0 → 买入
   *   solChange > 0, tokenChange < 0 → 卖出
   */
  processHeliusTransaction(tx, mintAddress) {
    if (!tx || !tx.transaction) return;

    const meta = tx.meta;
    if (!meta) return;
    if (meta.err) return;

    const signature = tx.transaction.signatures[0];
    const feePayer = tx.transaction.message.accountKeys[0].pubkey;

    if (this.isWhaleAddress(feePayer)) {
      this.skippedWhaleCount++;
      return;
    }

    const preSol = meta.preBalances[0];
    const postSol = meta.postBalances[0];
    const txFee = (meta.fee || 0) / 1e9;
    const solChange = (postSol - preSol) / 1e9 + txFee;

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
   * 处理 GMGN API 分页数据
   *   quote_amount → SOL 金额
   *   base_amount  → Token 数量
   *   event        → 'buy' | 'sell'
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
  // 核心：均价法更新用户状态
  // ─────────────────────────────────────────────────────────

  /**
   * 均价法处理单笔交易
   *
   * 买入逻辑：
   *   holdingQty      += buyQty
   *   holdingCost     += buyAmount          (buyAmount = |solChange|)
   *   totalBuyAmount  += buyAmount
   *   avgPrice         = holdingCost / holdingQty
   *
   * 卖出逻辑：
   *   sellPrincipal       = sellQty × avgPrice   (用当时均价计算成本)
   *   totalSellPrincipal += sellPrincipal
   *   totalSellAmount    += sellAmount           (sellAmount = |solChange|)
   *   holdingQty         -= sellQty
   *   holdingCost        -= sellPrincipal
   *   avgPrice            = holdingQty > 0 ? holdingCost / holdingQty : 0
   *
   * @param {string} user         - 钱包地址
   * @param {number} solChange    - SOL 净变化（负=买入，正=卖出）
   * @param {number} tokenChange  - Token 净变化（正=买入，负=卖出）
   * @param {string} signature    - 交易签名
   * @param {string} timestamp    - 格式化时间字符串
   * @param {string} source       - 数据来源
   * @param {number} rawTimestamp - Unix 毫秒时间戳
   */
  updateTraderState(user, solChange, tokenChange, signature, timestamp = '未知', source = '未知', rawTimestamp = Date.now()) {
    if (!this.traderStats[user]) {
      this._initTrader(user);
    }

    const stats = this.traderStats[user];
    let action = '';
    let sellPrincipal = 0;

    // ── 买入：SOL减少，Token增加 ──
    if (solChange < -0.000001 && tokenChange > 0) {
      const buyAmount = Math.abs(solChange);
      const buyQty = tokenChange;

      stats.holdingQty    += buyQty;
      stats.holdingCost   += buyAmount;
      stats.totalBuyAmount += buyAmount;
      stats.avgPrice = stats.holdingQty > 0 ? stats.holdingCost / stats.holdingQty : 0;

      action = '买入';

    // ── 卖出：SOL增加，Token减少 ──
    } else if (solChange > 0.000001 && tokenChange < 0) {
      const sellAmount = solChange;
      const sellQty = Math.abs(tokenChange);

      // 卖出本金 = 卖出数量 × 当时均价
      sellPrincipal = sellQty * stats.avgPrice;

      stats.totalSellPrincipal += sellPrincipal;
      stats.totalSellAmount    += sellAmount;
      stats.holdingQty         -= sellQty;
      stats.holdingCost        -= sellPrincipal;

      // 防止浮点误差导致负值
      if (stats.holdingQty < 0.001) {
        stats.holdingQty = 0;
        stats.holdingCost = 0;
      }
      stats.avgPrice = stats.holdingQty > 0 ? stats.holdingCost / stats.holdingQty : 0;

      action = '卖出';

    } else {
      return; // 非标准 swap，跳过
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
      sellPrincipal,
      avgPriceAfter: stats.avgPrice,
      holdingQtyAfter: stats.holdingQty,
      holdingCostAfter: stats.holdingCost,
    });

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

    // ── 实时快照日志（每笔交易后输出 3大参数 快照）──
    {
      const addrShort = `${user.slice(0, 8)}...${user.slice(-6)}`;
      const solStr = Math.abs(solChange).toFixed(6);
      const tokenStr = Math.abs(tokenChange).toFixed(0);

      // 全局 3大参数 快照
      let snapXiaZhu = 0, snapYiLuDai = 0;
      let snapActiveCount = 0, snapAllCount = 0;
      for (const [addr, s] of Object.entries(this.traderStats)) {
        if (this.whaleAddresses.has(addr)) continue;
        if (this.filteredUsers.size > 0 && !this.filteredUsers.has(addr)) continue;
        snapAllCount++;
        const hc = s.holdingCost;
        const profit = s.totalSellAmount - s.totalSellPrincipal;
        snapYiLuDai += profit;
        if (s.holdingQty > 0) {
          snapXiaZhu += hc;
          snapActiveCount++;
        }
      }
      const snapChengBen = snapXiaZhu - snapYiLuDai;

      const userLine = action === '买入'
        ? `均价: ${stats.avgPrice.toFixed(10)} SOL/T  持仓成本: ${stats.holdingCost.toFixed(6)} SOL  持仓量: ${stats.holdingQty.toFixed(0)} T`
        : `卖出本金: ${sellPrincipal.toFixed(6)} SOL  落袋利润: ${(Math.abs(solChange) - sellPrincipal).toFixed(6)} SOL  均价: ${stats.avgPrice.toFixed(10)}  持仓量: ${stats.holdingQty.toFixed(0)} T`;

      console.log(
        `\n╔${'═'.repeat(62)}╗\n` +
        `║ 【新交易】 ${addrShort}  ${action}  ${solStr} SOL / ${tokenStr} Token\n` +
        `║ ${userLine}\n` +
        `║ sig: ${(signature || '?').slice(0, 32)}..  来源: ${source}\n` +
        `╠${'═'.repeat(62)}╣\n` +
        `║ 3大参数快照（${snapActiveCount}人持仓 / ${snapAllCount}人参与）\n` +
        `║   本轮下注  = ${snapXiaZhu.toFixed(6)} SOL  [Σ持仓成本]\n` +
        `║   已落袋    = ${snapYiLuDai >= 0 ? '+' : ''}${snapYiLuDai.toFixed(6)} SOL  [Σ(卖出金额-卖出本金)]\n` +
        `║   本轮成本  = ${snapChengBen.toFixed(6)} SOL  [本轮下注-已落袋]\n` +
        `╚${'═'.repeat(62)}╝`
      );
    }
  }

  // ─────────────────────────────────────────────────────────
  // 3大参数计算
  // ─────────────────────────────────────────────────────────

  /**
   * 实时计算 3大参数并返回 metrics 对象。
   *
   * 计算逻辑（过滤 filteredUsers 和 whaleAddresses）：
   *
   *   ① 本轮下注 (benLunXiaZhu):
   *      = Σ user.holdingCost  for 持仓用户（holdingQty > 0）
   *      = Σ(totalBuyAmount - totalSellPrincipal)
   *      含义：当前所有持仓用户的持仓成本总和
   *
   *   ② 已落袋利润 (yiLuDai):
   *      = Σ(totalSellAmount - totalSellPrincipal)  for 所有用户
   *      含义：所有用户历史卖出的实现盈亏总和
   *
   *   ③ 本轮成本 (benLunChengBen):
   *      = 本轮下注 - 已落袋利润
   *      = Σ(totalBuyAmount - totalSellAmount)  数学等价
   *      含义：持仓用户的净资金投入（扣除已回收利润后）
   *
   * @returns {Object} { benLunXiaZhu, yiLuDai, benLunChengBen, ... }
   */
  getMetrics() {
    let benLunXiaZhu = 0;  // 本轮下注 = Σ holdingCost
    let yiLuDai = 0;       // 已落袋利润 = Σ(sellAmount - sellPrincipal)
    let activeCount = 0;
    let totalCount = 0;
    const logXiaZhu = [];
    const logYiLuDai = [];

    Object.entries(this.traderStats).forEach(([address, stats]) => {
      if (this.filteredUsers.size > 0 && !this.filteredUsers.has(address)) return;
      if (this.whaleAddresses.has(address)) return;

      totalCount++;
      const s = address.slice(0, 6) + '..' + address.slice(-4);
      const profit = stats.totalSellAmount - stats.totalSellPrincipal;

      // 已落袋：所有用户（含已退出）
      if (stats.totalSellAmount > 0) {
        yiLuDai += profit;
        logYiLuDai.push(
          `${s}: 卖出金额=${stats.totalSellAmount.toFixed(4)} - 卖出本金=${stats.totalSellPrincipal.toFixed(4)} = ${profit >= 0 ? '+' : ''}${profit.toFixed(4)}`
        );
      }

      // 本轮下注：仅持仓用户
      if (stats.holdingQty > 0) {
        benLunXiaZhu += stats.holdingCost;
        activeCount++;
        logXiaZhu.push(
          `${s}: 持仓成本=${stats.holdingCost.toFixed(4)} SOL  均价=${stats.avgPrice.toFixed(10)}  持仓量=${stats.holdingQty.toFixed(0)}`
        );
      }
    });

    // 本轮成本 = 本轮下注 - 已落袋利润
    const benLunChengBen = benLunXiaZhu - yiLuDai;

    // ── 3大参数日志（值变化时写入）──
    const metricsKey = `${benLunXiaZhu.toFixed(4)}|${yiLuDai.toFixed(4)}|${benLunChengBen.toFixed(4)}`;
    const now = Date.now();
    if (this.lastMetricsLog !== metricsKey || now - this.lastMetricsLogTime > 5000) {
      this.lastMetricsLog = metricsKey;
      this.lastMetricsLogTime = now;

      const xiaZhuFormula = logXiaZhu.length > 0
        ? logXiaZhu.map(l => {
            const m = l.match(/持仓成本=(-?[\d.]+)/);
            return m ? parseFloat(m[1]).toFixed(4) : '?';
          }).join(' + ') + ` = ${benLunXiaZhu.toFixed(4)} SOL`
        : `(无持仓用户) = 0.0000 SOL`;

      const yiLuDaiFormula = logYiLuDai.length > 0
        ? logYiLuDai.map(l => {
            const m = l.match(/= ([+\-]?[\d.]+)$/);
            return m ? m[1] : '?';
          }).join(' + ') + ` = ${yiLuDai >= 0 ? '+' : ''}${yiLuDai.toFixed(4)} SOL`
        : `(无卖出记录) = 0.0000 SOL`;

      const detail = [
        `【本轮下注】${benLunXiaZhu.toFixed(4)} SOL（${activeCount}人持仓 / ${totalCount}人参与）`,
        `  公式: 本轮下注 = Σ(总买入金额 - 总卖出本金)`,
        ...logXiaZhu.map(l => '  ' + l),
        `  ↳ ${xiaZhuFormula}`,
        ``,
        `【已落袋利润】${yiLuDai >= 0 ? '+' : ''}${yiLuDai.toFixed(4)} SOL`,
        `  公式: 已落袋 = Σ(卖出金额 - 卖出本金)  卖出本金 = 卖出量 × 均价`,
        ...logYiLuDai.map(l => '  ' + l),
        `  ↳ ${yiLuDaiFormula}`,
        ``,
        `【本轮成本】${benLunChengBen.toFixed(4)} SOL`,
        `  公式: 本轮成本 = 本轮下注(${benLunXiaZhu.toFixed(4)}) - 已落袋(${yiLuDai.toFixed(4)})`,
      ].join('\n');

      dataFlowLogger.log(
        '3大参数', '指标计算',
        `下注=${benLunXiaZhu.toFixed(4)} 落袋=${yiLuDai.toFixed(4)} 成本=${benLunChengBen.toFixed(4)}`,
        { detail }
      );
    }

    return {
      benLunXiaZhu,
      yiLuDai,
      benLunChengBen,
      currentPrice: this.currentPrice,
      activeCount,
      totalCount,
      totalProcessed: this.processedCount,
      skippedWhaleCount: this.skippedWhaleCount,
      recentTrades: this.recentTrades.slice(0, 20000).map(t => ({
        ...t,
        score: this.traderStats[t.address]?.score,
        label: this.traderStats[t.address]?.status || null
      }))
    };
  }

  printMetrics() {
    this.getMetrics();
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

    if (!existing.has_holder_snapshot && existing.has_hidden_relay !== undefined) {
      existing.has_hidden_relay = undefined;
      existing.hidden_relay_conditions = undefined;
    }

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

  // ─────────────────────────────────────────────────────────
  // 4大参数计算报告（历史初始化完成后输出）
  // ─────────────────────────────────────────────────────────

  /**
   * 输出初始化计算报告（从最早交易到最新的汇总）
   */
  printCalculationReport(_processedOrder) {
    console.log('[MetricsEngine] 初始化计算完成');
    // 4大参数已集成到 getMetrics() 中实时输出，此方法仅作占位
  }
}
