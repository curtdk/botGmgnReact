/**
 * HeliusIntegration - 集成 HeliusMonitor 到 GMGN 插件
 *
 * 功能：
 * 1. 检测 GMGN mint 页面
 * 2. 初始化 HeliusMonitor
 * 3. 监听 hook 事件并转发 signatures
 * 4. 在控制台输出关键信息
 */

import HeliusMonitor from '../helius/HeliusMonitor.js';
import { getMintFromPage } from '../utils/api.js';
import dataFlowLogger from '../utils/Logger.js';

class HeliusIntegration {
  constructor() {
    this.monitor = null;
    this.currentMint = null;
    this.isInitialized = false;
    this.enabled = false; // 监控开关状态
    this.lockedMint = null; // 侧边栏锁定的 mint（非 null 时禁止自动切换）
    this._isFirstMintDetection = true; // 整页加载后首次检测到 mint 的标记

    // 事件处理器引用（用于清理）
    this.gmgnTradesLoadedHandler = null;
    this.pageObserver = null;
    this.checkInterval = null;

    // GMGN 持有者数据（用于准确判断谁是持有者）
    this.gmgnHolders = new Set();

    // 庄家分类数据
    this.statusMap = {};  // 地址状态映射 { address: "庄家"|"散户" }
    this.manualStatusMap = {};  // 手动分类（优先级最高）

    // [新增] 数据管理（替代 ContentScoreManager）
    this.dataMap = new Map(); // Address -> UserInfo
    this.shortAddressMap = {}; // 短地址映射
    this.bossConfig = {}; // 庄家检测配置（用于 FlowerMarker）
    this.scoreThreshold = 100; // Score< 过滤阈值
    this.statusThreshold = 50; // 状态判断阈值
    this.apiKey = ''; // Helius API Key

    this.init();
  }

  /**
   * 初始化
   */
  async init() {
    // 获取当前 mint 地址
    const currentMint = getMintFromPage();

    // 从 storage 加载开关状态和配置
    chrome.storage.local.get([
      'helius_monitor_enabled',
      'boss_config',
      'score_threshold',
      'status_threshold',
      'helius_api_key',
      `manual_scores_${currentMint}` // 加载手动标记数据
    ], (res) => {
      this.enabled = res.helius_monitor_enabled || false;
      this.apiKey = res.helius_api_key || '';

      // 合并配置:使用默认配置作为基础,然后覆盖用户配置
      const defaultConfig = this.getDefaultConfig();
      this.bossConfig = {
        ...defaultConfig,
        ...(res.boss_config || {})
      };

      // 深度合并对象类型的规则配置
      ['rule_gas', 'rule_amount_sim', 'rule_large_holding', 'rule_sol_balance', 'rule_source_time'].forEach(key => {
        if (res.boss_config && res.boss_config[key]) {
          this.bossConfig[key] = { ...defaultConfig[key], ...res.boss_config[key] };
        }
      });

      // 如果 Chrome Storage 中没有配置,保存默认配置
      if (!res.boss_config) {
        chrome.storage.local.set({ boss_config: defaultConfig });
      }

      // 统一默认值,明确检查 undefined
      this.scoreThreshold = res.score_threshold !== undefined ? res.score_threshold : 100;
      this.statusThreshold = res.status_threshold !== undefined ? res.status_threshold : 50;

      // 加载手动标记数据
      this.manualStatusMap = res[`manual_scores_${currentMint}`] || {};


    });

    // 监听 hook 事件
    this.setupHookListeners();

    // 检测页面变化
    this.observePageChanges();

    // 监听开关消息
    this.setupMessageListener();

    // 监听配置变化
    this.setupConfigListener();

  }

