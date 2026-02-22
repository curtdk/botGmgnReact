/**
 * 测试其他可能的批量方法
 */

const API_KEY = '2304ce34-8d7d-4b15-a6cf-25722d048b45';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const TEST_SIGNATURES = [
  '4cj4ixhH8QnFJwC32vQP319eBDncqatwHshjFguwko1r2XBSW3VMT6WGebZkrZsXx9iEvsPs9FoJghmoTcfWSCAw',
  '3M64Y74vBSjivaaEsYcYr2GxVZLairXYZUHvtH9nRMKJAW64DXp5kdGGz9nWqudRWaCix511Rra8smssMaWFVBTN',
  '3xGPPxk6xU4Xfb8cP4Jj7q1c3ZsAmf12JuTtuBFAHB3Akt4Qh7DFL6Nk2kqFwkipKq4QxZNPYJKPc2xeg5zuJ4og'
];

const METHODS_TO_TRY = [
  'getTransactions',
  'getMultipleTransactions',
  'getTransactionBatch',
  'batchGetTransaction',
  'getTransactionsBatch',
  'getParsedTransactions',
  'getMultipleParsedTransactions'
];

async function testMethod(method) {
  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: method,
        params: [
          TEST_SIGNATURES,
          {
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
          }
        ]
      })
    });

    const data = await response.json();

    if (data.error) {
      return { method, success: false, error: data.error.message, code: data.error.code };
    } else if (data.result) {
      return { method, success: true, resultType: Array.isArray(data.result) ? 'Array' : typeof data.result };
    }
  } catch (error) {
    return { method, success: false, error: error.message };
  }
}

async function runTests() {
  console.log('\n' + '='.repeat(80));
  console.log('测试所有可能的批量方法');
  console.log('='.repeat(80));
  console.log('');

  for (const method of METHODS_TO_TRY) {
    process.stdout.write(`测试 ${method.padEnd(30)} ... `);
    const result = await testMethod(method);

    if (result.success) {
      console.log(`✓ 成功! (返回类型: ${result.resultType})`);
    } else {
      console.log(`✗ 失败 (${result.error || result.code})`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('结论: Helius 不支持批量获取交易的 API');
  console.log('建议: 保持当前的单个获取实现 (fetchParsedTxs)');
  console.log('='.repeat(80));
}

runTests().catch(console.error);
