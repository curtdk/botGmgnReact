/**
 * MetricsEngine - 浏览器版指标计算引擎
 *
 * 功能：
 * 1. 处理交易并计算统计指标
 * 2. 跟踪每个交易者的买卖行为
 * 3. 计算已落袋、本轮下注、本轮成本、浮盈浮亏等指标
 * 4. 确保只处理未计算过的交易（通过 SignatureManager 的 isProcessed 标志）
 * 5. 记录每个用户的完整交易历史，确保计算基于全部数据
 */

import LogFormatter from './LogFormatter.js';
import BossDetector from './BossDetector.js';
import dataFlowLogger from '../utils/Logger.js';

export default class MetricsEngine {
  constructor() {
    this.reset();
  }

  reset() {
    // user: { netSolSpent: 0, netTokenReceived: 0, totalBuySol: 0, totalSellSol: 0 }
    this.traderStats = {};
    // 记录每个用户的完整交易历史（确保计算基于全部数据）
    this.traderHistory = {};

    // [新增] 用户完整信息(类似 contentManager 的 dataMap)
    this.userInfo = {};  // { [address]: { owner, ui_amount, holding_share_pct, status, funding_account, ... } }

    this.currentPrice = 0;
    this.lastProcessedSig = null;
    this.processedCount = 0;
    // 当前处理阶段（用于日志）
    this.currentPhase = null;
    this.totalTransactions = 0;
    this.currentTransactionIndex = 0;

    // [新增] 庄家检测相关
    this.whaleAddresses = new Set();
    this.skippedWhaleCount = 0;

    // [新增] 过滤用户列表（score < threshold）
    this.filteredUsers = new Set();

    // 实时交易列表（最新在前，最多300条）
    this.recentTrades = [];

    // [新增] 防重复日志
    this.lastMetricsLog = null;
    this.lastMetricsLogTime = 0;

    // [新增] 庄家检测配置
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

  /**
   * 处理单个交易（支持 Helius 和 GMGN 格式）
   * @param {Object} txWrapper - 交易数据包装器 { type: 'helius'|'gmgn', data: ... }
   * @param {string} mintAddress - 代币地址
   */
  processTransaction(txWrapper, mintAddress) {
    if (!txWrapper) return;

    // 判断数据类型
    if (txWrapper.type === 'gmgn') {
      this.processGmgnTransaction(txWrapper.data, mintAddress);
    } else if (txWrapper.type === 'helius') {
      this.processHeliusTransaction(txWrapper.data, mintAddress);
    } else {
      // 兼容旧格式（直接传入 Helius 数据）
      this.processHeliusTransaction(txWrapper, mintAddress);
    }
  }

  /**
   * 处理 Helius 格式的交易
   */
  processHeliusTransaction(tx, mintAddress) {
    if (!tx || !tx.transaction) return;

    const meta = tx.meta;
    if (!meta) return;

    const signature = tx.transaction.signatures[0];

    if (meta.err) {
      console.log(`[MetricsEngine] ⏭️  跳过失败交易: ${signature.substring(0, 8)}...`);
      return; // 跳过失败的交易
    }

    const feePayer = tx.transaction.message.accountKeys[0].pubkey;

    // [新增] 庄家过滤
    if (this.isWhaleAddress(feePayer)) {
      this.skippedWhaleCount++;
      console.log(`[MetricsEngine] ⏭️  跳过庄家交易: ${feePayer.substring(0, 8)}... (sig: ${signature.substring(0, 8)}...)`);

      // 记录日志
      dataFlowLogger.log(
        'HeliusMonitor',
        '跳过庄家交易',
        `跳过庄家 ${feePayer.substring(0, 8)}... 的交易，不计入指标计算`,
        {
          address: feePayer,
          signature: signature,
          skippedCount: this.skippedWhaleCount,
          source: 'Helius'
        }
      );

      return;
    }

    // 1. 解析 SOL 变化（fee payer）
    const preSol = meta.preBalances[0];
    const postSol = meta.postBalances[0];
    // 还原实际 swap 金额：去掉交易 fee（preBalances/postBalances 差值包含 fee）
    // 买入：solChange = -(swap + fee) + fee = -swap（正确的 swap 成本）
    // 卖出：solChange = (swap - fee) + fee = +swap（正确的 swap 收益）
    const txFee = (meta.fee || 0) / 1e9;
    const solChange = (postSol - preSol) / 1e9 + txFee;

    // 2. 解析代币变化
    let preToken = 0;
    let postToken = 0;

    // 辅助函数：查找余额
    const findBal = (balances) => {
      const b = balances.find(b => b.owner === feePayer && b.mint === mintAddress);
      return b ? b.uiTokenAmount.uiAmount || 0 : 0;
    };

    if (meta.preTokenBalances) preToken = findBal(meta.preTokenBalances);
    if (meta.postTokenBalances) postToken = findBal(meta.postTokenBalances);

    const tokenChange = postToken - preToken;

    // 获取时间戳
    const rawTimestamp = tx.timestamp ? tx.timestamp * 1000 : Date.now();
    const timestamp = tx.timestamp ? new Date(rawTimestamp).toLocaleString('zh-CN') : '未知';

    // 使用改进的日志格式
    this.currentTransactionIndex++;
    if (this.totalTransactions > 0) {
      console.log('\n' + '-'.repeat(100));
      console.log(`[交易 ${this.currentTransactionIndex}/${this.totalTransactions}] 处理中...`);
      console.log('-'.repeat(100));
    } else {
      console.log(`\n[MetricsEngine] 📝 处理交易 ${signature.substring(0, 8)}...`);
    }

    console.log(`   📝 Signature: ${signature.substring(0, 12)}...${signature.substring(signature.length - 8)}`);
    console.log(`   ⏰ 时间: ${timestamp}`);
    console.log(`   👤 用户: ${feePayer.substring(0, 8)}...${feePayer.substring(feePayer.length - 8)}`);
    console.log(`   💰 SOL变化: ${solChange >= 0 ? '+' : ''}${solChange.toFixed(6)} SOL`);
    console.log(`   🪙 Token变化: ${tokenChange >= 0 ? '+' : ''}${tokenChange.toFixed(2)} Token`);
    console.log(`   📍 数据来源: Helius API`);

    // 3. 更新交易者状态（包含交易历史记录）
    this.updateTraderState(feePayer, solChange, tokenChange, signature, timestamp, 'Helius API', rawTimestamp);

    // 记录日志
    dataFlowLogger.log(
      'HeliusMonitor',
      '处理散户交易',
      `处理散户 ${feePayer.substring(0, 8)}... 的交易，计入指标计算`,
      {
        address: feePayer,
        signature: signature,
        solChange: solChange.toFixed(6),
        tokenChange: tokenChange.toFixed(2),
        processedCount: this.processedCount + 1,
        source: 'Helius'
      }
    );

    // 4. 更新价格（从交换估算）
    if (tokenChange !== 0 && Math.abs(solChange) > 0.000001) {
      this.currentPrice = Math.abs(solChange) / Math.abs(tokenChange);
    }

    this.lastProcessedSig = signature;
    this.processedCount++;
  }

  /**
   * 处理 GMGN 格式的交易
   */
  processGmgnTransaction(trade, mintAddress) {
    if (!trade) return;

    const maker = trade.maker;

    // [新增] 庄家过滤
    if (this.isWhaleAddress(maker)) {
      this.skippedWhaleCount++;
      console.log(`[MetricsEngine] ⏭️  跳过庄家交易: ${maker.substring(0, 8)}... (sig: ${trade.tx_hash.substring(0, 8)}...)`);

      // 记录日志
      dataFlowLogger.log(
        'HeliusMonitor',
        '跳过庄家交易',
        `跳过庄家 ${maker.substring(0, 8)}... 的交易，不计入指标计算`,
        {
          address: maker,
          signature: trade.tx_hash,
          skippedCount: this.skippedWhaleCount,
          source: 'GMGN'
        }
      );

      return;
    }

    const event = trade.event; // "buy" 或 "sell"
    const quoteAmount = parseFloat(trade.quote_amount); // SOL 数量
    const baseAmount = parseFloat(trade.base_amount);   // Token 数量
    const rawTimestamp = trade.timestamp ? trade.timestamp * 1000 : Date.now();
    const timestamp = trade.timestamp ? new Date(rawTimestamp).toLocaleString('zh-CN') : '未知';

    // 根据 event 类型计算 SOL 和 Token 变化
    let solChange, tokenChange;

    if (event === 'buy') {
      // 买入：SOL 减少（负值），Token 增加（正值）
      solChange = -quoteAmount;
      tokenChange = baseAmount;
    } else if (event === 'sell') {
      // 卖出：SOL 增加（正值），Token 减少（负值）
      solChange = quoteAmount;
      tokenChange = -baseAmount;
    } else {
      return; // 未知事件类型
    }

    // 更新交易者状态（包含交易历史）
    this.updateTraderState(maker, solChange, tokenChange, trade.tx_hash, timestamp, 'GMGN API', rawTimestamp);

    // 记录日志
    dataFlowLogger.log(
      'HeliusMonitor',
      '处理散户交易',
      `处理散户 ${maker.substring(0, 8)}... 的交易，计入指标计算`,
      {
        address: maker,
        signature: trade.tx_hash,
        event: event,
        solChange: solChange.toFixed(6),
        tokenChange: tokenChange.toFixed(2),
        processedCount: this.processedCount + 1,
        source: 'GMGN'
      }
    );

    // 更新价格
    if (tokenChange !== 0 && Math.abs(solChange) > 0.000001) {
      this.currentPrice = Math.abs(solChange) / Math.abs(tokenChange);
    }

    this.lastProcessedSig = trade.tx_hash;
    this.processedCount++;
  }

  /**
   * 处理交易列表（按时间顺序，从旧到新）
   * @param {Array} transactions - 交易列表
   * @param {string} mintAddress - 代币地址
   */
  processTransactions(transactions, mintAddress) {
    transactions.forEach(tx => {
      this.processTransaction(tx, mintAddress);
    });
  }

  /**
   * 设置总交易数（用于显示进度）
   */
  setTotalTransactions(total) {
    this.totalTransactions = total;
    this.currentTransactionIndex = 0;
  }

  /**
   * 更新用户信息(从 GMGN holder 数据)
   * @param {Object} holderData - GMGN holder 数据
   */
  updateUserInfo(holderData) {
    const owner = holderData.owner;

    if (!this.userInfo[owner]) {
      this.userInfo[owner] = {};
    }

    // [调试] 记录 Holder 数据的 ui_amount
    const uiAmount = holderData.ui_amount || holderData.amount || 0;
    console.log(`[MetricsEngine] updateUserInfo: ${owner.slice(0, 8)}..., ui_amount=${uiAmount}, total_buy_u=${holderData.total_buy_u || 0}`);

    // 合并数据
    Object.assign(this.userInfo[owner], {
      owner: owner,
      data_source: 'GMGN Holder API',  // 标识数据来源
      ui_amount: holderData.ui_amount || holderData.amount,
      holding_share_pct: holderData.holding_share_pct,
      total_buy_u: holderData.total_buy_u,
      funding_account: holderData.native_transfer?.from_address || null,
      first_buy_time: holderData.native_transfer?.block_timestamp || null,
      // 新增：混合数据源字段
      data_mode: 'holder_based',  // 数据模式：基于 Holder API
      has_holder_snapshot: true,  // 有 Holder 快照
      last_holder_update: Date.now(),  // 最后 Holder 更新时间
      // 保留其他字段
      ...holderData
    });

  }

  /**
   * 批量更新用户信息
   * @param {Array} holdersArray - GMGN holders 数组
   */
  updateUsersInfo(holdersArray) {
    holdersArray.forEach(holder => {
      this.updateUserInfo(holder);
    });

    console.log(`[MetricsEngine] 更新了 ${holdersArray.length} 个用户信息`);
  }

  /**
   * 更新庄家地址列表
   * @param {Set} whaleAddresses - 庄家地址集合
   */
  updateWhaleAddresses(whaleAddresses) {
    this.whaleAddresses = whaleAddresses || new Set();
    console.log(`[MetricsEngine] 更新庄家地址列表: ${this.whaleAddresses.size} 个庄家`);
  }

  /**
   * 检查地址是否为庄家
   * @param {string} address - 钱包地址
   * @returns {boolean}
   */
  isWhaleAddress(address) {
    return this.whaleAddresses.has(address);
  }

  /**
   * 更新庄家配置
   * @param {Object} config - 新配置
   */
  updateBossConfig(config) {
    Object.assign(this.bossConfig, config);
    console.log('[MetricsEngine] 更新庄家检测配置:', this.bossConfig);
  }

  /**
   * 执行庄家检测
   * @param {Object} existingStatusMap - 已有的手动分类
   * @returns {Object} - { statusMap, detectedBosses }
   */
  detectWhales(existingStatusMap = {}) {
    console.log('[MetricsEngine] 开始庄家检测...');
    console.log(`  - 用户总数: ${Object.keys(this.userInfo).length}`);
    console.log(`  - 配置: enable_no_source=${this.bossConfig.enable_no_source}, enable_same_source=${this.bossConfig.enable_same_source}, enable_time_cluster=${this.bossConfig.enable_time_cluster}`);

    const result = BossDetector.detectWhales(
      this.userInfo,
      this.traderStats,
      this.bossConfig,
      existingStatusMap
    );

    // 更新 whaleAddresses
    this.whaleAddresses.clear();
    Object.entries(result.statusMap).forEach(([address, status]) => {
      if (status === '庄家') {
        this.whaleAddresses.add(address);
      }
    });

    console.log(`[MetricsEngine] 庄家检测完成:`);
    console.log(`  - 检测到庄家: ${result.detectedBosses.size} 个`);
    console.log(`  - 总庄家数: ${this.whaleAddresses.size} 个`);
    console.log(`  - 散户数: ${Object.keys(result.statusMap).length - this.whaleAddresses.size} 个`);

    return result;
  }

  /**
   * 更新交易者状态（包含交易历史记录）
   */
  updateTraderState(user, solChange, tokenChange, signature, timestamp = '未知', source = '未知', rawTimestamp = Date.now()) {
    const isNewUser = !this.traderStats[user];

    if (isNewUser) {
      this.traderStats[user] = {
        netSolSpent: 0,
        netTokenReceived: 0,
        totalBuySol: 0,
        totalSellSol: 0
      };
      this.traderHistory[user] = [];
      console.log(`   ✨ 状态: 新用户`);
    }

    const stats = this.traderStats[user];
    let action = '';

    // 买入：SOL 减少（负变化），代币增加
    if (solChange < -0.000001 && tokenChange > 0) {
      const cost = Math.abs(solChange);
      stats.netSolSpent += cost;
      stats.totalBuySol += cost;
      stats.netTokenReceived += tokenChange;
      action = '买入';
      console.log(`   📊 操作: ${action}`);
      console.log(`   ✅ 买入: ${cost.toFixed(6)} SOL → ${tokenChange.toFixed(2)} Token`);
    }
    // 卖出：SOL 增加，代币减少
    else if (solChange > 0.000001 && tokenChange < 0) {
      const revenue = solChange;
      stats.netSolSpent -= revenue;
      stats.totalSellSol += revenue;
      stats.netTokenReceived += tokenChange;
      action = '卖出';
      console.log(`   📊 操作: ${action}`);
      console.log(`   ✅ 卖出: ${Math.abs(tokenChange).toFixed(2)} Token → ${revenue.toFixed(6)} SOL`);
    }
    // 既不是买入也不是卖出
    else {
      console.log(`   ⚠️  跳过: SOL变化太小或Token变化为0`);
      console.log(`      条件检查: solChange=${solChange.toFixed(9)}, tokenChange=${tokenChange.toFixed(2)}`);
      return; // 不记录无效交易
    }

    // 记录交易历史（确保每个用户的计算基于全部历史数据）
    this.traderHistory[user].push({
      signature,
      timestamp,
      solChange,
      tokenChange,
      action,
      source,
      // 记录交易后的累积状态
      totalBuyAfter: stats.totalBuySol,
      totalSellAfter: stats.totalSellSol,
      tokenBalanceAfter: stats.netTokenReceived,
      netCostAfter: stats.netSolSpent
    });

    // 添加到全局实时交易列表（最新在前）
    this.recentTrades.unshift({
      signature,
      address: user,
      action,
      tokenAmount: Math.abs(tokenChange),
      solAmount: Math.abs(solChange),
      rawTimestamp,
      label: this.userInfo[user]?.status || null
    });
    if (this.recentTrades.length > 300) {
      this.recentTrades.length = 300;
    }

    // 判断用户状态
    const isExited = stats.netTokenReceived < 1;
    const pnl = isExited ? (stats.totalSellSol - stats.totalBuySol) : null;

    // 显示用户状态更新
    console.log(`\n   📋 用户状态更新 (基于全部 ${this.traderHistory[user].length} 笔历史交易):`);
    console.log(`   ├─ 累计买入: ${stats.totalBuySol.toFixed(6)} SOL`);
    console.log(`   ├─ 累计卖出: ${stats.totalSellSol.toFixed(6)} SOL`);
    console.log(`   ├─ 持有代币: ${stats.netTokenReceived.toFixed(2)} Token`);
    console.log(`   ├─ 净成本: ${stats.netSolSpent.toFixed(6)} SOL`);

    if (isExited) {
      console.log(`   └─ 状态: 已退出 ❌ (实现盈亏: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL)`);
    } else {
      console.log(`   └─ 状态: 持有中 ✓`);
    }
  }

  /**
   * 获取指标
   */
  getMetrics() {
    let yiLuDai = 0; // 已落袋（已退出用户的实现盈亏）
    let benLunXiaZhu = 0; // 本轮下注（当前持有者的买入总额）
    let currentHoldersRealized = 0; // 当前持有者的卖出总额
    let floatingPnL = 0; // 浮盈浮亏
    let exitedCount = 0; // 已退出用户数
    let activeCount = 0; // 当前持有者数

    // [调试] 添加详细日志
    const traderStatsCount = Object.keys(this.traderStats).length;
    const filteredUsersCount = this.filteredUsers.size;
    const whaleAddressesCount = this.whaleAddresses.size;

    console.log(`[MetricsEngine] getMetrics 调试信息:`, {
      traderStatsCount,
      filteredUsersCount,
      whaleAddressesCount,
      currentPrice: this.currentPrice
    });

    let skippedByFilter = 0;
    let skippedByWhale = 0;
    let processedCount = 0;

    // 四个指标各自的日志行
    const logXiaZhu = [];
    const logChengBen = [];
    const logYiLuDai = [];
    const logFloating = [];

    Object.entries(this.traderStats).forEach(([address, stats]) => {
      // 只排除"已评分 AND 评分 >= 阈值"的用户（即不在 filteredUsers 里但在 userInfo 里）
      // 未评分的用户（不在 userInfo 里，如历史离场者）不应被过滤，仍需纳入统计
      const wasScored = !!this.userInfo[address];
      if (this.filteredUsers.size > 0 && wasScored && !this.filteredUsers.has(address)) {
        skippedByFilter++;
        return; // 跳过已评分的高分用户（庄家/高分散户）
      }

      // 跳过庄家
      if (this.whaleAddresses.has(address)) {
        skippedByWhale++;
        return;
      }

      processedCount++;

      const isExited = stats.netTokenReceived < 1; // 近似为 0
      const s = address.slice(0, 6) + '..' + address.slice(-4);

      const history = this.traderHistory[address] || [];

      if (isExited) {
        const delta = stats.totalSellSol - stats.totalBuySol;
        yiLuDai += delta;
        exitedCount++;
        // 逐笔展开
        logYiLuDai.push(`${s}:`);
        let runBuy = 0, runSell = 0;
        history.forEach((tx, i) => {
          if (tx.action === '买入') {
            runBuy += Math.abs(tx.solChange);
            logYiLuDai.push(`  [${i+1}] 买入 -${Math.abs(tx.solChange).toFixed(4)} SOL → 累计买入=${runBuy.toFixed(4)}`);
          } else if (tx.action === '卖出') {
            runSell += tx.solChange;
            logYiLuDai.push(`  [${i+1}] 卖出 +${tx.solChange.toFixed(4)} SOL → 累计卖出=${runSell.toFixed(4)}`);
          }
        });
        logYiLuDai.push(`  小计: 卖出${stats.totalSellSol.toFixed(4)} - 买入${stats.totalBuySol.toFixed(4)} = ${delta >= 0 ? '+' : ''}${delta.toFixed(4)} | 全局累计=${yiLuDai.toFixed(4)}`);
      } else {
        benLunXiaZhu += stats.totalBuySol;
        currentHoldersRealized += stats.totalSellSol;
        activeCount++;

        // 本轮下注：逐笔买入
        logXiaZhu.push(`${s}:`);
        let runBuyX = 0;
        history.forEach((tx, i) => {
          if (tx.action === '买入') {
            runBuyX += Math.abs(tx.solChange);
            logXiaZhu.push(`  [${i+1}] 买入 +${Math.abs(tx.solChange).toFixed(4)} SOL → 小计=${runBuyX.toFixed(4)}`);
          }
        });
        logXiaZhu.push(`  地址合计: ${stats.totalBuySol.toFixed(4)} | 全局累计=${benLunXiaZhu.toFixed(4)}`);

        // 本轮成本：逐笔买入/卖出
        logChengBen.push(`${s}:`);
        let runNet = 0;
        history.forEach((tx, i) => {
          if (tx.action === '买入') {
            runNet += Math.abs(tx.solChange);
            logChengBen.push(`  [${i+1}] 买入 +${Math.abs(tx.solChange).toFixed(4)} → 净=${runNet.toFixed(4)}`);
          } else if (tx.action === '卖出') {
            runNet -= tx.solChange;
            logChengBen.push(`  [${i+1}] 卖出 -${tx.solChange.toFixed(4)} → 净=${runNet.toFixed(4)}`);
          }
        });
        logChengBen.push(`  小计: 买入${stats.totalBuySol.toFixed(4)} 卖出${stats.totalSellSol.toFixed(4)} 净=${runNet.toFixed(4)} | 全局累计=${(benLunXiaZhu - currentHoldersRealized).toFixed(4)}`);

        // 浮盈浮亏
        const value = stats.netTokenReceived * this.currentPrice;
        const cost = stats.netSolSpent;
        const fpDelta = value - cost;
        floatingPnL += fpDelta;
        logFloating.push(
          `${s}: ${stats.netTokenReceived.toFixed(0)}×${this.currentPrice.toFixed(6)} - ${cost.toFixed(4)} = ${fpDelta >= 0 ? '+' : ''}${fpDelta.toFixed(4)} 累计=${floatingPnL.toFixed(4)}`
        );
      }
    });

    const benLunChengBen = benLunXiaZhu - currentHoldersRealized;

    // 组合四个指标的逐笔计算日志
    const calcLog = [
      '=== 本轮下注 ===',
      ...logXiaZhu,
      `合计: ${benLunXiaZhu.toFixed(4)} SOL`,
      '',
      '=== 本轮成本（下注 - 已卖出）===',
      ...logChengBen,
      `合计: ${benLunChengBen.toFixed(4)} SOL`,
      '',
      '=== 已落袋（已退出用户）===',
      ...logYiLuDai,
      `合计: ${yiLuDai.toFixed(4)} SOL`,
      '',
      '=== 浮盈浮亏（持有中用户）===',
      ...logFloating,
      `合计: ${floatingPnL.toFixed(4)} SOL`,
    ];

    // [调试] 输出统计信息
    console.log(`[MetricsEngine] getMetrics 统计:`, {
      processedCount,
      skippedByFilter,
      skippedByWhale,
      activeCount,
      exitedCount
    });

    // 生成日志内容
    const metricsLogContent = JSON.stringify({
      散户交易数: this.processedCount,
      跳过庄家交易数: this.skippedWhaleCount,
      过滤后用户数: this.filteredUsers.size,
      已落袋: yiLuDai.toFixed(4),
      本轮下注: benLunXiaZhu.toFixed(4),
      本轮成本: benLunChengBen.toFixed(4),
      浮盈浮亏: floatingPnL.toFixed(4),
      活跃用户: activeCount,
      已退出用户: exitedCount
    });

    // 防重复日志：只有当指标变化或距离上次日志超过5秒时才记录
    const now = Date.now();
    const shouldLog = this.lastMetricsLog !== metricsLogContent || (now - this.lastMetricsLogTime) > 5000;

    if (shouldLog) {
      dataFlowLogger.log(
        'HeliusMonitor',
        '计算指标完成',
        `指标计算完成：只计算散户交易，跳过庄家交易`,
        {
          散户交易数: this.processedCount,
          跳过庄家交易数: this.skippedWhaleCount,
          过滤后用户数: this.filteredUsers.size,
          已落袋: yiLuDai.toFixed(4) + ' SOL',
          本轮下注: benLunXiaZhu.toFixed(4) + ' SOL',
          本轮成本: benLunChengBen.toFixed(4) + ' SOL',
          浮盈浮亏: floatingPnL.toFixed(4) + ' SOL',
          活跃用户: activeCount,
          已退出用户: exitedCount
        }
      );
      // 写入逐笔计算明细日志
      dataFlowLogger.log(
        '实时指标计算',
        'METRICS_CALC',
        calcLog.join('\n'),
        {}
      );
      this.lastMetricsLog = metricsLogContent;
      this.lastMetricsLogTime = now;
    }

    return {
      yiLuDai,
      benLunXiaZhu,
      benLunChengBen,
      floatingPnL,
      currentPrice: this.currentPrice,
      activeCount,
      exitedCount,
      totalProcessed: this.processedCount,
      skippedWhaleCount: this.skippedWhaleCount,
      recentTrades: this.recentTrades.slice(0, 150)
    };
  }

  /**
   * 打印指标
   */
  printMetrics() {
    const metrics = this.getMetrics();

    console.log('\n========== 指标统计 ==========');
    console.log(`已落袋: ${metrics.yiLuDai.toFixed(4)} SOL`);
    console.log(`本轮下注: ${metrics.benLunXiaZhu.toFixed(4)} SOL`);
    console.log(`本轮成本: ${metrics.benLunChengBen.toFixed(4)} SOL`);
    console.log(`浮盈浮亏: ${metrics.floatingPnL.toFixed(4)} SOL`);
    console.log(`当前价格: ${metrics.currentPrice.toFixed(10)} SOL/Token`);
    console.log(`活跃用户: ${metrics.activeCount}`);
    console.log(`已退出用户: ${metrics.exitedCount}`);
    console.log(`已处理交易: ${metrics.totalProcessed}`);
    console.log(`跳过庄家交易: ${metrics.skippedWhaleCount}`);  // [新增]
    console.log('==============================\n');
  }

  /**
   * 打印详细指标（包含每个用户的计算过程）
   * @param {Set<string>} currentHolders - 当前持有者地址集合（来自 GMGN 数据）
   */
  printDetailedMetrics(currentHolders = null) {
    console.log('\n' + '='.repeat(80));
    console.log('详细指标统计 - 每个用户的计算明细');
    console.log('='.repeat(80));

    // 分类用户
    const exitedUsers = [];
    const activeUsers = [];

    Object.entries(this.traderStats).forEach(([address, stats]) => {
      // 如果提供了 GMGN 持有者列表，使用它来判断
      // 否则使用 netTokenReceived 来判断
      let isExited;
      if (currentHolders) {
        isExited = !currentHolders.has(address);
        console.log(`[分类] ${address.slice(0, 8)}... - GMGN持有: ${currentHolders.has(address)}, 计算余额: ${stats.netTokenReceived.toFixed(2)}`);
      } else {
        isExited = stats.netTokenReceived < 1;
      }

      if (isExited) {
        exitedUsers.push({ address, stats });
      } else {
        activeUsers.push({ address, stats });
      }
    });

    console.log(`\n📊 用户分类结果:`);
    console.log(`   - 已退出用户: ${exitedUsers.length} 个`);
    console.log(`   - 当前持有者: ${activeUsers.length} 个`);
    console.log(`   - 数据来源: ${currentHolders ? 'GMGN持有者列表' : 'Helius交易计算'}`);

    // 1. 已落袋详细计算
    console.log('\n💰 已落袋 (已退出用户的实现盈亏)');
    console.log('-'.repeat(80));
    console.log(`已退出用户数: ${exitedUsers.length}`);

    let yiLuDaiTotal = 0;
    if (exitedUsers.length > 0) {
      console.log('\n每个用户的详细计算:');
      exitedUsers.forEach(({ address, stats }, index) => {
        const pnl = stats.totalSellSol - stats.totalBuySol;
        yiLuDaiTotal += pnl;
        const shortAddr = `${address.slice(0, 4)}...${address.slice(-4)}`;
        console.log(`\n  ${index + 1}. ${shortAddr} (${address})`);
        console.log(`     ├─ 买入总额: ${stats.totalBuySol.toFixed(6)} SOL`);
        console.log(`     ├─ 卖出总额: ${stats.totalSellSol.toFixed(6)} SOL`);
        console.log(`     ├─ 计算代币余额: ${stats.netTokenReceived.toFixed(2)} Token`);
        console.log(`     ├─ 净SOL花费: ${stats.netSolSpent.toFixed(6)} SOL`);
        console.log(`     └─ 实现盈亏: ${stats.totalSellSol.toFixed(6)} - ${stats.totalBuySol.toFixed(6)} = ${pnl.toFixed(6)} SOL ${pnl >= 0 ? '✅ 盈利' : '❌ 亏损'}`);
      });
      console.log(`\n  ✅ 已落袋合计: ${yiLuDaiTotal.toFixed(6)} SOL`);
      console.log(`     计算方式: Σ(卖出总额 - 买入总额) 对所有已退出用户求和`);
    } else {
      console.log('  (暂无已退出用户)');
    }

    // 2. 本轮下注详细计算
    console.log('\n🎯 本轮下注 (当前持有者的买入总额)');
    console.log('-'.repeat(80));
    console.log(`当前持有者数: ${activeUsers.length}`);

    let benLunXiaZhuTotal = 0;
    if (activeUsers.length > 0) {
      console.log('\n每个用户的详细计算:');
      activeUsers.forEach(({ address, stats }, index) => {
        benLunXiaZhuTotal += stats.totalBuySol;
        const shortAddr = `${address.slice(0, 4)}...${address.slice(-4)}`;
        console.log(`\n  ${index + 1}. ${shortAddr} (${address})`);
        console.log(`     ├─ 买入总额: ${stats.totalBuySol.toFixed(6)} SOL`);
        console.log(`     ├─ 卖出总额: ${stats.totalSellSol.toFixed(6)} SOL`);
        console.log(`     └─ 持有代币: ${stats.netTokenReceived.toFixed(2)} Token`);
      });
      console.log(`\n  ✅ 本轮下注合计: ${benLunXiaZhuTotal.toFixed(6)} SOL`);
      console.log(`     计算方式: Σ(买入总额) 对所有当前持有者求和`);
    } else {
      console.log('  (暂无持有者)');
    }

    // 3. 本轮成本详细计算
    console.log('\n💵 本轮成本 (当前持有者的净成本)');
    console.log('-'.repeat(80));

    let benLunChengBenTotal = 0;
    let currentHoldersRealizedTotal = 0;
    if (activeUsers.length > 0) {
      console.log('\n每个用户的详细计算:');
      activeUsers.forEach(({ address, stats }, index) => {
        const netCost = stats.totalBuySol - stats.totalSellSol;
        benLunChengBenTotal += netCost;
        currentHoldersRealizedTotal += stats.totalSellSol;
        const shortAddr = `${address.slice(0, 4)}...${address.slice(-4)}`;
        console.log(`\n  ${index + 1}. ${shortAddr} (${address})`);
        console.log(`     ├─ 买入总额: ${stats.totalBuySol.toFixed(6)} SOL`);
        console.log(`     ├─ 卖出总额: ${stats.totalSellSol.toFixed(6)} SOL`);
        console.log(`     └─ 净成本: ${stats.totalBuySol.toFixed(6)} - ${stats.totalSellSol.toFixed(6)} = ${netCost.toFixed(6)} SOL`);
      });
      console.log(`\n  计算公式: 本轮下注 - 当前持有者已卖出`);
      console.log(`           ${benLunXiaZhuTotal.toFixed(6)} - ${currentHoldersRealizedTotal.toFixed(6)} = ${benLunChengBenTotal.toFixed(6)} SOL`);
      console.log(`  ✅ 本轮成本合计: ${benLunChengBenTotal.toFixed(6)} SOL`);
    } else {
      console.log('  (暂无持有者)');
    }

    // 4. 浮盈浮亏详细计算
    console.log('\n📈 浮盈浮亏 (当前持有者的未实现盈亏)');
    console.log('-'.repeat(80));
    console.log(`当前价格: ${this.currentPrice.toFixed(10)} SOL/Token`);

    let floatingPnLTotal = 0;
    if (activeUsers.length > 0) {
      console.log('\n每个用户的详细计算:');
      activeUsers.forEach(({ address, stats }, index) => {
        const currentValue = stats.netTokenReceived * this.currentPrice;
        const netCost = stats.netSolSpent;
        const pnl = currentValue - netCost;
        floatingPnLTotal += pnl;
        const shortAddr = `${address.slice(0, 4)}...${address.slice(-4)}`;
        console.log(`\n  ${index + 1}. ${shortAddr} (${address})`);
        console.log(`     ├─ 持有代币: ${stats.netTokenReceived.toFixed(2)} Token`);
        console.log(`     ├─ 当前价格: ${this.currentPrice.toFixed(10)} SOL/Token`);
        console.log(`     ├─ 当前市值: ${stats.netTokenReceived.toFixed(2)} × ${this.currentPrice.toFixed(10)} = ${currentValue.toFixed(6)} SOL`);
        console.log(`     ├─ 净成本: ${netCost.toFixed(6)} SOL`);
        console.log(`     ├─ 浮盈浮亏: ${currentValue.toFixed(6)} - ${netCost.toFixed(6)} = ${pnl.toFixed(6)} SOL ${pnl >= 0 ? '📈 盈利' : '📉 亏损'}`);
        console.log(`     └─ 收益率: ${netCost > 0 ? ((pnl / netCost) * 100).toFixed(2) : 'N/A'}%`);
      });
      console.log(`\n  ✅ 浮盈浮亏合计: ${floatingPnLTotal.toFixed(6)} SOL`);
      console.log(`     计算方式: Σ(当前市值 - 净成本) 对所有当前持有者求和`);
    } else {
      console.log('  (暂无持有者)');
    }

    // 5. 用户地址完整列表
    console.log('\n👥 用户地址完整列表');
    console.log('-'.repeat(80));

    console.log(`\n已退出用户 (${exitedUsers.length} 个):`);
    if (exitedUsers.length > 0) {
      exitedUsers.forEach(({ address, stats }, index) => {
        const pnl = stats.totalSellSol - stats.totalBuySol;
        console.log(`  ${index + 1}. ${address} (盈亏: ${pnl.toFixed(6)} SOL)`);
      });
    } else {
      console.log('  (无)');
    }

    console.log(`\n当前持有者 (${activeUsers.length} 个):`);
    if (activeUsers.length > 0) {
      activeUsers.forEach(({ address, stats }, index) => {
        const currentValue = stats.netTokenReceived * this.currentPrice;
        const pnl = currentValue - stats.netSolSpent;
        console.log(`  ${index + 1}. ${address} (持有: ${stats.netTokenReceived.toFixed(2)} Token, 浮盈浮亏: ${pnl.toFixed(6)} SOL)`);
      });
    } else {
      console.log('  (无)');
    }

    // 6. 总结
    console.log('\n' + '='.repeat(80));
    console.log('指标汇总');
    console.log('='.repeat(80));
    console.log(`💰 已落袋: ${yiLuDaiTotal.toFixed(6)} SOL (已退出用户的实现盈亏)`);
    console.log(`🎯 本轮下注: ${benLunXiaZhuTotal.toFixed(6)} SOL (当前持有者的买入总额)`);
    console.log(`💵 本轮成本: ${benLunChengBenTotal.toFixed(6)} SOL (当前持有者的净成本)`);
    console.log(`📈 浮盈浮亏: ${floatingPnLTotal.toFixed(6)} SOL (当前持有者的未实现盈亏)`);
    console.log(`📊 当前价格: ${this.currentPrice.toFixed(10)} SOL/Token`);
    console.log(`👥 活跃用户: ${activeUsers.length}`);
    console.log(`🚪 已退出用户: ${exitedUsers.length}`);
    console.log(`📝 已处理交易: ${this.processedCount}`);
    console.log('='.repeat(80) + '\n');
  }

  /**
   * 设置过滤后的用户列表
   * @param {Set} userSet - 过滤后的用户地址集合
   */
  setFilteredUsers(userSet) {
    this.filteredUsers = userSet;
    console.log('[MetricsEngine] 设置过滤用户列表', { count: userSet.size });
  }

  /**
   * 更新庄家地址列表
   * @param {Set} whaleSet - 庄家地址集合
   */
  updateWhaleAddresses(whaleSet) {
    this.whaleAddresses = whaleSet;
    console.log('[MetricsEngine] 更新庄家地址列表', { count: whaleSet.size });
  }
}

