export default class WhaleScoreManager {
    constructor() {
        this.index = new Map();
        this.statusMap = {};
        this.shortAddressMap = {};
        this.activityMap = {}; // 活跃度映射表
        this.cachedMint = '';
        // 默认庄家筛选配置
        this.bossConfig = {
            enable_no_source: true,      // 策略1: 无资金来源
            enable_same_source: false,   // 策略2: 同源账户聚类
            enable_time_cluster: false,  // 策略3: 时间聚类
            same_source_n: 5,            // 同源阈值
            same_source_exclude: '',     // 同源排除地址 (逗号分隔)
            time_cluster_n: 5,           // 时间聚类阈值
            time_cluster_j: 1            // 时间聚类窗口(秒)
        };
        // 异步加载
        this.init();
    }

    async init() {
        try {
            const res = await chrome.storage.local.get(['gmgn_short_map', 'boss_config']);
            if (res.gmgn_short_map && typeof res.gmgn_short_map === 'object') {
                this.shortAddressMap = res.gmgn_short_map;
            }
            if (res.boss_config && typeof res.boss_config === 'object') {
                this.bossConfig = { ...this.bossConfig, ...res.boss_config };
            }
        } catch (e) {
        }
    }

    saveStatusMap() {
        // 用户状态持久化已迁移至 IndexedDB，不再写入 chrome.storage
    }

    saveShortAddressMap() {
        try {
            chrome.storage.local.set({ gmgn_short_map: this.shortAddressMap });
        } catch (e) {
            if (!e.message.includes('Extension context invalidated')) {
            }
        }
    }

    // 导出持有者状态
    exportStatusMap() {
        return JSON.stringify(this.statusMap, null, 2);
    }

    // 导入持有者状态
    importStatusMap(jsonStr) {
        try {
            const data = JSON.parse(jsonStr);
            if (data && typeof data === 'object') {
                Object.assign(this.statusMap, data);
                this.saveStatusMap();
                return Object.keys(data).length;
            }
        } catch (e) {
        }
        return 0;
    }

    // 清空持有者状态
    clearStatusMap() {
        this.statusMap = {};
        this.saveStatusMap();
    }

    setShortAddress(owner, shortAddr) {
        if (!owner || !shortAddr) return;
        if (this.shortAddressMap[owner] !== shortAddr) {
            this.shortAddressMap[owner] = shortAddr;
            this.saveShortAddressMap();
            
            // 实时更新内存索引
            const item = this.index.get(owner);
            if (item) {
                item.main_address_short = shortAddr;
            }
        }
    }

    getShortAddress(owner) {
        return this.shortAddressMap[owner] || '';
    }

    importShortAddressMap(jsonStr) {
        try {
            const data = JSON.parse(jsonStr);
            if (data && typeof data === 'object') {
                Object.assign(this.shortAddressMap, data);
                this.saveShortAddressMap();
                // 立即应用到当前内存索引
                this.applyShortAddressesToIndex();
                return Object.keys(data).length;
            }
        } catch (e) {
        }
        return 0;
    }

    applyShortAddressesToIndex() {
        let updates = 0;
        for (const [owner, item] of this.index) {
            const short = this.shortAddressMap[owner];
            if (short && item.main_address_short !== short) {
                item.main_address_short = short;
                updates++;
            }
        }
        return updates;
    }

    exportShortAddressMap() {
        return JSON.stringify(this.shortAddressMap, null, 2);
    }

    clearShortAddressMap() {
        this.shortAddressMap = {};
        this.saveShortAddressMap();
    }

    setStatus(owner, status) {
        this.statusMap[owner] = status;
        const item = this.index.get(owner);
        if (item) {
            item.status = status;
        }
        this.saveStatusMap();
    }

    getStatus(owner) {
        return this.statusMap[owner] || '散户';
    }

    clear() {
        this.index.clear();
    }

    setMint(mint) {
        this.cachedMint = mint;
    }


    // 导出活跃度映射表
    exportActivityMap() {
        return this.activityMap;
    }

