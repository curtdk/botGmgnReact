/**
 * ContentScoreManager.js
 * 运行在 Content Script 中的超级数据管理器
 * 负责融合数据、庄家分析、聚类计算，并生成 UI 渲染数据
 */
import BossLogic from './BossLogic';

export default class ContentScoreManager {
    constructor() {
        this.dataMap = new Map(); // Address -> UserInfo
        this.processedTxHashes = new Set(); // 用于交易去重
        this.maxTxHistory = 2000; // 防止 Set 无限增长
        
        // 配置缓存 (内存中)
        this.bossConfig = {
            // 基础策略与权重
            enable_no_source: true,
            weight_no_source: 10,

            enable_same_source: false,
            same_source_n: 5,
            same_source_exclude: '',
            weight_same_source: 10,

            enable_time_cluster: false,
            time_cluster_n: 5,
            time_cluster_j: 1,
            weight_time_cluster: 10,

            // 高级规则对象
            rule_gas: { enabled: false, threshold: 0.01, weight: 10 },
            rule_amount_sim: { enabled: false, count: 5, range: 100, weight: 10 },
            rule_large_holding: { enabled: false, top_pct: 5, min_usd: 1000, logic: 'OR', weight: 10 },
            rule_sol_balance: { enabled: false, count: 3, range: 0.1, weight: 10 },
            // [新增] 资金来源时间聚类规则
            rule_source_time: { enabled: false, diff_sec: 10, count: 2, weight: 10 },

            // [新增] 火焰标记阈值配置
            fire_thresholds: [100, 200, 300]
        };
        // 数据处理模式配置 (默认开启持有人列表以兼容旧行为)
        this.modeConfig = {
            mode_holder_list: true,
            mode_boss_refresh: false
        };
        this.statusMap = {};
        this.shortAddressMap = {};

        // 初始化
        this.init();
    }

