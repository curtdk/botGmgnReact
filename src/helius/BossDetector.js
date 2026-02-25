/**
 * BossDetector - 庄家检测器
 * 移植自 BossLogic.js,适配 HeliusMonitor 的数据结构
 */
export default class BossDetector {
  /**
   * 执行庄家检测
   * @param {Object} userInfo - 用户信息对象 { [address]: { owner, funding_account, first_buy_time, ... } }
   * @param {Object} traderStats - 交易统计 { [address]: { totalBuySol, totalSellSol, ... } }
   * @param {Object} config - 检测配置
   * @param {Object} existingStatusMap - 已有的手动分类 { [address]: "庄家"|"散户" }
   * @returns {Object} - { statusMap: { [address]: "庄家"|"散户" }, detectedBosses: Set }
   */
  static detectWhales(userInfo, traderStats, config, existingStatusMap = {}) {
    const statusMap = { ...existingStatusMap };
    const detectedBosses = new Set();

    // 策略 1: 无资金来源
    if (config.enable_no_source) {
      Object.entries(userInfo).forEach(([address, info]) => {
        const manualStatus = existingStatusMap[address];
        if (manualStatus === '散户') return;  // 手动标记为散户,跳过

        if (!info.funding_account) {
          detectedBosses.add(address);
          statusMap[address] = '庄家';
        }
      });
    }

    // 策略 2: 同源账户聚类
    if (config.enable_same_source) {
      const fundingGroups = new Map();

      // 按资金来源分组
      Object.entries(userInfo).forEach(([address, info]) => {
        const src = info.funding_account;
        if (!src) return;

        if (!fundingGroups.has(src)) {
          fundingGroups.set(src, []);
        }
        fundingGroups.get(src).push(address);
      });

      // 检测同源聚类
      const threshold = config.same_source_n || 5;
      const excludeSet = new Set((config.same_source_exclude || '').split(',').map(s => s.trim()).filter(Boolean));

      for (const [src, group] of fundingGroups) {
        if (excludeSet.has(src)) continue;
        if (group.length >= threshold) {
          group.forEach(addr => {
            const manualStatus = existingStatusMap[addr];
            if (manualStatus !== '散户') {
              detectedBosses.add(addr);
              statusMap[addr] = '庄家';
            }
          });
        }
      }
    }

    // 策略 3: 时间聚类
    if (config.enable_time_cluster) {
      const timeGroups = [];

      Object.entries(userInfo).forEach(([address, info]) => {
        if (info.first_buy_time) {
          timeGroups.push({
            owner: address,
            time: info.first_buy_time
          });
        }
      });

      timeGroups.sort((a, b) => a.time - b.time);

      const threshold = config.time_cluster_n || 5;
      const windowSec = config.time_cluster_j || 1;

      for (let i = 0; i <= timeGroups.length - threshold; i++) {
        const startItem = timeGroups[i];
        const endItem = timeGroups[i + threshold - 1];

        if (endItem.time - startItem.time <= windowSec) {
          for (let k = i; k < i + threshold; k++) {
            const addr = timeGroups[k].owner;
            const manualStatus = existingStatusMap[addr];
            if (manualStatus !== '散户') {
              detectedBosses.add(addr);
              statusMap[addr] = '庄家';
            }
          }
        }
      }
    }

    // 策略 4: 无资金来源-隐藏中转
    if (config.enable_hidden_relay) {
      Object.entries(userInfo).forEach(([address, info]) => {
        const manualStatus = existingStatusMap[address];
        if (manualStatus === '散户') return;
        if (info.has_hidden_relay === true) {
          detectedBosses.add(address);
          statusMap[address] = '庄家';
        }
      });
    }

    // 默认未检测到的标记为散户
    Object.keys(userInfo).forEach(address => {
      if (!statusMap[address]) {
        statusMap[address] = '散户';
      }
    });

    return { statusMap, detectedBosses };
  }
}
