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

    console.log('[Helius集成] 初始化...');
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
      `manual_scores_${currentMint}` // 加载手动标记数据
    ], (res) => {
      this.enabled = res.helius_monitor_enabled || false;

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
        console.log('[Helius集成] 首次初始化,保存默认配置');
        chrome.storage.local.set({ boss_config: defaultConfig });
      }

      // 统一默认值,明确检查 undefined
      this.scoreThreshold = res.score_threshold !== undefined ? res.score_threshold : 100;
      this.statusThreshold = res.status_threshold !== undefined ? res.status_threshold : 50;

      // 加载手动标记数据
      this.manualStatusMap = res[`manual_scores_${currentMint}`] || {};

      console.log('[Helius集成] 开关状态:', this.enabled ? '启用' : '禁用');
      console.log('[Helius集成] Score< 阈值:', this.scoreThreshold);
      console.log('[Helius集成] 状态判断阈值:', this.statusThreshold);
      console.log('[Helius集成] Boss配置:', this.bossConfig);
      console.log('[Helius集成] Boss配置键数量:', Object.keys(this.bossConfig).length);
      console.log('[Helius集成] 手动标记数量:', Object.keys(this.manualStatusMap).length);

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

    console.log('[Helius集成] 已就绪，等待 mint 页面...');
  }

  /**
   * 设置 hook 事件监听
   */
  setupHookListeners() {
    // 监听 signatures 事件（快速通道）
    this.hookSignaturesHandler = (event) => {
      const { signatures, source } = event.detail;

      if (!this.monitor) return;

      console.log(`[Helius集成] 收到 ${signatures.length} 个 signatures (来源: ${source})`);

      signatures.forEach(sig => {
        this.monitor.signatureManager.addSignature(sig, source);
      });
    };
    window.addEventListener('HOOK_SIGNATURES_EVENT', this.hookSignaturesHandler);

    // 监听 GMGN holder 数据
    this.hookHolderHandler = (event) => {
      try {
        const data = event.detail;
        if (data && data.holders && Array.isArray(data.holders)) {
          console.log(`[Helius集成] 收到 ${data.holders.length} 个 holder 数据`);

          // 记录日志
          dataFlowLogger.log(
            'HeliusIntegration',
            '接收 GMGN Holder 数据',
            `从 hook.js 接收到 ${data.holders.length} 个 holder 数据`,
            { count: data.holders.length, hasMonitor: !!this.monitor }
          );

          // 如果 monitor 不存在，记录警告
          if (!this.monitor) {
            console.warn('[Helius集成] Monitor 未启动，无法处理 holder 数据');
            dataFlowLogger.log(
              'HeliusIntegration',
              '数据丢失警告',
              'HeliusMonitor 未启动，无法处理 holder 数据',
              { count: data.holders.length }
            );
            return;
          }

          // 传递配置给 HeliusMonitor
          this.monitor.setBossConfig(this.bossConfig);
          this.monitor.setScoreThreshold(this.scoreThreshold);
          this.monitor.setStatusThreshold(this.statusThreshold);

          // [调试] 打印第一个 holder 的字段结构
          if (data.holders.length > 0) {
            console.log('[HeliusIntegration] 第一个 holder 的字段:', {
              keys: Object.keys(data.holders[0]),
              sample: data.holders[0]
            });
          }

          // 传递给 HeliusMonitor 并执行评分
          dataFlowLogger.log(
            'HeliusIntegration',
            '传递数据到 HeliusMonitor',
            `将 ${data.holders.length} 个 holder 传递给 HeliusMonitor.updateHolderData`,
            { count: data.holders.length }
          );

          this.monitor.updateHolderData(data.holders);

          // 发送数据到 Sidepanel
          this.sendDataToSidepanel();
        }
      } catch (err) {
        console.error('[Helius集成] 处理 holder 数据失败:', err);
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
            console.log(`[Helius集成] 从 token_trades 提取了 ${trades.length} 个交易（包含完整数据）`);

            // 记录日志
            dataFlowLogger.log(
              'HeliusIntegration',
              '接收 GMGN Trade 数据',
              `从 hook.js 接收到 ${trades.length} 个交易数据`,
              { count: trades.length, hasMonitor: !!this.monitor }
            );

            // 如果 monitor 不存在，记录警告
            if (!this.monitor) {
              console.warn('[Helius集成] Monitor 未启动，无法处理交易数据');
              dataFlowLogger.log(
                'HeliusIntegration',
                '数据丢失警告',
                'HeliusMonitor 未启动，无法处理交易数据',
                { count: trades.length }
              );
              return;
            }

            let newTradesCount = 0;
            const newTrades = [];

            console.log(`[Helius集成] Hook 事件收到 ${trades.length} 个交易`);

            trades.forEach(trade => {
              if (trade.tx_hash) {
                // 检查是否是新交易
                const isNew = !this.monitor.signatureManager.signatures.has(trade.tx_hash);

                console.log(`[Helius集成] 交易 ${trade.tx_hash.substring(0, 8)}... isNew=${isNew}`);

                // 记录日志
                if (isNew) {
                  dataFlowLogger.log(
                    'HeliusIntegration',
                    '传递交易到 HeliusMonitor',
                    `将新交易 ${trade.tx_hash.substring(0, 8)}... 传递给 HeliusMonitor.signatureManager`,
                    { signature: trade.tx_hash, source: 'plugin' }
                  );
                }

                // 存储完整的 GMGN trade 数据
                this.monitor.signatureManager.addSignature(trade.tx_hash, 'plugin', trade);

                if (isNew) {
                  newTradesCount++;
                  newTrades.push(trade);
                }
              }
            });

            console.log(`[Helius集成] 新交易统计: 总数=${trades.length}, 新交易=${newTradesCount}, isInitialized=${this.monitor.isInitialized}`);

            // 如果系统已初始化且有新交易，立即处理
            if (this.monitor.isInitialized && newTradesCount > 0) {
              console.log(`[Helius集成] 检测到 ${newTradesCount} 个新交易，立即处理`);
              this.processNewGmgnTrades(newTrades);
            } else if (newTradesCount === 0) {
              console.log(`[Helius集成] 没有新交易需要处理（所有交易都已存在）`);
            }
          }
        } catch (err) {
          console.error('[Helius集成] 解析 token_trades 失败:', err);
        }
      }
    };
    window.addEventListener('HOOK_FETCH_XHR_EVENT', this.hookFetchXhrHandler);

    // 监听 GMGN 分页数据加载完成事件
    this.gmgnTradesLoadedHandler = (event) => {
      if (!this.monitor) return;

      console.log('[Helius集成] 收到 GMGN 分页数据加载完成通知');

      // 通知监控器可以开始批量获取了
      if (this.monitor.onGmgnDataLoaded) {
        this.monitor.onGmgnDataLoaded();
      }
    };
    window.addEventListener('GMGN_TRADES_LOADED', this.gmgnTradesLoadedHandler);

    console.log('[Helius集成] Hook 事件监听已设置');
  }

  /**
   * 设置消息监听器
   */
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'HELIUS_MONITOR_TOGGLE') {
        const enabled = request.enabled;
        this.enabled = enabled;

        console.log(`[Helius集成] Helius API 调用: ${enabled ? '启用' : '禁用'}`);

        // 不再启动/停止 monitor，只更新开关状态
        // monitor 会根据 this.enabled 决定是否调用 Helius API

        // 通知 monitor 更新开关状态
        if (this.monitor) {
          this.monitor.setHeliusApiEnabled(enabled);
        }

        sendResponse({ success: true });
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
        console.log('[Helius集成] URL 变化，重新检查...');
        this.checkAndInitMonitor();
      }
    });

    this.pageObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // 定期检查（备用）
    this.checkInterval = setInterval(() => {
      this.checkAndInitMonitor();
    }, 5000);
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
        console.log('[Helius集成] 离开 mint 页面，停止监控');
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

    // 停止旧的监控器
    if (this.monitor) {
      console.log('[Helius集成] 切换到新 mint，停止旧监控');
      this.monitor.stop();

      // 清空 SidePanel 数据
      this.sendClearMetrics();
    }

    // 启动新的监控器（不检查开关状态，自动启动）
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Helius集成] 检测到 Mint: ${mint}`);
    console.log(`${'='.repeat(60)}\n`);

    // 记录日志
    dataFlowLogger.log(
      'HeliusIntegration',
      'HeliusMonitor 自动启动',
      `检测到 mint 页面，自动启动 HeliusMonitor`,
      { mint, apiEnabled: this.enabled }
    );

    this.currentMint = mint;
    this.monitor = new HeliusMonitor(mint);

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
      console.log('\n[Helius集成] 监控已启动！\n');
    } catch (error) {
      // Extension context invalidated 不是真正的启动失败，monitor 仍可继续运行
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.warn('[Helius集成] 启动时 Extension context 尚未就绪，监控继续运行');
        this.isInitialized = true;
        return;
      }
      console.error('[Helius集成] 启动失败:', error);
      this.monitor = null;
      this.currentMint = null;
    }
  }

  /**
   * 在控制台显示指标
   */
  displayMetrics(metrics, showDetailed = false) {
    console.log('\n' + '='.repeat(60));
    console.log('📊 实时指标更新');
    console.log('='.repeat(60));
    console.log(`🎯 当前 Mint: ${this.currentMint}`);
    console.log(`💰 已落袋: ${metrics.yiLuDai.toFixed(4)} SOL`);
    console.log(`🎯 本轮下注: ${metrics.benLunXiaZhu.toFixed(4)} SOL`);
    console.log(`💵 本轮成本: ${metrics.benLunChengBen.toFixed(4)} SOL`);
    console.log(`📈 浮盈浮亏: ${metrics.floatingPnL.toFixed(4)} SOL`);
    console.log(`💲 当前价格: ${metrics.currentPrice.toFixed(10)} SOL/Token`);
    console.log(`👥 活跃用户: ${metrics.activeCount}`);
    console.log(`🚪 已退出: ${metrics.exitedCount}`);
    console.log(`✅ 已处理: ${metrics.totalProcessed} 笔交易`);
    console.log('='.repeat(60) + '\n');

    // 如果需要详细信息，调用详细打印方法（传入 GMGN 持有者数据）
    if (showDetailed && this.monitor && this.monitor.metricsEngine) {
      this.monitor.metricsEngine.printDetailedMetrics(this.gmgnHolders.size > 0 ? this.gmgnHolders : null);
    }

    // 获取统计信息
    if (this.monitor) {
      const stats = this.monitor.getStats();
      console.log('📋 Signature 统计:');
      console.log(`   总数: ${stats.total}`);
      console.log(`   有数据: ${stats.hasData} (${((stats.hasData / stats.total) * 100).toFixed(1)}%)`);
      console.log(`   需获取: ${stats.needFetch} (${((stats.needFetch / stats.total) * 100).toFixed(1)}%)`);
      console.log(`   已处理: ${stats.isProcessed} (${((stats.isProcessed / stats.total) * 100).toFixed(1)}%)`);
      console.log(`   未处理: ${stats.notProcessed}`);
      console.log(`   来源分布:`);
      console.log(`     - 初始 API: ${stats.bySources.initial} (${((stats.bySources.initial / stats.total) * 100).toFixed(1)}%)`);
      console.log(`     - WebSocket: ${stats.bySources.websocket} (${((stats.bySources.websocket / stats.total) * 100).toFixed(1)}%)`);
      console.log(`     - GMGN插件: ${stats.bySources.plugin} (${((stats.bySources.plugin / stats.total) * 100).toFixed(1)}%)`);
      console.log('');

      // 详细数据源统计
      const detailedStats = this.getDetailedDataSourceStats();
      console.log('📊 数据源详细统计:');
      console.log(`   Helius API 数据: ${detailedStats.heliusCount} (${((detailedStats.heliusCount / stats.total) * 100).toFixed(1)}%)`);
      console.log(`   GMGN 数据: ${detailedStats.gmgnCount} (${((detailedStats.gmgnCount / stats.total) * 100).toFixed(1)}%)`);
      console.log(`   无数据: ${detailedStats.noDataCount} (${((detailedStats.noDataCount / stats.total) * 100).toFixed(1)}%)`);
      console.log('');

      // 显示前 20 个 signatures
      this.displayFirst20Signatures();
    }

    // 发送消息到 SidePanel
    this.sendMetricsToUI(metrics);
  }

  /**
   * 获取详细的数据源统计
   */
  getDetailedDataSourceStats() {
    let heliusCount = 0;
    let gmgnCount = 0;
    let noDataCount = 0;

    for (const [sig, state] of this.monitor.signatureManager.signatures.entries()) {
      if (!state.hasData) {
        noDataCount++;
      } else if (state.txData) {
        if (state.txData.type === 'helius') {
          heliusCount++;
        } else if (state.txData.type === 'gmgn') {
          gmgnCount++;
        }
      }
    }

    return { heliusCount, gmgnCount, noDataCount };
  }

  /**
   * 显示前 20 个 signatures 的详细信息
   */
  displayFirst20Signatures() {
    console.log('🔍 前 20 个 Signatures 详细信息:');
    console.log('-'.repeat(60));

    const signatures = Array.from(this.monitor.signatureManager.signatures.entries());
    const first20 = signatures.slice(0, 20);

    first20.forEach(([sig, state], index) => {
      // Signature 发现来源
      const discoverySourcesStr = Array.from(state.sources).join(', ');

      // 数据来源
      let dataSourceStr = 'none';
      if (state.hasData && state.txData) {
        if (state.txData.type === 'helius') {
          dataSourceStr = 'Helius API';
        } else if (state.txData.type === 'gmgn') {
          dataSourceStr = 'GMGN 插件';
        }
      } else if (!state.hasData) {
        dataSourceStr = '无数据（待获取）';
      }

      const hasDataStr = state.hasData ? '✓' : '✗';
      const isProcessedStr = state.isProcessed ? '✓' : '✗';

      console.log(`${index + 1}. ${sig.substring(0, 12)}...`);
      console.log(`   Signature发现来源: ${discoverySourcesStr}`);
      console.log(`   交易数据来源: ${dataSourceStr}`);
      console.log(`   有数据: ${hasDataStr} | 已处理: ${isProcessedStr}`);
      console.log(`   时间戳: ${new Date(state.timestamp).toLocaleString()}`);
      console.log('');
    });

    console.log('-'.repeat(60) + '\n');
  }

  /**
   * 处理新的 GMGN 交易（实时模式）
   */
  processNewGmgnTrades(trades) {
    if (!this.monitor || !this.monitor.isInitialized) {
      console.log(`[Helius集成] processNewGmgnTrades 跳过: monitor=${!!this.monitor}, isInitialized=${this.monitor?.isInitialized}`);
      return;
    }

    console.log(`[Helius集成] processNewGmgnTrades 开始处理 ${trades.length} 个新交易`);

    // 按时间排序（从旧到新）
    trades.sort((a, b) => a.timestamp - b.timestamp);

    let processedCount = 0;
    let skippedCount = 0;

    // 逐个处理
    trades.forEach(trade => {
      const sig = trade.tx_hash;

      // 检查是否已处理
      if (this.monitor.signatureManager.isProcessedSig(sig)) {
        console.log(`[Helius集成] 跳过已处理交易: ${sig.substring(0, 8)}...`);
        skippedCount++;
        return;
      }

      // 获取状态
      const state = this.monitor.signatureManager.getState(sig);
      console.log(`[Helius集成] 交易状态 ${sig.substring(0, 8)}...: hasData=${state?.hasData}, isProcessed=${state?.isProcessed}`);

      if (state && state.hasData && !state.isProcessed) {
        // 处理交易
        this.monitor.metricsEngine.processTransaction(state.txData, this.monitor.mint);
        this.monitor.signatureManager.markProcessed(sig);
        processedCount++;

        console.log(`[Helius集成] ✓ 处理新 GMGN 交易: ${sig.substring(0, 8)}...`);
      } else {
        console.log(`[Helius集成] ✗ 无法处理交易 ${sig.substring(0, 8)}...: state=${!!state}`);
        skippedCount++;
      }
    });

    console.log(`[Helius集成] processNewGmgnTrades 完成: 处理=${processedCount}, 跳过=${skippedCount}`);

    // 更新指标
    const metrics = this.monitor.metricsEngine.getMetrics();
    console.log(`[Helius集成] 调用 displayMetrics, totalProcessed=${metrics.totalProcessed}`);
    this.displayMetrics(metrics);
  }

  /**
   * 发送指标到 SidePanel
   */
  sendMetricsToUI(metrics) {
    try {
      // 获取统计信息
      const stats = this.monitor ? this.monitor.getStats() : null;

      console.log(`[Helius集成] 发送指标到 UI: totalProcessed=${metrics.totalProcessed}, stats.total=${stats?.total}`);

      // 发送消息
      chrome.runtime.sendMessage({
        type: 'HELIUS_METRICS_UPDATE',
        metrics: metrics,
        stats: stats,
        mint: this.currentMint
      }).catch(err => {
        // 忽略 SidePanel 未打开的错误
        if (!err.message.includes('Receiving end does not exist')) {
          console.error('[Helius集成] 发送消息失败:', err);
        }
      });
    } catch (err) {
      console.error('[Helius集成] sendMetricsToUI 异常:', err);
    }
  }

  /**
   * 更新 GMGN 持有者列表（从 index.jsx 调用）
   * @param {Array} holders - 持有者对象数组
   */
  updateGmgnHolders(holders) {
    console.log('[HeliusIntegration] 接收 GMGN holders 数据', { count: holders.length });

    // [调试] 打印第一个 holder 的字段结构
    if (holders.length > 0) {
      console.log('[HeliusIntegration] 第一个 holder 的字段:', {
        keys: Object.keys(holders[0]),
        sample: holders[0]
      });
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
      this.monitor.updateHolderData(holders);

      // 发送数据到 Sidepanel
      this.sendDataToSidepanel();
    } else {
      console.warn('[HeliusIntegration] Monitor 未启动，无法处理 holder 数据');
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
      console.warn('[HeliusIntegration] Monitor 未启动，无法处理 trades 数据');
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

    console.log(`[HeliusIntegration] processFetchedTrades: 总数=${trades.length}, 新交易=${newTradesCount}`);

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

    const userInfo = this.monitor.metricsEngine.userInfo;
    const filteredUsers = this.monitor.metricsEngine.filteredUsers;
    const traderStats = this.monitor.metricsEngine.traderStats;
    const traderHistory = this.monitor.metricsEngine.traderHistory;

    // 只发送过滤后的用户（score < threshold）
    const holdersData = Object.entries(userInfo)
      .filter(([address]) => filteredUsers.has(address))
      .map(([address, info]) => {
        const stats = traderStats[address] || {};
        const history = traderHistory[address] || [];
        return {
          ...info,
          // 用 trade 计算结果覆盖 holder 快照值
          ui_amount: stats.netTokenReceived !== undefined ? stats.netTokenReceived : (info.ui_amount || 0),
          total_buy_u: stats.totalBuySol !== undefined ? stats.totalBuySol : (info.total_buy_u || 0),
          netflow_amount: stats.netSolSpent || 0,
          total_sell_u: stats.totalSellSol || 0,
          // 计算来源的 sig 数量
          trade_sig_count: history.length,
          status: info.status || '散户',
          score: info.score || 0,
          score_reasons: info.score_reasons || []
        };
      });

    // 统计庄家和散户数量
    const whaleCount = holdersData.filter(h => h.status === '庄家').length;
    const retailCount = holdersData.filter(h => h.status === '散户').length;

    // 详细日志：显示每个用户的分数
    const userScores = holdersData.map(h => ({
      address: h.owner ? h.owner.substring(0, 8) + '...' : 'unknown',
      score: h.score,
      status: h.status
    }));

    console.log('[HeliusIntegration] 发送给 UI 的用户分数详情:', userScores);

    // 记录日志
    dataFlowLogger.log(
      'HeliusIntegration',
      '发送数据到 Sidepanel',
      `发送 ${holdersData.length} 个过滤后的用户数据到 Sidepanel UI`,
      {
        totalUsers: Object.keys(userInfo).length,
        filteredUsers: holdersData.length,
        whaleCount: whaleCount,
        retailCount: retailCount,
        scoreThreshold: this.monitor.scoreThreshold,
        userScores: userScores
      }
    );

    // 发送 Chrome 消息给 sidepanel
    chrome.runtime.sendMessage({
      type: 'UI_RENDER_DATA',
      data: holdersData,
      url: null
    }).then(() => {
      console.log(`[HeliusIntegration] ✅ 成功发送数据到 Sidepanel: ${holdersData.length} 个用户 (庄家: ${whaleCount}, 散户: ${retailCount})`);

      dataFlowLogger.log(
        'HeliusIntegration',
        'Sidepanel 消息发送成功',
        `成功发送 ${holdersData.length} 个用户数据`,
        { success: true }
      );
    }).catch(err => {
      // Sidepanel 可能未打开
      console.log('[HeliusIntegration] ⚠️ 发送消息到 Sidepanel 失败（可能未打开）:', err.message);

      dataFlowLogger.log(
        'HeliusIntegration',
        'Sidepanel 消息发送失败',
        `无法发送数据到 Sidepanel: ${err.message}`,
        { error: err.message }
      );
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
          console.error('[Helius集成] 发送数据失败:', err);
        }
      });
    } catch (err) {
      console.error('[Helius集成] sendDataToUI 异常:', err);
    }
  }

  /**
   * 清空 SidePanel 指标
   */
  sendClearMetrics() {
    try {
      console.log('[Helius集成] 清空 SidePanel 指标');
      chrome.runtime.sendMessage({
        type: 'HELIUS_METRICS_CLEAR'
      }).catch(err => {
        // 忽略 SidePanel 未打开的错误
        if (!err.message.includes('Receiving end does not exist')) {
          console.error('[Helius集成] 发送清空消息失败:', err);
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
    console.log('[Helius集成] 数据已清空');
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
    console.log('[Helius集成] 设置手动标记', { address, status });

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
      console.log('[Helius集成] 状态已保存');
    } catch (err) {
      console.error('[Helius集成] 保存状态失败:', err);
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
  updateHolders(items) {
    console.warn('[Helius集成] updateHolders 被调用，但数据应该通过 HeliusMonitor 处理');
    // 暂时不做任何处理，数据应该通过 HeliusMonitor 来
  }

  /**
   * 更新 trades（暂时保留，但数据应该通过 HeliusMonitor 处理）
   */
  updateTrades(trades) {
    console.warn('[Helius集成] updateTrades 被调用，但数据应该通过 HeliusMonitor 处理');
    // 暂时不做任何处理，数据应该通过 HeliusMonitor 来
    return 0;
  }

  /**
   * 清理所有资源（注意：这个方法不应该被调用，因为 HeliusIntegration 是全局单例）
   * 事件监听器应该在整个页面生命周期中保持活跃
   * 只有 monitor 实例需要在切换 mint 时清理
   */
  cleanup() {
    console.log('[Helius集成] 开始清理所有资源...');

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

    console.log('[Helius集成] 资源清理完成');
  }

  /**
   * 获取默认配置
   */
  getDefaultConfig() {
    return {
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
          console.log('[Helius集成] 评分配置已更新');
          if (this.monitor) {
            this.monitor.setBossConfig(this.bossConfig);
          }
        }
        if (changes.score_threshold) {
          this.scoreThreshold = changes.score_threshold.newValue;
          console.log('[Helius集成] Score< 阈值已更新:', this.scoreThreshold);
          if (this.monitor) {
            this.monitor.setScoreThreshold(this.scoreThreshold);
            // 重新发送过滤后的数据到 Sidepanel
            this.sendDataToSidepanel();
          }
        }
        if (changes.status_threshold) {
          this.statusThreshold = changes.status_threshold.newValue;
          console.log('[Helius集成] 状态判断阈值已更新:', this.statusThreshold);
          if (this.monitor) {
            this.monitor.setStatusThreshold(this.statusThreshold);
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