  /**
   * 设置 hook 事件监听
   *
   * 数据流职责说明：
   *  - HOOK_FETCH_XHR_EVENT：仅由 index.jsx 负责 URL 捕获，HeliusIntegration 不再监听
   *  - HOOK_SIGNATURES_EVENT：已废弃（hook.js 不发送此事件），已删除
   *  - HOOK_HOLDERS_EVENT：已废弃（由 updateGmgnHolders 直接调用替代），已删除
   *  - 实时 trade 数据全部通过 EXECUTE_TRADES_REFRESH → processFetchedTrades() 流入
   *  - Monitor 初始化解锁信号来自 GMGN_TRADES_LOADED（EXECUTE_TRADES_REFRESH 结尾发送）
   */
  setupHookListeners() {
    // GMGN 分页数据加载完成事件（由 EXECUTE_TRADES_REFRESH 结尾触发）
    // 新架构中 Helius 后台任务独立运行，不再需要等待此事件解锁；仅做日志记录
    this.gmgnTradesLoadedHandler = (_event) => {
      if (!this.monitor) return;
      const stats = this.monitor.signatureManager.getStats();
      console.log(`[GMGN] 分页加载完成，SignatureManager sig 总数=${stats.total} 有数据=${stats.withData}`);
      this.sendStatusLog(`GMGN 分页加载完成，sig 总数=${stats.total}`);
      // 通知 HeliusMonitor：GMGN 首次分页全部加载完成，Step 2 可以继续
      this.monitor.notifyGmgnFirstLoad();
    };
    window.addEventListener('GMGN_TRADES_LOADED', this.gmgnTradesLoadedHandler);
  }

  /**
   * 设置消息监听器
   */
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (request.type === 'HELIUS_MONITOR_TOGGLE') {
        this.enabled = request.enabled;
        // 新架构：Helius API 始终启用，toggle 不再影响 heliusApiEnabled
        sendResponse({ success: true });
      }

      // 侧边栏开始：锁定 mint，启动监控
      if (request.type === 'LOCK_MINT') {
        this.lockedMint = request.mint || null;
        // 若当前监控的 mint 与锁定 mint 不同，先切换过来（重新创建 monitor 实例）
        if (this.lockedMint && this.currentMint !== this.lockedMint) {
          this.checkAndInitMonitor();
        }
        // 用户点击"开始"—— 调用 start() 启动后台初始化任务
        if (this.monitor) {
          console.log('[Monitor] 用户点击开始，启动 monitor...');
          this.monitor.start().catch(err => {
            if (err.message && err.message.includes('Extension context invalidated')) return;
            console.error('[Monitor] start() 异常:', err);
            this.sendStatusLog(`❌ 启动失败: ${err?.message || err}`);
          });
        }
        sendResponse({ success: true });
        return true;
      }

      // 侧边栏停止：解锁 mint
      if (request.type === 'UNLOCK_MINT') {
        this.lockedMint = null;
        sendResponse({ success: true });
        return true;
      }

      // 数据流日志开关
      if (request.type === 'DATA_FLOW_LOGGER_TOGGLE') {
        dataFlowLogger.setEnabled(request.enabled);
        sendResponse({ success: true });
        return true;
      }

      // 获取日志
      if (request.type === 'GET_DATA_FLOW_LOGS') {
        sendResponse({
          logs: dataFlowLogger.getLogs(),
          stats: dataFlowLogger.getStats()
        });
        return true;
      }

      // 导出日志
      if (request.type === 'EXPORT_DATA_FLOW_LOGS') {
        dataFlowLogger.downloadLogs();
        sendResponse({ success: true });
        return true;
      }

      // 清空日志
      if (request.type === 'CLEAR_DATA_FLOW_LOGS') {
        dataFlowLogger.clear();
        sendResponse({ success: true });
        return true;
      }

      // 获取校验状态
      if (request.type === 'GET_HELIUS_VERIFY_STATUS') {
        if (this.monitor) {
          sendResponse(this.monitor.getVerifyStatus());
        } else {
          sendResponse({ enabled: false, lastVerifyTime: null, timeSinceLastVerify: null });
        }
        return true;
      }

