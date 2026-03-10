/**
 * HeliusMonitor v2 - 浏览器版 Helius 监控器
 *
 * v2 核心改动：
 *  1. 并行初始化：Helius sig 获取 + 等待 GMGN 数据 同时进行（不再串行等待）
 *  2. 流式 sig 获取：每页拿到立即注入 SignatureManager，不等全部完成
 *  3. 动态 verify 间隔：无新 sig → 放宽间隔；有遗漏 → 缩短间隔
 *  4. 用户数据（手动标记/隐藏中转）全部走 IndexedDB users 表，不再用 chrome.storage
 *  5. verifySignatures 只拉最新 50 条（不是 1000 条）
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
    this.heliusApiEnabled = true;
    this.heliusFetchedTotal = 0;

    // 评分配置（唯一阈值：score >= scoreThreshold → 庄家）
    this.scoreThreshold = 100;
    this.manualScores = {};
    this.bossConfig = {};

    // 回调
    this.onMetricsUpdate = null;
    this.onGmgnDataLoaded = null;
    this.onStatusLog = null;    // 状态日志回调 → App.jsx 底部日志面板

    // 生命周期
    this.isStopped = false;
    this.reconnectTimeout = null;
    this.progressInterval = null;

    // WebSocket 状态
    this.wsStatus = { connected: false, lastConnectTime: null, lastDisconnectTime: null, reconnectCount: 0, error: null };
    this.onWsStatusChange = null;

    // 动态 verify 状态
    this.verifyInterval = null;
    this.lastVerifyTime = null;
    this._verifyIntervalMs = 30000; // 初始30s，动态调整
    this._verifyMissCount = 0;      // 连续0次遗漏计数（用于放宽间隔）

    // 实时 sig 流（初始化完成后的所有新 sig，含 hasData=false 的待处理条目）
    this.sigFeed = [];

    // GMGN 首次分页加载完成信号（等待 EXECUTE_TRADES_REFRESH 第一轮翻页结束）
    this._gmgnFirstLoadResolve = null;
    this._gmgnFirstLoadPromise = new Promise(resolve => {
      this._gmgnFirstLoadResolve = resolve;
    });
  }

  // ─────────────────────────────────────────────────────────
  // 状态日志（发送到 App.jsx 底部日志面板）
  // ─────────────────────────────────────────────────────────

  _log(msg) {
    if (this.onStatusLog) {
      try { this.onStatusLog(`[Helius] ${msg}`); } catch (_e) { /* ignore */ }
    }
  }

  // ─────────────────────────────────────────────────────────
  // GMGN 首次加载信号
  // ─────────────────────────────────────────────────────────

  /** HeliusIntegration 收到 GMGN_TRADES_LOADED 后调用此方法 */
  notifyGmgnFirstLoad() {
    if (this._gmgnFirstLoadResolve) {
      this._gmgnFirstLoadResolve();
      this._gmgnFirstLoadResolve = null; // 只触发一次
    }
  }

  /**
   * 等待 GMGN 首次分页加载完成，超时后自动继续
   * @param {number} timeoutMs 最长等待毫秒数，默认 60s
   */
  async _waitForGmgnFirstLoad(timeoutMs = 60000) {
    const timeoutPromise = new Promise(resolve => setTimeout(resolve, timeoutMs));
    await Promise.race([this._gmgnFirstLoadPromise, timeoutPromise]);
  }

  // ─────────────────────────────────────────────────────────
  // sigFeed 实时流 helpers
  // ─────────────────────────────────────────────────────────

  /** 新 sig 到达时立即加入 feed（pending 状态） */
  _addSigToFeed(sig, source) {
    if (this.sigFeed.some(e => e.sig === sig)) return;
    this.sigFeed.unshift({ sig, source, hasData: false, action: null, address: null, solAmount: null, tokenAmount: null, rawTimestamp: Date.now(), label: null });
    if (this.sigFeed.length > 20000) this.sigFeed.length = 20000;
  }

  /** 处理完成后用 MetricsEngine recentTrades[0] 更新 feed 条目 */
  _updateSigFeed(sig) {
    const entry = this.sigFeed.find(e => e.sig === sig);
    if (!entry) return;
    const trade = this.metricsEngine.recentTrades[0];
    if (trade?.signature === sig) {
      entry.hasData   = true;
      entry.action    = trade.action;
      entry.address   = trade.address;
      entry.solAmount = trade.solAmount;
      entry.tokenAmount = trade.tokenAmount;
      entry.rawTimestamp = trade.rawTimestamp;
      entry.label     = trade.label;
    }
  }

  /** 统一触发 onMetricsUpdate，自动附带 sigFeed */
  _fireMetricsUpdate() {
    if (!this.onMetricsUpdate || this.isStopped) return;
    const metrics = this.metricsEngine.getMetrics();
    metrics.sigFeed = this.sigFeed.slice(0, 100);
    this.onMetricsUpdate(metrics);
  }

  // ─────────────────────────────────────────────────────────
  // 启动
  // ─────────────────────────────────────────────────────────

  async start() {
    this._log(`启动中... mint=${this.mint.slice(0, 8)}...`);
    console.log(`[Helius] 启动 mint=${this.mint.slice(0, 8)}...`);

    // 1. 初始化 IndexedDB
    this._log('初始化 IndexedDB...');
    try {
      await this.cacheManager.init();
      if (this.isStopped) return;
      this._log('IndexedDB 就绪');
    } catch (initErr) {
      if (this.cacheManager.disabled) {
        const reason = initErr?.message === 'IndexedDB_BLOCKED' ? 'BLOCKED（另一标签页占用）' : '超时（6s）';
        this._log(`⚠ IndexedDB ${reason}，无缓存模式`);
      } else {
        throw initErr;
      }
    }
    if (this.isStopped) return;

    // 2. 从 IndexedDB 加载手动标记
    this.manualScores = await this.cacheManager.loadManualScores(this.mint);
    console.log(`[Helius] 手动标记加载完成: ${Object.keys(this.manualScores).length} 条`);

    // 3. WS 已禁用，不调用 connectWs()

    // 4. 启动 Helius 后台初始化任务（非阻塞，GMGN 数据同时正常流入）
    this._runHeliusInitTask().catch(err => {
      if (!this.isStopped) {
        console.error('[Helius] ❌ 初始化任务异常:', err);
        this._log(`❌ 初始化失败: ${err?.message || err}`);
      }
    });
  }

  /**
   * Helius 后台初始化任务（非阻塞，由 start() 启动）
   *
   * Step 1: 获取 mint 全部历史 sig（必须成功）
   * Step 2: 补全缺失 tx（GMGN plugin 数据优先，剩余调 Helius API）
   * Step 3: 从最早 sig 开始做首次 4 大参数计算
   * Step 4: isInitialized = true，进入实时模式
   */
  async _runHeliusInitTask() {
    // ── Step 1: 获取全部历史 sig ──
    console.log('[Helius] ── Step 1: 获取全部历史 sig ──');
    this._log('Step 1: 获取历史 sig 中...');

    if (!this.heliusApiEnabled) {
      console.log('[Helius] heliusApiEnabled=false，跳过 Helius 历史 sig 获取，直接进入实时模式');
      this._log('Helius API 未启用，直接进入实时模式');
      this.isInitialized = true;
      return;
    }

    const fetchResult = await this._fetchSigsStreaming();
    if (this.isStopped) return;

    const sigStats = this.signatureManager.getStats();
    console.log(`[Helius] Step 1 ✓ sig 获取完成: 新增=${fetchResult.totalNew} 缓存=${fetchResult.totalCached} 总计=${sigStats.total}`);
    this._log(`Step 1 ✓: ${sigStats.total} 条 sig`);

    if (sigStats.total === 0) {
      console.warn('[Helius] ⚠ 未获取到任何 sig，可能是新代币或 API 错误');
      this._log('⚠ 未获取到任何 sig');
    }

    // ── 等待 GMGN 第一轮翻页完成（EXECUTE_TRADES_REFRESH 全部跑完）──
    // 目的：确保 GMGN 数据已注入 SignatureManager，Step 2 补全时优先用 GMGN 数据
    console.log('[Helius] ── 等待 GMGN 第一轮分页加载完成（最多60s）──');
    this._log('等待 GMGN 首次数据加载...');
    await this._waitForGmgnFirstLoad(60000);
    if (this.isStopped) return;
    const gmgnStats = this.signatureManager.getStats();
    console.log(`[Helius] ✓ GMGN 数据已就绪，SignatureManager 当前 sig 总数=${gmgnStats.total} 有数据=${gmgnStats.withData}`);
    this._log(`GMGN 数据就绪，有数据=${gmgnStats.withData}`);

    // ── Step 2: 补全缺失 tx ──
    const missing1 = this.signatureManager.getMissingSignatures();
    console.log(`[Helius] ── Step 2: 补全 tx 数据 ──`);
    console.log(`[Helius] Step 2: 共 ${sigStats.total} 条 sig，GMGN 已覆盖 ${sigStats.total - missing1.length} 条，剩余 ${missing1.length} 条需从 API 获取`);
    this._log(`Step 2: 补全 ${missing1.length} 条 tx...`);

    await this.fetchMissingTransactions();
    if (this.isStopped) return;

    const missing2 = this.signatureManager.getMissingSignatures();

    // 按来源统计 tx 数据覆盖情况
    let gmgnCount = 0, heliusApiCount = 0, cacheCount = 0;
    for (const [, entry] of this.signatureManager.signatures.entries()) {
      if (!entry.hasData || !entry.txData) continue;
      if (entry.txData.type === 'gmgn')   gmgnCount++;
      else if (entry.txData.type === 'helius') heliusApiCount++;
      else if (entry.txData.type === 'cache')  cacheCount++;
    }
    console.log(`[Helius] Step 2 来源统计: GMGN覆盖=${gmgnCount} 缓存命中=${cacheCount} Helius API获取=${heliusApiCount} 仍缺失=${missing2.length}`);
    this._log(`Step 2 统计: GMGN=${gmgnCount} 缓存=${cacheCount} API=${heliusApiCount} 缺失=${missing2.length}`);

    if (missing2.length > 0) {
      console.error(`[Helius] ❌ Step 2 失败: 仍有 ${missing2.length} 条 tx 未能获取（API 错误或限流）`);
      this._log(`❌ Step 2: ${missing2.length} 条 tx 获取失败`);
    } else {
      console.log(`[Helius] Step 2 ✓ 全部 tx 补全完成`);
      this._log('Step 2 ✓: 全部 tx 已补全');
    }

    // ── Step 3: 首次 4 大参数计算（从最早 sig 开始） ──
    console.log(`[Helius] ── Step 3: 首次 4 大参数计算 ──`);
    this._log('Step 3: 开始历史计算（从最早 sig）...');

    await this.performInitialCalculation();
    if (this.isStopped) return;

    console.log(`[Helius] Step 3 ✓ 计算完成，已处理 ${this.metricsEngine.processedCount} 条`);
    this._log(`Step 3 ✓: 已处理 ${this.metricsEngine.processedCount} 条`);

    // ── Step 3.5: 立即评分（对所有账户打分，确定散户/庄家）──
    // 必须在 4大参数报告 和 UI 更新之前运行，使 filteredUsers 生效
    console.log('[Helius] ── Step 3.5: 立即评分 ──');
    this._log('Step 3.5: 立即评分...');
    const traderCount = Object.keys(this.metricsEngine.traderStats).length;
    if (traderCount > 0) {
      // [调试] Step 3.5 前 traderStats 快照
      console.log('[Step3.5-前] traderStats:',
        Object.entries(this.metricsEngine.traderStats).map(([addr, info]) => ({
          addr: `${addr.slice(0, 6)}..${addr.slice(-4)}`,
          score: info.score, status: info.status, manualScore: info.manualScore,
        }))
      );
      const { scoreMap, whaleAddresses } = this.scoringEngine.calculateScores(
        this.metricsEngine.traderStats,
        this.metricsEngine.traderStats,
        this.bossConfig,
        this.manualScores,
        this.scoreThreshold
      );
      for (const [address, scoreData] of scoreMap.entries()) {
        if (this.metricsEngine.traderStats[address]) {
          this.metricsEngine.traderStats[address].score = scoreData.score;
          this.metricsEngine.traderStats[address].score_reasons = scoreData.reasons;
          // ScoringEngine 已处理三态：enable_hidden_relay=true 时非庄家返回'普通'，否则'散户'
          this.metricsEngine.traderStats[address].status = scoreData.status;
        }
      }
      // filteredUsers = score < threshold 的全部用户（含"普通"状态）
      // 列表立刻显示；慢速评分完成一个后该用户 label 升级为"散户"
      const filteredUsers = this.filterUsersByScore(scoreMap);
      this.metricsEngine.updateWhaleAddresses(whaleAddresses);
      this.metricsEngine.setFilteredUsers(filteredUsers);
      // [调试] Step 3.5 后 traderStats 快照
      console.log('[Step3.5-后] traderStats:',
        Object.entries(this.metricsEngine.traderStats).map(([addr, info]) => ({
          addr: `${addr.slice(0, 6)}..${addr.slice(-4)}`,
          score: info.score, status: info.status, manualScore: info.manualScore,
        }))
      );
      console.log(`[Helius] Step 3.5 ✓ 评分完成，共 ${scoreMap.size} 个账户，散户=${filteredUsers.size} 庄家=${whaleAddresses.size}`);
      this._log(`Step 3.5 ✓: ${scoreMap.size} 账户已评分，散户=${filteredUsers.size}`);
    } else {
      console.log('[Helius] Step 3.5 跳过（无账户数据）');
    }


    // ── 4大参数报告（评分后输出，filteredUsers 已生效）──
    this.metricsEngine.printCalculationReport();

    // ── Step 4: 进入实时模式 ──
    this.isInitialized = true;
    console.log('[Helius] ✅ 初始化完成，进入实时模式');
    this._log('✅ 初始化完成，进入实时模式');
    this._fireMetricsUpdate();
        // 触发慢速评分（enable_hidden_relay=true 时异步运行 detectHiddenRelays）
    this._scheduleSlowScore();
  }

  /**
   * Helius sig 流式获取（每页回调注入 SignatureManager）
   */
  async _fetchSigsStreaming() {
    if (!this.heliusApiEnabled) return { totalNew: 0, totalCached: 0 };

    return this.dataFetcher.fetchHistorySigsStreaming(this.mint, (rawSigs, pageIndex, isLast) => {
      if (this.isStopped) return;

      // 每页立即注入 SignatureManager（带 slot/blockTime 元数据）
      this.signatureManager.addSignatureBatch(rawSigs, 'initial');

      if (pageIndex === 1) {
        this._log(`Helius 第1页: ${rawSigs.length} 条 sig，拉取中...`);
        // 第一页到来，立即通知 UI sig 总数
        if (this.onStatsUpdate) {
          try { this.onStatsUpdate(this.signatureManager.getStats()); } catch (e) { /* ignore */ }
        }
      } else if (pageIndex % 5 === 0) {
        const stats = this.signatureManager.getStats();
        this._log(`Helius 第${pageIndex}页，已获取 ${stats.total} 条 sig...`);
      }

      if (isLast && pageIndex > 1) {
        const stats = this.signatureManager.getStats();
        this._log(`Helius 历史拉取完毕: 共 ${pageIndex} 页，${stats.total} 条`);
      }
    });
  }

  // ─────────────────────────────────────────────────────────
  // WebSocket
  // ─────────────────────────────────────────────────────────

  connectWs() {
    if (!this.heliusApiEnabled || this.isStopped) return;

    if (this.ws) {
      try { this.ws.close(); } catch (_e) { /* ignore */ }
    }

    this.ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`);

    this.ws.onopen = () => {
      if (this.isStopped) return;
      this.wsStatus = { ...this.wsStatus, connected: true, lastConnectTime: Date.now(), error: null };
      this._log('WebSocket 已连接 ✓，订阅中...');
      this.notifyWsStatusChange();

      this.ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: [this.mint] }, { commitment: 'confirmed' }]
      }));

      this.pingInterval = setInterval(() => {
        if (this.isStopped) { clearInterval(this.pingInterval); return; }
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    };

    this.ws.onmessage = (event) => {
      if (this.isStopped) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.method === 'logsNotification') {
          const value = msg.params.result.value;
          // 跳过链上失败的交易（err 不为 null）
          if (value.err !== null && value.err !== undefined) return;
          this.handleNewSignature(value.signature, 'websocket');
        }
      } catch (err) {
      }
    };

    this.ws.onclose = () => {
      if (this.isStopped) return;
      clearInterval(this.pingInterval);
      this.wsStatus = { ...this.wsStatus, connected: false, lastDisconnectTime: Date.now(), reconnectCount: this.wsStatus.reconnectCount + 1 };
      this._log(`WebSocket 断开，3s 后重连 (第${this.wsStatus.reconnectCount}次)...`);
      this.notifyWsStatusChange();
      this.reconnectTimeout = setTimeout(() => { if (!this.isStopped) this.connectWs(); }, 3000);
    };

    this.ws.onerror = (err) => {
      if (this.isStopped) return;
      this.wsStatus = { ...this.wsStatus, error: err.message || 'WebSocket 连接错误' };
      this.notifyWsStatusChange();
    };
  }

  // ─────────────────────────────────────────────────────────
  // 补全缺失 tx 详情
  // ─────────────────────────────────────────────────────────

  async fetchMissingTransactions() {
    if (!this.heliusApiEnabled || this.isStopped) return;

    const missingSigs = this.signatureManager.getMissingSignatures();
    if (missingSigs.length === 0) {
      return;
    }

    // 先从缓存加载
    this._log(`加载缓存 tx: ${missingSigs.length} 条 sig 需要数据...`);
    const cachedTxs = await this.cacheManager.loadTransactionsBySignatures(missingSigs);
    if (this.isStopped) return;

    cachedTxs.forEach(tx => {
      const sig = tx.transaction.signatures[0];
      this.signatureManager.markHasData(sig, tx);
    });
    if (cachedTxs.length > 0) {
      this._log(`缓存命中: ${cachedTxs.length} 条`);
    }

    // 从 API 获取仍缺失的
    const stillMissing = this.signatureManager.getMissingSignatures();
    if (stillMissing.length === 0) return;

    this._log(`从 Helius API 获取 ${stillMissing.length} 条 tx 数据 (每批100)...`);
    let fetchedCount = 0;
    const CHUNK_SIZE = 100;
    for (let i = 0; i < stillMissing.length; i += CHUNK_SIZE) {
      if (this.isStopped) return;
      const chunk = stillMissing.slice(i, i + CHUNK_SIZE);
      const txs = await this.dataFetcher.fetchParsedTxs(chunk, this.mint);
      if (this.isStopped) return;
      txs.forEach(tx => {
        const sig = tx.transaction.signatures[0];
        this.signatureManager.markHasData(sig, tx);
      });
      fetchedCount += txs.length;
      if (stillMissing.length > CHUNK_SIZE) {
        this._log(`Tx 获取进度: ${Math.min(i + CHUNK_SIZE, stillMissing.length)}/${stillMissing.length}`);
      }
    }

    this._log(`Tx 补全完成: 缓存=${cachedTxs.length} API=${fetchedCount}`);
  }

  // ─────────────────────────────────────────────────────────
  // 首次计算
  // ─────────────────────────────────────────────────────────

  async performInitialCalculation() {
    if (this.isStopped) return;

    // 顺序计算：从旧到新，遇到第一个 hasData=false gap 就停
    // 保证 4 大参数按时序连续计算，gap 后的 sig 等补全后再续算
    const readySignatures = this.signatureManager.getReadySignaturesSequential();
    if (readySignatures.length === 0) {
      return;
    }

    const gapCount = this.signatureManager.getMissingSignatures().length;
    this._log(`处理历史交易: ${readySignatures.length} 条（顺序计算）${gapCount > 0 ? `，仍有 ${gapCount} 条缺口待补全` : ''}`);
    this.metricsEngine.setTotalTransactions(readySignatures.length);

    // [诊断日志] Step7 计算排序结果
    if (dataFlowLogger.enabled) {
      const first = readySignatures[0];
      const last  = readySignatures[readySignatures.length - 1];
      dataFlowLogger.log('HeliusMonitor', 'Step7 计算排序', `共${readySignatures.length}条 | 最旧(先处理)sig=${first?.sig?.slice(0,8)} slot=${first?.slot} ts=${first?.blockTime||first?.timestamp} | 最新(后处理)sig=${last?.sig?.slice(0,8)} slot=${last?.slot} ts=${last?.blockTime||last?.timestamp}`, null);
    }

    for (const item of readySignatures) {
      if (this.isStopped) return;
      this.metricsEngine.processTransaction(item.txData, this.mint);
      this.signatureManager.markProcessed(item.sig);
    }
    // 注意：printCalculationReport 和 _fireMetricsUpdate 已移至 _runHeliusInitTask
    // 在评分完成后调用，确保 4大参数按 filteredUsers 过滤，recentTrades 携带 score
  }

  /**
   * 在 gap 被补全后续算：从水位线继续处理连续的 hasData=true 未处理 sig
   * 调用时机：verifySignatures 或 fetchMissingTransactions 填充了缺失的 tx 后
   */
  async _tryProcessUnblocked() {
    if (this.isStopped) return;
    const readySigs = this.signatureManager.getReadySignaturesSequential();
    if (readySigs.length === 0) return;

    this._log(`续算: ${readySigs.length} 条 sig 解除阻塞，继续顺序计算...`);
    for (const item of readySigs) {
      if (this.isStopped) return;
      this.metricsEngine.processTransaction(item.txData, this.mint);
      this.signatureManager.markProcessed(item.sig);
    }
    this._fireMetricsUpdate();
  }

  // ─────────────────────────────────────────────────────────
  // 实时处理新 sig
  // ─────────────────────────────────────────────────────────

  async handleNewSignature(sig, source) {
    if (this.isStopped) return;

    this.signatureManager.addSignature(sig, source);

    if (!this.isInitialized) return;

    // 已处理过的 sig（GMGN/Helius 历史数据中已有）直接跳过，无需 pending 占位
    if (this.signatureManager.isProcessedSig(sig)) return;

    // 立即加入 sigFeed（pending 状态，hasData=false），触发 UI 即时显示占位条目
    this._addSigToFeed(sig, source);
    this._fireMetricsUpdate();

    if (!this.signatureManager.hasData(sig)) {
      const txs = await this.dataFetcher.fetchParsedTxs([sig], this.mint);
      if (this.isStopped) return;
      if (txs.length > 0) {
        this.signatureManager.markHasData(sig, txs[0]);
      } else {
        return;
      }
    }

    if (this.isStopped) return;

    const state = this.signatureManager.getState(sig);
    if (state?.hasData && !state.isProcessed) {
      this.metricsEngine.processTransaction(state.txData, this.mint);
      this.signatureManager.markProcessed(sig);
      this.cacheManager.updateSigStatus(sig, { isProcessed: true }).catch(() => {});

      // 增量日志：输出新交易详情 + 用户轮次 + 4大参数快照
      const feePayer = state.txData?.data?.transaction?.message?.accountKeys?.[0]?.pubkey
                    || state.txData?.transaction?.message?.accountKeys?.[0]?.pubkey;
      const lastTrade = this.metricsEngine.recentTrades[0];
      if (feePayer) {
        this.metricsEngine.printTradeUpdate(sig, feePayer, lastTrade?.action || '?', lastTrade?.solAmount || 0, lastTrade?.tokenAmount || 0, source);
      }

      this.metricsEngine.printMetrics();

      // sigFeed 条目升级为已处理状态
      this._updateSigFeed(sig);
      this._fireMetricsUpdate();

      const txAddr = state.txData?.transaction?.message?.accountKeys?.[0]?.pubkey;
      if (txAddr && this.metricsEngine.traderStats[txAddr]?.score === undefined) {
        this._scheduleQuickScore();
        this._scheduleSlowScore();
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // 动态 verify（替代固定30s间隔）
  // ─────────────────────────────────────────────────────────

  _scheduleNextVerify() {
    if (this.isStopped) return;
    const interval = this._verifyIntervalMs;
    this.verifyInterval = setTimeout(() => {
      if (!this.isStopped && this.isInitialized) {
        this.verifySignatures().finally(() => {
          if (!this.isStopped) this._scheduleNextVerify();
        });
      }
    }, interval);
  }

  async verifySignatures(overrideLimit = 0) {
    if (this.isStopped) return;
    const startTime = Date.now();

    try {
      // 动态拉取数量：默认50条，有遗漏时拉200条；首次 init 后传入 500 做大窗口桥接
      const fetchLimit = overrideLimit > 0 ? overrideLimit : (this._verifyMissCount > 0 ? 200 : 50);
      const latestSigs = await this.dataFetcher.fetchLatestSigsForVerify(this.mint, fetchLimit);
      if (this.isStopped) return;

      let newCount = 0;
      const newSigsToFetch = [];
      // 用于顺序验证：记录 GMGN sig 被 Helius slot 更新时的异常
      const orderIssues = [];
      let slotUpdatedCount = 0;

      latestSigs.forEach(rawSig => {
        const sig = rawSig.signature;
        if (!this.signatureManager.signatures.has(sig)) {
          // 新发现的 sig，用 Helius 元数据添加
          this.signatureManager.addSignature(rawSig, 'verify');
          newSigsToFetch.push(sig);
          newCount++;
        } else {
          // ── 顺序验证：读取旧状态，对比 Helius 补充的 slot ──
          const before = this.signatureManager.getState(sig);
          const oldSlot = before ? before.slot : -1;
          const oldTs   = before ? before.timestamp : 0;

          this.signatureManager.updateSigOrder(sig, rawSig.slot, rawSig.blockTime);

          // 仅对之前 slot=0（GMGN/WS来源）的 sig 做时序验证
          if (oldSlot === 0 && rawSig.slot > 0 && rawSig.blockTime > 0 && oldTs > 0) {
            slotUpdatedCount++;
            const heliusTs = rawSig.blockTime * 1000;
            const diffSec  = Math.abs(heliusTs - oldTs) / 1000;
            // 超过 5 分钟认为时序异常（GMGN 时间戳与链上时间差距太大）
            if (diffSec > 300) {
              orderIssues.push({
                sig: sig.slice(0, 8),
                gmgnTs: new Date(oldTs).toLocaleTimeString('zh-CN'),
                heliusTs: new Date(heliusTs).toLocaleTimeString('zh-CN'),
                diffSec: diffSec.toFixed(0)
              });
            }
          }

          // 同时更新 IndexedDB
          this.cacheManager.saveSig(this.mint, sig, {
            slot: rawSig.slot, blockTime: rawSig.blockTime, source: 'helius'
          }).catch(() => {});
        }
      });

      // 动态调整间隔
      if (newCount === 0) {
        this._verifyMissCount = 0;
        // 连续无遗漏 → 放宽间隔（最大120s）
        this._verifyIntervalMs = Math.min(this._verifyIntervalMs * 1.5, 120000);
      } else {
        this._verifyMissCount++;
        // 有遗漏 → 缩短间隔（最小10s）
        this._verifyIntervalMs = Math.max(10000, this._verifyIntervalMs / 2);
      }

      if (newCount > 0) {
        this._log(`Verify: 发现 ${newCount} 条新 sig，获取 tx 数据...`);
        const txs = await this.dataFetcher.fetchParsedTxs(newSigsToFetch, this.mint);
        if (this.isStopped) return;

        for (const tx of txs) {
          if (this.isStopped) return;
          const sig = tx.transaction.signatures[0];
          this.signatureManager.markHasData(sig, tx);
          this.metricsEngine.processTransaction({ type: 'helius', data: tx }, this.mint);
          this.signatureManager.markProcessed(sig);
          // 增量日志
          const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey;
          const lastTrade = this.metricsEngine.recentTrades[0];
          if (feePayer) {
            this.metricsEngine.printTradeUpdate(sig, feePayer, lastTrade?.action || '?', lastTrade?.solAmount || 0, lastTrade?.tokenAmount || 0, 'verify');
          }
        }

        this._log(`Verify: 处理完成 ${txs.length} 条新交易`);
        // 尝试续算：verify 可能补全了历史 gap 中的 sig，解锁后续连续段
        await this._tryProcessUnblocked();
        this._fireMetricsUpdate();
      }

      this.lastVerifyTime = Date.now();

      if (this.onStatsUpdate) {
        try { this.onStatsUpdate(this.signatureManager.getStats()); } catch (_e) { /* ignore */ }
      }

    } catch (error) {
      if (this.isStopped) return;
    }
  }

  // ─────────────────────────────────────────────────────────
  // 停止
  // ─────────────────────────────────────────────────────────

  stop() {
    this.isStopped = true;

    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      try { this.ws.close(); } catch (_e) { /* ignore */ }
      this.ws = null;
    }

    clearInterval(this.pingInterval);
    clearTimeout(this.reconnectTimeout);
    clearInterval(this.progressInterval);
    clearTimeout(this.verifyInterval);   // verifyInterval 现在是 setTimeout 返回值

    this.pingInterval = null;
    this.reconnectTimeout = null;
    this.progressInterval = null;
    this.verifyInterval = null;

    this.onGmgnDataLoaded = null;
    this.onMetricsUpdate = null;
    this.isInitialized = false;

    if (this.signatureManager) this.signatureManager.clear();

    // 停止时持久化当前 traderStats 到 IndexedDB（fire-and-forget，不阻塞停止流程）
    // 必须在 metricsEngine.reset() 之前捕获 stats
    const cm = this.cacheManager;
    const mint = this.mint;
    const stats = this.metricsEngine?.traderStats ? { ...this.metricsEngine.traderStats } : null;

    if (this.metricsEngine) this.metricsEngine.reset();
    this.sigFeed = [];

    const persistAndClose = async () => {
      try {
        if (cm && stats && !cm.disabled) {
          for (const [address, data] of Object.entries(stats)) {
            // score >= 0 才视为有效评分（-1 是初始哨兵值，不保存到 DB）
            if (data.score >= 0) {
              await cm.saveUser(address, mint, {
                score: data.score,
                status: data.status,
              });
            }
          }
        }
      } catch (_e) {}
      try { cm?.close(); } catch (_e) {}
    };
    persistAndClose();

  }

  // ─────────────────────────────────────────────────────────
  // Holder 数据更新 + 评分
  // ─────────────────────────────────────────────────────────

  async updateHolderData(holders) {
    try {
      this.metricsEngine.updateUsersInfo(holders);

      // 慢速评分统一由 _scheduleSlowScore() 调度（有 debounce，防重入）
      // 不在此直接调用 detectHiddenRelays()，避免与初始化/实时评分并行冲突
      this._scheduleSlowScore();

      const { scoreMap, whaleAddresses } = this.scoringEngine.calculateScores(
        this.metricsEngine.traderStats,
        this.metricsEngine.traderStats,
        this.bossConfig,
        this.manualScores,
        this.scoreThreshold
      );

      // 写入 traderStats
      for (const [address, scoreData] of scoreMap.entries()) {
        if (this.metricsEngine.traderStats[address]) {
          this.metricsEngine.traderStats[address].score = scoreData.score;
          this.metricsEngine.traderStats[address].score_reasons = scoreData.reasons;
          // ScoringEngine 已处理三态，直接写入
          this.metricsEngine.traderStats[address].status = scoreData.status;
        }
      }

      // 异步持久化用户评分到 IndexedDB
      this._persistUserScores(scoreMap).catch(() => {});

      // filteredUsers = score < threshold 的全部用户（含"普通"）→ 与快速评分一致
      const filteredUsers = this.filterUsersByScore(scoreMap);
      this.metricsEngine.updateWhaleAddresses(whaleAddresses);
      this.metricsEngine.setFilteredUsers(filteredUsers);
      this.recalculateMetrics();

    } catch (error) {
    }
  }

  /**
   * 将评分结果异步写入 IndexedDB users 表
   */
  async _persistUserScores(scoreMap) {
    for (const [address, scoreData] of scoreMap.entries()) {
      await this.cacheManager.saveUser(address, this.mint, {
        score: scoreData.score,
        status: scoreData.status,
        reasons: scoreData.reasons
      });
    }
  }

  filterUsersByScore(scoreMap) {
    const filtered = new Set();
    for (const address of Object.keys(this.metricsEngine.traderStats)) {
      const score = scoreMap.get(address)?.score ?? 0;
      if (score < this.scoreThreshold) filtered.add(address);
    }
    return filtered;
  }

  /**
   * 打印评分结果汇总：哪些用户在/不在 4大参数，各自的分数来源
   */
  _logScoringResult(phase, scoreMap, filteredUsers, whaleAddresses) {
    const stats = this.metricsEngine.traderStats;
    const allUsers = Object.keys(stats);

    // 分组
    const inMetrics  = [];  // 参与 4大参数（散户）
    const excluded   = [];  // 不参与（庄家 or 超阈值）
    const unscored   = [];  // 无评分

    for (const addr of allUsers) {
      const sd   = scoreMap.get(addr);
      const short = `${addr.slice(0, 6)}..${addr.slice(-4)}`;
      if (!sd) {
        unscored.push(short);
        continue;
      }
      const entry = {
        addr: short,
        score: sd.score,
        status: sd.status,
        reasons: (sd.reasons || []).join(', ') || '无',
        isWhale: whaleAddresses.has(addr)
      };
      if (filteredUsers.has(addr)) {
        inMetrics.push(entry);
      } else {
        excluded.push(entry);
      }
    }

    const fmt = (e) => `  ${e.addr} score=${e.score} status=${e.status}${e.isWhale ? ' [庄家地址]' : ''} | 原因: ${e.reasons}`;

    console.log(
      `[评分-${phase}] ✓ 完成 阈值=${this.scoreThreshold}\n` +
      `  参与4大参数(散户): ${inMetrics.length}人\n` +
      inMetrics.map(fmt).join('\n') +
      (inMetrics.length ? '\n' : '') +
      `  不参与4大参数(庄家/超阈值): ${excluded.length}人\n` +
      excluded.map(fmt).join('\n') +
      (excluded.length ? '\n' : '') +
      (unscored.length ? `  无评分(不参与): ${unscored.join(', ')}\n` : '')
    );
  }

  recalculateMetrics() {
    this._fireMetricsUpdate();
  }

  // ─────────────────────────────────────────────────────────
  // 手动标记（改用 IndexedDB，不再用 chrome.storage）
  // ─────────────────────────────────────────────────────────

  setManualScore(address, status) {
    if (status === '散户') {
      delete this.manualScores[address]; // 取消标记，清除条目
    } else {
      this.manualScores[address] = status;
    }
    // 持久化到 IndexedDB
    this.cacheManager.saveManualScores(this.mint, { [address]: status })
      .catch(() => {});

    // 立即重算所有评分，确保 traderStats.status 在 sendDataToSidepanel 前已更新
    if (Object.keys(this.metricsEngine.traderStats).length > 0) {
      const { scoreMap, whaleAddresses } = this.scoringEngine.calculateScores(
        this.metricsEngine.traderStats,
        this.metricsEngine.traderStats,
        this.bossConfig,
        this.manualScores,
        this.scoreThreshold
      );
      for (const [addr, scoreData] of scoreMap.entries()) {
        if (this.metricsEngine.traderStats[addr]) {
          this.metricsEngine.traderStats[addr].score = scoreData.score;
          this.metricsEngine.traderStats[addr].status = scoreData.status;
          this.metricsEngine.traderStats[addr].score_reasons = scoreData.reasons;
        }
      }
      const filteredUsers = this.filterUsersByScore(scoreMap);
      this.metricsEngine.updateWhaleAddresses(whaleAddresses);
      this.metricsEngine.setFilteredUsers(filteredUsers);
    }
  }

  setManualScores(manualScores) {
    this.manualScores = { ...manualScores };
  }

  // ─────────────────────────────────────────────────────────
  // 快速评分（新 trade 用户或 WS 新交易触发，500ms debounce）
  // 同步 BossLogic，<1ms，立即给新用户初步 score/status → 进入 filteredUsers
  // ─────────────────────────────────────────────────────────

  _scheduleQuickScore() {
    clearTimeout(this._quickScoreTimer);
    this._quickScoreTimer = setTimeout(() => {
      if (this.isStopped) return;
      const allUsers = Object.keys(this.metricsEngine.traderStats);
      const unscoredBefore = allUsers.filter(a => this.metricsEngine.traderStats[a]?.score === undefined);
      console.log(`[评分-快速] ▶ 开始 总用户=${allUsers.length} 未评分=${unscoredBefore.length}`);

      const { scoreMap, whaleAddresses } = this.scoringEngine.calculateScores(
        this.metricsEngine.traderStats,
        this.metricsEngine.traderStats,
        this.bossConfig,
        this.manualScores,
        this.scoreThreshold
      );
      for (const [address, scoreData] of scoreMap.entries()) {
        if (this.metricsEngine.traderStats[address]) {
          this.metricsEngine.traderStats[address].score = scoreData.score;
          this.metricsEngine.traderStats[address].score_reasons = scoreData.reasons;
          // ScoringEngine 已处理三态，直接写入
          this.metricsEngine.traderStats[address].status = scoreData.status;
        }
      }
      // filteredUsers = score < threshold 的全部用户（含"普通"）→ 列表立刻显示
      const filteredUsers = this.filterUsersByScore(scoreMap);
      this.metricsEngine.updateWhaleAddresses(whaleAddresses);
      this.metricsEngine.setFilteredUsers(filteredUsers);
      this._logScoringResult('快速', scoreMap, filteredUsers, whaleAddresses);
      this.recalculateMetrics();
    }, 500);
  }

  // ─────────────────────────────────────────────────────────
  // 慢速评分（detectHiddenRelays + 重新打分，3s debounce，异步非阻塞）
  // 仅在 enable_hidden_relay=true 时运行
  // 完成后更新 filteredUsers → 4大参数重算 → 实时列表 label 刷新
  // ─────────────────────────────────────────────────────────

  _scheduleSlowScore() {
    if (!this.bossConfig.enable_hidden_relay) return;
    console.log('[评分-慢速] ▶ _scheduleSlowScore 已触发（500ms 后运行）');
    clearTimeout(this._slowScoreTimer);
    this._slowScoreTimer = setTimeout(async () => {
      if (this.isStopped) return;
      // 已在检测中：不重置已确认状态，直接跳过（防止 label 闪烁回"普通"）
      if (this._relayDetecting) return;
      console.log(`[评分-慢速] ▶ 开始 detectHiddenRelays...`);
      // 运行 detectHiddenRelays（只处理尚未检测过的用户，已检测过的自动跳过）
      await this.detectHiddenRelays();
      if (this.isStopped) return;
      if (Object.keys(this.metricsEngine.traderStats).length === 0) return;
      console.log(`[评分-慢速] detectHiddenRelays 完成，重新全量打分...`);
      // 慢速检测完成后，重新全量打分（含 has_hidden_relay 结果）
      const { scoreMap, whaleAddresses } = this.scoringEngine.calculateScores(
        this.metricsEngine.traderStats,
        this.metricsEngine.traderStats,
        this.bossConfig,
        this.manualScores,
        this.scoreThreshold
      );
      for (const [address, scoreData] of scoreMap.entries()) {
        if (this.metricsEngine.traderStats[address]) {
          this.metricsEngine.traderStats[address].score = scoreData.score;
          this.metricsEngine.traderStats[address].score_reasons = scoreData.reasons;
          // 全部检测完成：仍是"普通"的用户升级为最终状态（非庄家→散户）
          if (this.metricsEngine.traderStats[address].status === '普通') {
            this.metricsEngine.traderStats[address].status = scoreData.isWhale ? '庄家' : '散户';
          }
        }
      }
      // filteredUsers = score < threshold 的全部用户（含散户 + 仍是普通的用户）
      const filteredUsers = this.filterUsersByScore(scoreMap);
      this.metricsEngine.updateWhaleAddresses(whaleAddresses);
      this.metricsEngine.setFilteredUsers(filteredUsers);
      this._logScoringResult('慢速', scoreMap, filteredUsers, whaleAddresses);
      // 触发 UI 更新：4大参数重算 + 实时列表 label 刷新
      this.recalculateMetrics();
      // [调试] 慢速评分结束，打印全部 traderStats
      console.log('[慢速评分-完成] traderStats 完整快照:',
        Object.entries(this.metricsEngine.traderStats).map(([addr, info]) => ({
          addr: `${addr.slice(0, 6)}..${addr.slice(-4)}`,
          score: info.score,
          status: info.status,
          has_hidden_relay: info.has_hidden_relay,
          funding_account: info.funding_account,
          has_holder_snapshot: info.has_holder_snapshot,
          manualScore: info.manualScore,
        }))
      );
    }, 500); // 500ms 防抖，与 quickScore 对齐，更快触发慢速检测
  }

  // ─────────────────────────────────────────────────────────
  // 隐藏中转检测（改用 IndexedDB）
  // ─────────────────────────────────────────────────────────

  isHiddenRelayTx(tx) {
    const instructions = tx?.transaction?.message?.instructions;
    if (!instructions || !Array.isArray(instructions)) return { isRelay: false, conditions: [] };

    const conditions = [];
    let hasCreate = false, hasClose = false;

    for (const ix of instructions) {
      const prog = ix.program || '';
      const pType = ix.parsed?.type || '';
      if (prog === 'spl-associated-token-account') { hasCreate = true; conditions.push('Create'); }
      if (prog === 'spl-token' && pType === 'closeAccount') { hasClose = true; conditions.push('CloseAccount'); }
      if (prog === 'system' && pType === 'transfer') conditions.push('Transfer');
      if (prog === 'spl-token' && pType === 'syncNative') conditions.push('SyncNative');
    }

    return { isRelay: hasCreate && hasClose, conditions };
  }

  async detectHiddenRelays() {
    if (this._relayDetecting) return;
    this._relayDetecting = true;

    try {
      const userInfo = this.metricsEngine.traderStats;
      const allUsers = Object.keys(userInfo);
      if (allUsers.length === 0) return;

      const sendLog = (msg) => {
        try { chrome.runtime.sendMessage({ type: 'LOG', message: msg }).catch(() => {}); } catch (_e) { /* ignore */ }
      };

      // 单次批量读取 users 表（含评分、中转检测结果等全部字段）
      const existingUsers = await this.cacheManager.loadUsersData(allUsers);

      // 跳过条件：
      //  0. 已确认为"庄家" → 无需中转检测
      //  1. 无资金来源（funding_account 为空）→ rule 9 条件1已直接成立，无需慢速检测
      //  2. 已有隐藏中转检测结果（hiddenRelayCheckedAt 存在）
      //  3. 已有评分记录（上次已完整处理过，不再做慢速 sig 翻页）
      const unchecked = allUsers.filter(u => {
        // ⓪ 已确认庄家，跳过（只处理"普通"用户）
        if (userInfo[u]?.status === '庄家') return false;

        // ① 有 holder 快照且确认无资金来源 → 条件1(无资金来源)已覆盖，跳过链上检测
        //    注意：trade-only 用户的 has_holder_snapshot 未设置，funding_account=undefined
        //          不代表确认无来源，应该进入检测
        if (userInfo[u]?.has_holder_snapshot === true && !userInfo[u]?.funding_account) return false;

        const ud = existingUsers[u];

        // ② 已在 IndexedDB 检测过，且 traderStats 里的 has_hidden_relay 没有被重置
        //    重置场景：updateUserInfo 检测到 trade-only 用户首次获得 holder 快照，
        //    会把 has_hidden_relay 设为 undefined，要求重新用新数据评估
        if (ud?.hiddenRelayCheckedAt && userInfo[u]?.has_hidden_relay !== undefined) return false;

        if (ud?.score !== undefined && ud.score >= 0) return false;  // 已有有效评分（≥0）→ 跳过；-1 为初始值，仍需检测
        return true;
      });

      // 恢复已缓存状态到 userInfo
      for (const u of allUsers) {
        const ud = existingUsers[u];
        if (ud?.hiddenRelayCheckedAt) {
          // 有中转检测结果 → 直接恢复
          userInfo[u].has_hidden_relay = ud.hiddenRelay;
          userInfo[u].hidden_relay_conditions = ud.hiddenRelayConditions || [];
        }
        // 有评分但无中转检测：has_hidden_relay 保持默认 false，评分体系已覆盖
      }

      if (unchecked.length === 0) {
        return;
      }

      const total = unchecked.length;
      sendLog(`[中转检测] 开始: ${total}个待查 / ${allUsers.length - total}个缓存`);

      const BATCH_SIZE = 2;
      let relayCount = 0;
      let doneCount = 0;

      for (let i = 0; i < unchecked.length; i += BATCH_SIZE) {
        if (this.isStopped) return; // 停止检查：外层批次
        const batch = unchecked.slice(i, i + BATCH_SIZE);

        for (const address of batch) {
          if (this.isStopped) return; // 停止检查：单用户
          doneCount++;
          const shortAddr = `${address.slice(0, 6)}..${address.slice(-4)}`;
          try {
            sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} 翻页中...`);
            let before = undefined;
            let lastBatch = [];
            let pageCount = 0;
            const MAX_PAGES = this.bossConfig?.hidden_relay_max_pages || 10;

            for (let page = 0; page < MAX_PAGES; page++) {
              if (this.isStopped) return; // 停止检查：翻页中
              const sigs = await this.dataFetcher.call('getSignaturesForAddress',
                [address, { limit: 1000, ...(before ? { before } : {}) }]
              );
              if (!Array.isArray(sigs) || sigs.length === 0) break;
              lastBatch = sigs;
              pageCount++;
              if (sigs.length < 1000) break;
              before = sigs[sigs.length - 1].signature;
              await new Promise(r => setTimeout(r, 500));
            }

            if (lastBatch.length === 0) {
              await this.cacheManager.saveHiddenRelayResult(address, this.mint, { isRelay: false, conditions: [] });
              userInfo[address].has_hidden_relay = false;
              userInfo[address].hidden_relay_conditions = [];
              continue;
            }

            const totalSigs = (pageCount - 1) * 1000 + lastBatch.length;
            const oldestSig = lastBatch[lastBatch.length - 1].signature;
            sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} 共${totalSigs}条sig，检测第1笔...`);
            // [调试] 输出最旧的 sig，方便复查
            console.log(`[中转检测-sig] ${shortAddr} 最旧sig: ${oldestSig}`);

            const tx = await this.dataFetcher.call('getTransaction', [
              oldestSig,
              { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
            ]);

            // [调试] 输出 tx 关键信息，方便复查
            if (tx) {
              const ixList = tx.transaction?.message?.instructions || [];
              const slot = tx.slot || '?';
              const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : '?';
              const ixSummary = ixList.map(ix => `${ix.program || '?'}/${ix.parsed?.type || 'raw'}`).join(', ');
              console.log(`[中转检测-tx] ${shortAddr} slot=${slot} 时间=${blockTime} 指令=[${ixSummary}]`);
            } else {
              console.log(`[中转检测-tx] ${shortAddr} tx获取失败(null)`);
            }

            let isRelay = false, conditions = [];
            if (tx) {
              const result = this.isHiddenRelayTx(tx);
              isRelay = result.isRelay;
              conditions = result.conditions;
            }

            userInfo[address].has_hidden_relay = isRelay;
            userInfo[address].hidden_relay_conditions = conditions;

            // 写入 IndexedDB（替代 chrome.storage.set）
            await this.cacheManager.saveHiddenRelayResult(address, this.mint, { isRelay, conditions });

            if (isRelay) {
              relayCount++;
              sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} ⚠ 中转[${conditions.join('+')}]`);
            } else {
              sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} - 普通`);
            }

          } catch (err) {
            userInfo[address].has_hidden_relay = false;
            userInfo[address].hidden_relay_conditions = [];
          }
          // 每个用户确认后立即重打分 + 更新 filteredUsers（仅已确认散户）+ 重算4大参数
          {
            const { scoreMap: fm, whaleAddresses: fw } = this.scoringEngine.calculateScores(
              this.metricsEngine.traderStats,
              this.metricsEngine.traderStats,
              this.bossConfig,
              this.manualScores,
              this.scoreThreshold
            );
            // 只更新已完成处理的 unchecked 用户的 status
            // 跳过的用户（不在 unchecked，如快速确认的庄家）保持原 status 不覆盖
            const processedSet = new Set(unchecked.slice(0, doneCount));
            for (const [addr, sd] of fm.entries()) {
              if (this.metricsEngine.traderStats[addr]) {
                this.metricsEngine.traderStats[addr].score = sd.score;
                this.metricsEngine.traderStats[addr].score_reasons = sd.reasons;
                if (processedSet.has(addr)) {
                  // relay 检测已完成：非庄家确认为'散户'（不再是待确认的'普通'）
                  this.metricsEngine.traderStats[addr].status = sd.isWhale ? '庄家' : '散户';
                }
              }
            }
            // 把仍在等待检测的用户重标为"普通"
            for (const pendingAddr of unchecked.slice(doneCount)) {
              if (!this.metricsEngine.traderStats[pendingAddr]?.manualScore) {
                this.metricsEngine.traderStats[pendingAddr].status = '普通';
              }
            }
            // filteredUsers = score < threshold 的全部用户（散户 + 仍待确认的普通用户）
            // "普通"用户保留在列表，label 仍显示"普通"，确认后升级为"散户"
            const confirmedFiltered = this.filterUsersByScore(fm);
            this.metricsEngine.updateWhaleAddresses(fw);
            this.metricsEngine.setFilteredUsers(confirmedFiltered);
            this.recalculateMetrics();
            // [调试] 每个用户确认后打印当前 traderStats 状态
            const shortAddr = `${address.slice(0, 6)}..${address.slice(-4)}`;
            console.log(`[中转检测-进度] (${doneCount}/${total}) ${shortAddr} 确认完成，当前快照:`,
              Object.entries(this.metricsEngine.traderStats).map(([addr, info]) => ({
                addr: `${addr.slice(0, 6)}..${addr.slice(-4)}`,
                score: info.score, status: info.status,
              }))
            );
          }
          await new Promise(r => setTimeout(r, 500));
        }
        if (i + BATCH_SIZE < unchecked.length) await new Promise(r => setTimeout(r, 800));
      }

      sendLog(`[中转检测] 完成: ${relayCount}个中转 / ${total - relayCount}个普通`);

    } finally {
      this._relayDetecting = false;
    }
  }

  // ─────────────────────────────────────────────────────────
  // 配置设置
  // ─────────────────────────────────────────────────────────

  setApiKey(key) {
    this.apiKey = key || '';
    this.dataFetcher.setApiKey(this.apiKey);
  }

  setHeliusApiEnabled(enabled) {
    this.heliusApiEnabled = enabled;
    if (!enabled && this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (enabled && !this.ws && this.isInitialized) {
      this.connectWs();
    }
  }

  setScoreThreshold(threshold) {
    this.scoreThreshold = threshold;
    const traderStats = this.metricsEngine.traderStats;
    if (Object.keys(traderStats).length > 0) {
      const filteredUsers = new Set();
      for (const [address, user] of Object.entries(traderStats)) {
        if ((user.score || 0) < threshold) filteredUsers.add(address);
      }
      this.metricsEngine.setFilteredUsers(filteredUsers);
    }
    this.recalculateMetrics();
  }

  // statusThreshold 已废弃，保留空方法避免外部调用报错
  setStatusThreshold(_threshold) {}

  setBossConfig(config) {
    this.bossConfig = config;
  }

  updateWhaleAddresses(whaleAddresses) {
    if (this.metricsEngine) this.metricsEngine.updateWhaleAddresses(whaleAddresses);
  }

  // ─────────────────────────────────────────────────────────
  // 状态查询
  // ─────────────────────────────────────────────────────────

  getMetrics() {
    return this.metricsEngine.getMetrics();
  }

  getStats() {
    const stats = this.signatureManager.getStats();
    stats.heliusFetchedTotal = this.heliusFetchedTotal;
    return stats;
  }

  notifyWsStatusChange() {
    if (this.onWsStatusChange) this.onWsStatusChange(this.getWsStatus());
  }

  getWsStatus() {
    return {
      ...this.wsStatus,
      uptime: this.wsStatus.connected && this.wsStatus.lastConnectTime
        ? Date.now() - this.wsStatus.lastConnectTime
        : 0
    };
  }

  getVerifyStatus() {
    return {
      enabled: !!this.verifyInterval,
      lastVerifyTime: this.lastVerifyTime,
      intervalMs: this._verifyIntervalMs,
      timeSinceLastVerify: this.lastVerifyTime ? Date.now() - this.lastVerifyTime : null
    };
  }
}
