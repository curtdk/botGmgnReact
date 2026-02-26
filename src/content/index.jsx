import { getMintFromPage, getPriceFromPage, findPriceDOM, normalize } from '../utils/api';
import ContentScoreManager from './ContentScoreManager';
import FlowerMarker from './FlowerMarker';
import './HeliusIntegration.js'; // 导入 Helius 集成

// -------------------------------------------------------------------------
// GMGN Content Script (Headless)
// 负责数据采集、Hook注入、DOM监听，并将数据转发给 Side Panel
// -------------------------------------------------------------------------

// 初始化本地数据管理器（只负责数据处理，不获取数据）
const contentManager = new ContentScoreManager();
// 初始化小花标记器
const flowerMarker = new FlowerMarker();

// 检查扩展上下文是否有效
const isContextValid = () => {
    return !!chrome.runtime?.id;
};

// 辅助函数：安全发送响应 (防止 Disconnected port error)
const safeSendResponse = (sendResponse, data) => {
    try {
        if (isContextValid()) {
            sendResponse(data);
        }
    } catch (error) {
        // 忽略连接断开的错误
        if (!error.message.includes('disconnected port') && !error.message.includes('Receiving end does not exist')) {
            console.warn('[GMGN Content] Failed to send response:', error);
        }
    }
};

// 安全发送消息
const safeSendMessage = async (msg) => {
    if (!isContextValid()) {
        // 上下文已失效，停止发送消息
        return;
    }
    try {
        await chrome.runtime.sendMessage(msg);
        console.log('[GMGN Content] Sending message type:', msg.type);
    } catch (err) {
        // 忽略特定的连接错误（如 Side Panel 未打开）
        if (err.message.includes('Receiving end does not exist')) {
            // 正常情况，无需报错
        } else {
            // console.debug('[GMGN Content] Send message failed:', err.message);
        }
    }
};

/**
 * 注入 Hook 脚本
 * 用于捕获网络请求中的 Token Holders 数据
 */
