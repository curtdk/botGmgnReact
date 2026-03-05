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
  // sigFeed 实时流 helpers
  // ─────────────────────────────────────────────────────────

  /** 新 sig 到达时立即加入 feed（pending 状态） */
  _addSigToFeed(sig, source) {
    if (this.sigFeed.some(e => e.sig === sig)) return;
    this.sigFeed.unshift({ sig, source, hasData: false, action: null, address: null, solAmount: null, tokenAmount: null, rawTimestamp: Date.now(), label: null });
    if (this.sigFeed.length > 150) this.sigFeed.length = 150;
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

     // ── [调试] 仅 GMGN 模式：注释下面这行恢复完整模式 ──
    this.heliusApiEnabled = false;   // ← 加这一行

    this._log(`启动中... mint=${this.mint.slice(0, 8)}...`);
    dataFlowLogger.log('启动', 'Step 0: 开始', `mint=${this.mint.slice(0, 8)}...`);

    try {
      // 1. 初始化缓存
      this._log('初始化 IndexedDB...');
      dataFlowLogger.log('启动', 'Step 1: IndexedDB 初始化', '正在连接本地缓存...');
      try {
        await this.cacheManager.init();
        if (this.isStopped) throw new Error('Stopped');
        this._log('IndexedDB 就绪');
        dataFlowLogger.log('启动', 'Step 1 ✓ IndexedDB 就绪', '本地缓存连接成功');
      } catch (initErr) {
        if (this.cacheManager.disabled) {
          // 超时或 blocked：以无缓存模式继续，不中断启动
          const reason = initErr?.message === 'IndexedDB_BLOCKED' ? 'BLOCKED（另一标签页占用）' : '超时（6s）';
          this._log(`⚠ IndexedDB ${reason}，无缓存模式`);
          dataFlowLogger.log('启动', `Step 1 ⚠ IndexedDB ${reason}`, '跳过本地缓存，数据将从网络实时拉取（本次不持久化）');
        } else {
          throw initErr; // 其他错误（如权限问题）仍向上抛
        }
      }
      if (this.isStopped) throw new Error('Stopped');

      // 2. 从 IndexedDB 加载手动标记（替代 chrome.storage）
      this.manualScores = await this.cacheManager.loadManualScores(this.mint);
      dataFlowLogger.log('启动', 'Step 2 ✓ 手动标记加载', `已加载 ${Object.keys(this.manualScores).length} 条手动标记`);

      // 3. 连接 WebSocket
      this._log('WebSocket 连接中...');
      dataFlowLogger.log('启动', 'Step 3: WebSocket 连接', '正在发起 WS 连接...');
      this.connectWs();
      if (this.isStopped) throw new Error('Stopped');

      // 4. ── 并行：Helius sig 获取 + 等待 GMGN 数据 ──
      this._log('并行获取 Helius 历史 + 等待 GMGN 数据...');
      dataFlowLogger.log('启动', 'Step 4: 并行拉取', 'Helius 历史 sig + 等待 GMGN 数据（并行）...');
      await this._parallelFetchAndWait();
      if (this.isStopped) throw new Error('Stopped');
      const sigStats = this.signatureManager.getStats();
      dataFlowLogger.log('启动', 'Step 4 ✓ 拉取完成', `sig 总数=${sigStats.total} 缺口=${sigStats.missing}`);

      // 5. GMGN 数据已到：先发送一次 GMGN 交易（不等 Helius tx 补全）
      await this._earlyPublishGmgnTrades();
      if (this.isStopped) throw new Error('Stopped');

      // 6. 补全缺失 tx 详情
      const missingSigs = this.signatureManager.getMissingSignatures();
      if (missingSigs.length > 0) {
        this._log(`补全缺失交易: ${missingSigs.length} 条，请稍候...`);
        dataFlowLogger.log('启动', 'Step 6: 补全 tx 数据', `${missingSigs.length} 条 sig 缺少 tx 详情，正在拉取...`);
      }
      await this.fetchMissingTransactions();
      if (this.isStopped) throw new Error('Stopped');
      dataFlowLogger.log('启动', 'Step 6 ✓ tx 补全完成', `缺口剩余=${this.signatureManager.getMissingSignatures().length}`);

      // 7. 首次计算（处理 Helius 补全后的剩余 sig）
      dataFlowLogger.log('启动', 'Step 7: 历史顺序计算', '开始按时序处理所有历史 sig...');
      await this.performInitialCalculation();
      if (this.isStopped) throw new Error('Stopped');
      dataFlowLogger.log('启动', 'Step 7 ✓ 历史计算完成', `已处理=${this.metricsEngine.processedCount} 条`);

      // 7.5 补全初始化期间 WS 推入但 hasData=false 的 sig（init 窗口桥接）
      //     场景：步骤7运行期间 WS 推来新 sig，handleNewSignature 因 !isInitialized 直接 return，
      //     sig 留在 SignatureManager(hasData=false)，若不在此处补全则永久丢失。
      const wsGapSigs = this.signatureManager.getMissingSignatures();
      if (wsGapSigs.length > 0) {
        this._log(`桥接 init 窗口: 补全 ${wsGapSigs.length} 条 WS 期间遗漏 sig...`);
        dataFlowLogger.log('启动', 'Step 7.5: 桥接 WS 窗口', `init 期间 WS 推入 ${wsGapSigs.length} 条未处理 sig，补全中...`);
        await this.fetchMissingTransactions();
        if (this.isStopped) throw new Error('Stopped');
        // 处理刚补全的 sig（顺序计算，保持与 performInitialCalculation 一致）
        const bridgeSigs = this.signatureManager.getReadySignaturesSequential();
        if (bridgeSigs.length > 0) {
          this._log(`桥接 init 窗口: 处理 ${bridgeSigs.length} 条补全交易...`);
          for (const item of bridgeSigs) {
            if (this.isStopped) return;
            this.metricsEngine.processTransaction(item.txData, this.mint);
            this.signatureManager.markProcessed(item.sig);
          }
          dataFlowLogger.log('启动', 'Step 7.5 ✓ 桥接完成', `续算 ${bridgeSigs.length} 条`);
        }
      }
      if (this.isStopped) throw new Error('Stopped');

      // 8. 进入实时模式
      this.isInitialized = true;
      this._log('初始化完成，进入实时模式 ✓');
      dataFlowLogger.log('启动', 'Step 8 ✓ 初始化完成', `进入实时模式，已处理=${this.metricsEngine.processedCount} 条 sig`);

      // 9. 启动动态 verify，首次使用大窗口（500条）桥接整个 init 时间段可能漏掉的链上 sig
      //    正常 verify 用 50/200，但 init 期间可能积累大量 sig，首次必须拉更宽
      // this._verifyMissCount = 1; // 触发 200 条窗口（不足500，故下面单独处理）
      // this.verifySignatures(500).finally(() => {
      //   if (!this.isStopped) this._scheduleNextVerify();
      // });

    } catch (error) {
      if (!this.isStopped) {
        dataFlowLogger.log('启动', '⚠ 启动异常', `${error?.message || error}`, { stack: error?.stack });
        throw error;
      }
    }
  }

  /**
   * 早期发布：GMGN 数据到来后立即向 UI 展示交易列表（仅预览，不进 MetricsEngine 累计）
   *
   * 为什么不在这里调用 MetricsEngine？
   *   GMGN hook 只包含近期 N 条交易，而 Helius 历史 sig 可能更老。
   *   若先处理近期再处理历史（step7 performInitialCalculation），MetricsEngine 的累计顺序就是
   *   "新 → 旧"，导致持仓轮次（currentRound / completedRounds）错乱，4大参数全错。
   *
   *   正确做法：GMGN sigs 保持 isProcessed=false，等 step7 把全部 sig 按
   *   slot/timestamp 从旧到新统一处理一遍，顺序才正确。
   *
   *   此函数只负责给 UI 快速展示 recentTrades 列表（仅界面效果，不影响指标正确性）。
   */
  async _earlyPublishGmgnTrades() {
    const readyNow = this.signatureManager.getReadySignatures();
    if (this.isStopped) return;
    if (readyNow.length === 0) {
      this._log('[Step5] 暂无就绪 sig，跳过预览（GMGN 数据可能晚于超时到达，将走阶段2续算）');
      dataFlowLogger.log('启动', 'Step 5 跳过', `readyNow=0，无法预览。若GMGN数据晚到，将由onGmgnDataLoaded阶段2处理`, null);
      return;
    }

    this._log(`[Step5] 提前预览 ${readyNow.length} 条 GMGN 交易（实时列表，指标等全量后统一计算）...`);
    dataFlowLogger.log('启动', 'Step 5: 提前预览', `就绪sig=${readyNow.length}条，构建预览交易列表推送UI`, null);

    // [诊断日志] 预览排序结果（从旧到新，旧的先处理→unshift→沉底，新的后处理→浮顶）
    if (dataFlowLogger.enabled) {
      const first = readyNow[0];
      const last  = readyNow[readyNow.length - 1];
      dataFlowLogger.log('HeliusMonitor', 'Step5 预览排序', `共${readyNow.length}条 | 最旧(先处理)sig=${first?.sig?.slice(0,8)} slot=${first?.slot} ts=${first?.blockTime||first?.timestamp} | 最新(后处理)sig=${last?.sig?.slice(0,8)} slot=${last?.slot} ts=${last?.blockTime||last?.timestamp}`, null);
    }

    // 仅构建预览 recentTrades 给 UI 展示（不调用 processTransaction，不改变 traderStats）
    // 不 markProcessed → performInitialCalculation 会按正确顺序重新处理这些 sig
    const previewTrades = [];
    for (const item of readyNow) {
      const td = item.txData;
      if (!td) continue;
      if (td.type === 'gmgn') {
        const t = td.data;
        if (!t || (t.event !== 'buy' && t.event !== 'sell')) continue;
        previewTrades.unshift({
          signature: t.tx_hash,
          address: t.maker,
          action: t.event === 'buy' ? '买入' : '卖出',
          tokenAmount: Math.abs(parseFloat(t.base_amount || 0)),
          solAmount: Math.abs(parseFloat(t.quote_amount || 0)),
          rawTimestamp: t.timestamp ? t.timestamp * 1000 : Date.now(),
          label: null,
          preview: true   // 标记为预览数据，后续 performInitialCalculation 会覆盖
        });
      }
    }

    if (previewTrades.length > 0 && this.onMetricsUpdate && !this.isStopped) {
      // 发送仅含预览 recentTrades 的空指标（4大参数全0，等全量计算后再更新）
      const emptyMetrics = this.metricsEngine.getMetrics();
      emptyMetrics.recentTrades = previewTrades;
      this.onMetricsUpdate(emptyMetrics);
      dataFlowLogger.log('启动', 'Step 5 ✅ 预览推送', `已推送 ${previewTrades.length} 条预览交易到UI（4大参数暂为0，等Step7计算后更新）`, null);
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

    // 10s 超时保护（Hook 数据通常在 1-2s 内到来；若实在没有则兜底继续）
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('timeout'), 10000));

    // 进度日志
    this.progressInterval = setInterval(() => {
      if (this.isStopped) { clearInterval(this.progressInterval); return; }
      const stats = this.signatureManager.getStats();
      this._log(`等待中... 已获取 Helius sig: ${stats.total} 条，等待 GMGN 数据...`);
    }, 10000);

    this.onGmgnDataLoaded = () => {
      if (this.isStopped) return;
      const stats = this.signatureManager.getStats();
      if (this.gmgnDataLoadedResolve) {
        // ── 阶段1：初始化等待中，GMGN 数据准时到达 ──
        this._log(`[GMGN] 数据到达，当前 sig 总数: ${stats.total}，解除等待，继续初始化...`);
        dataFlowLogger.log('HeliusMonitor', '✅ GMGN数据到达(阶段1)', `sig总数=${stats.total}，正常流程：→ Step5预览 → Step6补全 → Step7计算`, null);
        this.gmgnDataLoadedResolve();
        this.gmgnDataLoadedResolve = null;
      } else if (this.isInitialized) {
        // ── 阶段2：初始化已完成，GMGN 数据晚到（超出10s等待）──
        // 直接按 SignatureManager 时序处理已存储但未处理的 sig，确保顺序正确
        this._log(`[GMGN] 数据晚到（初始化已完成），sig 总数: ${stats.total}，触发时序续算...`);
        dataFlowLogger.log('HeliusMonitor', '⚠ GMGN数据晚到(阶段2)', `sig总数=${stats.total}，跳过earlyPublish/initCalc，直接按SignatureManager时序续算`, null);
        this._tryProcessUnblocked().then(() => {
          const afterStats = this.signatureManager.getStats();
          dataFlowLogger.log('HeliusMonitor', '✅ GMGN晚到续算完成', `已处理=${this.metricsEngine.processedCount}条，sig总数=${afterStats.total}`, null);
          this._fireMetricsUpdate();
        });
      } else {
        // 初始化进行中但 gmgnDataLoadedResolve 已置空（已超时解除等待，初始化尚未完成）
        this._log(`[GMGN] 数据到达，但初始化仍在进行中（sig 总数: ${stats.total}），等待 Step8 完成后自动处理`);
        dataFlowLogger.log('HeliusMonitor', '⏳ GMGN数据到达(初始化中)', `超时后GMGN到达，初始化尚未完成，sig总数=${stats.total}，Step8后将由续算流程处理`, null);
      }
    };

    // Helius sig 流式获取（并行启动，不阻塞 GMGN 等待）
    const heliusFetchPromise = this.heliusApiEnabled
      ? this._fetchSigsStreaming()
      : Promise.resolve({ totalNew: 0, totalCached: 0 });

    // 等待 GMGN 或超时
    const raceResult = await Promise.race([gmgnPromise, timeoutPromise]);
    clearInterval(this.progressInterval);

    if (raceResult === 'timeout') {
      const timeoutStats = this.signatureManager.getStats();
      this._log(`[等待超时] GMGN 数据未在 10s 内到达，继续初始化（当前 sig=${timeoutStats.total}）。GMGN 数据到达后将自动触发阶段2续算。`);
      dataFlowLogger.log('启动', 'Step 4 ⚠ GMGN等待超时', `GMGN数据未在10s内到达，已有sig=${timeoutStats.total}。后续GMGN到达时走"阶段2晚到续算"路径`, null);
    } else {
      const okStats = this.signatureManager.getStats();
      dataFlowLogger.log('启动', 'Step 4 GMGN准时到达', `sig总数=${okStats.total}，流程正常继续`, null);
    }

    // 等待 Helius 流式获取完成（通常此时早已完成）
    const fetchResult = await heliusFetchPromise;
    this.heliusFetchedTotal = fetchResult.totalNew + fetchResult.totalCached;

    this.signatureManager.endWaitPeriod();
    this.isWaitingForGmgn = false;

    const stats = this.signatureManager.getStats();
    this._log(`Helius 历史 sig 获取完成: 新增=${fetchResult.totalNew} 缓存=${fetchResult.totalCached} 共=${stats.total}`);
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

    this.metricsEngine.printMetrics();
    this.metricsEngine.printDetailedMetrics();

    this._fireMetricsUpdate();
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

    if (this.isWaitingForGmgn || !this.isInitialized) return;

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

      this.metricsEngine.printMetrics();

      // sigFeed 条目升级为已处理状态
      this._updateSigFeed(sig);
      this._fireMetricsUpdate();

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
    this.sigFeed = [];
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
        this.statusThreshold
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

      // 单次批量读取 users 表（含评分、中转检测结果等全部字段）
      const existingUsers = await this.cacheManager.loadUsersData(allUsers);

      // 跳过条件：
      //  1. 无资金来源（funding_account 为空）→ rule 9 条件1已直接成立，无需慢速检测
      //  2. 已有隐藏中转检测结果（hiddenRelayCheckedAt 存在）
      //  3. 已有评分记录（上次已完整处理过，不再做慢速 sig 翻页）
      const unchecked = allUsers.filter(u => {
        if (!userInfo[u]?.funding_account) return false; // 无资金来源 → 条件1已覆盖，跳过
        const ud = existingUsers[u];
        if (ud?.hiddenRelayCheckedAt) return false; // 已检测过（无论是否中转）
        if (ud?.score !== undefined) return false;  // 已有评分 → 跳过，视为已分类
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
