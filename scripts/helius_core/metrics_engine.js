class MetricsEngine {
    constructor() {
        this.reset();
    }

    reset() {
        // user: { netSolSpent: 0, netTokenReceived: 0, totalBuySol: 0, totalSellSol: 0 }
        this.traderStats = {};
        this.currentPrice = 0;
        this.lastProcessedSig = null;
        this.processedCount = 0;
    }

    /**
     * Process a list of parsed transactions (Oldest -> Newest)
     * @param {Array} transactions 
     * @param {string} mintAddress 
     */
    processTransactions(transactions, mintAddress) {
        transactions.forEach(tx => {
            if (!tx || !tx.transaction) return;
            
            // getParsedTransaction structure:
            // { slot, transaction: { signatures: [...], message: { accountKeys: [...], instructions: [...] } }, meta: { ... } }
            // We need 'meta' for balance changes.

            const meta = tx.meta;
            if (!meta) return;
            if (meta.err) return; // Skip failed txs (double check)

            const signature = tx.transaction.signatures[0];
            const feePayer = tx.transaction.message.accountKeys[0].pubkey; // Parsed format puts pubkey in object

            // 1. Parse SOL Change for Fee Payer
            // preBalances vs postBalances.
            // Index 0 is fee payer.
            const preSol = meta.preBalances[0];
            const postSol = meta.postBalances[0];
            const solChange = (postSol - preSol) / 1e9;

            // 2. Parse Token Change
            // meta.preTokenBalances and meta.postTokenBalances
            // We need to find the change for the fee payer (owner) and the specific Mint.
            
            let preToken = 0;
            let postToken = 0;

            // Helper to find balance
            const findBal = (balances) => {
                const b = balances.find(b => b.owner === feePayer && b.mint === mintAddress);
                return b ? b.uiTokenAmount.uiAmount || 0 : 0;
            };

            if (meta.preTokenBalances) preToken = findBal(meta.preTokenBalances);
            if (meta.postTokenBalances) postToken = findBal(meta.postTokenBalances);
            
            const tokenChange = postToken - preToken;

            // 3. Update State
            this.updateTraderState(feePayer, solChange, tokenChange);
            
            // 4. Update Price (Estimate from Swap)
            if (tokenChange !== 0 && Math.abs(solChange) > 0.000001) {
                this.currentPrice = Math.abs(solChange) / Math.abs(tokenChange);
            }

            this.lastProcessedSig = signature;
            this.processedCount++;
        });
    }

    updateTraderState(user, solChange, tokenChange) {
        if (!this.traderStats[user]) {
            this.traderStats[user] = { netSolSpent: 0, netTokenReceived: 0, totalBuySol: 0, totalSellSol: 0 };
        }
        const stats = this.traderStats[user];

        // Buy: SOL decreases (negative change), Token increases
        if (solChange < -0.000001 && tokenChange > 0) {
            const cost = Math.abs(solChange);
            stats.netSolSpent += cost;
            stats.totalBuySol += cost;
            stats.netTokenReceived += tokenChange;
        } 
        // Sell: SOL increases, Token decreases
        else if (solChange > 0.000001 && tokenChange < 0) {
            const revenue = solChange;
            stats.netSolSpent -= revenue;
            stats.totalSellSol += revenue;
            stats.netTokenReceived += tokenChange;
        }
    }

    getMetrics() {
        let yiLuDai = 0; // Realized PnL (Exited)
        let benLunXiaZhu = 0; // Current Bet (Holders Buy)
        let currentHoldersRealized = 0;
        let floatingPnL = 0;
        let exitedCount = 0;
        let activeCount = 0;

        Object.values(this.traderStats).forEach(stats => {
            const isExited = stats.netTokenReceived < 1; // Approx 0

            if (isExited) {
                yiLuDai += (stats.totalSellSol - stats.totalBuySol);
                exitedCount++;
            } else {
                benLunXiaZhu += stats.totalBuySol;
                currentHoldersRealized += stats.totalSellSol;
                activeCount++;
                
                // Floating PnL = Value - Cost
                const value = stats.netTokenReceived * this.currentPrice;
                const cost = stats.netSolSpent;
                floatingPnL += (value - cost);
            }
        });

        const benLunChengBen = benLunXiaZhu - currentHoldersRealized;

        return {
            yiLuDai,
            benLunXiaZhu,
            benLunChengBen,
            floatingPnL,
            currentPrice: this.currentPrice,
            activeCount,
            exitedCount,
            totalProcessed: this.processedCount
        };
    }
}

module.exports = new MetricsEngine();
