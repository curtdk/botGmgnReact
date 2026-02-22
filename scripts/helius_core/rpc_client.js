const API_KEY = '2304ce34-8d7d-4b15-a6cf-25722d048b45';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

class RpcClient {
    constructor() {
        this.totalCreditsUsed = 0;
    }

    async call(method, params) {
        let retries = 3;
        let delay = 1000;

        while (retries > 0) {
            try {
                const startTime = performance.now();
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
                    delay *= 2; // Exponential backoff
                    retries--;
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();
                
                if (data.error) {
                    if (data.error.code === -32429) { // JSON-RPC specific rate limit code
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
                // If it's a network error, retry
                console.warn(`[RPC] 网络错误: ${error.message}. 正在重试...`);
                await new Promise(r => setTimeout(r, delay));
                delay *= 2;
                retries--;
            }
        }
    }
}

module.exports = new RpcClient();
