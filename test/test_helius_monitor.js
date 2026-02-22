/**
 * 测试文件 - 使用 token_trades.json 数据测试 HeliusMonitor
 */

import HeliusMonitor from '../src/helius/HeliusMonitor.js';

// 模拟测试
async function testHeliusMonitor() {
  console.log('=== 开始测试 HeliusMonitor ===\n');

  // 使用测试 mint 地址
  const testMint = 'GnVYyqYxo9Y6T3Xd24pN9n8vBWACCYcDhgR5dmJ2hood';

  // 创建监控器
  const monitor = new HeliusMonitor(testMint);

  // 设置指标更新回调
  monitor.onMetricsUpdate = (metrics) => {
    console.log('\n[回调] 指标已更新:');
    console.log(JSON.stringify(metrics, null, 2));
  };

  try {
    // 启动监控
    await monitor.start();

    // 模拟插件数据（从 token_trades.json）
    console.log('\n=== 模拟插件数据输入 ===\n');

    const pluginData = [
      {
        tx_hash: "3Svd8JVjYyz88caKe4fCKBnvArGJmHYcpdySsY67Jw2trU6sMY2obmYSoyDATpn7LHBqkzw6yxZetN4Fewm3Pk9P",
        maker: "45CpoK9N5CZL6rindWuLmTJC4xPAjqLNSaXj9itEDxBH",
        event: "buy",
        base_amount: "1587284.295607",
        quote_amount: "0.044444619",
        timestamp: 1767849010
      },
      {
        tx_hash: "3LP4r1YtqqzgMe8V6LAvncghpRuy6fnP4rduoU4jrFmBZFdisywmqBmDCQSHxcnkrcWowt6K1R21MAxRY5c6qJiq",
        maker: "F9QE1r1A796i4isGGZVjCwrmvYyC9s1q1rcbP9YWpzP4",
        event: "sell",
        base_amount: "288020.020002",
        quote_amount: "0.008054912",
        timestamp: 1767849006
      }
    ];

    // 模拟插件发送 signatures
    for (const trade of pluginData) {
      monitor.signatureManager.addSignature(trade.tx_hash, 'plugin');
      console.log(`[插件] 添加 signature: ${trade.tx_hash.slice(0, 8)}...`);
    }

    // 等待一段时间观察
    console.log('\n等待 5 秒观察实时处理...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 获取最终统计
    const stats = monitor.getStats();
    console.log('\n=== 最终统计 ===');
    console.log(JSON.stringify(stats, null, 2));

    const metrics = monitor.getMetrics();
    console.log('\n=== 最终指标 ===');
    console.log(JSON.stringify(metrics, null, 2));

    // 停止监控
    monitor.stop();

    console.log('\n=== 测试完成 ===');

  } catch (error) {
    console.error('测试失败:', error);
  }
}

// 运行测试
testHeliusMonitor();
