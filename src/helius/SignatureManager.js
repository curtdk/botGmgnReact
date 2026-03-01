/**
 * SignatureManager v2 - Signature 状态管理器
 *
 * v2 变化：
 *  - 每条 sig 携带 slot / blockTime / blockIndex（来自 Helius API 原始字段）
 *  - 内存 Map 的排序以 slot DESC + blockIndex DESC 为准（与 Helius 标准顺序一致）
 *  - 新增 verifyAndReorder()：对 GMGN/WS 来源的 sig 做位置验证，发现乱序时标记
 *  - 向后兼容：addSignature() 保留，slot/blockTime 可选（WS来源初始无此信息）
 */

export default class SignatureManager {
  constructor(mintAddress) {
    this.mint = mintAddress;

    // sig → { slot, blockTime, blockIndex, hasData, isProcessed, sources, txData, createdAt }
    this.signatures = new Map();

    // 数据源跟踪
    this.sources = {
      initial: new Set(),
      websocket: new Set(),
      plugin: new Set(),
      verify: new Set()
    };

    // 累计初始获取计数（跨多次 verify 叠加）
    this.cumulativeInitialCount = 0;

    // 等待状态
    this.isWaiting = false;
    this.waitStartTime = null;
    this.fetchLock = false;

    // 回调
    this.onDataReceived = null;
  }

  // ─────────────────────────────────────────────────────────
  // 添加 sig
  // ─────────────────────────────────────────────────────────

  /**
   * 添加 signature
   * @param {string|Object} sigOrObj - sig字符串 或 Helius原始sig对象 { signature, slot, blockTime, blockIndex }
   * @param {string} source - 来源 'initial'|'websocket'|'plugin'|'verify'
   * @param {Object|null} gmgnData - 可选的 GMGN trade 数据
   */
  addSignature(sigOrObj, source, gmgnData = null) {
    const sig = typeof sigOrObj === 'string' ? sigOrObj : sigOrObj.signature;
    const slot = (typeof sigOrObj === 'object' && sigOrObj.slot) || 0;
    const blockTime = (typeof sigOrObj === 'object' && sigOrObj.blockTime) || 0;
    const blockIndex = (typeof sigOrObj === 'object' && sigOrObj.blockIndex) || 0;

    if (!this.signatures.has(sig)) {
      const hasData = !!gmgnData;
      const txData = gmgnData ? { type: 'gmgn', data: gmgnData } : null;

      if (source === 'initial') {
        this.cumulativeInitialCount++;
      }

      this.signatures.set(sig, {
        slot,
        blockTime,
        blockIndex,
        hasData,
        isProcessed: false,
        sources: new Set([source]),
        // 时间戳：优先用 blockTime（秒→毫秒），其次 GMGN timestamp，最后当前时间
        timestamp: blockTime ? blockTime * 1000 : (gmgnData?.timestamp ? gmgnData.timestamp * 1000 : Date.now()),
        txData,
        createdAt: Date.now()
      });

      if (this.sources[source]) this.sources[source].add(sig);

    } else {
      const entry = this.signatures.get(sig);
      entry.sources.add(source);
      if (this.sources[source]) this.sources[source].add(sig);

      // 用 Helius 数据补充 slot/blockTime（更精确）
      if (slot > 0 && entry.slot === 0) {
        entry.slot = slot;
        entry.blockTime = blockTime;
        entry.blockIndex = blockIndex;
        entry.timestamp = blockTime * 1000;
      }

      // 若之前无数据，现在有 GMGN 数据，更新
      if (!entry.hasData && gmgnData) {
        entry.hasData = true;
        entry.txData = { type: 'gmgn', data: gmgnData };
        if (!entry.timestamp && gmgnData.timestamp) {
          entry.timestamp = gmgnData.timestamp * 1000;
        }
      }
    }
  }

  /**
   * 批量添加来自 Helius API 的 sig 原始列表（含 slot/blockTime）
   * @param {Array} rawSigs - Helius getSignaturesForAddress 原始结果
   * @param {string} source
   */
  addSignatureBatch(rawSigs, source = 'initial') {
    const n = rawSigs.length;
    rawSigs.forEach((raw, idx) => {
      // Helius 返回倒序数组，idx=0 最新，blockIndex 越大越新
      const blockIndex = n - idx; // 转换：越新 blockIndex 越大
      this.addSignature(
        {
          signature: typeof raw === 'string' ? raw : raw.signature,
          slot: raw.slot || 0,
          blockTime: raw.blockTime || 0,
          blockIndex
        },
        source
      );
    });
  }

  // ─────────────────────────────────────────────────────────
  // 数据状态标记
  // ─────────────────────────────────────────────────────────

  markHasData(sig, txData) {
    if (!this.signatures.has(sig)) {
      this.addSignature(sig, 'unknown');
    }

    const entry = this.signatures.get(sig);
    // Helius 数据优先级高于 GMGN
    if (!entry.hasData || entry.txData?.type === 'gmgn') {
      entry.hasData = true;
      entry.txData = { type: 'helius', data: txData };

      if (this.onDataReceived) {
        this.onDataReceived(sig, txData);
      }
    }
  }

  markProcessed(sig) {
    if (this.signatures.has(sig)) {
      this.signatures.get(sig).isProcessed = true;
    }
  }

  // ─────────────────────────────────────────────────────────
  // 查询接口
  // ─────────────────────────────────────────────────────────

  getState(sig) {
    return this.signatures.get(sig) || null;
  }

  hasData(sig) {
    return this.signatures.get(sig)?.hasData ?? false;
  }

