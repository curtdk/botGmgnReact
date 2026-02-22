/**
 * SignatureManager - 浏览器版 Signature 状态管理器
 *
 * 功能：
 * 1. 跟踪所有 signature 的状态（hasData, isProcessed）
 * 2. 协调三个数据源：初始获取、WebSocket、插件
 * 3. 实现 20 秒等待策略
 * 4. 确保每个 signature 只计算一次
 */

export default class SignatureManager {
  constructor(mintAddress) {
    this.mint = mintAddress;

    // Signature 跟踪: sig -> { hasData, isProcessed, sources, timestamp, txData }
    this.signatures = new Map();

    // 数据源跟踪
    this.sources = {
      initial: new Set(),    // 从初始 getSignaturesForAddress
      websocket: new Set(),  // 从 WebSocket logsNotification
      plugin: new Set(),     // 从 GMGN 插件 tx_hash
      verify: new Set()      // 从定期校验补充
    };

    // 状态管理
    this.isWaiting = false;
    this.waitStartTime = null;
    this.fetchLock = false;

    // 回调
    this.onDataReceived = null;
  }

  /**
   * 添加 signature（从任何数据源）
   * @param {string} sig - Signature
   * @param {string} source - 来源 ('initial', 'websocket', 'plugin')
   * @param {object} gmgnData - 可选的 GMGN trade 数据
   */
  addSignature(sig, source, gmgnData = null) {
    if (!this.signatures.has(sig)) {
      // 如果提供了 GMGN 数据，标记为已有数据
      const hasData = !!gmgnData;
      const txData = gmgnData ? { type: 'gmgn', data: gmgnData } : null;

      this.signatures.set(sig, {
        hasData: hasData,        // 如果有 GMGN 数据，标记为 true
        isProcessed: false,      // 是否已计算过
        sources: new Set([source]),
        timestamp: gmgnData ? gmgnData.timestamp * 1000 : Date.now(), // GMGN 时间戳是秒，转换为毫秒
        txData: txData           // 存储 GMGN 数据或 null
      });

      // 添加到数据源跟踪
      if (this.sources[source]) {
        this.sources[source].add(sig);
      }

      if (gmgnData) {
        console.log(`[SignatureManager] 添加 signature (GMGN数据): ${sig.substring(0, 8)}... (来源: ${source})`);
      }
    } else {
      // 已存在，只添加来源
      const entry = this.signatures.get(sig);
      entry.sources.add(source);
      if (this.sources[source]) {
        this.sources[source].add(sig);
      }

      // 如果之前没有数据，现在有 GMGN 数据，更新
      if (!entry.hasData && gmgnData) {
        entry.hasData = true;
        entry.txData = { type: 'gmgn', data: gmgnData };
        entry.timestamp = gmgnData.timestamp * 1000;
        console.log(`[SignatureManager] 更新 signature (GMGN数据): ${sig.substring(0, 8)}... (来源: ${source})`);
      }
    }
  }

  /**
   * 标记 signature 已有数据（Helius 格式）
   */
  markHasData(sig, txData) {
    if (!this.signatures.has(sig)) {
      this.addSignature(sig, 'unknown');
    }

    const entry = this.signatures.get(sig);

    // 只在没有数据时更新，或者用 Helius 数据覆盖 GMGN 数据
    if (!entry.hasData || (entry.txData && entry.txData.type === 'gmgn')) {
      entry.hasData = true;
      entry.txData = { type: 'helius', data: txData };

      // 触发回调
      if (this.onDataReceived) {
        this.onDataReceived(sig, txData);
      }
    }
  }

  /**
   * 标记 signature 已计算
   */
  markProcessed(sig) {
    if (this.signatures.has(sig)) {
      this.signatures.get(sig).isProcessed = true;
    }
  }

  /**
   * 获取 signature 状态
   */
  getState(sig) {
    return this.signatures.get(sig) || null;
  }