const injectHookScript = () => {
    try {
      if (!isContextValid()) return;
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('hook.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
      console.log('[GMGN Content] Hook script injected');
    } catch (e) { console.warn('Hook injection failed', e); }
};

// 立即注入 Hook
injectHookScript();

// -------------------------------------------------------------------------
// 观察者模式集成 (Observer Feature) - 内联重构版
// -------------------------------------------------------------------------

// 全局变量
let pageObserver = null;
let pageScanTimer = null;
let observerEnabled = false;
let observerInterval = 500;
const shortNameCache = new Map();
let isFetchingTrades = false; // 全局锁，防止 Trades 请求并发
let isFetchingRemarks = false; // [新增] 全局锁，防止备注同步并发
let currentTradesTaskMint = null; // [新增] 记录当前 Trades 任务所属的 Mint，用于切换页面时终止旧任务

/**
 * 提取链接中的地址
 */
const extractAddress = (href) => {
    const match = href.match(/\/sol\/address\/([A-Za-z0-9]+)/);
    return match ? match[1] : null;
};

/**
 * 提取有效的短名称/备注
 */
const extractMainShort = (str) => {
    // 1. 尝试标准 "ABCD...WXYZ" 格式 (这种不需要保存，因为是默认显示)
    var m = str.match(/(?:^|\s)\d{0,3}\s*([1-9A-HJ-NP-Za-km-z]{4,})\.\.\.([1-9A-HJ-NP-Za-km-z]{4})/);
    if(m) return null; 
    
    // 2. 尝试仅有前缀的情况
    var m2 = str.match(/^(\d*[1-9A-HJ-NP-Za-km-z]+)/);
    if(m2){ 
        // 去除开头的数字
        const s = m2[1].replace(/^\d+/, '');
        if (s.length > 30) return null;
        // 非标准格式(前缀/备注)需要持久化
        return { shortAddr: s, shouldSave: true };
    }
    return null;
};

/**
 * 标记新交易用户 (小花 + 火焰)
 * 委托给 FlowerMarker 处理
 */
const markTradeUsers = () => {
    if (!observerEnabled) return;
    // 传递配置给 FlowerMarker
    flowerMarker.mark(contentManager.dataMap, contentManager.bossConfig);
};

/**
 * 执行页面扫描
 */
const scanPageData = () => {
    if (!observerEnabled || !isContextValid()) return;
    
    // 执行小花标记
    markTradeUsers();

    // console.log('[GMGN Observer] Scanning...');
    const addressLinks = document.querySelectorAll('a[href*="/sol/address/"]');
    // const updates = []; // 废弃
    let shouldRefreshUI = false;

    addressLinks.forEach(link => {
        const address = extractAddress(link.href);
        if (!address) return;

        // 1. 获取已保存的短名称
        const savedShort = shortNameCache.get(address) || null;

        // 尝试获取所在行文本
        const row = link.closest('.flex.flex-row') || link.parentElement;
        if (row) {
            let currentText = (row.textContent || '').trim();
            
            // 2. 尝试提取当前显示的有效短名称
            const extracted = extractMainShort(currentText);

            if (extracted && extracted.shouldSave) {
                // 情况 A: 页面显示了一个有效的用户备注
                if (extracted.shortAddr !== savedShort) {
                    // 如果与已保存的不同，说明用户刚刚修改了它 -> 视为新更新
                    
                    // 直接更新 Manager (内存 + 异步存储)
                    contentManager.setShortAddress(address, extracted.shortAddr);
                    
                    // 更新本地缓存以避免重复处理
                    shortNameCache.set(address, extracted.shortAddr);
                    
                    console.log(`[GMGN Observer] Found new remark for ${address.slice(0,4)}: ${extracted.shortAddr}`);
                    
                    // 标记需要刷新 UI
                    shouldRefreshUI = true;
                }
            }
        }
    });

    if (shouldRefreshUI) {
        // 发送全量融合数据给 SidePanel 刷新 UI
        safeSendMessage({
            type: 'UI_RENDER_DATA',
            data: contentManager.getSortedItems()
        });
    }
};

/**
 * 调度扫描 (防抖)
 */
const schedulePageScan = () => {
    if (pageScanTimer) clearTimeout(pageScanTimer);
    pageScanTimer = setTimeout(() => {
        scanPageData();
        pageScanTimer = null;
    }, observerInterval);
};

/**
 * 启动/重启页面观察者
 */
const setupPageObserver = () => {
    if (!isContextValid()) return;
    
    // 1. 清理旧状态
    if (pageObserver) {
        pageObserver.disconnect();
        pageObserver = null;
    }
    if (pageScanTimer) {
        clearTimeout(pageScanTimer);
        pageScanTimer = null;
    }

    // 2. 检查开关
    chrome.storage.local.get(['observer_enabled', 'observer_interval'], (res) => {
        if (!isContextValid()) return;
        
        if (res.observer_interval) observerInterval = res.observer_interval;
        observerEnabled = res.observer_enabled !== false;
        
        // 同步状态给 FlowerMarker
        flowerMarker.setEnabled(observerEnabled);

        if (!observerEnabled) {
            console.log('[GMGN Observer] Disabled');
            return;
        }

        // 3. 寻找目标节点 (.g-table-body)
        const targetNode = document.querySelector('.g-table-body');
        if (targetNode) {
            pageObserver = new MutationObserver(() => schedulePageScan());
            pageObserver.observe(targetNode, { childList: true, subtree: true, characterData: true });
            console.log('[GMGN Observer] Started & Attached to .g-table-body');
            
            // [新增] 发送监听成功状态
            safeSendMessage({
                type: 'PAGE_OBSERVER_STATUS',
                status: 'ok',
                msg: '运行中'
            });

            // 立即扫描一次
            schedulePageScan();
        } else {
            // 如果还没加载出来，稍后重试 (类似 Price Observer 的重试逻辑)
            console.log('[GMGN Observer] Target not found, retrying in 2s...');
            
            // [新增] 发送监听失败状态
            safeSendMessage({
                type: 'PAGE_OBSERVER_STATUS',
                status: 'error',
                msg: '寻找列表...'
            });

            setTimeout(setupPageObserver, 2000);
        }
    });
};

// 初始化配置
setupPageObserver();

// 监听配置变化 (Content Script 独立监听)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.observer_enabled || changes.observer_interval) {
            setupPageObserver();
        }
    }
});

// -------------------------------------------------------------------------
// 数据监听与转发
// -------------------------------------------------------------------------

// 内存暂存最新数据 (Pull 机制)
let lastCapturedData = null;

/**
 * 监听 Hook 捕获的数据 (HOOK_FETCH_XHR_EVENT)
 */
