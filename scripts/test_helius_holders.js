const fs = require('fs');
const path = require('path');

const API_KEY = '2304ce34-8d7d-4b15-a6cf-25722d048b45';
const MINT = '9svdK1bjBBuk1tqmeqSHrVSaD6M5wqLEsvFmG9SFpump';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

async function main() {
    console.log(`Starting Holders Test for Mint: ${MINT}`);
    console.log('Fetching Top 20 Token Accounts...');

    try {
        // 1. Get Largest Accounts (Token Accounts)
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
        if (!data.result || !data.result.value) {
            throw new Error('Failed to get token accounts: ' + JSON.stringify(data));
        }

        const tokenAccounts = data.result.value.slice(0, 20); // Top 20
        console.log(`Found ${tokenAccounts.length} largest token accounts.`);

        // 2. Fetch Account Info to get Owners (Batch request)
        // We need to call getMultipleAccounts on the 'address' (which is the Token Account Address)
        // The data returned will be the SPL Token Account data (binary/base64).
        // We need to parse it to find the 'owner' field.
        // Or simpler: use Helius parsed encoding if supported, but getMultipleAccounts supports jsonParsed.
        
        const accountAddresses = tokenAccounts.map(t => t.address);
        
        console.log('Fetching Account Info to resolve Owners...');
        const accountsResponse = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'getMultipleAccounts',
                params: [
                    accountAddresses,
                    { encoding: "jsonParsed" } // Request parsed JSON to get the 'owner' field easily
                ]
            })
        });

        const accountsData = await accountsResponse.json();
        if (!accountsData.result || !accountsData.result.value) {
            throw new Error('Failed to get account info: ' + JSON.stringify(accountsData));
        }

        const accountInfos = accountsData.result.value;
        
        // 3. Merge and Display
        console.log('\n--- Top Holders (Detailed) ---');
        console.log('Rank | Token Account | Owner (Wallet) | Amount | % (Approx)');
        console.log('-'.repeat(80));

        const detailedHolders = [];

        tokenAccounts.forEach((tAccount, index) => {
            const info = accountInfos[index];
            let owner = 'Unknown';
            let state = 'Unknown';
            
            if (info && info.data && info.data.parsed && info.data.parsed.info) {
                owner = info.data.parsed.info.owner;
                state = info.data.parsed.info.state;
            }

            const holderData = {
                rank: index + 1,
                tokenAccount: tAccount.address,
                owner: owner,
                amount: tAccount.uiAmountString,
                state: state
            };
            detailedHolders.push(holderData);

            console.log(`#${holderData.rank.toString().padEnd(3)} | ${holderData.tokenAccount.slice(0, 8)}... | ${holderData.owner} | ${parseFloat(holderData.amount).toLocaleString()} | ${state}`);
        });

        // Save to file
        const docPath = path.join(__dirname, '../docs');
        if (!fs.existsSync(docPath)) fs.mkdirSync(docPath, { recursive: true });
        
        fs.writeFileSync(path.join(docPath, 'detailed_holders.json'), JSON.stringify(detailedHolders, null, 2));
        console.log(`\nSaved detailed holder info to ${path.join(docPath, 'detailed_holders.json')}`);

    } catch (error) {
        console.error('Error:', error);
    }
}

main();
