/**
 * DataFetcher - 浏览器版数据获取器
 *
 * 功能：
 * 1. 使用 fetch() API 进行 RPC 调用
 * 2. 获取 signatures 和交易详情
 * 3. 指数退避重试逻辑
 * 4. 批量获取并发控制
 */

const API_KEY = '2304ce34-8d7d-4b15-a6cf-25722d048b45';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

export default class DataFetcher {
  constructor(cacheManager) {
    this.cacheManager = cacheManager;
    this.totalCreditsUsed = 0;
  }

  /**
   * RPC 调用（带重试）
   */
  async call(method, params) {
    let retries = 3;
    let delay = 1000;

    while (retries > 0) {
      try {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: method,
            params: params
          })
        });

        if (response.status === 429) {
          console.warn(`[RPC] 请求过于频繁 (429). 将在 ${delay}毫秒后重试...`);
          await new Promise(r => setTimeout(r, delay));
          delay *= 2; // 指数退避
          retries--;
          continue;
        }

        if (!response.ok) {
          throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        if (data.error) {
          if (data.error.code === -32429) { // JSON-RPC 限流代码
            console.warn(`[RPC] 触发限流. 将在 ${delay}毫秒后重试...`);
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
          console.error(`[RPC 客户端错误] 方法: ${method}`, error.message);
          throw error;
        }
        // 网络错误，重试
        console.warn(`[RPC] 网络错误: ${error.message}. 正在重试...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        retries--;
      }
    }
  }

  /**
   * 获取 signatures 列表
   */
  async fetchSignatures(address, options = {}) {
    const params = [
      address,
      {
        limit: options.limit || 1000,
        before: options.before,
        until: options.until
      }
    ];

    const sigs = await this.call('getSignaturesForAddress', params);

    if (!sigs || sigs.length === 0) {
      return [];
    }

    // 过滤失败的交易
    const successSigs = sigs.filter(s => !s.err).map(s => s.signature);
    return successSigs;
  }

  /**
   * 批量获取交易详情
   */
  async fetchParsedTxs(signatures, mintAddress) {
    const CONCURRENCY = 5; // 并发数
    let allTxs = [];

    for (let i = 0; i < signatures.length; i += CONCURRENCY) {
      const batchSigs = signatures.slice(i, i + CONCURRENCY);

      const promises = batchSigs.map(async (sig) => {
        try {
          const result = await this.call('getTransaction', [
            sig,
            {
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed"
            }
          ]);

          if (result && mintAddress && this.cacheManager) {
            // 立即缓存获取的交易
            await this.cacheManager.saveTransaction(sig, mintAddress, result);
          }
          return result;
        } catch (err) {
          console.error(`[数据抓取] 获取交易失败 ${sig}:`, err.message);
          return null;
        }
      });

      const results = await Promise.all(promises);
      const validTxs = results.filter(tx => tx);
      allTxs.push(...validTxs);

      // 延迟以避免限流
      await new Promise(r => setTimeout(r, 200));
    }

    return allTxs;
  }

  /**
   * 获取历史 signatures（增量获取）
   */
  async fetchHistorySigs(address) {
    console.log(`[历史] 正在获取交易签名列表 (${address})...`);

    // 1. 从 signatures 表加载完整有序的 sig 列表（从旧到新）
    let cachedSigs = [];
    if (this.cacheManager) {
      cachedSigs = await this.cacheManager.loadSignatureList(address);
    }

    let untilSig = null;
    if (cachedSigs.length > 0) {
      // cachedSigs 是从旧到新排序，最后一条是最新的
      untilSig = cachedSigs[cachedSigs.length - 1];
      console.log(`[缓存] 发现本地缓存 ${cachedSigs.length} 条签名。将增量拉取 (直到: ${untilSig.slice(0, 8)}...)`);
    }

    // 2. 获取新 signatures
    let newSigs = [];
    let before = null;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      const params = [
        address,
        {
          limit: 1000,
          before: before,
          ...(untilSig ? { until: untilSig } : {})
        }
      ];

      // 使用原始结果判断是否还有下一页，避免过滤后数量 < 1000 导致提前终止
      const rawResult = await this.call('getSignaturesForAddress', params);

      if (!rawResult || rawResult.length === 0) {
        hasMore = false;
        break;
      }

      // 只保留成功的交易 sig（过滤失败）
      const successSigs = rawResult.filter(s => !s.err).map(s => s.signature);
      newSigs.push(...successSigs);

      // before 游标用原始最后一条（含失败交易），确保分页不跳过任何区间
      before = rawResult[rawResult.length - 1].signature;
      pageCount++;

      if (pageCount % 5 === 0) {
        console.log(`  [增量] 已获取 ${pageCount} 页新签名... (本页原始=${rawResult.length} 有效=${successSigs.length})`);
      }

      // 用原始数量判断是否有下一页（过滤后数量可能因失败交易而 < 1000 但实际还有数据）
      if (rawResult.length < 1000) hasMore = false;
    }

    console.log(`[历史] 增量获取新签名: ${newSigs.length} 条`);

    // 3. 合并缓存
    // newSigs 是从新到旧，反转以匹配缓存（从旧到新）
    newSigs.reverse();

    const allSigs = [...cachedSigs, ...newSigs];

    // 4. 持久化完整 sig 列表到 signatures 表（确保下次增量拉取有完整基准）
    if (this.cacheManager && newSigs.length > 0) {
      await this.cacheManager.saveSignatureList(address, allSigs);
      console.log(`[历史] 已持久化完整 sig 列表: ${allSigs.length} 条`);
    }

    return { allSigs, newSigs, cachedSigs };
  }
}
