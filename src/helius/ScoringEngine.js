/**
 * ScoringEngine.js
 * 评分引擎 - 负责计算用户的庄家倾向分数
 *
 * 核心职责：
 *   1. 收集全量用户的统计数据（资金来源分组、时间聚类、金额分桶等）
 *   2. 调用 BossLogic.calculateUserScore 为每个用户打分（0~N 分）
 *   3. 基于分数和慢速检测结果，输出三态状态：
 *      - '庄家'：分数 >= 阈值（立即确认，无需等待慢速检测）
 *      - '普通'：分数 < 阈值，且仍需等待链上隐藏中转检测（has_hidden_relay 未知）
 *      - '散户'：分数 < 阈值，且已确认（无资金来源/已检测完毕/手动标记/未开启慢检）
 *
 * 与 detectHiddenRelays 的协作关系：
 *   - calculateScores 是纯同步计算，可随时调用
 *   - detectHiddenRelays 是异步链上检测，完成后将 has_hidden_relay 写入 traderStats
 *   - 每次 detectHiddenRelays 完成一个用户，立即调用 calculateScores 重新打分
 *   - calculateScores 根据 has_hidden_relay 的存在与否自动区分"已确认"和"待确认"用户
 */

import BossLogic from '../content/BossLogic.js';

export default class ScoringEngine {
  /**
   * 计算所有用户的分数和状态
   *
   * 调用时机：
   *   - 快速评分（Step3.5、updateHolderData、_scheduleQuickScore）：基础打分，无 has_hidden_relay 数据
   *   - 慢速评分（detectHiddenRelays 每用户完成后 + _scheduleSlowScore 末尾全量）：含检测结果打分
   *
   * 输出三态逻辑（详见 needsSlowConfirm 注释）：
   *   '庄家' > '普通' > '散户'
   *
   * @param {Object} userInfo - 用户信息对象 {address: userObj}，userObj 含 has_hidden_relay 等字段
   * @param {Object} traderStats - 交易统计（与 userInfo 相同对象，保留参数兼容性）
   * @param {Object} config - 评分配置，含 enable_hidden_relay、各规则权重等
   * @param {Object} manualScores - 手动标记 {address: '庄家'|'散户'}，手动标记优先级最高
   * @param {number} statusThreshold - 庄家阈值（分数 >= 此值判定为庄家）
   * @returns {{ scoreMap: Map, whaleAddresses: Set, statistics: Object }}
   */
  calculateScores(userInfo, traderStats, config, manualScores = {}, statusThreshold = 50) {

    // 阶段 1: 收集统计数据
    const stats = this.collectStatistics(userInfo, config);

    // 调试：显示第一个用户的信息
    const firstUser = Object.entries(userInfo)[0];
    if (firstUser) {
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
      const { score, reasons } = BossLogic.calculateUserScore(
        user, stats, config
      );

      // 手动标记加 10 分
      let finalScore = score;
      if (manualScores[address] === '庄家') {
        finalScore += 10;
        reasons.push('手动标记(+10)');
      }

      // ── 三态状态判断 ──────────────────────────────────────────────
      // 庄家：分数达到阈值
      // 普通：分数未达阈值，且仍在等待链上隐藏中转检测结果
      // 散户：分数未达阈值，且已确认（不需要检测 / 已检测完毕 / 手动标记）
      //
      // needsSlowConfirm（需要等待慢速检测）的完整条件：
      //   1. 未达庄家阈值
      //   2. 开启了隐藏中转检测（enable_hidden_relay = true）
      //   3. 非手动标记用户（手动标记直接确认，不需等链上）
      //   4. 非"已确认无资金来源"：confirmedNoFunding = has_holder_snapshot && !funding_account
      //      → 已确认无来源时，BossLogic 规则9条件1已直接成立（无需链上验证）
      //      → has_holder_snapshot=false 时，funding_account 为空只是"未获取"，不能跳过链上检测
      //   5. 链上检测尚未完成（has_hidden_relay === undefined）
      //      → 已检测完毕（true/false）的用户可以立即出结果，不再等待
      const isWhale = finalScore >= statusThreshold;
      // 已确认无资金来源：holder 数据已加载 且 funding_account 为空
      const confirmedNoFunding = !!user.has_holder_snapshot && !user.funding_account;
      const needsSlowConfirm = !isWhale
        && !!config.enable_hidden_relay
        && !manualScores[address]
        && !confirmedNoFunding             // 已确认无来源不需等待（规则9条件1已直接成立）
        && user.has_hidden_relay === undefined; // 未检测过才需等待
      const status = isWhale ? '庄家' : (needsSlowConfirm ? '普通' : '散户');

      scoreMap.set(address, {
        score: finalScore,
        reasons,
        isWhale,
        status
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
        detailCount++;
      }
    }

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
    if (config.enable_hidden_relay) enabled.push('无资金来源/隐藏中转');
    return enabled;
  }
}
