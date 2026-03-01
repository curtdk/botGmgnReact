/**
 * CacheManager v2 - 基于 IndexedDB 的缓存管理器
 *
 * DB Schema v2 变更：
 *  - transactions store：不变（sig → txData）
 *  - signatures store：v1=mint键数组 → v2=sig键独立记录（含slot/blockTime/source）
 *  - users store：新增，address键，存用户评分/身份/隐藏中转等信息
 *  - mint_meta store：新增，mint键，存每个mint的元信息
 */

export default class CacheManager {
  constructor() {
    this.dbName = 'helius_cache';
    this.dbVersion = 2;
    this.db = null;
  }

  // ─────────────────────────────────────────────────────────
  // 初始化 / 升级
  // ─────────────────────────────────────────────────────────

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.error('[CacheManager] 打开数据库失败:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[CacheManager] 数据库初始化成功 v2');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;
        console.log(`[CacheManager] 数据库升级 v${oldVersion} → v${this.dbVersion}`);

        // === transactions store（保持不变）===
        if (!db.objectStoreNames.contains('transactions')) {
          const txStore = db.createObjectStore('transactions', { keyPath: 'signature' });
          txStore.createIndex('mint', 'mint', { unique: false });
          txStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // === signatures store（v2：sig键独立记录，废弃v1的mint键数组）===
        if (db.objectStoreNames.contains('signatures')) {
          db.deleteObjectStore('signatures'); // 删除v1旧结构（数据重新从Helius拉取）
        }
        const sigStore = db.createObjectStore('signatures', { keyPath: 'signature' });
        sigStore.createIndex('mint', 'mint', { unique: false });
        // 复合索引：按mint+slot查询（用于排序验证）
        sigStore.createIndex('mint_slot', ['mint', 'slot'], { unique: false });
        sigStore.createIndex('slot', 'slot', { unique: false });
        console.log('[CacheManager] 创建 signatures store v2');

        // === users store（新增）===
        if (!db.objectStoreNames.contains('users')) {
          const userStore = db.createObjectStore('users', { keyPath: 'address' });
          userStore.createIndex('mint', 'mint', { unique: false });
          userStore.createIndex('status', 'status', { unique: false });
          console.log('[CacheManager] 创建 users store');
        }

        // === mint_meta store（新增）===
        if (!db.objectStoreNames.contains('mint_meta')) {
          db.createObjectStore('mint_meta', { keyPath: 'mint' });
          console.log('[CacheManager] 创建 mint_meta store');
        }
      };
    });
  }

  // ─────────────────────────────────────────────────────────
  // signatures store 操作
  // ─────────────────────────────────────────────────────────

  /**
   * 批量保存 sig 记录（来自 Helius getSignaturesForAddress 原始结果）
   * @param {string} mint - 代币地址
   * @param {Array} rawSigs - Helius 返回的原始 sig 对象数组
   *   每条格式: { signature, slot, blockTime, err, memo }
   * @param {string} source - 来源标识 'helius'|'gmgn'|'ws'
   */
  async saveSigBatch(mint, rawSigs, source = 'helius') {
    if (!this.db) await this.init();
    if (!rawSigs || rawSigs.length === 0) return 0;

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['signatures'], 'readwrite');
      const store = tx.objectStore('signatures');
      let completed = 0;
      let saved = 0;

      tx.oncomplete = () => resolve(saved);
      tx.onerror = () => reject(tx.error);

      rawSigs.forEach((rawSig, idx) => {
        const sig = typeof rawSig === 'string' ? rawSig : rawSig.signature;
        if (!sig) { completed++; return; }

        // 先读取是否已存在，避免覆盖 hasData/isProcessed 状态
        const getReq = store.get(sig);
        getReq.onsuccess = () => {
          const existing = getReq.result;

          const record = {
            signature: sig,
            mint,
            slot: rawSig.slot || 0,
            blockTime: rawSig.blockTime || 0,
            // 区块内执行序号：Helius返回的数组是倒序，同一slot内越靠后index越小(越早执行)
            // idx是倒序数组中的位置，转换：blockIndex = array.length - idx（近似）
            blockIndex: rawSig.blockIndex !== undefined ? rawSig.blockIndex : (rawSigs.length - idx),
            source: existing ? existing.source : source,
            hasData: existing ? existing.hasData : false,
            isProcessed: existing ? existing.isProcessed : false,
            createdAt: existing ? existing.createdAt : Date.now()
          };

          const putReq = store.put(record);
          putReq.onsuccess = () => { saved++; };
        };
      });

      // 用 oncomplete 而非逐条计数确保所有操作完成
    });
  }

  /**
   * 保存单条 sig 记录（通常来自 GMGN 或 WS）
   */
  async saveSig(mint, sig, { slot = 0, blockTime = 0, blockIndex = 0, source = 'gmgn' } = {}) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['signatures'], 'readwrite');
      const store = tx.objectStore('signatures');

      const getReq = store.get(sig);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          // 若 Helius 数据到来，更新 slot/blockTime（更准确）
          if (source === 'helius' && slot > 0) {
            existing.slot = slot;
            existing.blockTime = blockTime;
            existing.blockIndex = blockIndex;
          }
          // 合并来源
          if (!existing.source.includes(source)) {
            existing.source = existing.source + '+' + source;
          }
          store.put(existing);
        } else {
          store.put({ signature: sig, mint, slot, blockTime, blockIndex, source, hasData: false, isProcessed: false, createdAt: Date.now() });
        }
        resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * 更新 sig 的 hasData / isProcessed 状态
   */
  async updateSigStatus(sig, { hasData, isProcessed } = {}) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['signatures'], 'readwrite');
      const store = tx.objectStore('signatures');

      const getReq = store.get(sig);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (!record) { resolve(); return; }

        if (hasData !== undefined) record.hasData = hasData;
        if (isProcessed !== undefined) record.isProcessed = isProcessed;

        store.put(record);
        resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * 按 mint 加载全部 sig 记录，按 slot DESC + blockIndex DESC 排序（最新在前=Helius标准顺序）
   * @returns {Array<{signature, slot, blockTime, blockIndex, source, hasData, isProcessed}>}
   */
  async loadSigsByMint(mint) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['signatures'], 'readonly');
      const store = tx.objectStore('signatures');
      const index = store.index('mint');

      const request = index.getAll(mint);
      request.onsuccess = () => {
        const records = request.result || [];
        // 按 slot DESC，同slot内 blockIndex DESC（最新在前）
        records.sort((a, b) => {
          if (b.slot !== a.slot) return b.slot - a.slot;
          return b.blockIndex - a.blockIndex;
        });
        resolve(records);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 向后兼容：返回 sig 字符串数组，从旧到新（用于 SignatureManager 初始化）
   * @returns {string[]}
   */
  async loadSignatureList(mint) {
    const records = await this.loadSigsByMint(mint);
    // loadSigsByMint 返回最新在前，reverse得到从旧到新
    return records.reverse().map(r => r.signature);
  }

  /**
   * 获取 mint 最新的 sig（用于增量拉取的 until 参数）
   * @returns {{ signature, slot, blockTime } | null}
   */
  async getLatestSig(mint) {
    const records = await this.loadSigsByMint(mint);
    return records.length > 0 ? records[0] : null; // 第一条=最新
  }

  /**
   * 获取需要补充 tx 详情的 sig 列表（hasData=false）
   */
  async getMissingSigs(mint) {
    const records = await this.loadSigsByMint(mint);
    return records.filter(r => !r.hasData).map(r => r.signature);
  }

  /**
   * 向后兼容：旧接口，保存sig列表（字符串数组，无元数据）
   * 转换为批量写入，slot/blockTime 全为0，后续verify时补充
   */
  async saveSignatureList(mint, sigs) {
    if (!sigs || sigs.length === 0) return;
    const rawSigs = sigs.map(sig => ({ signature: sig, slot: 0, blockTime: 0 }));
    await this.saveSigBatch(mint, rawSigs, 'helius');
  }

  // ─────────────────────────────────────────────────────────
  // transactions store 操作（保持不变）
  // ─────────────────────────────────────────────────────────

  async saveTransaction(signature, mint, txData) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['transactions'], 'readwrite');
      const store = tx.objectStore('transactions');

      const request = store.put({ signature, mint, txData, timestamp: Date.now() });
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.error('[CacheManager] 保存交易失败:', request.error);
        reject(request.error);
      };
    });
  }

  async saveTransactions(transactions, mint) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['transactions'], 'readwrite');
      const store = tx.objectStore('transactions');

      if (transactions.length === 0) { resolve(0); return; }

      tx.oncomplete = () => resolve(transactions.length);
      tx.onerror = () => reject(tx.error);

      transactions.forEach(txData => {
        const sig = txData.transaction?.signatures?.[0];
        if (!sig) return;
        store.put({ signature: sig, mint, txData, timestamp: Date.now() });
      });
    });
  }

  async loadTransactionsBySignatures(signatures) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['transactions'], 'readonly');
      const store = tx.objectStore('transactions');
      const results = [];
      let pending = signatures.length;

      if (pending === 0) { resolve([]); return; }

      tx.onerror = () => reject(tx.error);

      signatures.forEach(sig => {
        const request = store.get(sig);
        request.onsuccess = () => {
          if (request.result) results.push(request.result.txData);
          pending--;
          if (pending === 0) {
            console.log(`[CacheManager] 从缓存加载了 ${results.length}/${signatures.length} 个交易`);
            resolve(results);
          }
        };
        request.onerror = () => {
          pending--;
          if (pending === 0) resolve(results);
        };
      });
    });
  }

  // ─────────────────────────────────────────────────────────
  // users store 操作
  // ─────────────────────────────────────────────────────────

  /**
   * 保存/更新用户数据（upsert）
   * @param {string} address - 用户钱包地址
   * @param {string} mint - 代币地址
   * @param {Object} userData - 用户数据（score/status/manualScore/holderSnapshot等）
   */
  async saveUser(address, mint, userData) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['users'], 'readwrite');
      const store = tx.objectStore('users');

      const getReq = store.get(address);
      getReq.onsuccess = () => {
        const existing = getReq.result || { address, mint, createdAt: Date.now() };
        const record = { ...existing, ...userData, address, mint, lastUpdated: Date.now() };
        store.put(record);
        resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * 批量保存用户数据
   */
  async saveUsers(usersMap, mint) {
    if (!this.db) await this.init();
    const entries = Object.entries(usersMap);
    if (entries.length === 0) return;

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['users'], 'readwrite');
      const store = tx.objectStore('users');

      tx.oncomplete = () => resolve(entries.length);
      tx.onerror = () => reject(tx.error);

      entries.forEach(([address, userData]) => {
        const getReq = store.get(address);
        getReq.onsuccess = () => {
          const existing = getReq.result || { address, mint, createdAt: Date.now() };
          store.put({ ...existing, ...userData, address, mint, lastUpdated: Date.now() });
        };
      });
    });
  }

  /**
   * 加载单个用户数据
   */
  async loadUser(address) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['users'], 'readonly');
      const store = tx.objectStore('users');
      const request = store.get(address);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 按 mint 加载所有用户数据
   */
  async loadUsersByMint(mint) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['users'], 'readonly');
      const store = tx.objectStore('users');
      const index = store.index('mint');
      const request = index.getAll(mint);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 保存手动标记（写入对应用户记录的 manualScore 字段）
   * @param {string} mint
   * @param {Object} scores - { address: status }
   */
  async saveManualScores(mint, scores) {
    if (!this.db) await this.init();
    const entries = Object.entries(scores);
    if (entries.length === 0) return;

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['users'], 'readwrite');
      const store = tx.objectStore('users');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      entries.forEach(([address, status]) => {
        const getReq = store.get(address);
        getReq.onsuccess = () => {
          const existing = getReq.result || { address, mint, createdAt: Date.now() };
          store.put({ ...existing, address, mint, manualScore: status, lastUpdated: Date.now() });
        };
      });
    });
  }

  /**
   * 加载手动标记（从 users 表读取 manualScore 字段）
   * @returns {Object} { address: status }
   */
  async loadManualScores(mint) {
    const users = await this.loadUsersByMint(mint);
    const scores = {};
    users.forEach(u => {
      if (u.manualScore) scores[u.address] = u.manualScore;
    });
    return scores;
  }

  /**
   * 保存隐藏中转检测结果
   */
  async saveHiddenRelayResult(address, mint, result) {
    await this.saveUser(address, mint, {
      hiddenRelay: result.isRelay,
      hiddenRelayConditions: result.conditions,
      hiddenRelayCheckedAt: Date.now()
    });
  }

  /**
   * 批量加载隐藏中转检测结果
   * @returns {Object} { address: { isRelay, conditions, checkedAt } }
   */
  async loadHiddenRelayResults(addresses) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['users'], 'readonly');
      const store = tx.objectStore('users');
      const results = {};
      let pending = addresses.length;

      if (pending === 0) { resolve({}); return; }

      tx.onerror = () => reject(tx.error);

      addresses.forEach(address => {
        const request = store.get(address);
        request.onsuccess = () => {
          const user = request.result;
          if (user && user.hiddenRelayCheckedAt) {
            results[address] = {
              isRelay: user.hiddenRelay,
              conditions: user.hiddenRelayConditions || [],
              checkedAt: user.hiddenRelayCheckedAt
            };
          }
          pending--;
          if (pending === 0) resolve(results);
        };
        request.onerror = () => {
          pending--;
          if (pending === 0) resolve(results);
        };
      });
    });
  }

  // ─────────────────────────────────────────────────────────
  // mint_meta store 操作
  // ─────────────────────────────────────────────────────────

  async saveMintMeta(mint, meta) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['mint_meta'], 'readwrite');
      const store = tx.objectStore('mint_meta');
      const getReq = store.get(mint);
      getReq.onsuccess = () => {
        const existing = getReq.result || { mint, createdAt: Date.now() };
        store.put({ ...existing, ...meta, mint, updatedAt: Date.now() });
        resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async loadMintMeta(mint) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['mint_meta'], 'readonly');
      const store = tx.objectStore('mint_meta');
      const request = store.get(mint);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  // ─────────────────────────────────────────────────────────
  // 清理 / 关闭
  // ─────────────────────────────────────────────────────────

  async cleanup(maxAge = 7 * 24 * 60 * 60 * 1000) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['transactions'], 'readwrite');
      const store = tx.objectStore('transactions');
      const index = store.index('timestamp');
      const cutoffTime = Date.now() - maxAge;
      const range = IDBKeyRange.upperBound(cutoffTime);
      const request = index.openCursor(range);
      let deleted = 0;

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          if (deleted > 0) console.log(`[CacheManager] 清理了 ${deleted} 个旧交易`);
          resolve(deleted);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[CacheManager] 数据库已关闭');
    }
  }
}