    /**
     * 初始化：加载配置并监听变化
     */
    async init() {
        try {
            // 1. 初始加载
            const res = await chrome.storage.local.get([
                'boss_config', 'holder_status', 'gmgn_short_map',
                'mode_holder_list', 'mode_boss_refresh', 'mode_update_current', 'hook_refresh_enabled'
            ]);
            
            if (res.boss_config) {
                // 深度合并配置，确保规则对象的默认值（如权重）不丢失
                const defaults = { ...this.bossConfig };
                this.bossConfig = { ...defaults, ...res.boss_config };
                
                ['rule_gas', 'rule_amount_sim', 'rule_large_holding', 'rule_sol_balance', 'rule_source_time'].forEach(key => {
                    if (res.boss_config[key]) {
                        this.bossConfig[key] = { ...defaults[key], ...res.boss_config[key] };
                    }
                });
            }

            if (res.holder_status) this.statusMap = res.holder_status;
            if (res.gmgn_short_map) this.shortAddressMap = res.gmgn_short_map;
            
            // 加载模式配置 (兼容逻辑：如果开启了Hook但没有mode配置，默认开启列表模式)
            if (res.mode_holder_list !== undefined) this.modeConfig.mode_holder_list = res.mode_holder_list;
            else if (res.hook_refresh_enabled) this.modeConfig.mode_holder_list = true;

            if (res.mode_boss_refresh !== undefined) this.modeConfig.mode_boss_refresh = res.mode_boss_refresh;
            

            // 2. 监听变化 (实时更新内存，无需重读 IO)
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local') {
                    if (changes.boss_config) {
                        const newConfig = changes.boss_config.newValue;
                        const current = { ...this.bossConfig };
                        this.bossConfig = { ...current, ...newConfig };
                        
                        // 深度合并
                        ['rule_gas', 'rule_amount_sim', 'rule_large_holding', 'rule_sol_balance', 'rule_source_time'].forEach(key => {
                            if (newConfig[key]) {
                                this.bossConfig[key] = { ...(current[key] || {}), ...newConfig[key] };
                            }
                        });
                    }
                    if (changes.holder_status) {
                        this.statusMap = changes.holder_status.newValue || {};
                    }
                    if (changes.gmgn_short_map) {
                        this.shortAddressMap = changes.gmgn_short_map.newValue || {};
                    }
                    // 监听模式配置变化
                    if (changes.mode_holder_list) this.modeConfig.mode_holder_list = changes.mode_holder_list.newValue;
                    if (changes.mode_boss_refresh) this.modeConfig.mode_boss_refresh = changes.mode_boss_refresh.newValue;
                }
            });
        } catch (e) {
        }
    }

    /**
     * 获取短地址 (优先取内存缓存)
     */
    getShortAddress(owner) {
        return this.shortAddressMap[owner] || '';
    }

    /**
     * 设置短地址 (更新内存并异步持久化)
     * @param {string} owner - 钱包地址
     * @param {string} shortAddr - 短地址/备注
     */
    setShortAddress(owner, shortAddr) {
        if (!owner) return;
        
        // 1. 检查是否有变化
        if (this.shortAddressMap[owner] === shortAddr) return;

        // 2. 更新内存
        this.shortAddressMap[owner] = shortAddr;
        
        // 3. 更新内存中的数据对象 (如果存在)
        const item = this.dataMap.get(owner);
        if (item) {
            item.main_address_short = shortAddr;
            item.last_updated = Date.now();
        }

        // 4. 异步更新存储 (不阻塞)
        chrome.storage.local.set({ gmgn_short_map: this.shortAddressMap }).catch(err => {
        });
    }

    /**
     * [新增] 批量更新短地址 (去重 + 批量保存)
     * @param {Array} items - [{ address, remark }, ...]
     */
    updateShortAddresses(items) {
        if (!Array.isArray(items) || items.length === 0) return 0;

        let changed = false;
        let updateCount = 0;

        items.forEach(item => {
            const { address, remark } = item;
            if (!address) return;

            // 检查是否有变化 (去重核心逻辑)
            // 只有当本地没有，或者本地值不等于新值时，才更新
            if (this.shortAddressMap[address] !== remark) {
                this.shortAddressMap[address] = remark;
                changed = true;
                updateCount++;

                // 同步更新内存对象
                const dataItem = this.dataMap.get(address);
                if (dataItem) {
                    dataItem.main_address_short = remark;
                    dataItem.last_updated = Date.now();
                }
            }
        });

        // 仅当有实际变更时才写入 Storage
        if (changed) {
            chrome.storage.local.set({ gmgn_short_map: this.shortAddressMap }).catch(err => {
            });
        } else {
        }

        return updateCount;
    }

    /**
     * 手动设置状态 (用于接收 SidePanel 的实时通知)
     * @param {string} owner - 钱包地址
     * @param {string} status - 新状态
     */
    setStatus(owner, status) {
        if (!owner) return;
        
        // 1. 更新内存状态表
        this.statusMap[owner] = status;
        
        // 2. 更新内存数据对象
        const item = this.dataMap.get(owner);
        if (item) {
            item.status = status;
            item.last_updated = Date.now();
        }
        
    }

    /**
     * 安全保存状态到 Storage (读取-合并-写入)
     */
    async saveStatus() {
        try {
            const res = await chrome.storage.local.get('holder_status');
            const current = res.holder_status || {};
            // 合并当前内存中的状态到存储中
            const merged = { ...current, ...this.statusMap };
            await chrome.storage.local.set({ holder_status: merged });
        } catch (e) {
        }
    }

    /**
     * 获取状态 (优先取内存缓存)
     */
    getStatus(owner) {
        return this.statusMap[owner] || '散户';
    }

    /**
     * 统一处理用户数据字段映射 (Normalization)
     * 确保新旧用户都能正确解析 native_balance 等字段
     * @param {Object} raw - API 返回的原始数据
     * @param {Object} existing - 已存在的用户对象 (可选)
     * @param {number} snapshotTs - 快照时间戳
     * @returns {Object} 合并后的用户对象
     */
    normalizeUserData(raw, existing, snapshotTs) {
        let merged;
        
        if (!existing) {
            // 新建对象
            merged = {
                ...raw,
                // owner: 在外部赋值
                source: 'holder',
                is_trade_only: false,
                last_updated: Date.now(),
                last_snapshot_ts: snapshotTs,
                score: 0,
                score_reasons: [],
                max_gas_fee: 0
            };
        } else {
            // 更新对象
            merged = existing;
            merged.last_snapshot_ts = snapshotTs;
            merged.last_updated = Date.now();
        }

        // 统一字段映射 (无论新旧用户都执行，确保字段最新)
        // 1. 总买入
        merged.total_buy_u = raw.history_bought_cost ?? raw.total_buy_u ?? merged.total_buy_u;
        
        // 2. 净流量
        merged.netflow_amount = raw.netflow_usd ?? raw.netflow_amount ?? merged.netflow_amount;
        
        // 3. 持仓占比
        merged.holding_share_pct = raw.amount_percentage ?? raw.holding_share_pct ?? merged.holding_share_pct;
        
        // 4. 持仓数量
        merged.ui_amount = raw.amount_cur ?? raw.amount ?? merged.ui_amount;
        
        // 5. SOL 余额 (关键修复：确保新用户也能解析)
        if (raw.native_balance !== undefined) {
            merged.sol_balance = parseFloat(raw.native_balance) / 1e9;
        } else if (raw.sol_balance !== undefined) {
            merged.sol_balance = raw.sol_balance;
        }

        // [新增] 6. 更新最后活跃时间戳 (Holder 数据可能带有 last_active_timestamp)
        if (raw.last_active_timestamp) {
            merged.last_active_timestamp = Math.max(merged.last_active_timestamp || 0, raw.last_active_timestamp);
        }

        return merged;
    }

    /**
     * 处理 Holder 列表 (基准数据 + 庄家分析 + 智能评分)
     * @param {Array} items - normalize 后的 holder 数据
     */
    updateHolders(items) {
        if (!Array.isArray(items)) return;
        
        const config = this.bossConfig;
        
        // --- Pass 1: 全局统计 (用于分桶和聚类) ---
        const stats = {
            fundingGroups: new Map(), // from -> [owner]
            timeGroups: [],           // { time, owner }
            sourceTimeGroups: [],     // [新增] { time, owner, from } (资金来源时间)
            amountBuckets: new Map(), // bucketKey -> count
            balanceBuckets: new Map(), // bucketKey -> count
            totalHolders: items.length,
            timeClusteredUsers: new Set(),
            sourceTimeClusteredUsers: new Map() // [修改] Owner -> Set<RelatedOwner>
        };

        const amountRange = config.rule_amount_sim?.range || 100;
        const balanceRange = config.rule_sol_balance?.range || 0.1;

        items.forEach(raw => {
            const owner = raw.address || raw.owner;
            if (!owner) return;

            // 资金来源分组 (Funding Group)
            // 兼容性处理：如果 native_transfer 存在，则取 from_address；否则尝试取 funding_account 字段
            // 如果 native_transfer 为 null，通常意味着是 CEX 提币或创世空投，此时 fundingAccount 为空字符串
            const fundingAccount = raw.native_transfer?.from_address || raw.funding_account || '';
            if (fundingAccount) {
                if (!stats.fundingGroups.has(fundingAccount)) stats.fundingGroups.set(fundingAccount, []);
                stats.fundingGroups.get(fundingAccount).push(owner);
            }

            // [新增] 资金来源时间收集
            if (raw.native_transfer && raw.native_transfer.timestamp) {
                stats.sourceTimeGroups.push({ 
                    time: raw.native_transfer.timestamp, 
                    owner: owner,
                    from: fundingAccount // 记录来源以便后续排除相同来源（如果需要）
                });
            }

            // 时间分组 (Time Group)
            const ts = raw.created_at || raw.open_timestamp || 0;
            if (ts > 0) stats.timeGroups.push({ time: ts, owner });

            // 金额分桶 (Amount Bucket - Total Buy USD)
            // 优先使用已有的累积数据，其次是快照数据
            // 映射：total_buy_u -> history_bought_cost
            const existing = this.dataMap.get(owner);
            const buyU = parseFloat(existing?.total_buy_u || raw.history_bought_cost || 0);
            if (buyU > 0) {
                const key = Math.floor(buyU / amountRange);
                stats.amountBuckets.set(key, (stats.amountBuckets.get(key) || 0) + 1);
            }

            // 余额分桶 (Balance Bucket - SOL)
            // 映射：sol_balance -> native_balance (lamports -> SOL)
            // 注意：token_holders.json 中只有 native_balance，没有 sol_balance
            let balance = 0;
            if (raw.native_balance) {
                balance = parseFloat(raw.native_balance) / 1e9;
            }
            if (balance > 0) {
                const key = Math.floor(balance / balanceRange);
                stats.balanceBuckets.set(key, (stats.balanceBuckets.get(key) || 0) + 1);
            }
        });

        // 计算时间聚类 (O(N log N))
        if (config.enable_time_cluster || config.weight_time_cluster > 0) {
            stats.timeGroups.sort((a, b) => a.time - b.time);
            const threshold = config.time_cluster_n || 5;
            const windowSec = config.time_cluster_j || 1;
            
            for (let i = 0; i <= stats.timeGroups.length - threshold; i++) {
                const startItem = stats.timeGroups[i];
                const endItem = stats.timeGroups[i + threshold - 1];
                if (endItem.time - startItem.time <= windowSec) {
                    for (let k = i; k < i + threshold; k++) stats.timeClusteredUsers.add(stats.timeGroups[k].owner);
                }
            }
        }

        // [新增] 计算资金来源时间聚类
        if (config.rule_source_time && (config.rule_source_time.enabled || config.rule_source_time.weight > 0)) {
            stats.sourceTimeGroups.sort((a, b) => a.time - b.time);
            // 这里我们先找出所有符合条件的窗口，然后将用户关联起来
            // 注意：滑动窗口可能会有重叠，我们需要将相互关联的用户合并到一个集合中
            // 简化逻辑：只要两个用户在窗口内，就互相记录
            
            const windowSec = config.rule_source_time.diff_sec || 10;
            const len = stats.sourceTimeGroups.length;

            for (let i = 0; i < len; i++) {
                const current = stats.sourceTimeGroups[i];
                // 向后寻找所有在窗口内的项
                for (let j = i + 1; j < len; j++) {
                    const next = stats.sourceTimeGroups[j];
                    if (next.time - current.time <= windowSec) {
                        // 发现关联：current 和 next
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
                        
                        // 自身也加入集合，方便后续计数
                        setA.add(current.owner);
                        setB.add(next.owner);
                    } else {
                        // 超过窗口，因为已排序，后续都不满足
                        break;
                    }
                }
            }
        }

        // --- Pass 2: 更新数据与评分 ---
        const allowAdd = this.modeConfig.mode_holder_list;
        const allowBossAnalyze = this.modeConfig.mode_holder_list || this.modeConfig.mode_boss_refresh;
        
        let hasNewStatus = false;
        let updateCount = 0; // 更新现有用户数
        let createCount = 0; // 新增用户数
        // 获取当前时间戳作为快照基准 (使用 Date.now() 或 API 响应时间)
        const snapshotTs = Date.now();

        items.forEach((raw, index) => {
            try {
                // 过滤垃圾数据 (仅在添加新用户时过滤，已存在的用户不过滤)
                const usdValue = raw.usd_value ?? 0;
                const owner = raw.address || raw.owner;
                if (!owner) return;

                const existing = this.dataMap.get(owner);

                if (!existing) {
                    if (usdValue <= 0 && (!raw.holding_share_pct || raw.holding_share_pct <= 0) && (!raw.ui_amount || raw.ui_amount <= 0)) return;
                    if (!allowAdd) return; // 不允许添加
                    createCount++;
                } else {
                    updateCount++;
                }

                // 统一字段解析 (包含 sol_balance 修复)
                let merged = this.normalizeUserData(raw, existing, snapshotTs);
                
                // [关键修复] 确保 owner 存在 (新用户 raw 可能只有 address)
                merged.owner = owner; 
                // [关键修复] 恢复短地址
                merged.main_address_short = this.getShortAddress(owner);

                // [新增] 标记为持有用户 (Holder 列表来源一定是持有用户)
                merged.is_holding = true;

                // 记录排名 (用于大额持仓判定)
                merged.rank = index + 1;

                // 补充/刷新关联信息
                // 增强获取逻辑：如果 native_transfer 不存在，尝试保留旧值或使用空字符串
                // 注意：如果 raw.native_transfer 是 null，说明确实没有来源（CEX提币），此时应覆盖旧值为空
                if (raw.native_transfer !== undefined) {
                    merged.funding_account = raw.native_transfer?.from_address || '';
                } else if (!merged.funding_account && raw.funding_account) {
                    merged.funding_account = raw.funding_account;
                }

                // *** 核心：计算分数 ***
                // 无论是否开启 Boss 分析，我们都计算分数用于显示
                const { score, isBoss, reasons } = BossLogic.calculateUserScore(merged, stats, this.bossConfig);
                merged.score = score;
                merged.score_reasons = reasons;

                // 状态处理
                if (allowBossAnalyze) {
                    const manualStatus = this.getStatus(owner);
                    if (manualStatus !== '散户') {
                        merged.status = manualStatus;
                    } else {
                        // 自动判定
                        if (isBoss) {
                            merged.status = '庄家';
                            // 仅当状态改变时标记
                            if (this.statusMap[owner] !== '庄家') {
                                this.statusMap[owner] = '庄家';
                                hasNewStatus = true;
                            }
                        } else {
                            // 如果之前被自动标记为庄家，现在不满足条件了，是否要变回散户？
                            // 策略：如果手动状态是散户（默认），且不再满足自动庄家条件，则设为散户
                            merged.status = '散户';
                        }
                    }
                }

                this.dataMap.set(owner, merged);
            } catch (err) {
            }
        });

        // 批量保存新状态
        if (hasNewStatus) {
            this.saveStatus();
        }
        
    }

    /**
     * 处理 Trade 历史 (增量数据)
     * @param {Array} history - 原始 trade history 数组
     */
    updateTrades(history) {
        if (!Array.isArray(history)) return 0;

        // 按时间降序排序 (先处理最新的交易，优先确定持有状态)
        const sortedTrades = [...history].sort((a, b) => b.timestamp - a.timestamp);
        let newCount = 0;
        let skippedCount = 0; // 统计跳过的交易
        let hasNewStatus = false;

        sortedTrades.forEach(tx => {
            if (this.processedTxHashes.has(tx.tx_hash)) return;
            this.processedTxHashes.add(tx.tx_hash);
            // newCount 在下面确认未被跳过后再增加

            const maker = tx.maker;
            if (!maker) return;

            const event = tx.event;
            const amountUsd = parseFloat(tx.amount_usd || 0);
            const baseAmount = parseFloat(tx.base_amount || 0);
            
            // 记录 Gas 费
            // 严格使用 gas_native (Solana)，如果为空则不参与判断
            let feeSol = 0;
            if (tx.gas_native) {
                // gas_native 通常是 SOL 值 (字符串)
                feeSol = parseFloat(tx.gas_native);
            }

            let user = this.dataMap.get(maker);
            if (!user) {
                // 新用户
                user = {
                    owner: maker,
                    address: maker,
                    source: 'trade',
                    is_trade_only: true,
                    status: this.getStatus(maker), // 使用缓存的状态
                    main_address_short: this.getShortAddress(maker),
                    total_buy_u: 0,
                    netflow_amount: 0,
                    ui_amount: 0,
                    buy_tx_count: 0,
                    sell_tx_count: 0,
                    last_active_timestamp: tx.timestamp,
                    last_snapshot_ts: 0, // 初始化为 0
                    // 初始化分数字段
                    score: 0,
                    score_reasons: [],
                    max_gas_fee: 0,
                    is_holding: true, // 默认为 true，后续根据 balance 判断
                    last_trade_processed_ts: 0 // 记录最后一次用于判定持有状态的交易时间戳
                };
            }

            // *** 核心：增量更新防重逻辑 ***
            // 如果该 Trade 的时间戳 <= 用户的快照时间戳，说明该 Trade 已经被包含在 Holders 快照数据中，跳过累加
            // 注意：tx.timestamp 是秒，last_snapshot_ts 是毫秒
            const txTimeMs = tx.timestamp * 1000;
            if (user.last_snapshot_ts && txTimeMs <= user.last_snapshot_ts) {
                // 已被快照包含，跳过数值累加
                skippedCount++;
            } else {
                // 正常的增量累加
                newCount++;
                // console.log(`[GMGN 调试] 交易生效: 用户 ${this.getShortAddress(maker) || maker.slice(0,4)}, ${event} ${amountUsd.toFixed(2)} USD`);
                
                if (event === 'buy') {
                    user.total_buy_u = (parseFloat(user.total_buy_u || 0) + amountUsd).toFixed(4);
                    user.netflow_amount = (parseFloat(user.netflow_amount || 0) + amountUsd).toFixed(4);
                    user.ui_amount = (parseFloat(user.ui_amount || 0) + baseAmount).toFixed(4);
                    user.buy_tx_count = (user.buy_tx_count || 0) + 1;
                } else if (event === 'sell') {
                    user.netflow_amount = (parseFloat(user.netflow_amount || 0) - amountUsd).toFixed(4);
                    user.ui_amount = (parseFloat(user.ui_amount || 0) - baseAmount).toFixed(4);
                    user.sell_tx_count = (user.sell_tx_count || 0) + 1;
                }

                // [新增] 动态更新持有状态 (支持 Holder 清仓检测)
                // 允许所有来源用户根据最新交易的 balance 判断是否离场
                // 规则：最新交易为卖出 且 balance 为 0 -> 非持有
                // [修复] 增加时间戳检查：
                // 1. currentTxTs > lastProcessedTs (防乱序)
                // 2. currentTxTs > user.last_snapshot_ts (防快照覆盖：只有快照之后发生的交易才能修改持有状态)
                
                const currentTxTs = tx.timestamp || 0;
                const lastProcessedTs = user.last_trade_processed_ts || 0;
                const snapshotTs = (user.last_snapshot_ts || 0) / 1000; // 转换为秒

                if (currentTxTs >= lastProcessedTs && currentTxTs > snapshotTs) {
                    if (tx.balance !== undefined && tx.balance !== null && tx.balance !== '') {
                        const balance = parseFloat(tx.balance);
                        // [修改] 统一判定逻辑：只要余额极小 (<= 0.000001)，无论 buy/sell 都视为清仓
                        // 覆盖了 event="buy" 但 balance="0" 的情况，以及 sell 后微小残留的情况
                        if (balance <= 0.000001) {
                            user.is_holding = false;
                        } else {
                            user.is_holding = true;
                        }
                        // 更新最后处理的时间戳
                        user.last_trade_processed_ts = currentTxTs;
                    }
                }
            }

            // 更新 Max Gas Fee (Holders 列表不含此数据，始终更新)
            if (feeSol > 0) {
                user.max_gas_fee = Math.max(user.max_gas_fee || 0, feeSol);
                
                // 实时 High Gas (改为 Low Gas) 判定
                // 直接在此处检查是否触发 Low Gas 规则
                const config = this.bossConfig;
                if (config.rule_gas && (config.rule_gas.enabled || config.rule_gas.weight > 0)) {
                    // 逻辑调整：Gas 费 < 阈值 (且 > 0)
                    if (user.max_gas_fee > 0 && user.max_gas_fee < (config.rule_gas.threshold || 0.01)) {
                        // 检查是否已经添加过 LowGas 原因
                        const hasReason = user.score_reasons.some(r => r.startsWith('LowGas'));
                        if (!hasReason) {
                            user.score += (config.rule_gas.weight || 0);
                            user.score_reasons.push(`LowGas(${user.max_gas_fee.toFixed(6)})`);
                            
                            if (config.rule_gas.enabled) {
                                if (user.status !== '庄家') {
                                    user.status = '庄家';
                                    this.statusMap[maker] = '庄家';
                                    hasNewStatus = true;
                                }
                            }
                        }
                    }
                }
            }

            // 检查 creator 标签并标记为庄家
            if (tx.maker_token_tags && tx.maker_token_tags.includes('creator')) {
                if (user.status !== '庄家') {
                    user.status = '庄家';
                    this.statusMap[maker] = '庄家';
                    hasNewStatus = true;
                }
            }

            user.last_active_timestamp = Math.max(user.last_active_timestamp || 0, tx.timestamp);
            user.last_updated = Date.now();

            this.dataMap.set(maker, user);
        });

        // 批量保存新状态
        if (hasNewStatus) {
            chrome.storage.local.set({ holder_status: this.statusMap });
        }

        // 维护 Set 大小
        if (this.processedTxHashes.size > this.maxTxHistory) {
            const arr = Array.from(this.processedTxHashes);
            for (let i = 0; i < 500; i++) this.processedTxHashes.delete(arr[i]);
        }
        
        if (newCount > 0 || skippedCount > 0) {
        }
        
        return newCount;
    }

    /**
     * 获取排序后的 UI 渲染数据
     */
    getSortedItems() {
        const items = Array.from(this.dataMap.values());
        return items.sort((a, b) => {
            // [修改] 优先按最后活跃时间 (last_active_timestamp) 降序排序
            const ta = a.last_active_timestamp || 0;
            const tb = b.last_active_timestamp || 0;
            if (tb !== ta) {
                return tb - ta;
            }

            // 其次按占比（holding_share_pct）从大到小排序
            const ap = parseFloat(a.holding_share_pct || 0);
            const bp = parseFloat(b.holding_share_pct || 0);
            if (Math.abs(ap - bp) > 0.000001) {
                return bp - ap;
            }
            // 最后按数量
            try {
                const ai = parseFloat(a.ui_amount || a.amount || 0);
                const bi = parseFloat(b.ui_amount || b.amount || 0);
                return bi - ai;
            } catch (_) {
                return 0;
            }
        });
    }

    /**
     * 获取状态映射（用于传递给 HeliusIntegration）
     */
    getStatusMap() {
        return this.statusMap || {};
    }

    /**
     * 获取仅在 Trade 中出现的用户地址（用于 UI 标记）
     */
    getTradeOnlyUsers() {
        const list = [];
        for (const user of this.dataMap.values()) {
            if (user.is_trade_only) {
                list.push(user.owner);
            }
        }
        return list;
    }

    /**
     * 清空所有数据 (Mint 切换时调用)
     */
    clearData() {
        this.dataMap.clear();
        this.processedTxHashes.clear();
    }
}
