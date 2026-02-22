import { describe, it, expect, vi } from 'vitest';
import ContentScoreManager from '../content/ContentScoreManager';
import tokenHolders from '../../dataweb/token_holders.json';
import tokenTrades from '../../dataweb/token_trades.json';

// Mock chrome API
global.chrome = {
    storage: {
        local: {
            get: vi.fn().mockResolvedValue({}),
            set: vi.fn().mockResolvedValue({}),
        },
        onChanged: {
            addListener: vi.fn(),
        }
    }
};

describe('Boss Logic Integration Test', () => {
    let manager;

    it('should correctly identify boss based on rules', async () => {
        manager = new ContentScoreManager();
        await manager.init();

        // 1. 设置配置：启用所有规则，设置阈值
        manager.bossConfig = {
            enable_no_source: true,
            weight_no_source: 10,
            
            enable_same_source: true,
            same_source_n: 2, // 降低阈值以便测试触发
            weight_same_source: 5,
            
            rule_gas: {
                enabled: true,
                threshold: 0.0001, // 阈值 (SOL)
                weight: 5
            },
            
            rule_amount_sim: {
                enabled: true,
                range: 10,
                count: 2,
                weight: 3
            },
            
            rule_large_holding: {
                enabled: true,
                top_pct: 100, // 宽松条件
                min_usd: 100,
                logic: 'OR',
                weight: 5
            },
            
            rule_sol_balance: {
                enabled: true,
                range: 0.01,
                count: 2,
                weight: 3
            }
        };

        // 2. 注入 Holders 数据
        // 注意：token_holders.json 的结构是 { code, data: { list: [] } }
        const holders = tokenHolders.data.list;
        console.log(`[Test] Injecting ${holders.length} holders...`);
        manager.updateHolders(holders);

        // 3. 注入 Trades 数据 (为了测试 High Gas)
        // 注意：token_trades.json 的结构是 { code, data: { history: [] } }
        // 修改一条 trade 的 gas_native 为有效值 (因为原始数据为空)
        const trades = JSON.parse(JSON.stringify(tokenTrades.data.history));
        if (trades.length > 0) {
            trades[0].gas_native = "0.00005"; // 设置 Low Gas (小于阈值 0.0001)
            console.log(`[Test] Modified trade[0] gas_native to 0.00005 SOL (Expect LowGas)`);
        }
        console.log(`[Test] Injecting ${trades.length} trades...`);
        manager.updateTrades(trades);

        // 4. 验证结果
        console.log('\n=== 庄家判定结果 ===');
        let bossCount = 0;
        
        manager.dataMap.forEach((user, address) => {
            // 重新计算分数以确保应用最新配置 (因为 updateHolders 时配置可能尚未完全生效或需要重新触发)
            // 但 updateHolders 内部已经调用了 calculateUserScore，这里我们直接检查结果
            
            // 为了更清晰的调试，我们可以手动再次调用 calculateUserScore
            // const stats = ... (这里无法轻易获取内部 stats，只能依赖 updateHolders 的结果)
            
            if (user.status === '庄家' || user.score > 0) {
                bossCount++;
                console.log(`\n用户: ${user.main_address_short || address.slice(0, 8)}`);
                console.log(`- 状态: ${user.status}`);
                console.log(`- 分数: ${user.score}`);
                console.log(`- 原因: ${user.score_reasons.join(', ')}`);
                console.log(`- 关键数据:`);
                console.log(`  * 来源: ${user.funding_account || '(无)'}`);
                console.log(`  * 余额: ${user.sol_balance} SOL`);
                console.log(`  * 总买: ${user.total_buy_u} USD`);
                console.log(`  * MaxGas: ${user.max_gas_fee} SOL`);
                console.log(`  * 持仓值: ${user.usd_value || 0} USD`);
            }
        });

        console.log(`\n=== 统计: 共发现 ${bossCount} 个庄家/高分用户 ===\n`);
        
        // 断言：至少应该检测出一个
        expect(bossCount).toBeGreaterThan(0);
        
        // 验证特定逻辑
        // 1. 检查 High Gas 是否触发 (对应 trades[0].maker)
        const gasMaker = trades[0].maker;
        const gasUser = manager.dataMap.get(gasMaker);
        if (gasUser) {
            expect(gasUser.max_gas_fee).toBe(0.00005);
            // 注意：只有当 updateHolders 再次运行时，或者 updateTrades 内部触发了重算（目前 updateTrades 不触发重算 Score），High Gas 分数才会更新
            // 当前架构设计：Score 是在 updateHolders 时计算的。Trades 更新了 max_gas_fee，但没有触发重算。
            // 这是一个潜在的逻辑点：如果 Trade 带来了 High Gas，Score 应该更新吗？
            // 现行逻辑：updateTrades 只更新数值，不更新 Score。Score 在下一次 updateHolders 时更新。
            // 为了测试，我们需要再次运行 updateHolders
            console.log('[Test] Re-running updateHolders to refresh scores with new Gas data...');
            manager.updateHolders(holders);
            
            const updatedGasUser = manager.dataMap.get(gasMaker);
            // 只有当该 Maker 也在 Holders 列表中时，分数才会更新
            // 检查 trades[0].maker 是否在 holders 中
            const isInHolders = holders.some(h => h.address === gasMaker);
            if (isInHolders) {
                expect(updatedGasUser.score_reasons.some(r => r.includes('LowGas'))).toBe(true);
                console.log('✅ Low Gas 规则验证通过');
            } else {
                console.log('⚠️ High Gas 用户不在 Holder 列表中，无法验证 Score 更新 (符合预期)');
            }
        }
    });
});
