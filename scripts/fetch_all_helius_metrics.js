const fs = require('fs');
const path = require('path');

const API_KEY = '2304ce34-8d7d-4b15-a6cf-25722d048b45';
const MINT = '9svdK1bjBBuk1tqmeqSHrVSaD6M5wqLEsvFmG9SFpump';
const HELIUS_BASE_API = `https://api.helius.xyz/v0/addresses/${MINT}/transactions?api-key=${API_KEY}`;

// 配置
const CONFIG = {
    maxPages: 1000, // 安全上限，防止无限循环
    pageSize: 100, // Helius 默认似乎是 100，这里不做强制限制，依赖 API 返回
    logInterval: 5 // 每抓取5页打印一次日志
};

async function main() {
    console.log(`Starting Full History Analysis for Mint: ${MINT}`);
    
    // --- 1. Fetch All History ---
    console.log('\n[Phase 1] Fetching all transactions...');
    const fetchStartTime = performance.now();
    
    let allTransactions = [];
    let beforeSignature = null;
    let pageCount = 0;
    let hasMore = true;

    try {
        while (hasMore && pageCount < CONFIG.maxPages) {
            let url = HELIUS_BASE_API;
            if (beforeSignature) {
                url += `&before=${beforeSignature}`;
            }

            const response = await fetch(url);
            if (!response.ok) {
                console.error(`HTTP Error: ${response.status} ${response.statusText}`);
                break;
            }

            const data = await response.json();
            
            if (!data || data.length === 0) {
                hasMore = false;
                break;
            }

            // Filter Errors immediately (Efficiency)
            // Helius Enhanced Tx has 'transactionError' field (null if success)
            // Also check 'err' just in case
            const validTxs = data.filter(tx => !tx.transactionError && !tx.err);
            
            allTransactions.push(...validTxs);
            
            // Pagination
            beforeSignature = data[data.length - 1].signature;
            pageCount++;

            if (pageCount % CONFIG.logInterval === 0) {
                console.log(`  Fetched page ${pageCount}, total valid txs so far: ${allTransactions.length}`);
            }
        }
    } catch (error) {
        console.error('Fetch Error:', error);
    }

    const fetchEndTime = performance.now();
    const fetchDuration = (fetchEndTime - fetchStartTime) / 1000; // seconds
    console.log(`[Phase 1 Complete] Fetched ${allTransactions.length} valid transactions in ${fetchDuration.toFixed(2)}s.`);

    if (allTransactions.length === 0) {
        console.log('No transactions found. Exiting.');
        return;
    }

    // --- 2. Sort & Replay (Genesis -> Now) ---
    console.log('\n[Phase 2] Replaying history (Genesis -> Now)...');
    const calcStartTime = performance.now();

    // Helius returns Newest -> Oldest. We need Oldest -> Newest for accurate replay.
    allTransactions.reverse(); 

    // Trader State
    // { userAddress: { netSolSpent: 0, netTokenReceived: 0, totalBuySol: 0, totalSellSol: 0 } }
    const traderStats = {};

    let currentPrice = 0; // SOL per Token (derived from last swap)

    allTransactions.forEach((tx, index) => {
        const feePayer = tx.feePayer;
        if (!feePayer) return;

        // Parse Balance Changes
        const solAccountData = tx.accountData?.find(a => a.account === feePayer);
        let solChange = solAccountData ? solAccountData.nativeBalanceChange / 1e9 : 0;
        
        let tokenChange = 0;
        if (tx.accountData) {
            for (const accData of tx.accountData) {
                if (accData.tokenBalanceChanges) {
                    const change = accData.tokenBalanceChanges.find(t => t.userAccount === feePayer && t.mint === MINT);
                    if (change && change.rawTokenAmount) {
                        tokenChange = parseFloat(change.rawTokenAmount.tokenAmount) / Math.pow(10, change.rawTokenAmount.decimals);
                        break; 
                    }
                }
            }
        }

        // Determine Action & Update State
        // Buy: SOL < 0, Token > 0
        // Sell: SOL > 0, Token < 0
        
        if (!traderStats[feePayer]) {
            traderStats[feePayer] = { 
                netSolSpent: 0, // Positive means spent (cost), Negative means profit
                netTokenReceived: 0, 
                totalBuySol: 0, 
                totalSellSol: 0 
            };
        }

        const stats = traderStats[feePayer];

        if (solChange < -0.000001 && tokenChange > 0) {
            // BUY
            const cost = Math.abs(solChange);
            stats.netSolSpent += cost;
            stats.totalBuySol += cost;
            stats.netTokenReceived += tokenChange;
            
            // Update Price (Simple Estimate)
            currentPrice = cost / tokenChange;

        } else if (solChange > 0.000001 && tokenChange < 0) {
            // SELL
            const revenue = solChange;
            stats.netSolSpent -= revenue; // Reducing cost (taking profit)
            stats.totalSellSol += revenue;
            stats.netTokenReceived += tokenChange; // tokenChange is negative
            
            // Update Price
            currentPrice = revenue / Math.abs(tokenChange);
        }
    });

    // --- 3. Calculate Final Metrics ---
    
    // Metrics Definitions:
    // 1. 已落袋 (Realized PnL of Exited Users): Users with ~0 token balance. PnL = Total Sell - Total Buy.
    // 2. 本轮下注 (Current Bet): Total Buy SOL of Current Holders.
    // 3. 本轮成本 (Current Cost): Current Bet - Realized PnL (of current holders? or global?).
    //    Actually, standard definition: Cost Basis of Current Holdings.
    //    Let's stick to the user's formula: "本轮成本：等于本轮下注减去已落袋。" (Current Cost = Current Bet - Realized PnL).
    //    Wait, "已落袋" usually means *Exited* users. 
    //    Let's check the doc again: "本轮成本：等于本轮下注减去已落袋。" 
    //    This formula is a bit ambiguous. If "YiLuDai" is only exited users, then cost is just Current Bet?
    //    Usually "Net Cost" = "Total Buy" - "Total Sell" (for current holders).
    //    If "YiLuDai" refers to the *Realized Portion* of current holders, then it makes sense.
    //    Let's calculate:
    //    - Exited Users PnL (Realized)
    //    - Current Holders: Net Cost (Net Sol Spent)
    
    let yiLuDai = 0; // Realized PnL (Sell - Buy) of Exited Users
    let benLunXiaZhu = 0; // Total Buy of Current Holders
    let currentHoldersRealized = 0; // (Sell - Buy) of Current Holders (Partial exits)
    
    let activeHoldersCount = 0;
    let exitedUsersCount = 0;

    Object.values(traderStats).forEach(stats => {
        const isExited = stats.netTokenReceived < 1; // Approx 0 balance (dust)

        if (isExited) {
            // Exited User
            // PnL = Sell - Buy. (If Sell > Buy, PnL > 0)
            const pnl = stats.totalSellSol - stats.totalBuySol;
            yiLuDai += pnl;
            exitedUsersCount++;
        } else {
            // Current Holder
            benLunXiaZhu += stats.totalBuySol;
            // "Realized" part for current holder? 
            // Usually we just track Net Spent.
            // Net Spent = Buy - Sell.
            // If we follow the formula "Cost = Bet - Realized":
            // Realized for a holder is usually 0 until they sell? 
            // If they sold partially, they have realized some PnL.
            // Let's use: 本轮成本 = Current Holders' Net Sol Spent (Total Buy - Total Sell).
            // If the formula forces "Bet - Realized", and Bet is Total Buy.
            // Then "Realized" must be "Total Sell".
            currentHoldersRealized += stats.totalSellSol;
            activeHoldersCount++;
        }
    });

    // Metric Calculations based on interpretation
    // 1. 已落袋 (YiLuDai): Total PnL of Exited Users.
    // 2. 本轮下注 (Current Bet): Total Buy of Current Holders.
    // 3. 本轮成本 (Current Cost): Net Sol Spent by Current Holders (Bet - Sell).
    const benLunChengBen = benLunXiaZhu - currentHoldersRealized; 
    
    // 4. 浮盈浮亏 (Floating PnL): Value - Cost.
    // Value = Current Token Balance * Current Price.
    // Cost = Net Sol Spent.
    // Floating PnL = (Balance * Price) - (Net Sol Spent).
    // Note: If Net Sol Spent is negative (already profited more than cost), PnL is even higher.
    
    // Calculate total floating PnL
    let floatingPnL = 0;
    Object.values(traderStats).forEach(stats => {
        if (stats.netTokenReceived >= 1) { // Holder
            const value = stats.netTokenReceived * currentPrice;
            const cost = stats.netSolSpent;
            floatingPnL += (value - cost);
        }
    });

    const calcEndTime = performance.now();
    const calcDuration = (calcEndTime - calcStartTime) / 1000;

    // --- 4. Report ---
    console.log('\n[Phase 3] Final Report');
    console.log('------------------------------------------------');
    console.log(`API Method: Helius Enhanced Transactions (v0/addresses/${MINT}/transactions)`);
    console.log(`Strategy: Full History Fetch + Genesis Replay`);
    console.log(`Total Valid Transactions: ${allTransactions.length}`);
    console.log(`Time Elapsed: Fetch ${fetchDuration.toFixed(2)}s | Calc ${calcDuration.toFixed(2)}s`);
    console.log('------------------------------------------------');
    console.log(`1. 已落袋 (Realized PnL of Exited): ${yiLuDai.toFixed(4)} SOL`);
    console.log(`   (Count: ${exitedUsersCount} users)`);
    console.log(`2. 本轮下注 (Current Bet / Total Buy of Holders): ${benLunXiaZhu.toFixed(4)} SOL`);
    console.log(`3. 本轮成本 (Current Cost / Net Spent of Holders): ${benLunChengBen.toFixed(4)} SOL`);
    console.log(`4. 浮盈浮亏 (Floating PnL): ${floatingPnL.toFixed(4)} SOL`);
    console.log(`   (Based on last price: ${currentPrice.toFixed(9)} SOL/Token)`);
    console.log('------------------------------------------------');

}

main();
