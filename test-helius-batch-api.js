/**
 * Helius getTransactions API 可行性测试
 *
 * 测试目标：
 * 1. 验证 getTransactions API 是否存在
 * 2. 测试批量获取交易的性能
 * 3. 对比单个获取 vs 批量获取的效率
 */

const API_KEY = '2304ce34-8d7d-4b15-a6cf-25722d048b45';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// 测试用的 signatures（从实际运行中获取）
const TEST_SIGNATURES = [
  '3AaYWkzZ5nrHKnQU1',
  'PYQpZ3NVGMd1nQU1',
  'n51p3RAz8R6wnQU1'
  // 添加更多测试 signatures
];

/**
 * RPC 调用
 */
async function call(method, params) {
  try {
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

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`RPC Error: ${JSON.stringify(data.error)}`);
    }

    return data.result;
  } catch (error) {
    console.error(`[RPC Error] ${method}:`, error.message);
    throw error;
  }
}

/**
 * 测试 1: 单个获取（当前方式）
 */
async function testSingleFetch(signatures) {
  console.log('\n' + '='.repeat(80));
  console.log('测试 1: 单个获取交易（当前方式）');
  console.log('='.repeat(80));

  const startTime = Date.now();
  let successCount = 0;
  let failCount = 0;

  for (const sig of signatures) {
    try {
      const result = await call('getTransaction', [
        sig,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
        }
      ]);

      if (result) {
        successCount++;
        console.log(`✓ 获取成功: ${sig.substring(0, 12)}...`);
      } else {
        failCount++;
        console.log(`✗ 获取失败: ${sig.substring(0, 12)}... (返回 null)`);
      }
    } catch (error) {
      failCount++;
      console.log(`✗ 获取失败: ${sig.substring(0, 12)}... (${error.message})`);
    }

    // 添加延迟避免限流
    await new Promise(r => setTimeout(r, 200));
  }

  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;

  console.log('\n结果统计:');
  console.log(`  - 总数: ${signatures.length}`);
  console.log(`  - 成功: ${successCount}`);
  console.log(`  - 失败: ${failCount}`);
  console.log(`  - 耗时: ${duration.toFixed(2)} 秒`);
  console.log(`  - 平均: ${(duration / signatures.length).toFixed(2)} 秒/笔`);

  return { successCount, failCount, duration };
}

/**
 * 测试 2: 批量获取（getTransactions）
 */
async function testBatchFetch(signatures) {
  console.log('\n' + '='.repeat(80));
  console.log('测试 2: 批量获取交易（getTransactions API）');
  console.log('='.repeat(80));

  const startTime = Date.now();

  try {
    // 尝试使用 getTransactions 方法
    console.log(`尝试批量获取 ${signatures.length} 笔交易...`);

    const result = await call('getTransactions', [
      signatures,
      {
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed"
      }
    ]);

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    if (result && Array.isArray(result)) {
      const successCount = result.filter(tx => tx !== null).length;
      const failCount = result.filter(tx => tx === null).length;

      console.log('\n✓ 批量获取成功！');
      console.log('\n结果统计:');
      console.log(`  - 总数: ${signatures.length}`);
      console.log(`  - 成功: ${successCount}`);
      console.log(`  - 失败: ${failCount}`);
      console.log(`  - 耗时: ${duration.toFixed(2)} 秒`);
      console.log(`  - 平均: ${(duration / signatures.length).toFixed(2)} 秒/笔`);

      // 显示返回的数据结构
      if (result.length > 0 && result[0]) {
        console.log('\n数据结构示例:');
        console.log('  - 包含 transaction 字段:', !!result[0].transaction);
        console.log('  - 包含 meta 字段:', !!result[0].meta);
        console.log('  - 包含 blockTime 字段:', !!result[0].blockTime);
      }

      return { successCount, failCount, duration, supported: true };
    } else {
      console.log('\n✗ 返回数据格式异常');
      console.log('返回值:', result);
      return { successCount: 0, failCount: signatures.length, duration, supported: false };
    }

  } catch (error) {
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    console.log('\n✗ 批量获取失败');
    console.log(`错误信息: ${error.message}`);

    // 检查是否是方法不存在的错误
    if (error.message.includes('Method not found') || error.message.includes('-32601')) {
      console.log('\n⚠️  getTransactions 方法不存在');
      console.log('可能的原因:');
      console.log('  1. Helius 不支持此方法');
      console.log('  2. 方法名称不正确');
      console.log('  3. 需要特殊的 API 权限');
    }

    return { successCount: 0, failCount: signatures.length, duration, supported: false, error: error.message };
  }
}

