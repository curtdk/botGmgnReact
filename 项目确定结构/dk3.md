

processGmgnTransaction : 

5fPM1ajSnoZScU7LevLia6gM3GVRVRdNhzzJVuC3vzPy

测试: npx vitest src/test/helius_monitor_start.test.js
运行站点:python -m http.server 8899
数据库:IndexedDB:signatures  transactions 表（Helius 解析的 tx，fetchParsedTxs 自动缓存）
sig 元数据:SignatureManager 
用户信息合集：MetricsEngine traderStats
实时交易显示： recentTrades  ui接收显示 


是否已经获取Tx:hasData

4参数计算:processFetchedTrades -> processNewGmgnTrades->(processGmgnTransaction)processHeliusTransaction-> updateTraderState
活动，持有者 定时刷新 :EXECUTE_HOLDERS_REFRESH  EXECUTE_TRADES_REFRESH
traderStats 实时聚合:getMetrics

评分:
    _scheduleQuickScore   是否确认  散户   快评分 calculateScores
    _scheduleSlowScore    只对 普通 用户 处理 慢评分  detectHiddenRelays

helius api 获取 tx :  fetchParsedTxs  后期要修改为 批量 当前是一次一个


