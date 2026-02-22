/**
 * 测试 JSON-RPC 批量请求
 * 在一个 HTTP 请求中发送多个 getTransaction 调用
 */

const API_KEY = '2304ce34-8d7d-4b15-a6cf-25722d048b45';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const TEST_SIGNATURES = [
  '4cj4ixhH8QnFJwC32vQP319eBDncqatwHshjFguwko1r2XBSW3VMT6WGebZkrZsXx9iEvsPs9FoJghmoTcfWSCAw',
  '3M64Y74vBSjivaaEsYcYr2GxVZLairXYZUHvtH9nRMKJAW64DXp5kdGGz9nWqudRWaCix511Rra8smssMaWFVBTN',
  '3xGPPxk6xU4Xfb8cP4Jj7q1c3ZsAmf12JuTtuBFAHB3Akt4Qh7DFL6Nk2kqFwkipKq4QxZNPYJKPc2xeg5zuJ4og'
];

async function testJSONRPCBatch() {
  console.log('\n' + '='.repeat(80));
  console.log('测试 JSON-RPC 批量请求');
  console.log('='.repeat(80));
  console.log('说明: 在一个 HTTP 请求中发送多个 getTransaction 调用');
  console.log('');

  // 构建批量请求
  const batchRequest = TEST_SIGNATURES.map((sig, index) => ({
    jsonrpc: '2.0',
    id: index + 1,
    method: 'getTransaction',
    params: [
      sig,
      {
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed"
      }
    ]
  }));

  console.log(`构建批量请求: ${TEST_SIGNATURES.length} 个 getTransaction 调用`);
  console.log('');

  const startBatch = Date.now();
  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchRequest)
    });

    const data = await response.json();
    const durationBatch = Date.now() - startBatch;

    if (Array.isArray(data)) {
      const successCount = data.filter(item => item.result !== null && !item.error).length;
      const errorCount = data.filter(item => item.error).length;

      console.log('✓ JSON-RPC 批量请求成功!');
      console.log(`  - 请求数量: ${TEST_SIGNATURES.length}`);
      console.log(`  - 成功: ${successCount}`);
      console.log(`  - 失败: ${errorCount}`);
      console.log(`  - 耗时: ${durationBatch}ms`);
      console.log(`  - 平均: ${(durationBatch / TEST_SIGNATURES.length).toFixed(1)}ms/笔`);
      console.log('');

      // 测试单个请求对比
      console.log('对比: 单个请求 (当前方式)');
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
        } catch (e) {}
      }

      const durationSingle = Date.now() - startSingle;

      console.log(`✓ 单个请求完成`);
      console.log(`  - 请求数量: ${TEST_SIGNATURES.length}`);
      console.log(`  - 成功: ${singleSuccess}`);
      console.log(`  - 耗时: ${durationSingle}ms`);
      console.log(`  - 平均: ${(durationSingle / TEST_SIGNATURES.length).toFixed(1)}ms/笔`);
      console.log('');

      // 性能对比
      console.log('='.repeat(80));
      console.log('性能对比');
      console.log('='.repeat(80));
      console.log(`JSON-RPC 批量: ${durationBatch}ms`);
      console.log(`单个请求: ${durationSingle}ms`);
      console.log(`性能提升: ${(durationSingle / durationBatch).toFixed(2)}x`);
      console.log(`时间节省: ${((durationSingle - durationBatch) / durationSingle * 100).toFixed(1)}%`);
      console.log('');
      console.log('✅ 结论: JSON-RPC 批量请求可用!');
      console.log('建议: 修改 DataFetcher.js 使用 JSON-RPC 批量请求格式');

    } else {
      console.log('✗ 返回数据格式异常');
      console.log('返回值:', JSON.stringify(data, null, 2));
    }

  } catch (error) {
    console.error('✗ 测试失败:', error.message);
  }

  console.log('\n' + '='.repeat(80));
}

testJSONRPCBatch().catch(console.error);
