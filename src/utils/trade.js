import PortalPay from './PortalPay';
import { stoGet } from './api';

/**
 * 封装后的交易函数，支持前端 API 或后端调用
 * @param {string} action - 'buy' | 'sell'
 * @param {object} params - { mint, amount, percent }
 * @returns {Promise<any>}
 */
export async function doTrade(action, params) {
    const cfg = await stoGet(['trade_mode', 'pumpportal_key', 'slippage', 'priority_fee', 'pool']);
    const mode = cfg.trade_mode || 'backend';

    if (mode === 'frontend') {
        if (!cfg.pumpportal_key) throw new Error('未配置 PumpPortal API Key');

        // params: {mint, amount(SOL), percent(number)}
        // PortalPay.trade 期望: 
        // buy: amount (SOL)
        // sell: amount ("50%" or token amount)
        
        let amt = params.amount;
        if (action === 'sell') {
            // 如果传入的是 percent (如 50)，转换为 "50%" 字符串
            if (params.percent !== undefined) {
                amt = params.percent + '%';
            } else if (typeof params.amount === 'string' && params.amount.includes('%')) {
                // 已经是字符串百分比
                amt = params.amount;
            }
        }

        return PortalPay.trade(
            cfg.pumpportal_key,
            action,
            params.mint,
            amt,
            cfg.slippage ?? 10,
            cfg.priority_fee ?? 0.00005,
            cfg.pool || 'auto'
        );
    } else {
        // Backend mode
        // 假设后端运行在 127.0.0.1:8787
        const path = action === 'buy' ? '/api/trade/buy' : '/api/trade/sell';
        const r = await fetch('http://127.0.0.1:8787' + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.text();
    }
}
