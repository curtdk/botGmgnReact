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

    // 事件处理器引用（用于清理）
    this.hookSignaturesHandler = null;
    this.hookFetchXhrHandler = null;
    this.hookHolderHandler = null;
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


      dataFlowLogger.log(
        'HeliusIntegration',
        '配置加载完成',
        `Boss配置键数量: ${Object.keys(this.bossConfig).length}`,
        {
          enabled: this.enabled,
          scoreThreshold: this.scoreThreshold,
          statusThreshold: this.statusThreshold,
          bossConfigKeys: Object.keys(this.bossConfig).length,
          enabledRules: this.getEnabledRules(),
          manualScoreCount: Object.keys(this.manualStatusMap).length
        }
      );
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
   */
  setupHookListeners() {
    // 监听 signatures 事件（快速通道）
    this.hookSignaturesHandler = (event) => {
      const { signatures, source } = event.detail;

      if (!this.monitor) return;


      signatures.forEach(sig => {
        this.monitor.signatureManager.addSignature(sig, source);
      });
    };
    window.addEventListener('HOOK_SIGNATURES_EVENT', this.hookSignaturesHandler);

    // 监听 GMGN holder 数据
    this.hookHolderHandler = async (event) => {
      try {
        const data = event.detail;
        if (data && data.holders && Array.isArray(data.holders)) {
          const hasMonitor = !!this.monitor;
          dataFlowLogger.log('GMGN-Hook', 'Holders 接收', `${data.holders.length} 个 holder | 锁定: ${this.lockedMint || '无'} | monitor: ${hasMonitor ? '✓' : '✗'}`, { count: data.holders.length, lockedMint: this.lockedMint, currentMint: this.currentMint });

          // 如果 monitor 不存在，记录警告
          if (!this.monitor) {
            dataFlowLogger.log('GMGN-Hook', '⚠ 丢弃', 'Monitor 未启动，holder 数据无法处理', { count: data.holders.length });
            return;
          }

          // 传递配置给 HeliusMonitor
          this.monitor.setBossConfig(this.bossConfig);
          this.monitor.setScoreThreshold(this.scoreThreshold);
          this.monitor.setStatusThreshold(this.statusThreshold);

          await this.monitor.updateHolderData(data.holders);

          // 发送数据到 Sidepanel
          this.sendDataToSidepanel();
        }
      } catch (err) {
      }
    };
    window.addEventListener('HOOK_HOLDERS_EVENT', this.hookHolderHandler);

    // 监听完整 XHR 事件（处理分页数据）
    this.hookFetchXhrHandler = (event) => {
      const detail = event.detail;

      // 如果是 token_trades，提取完整的 trade 数据
      // 注意：这里会捕获所有分页的数据，因为现有代码会循环获取所有页
      if (detail.url.includes('/token_trades/')) {
        try {
          const json = JSON.parse(detail.responseBody);

          // 兼容多种数据结构
          let trades = [];
          if (json.history && Array.isArray(json.history)) {
            trades = json.history;
          } else if (json.data && json.data.history && Array.isArray(json.data.history)) {
            trades = json.data.history;
          } else {
            trades = json.data?.history || json.data || [];
            if (!Array.isArray(trades)) trades = [];
          }

          if (trades.length > 0) {
            if (!this.monitor) {
              dataFlowLogger.log('GMGN-Hook', '⚠ 丢弃 Trades', `${trades.length} 个交易，Monitor 未启动 | 锁定: ${this.lockedMint || '无'}`, { count: trades.length });
              return;
            }

            let newTradesCount = 0;
            const newTrades = [];

            trades.forEach(trade => {
              if (trade.tx_hash) {
                const isNew = !this.monitor.signatureManager.signatures.has(trade.tx_hash);
                this.monitor.signatureManager.addSignature(trade.tx_hash, 'plugin', trade);
                if (isNew) { newTradesCount++; newTrades.push(trade); }
              }
            });

            if (newTradesCount > 0) {
              const initState = this.monitor.isInitialized ? '实时处理' : '等待初始化完成';
              this.sendStatusLog(`GMGN Hook: ${trades.length} 条交易 (新增${newTradesCount}) [${initState}]`);

              // 验证日志：GMGN Hook 新增交易顺序（按 GMGN timestamp 从旧→新）
              const sortedNew = [...newTrades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
              const orderLines = sortedNew.map((t, i) => {
                const ts = t.timestamp ? new Date(t.timestamp * 1000).toLocaleTimeString('zh-CN') : '?';
                return `[${i + 1}] ${(t.tx_hash || '').slice(0, 8)}... ts=${ts} event=${t.event || '?'} sol=${parseFloat(t.quote_amount || 0).toFixed(4)}`;
              }).join('\n');
              dataFlowLogger.log('验证-GMGN', 'Hook新增交易',
                `新增 ${newTradesCount}/${trades.length} 条（从旧→新，slot=0等待Helius verify补充）:\n${orderLines}`,
                { newCount: newTradesCount, total: trades.length, sigs: sortedNew.map(t => ({ sig: (t.tx_hash || '').slice(0, 8), ts: t.timestamp, event: t.event })) }
              );
            }

            if (this.monitor.isInitialized && newTradesCount > 0) {
              this.processNewGmgnTrades(newTrades);
            } else if (!this.monitor.isInitialized && newTradesCount > 0 && this.monitor.onGmgnDataLoaded) {
              // Hook 拦截到数据，且 Monitor 仍在初始化中（等待 GMGN 信号）
              // 直接解除并行等待，不必等 EXECUTE_TRADES_REFRESH 发起的分页拉取
              this.monitor.onGmgnDataLoaded();
            }
          }
        } catch (err) {
        }
      }
    };
    window.addEventListener('HOOK_FETCH_XHR_EVENT', this.hookFetchXhrHandler);

    // 监听 GMGN 分页数据加载完成事件
    this.gmgnTradesLoadedHandler = (_event) => {
      if (!this.monitor) return;

      this.sendStatusLog('GMGN 分页数据加载完成，通知 Monitor...');
      // 通知监控器可以开始批量获取了
      if (this.monitor.onGmgnDataLoaded) {
        this.monitor.onGmgnDataLoaded();
      }
    };
    window.addEventListener('GMGN_TRADES_LOADED', this.gmgnTradesLoadedHandler);

  }

  /**
   * 设置消息监听器
   */
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (request.type === 'HELIUS_MONITOR_TOGGLE') {
        const enabled = request.enabled;
        this.enabled = enabled;


        // 通知 monitor 更新开关状态
        if (this.monitor) {
          this.monitor.setHeliusApiEnabled(enabled);
        }

        sendResponse({ success: true });
      }

      // 侧边栏开始：锁定 mint，阻止自动切换
      if (request.type === 'LOCK_MINT') {
        this.lockedMint = request.mint || null;
        dataFlowLogger.log('锁定控制', '锁定 Mint', `侧边栏已启动，锁定 ${this.lockedMint}`, { lockedMint: this.lockedMint });
        // 若当前监控的 mint 与锁定 mint 不同，先切换过来
        if (this.lockedMint && this.currentMint !== this.lockedMint) {
          this.checkAndInitMonitor();
        }
        sendResponse({ success: true });
        return true;
      }

      // 侧边栏停止：解锁 mint
      if (request.type === 'UNLOCK_MINT') {
        dataFlowLogger.log('锁定控制', '解锁 Mint', `侧边栏已停止，解锁（原: ${this.lockedMint}）`, { prevLocked: this.lockedMint });
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
      dataFlowLogger.log('锁定控制', '忽略切换', `页面切换至 ${mint.slice(0,8)}...，继续锁定 ${this.lockedMint.slice(0,8)}...`, { newMint: mint, lockedMint: this.lockedMint });
      return;
    }

    // 停止旧的监控器
    if (this.monitor) {
      this.monitor.stop();

      // 清空 SidePanel 数据
      this.sendClearMetrics();
    }

    // 启动新的监控器（不检查开关状态，自动启动）

    dataFlowLogger.log('锁定控制', 'Monitor 启动', `检测到 Mint: ${mint.slice(0,8)}...，启动 HeliusMonitor`, { mint, apiEnabled: this.enabled, lockedMint: this.lockedMint });
    this.sendStatusLog(`检测到代币 ${mint.slice(0, 8)}...，启动 Helius 监控`);

    this.currentMint = mint;
    this.monitor = new HeliusMonitor(mint);

    // 注入 API Key
    this.monitor.setApiKey(this.apiKey);

    // 设置 API 开关状态
    this.monitor.setHeliusApiEnabled(this.enabled);

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

    try {
      await this.monitor.start();
      this.isInitialized = true;
    } catch (error) {
      // Extension context invalidated 不是真正的启动失败，monitor 仍可继续运行
      if (error.message && error.message.includes('Extension context invalidated')) {
        this.isInitialized = true;
        return;
      }
      this.monitor = null;
      this.currentMint = null;
    }
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


    // 按时间排序（从旧到新），确保 MetricsEngine unshift 后最新交易在顶部
    // 同一时间戳内：用 SignatureManager.createdAt DESC 作为 tie-breaker
    // GMGN 以最新在前的顺序插入 addSignature，故最新 sig 的 createdAt 最小，最旧的最大
    // createdAt DESC = 最旧优先处理 = unshift 后最新在顶 ✓
    const sortedTrades = [...trades].sort((a, b) => {
      const tDiff = (a.timestamp || 0) - (b.timestamp || 0);
      if (tDiff !== 0) return tDiff;
      // 同时间戳：按 SignatureManager 中的 createdAt DESC（最旧的 createdAt 最大）
      const stateA = this.monitor.signatureManager.getState(a.tx_hash);
      const stateB = this.monitor.signatureManager.getState(b.tx_hash);
      return (stateB?.createdAt || 0) - (stateA?.createdAt || 0);
    });

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

      dataFlowLogger.log('UI-发送', 'Metrics 推送', `processed=${metrics.totalProcessed} | 锁定: ${this.lockedMint || '无'}`, { totalProcessed: metrics.totalProcessed, statsTotal: stats?.total, lockedMint: this.lockedMint });

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

    // 统计庄家和散户数量
    const whaleCount = holdersData.filter(h => h.status === '庄家').length;
    const retailCount = holdersData.filter(h => h.status === '散户').length;

    dataFlowLogger.log('UI-发送', 'Holders 推送', `${holdersData.length} 用户 (庄家:${whaleCount} 散户:${retailCount}) | 锁定: ${this.lockedMint || '无'}`, { count: holdersData.length, whaleCount, retailCount, lockedMint: this.lockedMint });

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

    // 存储手动标记
    this.manualStatusMap[address] = status;

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

    // 1. 清理事件监听器（注意：通常不需要清理，因为是全局监听）
    if (this.hookSignaturesHandler) {
      window.removeEventListener('HOOK_SIGNATURES_EVENT', this.hookSignaturesHandler);
      this.hookSignaturesHandler = null;
    }
    if (this.hookFetchXhrHandler) {
      window.removeEventListener('HOOK_FETCH_XHR_EVENT', this.hookFetchXhrHandler);
      this.hookFetchXhrHandler = null;
    }
    if (this.hookHolderHandler) {
      window.removeEventListener('HOOK_HOLDERS_EVENT', this.hookHolderHandler);
      this.hookHolderHandler = null;
    }
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