  isProcessedSig(sig) {
    return this.signatures.get(sig)?.isProcessed ?? false;
  }

  /**
   * 获取需要 API 拉取详情的 sig 列表
   * 按 slot ASC（从旧到新）顺序返回，确保计算按时序进行
   */
  getMissingSignatures() {
    const missing = [];
    for (const [sig, state] of this.signatures.entries()) {
      if (!state.hasData) {
        missing.push({ sig, slot: state.slot, blockTime: state.blockTime, blockIndex: state.blockIndex });
      }
    }
    // 从旧到新（slot ASC，同slot内 blockIndex ASC）
    missing.sort((a, b) => {
      if (a.slot !== b.slot) return a.slot - b.slot;
      return a.blockIndex - b.blockIndex;
    });
    return missing.map(item => item.sig);
  }

  /**
   * 获取准备计算的 sig（有数据未处理），按从旧到新排序
   */
  getReadySignatures() {
    const ready = [];
    for (const [sig, state] of this.signatures.entries()) {
      if (state.hasData && !state.isProcessed) {
        ready.push({ sig, slot: state.slot, blockTime: state.blockTime, blockIndex: state.blockIndex, txData: state.txData });
      }
    }
    // 从旧到新（确保交易顺序正确）
    ready.sort((a, b) => {
      if (a.slot !== b.slot) return a.slot - b.slot;
      return a.blockIndex - b.blockIndex;
    });
    return ready;
  }

  /**
   * 获取最新的 sig（用于增量拉取的 until 参数）
   * @returns {{ sig, slot, blockTime } | null}
   */
  getLatestSig() {
    let latest = null;
    for (const [sig, state] of this.signatures.entries()) {
      if (state.sources.has('initial') || state.sources.has('verify')) {
        if (!latest || state.slot > latest.slot ||
           (state.slot === latest.slot && state.blockIndex > latest.blockIndex)) {
          latest = { sig, slot: state.slot, blockTime: state.blockTime };
        }
      }
    }
    return latest;
  }

  /**
   * 顺序验证：检查 GMGN/WS 来源的 sig 是否在预期位置
   * 发现 slot 信息后，用 Helius slot 更新排序信息
   * @param {string} sig
   * @param {number} slot - 从 Helius verify 得到的真实 slot
   * @param {number} blockTime
   * @param {number} blockIndex
   * @returns {boolean} 是否发生了位置更新
   */
  updateSigOrder(sig, slot, blockTime, blockIndex = 0) {
    const entry = this.signatures.get(sig);
    if (!entry) return false;

    const changed = entry.slot !== slot || entry.blockIndex !== blockIndex;
    if (changed) {
      console.log(`[SignatureManager] 顺序更新 ${sig.slice(0, 8)}... slot: ${entry.slot}→${slot} blockIdx: ${entry.blockIndex}→${blockIndex}`);
      entry.slot = slot;
      entry.blockTime = blockTime;
      entry.blockIndex = blockIndex;
      entry.timestamp = blockTime * 1000;
    }
    return changed;
  }

  // ─────────────────────────────────────────────────────────
  // 等待期控制
  // ─────────────────────────────────────────────────────────

  startWaitPeriod() {
    this.isWaiting = true;
    this.waitStartTime = Date.now();
    console.log('[SignatureManager] 开始等待期...');
  }

  endWaitPeriod() {
    this.isWaiting = false;
    const duration = Date.now() - this.waitStartTime;
    console.log(`[SignatureManager] 等待期结束，耗时 ${(duration / 1000).toFixed(1)} 秒`);
  }

  // ─────────────────────────────────────────────────────────
  // 统计
  // ─────────────────────────────────────────────────────────

  getStats() {
    let total = 0, hasData = 0, isProcessed = 0;
    const bySources = { initial: 0, websocket: 0, plugin: 0, verify: 0 };
    const byDataSource = { api: 0, cache: 0, plugin: 0, websocket: 0 };

    for (const [, entry] of this.signatures.entries()) {
      total++;
      if (entry.hasData) hasData++;
      if (entry.isProcessed) isProcessed++;

      entry.sources.forEach(src => {
        if (bySources[src] !== undefined) bySources[src]++;
      });

      if (entry.hasData && entry.txData) {
        const t = entry.txData.type;
        if (t === 'gmgn') byDataSource.plugin++;
        else if (t === 'helius') byDataSource.api++;
        else if (t === 'cache') byDataSource.cache++;
        else if (t === 'websocket') byDataSource.websocket++;
      }
    }

    return {
      total,
      hasData,
      needFetch: total - hasData,
      isProcessed,
      notProcessed: total - isProcessed,
      bySources: { ...bySources, initial: this.cumulativeInitialCount },
      byDataSource
    };
  }

  // ─────────────────────────────────────────────────────────
  // 清理
  // ─────────────────────────────────────────────────────────

  cleanup(maxAge = 7 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let removed = 0;
    for (const [sig, state] of this.signatures.entries()) {
      if (now - state.createdAt > maxAge) {
        this.signatures.delete(sig);
        removed++;
      }
    }
    if (removed > 0) console.log(`[SignatureManager] 清理 ${removed} 个旧 sig`);
  }

  clear() {
    console.log('[SignatureManager] 清理所有数据...');
    this.signatures.clear();
    Object.values(this.sources).forEach(s => s.clear());
    this.cumulativeInitialCount = 0;
    this.isWaiting = false;
    this.waitStartTime = null;
    this.fetchLock = false;
    this.onDataReceived = null;
    console.log('[SignatureManager] 数据清理完成');
  }
}