window.addEventListener('HOOK_FETCH_XHR_EVENT', (e) => {
    // 增加详细的调试日志
    console.log('%c[GMGN Content] Received HOOK event:', 'color: green; font-weight: bold;', e.detail?.url);

    // 首先检查上下文是否有效
    if (!isContextValid()) return;

    const detail = e.detail;
    if (!detail || !detail.url) return;

    // 仅处理 token_holders 相关请求
    if (detail.url.includes('/token_holders')) {
        try {
            if (!detail.responseBody) return;
            const json = JSON.parse(detail.responseBody);
            
            // 使用 api.js 中的 normalize 函数标准化数据
            const items = normalize(json);
            
            if (items && items.length > 0) {
                console.log(`[GMGN Content] 监听到 HOOK_FETCH_XHR_EVENT 更新 Captured ${items.length} items from hook`);
                
                // 1. 更新本地 Manager (基准数据)
                // contentManager.updateHolders(items);

                // 更新内存暂存
                lastCapturedData = {
                    data: contentManager.getSortedItems(), // 暂存融合后的全量数据
                    url: detail.url,
                    timestamp: Date.now()
                };

                // 2. 发送全量融合数据 (UI_RENDER_DATA)
                // 这里发送的是经过 ContentScoreManager 处理（去重、聚类、排序）后的最终数据
                // Side Panel 收到后直接 set 即可，无需再次计算
                safeSendMessage({
                    type: 'UI_RENDER_DATA',
                    data: contentManager.getSortedItems(),
                    url: detail.url
                });

                // 3. 触发一次页面标记
                // markTradeUsers();
            }
        } catch (err) {
            console.error('[GMGN Content] Failed to parse hook data', err);
        }
    } 
    // [新增] 处理 token_trades 相关请求
    else if (detail.url.includes('/token_trades')) {
        try {
            console.log(`[GMGN Content] /token_trades from token_trades`);

            if (!detail.responseBody) return;
            const json = JSON.parse(detail.responseBody);
            
            // 直接获取 data 字段 (通常是数组)
            const trades = json.data?.history || json.data || json; // 兼容不同结构
            
            if (trades && (Array.isArray(trades) || trades.length > 0)) {
                console.log(`[GMGN Content] 监听到 HOOK_FETCH_XHR_EVENT 更新 Captured ${trades.length} trades from token_trades`);
                
                // 1. 更新本地 Manager (增量数据)
                // contentManager.updateTrades(trades);

                // 2. 发送全量融合数据 (ALL_DATA_UPDATE)
                safeSendMessage({
                    type: 'UI_RENDER_DATA',
                    data: contentManager.getSortedItems(),
                    url: detail.url
                });

                // 3. 触发一次页面标记
                markTradeUsers();
            }
        } catch (err) {
            console.error('[GMGN Content] Failed to parse trades data', err);
        }
    }
    // [新增] 处理 get_remark_info 相关请求
    else if (detail.url.includes('/get_remark_info')) {
        // 检查开关状态
        chrome.storage.local.get(['auto_sync_remarks'], (res) => {
            if (res.auto_sync_remarks) {
                if (isFetchingRemarks) {
                    console.log('[GMGN Content] Remark sync already in progress, skipping hook trigger.');
                    return;
                }
                console.log('[GMGN Content] Hook triggered remark sync...');
                // [修改] 传递 requestHeaders
                fetchFullRemarks(detail.url, detail.requestHeaders);
            }
        });
    }
});

// -------------------------------------------------------------------------
// 备注同步逻辑
// -------------------------------------------------------------------------

/**
 * 全量获取并同步备注
 * @param {string} initialUrl - 捕获到的初始请求 URL
 * @param {object} headers - [新增] 原始请求头
 */
