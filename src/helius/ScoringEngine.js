/**
 * ScoringEngine.js
 * 评分引擎 - 负责计算用户的庄家倾向分数
 * 复用 BossLogic.js 的 8 个评分规则
 */

import BossLogic from '../content/BossLogic.js';
import dataFlowLogger from '../utils/Logger.js';

export default class ScoringEngine {
  /**
   * 计算所有用户的分数
   * @param {Object} userInfo - 用户信息对象 {address: userObj}
   * @param {Object} traderStats - 交易统计（暂未使用）
   * @param {Object} config - 评分配置
   * @param {Object} manualScores - 手动标记 {address: '庄家'|'散户'}
   * @param {number} statusThreshold - 状态判断阈值（>=阈值为庄家）
   * @returns {{ scoreMap: Map, whaleAddresses: Set, statistics: Object }}
   */
  calculateScores(userInfo, traderStats, config, manualScores = {}, statusThreshold = 50) {
    console.log('[ScoringEngine] 开始计算分数', {
      userCount: Object.keys(userInfo).length,
      manualScoreCount: Object.keys(manualScores).length,
      statusThreshold,
      configKeys: Object.keys(config).length,
      enableNoSource: config.enable_no_source,
      weightNoSource: config.weight_no_source
    });

    dataFlowLogger.log(
      'ScoringEngine',
      '开始计算分数',
      `用户数: ${Object.keys(userInfo).length}, 配置键数: ${Object.keys(config).length}`,
      {
        userCount: Object.keys(userInfo).length,
        configKeys: Object.keys(config).length,
        enabledRules: this.getEnabledRules(config)
      }
    );

    // 阶段 1: 收集统计数据
    const stats = this.collectStatistics(userInfo, config);

    // 调试：显示第一个用户的信息
    const firstUser = Object.entries(userInfo)[0];
    if (firstUser) {
      console.log('[ScoringEngine] 第一个用户示例:', {
        address: firstUser[0].substring(0, 8) + '...',
        hasFundingAccount: !!firstUser[1].funding_account,
        fundingAccount: firstUser[1].funding_account ? firstUser[1].funding_account.substring(0, 8) + '...' : 'null',
        owner: firstUser[1].owner ? firstUser[1].owner.substring(0, 8) + '...' : 'null'
      });
    }

    // 阶段 2: 计算每个用户的分数
    const scoreMap = new Map();
    const whaleAddresses = new Set();
    const scoreDistribution = { 0: 0, 10: 0, 20: 0, 30: 0, 40: 0, 50: 0, 60: 0, 70: 0, 80: 0 };

    // 详细日志：显示前3个用户的评分详情
    let detailCount = 0;
    const maxDetailLog = 3;

    for (const [address, user] of Object.entries(userInfo)) {
      // 基础分数（来自 BossLogic 规则）
      const { score, isBoss, reasons } = BossLogic.calculateUserScore(
        user, stats, config
      );

      // 手动标记加 10 分
      let finalScore = score;
      if (manualScores[address] === '庄家') {
        finalScore += 10;
        reasons.push('手动标记(+10)');
      }

      // 基于分数阈值判断状态
      const isWhale = finalScore >= statusThreshold;

      scoreMap.set(address, {
        score: finalScore,
        reasons,
        isWhale,
        status: isWhale ? '庄家' : '散户'
      });

      if (isWhale) {
        whaleAddresses.add(address);
      }

      // 统计分数分布
      const bucket = Math.floor(finalScore / 10) * 10;
      if (scoreDistribution[bucket] !== undefined) {
        scoreDistribution[bucket]++;
      }

      // 详细日志：显示前几个用户的评分详情
      if (detailCount < maxDetailLog) {
        console.log(`[ScoringEngine] 用户评分详情 [${detailCount + 1}/${maxDetailLog}]:`, {
          address: address.substring(0, 8) + '...',
          score: finalScore,
          reasons: reasons,
          status: isWhale ? '庄家' : '散户',
          hasManualMark: manualScores[address] === '庄家'
        });
        detailCount++;
      }
    }

    const avgScore = Array.from(scoreMap.values()).reduce((sum, s) => sum + s.score, 0) / scoreMap.size;

    // 详细日志：显示所有用户的分数
    const allUserScores = Array.from(scoreMap.entries()).map(([address, data]) => ({
      address: address.substring(0, 8) + '...',
      score: data.score,
      status: data.status,
      reasons: data.reasons.join(', ')
    }));

    console.log('[ScoringEngine] 所有用户分数详情:', allUserScores);

    console.log('[ScoringEngine] 分数计算完成', {
      totalUsers: scoreMap.size,
      whaleCount: whaleAddresses.size,
      retailCount: scoreMap.size - whaleAddresses.size,
      avgScore: avgScore.toFixed(2),
      scoreDistribution: scoreDistribution
    });

    dataFlowLogger.log(
      'ScoringEngine',
      '分数计算完成',
      `总用户: ${scoreMap.size}, 庄家: ${whaleAddresses.size}, 散户: ${scoreMap.size - whaleAddresses.size}`,
      {
        totalUsers: scoreMap.size,
        whaleCount: whaleAddresses.size,
        retailCount: scoreMap.size - whaleAddresses.size,
        avgScore: avgScore.toFixed(2),
        scoreDistribution,
        allUserScores: allUserScores
      }
    );

    return { scoreMap, whaleAddresses, statistics: stats };
  }

