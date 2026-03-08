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
      const detail = [
        `【本轮下注】${benLunXiaZhu.toFixed(4)} SOL（${activeCount}人持仓）`,
        ...logXiaZhu.map(l => '  ' + l),
        `【已落袋】${yiLuDai.toFixed(4)} SOL（${exitedRoundsCount}轮历史）`,
        ...logYiLuDai,
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
}
