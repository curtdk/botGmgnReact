IndexedDB:signatures  transactions 表（Helius 解析的 tx，fetchParsedTxs 自动缓存）

SignatureManager 内存（sig 元数据）
MetricsEngine traderStats（计算结果）
recentTrades 数组（实时交易显示）

WS：hasData=false → 立刻去 Helius RPC 拉完整 tx → 用 helius 格式处理
GMGN：hasData=true（trade 对象即数据） → 直接用 gmgn 格式处理，不拉 RPC


四大参数计算：1. helius sig  排序， 2， 有hasData=false  就停止，计算之前的，补全后继续计算