      // 获取 WebSocket 状态
      if (request.type === 'GET_HELIUS_WS_STATUS') {
        if (this.monitor) {
          sendResponse(this.monitor.getWsStatus());
        } else {
          sendResponse({ connected: false, error: '监控未启动' });
        }
        return true;
      }
    });
  }

  /**
   * 观察页面变化
   */
  observePageChanges() {
    // 初始检查
    this.checkAndInitMonitor();

    // 监听 URL 变化
    let lastUrl = location.href;
    this.pageObserver = new MutationObserver(() => {
      const currentUrl = location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        this.checkAndInitMonitor();
      }
    });

    this.pageObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    // 5s 备用轮询已移除：MutationObserver 足够，lockedMint 守卫防止意外切换
  }

  /**
   * 检查并初始化监控器
   */
  async checkAndInitMonitor() {
    // 检查是否在 mint 页面
    const mint = getMintFromPage();

    if (!mint) {
      // 不在 mint 页面
      if (this.monitor) {
        this.monitor.stop();
        this.monitor = null;
        this.currentMint = null;
        this.isInitialized = false;

        // 清空 SidePanel 数据
        this.sendClearMetrics();
      }
      return;
    }

    // 如果是同一个 mint，不重新初始化
    if (mint === this.currentMint && this.monitor) {
      return;
    }

    // 已锁定 mint 时，禁止自动切换到其他 mint
    if (this.lockedMint && mint !== this.lockedMint) {
      return;
    }

    // 停止旧的监控器
    if (this.monitor) {
      this.monitor.stop();

      // 清空 SidePanel 数据
      this.sendClearMetrics();
    }

    // 准备监控器（仅创建实例，等待用户点击"开始"后再调用 start()）

    this.sendStatusLog(`检测到代币 ${mint.slice(0, 8)}...，等待开始`);

    // 整页加载后首次检测到 mint：通知 SidePanel 重置并更新 pageMint
    // SPA 内导航由 MutationObserver 触发，此时 _isFirstMintDetection 已为 false，不重复通知
    const fromPageLoad = this._isFirstMintDetection;
    this._isFirstMintDetection = false;
    if (fromPageLoad) {
      try {
        chrome.runtime.sendMessage({ type: 'MINT_CHANGED', mint, fromPageLoad: true }).catch(() => {});
      } catch (_e) { /* ignore */ }
    }

    this.currentMint = mint;
    this.monitor = new HeliusMonitor(mint);

    // 注入 API Key
    this.monitor.setApiKey(this.apiKey);

    // 新架构：Helius 历史 sig 获取始终启用，不受侧边栏 toggle 影响
    // toggle 原来只控制 WS，WS 已禁用，此处不再调用 setHeliusApiEnabled

    // 设置指标更新回调
    this.monitor.onMetricsUpdate = (metrics) => {
      this.displayMetrics(metrics);
    };

    // 设置 sig 统计早期更新回调（fetchInitialSignatures 完成后立即触发）
    this.monitor.onStatsUpdate = (stats) => {
      try {
        chrome.runtime.sendMessage({
          type: 'HELIUS_STATS_UPDATE',
          stats: stats,
          mint: this.currentMint
        }).catch(() => {});
      } catch (e) {
        // Extension context 尚未就绪，忽略
      }
    };

    // 设置状态日志回调（转发到 App.jsx 底部日志面板）
    this.monitor.onStatusLog = (msg) => {
      this.sendStatusLog(msg);
    };

    // 设置 WebSocket 状态回调
    this.monitor.onWsStatusChange = (status) => {
      try {
        chrome.runtime.sendMessage({
          type: 'HELIUS_WS_STATUS',
          status: status
        }).catch(() => {});
      } catch (e) {
        // Extension context 尚未就绪，忽略
      }
    };

    // 不在此处调用 start()，等待用户点击"开始"按钮（LOCK_MINT 消息）
  }

  /**
   * 发送状态日志到 App.jsx 底部日志面板
   */
  sendStatusLog(msg) {
    try {
      chrome.runtime.sendMessage({ type: 'HELIUS_STATUS_LOG', message: msg }).catch(() => {});
    } catch (_e) { /* ignore */ }
  }

  /**
   * 在控制台显示指标并推送到 SidePanel
   */
  displayMetrics(metrics, showDetailed = false) {
    if (showDetailed && this.monitor && this.monitor.metricsEngine) {
      this.monitor.metricsEngine.printDetailedMetrics(this.gmgnHolders.size > 0 ? this.gmgnHolders : null);
    }
    this.sendMetricsToUI(metrics);
  }

  /**
   * 处理新的 GMGN 交易（实时模式）
   */
  processNewGmgnTrades(trades) {
    if (!this.monitor || !this.monitor.isInitialized) {
      return;
    }


    // ── 排序原则：GMGN 接口返回顺序即正确顺序（index=0最新，index越大越旧）──
    // 排序目标：最旧先处理 → MetricsEngine unshift 压到底部 → 最新浮在 recentTrades 顶部
    // 每次调用仅处理单页新 sig，按页内 index DESC 即可（index越大越旧，先处理沉底）
    const tradeIndexMap = new Map(trades.map((t, i) => [t.tx_hash, i]));

    // [日志] 排序前：GMGN 接口原始顺序（完整列表，index=0最新，搜索 "GMGN排序-原始" 定位）
    if (dataFlowLogger.enabled && trades.length > 0) {
      const fullList = trades.map((t, i) => `[${i}] ${t.tx_hash?.slice(0, 12)} ts=${t.timestamp} ${t.event||''}`).join('\n');
      dataFlowLogger.log('GMGN-Hook', `GMGN排序-原始(共${trades.length}条 index0最新)`, fullList, null);
    }

    // 仅按页内 index DESC 排序（不依赖 timestamp / createdAt）
    const sortedTrades = [...trades].sort((a, b) =>
      (tradeIndexMap.get(b.tx_hash) ?? 0) - (tradeIndexMap.get(a.tx_hash) ?? 0)
    );

    // [日志] 排序后：处理顺序（完整列表，先旧后新，搜索 "GMGN排序-处理" 定位）
    if (dataFlowLogger.enabled && trades.length > 0) {
      const fullSorted = sortedTrades.map((t, i) => `[处理${i}] apiIdx=${tradeIndexMap.get(t.tx_hash)} ${t.tx_hash?.slice(0, 12)} ts=${t.timestamp} ${t.event||''}`).join('\n');
      dataFlowLogger.log('GMGN-Hook', `GMGN排序-处理(共${sortedTrades.length}条 先旧后新)`, fullSorted, null);
    }

    let processedCount = 0;
    let skippedCount = 0;

    // 逐个处理（使用排序后的 sortedTrades，确保同秒内最旧的先处理）
    sortedTrades.forEach(trade => {
      const sig = trade.tx_hash;

      // 检查是否已处理
      if (this.monitor.signatureManager.isProcessedSig(sig)) {
        skippedCount++;
        return;
      }

      // 获取状态
      const state = this.monitor.signatureManager.getState(sig);

      if (state && state.hasData && !state.isProcessed) {
        // 处理交易
        this.monitor.metricsEngine.processTransaction(state.txData, this.monitor.mint);
        this.monitor.signatureManager.markProcessed(sig);
        processedCount++;

      } else {
        skippedCount++;
      }
    });


    // 更新指标
    const metrics = this.monitor.metricsEngine.getMetrics();
    this.displayMetrics(metrics);
  }

  /**
   * 发送指标到 SidePanel
   */
  sendMetricsToUI(metrics) {
    try {
      const stats = this.monitor ? this.monitor.getStats() : null;

      chrome.runtime.sendMessage({
        type: 'HELIUS_METRICS_UPDATE',
        metrics: metrics,
        stats: stats,
        mint: this.currentMint
      }).catch(err => {
        if (!err.message.includes('Receiving end does not exist')) {
        }
      });
    } catch (err) {
    }
  }

  /**
   * 更新 GMGN 持有者列表（从 index.jsx 调用）
   * @param {Array} holders - 持有者对象数组
   */
  async updateGmgnHolders(holders) {

    // [调试] 打印第一个 holder 的字段结构
    if (holders.length > 0) {
    }

    // 更新 gmgnHolders 集合（用于判断谁是持有者）
    this.gmgnHolders.clear();
    if (Array.isArray(holders)) {
      holders.forEach(holder => {
        if (holder && holder.owner) {
          this.gmgnHolders.add(holder.owner);
        }
      });
    }

    // 如果 monitor 存在，触发评分和数据更新
    if (this.monitor) {
      // 设置配置
      this.monitor.setBossConfig(this.bossConfig);
      this.monitor.setScoreThreshold(this.scoreThreshold);
      this.monitor.setStatusThreshold(this.statusThreshold);

      // 设置手动标记数据
      this.monitor.setManualScores(this.manualStatusMap);

      // 更新数据并触发评分
      await this.monitor.updateHolderData(holders);

      // 发送数据到 Sidepanel
      this.sendDataToSidepanel();
    } else {
    }
  }

  /**
   * 处理分页获取到的 trades 数据（从 EXECUTE_TRADES_REFRESH 直接调用）
   * 复用 hookFetchXhrHandler 的完整逻辑：存储 signatures + 处理新交易
   * @param {Array} trades - trade 数据数组
   */
  processFetchedTrades(trades) {
    if (!trades || trades.length === 0) return;

    // [诊断] 始终打印，不受 logger 限制 —— 搜索 "GMGN-FETCH-DIAG" 定位
    console.log(`[GMGN-FETCH-DIAG] processFetchedTrades 被调用 trades=${trades.length} monitor=${!!this.monitor} isInit=${this.monitor?.isInitialized} loggerOn=${dataFlowLogger.enabled}`);

    if (!this.monitor) {
      return;
    }

    let newTradesCount = 0;
    const newTrades = [];

    trades.forEach(trade => {
      if (trade.tx_hash) {
        const isNew = !this.monitor.signatureManager.signatures.has(trade.tx_hash);
        this.monitor.signatureManager.addSignature(trade.tx_hash, 'plugin', trade);
        if (isNew) {
          newTradesCount++;
          newTrades.push(trade);
        }
      }
    });


    if (dataFlowLogger.enabled) {
      const stats = this.monitor.signatureManager.getStats();
      // 接口返回整页原始顺序（含重复项，反映 GMGN API 真实返回顺序，搜索 "GMGN分页-接口" 定位）
      const rawFull = trades.map((t, i) => `[${i}] ${t.tx_hash?.slice(0, 12)} ts=${t.timestamp} ${t.event||''}`).join('\n');
      dataFlowLogger.log('GMGN-Hook', `GMGN分页-接口原始(共${trades.length}条 index0最新)`, rawFull, null);

      if (this.monitor.isInitialized) {
        dataFlowLogger.log('GMGN-Hook', 'GMGN分页到达(已初始化)', `本页=${trades.length}条，新增=${newTradesCount}条，sig总=${stats.total}，→ 走实时排序路径`, null);
      } else {
        dataFlowLogger.log('GMGN-Hook', 'GMGN分页到达(初始化中)', `本页=${trades.length}条，新增=${newTradesCount}条，sig总=${stats.total}，存入SignatureManager等待续算`, null);
      }
    }

    if (this.monitor.isInitialized && newTradesCount > 0) {
      this.processNewGmgnTrades(newTrades);
    }

    return newTradesCount;
  }

  /**
   * 发送数据给 Sidepanel UI
   */
  sendDataToSidepanel() {
    if (!this.monitor) return;

    const filteredUsers = this.monitor.metricsEngine.filteredUsers;
    const traderStats = this.monitor.metricsEngine.traderStats;
    const traderHistory = this.monitor.metricsEngine.traderHistory;

    // 只发送过滤后的散户（filteredUsers = score < threshold）
    // traderStats 已合并 holder 快照数据，是唯一数据源
    const holdersData = Object.entries(traderStats)
      .filter(([address]) => filteredUsers.has(address))
      .map(([address, stats]) => {
        const history = traderHistory[address] || [];
        return {
          ...stats,
          // 优先用 trade 统计值
          ui_amount: stats.netTokenReceived !== undefined ? stats.netTokenReceived : (stats.ui_amount || 0),
          total_buy_u: stats.totalBuySol !== undefined ? stats.totalBuySol : (stats.total_buy_u || 0),
          netflow_amount: stats.netSolSpent || 0,
          total_sell_u: stats.totalSellSol || 0,
          trade_sig_count: history.length,
          status: stats.status || '散户',
          score: stats.score || 0,
          score_reasons: stats.score_reasons || []
        };
      });

    // 发送 Chrome 消息给 sidepanel
    chrome.runtime.sendMessage({
      type: 'UI_RENDER_DATA',
      data: holdersData,
      url: null,
      mint: this.currentMint  // 用于侧边栏 mint 校验
    }).catch(() => {
      // Sidepanel 可能未打开，忽略错误
    });
  }

  /**
   * 发送数据给 UI
   */
  sendDataToUI() {
    try {
      chrome.runtime.sendMessage({
        type: 'UI_RENDER_DATA',
        data: this.getSortedItems(),
        statusMap: this.statusMap
      }).catch(err => {
        // 忽略 SidePanel 未打开的错误
        if (!err.message.includes('Receiving end does not exist')) {
        }
      });
    } catch (err) {
    }
  }

  /**
   * 清空 SidePanel 指标
   */
  sendClearMetrics() {
    try {
      chrome.runtime.sendMessage({
        type: 'HELIUS_METRICS_CLEAR'
      }).catch(err => {
        // 忽略 SidePanel 未打开的错误
        if (!err.message.includes('Receiving end does not exist')) {
        }
      });

      // 同时清空 WebSocket 状态
      chrome.runtime.sendMessage({
        type: 'HELIUS_WS_STATUS',
        status: {
          connected: false,
          lastConnectTime: null,
          reconnectCount: 0,
          error: null
        }
      }).catch(() => {});
    } catch (err) {
      // 忽略错误
    }
  }

  /**
   * 获取当前监控器
   */
  getMonitor() {
    return this.monitor;
  }

  /**
   * 获取排序后的数据（用于 UI 渲染）
   */
  getSortedItems() {
    const items = Array.from(this.dataMap.values());

    // 按 buy_u 降序排序
    items.sort((a, b) => {
      const buyA = parseFloat(a.buy_u) || 0;
      const buyB = parseFloat(b.buy_u) || 0;
      return buyB - buyA;
    });

    return items;
  }

  /**
   * 清空数据
   */
  clearData() {
    this.dataMap.clear();
    this.statusMap = {};
  }

  /**
   * 设置用户状态
   */
  setStatus(owner, status) {
    this.statusMap[owner] = status;
  }

  /**
   * 设置手动标记分数
   * @param {string} address - 用户地址
   * @param {string} status - 状态（'庄家' 或 '散户'）
   */
  setManualScore(address, status) {

    // 存储手动标记：取消标记时删除条目，避免重启时残留
    if (status === '散户') {
      delete this.manualStatusMap[address];
    } else {
      this.manualStatusMap[address] = status;
    }

    // 持久化到 Chrome storage
    chrome.storage.local.set({
      [`manual_scores_${this.currentMint}`]: this.manualStatusMap
    });

    // 如果 monitor 存在，设置手动标记并触发重新评分
    if (this.monitor) {
      this.monitor.setManualScore(address, status);

      // 重新发送数据给 UI
      this.sendDataToSidepanel();
    }
  }

  /**
   * 保存状态到 storage
   */
  async saveStatus() {
    try {
      await chrome.storage.local.set({ holder_status: this.statusMap });
    } catch (err) {
    }
  }

  /**
   * 设置短地址
   */
  setShortAddress(address, shortAddr) {
    this.shortAddressMap[address] = shortAddr;
  }

  /**
   * 批量更新短地址
   */
  updateShortAddresses(updates) {
    let count = 0;
    updates.forEach(({ address, remark }) => {
      if (address && remark) {
        this.shortAddressMap[address] = remark;
        count++;
      }
    });
    return count;
  }

  /**
   * 更新 holders（暂时保留，但数据应该通过 HeliusMonitor 处理）
   */
  updateHolders(_items) {
    // 暂时不做任何处理，数据应该通过 HeliusMonitor 来
  }

  /**
   * 更新 trades（暂时保留，但数据应该通过 HeliusMonitor 处理）
   */
  updateTrades(_trades) {
    // 暂时不做任何处理，数据应该通过 HeliusMonitor 来
    return 0;
  }

  /**
   * 清理所有资源（注意：这个方法不应该被调用，因为 HeliusIntegration 是全局单例）
   * 事件监听器应该在整个页面生命周期中保持活跃
   * 只有 monitor 实例需要在切换 mint 时清理
   */
  cleanup() {

    // 1. 清理事件监听器
    if (this.gmgnTradesLoadedHandler) {
      window.removeEventListener('GMGN_TRADES_LOADED', this.gmgnTradesLoadedHandler);
      this.gmgnTradesLoadedHandler = null;
    }

    // 2. 清理 MutationObserver
    if (this.pageObserver) {
      this.pageObserver.disconnect();
      this.pageObserver = null;
    }

    // 3. 清理定时器
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // 4. 清理 monitor
    if (this.monitor) {
      this.monitor.stop();
      this.monitor = null;
    }

    // 5. 重置状态
    this.currentMint = null;
    this.isInitialized = false;

  }

  /**
   * 获取默认配置
   */
  getDefaultConfig() {
    return {
      enable_no_source: true,
      weight_no_source: 10,
      enable_hidden_relay: false,
      weight_hidden_relay: 15,
      enable_same_source: false,
      same_source_n: 5,
      same_source_exclude: '',
      weight_same_source: 10,
      enable_time_cluster: false,
      time_cluster_n: 5,
      time_cluster_j: 1,
      weight_time_cluster: 10,
      rule_gas: { enabled: false, threshold: 0.01, weight: 10 },
      rule_amount_sim: { enabled: false, count: 5, range: 100, weight: 10 },
      rule_large_holding: { enabled: false, top_pct: 10, min_usd: 1000, logic: 'OR', weight: 10 },
      rule_sol_balance: { enabled: false, count: 3, range: 0.1, weight: 10 },
      rule_source_time: { enabled: false, diff_sec: 10, count: 2, weight: 10 }
    };
  }

  /**
   * 获取启用的规则列表
   */
  getEnabledRules() {
    const enabled = [];
    if (this.bossConfig.enable_no_source) enabled.push('无资金来源');
    if (this.bossConfig.enable_same_source) enabled.push('同源账户');
    if (this.bossConfig.enable_time_cluster) enabled.push('时间聚类');
    if (this.bossConfig.rule_gas?.enabled) enabled.push('Gas异常');
    if (this.bossConfig.rule_amount_sim?.enabled) enabled.push('金额相似');
    if (this.bossConfig.rule_large_holding?.enabled) enabled.push('大额持仓');
    if (this.bossConfig.rule_sol_balance?.enabled) enabled.push('SOL余额');
    if (this.bossConfig.rule_source_time?.enabled) enabled.push('同源时间');
    return enabled;
  }

  /**
   * 监听配置变化
   */
  setupConfigListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.boss_config) {
          this.bossConfig = changes.boss_config.newValue;
          if (this.monitor) {
            this.monitor.setBossConfig(this.bossConfig);
          }
        }
        if (changes.score_threshold) {
          this.scoreThreshold = changes.score_threshold.newValue;
          if (this.monitor) {
            this.monitor.setScoreThreshold(this.scoreThreshold);
            // 重新发送过滤后的数据到 Sidepanel
            this.sendDataToSidepanel();
          }
        }
        if (changes.status_threshold) {
          this.statusThreshold = changes.status_threshold.newValue;
          if (this.monitor) {
            this.monitor.setStatusThreshold(this.statusThreshold);
          }
        }
        if (changes.helius_api_key) {
          this.apiKey = changes.helius_api_key.newValue || '';
          if (this.monitor) {
            this.monitor.setApiKey(this.apiKey);
          }
        }
      }
    });
  }
}


// 创建全局实例
const heliusIntegration = new HeliusIntegration();

// 暴露到 window 以便调试
window.__heliusIntegration = heliusIntegration;

export default heliusIntegration;
