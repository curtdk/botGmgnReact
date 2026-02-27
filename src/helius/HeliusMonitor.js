/**
 * HeliusMonitor - 浏览器版 Helius 监控器
 *
 * 功能：
 * 1. 协调所有组件（SignatureManager, DataFetcher, MetricsEngine, CacheManager）
 * 2. 等待 GMGN 分页数据加载完成后开始批量获取
 * 3. 使用浏览器 WebSocket API 监听实时交易
 * 4. 首次倒排序计算，之后实时计算
 */

import SignatureManager from './SignatureManager.js';
import CacheManager from './CacheManager.js';
import MetricsEngine from './MetricsEngine.js';
import DataFetcher from './DataFetcher.js';
import ScoringEngine from './ScoringEngine.js';
import dataFlowLogger from '../utils/Logger.js';

export default class HeliusMonitor {
  constructor(mintAddress, apiKey = '') {
    this.mint = mintAddress;
    this.apiKey = apiKey;

    // 初始化组件
    this.signatureManager = new SignatureManager(mintAddress);
    this.cacheManager = new CacheManager();
    this.metricsEngine = new MetricsEngine();
    this.dataFetcher = new DataFetcher(this.cacheManager, apiKey);
    this.scoringEngine = new ScoringEngine();

    // WebSocket
    this.ws = null;
    this.pingInterval = null;

    // 状态
    this.isInitialized = false;
    this.isWaitingForGmgn = true;
    this.heliusApiEnabled = true;  // Helius API 开关
    this.heliusFetchedTotal = 0;  // Helius API 实际获取的 sig 原始总数（含缓存）
    this.gmgnDataLoadedResolve = null;
    this.gmgnDataLoadedReject = null;  // 新增：支持 Promise 取消

    // 评分配置
    this.scoreThreshold = 100; // Score< 过滤阈值（默认100）
    this.statusThreshold = 50; // 状态判断阈值（默认50）
    this.manualScores = {}; // 手动标记
    this.bossConfig = {}; // 评分配置

    // 回调
    this.onMetricsUpdate = null;
    this.onGmgnDataLoaded = null;

    // 生命周期管理
    this.isStopped = false;           // 停止标志
    this.reconnectTimeout = null;     // WebSocket 重连定时器
    this.progressInterval = null;     // 进度定时器

    // WebSocket 状态监控
    this.wsStatus = {
      connected: false,
      lastConnectTime: null,
      lastDisconnectTime: null,
      reconnectCount: 0,
      error: null
    };
    this.onWsStatusChange = null;     // WS 状态变化回调

    // 定期校验
    this.verifyInterval = null;
    this.lastVerifyTime = null;
  }

  /**
   * 启动监控
   */
  async start() {
    console.log(`\n--- 启动 Helius 浏览器监控系统 ---`);
    console.log(`目标代币 (Mint): ${this.mint}`);

    try {
      // 1. 初始化缓存
      await this.cacheManager.init();
      if (this.isStopped) throw new Error('Stopped during cache init');

      // 2. 连接 WebSocket（开始收集实时 signatures）
      this.connectWs();
      if (this.isStopped) throw new Error('Stopped during WebSocket connect');

      // 3. 获取初始 signature 列表
      await this.fetchInitialSignatures();
      if (this.isStopped) throw new Error('Stopped during initial fetch');

      // 4. 等待 GMGN 分页数据加载完成
      await this.waitForGmgnData();
      if (this.isStopped) throw new Error('Stopped during GMGN wait');

      // 5. 批量获取缺失的交易
      await this.fetchMissingTransactions();
      if (this.isStopped) throw new Error('Stopped during missing fetch');

      // 6. 首次计算
      await this.performInitialCalculation();
      if (this.isStopped) throw new Error('Stopped during initial calculation');

      // 7. 进入实时模式
      this.isInitialized = true;
      console.log('\n[系统] 进入实时模式，开始监听新交易...\n');

      // 8. 启动定期校验
      const verifyIntervalSec = this.bossConfig?.verify_interval_sec || 30;
      this.verifyInterval = setInterval(() => {
        if (!this.isStopped && this.isInitialized) {
          this.verifySignatures();
        }
      }, verifyIntervalSec * 1000);
      console.log(`[校验] 定期校验已启动 (间隔: ${verifyIntervalSec}秒)`);

    } catch (error) {
      if (this.isStopped) {
        console.log('[系统] 启动过程中被停止');
      } else {
        console.error('[系统] 启动失败:', error);
      }
      throw error;
    }
  }

  /**
   * 连接 WebSocket
   */
  connectWs() {
    // 检查 API 开关
    if (!this.heliusApiEnabled) {
      console.log('[WebSocket] Helius API 已禁用，跳过 WebSocket 连接');
      return;
    }

    // 检查停止标志
    if (this.isStopped) {
      console.log('[WebSocket] 实例已停止，取消连接');
      return;
    }

    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }

