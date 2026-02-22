const fs = require('fs');
const path = require('path');

const API_KEY = '2304ce34-8d7d-4b15-a6cf-25722d048b45';
const MINT = '9svdK1bjBBuk1tqmeqSHrVSaD6M5wqLEsvFmG9SFpump';
const HELIUS_API = `https://api.helius.xyz/v0/addresses/${MINT}/transactions?api-key=${API_KEY}`;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

async function main() {
    console.log(`Starting test for Mint: ${MINT}`);

    // 1. Fetch Transactions
    console.log('Fetching transactions...');
    let transactions = [];
    try {
        const response = await fetch(HELIUS_API); 
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        // Take first 10
        transactions = data.slice(0, 10);
        console.log(`Fetched ${transactions.length} transactions.`);
        
        // Save raw tx data
        const docPath = path.join(__dirname, '../docs');
        if (!fs.existsSync(docPath)) fs.mkdirSync(docPath, { recursive: true });
        
        fs.writeFileSync(path.join(docPath, 'sample_tx.json'), JSON.stringify(transactions, null, 2));
        console.log('Saved sample_tx.json');

    } catch (error) {
        console.error('Error fetching transactions:', error);
    }

    // 2. Fetch Holders (Top 20)
    console.log('Fetching holders...');
    let holders = [];
    try {
        const response = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTokenLargestAccounts',
                params: [MINT]
            })
        });
        const data = await response.json();
        const docPath = path.join(__dirname, '../docs');
        if (data.result && data.result.value) {
            holders = data.result.value;
            console.log(`Fetched ${holders.length} holders.`);
            fs.writeFileSync(path.join(docPath, 'sample_holders.json'), JSON.stringify(holders, null, 2));
            console.log('Saved sample_holders.json');
        } else {
            console.error('Error fetching holders:', data);
        }
    } catch (error) {
        console.error('Error fetching holders:', error);
    }

    // 3. Calculate Metrics (Simple Analysis)
    console.log('\n--- Metrics Calculation Analysis (Based on 10 txs) ---');
    console.log('注意: 由于仅有10条数据，以下计算仅为演示逻辑，数值不代表真实盈亏。');
    
    // We will parse the transactions to find Swaps and calculate volume
    let totalBuyVolumeSOL = 0;
    let totalSellVolumeSOL = 0;
    let uniqueTraders = new Set();
    const traderStats = {}; // { user: { buySol: 0, sellSol: 0, netSol: 0, tokenChange: 0 } }

    transactions.forEach((tx, index) => {
        // Helius Enhanced Tx structure parsing
        const feePayer = tx.feePayer;
        if (!feePayer) return;

        // Find the SOL balance change for the fee payer (trader)
        const solAccountData = tx.accountData?.find(a => a.account === feePayer);
        let solChange = solAccountData ? solAccountData.nativeBalanceChange / 1e9 : 0;
        
        let tokenChange = 0;
        
        // Find token balance change for the fee payer and MINT
        // Iterate all accountData entries to find tokenBalanceChanges
        if (tx.accountData) {
            for (const accData of tx.accountData) {
                if (accData.tokenBalanceChanges) {
                    const change = accData.tokenBalanceChanges.find(t => t.userAccount === feePayer && t.mint === MINT);
                    if (change && change.rawTokenAmount) {
                        // Calculate change based on rawTokenAmount? 
                        // Wait, Helius 'tokenBalanceChanges' usually shows the *Balance*, not the *Change*?
                        // No, the field name is 'tokenBalanceChanges', but Helius usually returns Pre/Post token balances in 'meta'. 
                        // Enhanced Tx 'accountData' structure says 'tokenBalanceChanges'.
                        // Let's check the sample data.
                        // Line 103: "rawTokenAmount": { "tokenAmount": "1559534591978", "decimals": 6 }
                        // Is this the *Change* or the *New Balance*?
                        // "tokenTransfers" (Line 17) shows "tokenAmount": 109995.669.
                        // "accountData" (Line 103) shows "1559534591978" (1.5M).
                        // If transfer was 1.5M, and balance change shows 1.5M, it might be the change.
                        // Let's assume it is the change (signed?). 
                        // Wait, in sample data Line 124, tokenAmount is "-109995669422729". Negative!
                        // So it IS the change.
                        
                        tokenChange = parseFloat(change.rawTokenAmount.tokenAmount) / Math.pow(10, change.rawTokenAmount.decimals);
                        break; // Assume only one token account per mint per user usually
                    }
                }
            }
        }

        // Determine Action
        // BUY: SOL decreased (negative change), Token increased (positive change)
        // SELL: SOL increased (positive change), Token decreased (negative change)
        
        if (solChange < -0.001 && tokenChange > 0) {
            action = 'BUY';
            const cost = Math.abs(solChange); // Including fees
            totalBuyVolumeSOL += cost;
            
            if (!traderStats[feePayer]) traderStats[feePayer] = { buySol: 0, sellSol: 0, tokenBalance: 0 };
            traderStats[feePayer].buySol += cost;
            traderStats[feePayer].tokenBalance += tokenChange;

        } else if (solChange > 0.001 && tokenChange < 0) {
            action = 'SELL';
            const revenue = solChange; // Net received
            totalSellVolumeSOL += revenue;

            if (!traderStats[feePayer]) traderStats[feePayer] = { buySol: 0, sellSol: 0, tokenBalance: 0 };
            traderStats[feePayer].sellSol += revenue;
            traderStats[feePayer].tokenBalance += tokenChange; // tokenChange is negative
        }

        if (action !== 'UNKNOWN') {
            uniqueTraders.add(feePayer);
            const timeStr = new Date(tx.timestamp * 1000).toLocaleString();
            console.log(`[Tx ${index + 1}] ${timeStr} | Hash: ${tx.signature}`);
            console.log(`    Type: ${tx.type}, Action: ${action}, Trader: ${feePayer.slice(0,6)}...`);
            console.log(`    SOL Change: ${solChange.toFixed(4)}, Token Change: ${tokenChange.toFixed(2)}`);
        }
    });

    console.log('\n--- Summary ---');
    console.log(`Total Buy Volume (SOL): ${totalBuyVolumeSOL.toFixed(4)}`);
    console.log(`Total Sell Volume (SOL): ${totalSellVolumeSOL.toFixed(4)}`);
    console.log(`Active Traders (in sample): ${uniqueTraders.size}`);
    
    // Calculate Metrics
    // 1. Realized PnL (YiLuDai): Only for users who have 0 token balance (Exited)
    // 2. Current Bet (BenLunXiaZhu): Total Buy SOL of current holders
    
    let realizedPnL = 0;
    let currentBet = 0;
    let realizedPnL_CurrentHolders = 0; // For Cost calculation

    Object.entries(traderStats).forEach(([user, stats]) => {
        // Since we only have 10 txs, tokenBalance might not be 0 even if they exited before.
        // We assume tokenBalance close to 0 is exited.
        const isExited = Math.abs(stats.tokenBalance) < 1; 

        if (isExited) {
            // Realized PnL = Sell SOL - Buy SOL
            realizedPnL += (stats.sellSol - stats.buySol);
        } else {
            // Current Holder
            currentBet += stats.buySol;
            realizedPnL_CurrentHolders += (stats.sellSol - stats.buySol);
        }
    });

    // 3. Current Cost (BenLunChengBen) = Current Bet - Realized (of everyone? Or current holders?)
    // Doc says: "Realized PnL calculation is sum of all users... sell minus buy... equals Realized PnL"
    // "Current Cost = Current Bet - Realized PnL" -> This implies Realized PnL is a global number?
    // "Realized PnL is ... all users including exited users ... their total Sell - Total Buy"
    // Wait, if Realized PnL is (Sell - Buy), and Current Bet is (Current Holders Buy).
    // Current Cost = Current Bet - Realized PnL?
    // If Realized PnL is positive (Profit), then Cost is reduced?
    // Let's follow the formula:
    // Metric 1: Realized PnL (YiLuDai) = Sum(Sell - Buy) for ALL users? Or just Exited?
    // Doc: "XiaoSaoBa: users who sold all... Realized PnL calculation is firstly all users, including exited users, their total sell minus total buy..."
    // Wait, "Total Sell - Total Buy" for ALL users is the Net Inflow of the system (which is 0 if we ignore fees and dev mint).
    // Actually, usually "Realized PnL" refers to closed positions.
    // Let's stick to: Realized PnL = Sum(Sell - Buy) for Exited Users (XiaoSaoBa).
    
    // Re-reading doc: "Realized PnL... includes exited users... their total sell minus total buy... equals Realized PnL"
    // It seems "YiLuDai" = Sum(Sell - Buy) of ALL users?
    // No, that would be "Total Net Inflow".
    // Let's assume "YiLuDai" is (Sell - Buy) of Exited Users.
    
    // Metric 3: Current Cost = Current Bet - YiLuDai.
    
    const yiLuDai = realizedPnL; // (Sell - Buy) of exited users.
    const benLunChengBen = currentBet - yiLuDai; 

    // Metric 4: Floating PnL (FuYingFuKui)
    // "Exclude XiaoSaoBa (Exited), Net Inflow Sum's Negative"
    // Net Inflow of Current Holders = (Sell - Buy).
    // Floating PnL = - (Net Inflow of Current Holders) = Buy - Sell (of current holders).
    // Wait, Floating PnL usually implies (Current Value - Cost).
    // If "Net Inflow Sum's Negative", then if I bought 100 (Inflow -100), Negative is 100.
    // So Floating PnL = Total Buy (of current holders) - Total Sell (of current holders)?
    // This equals "Net Investment".
    // Doc says: "Example: buy 100, sell 120, profit 20. I calculate sum of this 20... excluding XiaoSaoBa".
    // If I hold, Buy 100, Sell 0. Profit is (Value - 100).
    // If I hold, Buy 100, Sell 50. Cost 50. Value ?
    
    // Let's output the raw stats for now.
    
    console.log('\n--- Calculated Metrics (Demo) ---');
    console.log(`1. 已落袋 (Realized PnL): ${yiLuDai.toFixed(4)} SOL (已清仓用户的净盈亏)`);
    console.log(`2. 本轮下注 (Current Bet): ${currentBet.toFixed(4)} SOL (当前持有者的总买入)`);
    console.log(`3. 本轮成本 (Current Cost): ${benLunChengBen.toFixed(4)} SOL (本轮下注 - 已落袋)`);
    console.log(`4. 浮盈浮亏 (Floating PnL): 需结合当前价格计算持仓价值。`);
    console.log(`   当前持有者净投入 (Net Investment): ${(currentBet - (realizedPnL_CurrentHolders + currentBet)).toFixed(4)} SOL (Buy - Sell of current holders)`);
}

main();
