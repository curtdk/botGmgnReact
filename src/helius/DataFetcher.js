/**
 * DataFetcher v2 - 数据获取器
 *
 * v2 变化：
 *  - fetchHistorySigs 改为流式回调：每页拿到数据立即回调，不等全部完成
 *    → 支持与 GMGN 数据并行处理（HeliusMonitor 可立即消费每一页 sig）
 *  - 保留原始 Helius sig 对象（含 slot/blockTime），不提前过滤失败交易的元数据
 *  - 增量拉取：优先使用 IndexedDB 中最新 sig 的 slot 作为 until 参数
 *  - verify 优化：动态拉取数量（默认50条，有缺失则最多200条）
 */

export default class DataFetcher {
  constructor(cacheManager, apiKey = '') {
    this.cacheManager = cacheManager;
    this.totalCreditsUsed = 0;
    this.apiKey = apiKey;
  }

  setApiKey(key) {
    this.apiKey = key || '';
  }

  get rpcUrl() {
    return `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
  }

  // ─────────────────────────────────────────────────────────
  // 基础 RPC 调用（带指数退避重试）
  // ─────────────────────────────────────────────────────────

  async call(method, params) {
    let retries = 3;
    let delay = 1000;

    while (retries > 0) {
      try {
        const response = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
        });

        if (response.status === 429) {
          console.warn(`[RPC] 429 限流，${delay}ms 后重试...`);
          await new Promise(r => setTimeout(r, delay));
          delay *= 2;
          retries--;
          continue;
        }

        if (!response.ok) throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);

        const data = await response.json();

        if (data.error) {
          if (data.error.code === -32429) {
            console.warn(`[RPC] JSON-RPC 限流，${delay}ms 后重试...`);
            await new Promise(r => setTimeout(r, delay));
            delay *= 2;
            retries--;
            continue;
          }
          throw new Error(`RPC Error: ${JSON.stringify(data.error)}`);
        }

        return data.result;

      } catch (error) {
        if (retries === 1) {
          console.error(`[RPC] 方法 ${method} 最终失败:`, error.message);
          throw error;
        }
        console.warn(`[RPC] 网络错误 (${method}): ${error.message}，重试...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        retries--;
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // 获取 sig 列表（单次调用，返回原始 Helius 对象数组）
  // ─────────────────────────────────────────────────────────

  /**
   * 获取地址的 sig 列表（单页）
   * @param {string} address
   * @param {Object} options - { limit, before, until }
   * @returns {Array} Helius 原始 sig 对象 [{ signature, slot, blockTime, err, ... }]
   */
  async fetchSignaturesRaw(address, options = {}) {
    const params = [
      address,
      {
        limit: options.limit || 1000,
        ...(options.before ? { before: options.before } : {}),
        ...(options.until ? { until: options.until } : {})
      }
    ];
    const result = await this.call('getSignaturesForAddress', params);
    return Array.isArray(result) ? result : [];
  }

  /**
   * 向后兼容：返回成功 sig 字符串数组
   */
  async fetchSignatures(address, options = {}) {
    const raw = await this.fetchSignaturesRaw(address, options);
    return raw.filter(s => !s.err).map(s => s.signature);
  }

  // ─────────────────────────────────────────────────────────
  // 历史 sig 流式获取（v2 核心改造）
  // ─────────────────────────────────────────────────────────

  /**
   * 流式获取历史 sig 列表
   *
   * 与旧版的区别：
   *  - 每获取一页立即调用 onPage 回调，不等待全部完成
   *  - onPage 收到 Helius 原始对象数组（含 slot/blockTime），可立即存 IndexedDB 并通知 SignatureManager
   *  - 增量：从 IndexedDB 读最新 sig 作为 until 参数，只拉新增部分
   *
   * @param {string} address - 代币 mint 地址
   * @param {Function} onPage - 每页回调 (rawSigs: Array, pageIndex: number, isLast: boolean) => void
   * @returns {{ totalNew: number, totalCached: number }}
   */
  async fetchHistorySigsStreaming(address, onPage) {
    console.log(`[历史] 流式获取 sig 列表 (${address.slice(0, 8)}...)...`);

    // 1. 从 IndexedDB 读最新 sig（用于增量拉取的 until 参数）
    let untilSig = null;
    let cachedCount = 0;
    if (this.cacheManager) {
      const latest = await this.cacheManager.getLatestSig(address);
      if (latest) {
        untilSig = latest.signature;
        cachedCount = (await this.cacheManager.loadSigsByMint(address)).length;
        console.log(`[缓存] 已有 ${cachedCount} 条 sig，增量拉取 until: ${untilSig.slice(0, 8)}...`);
      }
    }

    // 2. 分页拉取新 sig，每页立即回调
    let before = null;
    let hasMore = true;
    let pageIndex = 0;
    let totalNew = 0;

    while (hasMore) {
      const rawPage = await this.fetchSignaturesRaw(address, {
        limit: 1000,
        before: before || undefined,
        until: untilSig || undefined
      });

      if (!rawPage || rawPage.length === 0) {
        hasMore = false;
        break;
      }

      // 过滤失败交易（但保留完整原始对象用于 slot/blockTime）
      // 注意：before 游标必须用原始最后一条（含失败），确保分页不跳过区间
      const successSigs = rawPage.filter(s => !s.err);
      totalNew += successSigs.length;
      pageIndex++;

      // 判断是否是最后一页（< 1000 条）
      const isLast = rawPage.length < 1000;

      // ── 立即回调，让调用方可以并行处理 ──
      if (successSigs.length > 0 && onPage) {
        onPage(successSigs, pageIndex, isLast);
      }

      // 批量存 IndexedDB（异步，不阻塞下一页拉取）
      if (this.cacheManager && successSigs.length > 0) {
        this.cacheManager.saveSigBatch(address, successSigs, 'helius').catch(e =>
          console.warn('[DataFetcher] 保存 sig 批次失败:', e.message)
        );
      }

      if (pageIndex % 5 === 0) {
        console.log(`[历史] 已获取 ${pageIndex} 页 (新增 ${totalNew} 条)...`);
      }

      if (isLast) {
        hasMore = false;
      } else {
        // before 游标用原始最后一条（含失败交易），确保不跳区间
        before = rawPage[rawPage.length - 1].signature;
      }
    }

    console.log(`[历史] 流式获取完成 | 新增=${totalNew} 缓存=${cachedCount}`);
    return { totalNew, totalCached: cachedCount };
  }

  /**
   * 向后兼容：非流式版本，等待全部完成返回结果
   * （HeliusMonitor 旧调用路径，逐步迁移后可移除）
   */
  async fetchHistorySigs(address) {
    console.log(`[历史] 获取 sig 列表 (${address.slice(0, 8)}...)...`);

    let cachedSigs = [];
    if (this.cacheManager) {
      cachedSigs = await this.cacheManager.loadSignatureList(address);
    }

    let untilSig = cachedSigs.length > 0 ? cachedSigs[cachedSigs.length - 1] : null;
    if (untilSig) {
      console.log(`[缓存] 发现 ${cachedSigs.length} 条缓存，增量拉取 until: ${untilSig.slice(0, 8)}...`);
    }

    let before = null;
    let hasMore = true;
    let pageCount = 0;
    const newRawSigs = []; // 保留原始对象

    while (hasMore) {
      const rawPage = await this.fetchSignaturesRaw(address, {
        limit: 1000,
        before: before || undefined,
        until: untilSig || undefined
      });

      if (!rawPage || rawPage.length === 0) { hasMore = false; break; }

      const successSigs = rawPage.filter(s => !s.err);
      newRawSigs.push(...successSigs);
      before = rawPage[rawPage.length - 1].signature;
      pageCount++;

      if (pageCount % 5 === 0) {
        console.log(`  [增量] ${pageCount} 页... (新增 ${successSigs.length})`);
      }

      if (rawPage.length < 1000) hasMore = false;
    }

    console.log(`[历史] 新增 sig: ${newRawSigs.length} 条`);

    // 新 sig 从新到旧 → 反转为从旧到新，与缓存合并
    newRawSigs.reverse();
    const newSigStrings = newRawSigs.map(r => r.signature);
    const allSigs = [...cachedSigs, ...newSigStrings];

    // 存 IndexedDB
    if (this.cacheManager && newRawSigs.length > 0) {
      // 存带元数据的完整记录（但此时 blockIndex 不准，后续 verify 会补充）
      await this.cacheManager.saveSigBatch(address, newRawSigs.reverse(), 'helius');
      console.log(`[历史] 已持久化 sig 列表: ${allSigs.length} 条`);
    }

    return { allSigs, newSigs: newSigStrings, cachedSigs };
  }

  // ─────────────────────────────────────────────────────────
  // 批量获取交易详情
  // ─────────────────────────────────────────────────────────

  /**
   * 批量获取交易详情（并发5路）
   * @param {string[]} signatures
   * @param {string} mintAddress - 用于缓存分类
   * @returns {Array} 成功获取的交易数组
   */
  async fetchParsedTxs(signatures, mintAddress) {
    const CONCURRENCY = 5;
    const allTxs = [];

    for (let i = 0; i < signatures.length; i += CONCURRENCY) {
      const batch = signatures.slice(i, i + CONCURRENCY);

      const results = await Promise.all(batch.map(async (sig) => {
        try {
          const result = await this.call('getTransaction', [
            sig,
            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
          ]);

          if (result && mintAddress && this.cacheManager) {
            // 异步缓存，不阻塞主流程
            this.cacheManager.saveTransaction(sig, mintAddress, result).catch(e =>
              console.warn(`[DataFetcher] 缓存交易失败 ${sig.slice(0, 8)}:`, e.message)
            );
            // 同步更新 sig 的 hasData 状态
            this.cacheManager.updateSigStatus(sig, { hasData: true }).catch(() => {});
          }
          return result;
        } catch (err) {
          console.error(`[DataFetcher] 获取交易失败 ${sig.slice(0, 8)}:`, err.message);
          return null;
        }
      }));

      allTxs.push(...results.filter(Boolean));

      // 避免限流
      if (i + CONCURRENCY < signatures.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    return allTxs;
  }

  // ─────────────────────────────────────────────────────────
  // Verify 专用：小批量拉取最新 sig（动态数量）
  // ─────────────────────────────────────────────────────────

  /**
   * 拉取用于 verify 的最新 sig（不超过 limit 条）
   * verify 不需要全量 1000 条，通常 50 条足够
   */
  async fetchLatestSigsForVerify(address, limit = 50) {
    const raw = await this.fetchSignaturesRaw(address, { limit });
    return raw.filter(s => !s.err);
  }
}