    console.log('[WebSocket] 连接中...');
    this.ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`);

    this.ws.onopen = () => {
      if (this.isStopped) return;  // 检查停止标志

      console.log('[WebSocket] 已连接，开始订阅实时日志...');

      // 更新状态
      this.wsStatus.connected = true;
      this.wsStatus.lastConnectTime = Date.now();
      this.wsStatus.error = null;
      this.notifyWsStatusChange();

      const request = {
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          { "mentions": [this.mint] },
          { "commitment": "confirmed" }
        ]
      };
      this.ws.send(JSON.stringify(request));

      // 心跳
      this.pingInterval = setInterval(() => {
        if (this.isStopped) {
          clearInterval(this.pingInterval);
          return;
        }
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    };

    this.ws.onmessage = (event) => {
      if (this.isStopped) return;  // 检查停止标志

      try {
        const msg = JSON.parse(event.data);
        if (msg.method === 'logsNotification') {
          const sig = msg.params.result.value.signature;
          this.handleNewSignature(sig, 'websocket');
        }
      } catch (err) {
        console.error('[WebSocket] 解析错误:', err);
      }
    };

    this.ws.onclose = () => {
      if (this.isStopped) {
        console.log('[WebSocket] 实例已停止，不重连');
        return;
      }

      console.log('[WebSocket] 连接断开，3秒后重连...');
      clearInterval(this.pingInterval);

      // 更新状态
      this.wsStatus.connected = false;
      this.wsStatus.lastDisconnectTime = Date.now();
      this.wsStatus.reconnectCount++;
      this.notifyWsStatusChange();

      // 存储定时器引用
      this.reconnectTimeout = setTimeout(() => {
        if (!this.isStopped) {
          this.connectWs();
        }
      }, 3000);
    };

    this.ws.onerror = (err) => {
      if (this.isStopped) return;
      console.error('[WebSocket] 错误:', err);

      // 更新状态
      this.wsStatus.error = err.message || 'WebSocket 连接错误';
      this.notifyWsStatusChange();
    };
  }

  /**
   * 获取初始 signature 列表
   */
  async fetchInitialSignatures() {
    console.log('[初始化] 获取 signature 列表...');

    const { allSigs, newSigs, cachedSigs } = await this.dataFetcher.fetchHistorySigs(this.mint);

    // 记录 Helius 实际获取的 sig 原始总数（缓存 + 新增）
    this.heliusFetchedTotal = allSigs.length;
    console.log(`[初始化] Helius 获取总数: ${allSigs.length} (缓存=${cachedSigs.length} 新增=${newSigs.length})`);

    // 添加所有 signatures 到 SignatureManager
    allSigs.forEach(sig => {
      this.signatureManager.addSignature(sig, 'initial');
    });

    console.log(`[初始化] 添加了 ${allSigs.length} 个 signatures 到管理器`);

    // 立即通知 UI sig 总数已就绪
    if (this.onStatsUpdate) {
      try {
        this.onStatsUpdate(this.signatureManager.getStats());
      } catch (e) {
        console.warn('[HeliusMonitor] onStatsUpdate 回调异常:', e.message);
      }
    }
  }

  /**
   * 等待 GMGN 分页数据加载完成
   */
  async waitForGmgnData() {
    console.log('[等待] 检查 GMGN 分页数据状态...');

    // [新增] 智能检查：如果大部分数据已经加载，跳过等待
    const stats = this.signatureManager.getStats();
    if (stats.total > 0) {
      const dataLoadedPercent = (stats.hasData / stats.total) * 100;
      console.log(`[等待] 当前数据状态: ${stats.hasData}/${stats.total} (${dataLoadedPercent.toFixed(1)}%)`);

      // 如果超过 80% 的数据已加载，认为 GMGN 数据已经就绪
      if (dataLoadedPercent >= 80) {
        console.log('[等待] ✓ GMGN 数据已基本加载完成，跳过等待');
        return;
      }
    }

    console.log('[等待] 等待 GMGN 分页数据加载完成...');
    this.signatureManager.startWaitPeriod();
    this.isWaitingForGmgn = true;

    const startTime = Date.now();
    const TIMEOUT_MS = 60000; // 60秒超时

    // 设置回调，当 GMGN 数据加载完成时调用
    const gmgnDataPromise = new Promise((resolve, reject) => {
      this.gmgnDataLoadedResolve = resolve;
      this.gmgnDataLoadedReject = reject;  // 支持取消
    });

    // 超时保护
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, TIMEOUT_MS);
    });

    // 进度更新 - 存储定时器引用
    this.progressInterval = setInterval(() => {
      if (this.isStopped) {
        clearInterval(this.progressInterval);
        return;
      }

      const elapsed = Date.now() - startTime;
      const stats = this.signatureManager.getStats();

      console.log(`[等待] ${(elapsed / 1000).toFixed(0)}秒 | ` +
                  `总数: ${stats.total} | 有数据: ${stats.hasData} | ` +
                  `需获取: ${stats.needFetch}`);

      // 如果等待超过30秒，输出警告
      if (elapsed > 30000 && elapsed % 10000 < 5000) {
        console.warn('[等待] ⚠️ 等待时间较长，请检查 GMGN 数据是否正在加载...');
      }
    }, 5000);

    // 设置 onGmgnDataLoaded 回调
    this.onGmgnDataLoaded = () => {
      if (this.isStopped) return;

      console.log('[等待] 收到 GMGN 数据加载完成通知');
      if (this.gmgnDataLoadedResolve) {
        this.gmgnDataLoadedResolve();
      }
    };

    // 等待 GMGN 数据加载完成、超时或实例停止
    try {
      const result = await Promise.race([gmgnDataPromise, timeoutPromise]);
      clearInterval(this.progressInterval);

      if (result === 'timeout') {
        const duration = Date.now() - startTime;
        console.warn(`[等待] ⚠️ 等待超时（${(duration / 1000).toFixed(1)}秒），继续执行...`);
        console.warn('[等待] 提示：GMGN 数据可能未完全加载，后续计算可能不完整');
      } else {
        const duration = Date.now() - startTime;
        console.log(`[等待] GMGN 数据加载完成，耗时 ${(duration / 1000).toFixed(1)} 秒`);
      }

      this.signatureManager.endWaitPeriod();
      this.isWaitingForGmgn = false;
    } catch (err) {
      // 实例被停止
      clearInterval(this.progressInterval);
      console.log('[等待] 等待被中断（实例已停止）');
      throw err;
    }
  }

  /**
   * 批量获取缺失的交易
   */
  async fetchMissingTransactions() {
    // 检查 API 开关
    if (!this.heliusApiEnabled) {
      console.log('[获取] Helius API 已禁用，跳过批量获取');
      return;
    }

    if (this.isStopped) {
      console.log('[获取] 实例已停止，跳过获取');
      return;
    }

    const missingSigs = this.signatureManager.getMissingSignatures();

    if (missingSigs.length === 0) {
      console.log('[获取] 无需获取，所有数据已收集！');
      return;
    }

    console.log(`[获取] 需要获取 ${missingSigs.length} 个交易...`);

    // 1. 先从缓存加载
    const cachedTxs = await this.cacheManager.loadTransactionsBySignatures(missingSigs);

    if (this.isStopped) return;  // 检查停止标志

    cachedTxs.forEach(tx => {
      const sig = tx.transaction.signatures[0];
      this.signatureManager.markHasData(sig, tx);
    });

    // 2. 获取仍然缺失的
    const stillMissing = this.signatureManager.getMissingSignatures();

    if (stillMissing.length > 0) {
      console.log(`[获取] ${cachedTxs.length} 个来自缓存，${stillMissing.length} 个需要 API`);

      // 批量获取
      const CHUNK_SIZE = 100;
      for (let i = 0; i < stillMissing.length; i += CHUNK_SIZE) {
        if (this.isStopped) {
          console.log('[获取] 实例已停止，中断获取');
          return;
        }

        const chunk = stillMissing.slice(i, i + CHUNK_SIZE);
        const txs = await this.dataFetcher.fetchParsedTxs(chunk, this.mint);

        if (this.isStopped) return;  // 再次检查

        // 标记为已有数据
        txs.forEach(tx => {
          const sig = tx.transaction.signatures[0];
          this.signatureManager.markHasData(sig, tx);
        });

        console.log(`[获取] 进度: ${Math.min(i + CHUNK_SIZE, stillMissing.length)} / ${stillMissing.length}`);
      }
    }
  }

  /**
   * 首次计算（20 秒后，倒排序）
   */
  async performInitialCalculation() {
    if (this.isStopped) {
      console.log('[首次计算] 实例已停止，跳过计算');
      return;
    }

    // 获取准备计算的 signatures（有数据但未处理）
    const readySignatures = this.signatureManager.getReadySignatures();

    if (readySignatures.length === 0) {
      console.log('[首次计算] 没有可处理的交易');
      return;
    }

    // 使用改进的日志格式
    console.log('\n' + '='.repeat(100));
    console.log('[阶段 1] 首次计算开始');
    console.log('='.repeat(100));
    console.log('📊 数据概览:');
    console.log(`   - 总交易数: ${readySignatures.length} 笔`);
    console.log(`   - 处理顺序: 按时间倒序（从最早到最新）`);
    console.log(`   - 数据来源: Helius API`);
    console.log('   - 计算基础: 每个用户的全部历史交易数据');
    console.log('');

    // 设置总交易数（用于显示进度）
    this.metricsEngine.setTotalTransactions(readySignatures.length);

    // 按顺序处理每个交易
    for (const item of readySignatures) {
      if (this.isStopped) {
        console.log('[首次计算] 实例已停止，中断计算');
        return;
      }

      this.metricsEngine.processTransaction(item.txData, this.mint);
      this.signatureManager.markProcessed(item.sig);
    }

    console.log('\n' + '='.repeat(100));
    console.log('[阶段 1] 首次计算完成');
    console.log('='.repeat(100));
    console.log('📈 阶段总结:');
    console.log(`   ✓ 处理交易数: ${readySignatures.length} 笔`);
    console.log(`   ✓ 数据完整性: 每个用户的计算基于其全部历史交易`);
    console.log('');

    // 打印简要指标
    this.metricsEngine.printMetrics();

    // 打印详细指标（包含每个用户的计算明细）
    this.metricsEngine.printDetailedMetrics();

    // 触发回调
    if (this.onMetricsUpdate && !this.isStopped) {
      this.onMetricsUpdate(this.metricsEngine.getMetrics());
    }
  }

  /**
   * 处理新 signature
   */
  async handleNewSignature(sig, source) {
    if (this.isStopped) return;  // 立即返回

    // 添加到 SignatureManager
    this.signatureManager.addSignature(sig, source);

    // 如果在等待 GMGN 数据，不处理
    if (this.isWaitingForGmgn) {
      return;
    }

    // 如果未初始化，不处理
    if (!this.isInitialized) {
      return;
    }

    // 检查是否已处理
    if (this.signatureManager.isProcessedSig(sig)) {
      console.log(`[跳过] 交易已处理: ${sig}`);
      return;
    }

    // 检查是否有数据
    if (!this.signatureManager.hasData(sig)) {
      // 获取交易详情
      console.log(`[实时] 获取新交易: ${sig}`);
      const txs = await this.dataFetcher.fetchParsedTxs([sig], this.mint);

      if (this.isStopped) return;  // 检查停止标志

      if (txs.length > 0) {
        this.signatureManager.markHasData(sig, txs[0]);
      } else {
        console.error(`[实时] 获取交易失败: ${sig}`);
        return;
      }
    }

    if (this.isStopped) return;  // 再次检查

    // 处理交易
    const state = this.signatureManager.getState(sig);
    if (state && state.hasData && !state.isProcessed) {
      this.metricsEngine.processTransaction(state.txData, this.mint);
      this.signatureManager.markProcessed(sig);

      console.log(`[实时] 处理新交易: ${sig}`);

      // 打印指标
      this.metricsEngine.printMetrics();

      // 触发回调
      if (this.onMetricsUpdate && !this.isStopped) {
        this.onMetricsUpdate(this.metricsEngine.getMetrics());
      }

      // 检测是否有尚未评分的地址，触发快速评分
      const txAddr = state.txData?.transaction?.message?.accountKeys?.[0]?.pubkey;
      if (txAddr && this.metricsEngine.traderStats[txAddr]?.score === undefined) {
        this._scheduleQuickScore();
      }
    }
  }

  /**
   * 设置 Helius API 开关
   * 设置 Helius API Key
   */
  setApiKey(key) {
    this.apiKey = key || '';
    this.dataFetcher.setApiKey(this.apiKey);
    console.log('[HeliusMonitor] API Key 已更新');
  }

  /**
   * @param {boolean} enabled - 是否启用 Helius API
   */
  setHeliusApiEnabled(enabled) {
    this.heliusApiEnabled = enabled;
    console.log(`[HeliusMonitor] Helius API 调用: ${enabled ? '启用' : '禁用'}`);

    // 如果禁用，停止 WebSocket
    if (!enabled && this.ws) {
      console.log('[HeliusMonitor] 关闭 WebSocket 连接');
      this.ws.close();
      this.ws = null;
    }

    // 如果启用，重新连接 WebSocket
    if (enabled && !this.ws && this.isInitialized) {
      console.log('[HeliusMonitor] 重新连接 WebSocket');
      this.connectWs();
    }

    // 如果启用且已初始化，检查并补全缺失的交易
    if (enabled && this.isInitialized) {
      const stats = this.signatureManager.getStats();
      if (stats.needFetch > 0) {
        console.log(`[HeliusMonitor] 检测到 ${stats.needFetch} 个缺失交易，开始补全...`);
        this.fetchMissingTransactions()
          .then(() => this.performInitialCalculation())
          .then(() => {
            if (this.onStatsUpdate) {
              try {
                this.onStatsUpdate(this.signatureManager.getStats());
              } catch (e) {
                console.warn('[HeliusMonitor] onStatsUpdate 回调异常:', e.message);
              }
            }
            console.log('[HeliusMonitor] 缺失交易补全完成');
          })
          .catch(err => {
            console.error('[HeliusMonitor] 补全失败:', err.message);
          });
      }
    }
  }

  /**
   * 停止监控
   */
  stop() {
    console.log('[系统] 正在停止监控...');

    // 1. 设置停止标志（最先执行）
    this.isStopped = true;

    // 2. 清理 WebSocket
    if (this.ws) {
      // 移除事件监听器，防止 onclose 触发重连
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;

      try {
        this.ws.close();
      } catch (e) {
        console.error('[系统] 关闭 WebSocket 失败:', e);
      }
      this.ws = null;
    }

    // 3. 清理所有定时器
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    if (this.verifyInterval) {
      clearInterval(this.verifyInterval);
      this.verifyInterval = null;
    }

    // 4. 取消等待中的 Promise
    if (this.gmgnDataLoadedReject) {
      this.gmgnDataLoadedReject(new Error('Monitor stopped'));
      this.gmgnDataLoadedResolve = null;
      this.gmgnDataLoadedReject = null;
    }

    // 5. 清理回调
    this.onGmgnDataLoaded = null;
    this.onMetricsUpdate = null;

    // 6. 重置状态标志
    this.isInitialized = false;
    this.isWaitingForGmgn = false;

    // 7. 清理数据结构
    if (this.signatureManager) {
      this.signatureManager.clear();
    }
    if (this.metricsEngine) {
      this.metricsEngine.reset();
    }

    // 8. 关闭缓存管理器
    if (this.cacheManager) {
      try {
        this.cacheManager.close();
      } catch (e) {
        console.error('[系统] 关闭缓存管理器失败:', e);
      }
    }

    console.log('[系统] 监控已完全停止');
  }

  /**
   * 获取当前指标
   */
  getMetrics() {
    return this.metricsEngine.getMetrics();
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const stats = this.signatureManager.getStats();
    stats.heliusFetchedTotal = this.heliusFetchedTotal;  // Helius API 实际拉取总数（含缓存）
    return stats;
  }

  /**
   * 通知 WebSocket 状态变化
   */
  notifyWsStatusChange() {
    if (this.onWsStatusChange) {
      this.onWsStatusChange(this.getWsStatus());
    }
  }

  /**
   * 获取 WebSocket 状态
   */
  getWsStatus() {
    return {
      ...this.wsStatus,
      uptime: this.wsStatus.connected && this.wsStatus.lastConnectTime
        ? Date.now() - this.wsStatus.lastConnectTime
        : 0
    };
  }

  /**
   * 获取校验状态
   */
  getVerifyStatus() {
    return {
      enabled: !!this.verifyInterval,
      lastVerifyTime: this.lastVerifyTime,
      timeSinceLastVerify: this.lastVerifyTime
        ? Date.now() - this.lastVerifyTime
        : null
    };
  }

  /**
   * 更新庄家地址列表（从 HeliusIntegration 调用）
   * @param {Set} whaleAddresses - 庄家地址集合
   */
  updateWhaleAddresses(whaleAddresses) {
    console.log(`[HeliusMonitor] 更新庄家地址列表: ${whaleAddresses ? whaleAddresses.size : 0} 个庄家`);

    // 传递给 MetricsEngine
    if (this.metricsEngine) {
      this.metricsEngine.updateWhaleAddresses(whaleAddresses);
    }
  }

  /**
   * 定期校验 signatures 完整性
   * 每30秒检查一次是否有遗漏的 signatures
   */
  async verifySignatures() {
    if (this.isStopped) return;

    const startTime = Date.now();
    console.log('[校验] 开始校验 signatures...');

    try {
      // 只获取最新的 1000 个 signatures
      const latestSigs = await this.dataFetcher.fetchSignatures(this.mint, {
        limit: 1000
      });

      if (this.isStopped) return;

      // 检查是否有新的 signatures
      let newCount = 0;
      const newSigs = [];

      latestSigs.forEach(sig => {
        if (!this.signatureManager.signatures.has(sig)) {
          this.signatureManager.addSignature(sig, 'verify');  // 用 verify 源，避免污染 initial 计数
          newSigs.push(sig);
          newCount++;
        }
      });

      if (newCount > 0) {
        console.log(`[校验] ⚠️  发现 ${newCount} 个遗漏的 signatures`);
        console.log(`[校验] 正在补充遗漏的交易数据...`);

        // 获取遗漏交易的详细数据
        const txs = await this.dataFetcher.fetchParsedTxs(newSigs, this.mint);

        if (this.isStopped) return;

        // 处理遗漏的交易
        for (const tx of txs) {
          if (this.isStopped) return;

          const sig = tx.transaction.signatures[0];
          this.signatureManager.markHasData(sig, tx);

          // 立即计算
          this.metricsEngine.processTransaction({ type: 'helius', data: tx }, this.mint);
          this.signatureManager.markProcessed(sig);
        }

        console.log(`[校验] ✓ 已补充 ${newCount} 个遗漏的交易`);
      } else {
        console.log(`[校验] ✓ 没有遗漏 (耗时: ${Date.now() - startTime}ms)`);
      }

      this.lastVerifyTime = Date.now();

      // 校验完成后推送最新 stats 到 UI
      if (this.onStatsUpdate) {
        try {
          this.onStatsUpdate(this.signatureManager.getStats());
        } catch (e) {
          console.warn('[HeliusMonitor] onStatsUpdate 回调异常:', e.message);
        }
      }

    } catch (error) {
      if (this.isStopped) return;
      console.error('[校验] 校验失败:', error.message);
    }
  }

  /**
   * 更新 holder 数据并执行评分
   * @param {Array} holders - holder 数据
   */
  async updateHolderData(holders) {
    try {
      console.log('[HeliusMonitor] 更新 holder 数据并执行评分', { holderCount: holders.length });

      // 记录日志
      dataFlowLogger.log(
        'HeliusMonitor',
        '开始评分流程',
        `接收到 ${holders.length} 个 holder，开始执行评分`,
        { holderCount: holders.length }
      );

      // 1. 将 holder 快照数据合并进 traderStats（用于评分）
      this.metricsEngine.updateUsersInfo(holders);
      console.log('[HeliusMonitor] 步骤1完成: updateUsersInfo', { traderStatsCount: Object.keys(this.metricsEngine.traderStats).length });

      dataFlowLogger.log(
        'HeliusMonitor',
        '步骤1: 更新用户信息',
        `已更新 ${Object.keys(this.metricsEngine.traderStats).length} 个用户的基础信息`,
        { traderStatsCount: Object.keys(this.metricsEngine.traderStats).length }
      );

      // 步骤1.5b: 隐藏中转检测
      if (this.bossConfig.enable_hidden_relay) {
        await this.detectHiddenRelays();
      }

      // 2. 计算分数
      console.log('[HeliusMonitor] 步骤2开始: calculateScores', {
        bossConfigKeys: Object.keys(this.bossConfig).length,
        statusThreshold: this.statusThreshold
      });

      dataFlowLogger.log(
        'HeliusMonitor',
        '步骤2: 开始计算分数',
        `使用 ScoringEngine 计算分数，配置项: ${Object.keys(this.bossConfig).length} 个`,
        {
          bossConfigKeys: Object.keys(this.bossConfig).length,
          statusThreshold: this.statusThreshold,
          scoreThreshold: this.scoreThreshold
        }
      );

      const { scoreMap, whaleAddresses } = this.scoringEngine.calculateScores(
        this.metricsEngine.traderStats,
        this.metricsEngine.traderStats,
        this.bossConfig,
        this.manualScores,
        this.statusThreshold
      );
      console.log('[HeliusMonitor] 步骤2完成: calculateScores', { scoreMapSize: scoreMap.size, whaleCount: whaleAddresses.size });

      dataFlowLogger.log(
        'HeliusMonitor',
        '步骤2: 分数计算完成',
        `计算了 ${scoreMap.size} 个用户的分数，识别出 ${whaleAddresses.size} 个庄家`,
        {
          scoreMapSize: scoreMap.size,
          whaleCount: whaleAddresses.size,
          retailCount: scoreMap.size - whaleAddresses.size
        }
      );

      // 3. 将分数存储到 traderStats
      let updatedCount = 0;
      for (const [address, scoreData] of scoreMap.entries()) {
        if (this.metricsEngine.traderStats[address]) {
          this.metricsEngine.traderStats[address].score = scoreData.score;
          this.metricsEngine.traderStats[address].score_reasons = scoreData.reasons;
          this.metricsEngine.traderStats[address].status = scoreData.status;
          updatedCount++;
        }
      }
      console.log('[HeliusMonitor] 步骤3完成: 存储分数', { updatedCount });

      dataFlowLogger.log(
        'HeliusMonitor',
        '步骤3: 存储分数到 traderStats',
        `已将分数存储到 ${updatedCount} 个用户的 traderStats 中`,
        { updatedCount }
      );

      // 4. 根据 scoreThreshold 过滤用户
      const filteredUsers = this.filterUsersByScore(scoreMap);
      console.log('[HeliusMonitor] 步骤4完成: 过滤用户', { filteredCount: filteredUsers.size });

      dataFlowLogger.log(
        'HeliusMonitor',
        '步骤4: 过滤用户',
        `根据阈值 ${this.scoreThreshold} 过滤，保留 ${filteredUsers.size} 个用户`,
        {
          filteredCount: filteredUsers.size,
          threshold: this.scoreThreshold
        }
      );

      // 5. 更新庄家地址列表
      this.metricsEngine.updateWhaleAddresses(whaleAddresses);

      // 6. 设置过滤后的用户列表
      this.metricsEngine.setFilteredUsers(filteredUsers);

      // 7. 重新计算指标
      this.recalculateMetrics();
      console.log('[HeliusMonitor] 步骤7完成: 重新计算指标');

      dataFlowLogger.log(
        'HeliusMonitor',
        '评分流程完成',
        `评分流程全部完成，用户数据已更新`,
        {
          totalUsers: Object.keys(this.metricsEngine.traderStats).length,
          whaleCount: whaleAddresses.size,
          filteredCount: filteredUsers.size
        }
      );
    } catch (error) {
      console.error('[HeliusMonitor] updateHolderData 执行失败:', error);
      console.error('[HeliusMonitor] 错误堆栈:', error.stack);

      dataFlowLogger.log(
        'HeliusMonitor',
        '评分流程失败',
        `评分过程中发生错误: ${error.message}`,
        {
          error: error.message,
          stack: error.stack
        }
      );
    }
  }

  /**
   * 根据分数阈值构建散户集合
   * 以 traderStats 为基准：有评分的用 score 判断，无评分（纯 sig 用户）默认 score=0 视为散户
   */
  filterUsersByScore(scoreMap) {
    const filtered = new Set();
    const traderStats = this.metricsEngine.traderStats;

    for (const address of Object.keys(traderStats)) {
      const score = scoreMap.get(address)?.score ?? 0;
      if (score < this.scoreThreshold) {
        filtered.add(address);
      }
    }

    console.log('[HeliusMonitor] 过滤用户', {
      traderTotal: Object.keys(traderStats).length,
      scored: scoreMap.size,
      filtered: filtered.size,
      threshold: this.scoreThreshold
    });
    return filtered;
  }

  /**
   * 重新计算指标
   */
  recalculateMetrics() {
    const metrics = this.metricsEngine.getMetrics();
    console.log('[HeliusMonitor] 重新计算指标', metrics);

    // 触发回调
    if (this.onMetricsUpdate) {
      this.onMetricsUpdate(metrics);
    }
  }

  /**
   * WS 新交易触发的快速评分（500ms debounce）
   * 用于为尚未评分的地址快速计算分数，消除"检查中"状态
   * 对无 GMGN holder 快照的地址：funding_account 为空 → 无资金来源规则触发 → score≈10
   */
  _scheduleQuickScore() {
    clearTimeout(this._quickScoreTimer);
    this._quickScoreTimer = setTimeout(() => {
      if (this.isStopped) return;
      const { scoreMap, whaleAddresses } = this.scoringEngine.calculateScores(
        this.metricsEngine.traderStats,
        this.metricsEngine.traderStats,
        this.bossConfig,
        this.manualScores,
        this.statusThreshold
      );
      for (const [address, scoreData] of scoreMap.entries()) {
        if (this.metricsEngine.traderStats[address]) {
          this.metricsEngine.traderStats[address].score = scoreData.score;
          this.metricsEngine.traderStats[address].status = scoreData.status;
          this.metricsEngine.traderStats[address].score_reasons = scoreData.reasons;
        }
      }
      const filteredUsers = this.filterUsersByScore(scoreMap);
      this.metricsEngine.updateWhaleAddresses(whaleAddresses);
      this.metricsEngine.setFilteredUsers(filteredUsers);
      this.recalculateMetrics();
    }, 500);
  }

  /**
   * 设置 Score< 过滤阈值
   */
  setScoreThreshold(threshold) {
    console.log('[HeliusMonitor] 设置 Score< 阈值:', threshold);
    this.scoreThreshold = threshold;

    // 以 traderStats 为基准重新构建散户集合
    const traderStats = this.metricsEngine.traderStats;
    if (Object.keys(traderStats).length > 0) {
      const filteredUsers = new Set();
      for (const [address, user] of Object.entries(traderStats)) {
        if ((user.score || 0) < threshold) {
          filteredUsers.add(address);
        }
      }

      console.log('[HeliusMonitor] 重新过滤用户:', {
        threshold,
        totalTraders: Object.keys(traderStats).length,
        filteredCount: filteredUsers.size
      });

      this.metricsEngine.setFilteredUsers(filteredUsers);
    }

    // 重新计算指标
    this.recalculateMetrics();
  }

  /**
   * 设置状态判断阈值
   */
  setStatusThreshold(threshold) {
    console.log('[HeliusMonitor] 设置状态判断阈值:', threshold);
    this.statusThreshold = threshold;
    // 触发重新评分（需要重新获取 holder 数据）
    // 这里暂时只更新阈值，实际重新评分由 HeliusIntegration 触发
  }

  /**
   * 设置手动标记
   */
  setManualScore(address, status) {
    console.log('[HeliusMonitor] 设置手动标记:', { address, status });
    this.manualScores[address] = status;

    // 持久化到 Chrome storage
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({
        [`manual_scores_${this.mint}`]: this.manualScores
      });
    }

    // 触发重新评分（需要重新获取 holder 数据）
    // 这里暂时只更新标记，实际重新评分由 HeliusIntegration 触发
  }

  /**
   * 批量设置手动标记
   * @param {Object} manualScores - 手动标记对象 { address: status }
   */
  setManualScores(manualScores) {
    console.log('[HeliusMonitor] 批量设置手动标记:', { count: Object.keys(manualScores).length });
    this.manualScores = { ...manualScores };
  }

  /**
   * 设置评分配置
   */
  setBossConfig(config) {
    console.log('[HeliusMonitor] 设置评分配置');
    this.bossConfig = config;
    // 触发重新评分（需要重新获取 holder 数据）
    // 这里暂时只更新配置，实际重新评分由 HeliusIntegration 触发
  }

  /**
   * 检测单笔交易是否为隐藏中转模式
   * 最小条件: spl-associated-token-account:create + spl-token:closeAccount 同时出现
   */
  isHiddenRelayTx(tx) {
    const instructions = tx?.transaction?.message?.instructions;
    if (!instructions || !Array.isArray(instructions)) return { isRelay: false, conditions: [] };

    const conditions = [];
    let hasCreate = false, hasClose = false;

    for (const ix of instructions) {
      const prog = ix.program || '';
      const pType = ix.parsed?.type || '';
      if (prog === 'spl-associated-token-account') {
        hasCreate = true;
        conditions.push('Create');
      }
      if (prog === 'spl-token' && pType === 'closeAccount') {
        hasClose = true;
        conditions.push('CloseAccount');
      }
      if (prog === 'system' && pType === 'transfer') {
        conditions.push('Transfer');
      }
      if (prog === 'spl-token' && pType === 'syncNative') {
        conditions.push('SyncNative');
      }
    }

    return { isRelay: hasCreate && hasClose, conditions };
  }

  /**
   * 批量检测隐藏中转资金来源
   * 分页翻到最旧 sig → 检测第一笔交易 → 缓存结果到 chrome.storage.local
   */
  async detectHiddenRelays() {
    // 防止并发：同一时刻只允许一个实例运行
    if (this._relayDetecting) {
      console.log('[HiddenRelay] 已有检测在运行，跳过本次');
      return;
    }
    this._relayDetecting = true;

    try {
    const userInfo = this.metricsEngine.traderStats;
    const allUsers = Object.keys(userInfo);
    if (allUsers.length === 0) { this._relayDetecting = false; return; }

    // 推送日志到插件日志区的辅助函数
    const sendLog = (msg) => {
      try {
        chrome.runtime.sendMessage({ type: 'LOG', message: msg }).catch(() => {});
      } catch (e) { /* 忽略 */ }
    };

    // 1. 批量读取缓存，过滤出未检测过的用户
    const cacheKeys = allUsers.map(u => `hidden_relay_${u}`);
    const cached = await new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get(cacheKeys, resolve);
      } else {
        resolve({});
      }
    });

    const unchecked = allUsers.filter(u => cached[`hidden_relay_${u}`] === undefined);

    // 从缓存中恢复已有结果
    for (const u of allUsers) {
      const c = cached[`hidden_relay_${u}`];
      if (c !== undefined) {
        userInfo[u].has_hidden_relay = c.isRelay;
        userInfo[u].hidden_relay_conditions = c.conditions;
      }
    }

    if (unchecked.length === 0) {
      console.log('[HiddenRelay] 全部命中缓存，跳过检测');
      return;
    }

    const total = unchecked.length;
    const cached_count = allUsers.length - total;
    sendLog(`[中转检测] 开始: ${total}个待查 / ${cached_count}个缓存`);
    console.log(`[HiddenRelay] 开始检测 ${total} 个未缓存用户`);

    // 2. 分批检测（每批2人，避免限速）
    const BATCH_SIZE = 2;
    let relayCount = 0;
    let doneCount = 0;

    for (let i = 0; i < unchecked.length; i += BATCH_SIZE) {
      const batch = unchecked.slice(i, i + BATCH_SIZE);

      for (const address of batch) {
        doneCount++;
        const shortAddr = `${address.slice(0, 6)}..${address.slice(-4)}`;
        try {
          sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} 翻页中...`);

          // 分页获取最旧 sig（最多翻10页 = 10000条）
          let before = undefined;
          let lastBatch = [];
          let pageCount = 0;
          const MAX_PAGES = this.bossConfig?.hidden_relay_max_pages || 10;

          for (let page = 0; page < MAX_PAGES; page++) {
            const params = [address, { limit: 1000, ...(before ? { before } : {}) }];
            const sigs = await this.dataFetcher.call('getSignaturesForAddress', params);
            if (!Array.isArray(sigs) || sigs.length === 0) break;
            lastBatch = sigs;
            pageCount++;
            if (sigs.length < 1000) break;  // 已到底
            before = sigs[sigs.length - 1].signature;
            await new Promise(r => setTimeout(r, 500));  // 避免限速
          }

          if (lastBatch.length === 0) {
            userInfo[address].has_hidden_relay = false;
            userInfo[address].hidden_relay_conditions = [];
            if (typeof chrome !== 'undefined' && chrome.storage) {
              chrome.storage.local.set({ [`hidden_relay_${address}`]: { isRelay: false, conditions: [], checkedAt: Date.now() } });
            }
            sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} 无sig，跳过`);
            continue;
          }

          const totalSigs = (pageCount - 1) * 1000 + lastBatch.length;
          const oldestSig = lastBatch[lastBatch.length - 1].signature;

          sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} 共${totalSigs}条sig，检测第1笔...`);

          // 获取最旧交易详情
          const tx = await this.dataFetcher.call('getTransaction', [
            oldestSig,
            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
          ]);

          let isRelay = false;
          let conditions = [];

          if (tx) {
            const result = this.isHiddenRelayTx(tx);
            isRelay = result.isRelay;
            conditions = result.conditions;
          }

          // 写入 userInfo
          userInfo[address].has_hidden_relay = isRelay;
          userInfo[address].hidden_relay_conditions = conditions;

          // 持久化缓存
          if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({
              [`hidden_relay_${address}`]: { isRelay, conditions, checkedAt: Date.now() }
            });
          }

          if (isRelay) {
            relayCount++;
            sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} ⚠ 中转[${conditions.join('+')}]`);
          } else {
            sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} - 普通`);
          }
          console.log(`[HiddenRelay] ${shortAddr} isRelay=${isRelay} conds=[${conditions.join(',')}]`);

        } catch (err) {
          console.warn(`[HiddenRelay] 检测失败 ${shortAddr}:`, err.message);
          userInfo[address].has_hidden_relay = false;
          userInfo[address].hidden_relay_conditions = [];
          sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} 错误: ${err.message.slice(0, 30)}`);
        }

        await new Promise(r => setTimeout(r, 500));  // 用户间间隔
      }

      if (i + BATCH_SIZE < unchecked.length) {
        await new Promise(r => setTimeout(r, 800));  // 批次间间隔
      }
    }

    sendLog(`[中转检测] 完成: ${relayCount}个中转 / ${total - relayCount}个普通`);
    console.log('[HiddenRelay] 检测完成');

    } finally {
      this._relayDetecting = false;
    }
  }

}

