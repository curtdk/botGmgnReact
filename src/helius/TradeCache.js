/**
 * TradeCache - Trade 数据缓存管理类
 *
 * 功能：
 * 1. 管理所有 Trade 数据
 * 2. 按用户分组存储
 * 3. 去重和时间排序
 * 4. 支持混合数据源策略
 */

export default class TradeCache {
  constructor() {
    this.reset();
  }

  reset() {
    // 按用户分组的交易数据: { [address]: [trade1, trade2, ...] }
    this.tradesByUser = {};

    // 交易签名集合，用于去重: Set<signature>
    this.signatures = new Set();

    // 统计信息
    this.totalTrades = 0;
  }

  /**
   * 添加交易并去重
   * @param {Object} trade - 交易数据
   * @param {string} trade.owner - 交易者地址
   * @param {string} trade.signature - 交易签名
   * @param {string} trade.event - 交易类型 ('buy' | 'sell')
   * @param {number} trade.sol_amount - SOL 数量
   * @param {number} trade.token_amount - Token 数量
   * @param {number} trade.timestamp - 交易时间戳
   * @returns {boolean} - 是否为新交易（true: 新交易, false: 重复交易）
   */
  addTrade(trade) {
    if (!trade || !trade.owner || !trade.signature) {
      console.warn('[TradeCache] 无效的交易数据:', trade);
      return false;
    }

    // 去重检查
    if (this.signatures.has(trade.signature)) {
      return false; // 重复交易
    }

    // 添加到签名集合
    this.signatures.add(trade.signature);

    // 初始化用户的交易列表
    if (!this.tradesByUser[trade.owner]) {
      this.tradesByUser[trade.owner] = [];
    }

    // 添加交易
    this.tradesByUser[trade.owner].push(trade);

    // 按时间排序（确保交易按时间顺序）
    this.tradesByUser[trade.owner].sort((a, b) => a.timestamp - b.timestamp);

    // 更新统计
    this.totalTrades++;

    return true; // 新交易
  }

  /**
   * 获取用户的所有交易
   * @param {string} address - 用户地址
   * @returns {Array} - 交易列表（按时间排序）
   */
  getAllTradesForUser(address) {
    return this.tradesByUser[address] || [];
  }

  /**
   * 获取有交易的用户数量
   * @returns {number} - 用户数量
   */
  getUserCount() {
    return Object.keys(this.tradesByUser).length;
  }

  /**
   * 获取所有用户地址
   * @returns {Array<string>} - 用户地址列表
   */
  getAllUserAddresses() {
    return Object.keys(this.tradesByUser);
  }

  /**
   * 检查用户是否有交易记录
   * @param {string} address - 用户地址
   * @returns {boolean} - 是否有交易记录
   */
  hasTradesForUser(address) {
    return !!this.tradesByUser[address] && this.tradesByUser[address].length > 0;
  }

  /**
   * 获取统计信息
   * @returns {Object} - 统计信息
   */
  getStats() {
    return {
      totalTrades: this.totalTrades,
      userCount: this.getUserCount(),
      uniqueSignatures: this.signatures.size
    };
  }
}