const fetchFullRemarks = async (initialUrl, headers = {}) => {
    if (isFetchingRemarks) return;
    isFetchingRemarks = true;

    // 通知开始
    safeSendMessage({
        type: 'LOG',
        message: '开始同步 GMGN 备注...',
        level: 'info'
    });

    let count = 0;
    let page = 0;
    let nextCursor = ''; 
    let currentUrl = initialUrl;

    // 初始处理：强制 limit=50 (可选，如果 URL 中已有 limit 可保留)
    // 这里简单处理：先解析一次以确保 limit 参数存在
    try {
        const tempUrl = new URL(currentUrl, window.location.origin);
        tempUrl.searchParams.set('limit', '50');
        // 保持相对路径
        currentUrl = tempUrl.pathname + tempUrl.search;
    } catch (e) {
        console.warn('[GMGN Content] Failed to set limit param:', e);
    }

    try {
        do {
            page++;
            
            // 如果有下一页 cursor，更新 URL
            if (nextCursor) {
                const u = new URL(currentUrl, window.location.origin);
                u.searchParams.set('cursor', nextCursor);
                currentUrl = u.pathname + u.search;
            }

            console.log(`[GMGN Content] Fetching remarks page ${page}...`, currentUrl);

            const res = await fetch(currentUrl, {
                method: 'GET',
                credentials: 'include',
                headers: headers // [新增] 附带原始请求头
            });
            const json = await res.json();

            if (json.code !== 0 || !json.data) {
                console.warn('[GMGN Content] Remark fetch failed:', json);
                break;
            }

            const list = json.data.remark_info || [];
            nextCursor = json.data.cursor;

            if (list.length > 0) {
                // [修改] 使用批量更新方法，提高性能并去重
                const updates = list.map(item => ({
                    address: item.address,
                    remark: item.remark
                })).filter(item => item.address && item.remark);
                
                const updatedCount = contentManager.updateShortAddresses(updates);
                count += updatedCount;
                
                // 实时反馈
                safeSendMessage({
                    type: 'LOG',
                    message: `正在同步备注: 第 ${page} 页，本页新增/更新 ${updatedCount} 条...`,
                    level: 'info'
                });
            } else {
                // 没有数据了
                break;
            }

            // 稍微延时，防止请求过快
            await new Promise(r => setTimeout(r, 1000));

        } while (nextCursor);

        console.log(`[GMGN Content] Remark sync completed. Total: ${count}`);
        
        // 通知完成
        safeSendMessage({
            type: 'LOG',
            message: `GMGN 备注同步完成！共更新 ${count} 条数据`,
            level: 'success'
        });

        // 刷新 UI
        safeSendMessage({
            type: 'UI_RENDER_DATA',
            data: contentManager.getSortedItems()
        });

    } catch (err) {
        console.error('[GMGN Content] Remark sync failed:', err);
        safeSendMessage({
            type: 'LOG',
            message: `备注同步失败: ${err.message}`,
            level: 'error'
        });
    } finally {
        isFetchingRemarks = false;
    }
};

// -------------------------------------------------------------------------
// 价格监听 (Price Observer)
// -------------------------------------------------------------------------

let priceObserver = null;
let lastPrice = 0;

/**
 * 读取并广播当前价格
 */
const updatePrice = () => {
    if (!isContextValid()) {
        if (priceObserver) {
            priceObserver.disconnect();
            priceObserver = null;
        }
        return;
    }

    const price = getPriceFromPage();
    // [Debug] 每次检查都打印，方便调试
    // console.log(`[GMGN Content] updatePrice check. Got: ${price}, Last: ${lastPrice}`);

    // [修改] 移除 price > 0 的限制，允许价格归零或变化
    // 只要价格有变化（包括变成0，或者从0变成非0），都推送
    // 并且如果是首次（lastPrice=0），也推送
    if (price !== lastPrice) {
        console.log(`[GMGN Content] Price changed: ${lastPrice} -> ${price}`);
        lastPrice = price;
        safeSendMessage({
            type: 'PRICE_UPDATE',
            price: price
        });
    }
};

/**
 * 设置 DOM 变动观察器以监听价格变化
 */
const setupPriceObserver = () => {
    if (!isContextValid()) return;

    if (priceObserver) {
        priceObserver.disconnect();
        priceObserver = null;
    }

    const target = findPriceDOM();
    if (target) {
        // [Debug] 打印找到的 DOM 文本预览，确认是否是新页面的元素
        console.log('[GMGN Content] Price DOM target found. Text preview:', (target.textContent || '').slice(0, 50).trim());

        priceObserver = new MutationObserver(updatePrice);
        priceObserver.observe(target, { subtree: true, characterData: true, childList: true });
        updatePrice(); // 立即检查一次
        console.log('[GMGN Content] Price observer started');
        
        // [新增] 发送监听成功状态
        safeSendMessage({
            type: 'PRICE_DOM_STATUS',
            status: 'ok',
            msg: '已监听'
        });
    } else {
        // 如果 DOM 尚未准备好，延迟重试
        console.log('[GMGN Content] Price DOM not found, retrying...');
        
        // [新增] 发送监听失败状态
        safeSendMessage({
            type: 'PRICE_DOM_STATUS',
            status: 'error',
            msg: '寻找DOM...'
        });
        
        setTimeout(setupPriceObserver, 2000);
    }
};

// 页面加载完成后启动价格监听
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupPriceObserver);
} else {
    setupPriceObserver();
}

