/**
 * 快速测试 Helius 批量 API
 * 直接在浏览器控制台运行此代码
 */

(async function testHeliusBatchAPI() {
  console.log('\n' + '='.repeat(80));
  console.log('Helius 批量 API 快速测试');
  console.log('='.repeat(80));

  // 1. 获取当前监控的 signatures
  const monitor = window.heliusIntegration?.monitor;
  if (!monitor) {
    console.error('❌ HeliusMonitor 未运行,请先启动监控');
    return;
  }

  const allSigs = Array.from(monitor.signatureManager?.signatures?.keys() || []);
  if (allSigs.length === 0) {
    console.error('❌ 没有找到 signatures');
    return;
  }

  // 取前10个进行测试
  const testSigs = allSigs.slice(0, 10);
  console.log(`\n✓ 获取到 ${allSigs.length} 个 signatures,使用前 ${testSigs.length} 个进行测试\n`);

  const API_KEY = '2304ce34-8d7d-4b15-a6cf-25722d048b45';
  const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

  // 2. 测试批量获取
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
          testSigs,
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
      if (data.error.code === -32601) {
        console.log('⚠️  getTransactions 方法不存在');
      }
    } else if (data.result && Array.isArray(data.result)) {
      const successCount = data.result.filter(tx => tx !== null).length;
      console.log(`✓ 批量获取成功!`);
      console.log(`  - 请求数量: ${testSigs.length}`);
      console.log(`  - 成功: ${successCount}`);
      console.log(`  - 失败: ${testSigs.length - successCount}`);
      console.log(`  - 耗时: ${durationBatch}ms`);
      console.log(`  - 平均: ${(durationBatch / testSigs.length).toFixed(1)}ms/笔`);

      // 3. 对比单个获取
      console.log('\n测试 2: 单个获取 (当前方式)');
      console.log('-'.repeat(80));

      const startSingle = Date.now();
      let singleSuccess = 0;

      for (const sig of testSigs) {
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

      console.log(`✓ 单个获取完成`);
      console.log(`  - 请求数量: ${testSigs.length}`);
      console.log(`  - 成功: ${singleSuccess}`);
      console.log(`  - 耗时: ${durationSingle}ms`);
      console.log(`  - 平均: ${(durationSingle / testSigs.length).toFixed(1)}ms/笔`);

      // 4. 性能对比
      console.log('\n' + '='.repeat(80));
      console.log('性能对比');
      console.log('='.repeat(80));
      console.log(`批量获取: ${durationBatch}ms`);
      console.log(`单个获取: ${durationSingle}ms`);
      console.log(`性能提升: ${(durationSingle / durationBatch).toFixed(2)}x`);
      console.log(`时间节省: ${((durationSingle - durationBatch) / durationSingle * 100).toFixed(1)}%`);
      console.log('\n✅ 结论: getTransactions API 可用,建议替换!');
    }

  } catch (error) {
    console.error('✗ 测试失败:', error.message);
  }

  console.log('\n' + '='.repeat(80));
})();
