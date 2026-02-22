/**
 * Helius 批量 API 测试 (Node.js 版本)
 * 使用真实的 signatures 测试
 */

const API_KEY = '2304ce34-8d7d-4b15-a6cf-25722d048b45';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// 真实的 signatures
const TEST_SIGNATURES = [
  '4cj4ixhH8QnFJwC32vQP319eBDncqatwHshjFguwko1r2XBSW3VMT6WGebZkrZsXx9iEvsPs9FoJghmoTcfWSCAw',
  '3M64Y74vBSjivaaEsYcYr2GxVZLairXYZUHvtH9nRMKJAW64DXp5kdGGz9nWqudRWaCix511Rra8smssMaWFVBTN',
  '3xGPPxk6xU4Xfb8cP4Jj7q1c3ZsAmf12JuTtuBFAHB3Akt4Qh7DFL6Nk2kqFwkipKq4QxZNPYJKPc2xeg5zuJ4og'
];

async function testBatchAPI() {
  console.log('\n' + '='.repeat(80));
  console.log('Helius 批量 API 测试');
  console.log('='.repeat(80));
  console.log(`测试 Signatures 数量: ${TEST_SIGNATURES.length}`);
  console.log('');

  // 测试 1: 批量获取 (getTransactions)
  console.log('测试 1: 批量获取 (getTransactions)');
  console.log('-'.repeat(80));

  const startBatch = Date.now();
  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransactions',
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
    const durationBatch = Date.now() - startBatch;

    if (data.error) {
      console.log(`✗ 批量获取失败: ${data.error.message}`);
      console.log(`  错误代码: ${data.error.code}`);
      if (data.error.code === -32601) {
        console.log('  ⚠️  getTransactions 方法不存在');
      }
      console.log('');
    } else if (data.result && Array.isArray(data.result)) {
      const successCount = data.result.filter(tx => tx !== null).length;
      console.log(`✓ 批量获取成功!`);
      console.log(`  - 请求数量: ${TEST_SIGNATURES.length}`);
      console.log(`  - 成功: ${successCount}`);
      console.log(`  - 失败: ${TEST_SIGNATURES.length - successCount}`);
      console.log(`  - 耗时: ${durationBatch}ms`);
      console.log(`  - 平均: ${(durationBatch / TEST_SIGNATURES.length).toFixed(1)}ms/笔`);
      console.log('');

      // 显示数据结构
      if (data.result[0]) {
        console.log('数据结构验证:');
        console.log(`  - 包含 transaction: ${!!data.result[0].transaction}`);
        console.log(`  - 包含 meta: ${!!data.result[0].meta}`);
        console.log(`  - 包含 blockTime: ${!!data.result[0].blockTime}`);
        console.log('');
      }

      // 测试 2: 单个获取对比
      console.log('测试 2: 单个获取 (当前方式)');
      console.log('-'.repeat(80));

      const startSingle = Date.now();
      let singleSuccess = 0;

      for (const sig of TEST_SIGNATURES) {
        try {
          const res = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getTransaction',
              params: [
                sig,
                {
                  encoding: "jsonParsed",
                  maxSupportedTransactionVersion: 0,
                  commitment: "confirmed"
                }
              ]
            })
          });
          const d = await res.json();
          if (d.result) singleSuccess++;
        } catch (e) {
          console.error(`  获取失败: ${sig.substring(0, 12)}...`);
        }
      }

      const durationSingle = Date.now() - startSingle;

      console.log(`✓ 单个获取完成`);
      console.log(`  - 请求数量: ${TEST_SIGNATURES.length}`);
      console.log(`  - 成功: ${singleSuccess}`);
      console.log(`  - 耗时: ${durationSingle}ms`);
      console.log(`  - 平均: ${(durationSingle / TEST_SIGNATURES.length).toFixed(1)}ms/笔`);
      console.log('');

      // 性能对比
      console.log('='.repeat(80));
      console.log('性能对比');
      console.log('='.repeat(80));
      console.log(`批量获取: ${durationBatch}ms`);
      console.log(`单个获取: ${durationSingle}ms`);
      console.log(`性能提升: ${(durationSingle / durationBatch).toFixed(2)}x`);
      console.log(`时间节省: ${((durationSingle - durationBatch) / durationSingle * 100).toFixed(1)}%`);
      console.log('');
      console.log('✅ 结论: getTransactions API 可用,建议替换 DataFetcher.js 实现!');
    } else {
      console.log('✗ 返回数据格式异常');
      console.log('返回值:', JSON.stringify(data, null, 2));
    }

  } catch (error) {
    console.error('✗ 测试失败:', error.message);
  }

  console.log('\n' + '='.repeat(80));
}

// 运行测试
testBatchAPI().catch(console.error);