// -------------------------------------------------------------------------
// 消息通信 (响应 Side Panel 请求)
// -------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isContextValid()) return;

    if (msg.type === 'GET_PAGE_STATE') {
        // Side Panel 初始化时会主动请求当前页面状态
        const mint = getMintFromPage();
        const price = getPriceFromPage();

        // [修改] 不再返回 lastCapturedData（来自 ContentScoreManager，未过滤）
        // 而是从 HeliusIntegration 获取过滤后的数据
        let hookData = null;
        if (window.__heliusIntegration && window.__heliusIntegration.monitor) {
            const traderStats = window.__heliusIntegration.monitor.metricsEngine.traderStats;
            const filteredUsers = window.__heliusIntegration.monitor.metricsEngine.filteredUsers;

            // traderStats 已合并 holder 数据，是唯一数据源
            const holdersData = Object.entries(traderStats)
                .filter(([address]) => filteredUsers.has(address))
                .map(([, stats]) => ({
                    ...stats,
                    status: stats.status || '散户',
                    score: stats.score || 0,
                    score_reasons: stats.score_reasons || []
                }));

            if (holdersData.length > 0) {
                hookData = {
                    data: holdersData,
                    url: lastCapturedData?.url || null,
                    timestamp: Date.now()
                };
            }
        }

        // 返回基础信息 + 过滤后的数据
        sendResponse({
            mint,
            price,
            hookData: hookData
        });
    }
    else if (msg.type === 'REFRESH_PRICE_OBSERVER') {
        // 强制重启价格监听
        setupPriceObserver();
        sendResponse({ success: true });
    }
    // [新增] 处理 URL 变化 (Mint 切换)
    else if (msg.type === 'TAB_URL_CHANGED') {
        const mint = msg.mint;
        if (mint && mint !== lastMint) {
            console.log('[GMGN Content] TAB_URL_CHANGED: Mint changed:', mint);
            lastMint = mint;
            hasFetchedFullTradesHistory = false; // 重置全量获取标记
            currentTradesTaskMint = null; // [新增] 使旧任务失效
            isFetchingTrades = false;     // [新增] 强制释放锁

            // 1. 清空数据
            contentManager.clearData();
            lastCapturedData = null;
            lastPrice = 0; // [新增] 重置价格，确保切换新页面后能重新推送价格

            // 2. 清除页面标记 (使用 FlowerMarker)
            flowerMarker.clearAll();

            // 3. 通知 Side Panel
            safeSendMessage({
                type: 'MINT_CHANGED',
                mint: mint
            });
            
            // [新增] 设置状态为等待中
            safeSendMessage({
                type: 'PRICE_DOM_STATUS',
                status: 'pending',
                msg: '切换中...'
            });
            
            // [新增] 设置页面观察者状态为等待中
            safeSendMessage({
                type: 'PAGE_OBSERVER_STATUS',
                status: 'pending',
                msg: '切换中...'
            });

            // 4. 延迟重启监听 (关键：等待 SPA 页面渲染完成)
            // 如果立即重启，可能获取到的是旧页面的 DOM 元素，导致后续更新失效
            if (priceObserver) {
                priceObserver.disconnect();
                priceObserver = null;
            }
            
            console.log('[GMGN Content] Waiting for DOM render (1.5s)...');
            setTimeout(() => {
                console.log('[GMGN Content] Restarting observers after delay...');
                setupPriceObserver();
                setupPageObserver();
                
                // [新增] 立即尝试获取一次价格
                updatePrice();
            }, 1500);
        }
        sendResponse({ success: true });
    }
    // [新增] 处理手动标记分数
    else if (msg.type === 'SET_MANUAL_SCORE') {
        const { address, status } = msg;
        console.log('[GMGN Content] SET_MANUAL_SCORE 接收到请求', { address, status });

        // 通知 HeliusIntegration 设置手动标记
        if (window.__heliusIntegration) {
            window.__heliusIntegration.setManualScore(address, status);
            sendResponse({ success: true });
        } else {
            console.warn('[GMGN Content] window.__heliusIntegration 不存在');
            sendResponse({ success: false, error: 'HeliusIntegration not found' });
        }
    }
    // 必须返回 true 以支持异步 sendResponse (虽然这里是同步的，但保持习惯)
    return true; 
});

// -------------------------------------------------------------------------
// 代理请求 (解决 Side Panel 跨域/Cookie/路径问题)
// -------------------------------------------------------------------------


 

