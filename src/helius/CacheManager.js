/**
 * CacheManager - 基于 IndexedDB 的缓存管理器
 *
 * 功能：
 * 1. 持久化存储交易数据
 * 2. 按 signature 快速查找
 * 3. 按 mint 地址组织数据
 * 4. 自动清理旧数据
 */

export default class CacheManager {
  constructor() {
    this.dbName = 'helius_cache';
    this.dbVersion = 1;
    this.db = null;
  }

  /**
   * 初始化数据库
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.error('[CacheManager] 打开数据库失败:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[CacheManager] 数据库初始化成功');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // 创建 transactions 对象存储（按 signature 键控）
        if (!db.objectStoreNames.contains('transactions')) {
          const txStore = db.createObjectStore('transactions', { keyPath: 'signature' });
          txStore.createIndex('mint', 'mint', { unique: false });
          txStore.createIndex('timestamp', 'timestamp', { unique: false });
          console.log('[CacheManager] 创建 transactions 对象存储');
        }

        // 创建 signatures 对象存储（按 mint 键控，存储 signature 列表）
        if (!db.objectStoreNames.contains('signatures')) {
          const sigStore = db.createObjectStore('signatures', { keyPath: 'mint' });
          sigStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          console.log('[CacheManager] 创建 signatures 对象存储');
        }
      };
    });
  }

  /**
   * 保存交易
   */
  async saveTransaction(signature, mint, txData) {
    if (!this.db) {
      await this.init();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['transactions'], 'readwrite');
      const store = transaction.objectStore('transactions');

      const data = {
        signature,
        mint,
        txData,
        timestamp: Date.now()
      };

      const request = store.put(data);

      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.error('[CacheManager] 保存交易失败:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * 批量保存交易
   */
  async saveTransactions(transactions, mint) {
    if (!this.db) {
      await this.init();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['transactions'], 'readwrite');
      const store = transaction.objectStore('transactions');

      let completed = 0;
      const total = transactions.length;

      transactions.forEach(tx => {
        const sig = tx.transaction?.signatures?.[0];
        if (!sig) return;

        const data = {
          signature: sig,
          mint,
          txData: tx,
          timestamp: Date.now()
        };

        const request = store.put(data);
        request.onsuccess = () => {
          completed++;
          if (completed === total) {
            resolve(completed);
          }
        };
        request.onerror = () => {
          console.error('[CacheManager] 保存交易失败:', request.error);
        };
      });

      if (total === 0) {
        resolve(0);
      }
    });
  }

  /**
   * 按 signatures 加载交易
   */
  async loadTransactionsBySignatures(signatures) {
    if (!this.db) {
      await this.init();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['transactions'], 'readonly');
      const store = transaction.objectStore('transactions');

      const results = [];
      let completed = 0;

      signatures.forEach(sig => {
        const request = store.get(sig);

        request.onsuccess = () => {
          if (request.result) {
            results.push(request.result.txData);
          }
          completed++;

          if (completed === signatures.length) {
            console.log(`[CacheManager] 从缓存加载了 ${results.length}/${signatures.length} 个交易`);
            resolve(results);
          }
        };

        request.onerror = () => {
          completed++;
          if (completed === signatures.length) {
            resolve(results);
          }
        };
      });

      if (signatures.length === 0) {
        resolve([]);
      }
    });
  }

  /**
   * 按 mint 加载所有 signatures
   */
  async loadSignaturesByMint(mint) {
    if (!this.db) {
      await this.init();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['transactions'], 'readonly');
      const store = transaction.objectStore('transactions');
      const index = store.index('mint');

      const request = index.getAll(mint);

      request.onsuccess = () => {
        const signatures = request.result.map(item => item.signature);
        console.log(`[CacheManager] 从缓存加载了 ${signatures.length} 个 signatures (mint: ${mint})`);
        resolve(signatures);
      };

      request.onerror = () => {
        console.error('[CacheManager] 加载 signatures 失败:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * 清理旧数据
   */
  async cleanup(maxAge = 7 * 24 * 60 * 60 * 1000) {  // 默认 7 天
    if (!this.db) {
      await this.init();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['transactions'], 'readwrite');
      const store = transaction.objectStore('transactions');
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
          if (deleted > 0) {
            console.log(`[CacheManager] 清理了 ${deleted} 个旧交易`);
          }
          resolve(deleted);
        }
      };

      request.onerror = () => {
        console.error('[CacheManager] 清理失败:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * 关闭数据库
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[CacheManager] 数据库已关闭');
    }
  }
}