  /**
   * 检查是否有数据
   */
  hasData(sig) {
    const state = this.signatures.get(sig);
    return state ? state.hasData : false;
  }

  /**
   * 检查是否已处理
   */
  isProcessedSig(sig) {
    const state = this.signatures.get(sig);
    return state ? state.isProcessed : false;
  }

  /**
   * 获取需要 API 获取的 signatures
   */
  getMissingSignatures() {
    const missing = [];

    for (const [sig, state] of this.signatures.entries()) {
      if (!state.hasData) {  // 没有数据的需要获取
        missing.push({ sig, timestamp: state.timestamp });
      }
    }

    // 按时间戳排序（从旧到新）
    missing.sort((a, b) => a.timestamp - b.timestamp);

    return missing.map(item => item.sig);
  }

  /**
   * 获取准备计算的 signatures（有数据但未处理）
   */
  getReadySignatures() {
    const ready = [];

    for (const [sig, state] of this.signatures.entries()) {
      if (state.hasData && !state.isProcessed) {
        ready.push({
          sig,
          timestamp: state.timestamp,
          txData: state.txData
        });
      }
    }

    // 按时间戳倒排序（从旧到新）
    ready.sort((a, b) => a.timestamp - b.timestamp);

    return ready;
  }

  /**
   * 开始等待期
   */
  startWaitPeriod() {
    this.isWaiting = true;
    this.waitStartTime = Date.now();
    console.log('[SignatureManager] 开始 20 秒等待期...');
  }

  /**
   * 结束等待期
   */
  endWaitPeriod() {
    this.isWaiting = false;
    const duration = Date.now() - this.waitStartTime;
    console.log(`[SignatureManager] 等待期结束，耗时 ${(duration / 1000).toFixed(1)} 秒`);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    let total = 0;
    let hasData = 0;
    let isProcessed = 0;
    const bySources = { initial: 0, websocket: 0, plugin: 0, verify: 0 };
    const byDataSource = { api: 0, cache: 0, plugin: 0, websocket: 0 };

    for (const [sig, entry] of this.signatures.entries()) {
      total++;
      if (entry.hasData) hasData++;
      if (entry.isProcessed) isProcessed++;

      // 统计 signature 来源
      entry.sources.forEach(src => {
        if (bySources[src] !== undefined) {
          bySources[src]++;
        }
      });

      // 统计详细信息来源
      if (entry.hasData && entry.txData) {
        const dataType = entry.txData.type; // 'gmgn', 'helius', 'cache', 'websocket'
        if (dataType === 'gmgn') {
          byDataSource.plugin++;
        } else if (dataType === 'helius') {
          byDataSource.api++;
        } else if (dataType === 'cache') {
          byDataSource.cache++;
        } else if (dataType === 'websocket') {
          byDataSource.websocket++;
        }
      }
    }

    return {
      total,
      hasData,
      needFetch: total - hasData,
      isProcessed,
      notProcessed: total - isProcessed,
      bySources,        // Signature 来源
      byDataSource      // 详细信息来源
    };
  }

  /**
   * 清理旧数据（可选，防止内存溢出）
   */
  cleanup(maxAge = 7 * 24 * 60 * 60 * 1000) {  // 默认 7 天
    const now = Date.now();
    let removed = 0;

    for (const [sig, state] of this.signatures.entries()) {
      if (now - state.timestamp > maxAge) {
        this.signatures.delete(sig);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[SignatureManager] 清理了 ${removed} 个旧 signatures`);
    }
  }

  /**
   * 清理所有数据
   */
  clear() {
    console.log('[SignatureManager] 清理所有数据...');

    this.signatures.clear();
    this.sources.initial.clear();
    this.sources.websocket.clear();
    this.sources.plugin.clear();
    this.sources.verify.clear();

    this.isWaiting = false;
    this.waitStartTime = null;
    this.fetchLock = false;

    this.onDataReceived = null;

    console.log('[SignatureManager] 数据清理完成');
  }
}