function quickClean(url) {
  return url
    .replace(/&?makers=[^&]+/g, '')   // 删除 makers=xxx
    .replace(/&?event=[^&]+/g, '')     // 删除所有 event=xxx
    .replace(/[?&]$/, '')              // 清理结尾多余的 ? 或 &
    .replace(/&&/g, '&');              // 清理连续的 &&
}


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'EXECUTE_HOOK_REFRESH') {
        const url = msg.url;
        if (!url) {
            sendResponse({ success: false, error: 'No URL provided' });
            return;
        }

        console.log('[GMGN Content] EXECUTE_HOOK_REFRESH 接收到请求', { url });

        // 使用页面环境的 fetch，自带 Cookie 和同源权限
        fetch(url, {
            method: 'GET',
            credentials: 'include'
        })
        .then(res => res.text()) // 先拿 text，防止 json 解析失败
        .then(text => {
            try {
                // 尝试解析 JSON
                // 验证是否是有效的 API 响应
                const json = JSON.parse(text);

                // 调试日志：显示 API 响应结构
                console.log('[GMGN Content] API 响应结构:', {
                    hasData: !!json.data,
                    hasDataList: !!json.data?.list,
                    hasList: !!json.list,
                    isDataArray: Array.isArray(json.data),
                    isArray: Array.isArray(json),
                    keys: Object.keys(json).slice(0, 5)
                });

                // 复用现有的 HOOK_DATA 通道回传数据
                // 这样 Side Panel 的处理逻辑不用变

                // [修改] 尝试多种可能的 API 结构
                let items = null;
                if (json.data && Array.isArray(json.data.list)) {
                    items = json.data.list;
                    console.log('[GMGN Content] 使用 json.data.list 结构');
                } else if (Array.isArray(json.data)) {
                    items = json.data;
                    console.log('[GMGN Content] 使用 json.data 结构');
                } else if (Array.isArray(json.list)) {
                    items = json.list;
                    console.log('[GMGN Content] 使用 json.list 结构');
                } else if (Array.isArray(json)) {
                    items = json;
                    console.log('[GMGN Content] 使用 json 结构（直接数组）');
                }

                // [修复] 使用 normalize 函数统一字段名
                if (items && Array.isArray(items) && items.length > 0) {
                    // 导入 normalize 函数（需要在文件顶部添加 import）
                    // 临时方案：手动 normalize
                    items = items.map(x => {
                        const owner = x.owner || x.address || x.wallet_address;
                        return {
                            ...x,
                            owner: owner  // 确保有 owner 字段
                        };
                    });
                }

                console.log('[GMGN Content] 解析结果:', {
                    itemCount: items ? items.length : 0,
                    firstItemKeys: items && items[0] ? Object.keys(items[0]).slice(0, 10) : null,
                    firstItemOwner: items && items[0] ? items[0].owner : null
                });

                if (items && Array.isArray(items) && items.length > 0) {
                    console.log('[GMGN Content] 开始处理 holder 数据', { count: items.length });

                    // 只调用 HeliusIntegration,不再调用 contentManager
                    // 转发 holder 数据给 HeliusIntegration
                    window.dispatchEvent(new CustomEvent('HOOK_HOLDERS_EVENT', {
                        detail: {
                            holders: items
                        }
                    }));

                    // 更新 Helius 集成的持有者列表
                    if (window.__heliusIntegration) {
                        console.log('[GMGN Content] 调用 updateGmgnHolders', { holderCount: items.length });
                        window.__heliusIntegration.updateGmgnHolders(items);
                    } else {
                        console.warn('[GMGN Content] window.__heliusIntegration 不存在');
                    }

                    console.log(`[GMGN Content] Proxy fetch success: ${items.length} items (Merged)`);
                    sendResponse({ success: true, count: items.length });
                } else {
                    console.warn('[GMGN Content] 没有有效的 holder 数据', {
                        items: items,
                        jsonKeys: Object.keys(json)
                    });
                    sendResponse({ success: false, error: 'No valid holder data' });
                }
            } catch (e) {
                console.error('[GMGN Content] Proxy fetch parse error', e);
                sendResponse({ success: false, error: e.message });
            }
        })
        .catch(err => {
            console.error('[GMGN Content] Proxy fetch failed', err);
            sendResponse({ success: false, error: err.message });
        });
        return true; // 保持通道开启
    } else if (msg.type === 'UPDATE_STATUS') {
        // [新增] 接收状态更新消息
        const { owner, status } = msg;
        if (owner && status) {
            contentManager.setStatus(owner, status);
            // 异步持久化，不阻塞响应
            contentManager.saveStatus();
            console.log(`[GMGN Content] Status synced via message: ${owner} -> ${status}`);
            sendResponse({ success: true });
        }
    } else if (msg.type === 'EXECUTE_TRADES_REFRESH') {
        const requestTime = new Date().toISOString();
        console.log(`[GMGN Content] ========== EXECUTE_TRADES_REFRESH received at ${requestTime} ==========`);

        // [新增] 并发锁检查
        if (isFetchingTrades) {
            console.log('[GMGN Content] ❌ EXECUTE_TRADES_REFRESH ignored (already fetching)');
            sendResponse({ success: false, error: 'Already fetching' });
            return;
        }

        // [新增] 代理获取 Trades 数据
        const url = msg.url;
        if (!url) {
            console.log('[GMGN Content] ❌ No URL provided');
            sendResponse({ success: false, error: 'No URL provided' });
            return;
        }

        // [新增] 绑定当前任务到当前 Mint
        const currentMint = getMintFromPage();
        if (!currentMint) {
            console.log('[GMGN Content] ❌ No mint found on page');
            sendResponse({ success: false, error: 'No mint on page' });
            return;
        }

        console.log(`[GMGN Content] ✓ Starting trades fetch for mint: ${currentMint.slice(0, 8)}...`);
        console.log(`[GMGN Content] ✓ URL: ${url}`);

        // 加锁
        isFetchingTrades = true;
        currentTradesTaskMint = currentMint;

        // 辅助函数：睡眠
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        // 异步执行获取逻辑 (立即返回 sendResponse 以防止超时)
        (async () => {
            let nextCursor = null;
            let pageCount = 0;
            const baseUrl = quickClean(url);

            try {
                // [修复] 在开始前再次检查 mint 是否仍然匹配
                const startMint = getMintFromPage();
                if (currentTradesTaskMint !== startMint) {
                    console.log('[GMGN Content] Trades fetch aborted before start (Mint changed).');
                    return;
                }

                console.log(`[GMGN Content] Starting trades fetch for mint: ${currentTradesTaskMint}`);

                do {
                    // [修复] 检查任务是否过期 (Mint 已切换) - 使用实时获取的 mint
                    const pageMint = getMintFromPage();
                    if (currentTradesTaskMint !== pageMint) {
                        console.log(`[GMGN Content] Trades fetch aborted (Mint changed from ${currentTradesTaskMint} to ${pageMint}).`);
                        break;
                    }

                    // 1. 构建当前页 URL
                    let currentUrl = baseUrl;
                    if (nextCursor) {
                        // 使用字符串拼接处理相对路径参数
                        const separator = baseUrl.includes('?') ? '&' : '?';
                        currentUrl = `${baseUrl}${separator}cursor=${encodeURIComponent(nextCursor)}`;
                        
                        // 暂停 1 秒 (仅在获取下一页前暂停)
                        await sleep(1000);
                    }

                    console.log(`[GMGN Content] 📄 Fetching trades page ${pageCount + 1}...`);

                    // 2. 发起请求
                    const res = await fetch(currentUrl, {
                        method: 'GET',
                        credentials: 'include'
                    });
                    const text = await res.text();
                    const json = JSON.parse(text);

                    // 3. 解析数据 (兼容多种结构)
                    let trades = [];
                    // 优先检查 history 字段 (根据用户提供的结构)
                    if (json.history && Array.isArray(json.history)) {
                        trades = json.history;
                        nextCursor = json.next;
                    } else if (json.data && json.data.history && Array.isArray(json.data.history)) {
                        trades = json.data.history;
                        nextCursor = json.data.next;
                    } else {
                        // 兼容旧结构
                        trades = json.data?.history || json.data || json;
                        if (!Array.isArray(trades)) trades = [];
                        nextCursor = json.data?.next || json.next;
                    }

                    // 4. 更新数据 - 直接调用 HeliusIntegration，统一走 HeliusMonitor 数据体系
                    let newCount = 0;
                    if (trades.length > 0) {
                        if (window.__heliusIntegration) {
                            newCount = window.__heliusIntegration.processFetchedTrades(trades) || 0;
                        } else {
                            console.warn('[GMGN Content] window.__heliusIntegration 不存在，trades 数据丢失');
                        }
                        markTradeUsers();
                    }

                    console.log(`[GMGN Content] ✓ Page ${pageCount + 1} fetched: ${trades.length} trades. Next: ${nextCursor ? 'YES' : 'NO'}`);

                    // [新增] 发送进度消息给 SidePanel (仅从第二页开始)
                    if (pageCount > 0) {
                        const lastTxHash = trades.length > 0 ? trades[trades.length - 1].tx_hash : 'N/A';
                        safeSendMessage({
                            type: 'TRADES_FETCH_PROGRESS',
                            page: pageCount + 1,
                            count: trades.length,
                            lastHash: lastTxHash
                        });
                    }

                    // 5. 首次响应 (告诉 SidePanel 请求已开始)
                    if (pageCount === 0) {
                        // 只有当任务仍然有效时，才发送响应
                        if (currentTradesTaskMint === getMintFromPage()) {
                            safeSendResponse(sendResponse, { success: true, count: trades.length });
                        }
                    }

                    pageCount++;

                    // 6. 判断是否继续
                    // [修改] 智能停止策略：如果发现重复数据（newCount < trades.length），说明接上了历史记录
                    const isOverlap = trades.length > 0 && newCount < trades.length;
                    
                    // 核心修改：只有在“已完成过全量同步”的前提下，才允许因重叠而提前停止
                    const shouldStopByOverlap = hasFetchedFullTradesHistory && isOverlap;

                    // 调试日志：如果重叠但因为是首次同步而继续
                    if (isOverlap && !hasFetchedFullTradesHistory) {
                        console.log(`[GMGN Content] Overlap detected but continuing (First Sync). New: ${newCount}/${trades.length}`);
                    }
                    
                    // [新增] 调试日志：如果是最后一组数据（无论是翻页结束还是因重叠停止），打印详细数据
                    // if (!nextCursor || shouldStopByOverlap) {
                    //     console.log(`[GMGN Content] Last batch details (Reason: ${!nextCursor ? 'End of Pages' : 'Overlap Detected'}). Count: ${trades.length}, New: ${newCount}`, trades);
                    // }
                    console.log(`[GMGN Content] Last batch details (Reason: ${!nextCursor ? 'End of Pages' : 'Overlap Detected'}). Count: ${trades.length}, New: ${newCount}`, trades);


                    if (shouldStopByOverlap) {
                        console.log(`[GMGN Content] Overlap detected (new: ${newCount}, total: ${trades.length}). Stopping.`);
                        break; 
                    }

                } while (nextCursor);

                // [新增] 完成日志
                console.log(`[GMGN Content] ========== Trades fetch completed: ${pageCount} pages ==========`);

                // 标记全量历史已获取
                if (!hasFetchedFullTradesHistory) {
                    hasFetchedFullTradesHistory = true;
                    console.log('[GMGN Content] Full trades history synced (first time).');
                }

                // [修复] 总是分发 GMGN 分页数据加载完成事件，不管是否首次
                // 这样可以确保 HeliusMonitor 即使在数据已加载后启动也能收到通知
                window.dispatchEvent(new CustomEvent('GMGN_TRADES_LOADED', {
                    detail: { mint: currentMint }
                }));
                console.log('[GMGN Content] Dispatched GMGN_TRADES_LOADED event');

            } catch (err) {
                console.error('[GMGN Content] ❌ Proxy trades fetch failed:', err);
                if (pageCount === 0) {
                    // 只有当任务仍然有效时，才发送错误响应
                    if (currentTradesTaskMint === getMintFromPage()) {
                        safeSendResponse(sendResponse, { success: false, error: err.message });
                    }
                }
            } finally {
                // [新增] 释放锁
                isFetchingTrades = false;
                console.log(`[GMGN Content] ========== Trades fetch ended, lock released ==========`);
            }
        })();

        return true; // 保持通道开启
    }
});

