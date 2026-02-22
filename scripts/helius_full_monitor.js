const WebSocket = require('ws');
const readline = require('readline');
const dataFetcher = require('./helius_core/data_fetcher');
const metricsEngine = require('./helius_core/metrics_engine');

// Default MINT if not provided (fallback)
const DEFAULT_MINT = '9svdK1bjBBuk1tqmeqSHrVSaD6M5wqLEsvFmG9SFpump';
const WSS_URL = `wss://mainnet.helius-rpc.com/?api-key=2304ce34-8d7d-4b15-a6cf-25722d048b45`;

class HeliusMonitor {
    constructor(mintAddress) {
        this.mint = mintAddress;
        this.pendingSigs = new Set();
        this.processedSigs = new Set(); 
        this.ws = null;
        this.pingInterval = null;
        this.isSyncing = false;
        
        // Start immediately
        this.start();
    }

    async start() {
        console.log(`\n--- 启动 Helius 全栈监控系统 ---`);
        console.log(`目标代币 (Mint): ${this.mint}`);
        
        // 1. Start WebSocket Listening
        this.connectWs();

        // 2. Start Full History Sync
        await this.syncHistory();

        // 3. Enter Realtime Processing Loop
        this.startRealtimeProcessor();
        
        // 4. Start Periodic Safety Check
        setInterval(() => this.runSafetyCheck(), 5 * 60 * 1000); 
    }

    connectWs() {
        if (this.ws) {
            try { this.ws.terminate(); } catch (e) {}
        }

        console.log('[WebSocket] 连接中...');
        this.ws = new WebSocket(WSS_URL);

        this.ws.on('open', () => {
            console.log('[WebSocket] 已连接，开始订阅实时日志...');
            const request = {
                jsonrpc: "2.0",
                id: 1,
                method: "logsSubscribe",
                params: [
                    { "mentions": [this.mint] },
                    { "commitment": "confirmed" }
                ]
            };
            this.ws.send(JSON.stringify(request));
            
            this.pingInterval = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
            }, 30000);
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.method === 'logsNotification') {
                    const sig = msg.params.result.value.signature;
                    if (!this.processedSigs.has(sig)) {
                        this.pendingSigs.add(sig);
                    }
                }
            } catch (err) {
                console.error('[WebSocket] 解析错误:', err);
            }
        });

        this.ws.on('close', () => {
            console.log('[WebSocket] 连接断开，3秒后重连...');
            clearInterval(this.pingInterval);
            setTimeout(() => this.connectWs(), 3000);
        });
        
        this.ws.on('error', (err) => {
            console.error('[WebSocket] 错误:', err.message);
        });
    }

    async syncHistory() {
        this.isSyncing = true;
        console.log('[历史] 开始全量同步 (支持本地缓存)...');
        const startTime = performance.now();

        try {
            // 1. Fetch Signatures
            const { allSigs, newSigs, cachedSigs } = await dataFetcher.fetchHistorySigs(this.mint);
            
            // 2. Load Cached Transactions
            if (cachedSigs.length > 0) {
                console.log(`[缓存] 加载 ${cachedSigs.length} 笔历史交易...`);
                const cachedTxs = dataFetcher.loadAllCachedTxs(this.mint);
                cachedTxs.sort((a, b) => a.slot - b.slot);
                
                metricsEngine.processTransactions(cachedTxs, this.mint);
                cachedSigs.forEach(s => this.processedSigs.add(s));
            }
            
            // 3. Fetch New Transactions
            if (newSigs.length > 0) {
                console.log(`[历史] 开始下载 ${newSigs.length} 笔新交易详情...`);
                
                const CHUNK_SIZE = 100;
                for (let i = 0; i < newSigs.length; i += CHUNK_SIZE) {
                    const chunk = newSigs.slice(i, i + CHUNK_SIZE);
                    const parsedTxs = await dataFetcher.fetchParsedTxs(chunk, this.mint);
                    
                    parsedTxs.sort((a, b) => a.slot - b.slot);
                    metricsEngine.processTransactions(parsedTxs, this.mint);
                    
                    chunk.forEach(s => this.processedSigs.add(s));
                    console.log(`[历史同步] 进度: 新增已处理 ${Math.min(i + CHUNK_SIZE, newSigs.length)} / ${newSigs.length}`);
                }
            } else {
                console.log('[历史] 没有新交易需要下载。');
            }
            
            const duration = (performance.now() - startTime) / 1000;
            console.log(`[历史] 同步完成，耗时 ${duration.toFixed(2)}秒。`);
            this.printMetrics();

        } catch (err) {
            console.error('[历史] 同步失败:', err);
        } finally {
            this.isSyncing = false;
        }
    }

    async startRealtimeProcessor() {
        console.log('[实时] 处理器已启动。');
        
        setInterval(async () => {
            if (this.isSyncing) return;
            if (this.pendingSigs.size === 0) return;

            const sigsToFetch = Array.from(this.pendingSigs);
            this.pendingSigs.clear();

            const uniqueSigs = sigsToFetch.filter(s => !this.processedSigs.has(s));
            if (uniqueSigs.length === 0) return;

            console.log(`[实时] 处理 ${uniqueSigs.length} 笔新交易...`);

            try {
                const parsedTxs = await dataFetcher.fetchParsedTxs(uniqueSigs, this.mint);
                metricsEngine.processTransactions(parsedTxs, this.mint);
                
                uniqueSigs.forEach(s => this.processedSigs.add(s));
                
                this.printMetrics();

            } catch (err) {
                console.error('[实时] 处理失败，交易签名已退回队列:', err);
                uniqueSigs.forEach(s => this.pendingSigs.add(s));
            }

        }, 1000); 
    }

    async runSafetyCheck() {
        if (this.isSyncing) return;
        console.log('[安全检查] 运行定期检查...');
        try {
            await dataFetcher.fetchHistorySigs(this.mint, null); 
            console.log(`[安全检查] 队列大小: ${this.pendingSigs.size}, 已处理总数: ${this.processedSigs.size}`);
        } catch (e) {
            console.error('[安全检查] 检查失败', e);
        }
    }

    printMetrics() {
        const m = metricsEngine.getMetrics();
        console.log('\n--- 实时指标更新 ---');
        console.log(`时间: ${new Date().toLocaleTimeString()}`);
        console.log(`价格: ${m.currentPrice.toFixed(9)} SOL`);
        console.log(`1. 已落袋 (已清仓用户): ${m.yiLuDai.toFixed(4)} SOL`);
        console.log(`2. 本轮下注 (当前持有者总买入): ${m.benLunXiaZhu.toFixed(4)} SOL`);
        console.log(`3. 本轮成本 (当前持有者净投入): ${m.benLunChengBen.toFixed(4)} SOL`);
        console.log(`4. 浮盈浮亏: ${m.floatingPnL.toFixed(4)} SOL`);
        console.log(`持有者数: ${m.activeCount}, 已清仓用户数: ${m.exitedCount}`);
        console.log('---------------------------');
    }
}

// Main Entry Point
async function main() {
    const args = process.argv.slice(2);
    let mint = args[0];

    if (!mint) {
        // Interactive Mode
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        mint = await new Promise(resolve => {
            rl.question('请输入要监控的 Mint 地址 (回车使用默认): ', (answer) => {
                rl.close();
                resolve(answer.trim() || DEFAULT_MINT);
            });
        });
    }

    if (!mint) {
        console.error('未提供有效 Mint 地址。');
        process.exit(1);
    }

    new HeliusMonitor(mint);
}

main();
