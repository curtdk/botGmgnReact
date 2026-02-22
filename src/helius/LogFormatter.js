/**
 * LogFormatter - 统一的日志格式化工具
 *
 * 提供结构化、层次化的日志输出格式
 */

class LogFormatter {
  constructor() {
    this.phaseCounter = 0;
    this.transactionCounter = 0;
  }

  /**
   * 重置计数器
   */
  reset() {
    this.phaseCounter = 0;
    this.transactionCounter = 0;
  }

  /**
   * 阶段开始
   */
  phaseStart(phaseName, details = {}) {
    this.phaseCounter++;
    const phaseNum = this.phaseCounter;

    console.log('\n' + '='.repeat(100));
    console.log(`[阶段 ${phaseNum}] ${phaseName}`);
    console.log('='.repeat(100));

    if (Object.keys(details).length > 0) {
      console.log('📊 阶段信息:');
      Object.entries(details).forEach(([key, value]) => {
        console.log(`   - ${key}: ${value}`);
      });
      console.log('');
    }

    return phaseNum;
  }

  /**
   * 阶段结束
   */
  phaseEnd(phaseName, summary = {}) {
    console.log('\n' + '='.repeat(100));
    console.log(`[阶段 ${this.phaseCounter}] ${phaseName} - 完成`);
    console.log('='.repeat(100));

    if (Object.keys(summary).length > 0) {
      console.log('📈 阶段总结:');
      Object.entries(summary).forEach(([key, value]) => {
        console.log(`   ✓ ${key}: ${value}`);
      });
    }
    console.log('');
  }

  /**
   * 交易处理开始
   */
  transactionStart(txInfo) {
    this.transactionCounter++;
    const { signature, timestamp, total, current } = txInfo;

    console.log('\n' + '-'.repeat(100));
    console.log(`[交易 ${current}/${total}] 处理中...`);
    console.log('-'.repeat(100));
    console.log(`   📝 Signature: ${signature.substring(0, 12)}...${signature.substring(signature.length - 8)}`);
    console.log(`   ⏰ 时间: ${timestamp || '未知'}`);
  }

  /**
   * 用户操作日志
   */
  userAction(userInfo) {
    const { address, isNew, action, solChange, tokenChange, source } = userInfo;
    const shortAddr = `${address.slice(0, 8)}...${address.slice(-8)}`;

    console.log(`   👤 用户: ${shortAddr}`);
    if (isNew) {
      console.log(`   ✨ 状态: 新用户`);
    }
    console.log(`   📊 操作: ${action}`);
    console.log(`   💰 SOL变化: ${solChange >= 0 ? '+' : ''}${solChange.toFixed(6)} SOL`);
    console.log(`   🪙 Token变化: ${tokenChange >= 0 ? '+' : ''}${tokenChange.toFixed(2)} Token`);
    if (source) {
      console.log(`   📍 数据来源: ${source}`);
    }
  }

  /**
   * 用户状态更新
   */
  userStateUpdate(stateInfo) {
    const { address, totalBuy, totalSell, tokenBalance, netCost, status, pnl } = stateInfo;

    console.log(`\n   📋 用户状态更新:`);
    console.log(`   ├─ 累计买入: ${totalBuy.toFixed(6)} SOL`);
    console.log(`   ├─ 累计卖出: ${totalSell.toFixed(6)} SOL`);
    console.log(`   ├─ 持有代币: ${tokenBalance.toFixed(2)} Token`);
    console.log(`   ├─ 净成本: ${netCost.toFixed(6)} SOL`);

    if (status === 'exited') {
      console.log(`   └─ 状态: 已退出 ❌ (实现盈亏: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL)`);
    } else {
      console.log(`   └─ 状态: 持有中 ✓`);
    }
  }

  /**
   * 数据源统计
   */
  dataSourceSummary(sources) {
    console.log('\n📊 数据源统计:');
    Object.entries(sources).forEach(([source, count]) => {
      console.log(`   - ${source}: ${count} 笔`);
    });
  }

  /**
   * 用户历史记录
   */
  userHistory(userInfo) {
    const { address, transactions } = userInfo;
    const shortAddr = `${address.slice(0, 8)}...${address.slice(-8)}`;

    console.log(`\n👤 用户 ${shortAddr} 的完整交易历史:`);
    console.log(`   总交易数: ${transactions.length} 笔`);
    console.log(`   交易明细:`);

    transactions.forEach((tx, index) => {
      const action = tx.solChange < 0 ? '买入' : '卖出';
      const emoji = tx.solChange < 0 ? '📥' : '📤';
      console.log(`   ${index + 1}. ${emoji} ${action} | SOL: ${tx.solChange >= 0 ? '+' : ''}${tx.solChange.toFixed(6)} | Token: ${tx.tokenChange >= 0 ? '+' : ''}${tx.tokenChange.toFixed(2)} | ${tx.timestamp}`);
    });
  }

  /**
   * 指标汇总
   */
  metricsSummary(metrics) {
    console.log('\n' + '='.repeat(100));
    console.log('📊 实时指标汇总');
    console.log('='.repeat(100));
    console.log(`💰 已落袋: ${metrics.yiLuDai.toFixed(4)} SOL (${metrics.exitedCount} 个已退出用户)`);
    console.log(`🎯 本轮下注: ${metrics.benLunXiaZhu.toFixed(4)} SOL (${metrics.activeCount} 个持有者)`);
    console.log(`💵 本轮成本: ${metrics.benLunChengBen.toFixed(4)} SOL`);
    console.log(`📈 浮盈浮亏: ${metrics.floatingPnL.toFixed(4)} SOL`);
    console.log(`💲 当前价格: ${metrics.currentPrice.toFixed(10)} SOL/Token`);
    console.log(`✅ 已处理交易: ${metrics.totalProcessed} 笔`);
    console.log('='.repeat(100) + '\n');
  }

  /**
   * 错误日志
   */
  error(message, details = null) {
    console.error(`\n❌ 错误: ${message}`);
    if (details) {
      console.error('   详情:', details);
    }
  }

  /**
   * 警告日志
   */
  warn(message) {
    console.warn(`\n⚠️ 警告: ${message}`);
  }

  /**
   * 信息日志
   */
  info(message) {
    console.log(`\n💡 ${message}`);
  }

  /**
   * 成功日志
   */
  success(message) {
    console.log(`\n✅ ${message}`);
  }
}

// 导出单例
export default new LogFormatter();