    // 【优化版】统一更新方法（API 和 Web 数据都走这里）
    updateData(rawItems, isWebData = false) {
        // 方便调试：强制断点
        // debugger;
        
        if (!rawItems || !Array.isArray(rawItems)) return new Set();

        


        const newOwners = new Set();
        let hasNewStatus = false; // 标记是否有新状态需要保存

        // 预处理集合
        const fundingGroups = new Map(); // from_address -> [owner]
        const timeGroups = [];           // { time, owner }
        const config = this.bossConfig;

        // 重置本次活跃度统计 (如果是全量更新)
        // 注意：如果是增量更新，可能需要保留旧值。这里假设 rawItems 是全量或分页获取的最新状态。
        // 为简单起见，这里直接覆盖更新，或者也可以累加。原版逻辑是基于 Map 的。
        // 这里我们重新计算本次 rawItems 中的活跃度。
        const newActivityMap = {}; 

        rawItems.forEach(raw => {

            // ------------------ 新增：过滤 usd_value 为 0 或无效的数据 ------------------
            const usdValue = raw.usd_value ?? 0;  // null/undefined 转为 0
            // 放宽条件：如果 usdValue 为 0，但持有比例 > 0 或 ui_amount > 0，也保留
            if (usdValue <= 0 && (!raw.holding_share_pct || raw.holding_share_pct <= 0) && (!raw.ui_amount || raw.ui_amount <= 0)) {
                 // console.log(`[WhaleScoreManager] Filtered out dust: ${owner}`);
                 return;  // 确实是垃圾数据（无价值、无占比、无数量）
            }
            // -------------------------------------------------------------------------

            const owner = raw.address || raw.owner;
            
            // 统计活跃度 (买入次数)
            // 原版逻辑：buy_tx_count (API) 或累加 (Web)
            let activity = 0;
            if (raw.buy_tx_count !== undefined) {
                activity = parseInt(raw.buy_tx_count) || 0;
            } else {
                // 如果没有显式的 tx count，可以用 buy_volume_cur 大致判断等级，或者默认为 0
                // 为了兼容 observer_feature.js 的逻辑 (fire1/fire2/fire3)，这里需要产生一个数字
                // 暂时用 total_buy_u / 100 模拟，或者直接为 0
                // 更好的方式是 API 返回 tx_count。如果 API 没有，则不显示火。
                // 修复：如果 total_buy_u 有值，赋予一个默认活跃度，确保能显示火
                if (parseFloat(raw.total_buy_u) > 100) activity = 1;
                if (parseFloat(raw.total_buy_u) > 1000) activity = 3;
                if (parseFloat(raw.total_buy_u) > 10000) activity = 5;
            }
            
            // 如果 rawItems 包含 tx_count，则记录
            // 修复：只要有 activity 就记录，不强制要求 tx_count
            if (activity > 0) {
                newActivityMap[owner] = activity;
            }


            let fundingAccount = raw?.native_transfer?.from_address || '';
            let transferName = raw?.native_transfer?.name || '-';
            let transferAmount = raw?.native_transfer?.amount || '-';           

            // 1. 基础字段准备（API 数据结构）
            // let fundingAccount = raw.fundingAccount;
            // if (raw.native_transfer && raw.native_transfer.from_address) {
            //     fundingAccount = raw.native_transfer.from_address;
            // }
            
            // 构造标准 item
            const it = {
                owner: raw.address || raw.owner,                  // 全地址
            };
            // 短地址（优先取本地保存的）
            const shortAddr = this.getShortAddress(it.owner);

            // 补充 item 字段
            it.main_address_short = shortAddr;
            it.total_buy_u = raw.total_buy_u ?? 0;
            it.netflow_amount = raw.netflow_amount ?? 0; // 新增：净流入金额 (USD)
            it.holding_share_pct = raw.usd_value ?? 0;
            it.funding_account = fundingAccount;

            // 收集聚类数据
            // 同源聚类
            if (config.enable_same_source && fundingAccount) {
                if (!fundingGroups.has(fundingAccount)) fundingGroups.set(fundingAccount, []);
                fundingGroups.get(fundingAccount).push(it.owner);
            }

            // 时间聚类 (优先使用 created_at)
            if (config.enable_time_cluster) {
                const ts = raw.created_at || raw.open_timestamp || 0;
                if (ts > 0) {
                    timeGroups.push({ time: ts, owner: it.owner });
                }
            }

            newOwners.add(it.owner);

            const old = this.index.get(it.owner);
            let merged = { ...it };

            // 2. 状态处理
            const manualStatus = this.getStatus(it.owner);
            
            if (manualStatus !== '散户') {
                merged.status = manualStatus;                // 手动标记永远保留
            } else {
                // 默认散户，稍后通过聚类和策略更新
                merged.status = '散户';
            }

            // 策略1: 无资金来源 (No Funding Source)
            if (config.enable_no_source && manualStatus === '散户') {
                    // 明确要求：from_address 不存在即为庄家
                if (!fundingAccount) {
                    merged.status = '庄家';
                    if (this.statusMap[it.owner] !== '庄家') {
                        this.statusMap[it.owner] = '庄家';
                        hasNewStatus = true;
                    }
                }
            }

            // 3. 合并旧数据（保留有价值的旧字段）
            if (old) {
                merged = { ...old, ...merged };

                // 特殊保护字段（旧的有值且新的没有时保留旧的）
                if (!merged.source_text && old.source_text) merged.source_text = old.source_text;
                if (!merged.funding_account && old.funding_account) merged.funding_account = old.funding_account;
            }

            this.index.set(it.owner, merged);
        });

        // 执行聚类分析 (针对本次数据中的项)
        const detectedBosses = new Set();

        // 策略2: 同源账户聚类
        if (config.enable_same_source) {
            const threshold = config.same_source_n || 5;
            // 解析排除列表
            const excludeSet = new Set(
                String(config.same_source_exclude || '')
                    .split(/[,，\s]+/)
                    .map(s => s.trim())
                    .filter(Boolean)
            );

            for (const [src, group] of fundingGroups) {
                // 排除特定来源
                if (excludeSet.has(src)) {
                    continue;
                }

                // 排除交易所/短名称来源 (如 "Binance", "OKX")
                // Solana 地址通常 > 30 字符，短名称通常是交易所或标签
                if (src.length < 30) {
                    continue;
                }

                if (group.length >= threshold) {
                    group.forEach(addr => detectedBosses.add(addr));
                }
            }
        }

        // 策略3: 时间聚类
        if (config.enable_time_cluster) {
            const threshold = config.time_cluster_n || 5;
            const windowSec = config.time_cluster_j || 1;
            
            timeGroups.sort((a, b) => a.time - b.time);
            
            // 滑动窗口
            for (let i = 0; i <= timeGroups.length - threshold; i++) {
                const startItem = timeGroups[i];
                const endItem = timeGroups[i + threshold - 1];
                
                if (endItem.time - startItem.time <= windowSec) {
                        // 窗口内所有元素标记为庄家
                    for (let k = i; k < i + threshold; k++) {
                        detectedBosses.add(timeGroups[k].owner);
                    }
                }
            }
        }

        // 应用聚类结果
        if (detectedBosses.size > 0) {
            detectedBosses.forEach(owner => {
                const item = this.index.get(owner);
                if (item && item.status !== '庄家') {
                        // 仅当之前未被手动标记或其他策略标记时更新
                        // 但手动标记如果是 '散户' 会被覆盖吗？ getStatus 如果返回 '散户' 则这里会更新
                        // 注意：manualStatus !== '散户' 的情况已经在上面处理并赋值了 merged.status
                        // 这里我们需要检查是否需要覆盖 '散户'
                        
                        // 再次检查 manualStatus 防止覆盖用户手动设置的非庄家状态(如果有的话，目前只有庄/散)
                        // 假设 manualStatus 为 '散户' 时才覆盖
                        const currentStored = this.statusMap[owner];
                        if (!currentStored || currentStored === '散户') {
                            item.status = '庄家';
                            this.statusMap[owner] = '庄家';
                            hasNewStatus = true;
                        }
                }
            });
        }

        // 如果有新的自动标记状态，批量保存一次
        if (hasNewStatus) {
            this.saveStatusMap();
        }

        // 更新活跃度表 (合并而非覆盖，以保留历史)
        Object.assign(this.activityMap, newActivityMap);

        return newOwners;
    }

    getAllItems() {
        return Array.from(this.index.values());
    }

    getSortedItems() {
        const items = this.getAllItems();
        return items.sort((a, b) => {
            // 优先按占比（holding_share_pct）从大到小排序
            const ap = parseFloat(a.holding_share_pct || 0);
            const bp = parseFloat(b.holding_share_pct || 0);
            if (Math.abs(ap - bp) > 0.000001) {
                    return bp - ap;
            }

            try {
                const ai = BigInt(a.amount || 0), bi = BigInt(b.amount || 0);
                return bi > ai ? 1 : bi < ai ? -1 : 0;
            } catch (_) {
                return (parseFloat(b.ui_amount || 0) - parseFloat(a.ui_amount || 0));
            }
        });
    }
}