/**
 * 测试 3: 尝试其他可能的批量方法名
 */
async function testAlternativeMethods(signatures) {
  console.log('\n' + '='.repeat(80));
  console.log('测试 3: 尝试其他可能的批量方法');
  console.log('='.repeat(80));

  const methods = [
    'getMultipleTransactions',
    'getTransactionBatch',
    'batchGetTransaction',
    'getTransactionsBatch'
  ];

  for (const method of methods) {
    console.log(`\n尝试方法: ${method}`);
    try {
      const result = await call(method, [
        signatures,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
        }
      ]);

      console.log(`✓ ${method} 成功！`);
      console.log('返回数据类型:', Array.isArray(result) ? 'Array' : typeof result);
      return { method, supported: true, result };

    } catch (error) {
      if (error.message.includes('Method not found') || error.message.includes('-32601')) {
        console.log(`✗ ${method} 不存在`);
      } else {
        console.log(`✗ ${method} 错误: ${error.message}`);
      }
    }
  }

  return { supported: false };
}

/**
 * 主测试函数
 */
async function runTests() {
  console.log('\n' + '='.repeat(80));
  console.log('Helius getTransactions API 可行性测试');
  console.log('='.repeat(80));
  console.log(`测试时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`API Key: ${API_KEY.substring(0, 8)}...`);
  console.log(`测试 Signatures 数量: ${TEST_SIGNATURES.length}`);

  // 如果没有测试数据，提示用户
  if (TEST_SIGNATURES.length === 0 || TEST_SIGNATURES[0].length < 20) {
    console.log('\n⚠️  警告: 请先添加真实的 signature 数据到 TEST_SIGNATURES 数组');
    console.log('你可以从浏览器控制台的日志中复制 signature');
    return;
  }

  try {
    // 测试 2: 批量获取
    const batchResult = await testBatchFetch(TEST_SIGNATURES);

    if (batchResult.supported) {
      // 如果批量获取成功，进行性能对比
      console.log('\n' + '='.repeat(80));
      console.log('性能对比');
      console.log('='.repeat(80));

      // 测试 1: 单个获取
      const singleResult = await testSingleFetch(TEST_SIGNATURES);

      console.log('\n对比结果:');
      console.log(`  单个获取耗时: ${singleResult.duration.toFixed(2)} 秒`);
      console.log(`  批量获取耗时: ${batchResult.duration.toFixed(2)} 秒`);
      console.log(`  性能提升: ${(singleResult.duration / batchResult.duration).toFixed(2)}x`);
      console.log(`  时间节省: ${((singleResult.duration - batchResult.duration) / singleResult.duration * 100).toFixed(1)}%`);

      console.log('\n✅ 结论: getTransactions API 可用，建议替换！');
    } else {
      // 如果批量获取失败，尝试其他方法
      console.log('\n尝试查找其他批量方法...');
      const altResult = await testAlternativeMethods(TEST_SIGNATURES);

      if (altResult.supported) {
        console.log(`\n✅ 找到可用的批量方法: ${altResult.method}`);
      } else {
        console.log('\n❌ 结论: Helius 不支持批量获取交易，保持当前实现');
      }
    }

  } catch (error) {
    console.error('\n测试过程中发生错误:', error);
  }

  console.log('\n' + '='.repeat(80));
  console.log('测试完成');
  console.log('='.repeat(80));
}

// 如果在 Node.js 环境中运行
if (typeof window === 'undefined') {
  // Node.js 环境需要 node-fetch
  console.log('⚠️  此脚本需要在浏览器环境中运行');
  console.log('请在浏览器控制台中执行此脚本');
} else {
  // 浏览器环境，可以直接运行
  console.log('✓ 浏览器环境检测成功');
  console.log('\n使用方法:');
  console.log('1. 打开浏览器控制台');
  console.log('2. 复制此文件内容到控制台');
  console.log('3. 添加真实的 signature 到 TEST_SIGNATURES 数组');
  console.log('4. 运行 runTests()');
}

// 导出测试函数
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runTests, testBatchFetch, testSingleFetch };
}
