// 移植自 extensions/gmgn-standard/pay/portal.js
// 提供 PumpPortal 交易 API 封装和高级策略管理

const PortalPay = {
    /**
     * 执行交易 (PumpPortal API)
     * @param {string} apiKey - PumpPortal API Key
     * @param {string} action - "buy" or "sell"
     * @param {string} mint - Token mint address
     * @param {number|string} amount - SOL amount for buy, or "100%" / token amount for sell
     * @param {number} slippage - Slippage percent (e.g. 10)
     * @param {number} priorityFee - Priority fee in SOL
     * @param {string} pool - Pool to trade on (default "auto")
     * @returns {Promise<any>}
     */
    trade: async function(apiKey, action, mint, amount, slippage = 10, priorityFee = 0.00005, pool = "auto") {
        if (!apiKey) throw new Error("API Key is required");
        if (!mint) throw new Error("Mint address is required");

        const isBuy = action === 'buy';
        // 构造请求体
        const payload = {
            "action": action,
            "mint": mint,
            "amount": amount,
            "denominatedInSol": isBuy ? "true" : "false", // 买入通常是 SOL，卖出通常是 Token 或百分比
            "slippage": slippage,
            "priorityFee": priorityFee,
            "pool": pool
        };

        console.log('[PortalPay] Sending request:', payload);

        const response = await fetch(`https://pumpportal.fun/api/trade?api-key=${apiKey}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.errors ? JSON.stringify(data.errors) : `HTTP ${response.status}`);
        }
        
        if (data.errors && data.errors.length > 0) {
            throw new Error(JSON.stringify(data.errors));
        }

        return data;
    },

    // ---------------------------------------------------------------------
    // Strategy Manager: 高级策略管理
    // ---------------------------------------------------------------------
    _strategy: {
        active: false,
        config: null,
        logs: [],
        onLog: null,
        onTrade: null
    },

    /**
     * 启动策略
     * @param {object} config - 策略配置对象 (JSON)
     * @param {function} logCallback - 日志回调
     * @param {function} tradeCallback - 交易执行回调(通常调用 trade)
     */
    startStrategy: function(config, logCallback, tradeCallback) {
        this._strategy.config = config;
        this._strategy.onLog = logCallback;
        this._strategy.onTrade = tradeCallback;
        this._strategy.active = true;
        this._strategy.logs = [];
        this.logStrategy('策略已启动: ' + (config.name || '未命名策略'));
        this.logStrategy('基准价格: $' + config.base_price);
        
        // 如果是立即执行模式，直接处理
        if (config.mode === 'immediate') {
            this.executeImmediate(config);
        }
    },

    stopStrategy: function() {
        if (this._strategy.active) {
            this._strategy.active = false;
            this.logStrategy('策略已停止');
            this._strategy.config = null;
        }
    },

    isActive: function() {
        return this._strategy.active;
    },

    getLogs: function() {
        return this._strategy.logs;
    },

    // 重新绑定日志回调 (用于弹窗关闭后重新打开)
    setLogCallback: function(cb) {
        this._strategy.onLog = cb;
    },

    logStrategy: function(msg) {
        const time = new Date().toLocaleTimeString();
        const line = `[${time}] ${msg}`;
        this._strategy.logs.push(line);
        if (this._strategy.onLog) this._strategy.onLog(line);
        console.log('[PortalStrategy]', msg);
    },

    /**
     * 检查价格并触发策略
     * @param {number} currentPrice - 当前最新价格
     */
    checkStrategy: async function(currentPrice) {
        if (!this._strategy.active || !this._strategy.config) return;
        
        const cfg = this._strategy.config;
        if (cfg.mode !== 'monitor') return;
        
        const base = parseFloat(cfg.base_price);
        if (!base || base <= 0) return;
        
        const changePct = ((currentPrice - base) / base) * 100;
        // this.logStrategy(`价格监控: $${currentPrice} (变化 ${changePct.toFixed(2)}%)`);

        if (cfg.conditions && Array.isArray(cfg.conditions)) {
            for (const cond of cfg.conditions) {
                if (cond.triggered) continue; // 已触发过的条件跳过

                let trigger = false;
                if (cond.type === 'up_pct' && changePct >= parseFloat(cond.value)) {
                    trigger = true;
                    this.logStrategy(`触发止盈/上涨条件: 涨幅 ${changePct.toFixed(2)}% >= ${cond.value}%`);
                } else if (cond.type === 'down_pct' && changePct <= parseFloat(cond.value)) { // value 应该是负数，如 -10
                    trigger = true;
                    this.logStrategy(`触发止损/下跌条件: 跌幅 ${changePct.toFixed(2)}% <= ${cond.value}%`);
                } else if (cond.type === 'price_above' && currentPrice >= parseFloat(cond.value)) {
                    trigger = true;
                    this.logStrategy(`触发价格上限: $${currentPrice} >= $${cond.value}`);
                } else if (cond.type === 'price_below' && currentPrice <= parseFloat(cond.value)) {
                    trigger = true;
                    this.logStrategy(`触发价格下限: $${currentPrice} <= $${cond.value}`);
                }

                if (trigger) {
                    cond.triggered = true; // 标记为已触发
                    await this.executeAction(cond);
                }
            }
        }
    },

    executeImmediate: async function(cfg) {
        this.logStrategy('执行立即操作...');
        if (cfg.actions && Array.isArray(cfg.actions)) {
            for (const action of cfg.actions) {
                await this.executeAction(action);
            }
        }
        // 立即模式执行完即停止
        this.stopStrategy();
    },

    executeAction: async function(actionCfg) {
        if (!this._strategy.onTrade) {
            this.logStrategy('错误: 未配置交易执行器');
            return;
        }
        
        try {
            this.logStrategy(`正在执行: ${actionCfg.action.toUpperCase()} ${actionCfg.amount} ...`);
            
            // 构造 trade 参数
            // actionCfg: { action: "buy", amount: 0.1, mint: "..." }
            // 默认使用 config 里的 mint，如果 action 里没有指定
            const mint = actionCfg.mint || (this._strategy.config && this._strategy.config.mint);
            
            await this._strategy.onTrade({
                action: actionCfg.action,
                amount: actionCfg.amount, // "100%" or number
                mint: mint
            });
            
            this.logStrategy(`执行成功: ${actionCfg.action} ${actionCfg.amount}`);
        } catch (e) {
            this.logStrategy(`执行失败: ${e.message}`);
        }
    }
};

export default PortalPay;