  /**
   * 收集统计数据（同 ContentScoreManager.updateHolders Pass 1）
   * @param {Object} userInfo - 用户信息对象
   * @param {Object} config - 评分配置
   * @returns {Object} 统计数据
   */
  collectStatistics(userInfo, config) {
    const stats = {
      fundingGroups: new Map(), // from -> [owner]
      timeGroups: [],           // { time, owner }
      sourceTimeGroups: [],     // { time, owner, from }
      amountBuckets: new Map(), // bucketKey -> count
      balanceBuckets: new Map(), // bucketKey -> count
      totalHolders: Object.keys(userInfo).length,
      timeClusteredUsers: new Set(),
      sourceTimeClusteredUsers: new Map() // Owner -> Set<RelatedOwner>
    };

    const amountRange = config.rule_amount_sim?.range || 100;
    const balanceRange = config.rule_sol_balance?.range || 0.1;

    // 遍历所有用户收集统计数据
    Object.entries(userInfo).forEach(([address, user]) => {
      // 资金来源分组
      const fundingAccount = user.funding_account || '';
      if (fundingAccount) {
        if (!stats.fundingGroups.has(fundingAccount)) {
          stats.fundingGroups.set(fundingAccount, []);
        }
        stats.fundingGroups.get(fundingAccount).push(address);
      }

      // 资金来源时间收集
      if (user.native_transfer && user.native_transfer.timestamp) {
        stats.sourceTimeGroups.push({
          time: user.native_transfer.timestamp,
          owner: address,
          from: fundingAccount
        });
      }

      // 时间分组
      const ts = user.created_at || user.open_timestamp || 0;
      if (ts > 0) {
        stats.timeGroups.push({ time: ts, owner: address });
      }

      // 金额分桶
      const buyU = parseFloat(user.total_buy_u || 0);
      if (buyU > 0) {
        const key = Math.floor(buyU / amountRange);
        stats.amountBuckets.set(key, (stats.amountBuckets.get(key) || 0) + 1);
      }

      // 余额分桶
      const balance = parseFloat(user.sol_balance || 0);
      if (balance > 0) {
        const key = Math.floor(balance / balanceRange);
        stats.balanceBuckets.set(key, (stats.balanceBuckets.get(key) || 0) + 1);
      }
    });

    // 计算时间聚类
    if (config.enable_time_cluster || config.weight_time_cluster > 0) {
      stats.timeGroups.sort((a, b) => a.time - b.time);
      const threshold = config.time_cluster_n || 5;
      const windowSec = config.time_cluster_j || 1;

      for (let i = 0; i <= stats.timeGroups.length - threshold; i++) {
        const startItem = stats.timeGroups[i];
        const endItem = stats.timeGroups[i + threshold - 1];
        if (endItem.time - startItem.time <= windowSec) {
          for (let k = i; k < i + threshold; k++) {
            stats.timeClusteredUsers.add(stats.timeGroups[k].owner);
          }
        }
      }
    }

    // 计算资金来源时间聚类
    if (config.rule_source_time && (config.rule_source_time.enabled || config.rule_source_time.weight > 0)) {
      stats.sourceTimeGroups.sort((a, b) => a.time - b.time);
      const windowSec = config.rule_source_time.diff_sec || 10;
      const len = stats.sourceTimeGroups.length;

      for (let i = 0; i < len; i++) {
        const current = stats.sourceTimeGroups[i];
        for (let j = i + 1; j < len; j++) {
          const next = stats.sourceTimeGroups[j];
          if (next.time - current.time <= windowSec) {
            if (!stats.sourceTimeClusteredUsers.has(current.owner)) {
              stats.sourceTimeClusteredUsers.set(current.owner, new Set());
            }
            if (!stats.sourceTimeClusteredUsers.has(next.owner)) {
              stats.sourceTimeClusteredUsers.set(next.owner, new Set());
            }

            const setA = stats.sourceTimeClusteredUsers.get(current.owner);
            const setB = stats.sourceTimeClusteredUsers.get(next.owner);

            setA.add(next.owner);
            setB.add(current.owner);
            setA.add(current.owner);
            setB.add(next.owner);
          } else {
            break;
          }
        }
      }
    }

    console.log('[ScoringEngine] 统计数据收集完成', {
      fundingGroups: stats.fundingGroups.size,
      timeClusteredUsers: stats.timeClusteredUsers.size,
      sourceTimeClusteredUsers: stats.sourceTimeClusteredUsers.size
    });

    return stats;
  }

  /**
   * 获取启用的规则列表
   */
  getEnabledRules(config) {
    const enabled = [];
    if (config.enable_no_source) enabled.push('无资金来源');
    if (config.enable_same_source) enabled.push('同源账户');
    if (config.enable_time_cluster) enabled.push('时间聚类');
    if (config.rule_gas?.enabled) enabled.push('Gas异常');
    if (config.rule_amount_sim?.enabled) enabled.push('金额相似');
    if (config.rule_large_holding?.enabled) enabled.push('大额持仓');
    if (config.rule_sol_balance?.enabled) enabled.push('SOL余额');
    if (config.rule_source_time?.enabled) enabled.push('同源时间');
    return enabled;
  }
}
