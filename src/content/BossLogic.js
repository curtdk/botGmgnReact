/**
 * BossLogic.js
 * 负责庄家判定规则的纯函数逻辑模块
 */

export default class BossLogic {
    /**
     * 计算用户分数与庄家状态
     * @param {Object} user - 用户对象
     * @param {Object} stats - 全局统计信息 { fundingGroups, timeGroups, amountBuckets, balanceBuckets, totalHolders, timeClusteredUsers }
     * @param {Object} config - 判定配置对象 (bossConfig)
     * @returns {Object} { score, reasons }
     */
    static calculateUserScore(user, stats, config) {
        let score = 0;
        const reasons = [];

        if (!config) return { score, reasons };

        // 1. 无资金来源 (Funding Account 为空)
        if (config.enable_no_source && !user.funding_account) {
            score += (config.weight_no_source || 10);
            reasons.push('无来源(+' + (config.weight_no_source || 10) + ')');
        }

        // 2. 同源账户 (Funding Account 相同)
        if (config.enable_same_source && user.funding_account) {
            const group = stats.fundingGroups.get(user.funding_account);
            // 排除名单检查
            const excludeSet = new Set(String(config.same_source_exclude || '').split(/[,，\s]+/).filter(Boolean));
            if (group && group.length >= (config.same_source_n || 5) && !excludeSet.has(user.funding_account)) {
                score += (config.weight_same_source || 10);
                reasons.push(`同源(${group.length})(+${config.weight_same_source || 10})`);
            }
        }

        // 3. 时间聚类 (创建时间接近)
        if (config.enable_time_cluster) {
            if (stats.timeClusteredUsers && stats.timeClusteredUsers.has(user.owner)) {
                score += (config.weight_time_cluster || 10);
                reasons.push('时间聚集(+' + (config.weight_time_cluster || 10) + ')');
            }
        }

        // 4. Gas 费用异常 (需要 Trade 数据)
        // 逻辑调整：庄家通常使用脚本或私有节点，Gas 费可能极低 (Low Gas)
        if (config.rule_gas && config.rule_gas.enabled) {
            if (user.max_gas_fee > 0 && user.max_gas_fee < (config.rule_gas.threshold || 0.01)) {
                score += (config.rule_gas.weight || 10);
                reasons.push(`LowGas(${user.max_gas_fee.toFixed(6)})(+${config.rule_gas.weight || 10})`);
            }
        }

        // 5. 金额相似群组 (买入金额接近)
        if (config.rule_amount_sim && config.rule_amount_sim.enabled) {
            const range = config.rule_amount_sim.range || 100;
            const amount = parseFloat(user.total_buy_u || 0);
            if (amount > 0) {
                const bucketKey = Math.floor(amount / range);
                const count = (stats.amountBuckets.get(bucketKey) || 0) +
                              (stats.amountBuckets.get(bucketKey - 1) || 0) +
                              (stats.amountBuckets.get(bucketKey + 1) || 0);

                if (count >= (config.rule_amount_sim.count || 5)) {
                    score += (config.rule_amount_sim.weight || 10);
                    reasons.push(`金额相似(${count})(+${config.rule_amount_sim.weight || 10})`);
                }
            }
        }

        // 6. 大额持仓
        if (config.rule_large_holding && config.rule_large_holding.enabled) {
            const rule = config.rule_large_holding;
            const isTop = user.rank && user.rank <= (stats.totalHolders * (rule.top_pct / 100));
            const isLargeAmt = (user.usd_value || 0) > rule.min_usd;

            let match = false;
            if (rule.logic === 'AND') match = isTop && isLargeAmt;
            else match = isTop || isLargeAmt;

            if (match) {
                score += (rule.weight || 10);
                reasons.push('大额持仓(+' + (rule.weight || 10) + ')');
            }
        }

        // 7. SOL 余额关联
        if (config.rule_sol_balance && config.rule_sol_balance.enabled) {
            const rule = config.rule_sol_balance;
            const balance = parseFloat(user.sol_balance || 0);
            if (balance > 0) {
                const range = rule.range || 0.1;
                const bucketKey = Math.floor(balance / range);
                const count = (stats.balanceBuckets.get(bucketKey) || 0) +
                              (stats.balanceBuckets.get(bucketKey - 1) || 0) +
                              (stats.balanceBuckets.get(bucketKey + 1) || 0);

                if (count >= (rule.count || 3)) {
                    score += (rule.weight || 10);
                    reasons.push(`余额相似(${count})(+${rule.weight || 10})`);
                }
            }
        }

        // 8. 资金来源时间聚类
        if (config.rule_source_time && config.rule_source_time.enabled) {
            const clusterSet = stats.sourceTimeClusteredUsers ? stats.sourceTimeClusteredUsers.get(user.owner) : null;
            const threshold = config.rule_source_time.count || 2;

            if (clusterSet && clusterSet.size >= threshold) {
                score += (config.rule_source_time.weight || 10);

                const related = Array.from(clusterSet)
                    .filter(addr => addr !== user.owner)
                    .slice(0, 3)
                    .map(addr => addr.slice(0, 4));

                const more = clusterSet.size - 1 > 3 ? '...' : '';
                reasons.push(`同源时间(${clusterSet.size}): ${related.join(',')}${more}(+${config.rule_source_time.weight || 10})`);
            }
        }

        // 9. 无资金来源-隐藏中转
        // 条件1（快）：Funding Address 为空 → 直接成立
        // 条件2（慢）：仅当 funding_account 存在时，由 detectHiddenRelays 检测第一笔 tx 含 Create+CloseAccount 指令
        if (config.enable_hidden_relay) {
            const w = config.weight_hidden_relay || 15;
            if (!user.funding_account) {
                score += w;
                reasons.push(`无资金来源/中转(+${w})`);
            } else if (user.has_hidden_relay) {
                const condStr = user.hidden_relay_conditions ? user.hidden_relay_conditions.join('+') : '';
                score += w;
                reasons.push(`隐藏中转[${condStr}](+${w})`);
            }
        }

        return { score, reasons };
    }
}
