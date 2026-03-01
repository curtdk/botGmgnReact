IndexedDB:signatures  transactions 表（Helius 解析的 tx，fetchParsedTxs 自动缓存）

SignatureManager 内存（sig 元数据）
MetricsEngine traderStats（计算结果）
recentTrades 数组（实时交易显示）

WS：hasData=false → 立刻去 Helius RPC 拉完整 tx → 用 helius 格式处理
GMGN：hasData=true（trade 对象即数据） → 直接用 gmgn 格式处理，不拉 RPC


----------------------
earlyPublish:
  仅构建 previewTrades 给 UI 展示（不调用 processTransaction）
  GMGN sigs 保持 isProcessed=false ✓

fetchMissingTransactions:
  补全 Helius 历史 sig 的 tx 数据

performInitialCalculation:
  getReadySignatures() 返回全部 hasData=true sigs 按 slot 从旧→新排序