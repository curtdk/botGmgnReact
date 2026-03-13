/**
 * HeliusMonitor.start() 集成测试
 *
 * 测试从 start() 方法开始的完整数据流：
 *   start() → 注入 trades → performInitialCalculation() → updateHolderData() → metrics
 *
 * 数据来源（你需要提前填充）：
 *   - src/test/data/trades_data.js  ← EXECUTE_TRADES_REFRESH 接口数据
 *   - src/test/data/holders_data.js ← EXECUTE_HOLDERS_REFRESH 接口数据
 *
 * 运行：npx vitest run src/test/helius_monitor_start.test.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock chrome API ───────────────────────────────────────────────────────────
global.chrome = {
    storage: {
        local: {
            get: vi.fn().mockResolvedValue({}),
            set: vi.fn().mockResolvedValue({}),
        },
        onChanged: { addListener: vi.fn() }
    }
};

// ─── Mock dataFlowLogger（避免 chrome 依赖）────────────────────────────────────
vi.mock('../utils/Logger.js', () => ({
    default: { enabled: false, log: () => {} }
}));

// ─── Mock CacheManager ─────────────────────────────────────────────────────────
vi.mock('../helius/CacheManager.js', () => ({
    default: class MockCacheManager {
        disabled = false;
        init()                                  { return Promise.resolve(); }
        loadManualScores()                      { return Promise.resolve({}); }
        loadTransactionsBySignatures()          { return Promise.resolve([]); }
        updateSigStatus()                       { return Promise.resolve(); }
        saveUser()                              { return Promise.resolve(); }
        saveSigs()                              { return Promise.resolve(); }
        getCachedSigs()                         { return Promise.resolve([]); }
        getCachedTxs()                          { return Promise.resolve([]); }
        saveTxs()                               { return Promise.resolve(); }
    }
}));

// ─── Mock DataFetcher（禁用真实 Helius API 请求）──────────────────────────────
vi.mock('../helius/DataFetcher.js', () => ({
    default: class MockDataFetcher {
        setApiKey()                             {}
        fetchHistorySigsStreaming()             { return Promise.resolve({ totalNew: 0, totalCached: 0 }); }
        fetchParsedTxs()                        { return Promise.resolve([]); }
        fetchLatestSigsForVerify()              { return Promise.resolve([]); }
        call()                                  { return Promise.resolve([]); }
    }
}));

import HeliusMonitor from '../helius/HeliusMonitor.js';
import { tradesData } from './data/trades_data.js';
import { holdersData } from './data/holders_data.js';

// ─── 辅助：轮询等待 isInitialized ─────────────────────────────────────────────
function waitForInit(monitor, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            if (monitor.isInitialized) return resolve();
            if (Date.now() - start > timeout) return reject(new Error('等待 isInitialized 超时'));
            setTimeout(check, 50);
        };
        check();
    });
}

// ─── Test Suite ────────────────────────────────────────────────────────────────
describe('HeliusMonitor.start() 集成测试', () => {
    // ⬇ 替换为你实际测试的代币 mint 地址
    const TEST_MINT = 'QSsF56toZUnyZf6EXubnm49ZxMoyXbpa6yugBkhpump';

    let monitor;
    let metricsLog = [];
    let statusLog  = [];

    beforeEach(() => {
        metricsLog = [];
        statusLog  = [];

        monitor = new HeliusMonitor(TEST_MINT, 'test-api-key');

        monitor.onMetricsUpdate = (metrics) => {
            metricsLog.push(metrics);
        };

        monitor.onStatusLog = (msg) => {
            statusLog.push(msg);
        };

        // ★ 禁用 Helius API → _runHeliusInitTask 直接设 isInitialized=true
        monitor.heliusApiEnabled = false;
    });

    afterEach(() => {
        monitor.stop();
    });

    // ──────────────────────────────────────────────────────────────────────────
    it('从 start() 启动，注入 trades + holders，完成初始化并输出 metrics', async () => {
        const DIV = '═'.repeat(55);

        console.log(`\n╔${DIV}╗`);
        console.log(`║  HeliusMonitor.start() 集成测试`);
        console.log(`╚${DIV}╝`);
        console.log(`  mint        : ${TEST_MINT.slice(0, 16)}...`);
        console.log(`  trades 数据 : ${tradesData.length} 条`);
        console.log(`  holders 数据: ${holdersData.length} 条`);

        // ── Step 1: 启动 Monitor ────────────────────────────────────────────
        console.log('\n▶ Step 1: start()');
        await monitor.start();
        await waitForInit(monitor);
        console.log(`  ✓ isInitialized = ${monitor.isInitialized}`);
        expect(monitor.isInitialized).toBe(true);

        // ── Step 2: 注入 GMGN trades 数据 ──────────────────────────────────
        console.log(`\n▶ Step 2: 注入 trades（${tradesData.length} 条）`);
        let injected = 0;
        for (const trade of tradesData) {
            if (trade.tx_hash) {
                monitor.signatureManager.addSignature(trade.tx_hash, 'plugin', trade);
                injected++;
            }
        }
        const sigStats = monitor.signatureManager.getStats();
        console.log(`  已注入 ${injected} 条 | total=${sigStats.total} withData=${sigStats.withData}`);
        if (tradesData.length > 0) {
            expect(sigStats.total).toBeGreaterThan(0);
        }

        // ── Step 3: 历史首次计算 ────────────────────────────────────────────
        console.log('\n▶ Step 3: performInitialCalculation()');
        await monitor.performInitialCalculation();
        console.log(`  ✓ processedCount = ${monitor.metricsEngine.processedCount}`);
        console.log(`  ✓ traderStats    = ${Object.keys(monitor.metricsEngine.traderStats).length} 个地址`);

        // ── Step 4: 注入 holders + 触发评分 ────────────────────────────────
        console.log(`\n▶ Step 4: updateHolderData（${holdersData.length} 条）`);
        await monitor.updateHolderData(holdersData);
        const traderCount = Object.keys(monitor.metricsEngine.traderStats).length;
        console.log(`  ✓ traderStats = ${traderCount} 个地址`);

        // ── Step 5: 触发 metrics 推送 ───────────────────────────────────────
        monitor._fireMetricsUpdate();
        const metrics = monitor.metricsEngine.getMetrics();

        // ── 打印最终四大指标 ────────────────────────────────────────────────
        console.log(`\n╔${DIV}╗`);
        console.log('║  最终四大指标');
        console.log(`╚${DIV}╝`);
        console.log(JSON.stringify({
            本轮下注:    metrics.netBet,
            已落袋:      metrics.pocketedProfit,
            浮盈浮亏:    metrics.floatingPnl,
            本轮成本:    metrics.costBasis,
            已处理交易数: monitor.metricsEngine.processedCount,
            交易员总数:   traderCount,
            最新交易数:   metrics.recentTrades?.length ?? 0,
        }, null, 2));

        // ── 打印交易员评分 Top 10 ───────────────────────────────────────────
        console.log(`\n╔${DIV}╗`);
        console.log('║  交易员评分（按分数降序，Top 10）');
        console.log(`╚${DIV}╝`);
        const topTraders = Object.entries(metrics.traderStats || {})
            .sort((a, b) => (b[1].score || 0) - (a[1].score || 0))
            .slice(0, 10);
        if (topTraders.length === 0) {
            console.log('  （暂无数据，请检查 trades_data.js 是否已填充）');
        }
        for (const [addr, info] of topTraders) {
            console.log(
                `  ${addr.slice(0, 8)}...${addr.slice(-4)}` +
                `  score=${String(info.score ?? -1).padStart(4)}` +
                `  status=${info.status ?? '未评分'}` +
                `  buySOL=${(info.totalBuySol || 0).toFixed(4)}`
            );
        }

        // ── 打印最新交易前 5 条 ─────────────────────────────────────────────
        console.log(`\n╔${DIV}╗`);
        console.log('║  最新交易（前 5 条）');
        console.log(`╚${DIV}╝`);
        const recentTrades = metrics.recentTrades || [];
        if (recentTrades.length === 0) {
            console.log('  （暂无交易，请检查 trades_data.js 是否已填充）');
        }
        recentTrades.slice(0, 5).forEach((t, i) => {
            console.log(
                `  [${i + 1}] ${(t.action || '?').padEnd(4)}` +
                `  ${(t.address || '').slice(0, 8)}...` +
                `  sol=${(t.solAmount || 0).toFixed(4)}`
            );
        });

        // ── 基本断言 ────────────────────────────────────────────────────────
        if (tradesData.length > 0) {
            expect(monitor.metricsEngine.processedCount).toBeGreaterThan(0);
        }
        if (holdersData.length > 0) {
            expect(traderCount).toBeGreaterThan(0);
        }

        console.log('\n✅ 测试完成');
    }, 20000);
});
