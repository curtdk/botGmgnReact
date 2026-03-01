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
    this.isWaitingForGmgn = true;
    this.heliusApiEnabled = true;
    this.heliusFetchedTotal = 0;
    this.gmgnDataLoadedResolve = null;
    this.gmgnDataLoadedReject = null;

    // 评分配置
    this.scoreThreshold = 100;
    this.statusThreshold = 50;
    this.manualScores = {};
    this.bossConfig = {};

    // 回调
    this.onMetricsUpdate = null;
    this.onGmgnDataLoaded = null;

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
  }

  // ─────────────────────────────────────────────────────────
  // 启动
  // ─────────────────────────────────────────────────────────

  async start() {

    try {
      // 1. 初始化缓存
      await this.cacheManager.init();
      if (this.isStopped) throw new Error('Stopped');

      // 2. 从 IndexedDB 加载手动标记（替代 chrome.storage）
      this.manualScores = await this.cacheManager.loadManualScores(this.mint);

      // 3. 连接 WebSocket
      this.connectWs();
      if (this.isStopped) throw new Error('Stopped');

      // 4. ── 并行：Helius sig 获取 + 等待 GMGN 数据 ──
      await this._parallelFetchAndWait();
      if (this.isStopped) throw new Error('Stopped');

      // 5. 补全缺失 tx 详情
      await this.fetchMissingTransactions();
      if (this.isStopped) throw new Error('Stopped');

      // 6. 首次计算
      await this.performInitialCalculation();
      if (this.isStopped) throw new Error('Stopped');

      // 7. 进入实时模式
      this.isInitialized = true;

      // 8. 启动动态 verify
      this._scheduleNextVerify();

    } catch (error) {
      if (!this.isStopped) throw error;
    }
  }

  // ─────────────────────────────────────────────────────────
  // 并行：Helius sig 流式获取 + 等待 GMGN
  // ─────────────────────────────────────────────────────────

  async _parallelFetchAndWait() {

    // GMGN 等待 Promise
    this.signatureManager.startWaitPeriod();
    this.isWaitingForGmgn = true;

    const gmgnPromise = new Promise((resolve, reject) => {
      this.gmgnDataLoadedResolve = resolve;
      this.gmgnDataLoadedReject = reject;
    });

    // 60s 超时保护
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('timeout'), 60000));

    // 进度日志
    const startTime = Date.now();
    this.progressInterval = setInterval(() => {
      if (this.isStopped) { clearInterval(this.progressInterval); return; }
      const stats = this.signatureManager.getStats();
    }, 5000);

    this.onGmgnDataLoaded = () => {
      if (this.isStopped) return;
      if (this.gmgnDataLoadedResolve) this.gmgnDataLoadedResolve();
    };

    // Helius sig 流式获取（并行启动，不阻塞 GMGN 等待）
    const heliusFetchPromise = this.heliusApiEnabled
      ? this._fetchSigsStreaming()
      : Promise.resolve({ totalNew: 0, totalCached: 0 });

    // 等待 GMGN 或超时
    await Promise.race([gmgnPromise, timeoutPromise]);
    clearInterval(this.progressInterval);


    // 等待 Helius 流式获取完成（通常此时早已完成）
    const fetchResult = await heliusFetchPromise;
    this.heliusFetchedTotal = fetchResult.totalNew + fetchResult.totalCached;

    this.signatureManager.endWaitPeriod();
    this.isWaitingForGmgn = false;

    const stats = this.signatureManager.getStats();
    dataFlowLogger.log('Helius-API', 'Sig 列表', `总计 ${stats.total} (新增=${fetchResult.totalNew} 缓存=${fetchResult.totalCached}) | mint: ${this.mint.slice(0, 8)}...`,
      { total: stats.total, newSigs: fetchResult.totalNew, cached: fetchResult.totalCached, mint: this.mint }
    );
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
        // 第一页到来，立即通知 UI sig 总数
        if (this.onStatsUpdate) {
          try { this.onStatsUpdate(this.signatureManager.getStats()); } catch (e) { /* ignore */ }
        }
      }

      if (isLast) {
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
          const sig = msg.params.result.value.signature;
          dataFlowLogger.log('Helius-WS', '新 Sig', `${sig.slice(0, 8)}... | mint: ${this.mint.slice(0, 8)}...`, { sig, mint: this.mint });
          this.handleNewSignature(sig, 'websocket');
        }
      } catch (err) {
      }
    };

    this.ws.onclose = () => {
      if (this.isStopped) return;
      clearInterval(this.pingInterval);
      this.wsStatus = { ...this.wsStatus, connected: false, lastDisconnectTime: Date.now(), reconnectCount: this.wsStatus.reconnectCount + 1 };
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
    const cachedTxs = await this.cacheManager.loadTransactionsBySignatures(missingSigs);
    if (this.isStopped) return;

    cachedTxs.forEach(tx => {
      const sig = tx.transaction.signatures[0];
      this.signatureManager.markHasData(sig, tx);
    });

    // 从 API 获取仍缺失的
    const stillMissing = this.signatureManager.getMissingSignatures();
    if (stillMissing.length === 0) return;

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
    }

    dataFlowLogger.log('Helius-API', 'Tx 补全', `缓存=${cachedTxs.length} API=${fetchedCount} 共需=${missingSigs.length} | mint: ${this.mint.slice(0, 8)}...`,
      { cached: cachedTxs.length, fetched: fetchedCount, total: missingSigs.length }
    );
  }

  // ─────────────────────────────────────────────────────────
  // 首次计算
  // ─────────────────────────────────────────────────────────

  async performInitialCalculation() {
    if (this.isStopped) return;

    const readySignatures = this.signatureManager.getReadySignatures();
    if (readySignatures.length === 0) {
      return;
    }


    this.metricsEngine.setTotalTransactions(readySignatures.length);

    for (const item of readySignatures) {
      if (this.isStopped) return;
      this.metricsEngine.processTransaction(item.txData, this.mint);
      this.signatureManager.markProcessed(item.sig);
    }

    this.metricsEngine.printMetrics();
    this.metricsEngine.printDetailedMetrics();

    if (this.onMetricsUpdate && !this.isStopped) {
      this.onMetricsUpdate(this.metricsEngine.getMetrics());
    }
  }

  // ─────────────────────────────────────────────────────────
  // 实时处理新 sig
  // ─────────────────────────────────────────────────────────

  async handleNewSignature(sig, source) {
    if (this.isStopped) return;

    this.signatureManager.addSignature(sig, source);

    if (this.isWaitingForGmgn || !this.isInitialized) return;
    if (this.signatureManager.isProcessedSig(sig)) return;

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
      // 同步更新 IndexedDB sig 状态
      this.cacheManager.updateSigStatus(sig, { isProcessed: true }).catch(() => {});

      this.metricsEngine.printMetrics();

      if (this.onMetricsUpdate && !this.isStopped) {
        this.onMetricsUpdate(this.metricsEngine.getMetrics());
      }

      // 检查是否需要快速评分
      const txAddr = state.txData?.transaction?.message?.accountKeys?.[0]?.pubkey;
      if (txAddr && this.metricsEngine.traderStats[txAddr]?.score === undefined) {
        this._scheduleQuickScore();
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

  async verifySignatures() {
    if (this.isStopped) return;
    const startTime = Date.now();

    try {
      // 动态拉取数量：默认50条，有遗漏时拉200条
      const fetchLimit = this._verifyMissCount > 0 ? 200 : 50;
      const latestSigs = await this.dataFetcher.fetchLatestSigsForVerify(this.mint, fetchLimit);
      if (this.isStopped) return;

      let newCount = 0;
      const newSigsToFetch = [];

      latestSigs.forEach(rawSig => {
        const sig = rawSig.signature;
        if (!this.signatureManager.signatures.has(sig)) {
          // 新发现的 sig，用 Helius 元数据添加
          this.signatureManager.addSignature(rawSig, 'verify');
          newSigsToFetch.push(sig);
          newCount++;
        } else {
          // 已有的 sig，补充/更新 slot 信息（用于顺序验证）
          this.signatureManager.updateSigOrder(sig, rawSig.slot, rawSig.blockTime);
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
        const txs = await this.dataFetcher.fetchParsedTxs(newSigsToFetch, this.mint);
        if (this.isStopped) return;

        for (const tx of txs) {
          if (this.isStopped) return;
          const sig = tx.transaction.signatures[0];
          this.signatureManager.markHasData(sig, tx);
          this.metricsEngine.processTransaction({ type: 'helius', data: tx }, this.mint);
          this.signatureManager.markProcessed(sig);
        }


        if (this.onMetricsUpdate && !this.isStopped) {
          this.onMetricsUpdate(this.metricsEngine.getMetrics());
        }
      } else {
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

    if (this.gmgnDataLoadedReject) {
      this.gmgnDataLoadedReject(new Error('Monitor stopped'));
      this.gmgnDataLoadedResolve = null;
      this.gmgnDataLoadedReject = null;
    }

    this.onGmgnDataLoaded = null;
    this.onMetricsUpdate = null;
    this.isInitialized = false;
    this.isWaitingForGmgn = false;

    if (this.signatureManager) this.signatureManager.clear();
    if (this.metricsEngine) this.metricsEngine.reset();
    if (this.cacheManager) {
      try { this.cacheManager.close(); } catch (_e) { /* ignore */ }
    }

  }

  // ─────────────────────────────────────────────────────────
  // Holder 数据更新 + 评分
  // ─────────────────────────────────────────────────────────

  async updateHolderData(holders) {
    try {
      this.metricsEngine.updateUsersInfo(holders);

      if (this.bossConfig.enable_hidden_relay) {
        await this.detectHiddenRelays();
      }

      const { scoreMap, whaleAddresses } = this.scoringEngine.calculateScores(
        this.metricsEngine.traderStats,
        this.metricsEngine.traderStats,
        this.bossConfig,
        this.manualScores,
        this.statusThreshold
      );

      // 写入 traderStats
      for (const [address, scoreData] of scoreMap.entries()) {
        if (this.metricsEngine.traderStats[address]) {
          this.metricsEngine.traderStats[address].score = scoreData.score;
          this.metricsEngine.traderStats[address].score_reasons = scoreData.reasons;
          this.metricsEngine.traderStats[address].status = scoreData.status;
        }
      }

      // 异步持久化用户评分到 IndexedDB
      this._persistUserScores(scoreMap).catch(() => {});

      const filteredUsers = this.filterUsersByScore(scoreMap);
      this.metricsEngine.updateWhaleAddresses(whaleAddresses);
      this.metricsEngine.setFilteredUsers(filteredUsers);
      this.recalculateMetrics();

      dataFlowLogger.log('HeliusMonitor', '评分完成',
        `${holders.length} holders → 庄家:${whaleAddresses.size} 过滤后:${filteredUsers.size}`,
        { holderCount: holders.length, whaleCount: whaleAddresses.size, filteredCount: filteredUsers.size }
      );
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

  recalculateMetrics() {
    const metrics = this.metricsEngine.getMetrics();
    if (this.onMetricsUpdate) this.onMetricsUpdate(metrics);
  }

  // ─────────────────────────────────────────────────────────
  // 手动标记（改用 IndexedDB，不再用 chrome.storage）
  // ─────────────────────────────────────────────────────────

  setManualScore(address, status) {
    this.manualScores[address] = status;
    // 持久化到 IndexedDB
    this.cacheManager.saveManualScores(this.mint, { [address]: status })
      .catch(() => {});
  }

  setManualScores(manualScores) {
    this.manualScores = { ...manualScores };
  }

  // ─────────────────────────────────────────────────────────
  // 快速评分（WS新交易触发，500ms debounce）
  // ─────────────────────────────────────────────────────────

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

      // 从 IndexedDB 批量加载已检测过的缓存（替代 chrome.storage 批量 get）
      const cached = await this.cacheManager.loadHiddenRelayResults(allUsers);

      const unchecked = allUsers.filter(u => !cached[u]);

      // 恢复已缓存的结果到 userInfo
      for (const u of allUsers) {
        if (cached[u]) {
          userInfo[u].has_hidden_relay = cached[u].isRelay;
          userInfo[u].hidden_relay_conditions = cached[u].conditions;
        }
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
        const batch = unchecked.slice(i, i + BATCH_SIZE);

        for (const address of batch) {
          doneCount++;
          const shortAddr = `${address.slice(0, 6)}..${address.slice(-4)}`;
          try {
            sendLog(`[中转检测] (${doneCount}/${total}) ${shortAddr} 翻页中...`);
            let before = undefined;
            let lastBatch = [];
            let pageCount = 0;
            const MAX_PAGES = this.bossConfig?.hidden_relay_max_pages || 10;

            for (let page = 0; page < MAX_PAGES; page++) {
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

            const tx = await this.dataFetcher.call('getTransaction', [
              oldestSig,
              { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
            ]);

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

  setStatusThreshold(threshold) {
    this.statusThreshold = threshold;
  }

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
