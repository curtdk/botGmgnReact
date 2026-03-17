/**
 * MetricsEngine v3（均价法）集成测试
 *
 * 使用 dataweb/控制台日志.html 的真实 GMGN 交易数据验证 3大参数计算。
 *
 * 运行方法：
 *   npx vitest run src/test/metrics_engine_new.test.js
 *   或静默模式（只看汇总）：
 *   npx vitest run src/test/metrics_engine_new.test.js 2>&1 | grep -A 100 "═══"
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ─── Mock dataFlowLogger（避免 chrome 依赖）────────────────────────────────────
import { vi } from 'vitest';
vi.mock('../utils/Logger.js', () => ({
  default: { enabled: false, log: () => {} }
}));

import MetricsEngine from '../helius/MetricsEngine.js';

// ─── 读取测试数据 ─────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
let rawData = readFileSync(resolve(__dirname, '../../dataweb/控制台日志.html'), 'utf-8').trim();
// 文件可能未以 ] 结尾，补全合法 JSON
if (!rawData.endsWith(']')) rawData += ']';
const ALL_TRADES = JSON.parse(rawData);

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 短地址 */
const short = (addr) => `${addr.slice(0, 6)}..${addr.slice(-4)}`;

/** 格式化 SOL */
const fmtSOL = (v) => {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(8)} SOL`;
};

/** 格式化 Token */
const fmtToken = (v) => Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

// ─── 测试套件 ─────────────────────────────────────────────────────────────────

describe('MetricsEngine v3 均价法 - 3大参数计算', () => {

  it('使用真实 GMGN 数据，逐笔打印计算过程并验证 3大参数', () => {

    // 1. 按时间戳升序排列（从旧到新）
    const trades = [...ALL_TRADES].sort((a, b) => a.timestamp - b.timestamp);

    console.log(
      `\n${'═'.repeat(70)}\n` +
      `  MetricsEngine v3（均价法）测试\n` +
      `  共 ${trades.length} 笔交易，时间跨度: ` +
      `${new Date(trades[0].timestamp * 1000).toLocaleString('zh-CN')} → ` +
      `${new Date(trades[trades.length - 1].timestamp * 1000).toLocaleString('zh-CN')}\n` +
      `${'═'.repeat(70)}\n` +
      `  算法说明（均价法）:\n` +
      `  ┌─ 买入: holdingCost += buyAmount  holdingQty += buyQty\n` +
      `  │        avgPrice = holdingCost / holdingQty\n` +
      `  ├─ 卖出: sellPrincipal = sellQty × avgPrice\n` +
      `  │        holdingCost -= sellPrincipal  holdingQty -= sellQty\n` +
      `  │        avgPrice = holdingQty > 0 ? holdingCost / holdingQty : 0\n` +
      `  └─ 3大参数:\n` +
      `       本轮下注  = Σ holdingCost（持仓用户）\n` +
      `       已落袋    = Σ(sellAmount - sellPrincipal)（所有用户）\n` +
      `       本轮成本  = 本轮下注 - 已落袋\n` +
      `${'═'.repeat(70)}`
    );

    // 2. 初始化引擎
    const engine = new MetricsEngine();

    // 3. 关闭引擎内部的每笔日志（测试里手动打印更清晰）
    //    通过覆盖 console.log 来静默引擎内部日志
    const origLog = console.log;
    console.log = () => {};  // 静默引擎内部日志

    // 4. 逐笔处理并收集中间状态
    const stepRecords = [];

    for (const trade of trades) {
      const maker = trade.maker;
      const event = trade.event;
      const quoteAmount = parseFloat(trade.quote_amount);
      const baseAmount = parseFloat(trade.base_amount);

      // 处理前快照
      const before = engine.traderStats[maker]
        ? { ...engine.traderStats[maker] }
        : null;

      // 注入交易
      engine.processTransaction({ type: 'gmgn', data: trade }, trade.token_address);

      // 处理后快照
      const after = engine.traderStats[maker];
      if (!after) continue;

      const buyPrice = event === 'buy'
        ? quoteAmount / baseAmount
        : null;
      const sellPrincipal = event === 'sell' && before
        ? baseAmount * before.avgPrice
        : null;
      const realizedProfit = event === 'sell' && sellPrincipal !== null
        ? quoteAmount - sellPrincipal
        : null;

      stepRecords.push({
        trade,
        before,
        after: { ...after },
        buyPrice,
        sellPrincipal,
        realizedProfit,
      });
    }

    // 恢复 console.log
    console.log = origLog;

    // 5. 按用户分组打印明细
    const userGroups = {};
    for (const rec of stepRecords) {
      const addr = rec.trade.maker;
      if (!userGroups[addr]) userGroups[addr] = [];
      userGroups[addr].push(rec);
    }

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`  【逐用户交易明细】（共 ${Object.keys(userGroups).length} 个用户）`);
    console.log(`${'─'.repeat(70)}`);

    for (const [addr, recs] of Object.entries(userGroups)) {
      const s = short(addr);
      console.log(`\n  ┌─ 用户: ${s}  (${addr})`);
      console.log(`  │  共 ${recs.length} 笔交易`);

      for (let i = 0; i < recs.length; i++) {
        const { trade, before, after, buyPrice, sellPrincipal, realizedProfit } = recs[i];
        const isFirst = i === 0;
        const prefix = i < recs.length - 1 ? '  ├─' : '  └─';

        if (trade.event === 'buy') {
          const buyAmount = parseFloat(trade.quote_amount);
          const buyQty = parseFloat(trade.base_amount);
          const prevCost = before?.holdingCost ?? 0;
          const prevQty = before?.holdingQty ?? 0;
          const newCost = after.holdingCost;
          const newQty = after.holdingQty;
          const newAvg = after.avgPrice;

          console.log(
            `${prefix} [${i + 1}] 买入 | ${new Date(trade.timestamp * 1000).toLocaleString('zh-CN')}\n` +
            `  │     数量: ${fmtToken(buyQty)} Token  金额: ${buyAmount.toFixed(8)} SOL\n` +
            `  │     买入价: ${buyPrice.toFixed(12)} SOL/T\n` +
            `  │     持仓成本: ${prevCost.toFixed(8)} → ${newCost.toFixed(8)} SOL  (+${buyAmount.toFixed(8)})\n` +
            `  │     持仓量:  ${prevQty.toFixed(0)} → ${newQty.toFixed(0)} T\n` +
            `  │     均价:   ${isFirst ? '(首笔)' : before.avgPrice.toFixed(12)} → ${newAvg.toFixed(12)} SOL/T`
          );
        } else if (trade.event === 'sell') {
          const sellAmount = parseFloat(trade.quote_amount);
          const sellQty = parseFloat(trade.base_amount);
          const prevAvg = before?.avgPrice ?? 0;
          const prevCost = before?.holdingCost ?? 0;
          const prevQty = before?.holdingQty ?? 0;
          const sp = sellPrincipal ?? 0;
          const rp = realizedProfit ?? 0;
          const newCost = after.holdingCost;
          const newQty = after.holdingQty;

          console.log(
            `${prefix} [${i + 1}] 卖出 | ${new Date(trade.timestamp * 1000).toLocaleString('zh-CN')}\n` +
            `  │     数量: ${fmtToken(sellQty)} Token  金额: ${sellAmount.toFixed(8)} SOL\n` +
            `  │     当时均价: ${prevAvg.toFixed(12)} SOL/T\n` +
            `  │     卖出本金: ${fmtToken(sellQty)} × ${prevAvg.toFixed(12)} = ${sp.toFixed(8)} SOL\n` +
            `  │     卖出金额: ${sellAmount.toFixed(8)} SOL\n` +
            `  │     已落袋利润: ${sellAmount.toFixed(8)} - ${sp.toFixed(8)} = ${fmtSOL(rp)}\n` +
            `  │     持仓成本: ${prevCost.toFixed(8)} - ${sp.toFixed(8)} = ${newCost.toFixed(8)} SOL\n` +
            `  │     持仓量:  ${prevQty.toFixed(0)} - ${fmtToken(sellQty)} = ${newQty.toFixed(0)} T\n` +
            `  │     均价:   ${newQty > 0 ? after.avgPrice.toFixed(12) : '0 (已清仓)'} SOL/T`
          );
        }
      }

      // 用户最终状态
      const finalStats = engine.traderStats[addr];
      const userProfit = finalStats.totalSellAmount - finalStats.totalSellPrincipal;
      console.log(
        `  │\n  │  ── 用户最终状态 ──\n` +
        `  │  totalBuyAmount     = ${finalStats.totalBuyAmount.toFixed(8)} SOL\n` +
        `  │  totalSellAmount    = ${finalStats.totalSellAmount.toFixed(8)} SOL\n` +
        `  │  totalSellPrincipal = ${finalStats.totalSellPrincipal.toFixed(8)} SOL\n` +
        `  │  holdingCost        = ${finalStats.holdingCost.toFixed(8)} SOL  ← 贡献到本轮下注\n` +
        `  │  holdingQty         = ${finalStats.holdingQty.toFixed(0)} T\n` +
        `  │  avgPrice           = ${finalStats.avgPrice.toFixed(12)} SOL/T\n` +
        `  │  已落袋利润贡献      = ${fmtSOL(userProfit)}`
      );
    }

    // 6. 全局 3大参数 计算明细
    const metrics = engine.getMetrics();

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  【3大参数 完整计算明细】`);
    console.log(`${'═'.repeat(70)}`);

    // 本轮下注明细
    console.log(`\n  ① 本轮下注 = Σ holdingCost（持仓用户）`);
    let sumXiaZhu = 0;
    const xiaZhuTerms = [];
    for (const [addr, stats] of Object.entries(engine.traderStats)) {
      if (stats.holdingQty > 0) {
        sumXiaZhu += stats.holdingCost;
        xiaZhuTerms.push(`${short(addr)}: ${stats.holdingCost.toFixed(6)} SOL (均价=${stats.avgPrice.toFixed(10)}, qty=${stats.holdingQty.toFixed(0)})`);
      }
    }
    if (xiaZhuTerms.length === 0) {
      console.log(`     (无持仓用户) = 0`);
    } else {
      xiaZhuTerms.forEach(l => console.log(`     + ${l}`));
      console.log(`     ────────────────────`);
      console.log(`     本轮下注 = ${xiaZhuTerms.map(l => parseFloat(l.split(': ')[1])).join(' + ')} = ${sumXiaZhu.toFixed(8)} SOL`);
    }

    // 已落袋明细
    console.log(`\n  ② 已落袋利润 = Σ(卖出金额 - 卖出本金)`);
    let sumYiLuDai = 0;
    const yiLuDaiTerms = [];
    for (const [addr, stats] of Object.entries(engine.traderStats)) {
      if (stats.totalSellAmount > 0) {
        const profit = stats.totalSellAmount - stats.totalSellPrincipal;
        sumYiLuDai += profit;
        yiLuDaiTerms.push(
          `${short(addr)}: ${stats.totalSellAmount.toFixed(6)} - ${stats.totalSellPrincipal.toFixed(6)} = ${fmtSOL(profit)}`
        );
      }
    }
    if (yiLuDaiTerms.length === 0) {
      console.log(`     (无卖出记录) = 0`);
    } else {
      yiLuDaiTerms.forEach(l => console.log(`     ${l}`));
      console.log(`     ────────────────────`);
      console.log(`     已落袋利润 = ${sumYiLuDai.toFixed(8)} SOL`);
    }

    // 本轮成本
    const chengBen = sumXiaZhu - sumYiLuDai;
    console.log(`\n  ③ 本轮成本 = 本轮下注 - 已落袋利润`);
    console.log(`     = ${sumXiaZhu.toFixed(8)} - (${sumYiLuDai.toFixed(8)})`);
    console.log(`     = ${chengBen.toFixed(8)} SOL`);

    // 汇总
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  【3大参数 最终结果】`);
    console.log(`  ┌───────────────────────────────────────────┐`);
    console.log(`  │  本轮下注   = ${sumXiaZhu.toFixed(8).padStart(20)} SOL  │`);
    console.log(`  │  已落袋利润 = ${sumYiLuDai.toFixed(8).padStart(20)} SOL  │`);
    console.log(`  │  本轮成本   = ${chengBen.toFixed(8).padStart(20)} SOL  │`);
    console.log(`  └───────────────────────────────────────────┘`);
    console.log(`${'═'.repeat(70)}\n`);

    // 7. 断言：getMetrics() 结果与手动计算一致
    expect(Math.abs(metrics.benLunXiaZhu - sumXiaZhu)).toBeLessThan(1e-6);
    expect(Math.abs(metrics.yiLuDai - sumYiLuDai)).toBeLessThan(1e-6);
    expect(Math.abs(metrics.benLunChengBen - chengBen)).toBeLessThan(1e-6);

    // 8. 基本合理性验证
    const validTradeCount = trades.filter(t => t.event === 'buy' || t.event === 'sell').length;
    expect(metrics.benLunXiaZhu).toBeGreaterThanOrEqual(0);      // 持仓成本不应为负
    expect(metrics.totalProcessed).toBe(validTradeCount);         // buy/sell 交易都被处理
  });


  it('手工案例验证：买100 → 卖50 → 买80 → 全卖', () => {
    /**
     * 手工推导（以 SOL 为单位，1 Token = 简化价格）：
     *
     * 用户 Alice:
     *   买1: 100 Token @ 0.01 SOL/T → buyAmount=1.00 SOL
     *        holdingCost=1.00  holdingQty=100  avgPrice=0.01
     *
     *   卖1: 50 Token @ 0.015 SOL/T → sellAmount=0.75 SOL
     *        sellPrincipal = 50 × 0.01 = 0.50 SOL
     *        holdingCost = 1.00 - 0.50 = 0.50 SOL
     *        holdingQty  = 50
     *        avgPrice    = 0.50 / 50 = 0.01 (不变)
     *        realizedProfit = 0.75 - 0.50 = +0.25 SOL
     *
     *   买2: 80 Token @ 0.02 SOL/T → buyAmount=1.60 SOL
     *        holdingCost = 0.50 + 1.60 = 2.10 SOL
     *        holdingQty  = 50 + 80 = 130
     *        avgPrice    = 2.10 / 130 ≈ 0.016154 SOL/T
     *
     *   卖2: 130 Token @ 0.025 SOL/T → sellAmount=3.25 SOL
     *        sellPrincipal = 130 × 0.016154 = 2.10 SOL
     *        holdingCost = 2.10 - 2.10 = 0 SOL
     *        holdingQty  = 0
     *        realizedProfit = 3.25 - 2.10 = +1.15 SOL
     *
     * 3大参数：
     *   本轮下注  = holdingCost = 0  (全部清仓)
     *   已落袋利润 = 0.25 + 1.15 = +1.40 SOL
     *   本轮成本  = 0 - 1.40 = -1.40 SOL
     */

    vi.mock('../utils/Logger.js', () => ({
      default: { enabled: false, log: () => {} }
    }));

    const engine = new MetricsEngine();
    const ALICE = 'Alice111111111111111111111111111111111111111';
    const MINT  = 'MINT_ADDRESS';

    const mkGmgn = (event, baseAmount, quoteAmount, ts) => ({
      type: 'gmgn',
      data: {
        maker: ALICE,
        event,
        base_amount: String(baseAmount),
        quote_amount: String(quoteAmount),
        tx_hash: `sig_${ts}`,
        timestamp: ts,
        token_address: MINT,
      }
    });

    // 静默引擎日志
    const origLog = console.log;
    console.log = () => {};

    engine.processTransaction(mkGmgn('buy',  100, 1.00, 1000), MINT);
    engine.processTransaction(mkGmgn('sell',  50, 0.75, 2000), MINT);
    engine.processTransaction(mkGmgn('buy',   80, 1.60, 3000), MINT);
    engine.processTransaction(mkGmgn('sell', 130, 3.25, 4000), MINT);

    console.log = origLog;

    const s = engine.traderStats[ALICE];
    const metrics = engine.getMetrics();

    console.log('\n  【手工案例验证】');
    console.log(`  买1:  100T @0.01  → holdingCost=1.0000  avgPrice=0.0100`);
    console.log(`  卖1:   50T @0.015 → sellPrincipal=0.5000  holdingCost=0.5000  利润=+0.2500`);
    console.log(`  买2:   80T @0.020 → holdingCost=2.1000  avgPrice=${(2.1/130).toFixed(6)}`);
    console.log(`  卖2:  130T @0.025 → sellPrincipal=2.1000  holdingCost=0.0000  利润=+1.1500`);
    console.log(`  本轮下注  = ${metrics.benLunXiaZhu.toFixed(6)} SOL  (期望 ≈ 0)`);
    console.log(`  已落袋    = ${metrics.yiLuDai.toFixed(6)} SOL  (期望 ≈ +1.40)`);
    console.log(`  本轮成本  = ${metrics.benLunChengBen.toFixed(6)} SOL  (期望 ≈ -1.40)`);

    expect(s.totalBuyAmount).toBeCloseTo(2.60, 8);
    expect(s.totalSellAmount).toBeCloseTo(4.00, 8);
    expect(s.totalSellPrincipal).toBeCloseTo(2.60, 6);  // 0.50 + 2.10
    expect(s.holdingQty).toBeCloseTo(0, 1);
    expect(s.holdingCost).toBeCloseTo(0, 6);

    expect(metrics.benLunXiaZhu).toBeCloseTo(0, 6);
    expect(metrics.yiLuDai).toBeCloseTo(1.40, 4);
    expect(metrics.benLunChengBen).toBeCloseTo(-1.40, 4);
  });


  it('手工案例2：两用户混合，验证聚合', () => {
    /**
     * Alice: 买100T @0.01 → 持仓中，holdingCost = 1.0 SOL
     * Bob:   买200T @0.02 → 卖100T @0.03 → 持仓中
     *   Bob 卖: sellPrincipal = 100×0.02 = 2.0, profit = 3.0 - 2.0 = +1.0
     *   Bob holdingCost = 200×0.02 - 2.0 = 2.0 SOL
     *
     * 3大参数：
     *   本轮下注  = Alice.holdingCost + Bob.holdingCost = 1.0 + 2.0 = 3.0 SOL
     *   已落袋    = Bob的利润 = +1.0 SOL
     *   本轮成本  = 3.0 - 1.0 = 2.0 SOL
     */

    const engine2 = new MetricsEngine();
    const ALICE = 'Alice222222222222222222222222222222222222222';
    const BOB   = 'Bob11111111111111111111111111111111111111111';
    const MINT  = 'MINT2';

    const mk = (maker, event, base, quote, ts) => ({
      type: 'gmgn',
      data: { maker, event, base_amount: String(base), quote_amount: String(quote), tx_hash: `h${ts}`, timestamp: ts, token_address: MINT }
    });

    const origLog = console.log;
    console.log = () => {};

    engine2.processTransaction(mk(ALICE, 'buy',  100, 1.0, 1), MINT);
    engine2.processTransaction(mk(BOB,   'buy',  200, 4.0, 2), MINT);
    engine2.processTransaction(mk(BOB,   'sell', 100, 3.0, 3), MINT);

    console.log = origLog;

    const metrics2 = engine2.getMetrics();

    console.log('\n  【手工案例2 - 两用户聚合验证】');
    console.log(`  Alice 买100T@0.01 → holdingCost=1.0000 SOL`);
    console.log(`  Bob   买200T@0.02 → holdingCost=4.0000 SOL  avgPrice=0.020`);
    console.log(`  Bob   卖100T@0.03 → sellPrincipal=2.0  holdingCost=2.0  利润=+1.0`);
    console.log(`  本轮下注  = 1.0 + 2.0 = ${metrics2.benLunXiaZhu.toFixed(4)} SOL  (期望 3.0000)`);
    console.log(`  已落袋    = ${metrics2.yiLuDai.toFixed(4)} SOL  (期望 1.0000)`);
    console.log(`  本轮成本  = ${metrics2.benLunChengBen.toFixed(4)} SOL  (期望 2.0000)`);

    expect(metrics2.benLunXiaZhu).toBeCloseTo(3.0, 6);
    expect(metrics2.yiLuDai).toBeCloseTo(1.0, 6);
    expect(metrics2.benLunChengBen).toBeCloseTo(2.0, 6);
  });

});