// -------------------------------------------------------------------------
// 监听 HeliusMonitor 数据更新
// -------------------------------------------------------------------------
window.addEventListener('HELIUS_DATA_UPDATE', (event) => {
  const { holders, statusMap } = event.detail;

  console.log(`[GMGN Content] 收到 HeliusMonitor 数据: ${holders.length} 个用户`);

  // 更新 contentManager
  if (contentManager) {
    // 直接设置 statusMap
    contentManager.statusMap = statusMap;

    // 更新 dataMap
    contentManager.dataMap.clear();
    holders.forEach(holder => {
      contentManager.dataMap.set(holder.owner, holder);
    });

    // 触发 UI 更新
    safeSendMessage({
      type: 'UI_RENDER_DATA',
      data: contentManager.getSortedItems(),
      statusMap: statusMap
    });

    console.log(`[GMGN Content] contentManager 已更新: ${contentManager.dataMap.size} 个用户`);
  }
});

// -------------------------------------------------------------------------
// Mint 地址变化检测 (URL 轮询) - 已废弃，改用 TAB_URL_CHANGED 消息
// -------------------------------------------------------------------------

let lastMint = getMintFromPage();
let hasFetchedFullTradesHistory = false; // 标记是否已获取全量历史

// const mintCheckTimer = setInterval(() => { ... }); // 移除轮询定时器

console.log('[GMGN Content] Service initialized (Headless Mode)');
