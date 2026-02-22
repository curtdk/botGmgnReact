const fs = require('fs');
const path = require('path');
const rpc = require('./rpc_client');

// 缓存目录配置
const CACHE_DIR = path.join(__dirname, '../../data/cache');

class DataFetcher {
    constructor() {
        // Ensure cache directory exists
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
    }

    _getMintCacheDir(address) {
        const dir = path.join(CACHE_DIR, address);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    _loadCachedSignatures(address) {
        const filePath = path.join(this._getMintCacheDir(address), 'signatures.json');
        if (fs.existsSync(filePath)) {
            try {
                return JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                console.error('[缓存] 读取签名缓存失败:', e);
            }
        }
        return [];
    }

    _saveCachedSignatures(address, signatures) {
        const filePath = path.join(this._getMintCacheDir(address), 'signatures.json');
        fs.writeFileSync(filePath, JSON.stringify(signatures));
    }

    _loadCachedTransactions(address) {
        const filePath = path.join(this._getMintCacheDir(address), 'transactions.jsonl');
        const txs = [];
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                content.split('\n').forEach(line => {
                    if (line.trim()) txs.push(JSON.parse(line));
                });
            } catch (e) {
                console.error('[缓存] 读取交易缓存失败:', e);
            }
        }
        return txs;
    }

    _appendCachedTransaction(address, tx) {
        const filePath = path.join(this._getMintCacheDir(address), 'transactions.jsonl');
        fs.appendFileSync(filePath, JSON.stringify(tx) + '\n');
    }

    /**
     * Fetch all transaction signatures for an address (Mint)
     * Uses local cache + incremental fetch.
     * @param {string} address - Mint address
     */
    async fetchHistorySigs(address) {
        console.log(`[历史] 正在获取交易签名列表 (${address})...`);
        
        // 1. Load Cache
        let cachedSigs = this._loadCachedSignatures(address);
        // Cached sigs are usually Oldest -> Newest (based on our reverse logic)
        // But Helius API returns Newest -> Oldest.
        // We need the "Newest" cached signature to use as 'until' (stop point).
        
        let untilSig = null;
        if (cachedSigs.length > 0) {
            // Assume cachedSigs is sorted Oldest -> Newest (index 0 is Genesis)
            // The last element is the newest processed signature.
            untilSig = cachedSigs[cachedSigs.length - 1];
            console.log(`[缓存] 发现本地缓存 ${cachedSigs.length} 条签名。将增量拉取 (直到: ${untilSig.slice(0,8)}...)`);
        }

        // 2. Fetch New Signatures
        let newSigs = [];
        let before = null;
        let hasMore = true;
        let pageCount = 0;

        while (hasMore) {
            const params = [
                address,
                {
                    limit: 1000, 
                    before: before
                }
            ];
            
            if (untilSig) params[1].until = untilSig;

            const sigs = await rpc.call('getSignaturesForAddress', params);

            if (!sigs || sigs.length === 0) {
                hasMore = false;
                break;
            }

            const successSigs = sigs.filter(s => !s.err).map(s => s.signature);
            newSigs.push(...successSigs);
            
            before = sigs[sigs.length - 1].signature;
            pageCount++;
            
            // If we hit the 'until' sig, the API stops returning automatically? 
            // Yes, Helius/Solana 'until' param works this way.
            
            if (pageCount % 5 === 0) console.log(`  [增量] 已获取 ${pageCount} 页新签名...`);
            if (sigs.length < 1000) hasMore = false; 
        }

        console.log(`[历史] 增量获取新签名: ${newSigs.length} 条`);
        
        // 3. Merge Cache
        // newSigs is Newest -> Oldest. Reverse it to match Cache (Oldest -> Newest).
        newSigs.reverse();
        
        const allSigs = [...cachedSigs, ...newSigs];
        
        // Save updated cache
        if (newSigs.length > 0) {
            this._saveCachedSignatures(address, allSigs);
            console.log(`[缓存] 签名列表已更新，总数: ${allSigs.length}`);
        }

        return { allSigs, newSigs, cachedSigs };
    }

    /**
     * Batch fetch parsed transactions with caching support
     * @param {string[]} signatures - Array of signatures to fetch
     * @param {string} mintAddress - For cache path
     */
    async fetchParsedTxs(signatures, mintAddress) {
        // Helius Free Tier does NOT support Batch Requests (Error -32403).
        const CONCURRENCY = 5; 
        let allTxs = [];
        
        for (let i = 0; i < signatures.length; i += CONCURRENCY) {
            const batchSigs = signatures.slice(i, i + CONCURRENCY);
            
            const promises = batchSigs.map(async (sig) => {
                try {
                    const result = await require('./rpc_client').call('getTransaction', [
                        sig,
                        { 
                            encoding: "jsonParsed", 
                            maxSupportedTransactionVersion: 0,
                            commitment: "confirmed"
                        }
                    ]);
                    
                    if (result && mintAddress) {
                        // Cache the fetched transaction immediately
                        this._appendCachedTransaction(mintAddress, result);
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
            
            await new Promise(r => setTimeout(r, 200));
        }
        
        return allTxs;
    }
    
    // Helper to load all cached txs for initialization
    loadAllCachedTxs(address) {
        return this._loadCachedTransactions(address);
    }
}

module.exports = new DataFetcher();
