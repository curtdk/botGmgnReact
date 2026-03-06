import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import WhaleScoreManager from '../utils/WhaleScoreManager';
import { fetchAll, getKeys, getMintFromPage, getHolderConfig, normalize, stoSet, getPriceFromPage, findPriceDOM } from '../utils/api';
import SettingsModal from '../content/components/SettingsModal';
import BossSettingsModal from '../content/components/BossSettingsModal';
import AdvancedStrategyModal from '../content/components/AdvancedStrategyModal';
import TradePanel from '../content/components/TradePanel';
import PortalPay from '../utils/PortalPay';
import { THEMES, getStyles } from '../content/styles';

// 辅助函数：浅比较对象
const shallowEqual = (obj1, obj2) => {
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    if (keys1.length !== keys2.length) return false;
    for (let key of keys1) {
        if (obj1[key] !== obj2[key]) return false;
    }
    return true;
};

// 辅助函数：智能合并数组，保持未变化项的引用
const mergeItems = (oldItems, newItems) => {
    if (!oldItems || oldItems.length === 0) return newItems;
    if (!newItems || newItems.length === 0) return oldItems;

    const oldMap = new Map(oldItems.map(item => [item.owner, item]));
    const result = [];

    for (const newItem of newItems) {
        const oldItem = oldMap.get(newItem.owner);
        if (oldItem && shallowEqual(oldItem, newItem)) {
            result.push(oldItem);
        } else {
            result.push(newItem);
        }
    }

    return result;
};

// 列定义常量
const COLUMN_DEFS = [
    { id: 'rank',         label: '排',    width: '24px', align: 'center', defaultVisible: true },
    { id: 'address',      label: '地址',  width: '36px', align: 'left',   defaultVisible: true },
    { id: 'score',        label: 'Score', width: '36px', align: 'center', defaultVisible: true },
    { id: 'net_cost',     label: '成本',  flex: 1,       align: 'right',  defaultVisible: true },
    { id: 'total_buy',    label: '下注',  width: '44px', align: 'right',  defaultVisible: true },
    { id: 'realized',     label: '落袋',  width: '40px', align: 'right',  defaultVisible: true },
    { id: 'floating_pnl', label: '浮亏',  width: '46px', align: 'right',  defaultVisible: true },
];

// 优化的列表项组件 - 使用 React.memo 避免不必要的重新渲染
const UserListItem = React.memo(({
    item,
    isSelected,
    visibleColIds,
    colWidths,
    styles,
    onSelect,
    onStatusChange,
    currentPrice,
    metricsUnit,
    solUsdtPrice,
}) => {
    // SOL → USDT 换算（USDT 模式下乘以 solUsdtPrice）
    const toDisp = (solVal) => {
        const v = metricsUnit === 'USDT' && solUsdtPrice > 0 ? solVal * solUsdtPrice : solVal;
        return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
    };

    const handleCheckboxChange = (e) => {
        e.stopPropagation();
        const newStatus = e.target.checked ? '庄家' : '散户';
        onStatusChange(item.owner, newStatus);
    };

    return (
        <div
            style={{
                ...styles.listItem(isSelected),
                transition: 'all 0.2s ease-in-out' // 添加平滑过渡
            }}
            onClick={() => onSelect(item.owner)}
        >
            {visibleColIds.map(colId => {
                const col = COLUMN_DEFS.find(c => c.id === colId);
                if (!col) return null;

                let content = null;
                const customWidth = colWidths[colId];
                const style = {
                    textAlign: col.align || 'left',
                    paddingRight: col.align === 'right' ? '4px' : 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    transition: 'color 0.3s ease-in-out' // 数字变化平滑过渡
                };

                if (customWidth) {
                    if (customWidth === 'flex' || customWidth.includes('fr')) {
                        style.flex = 1;
                    } else {
                        style.width = customWidth;
                    }
                } else {
                    style.width = col.width;
                    style.flex = col.flex;
                }

                switch(col.id) {
                    case 'rank':
                        content = (
                            <div style={{ textAlign: 'center' }}>
                                <input
                                    type="checkbox"
                                    checked={item.status === '庄家'}
                                    onChange={handleCheckboxChange}
                                    onClick={e => e.stopPropagation()}
                                />
                            </div>
                        );
                        break;
                    case 'address':
                        style.fontFamily = 'monospace';
                        style.title = item.owner || '';
                        content = item.main_address_short || (item.owner ? item.owner.slice(0, 4) : 'N/A');
                        break;
                    case 'score':
                        style.color = (item.score || 0) > 0 ? '#f59e0b' : styles.colors.textSecondary;
                        style.cursor = 'help';
                        style.title = item.score_reasons ? item.score_reasons.join(', ') : '无评分原因';
                        content = item.score || 0;
                        break;
                    case 'status':
                        style.color = item.status === '庄家' ? styles.colors.boss : styles.colors.textSecondary;
                        content = item.status === '庄家' ? '庄' : '散';
                        break;
                    case 'net_cost': {
                        const v = parseFloat(item.netflow_amount || 0);
                        style.color = v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#e5e7eb';
                        content = toDisp(v);
                        break;
                    }
                    case 'total_buy':
                        style.color = '#22c55e';
                        content = toDisp(parseFloat(item.total_buy_u || 0));
                        break;
                    case 'realized':
                        style.color = '#ef4444';
                        content = toDisp(parseFloat(item.total_sell_u || 0));
                        break;
                    case 'floating_pnl': {
                        const price = currentPrice || 0;
                        const tokenVal = parseFloat(item.ui_amount || 0) * price;
                        const cost = parseFloat(item.netflow_amount || 0);
                        const pnl = tokenVal - cost;
                        style.color = pnl >= 0 ? '#10b981' : '#ef4444';
                        content = toDisp(pnl);
                        break;
                    }
                    case 'pct':
                        content = `${parseFloat(item.holding_share_pct || 0).toFixed(2)}%`;
                        break;
                    default:
                        content = '-';
                }

                return <div key={col.id} style={style}>{content}</div>;
            })}
        </div>
    );
}, (prevProps, nextProps) => {
    // 自定义比较函数：只有这些关键字段变化时才重新渲染
    if (prevProps.item === nextProps.item &&
        prevProps.isSelected === nextProps.isSelected &&
        prevProps.visibleColIds === nextProps.visibleColIds &&
        prevProps.metricsUnit === nextProps.metricsUnit &&
        prevProps.solUsdtPrice === nextProps.solUsdtPrice) {
        return true;
    }

    // 否则检查关键字段
    return (
        prevProps.item.owner === nextProps.item.owner &&
        prevProps.item.score === nextProps.item.score &&
        prevProps.item.status === nextProps.item.status &&
        prevProps.item.total_buy_u === nextProps.item.total_buy_u &&
        prevProps.item.total_sell_u === nextProps.item.total_sell_u &&
        prevProps.item.netflow_amount === nextProps.item.netflow_amount &&
        prevProps.item.holding_share_pct === nextProps.item.holding_share_pct &&
        prevProps.item.ui_amount === nextProps.item.ui_amount &&
        prevProps.currentPrice === nextProps.currentPrice &&
        prevProps.metricsUnit === nextProps.metricsUnit &&
        prevProps.solUsdtPrice === nextProps.solUsdtPrice &&
        prevProps.isSelected === nextProps.isSelected &&
        prevProps.visibleColIds.length === nextProps.visibleColIds.length &&
        prevProps.visibleColIds.every((id, i) => id === nextProps.visibleColIds[i])
    );
});

// 实时交易列表组件
function RecentTradesList({ trades, sigFeed, minScore, metricsUnit, solUsdtPrice, height = 280 }) {
    // pending 条目：sigFeed 中还没有 tx 数据的 sig（最新到达，尚未被 MetricsEngine 处理）
    const pendingEntries = (sigFeed || []).filter(s => !s.hasData);

    if ((!trades || trades.length === 0) && pendingEntries.length === 0) return null;

    // 过滤逻辑：
    //  - score === undefined → 未评分，默认显示（评分结果还没拿到时不应隐藏）
    //  - score >= minScore   → 庄家，隐藏（仅当 minScore > 0 时启用此过滤）
    //  - score < minScore    → 散户，显示
    // minScore === 0 时不过滤，显示全部
    const visibleTrades = minScore > 0
        ? (trades || []).filter(t => t.score === undefined || t.score < minScore)
        : (trades || []);

    const timeAgo = (ts) => {
        const diff = Math.floor((Date.now() - ts) / 1000);
        if (diff < 60) return `${diff}s`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
        return `${Math.floor(diff / 86400)}d`;
    };

    const fmtToken = (v) => {
        if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
        if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
        if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
        return v.toFixed(0);
    };

    const fmtSol = (v) => {
        const val = metricsUnit === 'USDT' && solUsdtPrice > 0 ? v * solUsdtPrice : v;
        if (val >= 100) return val.toFixed(0);
        if (val >= 10) return val.toFixed(1);
        return val.toFixed(2);
    };

    const flames = (v) => {
        const val = metricsUnit === 'USDT' && solUsdtPrice > 0 ? v * solUsdtPrice : v;
        if (val >= 300) return '🔥🔥🔥';
        if (val >= 200) return '🔥🔥';
        return '';
    };

    const shortAddr = (addr) => addr ? addr.slice(0, 4) : '----';

    const colStyle = (width, align = 'right') => ({
        width,
        flexShrink: 0,
        textAlign: align,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
    });

    return (
        <div style={{ borderBottom: '1px solid #1f2937', marginBottom: '2px' }}>
            {/* 标题栏 */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 6px',
                backgroundColor: '#0d1117',
                borderBottom: '1px solid #1f2937',
            }}>
                <span style={{ fontSize: '11px', color: '#9ca3af', fontWeight: 'bold' }}>实时交易</span>
                <span style={{
                    fontSize: '10px',
                    color: '#6b7280',
                    backgroundColor: '#1f2937',
                    borderRadius: '8px',
                    padding: '0 5px',
                    lineHeight: '16px',
                }}>{trades.length}</span>
            </div>
            {/* 表头 */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                padding: '2px 6px',
                fontSize: '10px',
                color: '#4b5563',
                backgroundColor: '#0d1117',
                borderBottom: '1px solid #111827',
                userSelect: 'none',
            }}>
                <span style={colStyle('30px', 'left')}>时间</span>
                <span style={colStyle('36px', 'left')}>类型</span>
                <span style={colStyle('56px')}>数量</span>
                <span style={colStyle('68px')}>金额</span>
                <span style={colStyle('36px')}>交易者</span>
                <span style={{ flex: 1, textAlign: 'right' }}>标签</span>
            </div>
            {/* 交易行 */}
            <div style={{ height: `${height}px`, overflowY: 'auto', backgroundColor: '#0d1117' }}>
                {/* Pending 条目：sig 已到达但 tx 数据尚未获取 */}
                {pendingEntries.map((s) => (
                    <div key={s.sig} style={{
                        display: 'flex',
                        alignItems: 'center',
                        padding: '2px 6px',
                        fontSize: '11px',
                        color: '#4b5563',
                        borderBottom: '1px solid #111827',
                        backgroundColor: '#0a0e16',
                    }}>
                        <span style={{ width: '30px', flexShrink: 0, color: '#374151' }}>{Math.floor((Date.now() - s.rawTimestamp) / 1000)}s</span>
                        <span style={{ width: '36px', flexShrink: 0, color: '#374151' }}>···</span>
                        <span style={{ flex: 1, color: '#374151', fontFamily: 'monospace', fontSize: '10px' }}>{s.sig.slice(0, 8)}… 待获取</span>
                    </div>
                ))}
                {visibleTrades.map((t, i) => {
                    const isBuy = t.action === '买入';
                    return (
                        <div key={t.signature + i} style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: '2px 6px',
                            fontSize: '11px',
                            color: '#d1d5db',
                            borderBottom: '1px solid #111827',
                        }}>
                            <span style={{ ...colStyle('30px', 'left'), color: '#6b7280' }}>{timeAgo(t.rawTimestamp)}</span>
                            <span style={{ ...colStyle('36px', 'left'), color: isBuy ? '#22c55e' : '#ef4444', fontWeight: 500 }}>{t.action}</span>
                            <span style={{ ...colStyle('56px'), color: '#6b7280' }}>{fmtToken(t.tokenAmount)}</span>
                            <span style={{ ...colStyle('68px'), color: isBuy ? '#22c55e' : '#ef4444' }}>{fmtSol(t.solAmount)}{flames(t.solAmount)}</span>
                            <span style={{ ...colStyle('36px'), color: '#ffffff', fontFamily: 'monospace' }}>{shortAddr(t.address)}</span>
                            <span style={{ flex: 1, textAlign: 'right', color: t.label ? (t.label === '庄家' ? '#ef4444' : '#10b981') : '#4b5563' }}>
                                {t.label || '待评分'}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

const App = () => {
  // Theme State
  const [themeMode, setThemeMode] = useState('dark');

  // 初始化主题（从 storage 读取）
  useEffect(() => {
      chrome.storage.local.get([
        'gmgn_theme_mode',
        'helius_monitor_enabled',
        'data_flow_logger_enabled',
        'score_threshold',
        'status_threshold',
        'gmgn_max_pages',
        'gmgn_page_delay'
      ], (res) => {
          if (res.gmgn_theme_mode) setThemeMode(res.gmgn_theme_mode);
          if (res.helius_monitor_enabled !== undefined) {
              setHeliusMonitorEnabled(res.helius_monitor_enabled);
          }
          if (res.data_flow_logger_enabled !== undefined) {
              setDataFlowLoggerEnabled(res.data_flow_logger_enabled);
          }
          // 统一默认值为 100
          setMinScore(res.score_threshold !== undefined ? res.score_threshold : 100);
          // 统一默认值为 50
          setStatusThreshold(res.status_threshold !== undefined ? res.status_threshold : 50);
          if (res.gmgn_max_pages !== undefined) setMaxPages(res.gmgn_max_pages);
          if (res.gmgn_page_delay !== undefined) setPageDelay(res.gmgn_page_delay);
      });
  }, []);

  const [showColSettings, setShowColSettings] = useState(false); // 控制列设置面板显示
  
  // Column Visibility State
  const [visibleColIds, setVisibleColIds] = useState([]);
  const [colWidths, setColWidths] = useState({});
  const [listFontSize, setListFontSize] = useState(13);
  const [tradeListHeight, setTradeListHeight] = useState(280);
  const [userListHeight, setUserListHeight] = useState(120);

  // 初始化列设置
  useEffect(() => {
      chrome.storage.local.get(['gmgn_col_visible', 'gmgn_col_widths', 'gmgn_list_font_size', 'gmgn_trade_list_height', 'gmgn_user_list_height'], (res) => {
          if (res.gmgn_col_visible) {
              setVisibleColIds(JSON.parse(res.gmgn_col_visible));
          } else {
              setVisibleColIds(COLUMN_DEFS.filter(c => c.defaultVisible).map(c => c.id));
          }
          if (res.gmgn_col_widths) setColWidths(JSON.parse(res.gmgn_col_widths));
          if (res.gmgn_list_font_size) setListFontSize(parseInt(res.gmgn_list_font_size));
          if (res.gmgn_trade_list_height !== undefined) setTradeListHeight(parseInt(res.gmgn_trade_list_height));
          if (res.gmgn_user_list_height !== undefined) setUserListHeight(parseInt(res.gmgn_user_list_height));
      });
  }, []);

  // isOpen 默认为 true，因为这是 Side Panel，打开就是打开了
  const [isOpen, setIsOpen] = useState(true); 
  const [width, setWidth] = useState(window.innerWidth); // 响应式宽度
  const [statusLogs, setStatusLogs] = useState(['状态：就绪']); // 改为多行日志
  const [debugInfo, setDebugInfo] = useState('');
  const [items, setItems] = useState([]); // 列表数据
  const [filterRetail, setFilterRetail] = useState(true);
  const [filterBoss, setFilterBoss] = useState(false);
  const [minScore, setMinScore] = useState(0); // 新增分数筛选状态
  const [statusThreshold, setStatusThreshold] = useState(50); // 状态判断阈值
  const [maxPages, setMaxPages] = useState(30); // GMGN 最大翻页数
  const [pageDelay, setPageDelay] = useState(1000); // 翻页间隔 ms
  const [showSettings, setShowSettings] = useState(false);
  const [showBossSettings, setShowBossSettings] = useState(false);
  const [showStrategyModal, setShowStrategyModal] = useState(false);
  const [showTradePanel, setShowTradePanel] = useState(false);
  const [selectedOwner, setSelectedOwner] = useState(null);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [priceDomStatus, setPriceDomStatus] = useState({ status: 'init', msg: '初始化' }); // 新增状态
  const [pageObserverStatus, setPageObserverStatus] = useState({ status: 'init', msg: '初始化' }); // [新增] 页面观察者状态
  const [pageMint, setPageMint] = useState(''); // 当前页面的 Mint 地址，用于触发 Effect

  // Helius 指标状态
  const [heliusMetrics, setHeliusMetrics] = useState(null);
  const [heliusStats, setHeliusStats] = useState(null);
  const [heliusMint, setHeliusMint] = useState(null);
  const [recentTrades, setRecentTrades] = useState([]);
  const [sigFeed, setSigFeed] = useState([]);
  const [heliusMonitorEnabled, setHeliusMonitorEnabled] = useState(false); // Helius 监控开关
  const [heliusWsStatus, setHeliusWsStatus] = useState({
    connected: false,
    lastConnectTime: null,
    reconnectCount: 0,
    error: null
  }); // WebSocket 状态
  const [heliusVerifyStatus, setHeliusVerifyStatus] = useState({
    lastVerifyTime: null,
    timeSinceLastVerify: null
  }); // 校验状态

  // 数据流日志状态
  const [dataFlowLoggerEnabled, setDataFlowLoggerEnabled] = useState(false);
  const [showLogViewer, setShowLogViewer] = useState(false);
  const [logStats, setLogStats] = useState({ total: 0, bySources: {}, byEvents: {} });

  // 交易配置状态
  const [fixedBuyAmounts, setFixedBuyAmounts] = useState([0.01, 0.05, 0.1]);
  const [fixedSellPcts, setFixedSellPcts] = useState([25, 50, 100]);

  // 自动更新状态
  const [hookRefreshEnabled, setHookRefreshEnabled] = useState(false);
  const [apiRefreshEnabled, setApiRefreshEnabled] = useState(false);
  const [autoUpdateSec, setAutoUpdateSec] = useState(3);
  const [bossDetectSec, setBossDetectSec] = useState(10); // 新增状态
  const [activityMonitorEnabled, setActivityMonitorEnabled] = useState(false); // 活动监听开关

  // SOL/USDT 切换状态
  const [solUsdtPrice, setSolUsdtPrice] = useState(0);
  const [metricsUnit, setMetricsUnit] = useState('SOL');
  const [showPriceInput, setShowPriceInput] = useState(false);
  const [manualPriceInput, setManualPriceInput] = useState('');
  const [activityMonitorInterval, setActivityMonitorInterval] = useState(3); // 活动监听间隔
  const [observerEnabled, setObserverEnabled] = useState(false); // 页面监听开关
  const [observerInterval, setObserverInterval] = useState(500); // 页面监听间隔
  const isAutoFilling = useRef(false);
  const autoUpdateTimer = useRef(null);
  const tradesUpdateTimer = useRef(null); // 活动数据定时器
  const lastHoldersUrlRef = useRef(''); // 存储最新的 /token_holders URL，供定时刷新使用
  const lastTradesUrlRef = useRef('');  // 存储最新的 /token_trades  URL，供定时刷新使用
  const holdersUrlFailCountRef = useRef(0); // 连续失败计数（holders URL 失效检测）
  const tradesUrlFailCountRef = useRef(0);  // 连续失败计数（trades URL 失效检测）
  const lastGmgnHeadersRef = useRef({}); // 存储最新的 API 请求头
  const [hookUrl, setHookUrl] = useState(''); // 存储最新的 GMGN API URL (state 用于触发副作用)

  // 开始/停止控制
  const [isStarted, setIsStarted] = useState(false);
  const [startedMint, setStartedMint] = useState('');
  const [startStage, setStartStage] = useState('就绪');
  const [hookUrlReady, setHookUrlReady] = useState(null); // null=未检查 true=可用 false=无缓存
  const isStartedRef = useRef(false);
  const startedMintRef = useRef('');

  // 使用 Ref 同步配置状态，解决闭包问题
  const hookRefreshEnabledRef = useRef(hookRefreshEnabled);
  const apiRefreshEnabledRef = useRef(apiRefreshEnabled);
  const autoUpdateSecRef = useRef(autoUpdateSec);
  const activityMonitorEnabledRef = useRef(activityMonitorEnabled);
  const activityMonitorIntervalRef = useRef(activityMonitorInterval);
  const observerEnabledRef = useRef(observerEnabled);
  const observerIntervalRef = useRef(observerInterval);

  // 同步开始/停止 ref（解决定时器闭包问题）
  useEffect(() => { isStartedRef.current = isStarted; }, [isStarted]);
  useEffect(() => { startedMintRef.current = startedMint; }, [startedMint]);

  // pageMint ref（供 storage 监听器中读取当前 mint）
  const pageMintRef = useRef('');
  useEffect(() => { pageMintRef.current = pageMint; }, [pageMint]);

  // 引用管理器实例
  const scoreManagerRef = useRef(null);

  // 监听窗口大小变化
  useEffect(() => {
      const handleResize = () => setWidth(window.innerWidth);
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Compute Styles
  const currentTheme = THEMES[themeMode];
  // Side Panel 不需要 absolute positioning，修改 container 样式
  const styles = useMemo(() => {
      const s = getStyles(currentTheme, true, width, listFontSize, userListHeight);
      s.container = {
          ...s.container,
          position: 'relative',
          height: '100vh',
          width: '100%',
          borderLeft: 'none',
          boxShadow: 'none'
      };
      return s;
  }, [themeMode, width, listFontSize]);

  // 同步 State 到 Ref
  useEffect(() => {
      hookRefreshEnabledRef.current = hookRefreshEnabled;
      apiRefreshEnabledRef.current = apiRefreshEnabled;
      autoUpdateSecRef.current = autoUpdateSec;
      activityMonitorEnabledRef.current = activityMonitorEnabled;
      activityMonitorIntervalRef.current = activityMonitorInterval;
      observerEnabledRef.current = observerEnabled;
      observerIntervalRef.current = observerInterval;
  }, [hookRefreshEnabled, apiRefreshEnabled, autoUpdateSec, activityMonitorEnabled, activityMonitorInterval, observerEnabled, observerInterval]);

  // 更新可见列并持久化
  const toggleColumn = (colId) => {
      setVisibleColIds(prev => {
          const newSet = new Set(prev);
          if (newSet.has(colId)) {
              newSet.delete(colId);
          } else {
              newSet.add(colId);
          }
          const newArr = Array.from(newSet);
          const sorted = COLUMN_DEFS.filter(c => newArr.includes(c.id)).map(c => c.id);
          chrome.storage.local.set({ gmgn_col_visible: JSON.stringify(sorted) });
          return sorted;
      });
  };

  // 更新列宽并持久化
  const updateColWidth = (colId, newWidth) => {
      setColWidths(prev => {
          const next = { ...prev, [colId]: newWidth };
          chrome.storage.local.set({ gmgn_col_widths: JSON.stringify(next) });
          return next;
      });
  };

  // 更新字体大小并持久化
  const updateListFontSize = (size) => {
      setListFontSize(size);
      chrome.storage.local.set({ gmgn_list_font_size: size.toString() });
  };

  // 切换主题
  const toggleTheme = () => {
      setThemeMode(prev => {
          const next = prev === 'dark' ? 'light' : 'dark';
          chrome.storage.local.set({ gmgn_theme_mode: next });
          return next;
      });
  };

  /**
   * 辅助：添加日志 (带时间戳)
   * @param {string} msg - 日志消息
   */
  const addLog = (msg) => {
      const time = new Date().toLocaleTimeString('en-GB'); // HH:mm:ss
      setStatusLogs(prev => [`[${time}] ${msg}`, ...prev].slice(0, 100));
  };

  /** 开始处理 */
  const handleStart = () => {
      console.log('[dk] 开始handleStart ');

      if (!pageMint) { addLog('未检测到代币，请先访问 GMGN 代币页面'); return; }
      setIsStarted(true);
      setStartedMint(pageMint);
      isStartedRef.current = true;
      startedMintRef.current = pageMint;
      setStartStage('检查 Hook URL...');

      // 检查 hook URL 缓存
      chrome.storage.local.get([`gmgn_hook_url_${pageMint}`], (res) => {
          const url = res[`gmgn_hook_url_${pageMint}`];
          const ready = !!(url && (url.includes('/token_holders') || url.includes('/token_trades')));
          setHookUrlReady(ready);
          if (ready) {
              if (url.includes('/token_holders')) lastHoldersUrlRef.current = url;
              else if (url.includes('/token_trades')) lastTradesUrlRef.current = url;
              addLog('Hook URL: ✓ 可用，开始处理...');
              setStartStage('获取数据中...');
              if (apiRefreshEnabledRef.current) handleFullRefresh(false);
              startHookAutoRefresh();
          } else {
              addLog('Hook URL: ⚠ 无缓存，请刷新 GMGN 页面');
              setStartStage('等待 Hook URL');
          }
      });

      // 启动 Helius 并锁定 mint（告知内容脚本禁止自动切换）
      toggleHeliusMonitor(true);
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, { type: 'LOCK_MINT', mint: pageMint }).catch(() => {});
          }
      });
  };

  /** 停止所有处理 */
  const handleStop = () => {
      setIsStarted(false);
      setStartedMint('');
      isStartedRef.current = false;
      startedMintRef.current = '';
      setStartStage('已停止');
      setHookUrlReady(null);

      // 停止定时器
      if (autoUpdateTimer.current) { clearInterval(autoUpdateTimer.current); autoUpdateTimer.current = null; }
      if (tradesUpdateTimer.current) { clearInterval(tradesUpdateTimer.current); tradesUpdateTimer.current = null; }

      // 解锁 mint（告知内容脚本恢复自动监控）
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, { type: 'UNLOCK_MINT' }).catch(() => {});
          }
      });

      // 停止 Helius
      toggleHeliusMonitor(false);
      addLog('已停止所有处理');
  };

  /**
   * 切换 Helius 监控开关
   */
  const toggleHeliusMonitor = (enabled) => {
      setHeliusMonitorEnabled(enabled);

      // 如果关闭,清空状态
      if (!enabled) {
          setHeliusMetrics(null);
          setHeliusStats(null);
          setHeliusMint(null);
          setHeliusWsStatus({
              connected: false,
              lastConnectTime: null,
              reconnectCount: 0,
              error: null
          });
          setHeliusVerifyStatus({
              lastVerifyTime: null,
              timeSinceLastVerify: null
          });
      }

      // 保存到 storage
      chrome.storage.local.set({ helius_monitor_enabled: enabled });

      // 发送消息给 content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                  type: 'HELIUS_MONITOR_TOGGLE',
                  enabled: enabled
              }).catch(err => {
              });
          }
      });

      addLog(enabled ? 'Helius 监控已启动' : 'Helius 监控已停止');
  };

  /**
   * 切换数据流日志开关
   */
  const toggleDataFlowLogger = async (enabled) => {
      setDataFlowLoggerEnabled(enabled);

      // 发送消息给 content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                  type: 'DATA_FLOW_LOGGER_TOGGLE',
                  enabled: enabled
              }).catch(err => {
              });
          }
      });

      addLog(enabled ? '数据流日志已启用' : '数据流日志已禁用');
  };

  /**
   * 查看日志
   */
  const viewLogs = () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                  type: 'GET_DATA_FLOW_LOGS'
              }).then(response => {
                  if (response && response.logs) {
                      // 更新统计信息
                      setLogStats(response.stats);
                      // 显示日志查看器
                      setShowLogViewer(true);
                  }
              }).catch(err => {
              });
          }
      });
  };

  /**
   * 导出日志
   */
  const exportLogs = () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                  type: 'EXPORT_DATA_FLOW_LOGS'
              }).catch(err => {
              });
          }
      });
  };

  /**
   * 清空日志
   */
  const clearLogs = () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                  type: 'CLEAR_DATA_FLOW_LOGS'
              }).then(() => {
                  setLogStats({ total: 0, bySources: {}, byEvents: {} });
                  addLog('日志已清空');
              }).catch(err => {
              });
          }
      });
  };

  // SOL/USDT 切换：点击时获取价格，失败则弹框手动输入
  const handleMetricsUnitToggle = async () => {
      if (metricsUnit === 'USDT') {
          setMetricsUnit('SOL');
          return;
      }
      try {
          const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
          const data = await res.json();
          if (data.price) {
              setSolUsdtPrice(parseFloat(data.price));
              setMetricsUnit('USDT');
          } else {
              throw new Error('no price');
          }
      } catch (e) {
          setManualPriceInput('');
          setShowPriceInput(true);
      }
  };

  // 格式化指标值（SOL 或 USDT）
  const fmtMetric = (solVal) => {
      if (metricsUnit === 'USDT' && solUsdtPrice > 0) {
          return { value: (solVal * solUsdtPrice).toFixed(2), unit: 'USDT' };
      }
      return { value: solVal.toFixed(4), unit: 'SOL' };
  };

  /**
   * 全量刷新数据
   * @param {boolean} quiet - 是否静默模式
   */
  const handleFullRefresh = async (quiet = false) => {
      if (!isStartedRef.current) return; // 未启动则跳过
        console.log('[dk] handleFullRefresh  全量 hook ');

      if(!quiet) { addLog('状态：正在全量获取...'); setStartStage('获取持仓数据...'); }
      
      try {
          if(!pageMint) {
              addLog('错误：未找到 Mint 地址');
              return;
          }
          
          // 更新管理器 Mint
          if (scoreManagerRef.current) scoreManagerRef.current.setMint(pageMint);
          
          const keys = await getKeys();
          if(!keys || keys.length === 0) {
              addLog('错误：未配置 API Keys');
              return;
          }
          
          const { limitVal, maxVal } = await getHolderConfig();
          
          // TODO: 这里需要改为发送消息给 Content Script 执行 fetchAll
          // 目前 fetchAll 是直接 fetch，如果在 Side Panel 执行，可能会有 Cookie 问题
          // 暂时尝试直接执行，如果失败则需要 Content Script 代理
          // 实际上 fetchAll 内部是直接 fetch，不依赖 DOM，但依赖 Cookie 鉴权？
          // 如果是 Public API 可能不需要 Cookie。如果是私有 API，需要 Cookie。
          
          // 临时方案：直接调用 fetchAll (假设 Side Panel 有权限或 API 不需要 Cookie)
          // 长期方案：发送 PROXY_FETCH 消息
          
          const rawItems = await fetchAll(pageMint, keys, limitVal, maxVal, (msg) => {
              if(!quiet) addLog(msg);
          });

          if (!rawItems) {
              throw new Error('获取失败 (所有Key均无效或网络错误)');
          }

          // [修改] 不再使用 WhaleScoreManager 重新计算分数
          // 直接使用数据源的分数,确保数据一致性
          // const newOwners = scoreManagerRef.current.updateData(rawItems);
          // const sortedItems = scoreManagerRef.current.getSortedItems();
          setItems(prev => mergeItems(prev, rawItems));

          if(!quiet) addLog(`状态：更新完成，共 ${rawItems.length} 条`);
          
      } catch (e) {
          if(!quiet) addLog(`错误：${e.message}`);
      }
  };

  /**
   * 自动补全数据
   */
  const autoFillData = async () => {
      if(isAutoFilling.current) return;
      isAutoFilling.current = true;
      try {
          const keys = await getKeys();
          if(!pageMint || !keys.length) return;
          
          const { limitVal, maxVal } = await getHolderConfig();

          // [修改] 使用 items.length 而不是 scoreManagerRef，确保使用数据源的数据
          while(items.length < maxVal) {
              addLog(`自动补全: Fetching...`);
              try {
                  await handleFullRefresh(true);
                  break;
              } catch(e) {
                  break;
              }
          }
      } finally {
          isAutoFilling.current = false;
      }
  };

  /**
   * 基于 Hook URL 的刷新 (复刻 performRefresh)
   * 修正：通过 Content Script 代理请求，解决跨域和路径问题
   */
  const runHookRefresh = async () => {
      if (!isStartedRef.current) return; // 未启动则跳过
      const url = lastHoldersUrlRef.current;
      if (!url) {
          addLog('EXECUTE_HOLDERS_REFRESH URL: 无URL，请刷新 GMGN 页面获取');
          return;
      }
      console.log(`[runHookRefresh] 触发 url=${url.slice(0, 60)}`);
      addLog('[Holders] 刷新触发');
      
      // 发送指令给 Content Script 执行真正的 fetch
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                  type: 'EXECUTE_HOLDERS_REFRESH',
                  url: url
              }, (response) => {
                  if (chrome.runtime.lastError) {
                      // content script 不可达，不计入 URL 失效
                  } else if (response) {
                      if (response.success === false) {
                          holdersUrlFailCountRef.current += 1;
                          if (holdersUrlFailCountRef.current >= 3) {
                              addLog('⚠ Holders URL 已失效，请刷新 GMGN 页面重新获取');
                              lastHoldersUrlRef.current = '';
                              setHookUrlReady(false);
                              holdersUrlFailCountRef.current = 0;
                          }
                      } else {
                          holdersUrlFailCountRef.current = 0;
                      }
                  }
              });
              addLog('EXECUTE_HOLDERS_REFRESH 刷新: 请求已发送...');
          }
      });
  };

  /**
   * 活动数据刷新 (Trades)
   */
  const runTradesRefresh = async () => {
      const url = lastTradesUrlRef.current;
      if(!url) return;
      console.log(`[runTradesRefresh] 触发 url=${url.slice(0, 60)}`);
      addLog('[Trades] 刷新触发');

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.id) {
              // addLog('活动刷新: 正在请求...');
              chrome.tabs.sendMessage(tabs[0].id, {
                  type: 'EXECUTE_TRADES_REFRESH',
                  url: url,
                  maxPages: maxPages,
                  pageDelay: pageDelay
              }, (response) => {
                  if (chrome.runtime.lastError) {
                      // content script 不可达，不计入 URL 失效
                  } else if (response) {
                      if (response.success === false && response.error !== 'Already fetching') {
                          tradesUrlFailCountRef.current += 1;
                          if (tradesUrlFailCountRef.current >= 3) {
                              addLog('⚠ Trades URL 已失效，请刷新 GMGN 页面重新获取');
                              lastTradesUrlRef.current = '';
                              tradesUrlFailCountRef.current = 0;
                          }
                      } else if (response.success !== false) {
                          tradesUrlFailCountRef.current = 0;
                      }
                  }
              });
          }
      });
  };

  /**
   * 初始化/重置页面逻辑
   * @param {string} mint - 新的 Mint 地址
   */
  const initPageLogic = (mint) => {
      if (!mint) {
          return;
      }
      addLog(`检测到新代币: ${mint.slice(0,6)}...`);

      // 已启动时锁定 mint，忽略页面切换
      if (isStartedRef.current) {
          if (mint !== startedMintRef.current) {
              addLog(`浏览已切换至 ${mint.slice(0,6)}...，继续处理 ${startedMintRef.current.slice(0,6)}...`);
          }
          return;
      }

      // 1. 初始化/重置管理器
      scoreManagerRef.current = new WhaleScoreManager();
      scoreManagerRef.current.setMint(mint);

      // 2. 重置状态
      setItems([]);
      setStatusLogs(['状态：就绪']);
      lastHoldersUrlRef.current = '';
      lastTradesUrlRef.current = ''; // 重置 Trades URL
      holdersUrlFailCountRef.current = 0; // 重置失败计数
      tradesUrlFailCountRef.current = 0;
      setPageMint(mint);
      setHookUrlReady(null);

      // 2.5 从缓存检查 hook URL 是否可用
      chrome.storage.local.get([`gmgn_hook_url_${mint}`], (res) => {
          const cachedUrl = res[`gmgn_hook_url_${mint}`];
          if (cachedUrl && (cachedUrl.includes('/token_holders') || cachedUrl.includes('/token_trades'))) {
              lastHoldersUrlRef.current = cachedUrl;
              setHookUrlReady(true);
              addLog(`Hook URL: ✓ 已从缓存恢复，点击开始即可运行`);
          } else {
              setHookUrlReady(null); // 保持"待检查"，等待 hook 自动写入
              addLog(`Hook URL: 等待自动检测...`);
          }
      });

      // 3. 不再自动触发刷新，等待用户点击"开始"
  };

  useEffect(() => {
    // 1. 加载所有配置
    chrome.storage.local.get([
        'fixed_buy_sol', 'fixed_sell_pct', 'hook_auto_start', 'auto_update_sec',
        'hook_refresh_enabled', 'api_refresh_enabled', 'boss_detect_sec',
        'activity_monitor_enabled', 'activity_monitor_interval',
        'observer_enabled', 'observer_interval'
    ], (res) => {
        if(Array.isArray(res.fixed_buy_sol) && res.fixed_buy_sol.length) setFixedBuyAmounts(res.fixed_buy_sol);
        if(Array.isArray(res.fixed_sell_pct) && res.fixed_sell_pct.length) setFixedSellPcts(res.fixed_sell_pct);
        if(res.hook_refresh_enabled !== undefined) setHookRefreshEnabled(res.hook_refresh_enabled);
        if(res.api_refresh_enabled !== undefined) setApiRefreshEnabled(res.api_refresh_enabled);
        
        const sec = parseInt(res.auto_update_sec) || 3;
        setAutoUpdateSec(sec);

        if(res.boss_detect_sec) setBossDetectSec(res.boss_detect_sec);
        if(res.activity_monitor_enabled !== undefined) setActivityMonitorEnabled(res.activity_monitor_enabled);
        if(res.activity_monitor_interval) setActivityMonitorInterval(res.activity_monitor_interval);
        if(res.observer_enabled !== undefined) setObserverEnabled(res.observer_enabled);
        if(res.observer_interval) setObserverInterval(res.observer_interval);
    });

    // 2. 监听配置变化
    const handleStorageChange = (changes, area) => {
        if (area === 'local') {
            if (changes.fixed_buy_sol?.newValue) setFixedBuyAmounts(changes.fixed_buy_sol.newValue);
            if (changes.fixed_sell_pct?.newValue) setFixedSellPcts(changes.fixed_sell_pct.newValue);
            if (changes.hook_refresh_enabled) setHookRefreshEnabled(changes.hook_refresh_enabled.newValue);
            if (changes.api_refresh_enabled) setApiRefreshEnabled(changes.api_refresh_enabled.newValue);
            if (changes.auto_update_sec?.newValue) setAutoUpdateSec(parseInt(changes.auto_update_sec.newValue) || 3);
            if (changes.boss_detect_sec) setBossDetectSec(changes.boss_detect_sec.newValue);
            if (changes.activity_monitor_enabled) setActivityMonitorEnabled(changes.activity_monitor_enabled.newValue);
            if (changes.activity_monitor_interval) setActivityMonitorInterval(changes.activity_monitor_interval.newValue);
            if (changes.observer_enabled) setObserverEnabled(changes.observer_enabled.newValue);
            if (changes.observer_interval) setObserverInterval(changes.observer_interval.newValue);

            // 自动检测 hook URL 写入（hook.js → content/index.jsx → storage）
            const currentMint = pageMintRef.current;
            if (currentMint && !isStartedRef.current) {
                const hookKey = `gmgn_hook_url_${currentMint}`;
                if (changes[hookKey]) {
                    const newUrl = changes[hookKey].newValue;
                    if (newUrl && newUrl.includes('/token_holders')) {
                        lastHoldersUrlRef.current = newUrl;
                        setHookUrlReady(true);
                        addLog('Hook URL: ✓ 已自动检测到 holders URL，可以点击开始');
                    } else if (newUrl && newUrl.includes('/token_trades')) {
                        lastTradesUrlRef.current = newUrl;
                        setHookUrlReady(true);
                        addLog('Hook URL: ✓ 已自动检测到 trades URL，可以点击开始');
                    }
                }
            }
        }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);

    // 3. 监听来自 Content Script 的消息
    const handleMessage = (request, sender, sendResponse) => {
        if (request.type === 'UI_RENDER_DATA') {
            // 接收渲染就绪数据
            if (!isStartedRef.current) return; // 未启动，忽略数据更新
            if (request.data && Array.isArray(request.data)) {
                // mint 不匹配时跳过（防止旧 mint 数据污染）
                // 优先检查消息体中的 mint 字段（HeliusIntegration.sendDataToSidepanel 携带）
                if (request.mint && startedMintRef.current && request.mint !== startedMintRef.current) return;
                // 兜底：从 URL 中解析 mint（GMGN Hook 路径携带）
                if (!request.mint && startedMintRef.current && request.url) {
                    const mintMatch = request.url.match(/token_(?:holders|trades)\/[^/]+\/([^?&/]+)/);
                    if (mintMatch && mintMatch[1] !== startedMintRef.current) return;
                }

                setStartStage('运行中 · 实时监听');
                // 直接更新 UI，Side Panel 变为轻量级渲染器
                setItems(prev => mergeItems(prev, request.data));
            }
        } else if (request.type === 'HOOK_HOLDERS_URL_CAPTURED') {
            // /token_holders URL 首次捕获（hook.js → index.jsx → 此处）
            if (request.url) {
                lastHoldersUrlRef.current = request.url;
                holdersUrlFailCountRef.current = 0; // 新 URL 到来，重置失败计数
                const mintMatch = request.url.match(/token_holders\/[^/]+\/([^?&/]+)/);
                if (mintMatch?.[1]) {
                    chrome.storage.local.set({ [`gmgn_hook_url_${mintMatch[1]}`]: request.url });
                }
                if (!isStartedRef.current) setHookUrlReady(true);
            }
        } else if (request.type === 'HOOK_TRADES_URL_CAPTURED') {
            // /token_trades URL 首次捕获（hook.js → index.jsx → 此处）
            if (request.url) {
                lastTradesUrlRef.current = request.url;
                tradesUrlFailCountRef.current = 0; // 新 URL 到来，重置失败计数
                const mintMatch = request.url.match(/token_trades\/[^/]+\/([^?&/]+)/);
                if (mintMatch?.[1]) {
                    chrome.storage.local.set({ [`gmgn_hook_url_${mintMatch[1]}`]: request.url });
                }
                if (!isStartedRef.current) setHookUrlReady(true);
            }
        } else if (request.type === 'PRICE_UPDATE') {
            // 处理价格更新
            if (request.price) setCurrentPrice(request.price);
        } else if (request.type === 'MINT_CHANGED') {
            // 处理 Mint 变化
            if (request.mint) {
                if (request.fromPageLoad) {
                    // 整页加载（地址栏直接输入/回车）：用户主动跳转，重置监控状态
                    if (isStartedRef.current) {
                        setIsStarted(false);
                        isStartedRef.current = false;
                        setStartedMint('');
                        startedMintRef.current = '';
                        setStartStage('已停止');
                        if (autoUpdateTimer.current) { clearInterval(autoUpdateTimer.current); autoUpdateTimer.current = null; }
                        if (tradesUpdateTimer.current) { clearInterval(tradesUpdateTimer.current); tradesUpdateTimer.current = null; }
                        // UNLOCK_MINT 不需要发送：新 content script 已重置 lockedMint=null
                    }
                    initPageLogic(request.mint);
                } else if (request.mint !== pageMint) {
                    initPageLogic(request.mint);
                }
            }
        } else if (request.type === 'PAGE_INFO') {
            // 初始化信息
            if (request.data.mint) initPageLogic(request.data.mint);
            if (request.data.price) setCurrentPrice(request.data.price);
        } else if (request.type === 'TRADES_FETCH_PROGRESS') {
            // [新增] 显示 Trades 获取进度
            const { page, count, lastHash } = request;
            addLog(`Trades P${page}: ${count}条`);
            if (lastHash && lastHash !== 'N/A') {
                addLog(lastHash); // 独占一行显示完整 Hash
            }
        } else if (request.type === 'PRICE_DOM_STATUS') {
            // [新增] 接收价格监听状态
            setPriceDomStatus({ status: request.status, msg: request.msg });
        } else if (request.type === 'PAGE_OBSERVER_STATUS') {
            // [新增] 接收页面观察者状态
            setPageObserverStatus({ status: request.status, msg: request.msg });
        } else if (request.type === 'LOG') {
            // [新增] 接收通用日志
            if (request.message) {
                addLog(request.message);
            }
        } else if (request.type === 'HELIUS_STATUS_LOG') {
            // 接收 Helius 流程状态日志（显示在底部日志面板）
            if (request.message) {
                addLog(request.message);
            }
        } else if (request.type === 'HELIUS_METRICS_UPDATE') {
            // 接收 Helius 指标更新 — 仅接受启动 mint 的数据
            if (!isStartedRef.current) return;
            if (request.mint && startedMintRef.current && request.mint !== startedMintRef.current) return;
            if (request.metrics) {
                setHeliusMetrics(request.metrics);
                if (request.metrics.recentTrades) {
                    setRecentTrades(request.metrics.recentTrades);
                }
                if (request.metrics.sigFeed) {
                    setSigFeed(request.metrics.sigFeed);
                }
            }
            if (request.stats) {
                setHeliusStats(request.stats);
            }
            if (request.mint) {
                setHeliusMint(request.mint);
            }
        } else if (request.type === 'HELIUS_STATS_UPDATE') {
            // sig 统计早期更新 — 仅接受启动 mint 的数据
            if (!isStartedRef.current) return;
            if (request.mint && startedMintRef.current && request.mint !== startedMintRef.current) return;
            if (request.stats) {
                setHeliusStats(request.stats);
            }
            if (request.mint) {
                setHeliusMint(request.mint);
            }
        } else if (request.type === 'HELIUS_METRICS_CLEAR') {
            // 已启动时忽略清空指令（防止切换 mint 时覆盖锁定 mint 的数据）
            if (isStartedRef.current) return;
            setHeliusMetrics(null);
            setHeliusStats(null);
            setHeliusMint(null);
            setRecentTrades([]);
        } else if (request.type === 'HELIUS_WS_STATUS') {
            // [新增] 接收 WebSocket 状态更新
            if (request.status) {
                setHeliusWsStatus(request.status);
            }
        }
    };
    chrome.runtime.onMessage.addListener(handleMessage);

    // 4. 主动询问 Content Script 获取当前页面信息
    // 获取当前活动 Tab 并发送消息
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_STATE' }, (response) => {
                 if (chrome.runtime.lastError) {
                     return;
                 }
                 if (response) {
                     // 1. 初始化页面基础信息
                     if (response.mint) initPageLogic(response.mint);
                     if (response.price) setCurrentPrice(response.price);
                     
                     // 2. 如果有暂存的 Hook 数据，立即加载
                     if (response.hookData && response.hookData.data) {
                         const cachedItems = response.hookData.data;
                         // [修改] 不再使用 WhaleScoreManager 重新计算分数
                         // 直接使用缓存数据的分数,确保数据一致性
                         setTimeout(() => {
                             setItems(prev => mergeItems(prev, cachedItems));
                             addLog(`缓存: 加载了 ${cachedItems.length} 条历史数据`);
                         }, 100);

                         if (response.hookData.url) {
                             if (response.hookData.url.includes('/token_holders')) {
                                 lastHoldersUrlRef.current = response.hookData.url;
                             } else if (response.hookData.url.includes('/token_trades')) {
                                 lastTradesUrlRef.current = response.hookData.url;
                             }
                         }
                     }
                 }
            });
        }
    });

    return () => {
        chrome.storage.onChanged.removeListener(handleStorageChange);
        chrome.runtime.onMessage.removeListener(handleMessage);
        if(autoUpdateTimer.current) clearInterval(autoUpdateTimer.current);
    };
  }, []);

  // 定期查询 Helius 校验状态
  useEffect(() => {
      if (!heliusMonitorEnabled) return;

      const interval = setInterval(() => {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]) {
                  chrome.tabs.sendMessage(tabs[0].id, {
                      type: 'GET_HELIUS_VERIFY_STATUS'
                  }, (response) => {
                      if (response) {
                          setHeliusVerifyStatus(response);
                      }
                  });
              }
          });
      }, 5000); // 每5秒更新一次显示

      return () => clearInterval(interval);
  }, [heliusMonitorEnabled]);

  // 启动 Hook 驱动的自动刷新（统一管理 holders + trades 两个定时器）
  const startHookAutoRefresh = () => {
      const hookEnabled = hookRefreshEnabledRef.current;
      const apiEnabled = apiRefreshEnabledRef.current;
      const tradesEnabled = activityMonitorEnabledRef.current;
      const sec = autoUpdateSecRef.current || 3;
      const tradesSec = activityMonitorIntervalRef.current || 3;

      // ── Holders / API 定时器 ──
      if (autoUpdateTimer.current) clearInterval(autoUpdateTimer.current);
      autoUpdateTimer.current = null;
      if (hookEnabled || apiEnabled) {
          addLog(`状态：Holders刷新已启动 (${sec}s) Hook:${hookEnabled} API:${apiEnabled}`);
          autoUpdateTimer.current = setInterval(() => {
              if (!isStartedRef.current) return;
              const url = lastHoldersUrlRef.current;
              if (hookRefreshEnabledRef.current && url) {
                  runHookRefresh();
              }
              if (apiRefreshEnabledRef.current) {
                  handleFullRefresh(true);
              }
          }, sec * 1000);
      }

      // ── Trades 定时器（只有点击开始后才实际执行）──
      if (tradesUpdateTimer.current) clearInterval(tradesUpdateTimer.current);
      tradesUpdateTimer.current = null;
      if (tradesEnabled) {
          addLog(`状态：Trades刷新已启动 (${tradesSec}s)`);
          tradesUpdateTimer.current = setInterval(() => {
              if (!isStartedRef.current) return; // 未点开始跳过
              const url = lastTradesUrlRef.current;
              if (url) runTradesRefresh();
          }, tradesSec * 1000);
      }
  };

  // 监听配置变化并管理定时器
  useEffect(() => {
      // 任意一个开关开启，就重新启动（内部会处理清旧建新）
      if (hookRefreshEnabled || apiRefreshEnabled || activityMonitorEnabled) {
          startHookAutoRefresh();
      } else {
          // 全部关闭时停止所有定时器
          if (autoUpdateTimer.current) {
              clearInterval(autoUpdateTimer.current);
              autoUpdateTimer.current = null;
          }
          if (tradesUpdateTimer.current) {
              clearInterval(tradesUpdateTimer.current);
              tradesUpdateTimer.current = null;
              addLog('状态：自动刷新已全部停止');
          }
      }
  }, [autoUpdateSec, hookRefreshEnabled, apiRefreshEnabled, activityMonitorEnabled, activityMonitorInterval]);

  // 筛选逻辑 - 后端已经根据 Score< 过滤，前端直接显示所有数据
  const displayItems = useMemo(() => {
      return [...items].sort((a, b) =>
          (parseFloat(b.netflow_amount) || 0) - (parseFloat(a.netflow_amount) || 0)
      );
  }, [items]);

  // 统计逻辑
  const stats = React.useMemo(() => {
      let retail = 0, boss = 0;
      let retailBuyU = 0, bossBuyU = 0;
      let retailNetflow = 0, bossNetflow = 0; // 新增统计

      displayItems.forEach(it => {
          const u = parseFloat(it.ui_amount || it.amount || 0) || 0;
          const bU = parseFloat(it.total_buy_u || 0) || 0;
          const nF = parseFloat(it.netflow_amount || 0) || 0;

          if (it.status === '庄家') {
              boss += u;
              bossBuyU += bU;
              bossNetflow += nF;
          } else {
              retail += u;
              retailBuyU += bU;
              retailNetflow += nF;
          }
      });
      return { retail, boss, retailBuyU, bossBuyU, retailNetflow, bossNetflow };
  }, [displayItems]);

  const selectedItem = selectedOwner ? items.find(i => i.owner === selectedOwner) : null;

  // 计算自定义短名称列表
  const customShortNames = React.useMemo(() => {
      const names = new Set();
      items.forEach(it => {
          if (it.main_address_short && it.status !== '庄家') {
              names.add(it.main_address_short);
          }
      });
      return Array.from(names);
  }, [items]);

  // 计算有效用户总数 (净流入 > 0)
  const validUserCount = React.useMemo(() => {
      return items.filter(it => parseFloat(it.netflow_amount || 0) > 0).length;
  }, [items]);

  // [新增] 计算持有用户总数 (is_holding !== false)
  const holdingUserCount = React.useMemo(() => {
      return items.filter(it => it.is_holding !== false).length;
  }, [items]);

  // 批量标记庄家
  const handleSetBossByShortName = (shortName) => {
      let changed = false;
      items.forEach(it => {
          if (it.main_address_short === shortName && it.status !== '庄家') {
              // [修改] 不再直接调用 scoreManagerRef.current.setStatus()
              // 而是发送消息给 Content Script，由 HeliusIntegration 处理手动标记
              // 手动标记会给分数 +10 分，然后基于分数阈值判断状态

              // 临时更新 UI 显示
              it.status = '庄家';

              // [新增] 立即通知 Content Script
              chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                  if (tabs[0]?.id) {
                      chrome.tabs.sendMessage(tabs[0].id, {
                          type: 'SET_MANUAL_SCORE',
                          address: it.owner,
                          status: '庄家'
                      });
                  }
              });

              changed = true;
          }
      });

      if (changed) {
          setItems(prev => [...prev]); // 触发刷新
          addLog(`操作: 将 "${shortName}" 标记为庄家`);
      }
  };

  return (
    <div 
      className="gmgn-std-panel"
      style={styles.container}
    >
      {/* Header */}
      <div style={styles.header}>
        <button onClick={() => setShowSettings(true)} style={{...styles.smBtn, flex: 1, background: currentTheme.subHeaderBg}}>设置</button>
        <button onClick={() => handleFullRefresh(false)} style={{...styles.smBtn, flex: 1, background: currentTheme.hoverBg}}>全量</button>
        <button onClick={() => setShowTradePanel(true)} style={{...styles.smBtn, flex: 1, background: styles.colors.success, color: '#fff'}}>买卖</button>
        <button onClick={() => setShowBossSettings(true)} style={{...styles.smBtn, flex: 1, background: styles.colors.boss, color: '#000'}}>庄家</button>
        <button onClick={() => setShowStrategyModal(true)} style={{...styles.smBtn, flex: 1, background: '#7c3aed', color: '#fff'}}>策略</button>
        {/* 开始/停止按钮 */}
        {pageMint && (
            isStarted
                ? <button onClick={handleStop}
                    style={{...styles.smBtn, flex: 1, background: '#ef4444', color: '#fff', fontWeight: 'bold'}}>
                    ⏹ 停止
                  </button>
                : <button onClick={handleStart}
                    style={{...styles.smBtn, flex: 1, background: '#22c55e', color: '#fff', fontWeight: 'bold'}}>
                    ▶ 开始
                  </button>
        )}
      </div>

      {/* Mint 状态栏 */}
      {pageMint && (
          <div style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '4px 8px', backgroundColor: '#0d1117',
              borderBottom: '1px solid #1f2937', fontSize: '11px',
              flexWrap: 'nowrap', overflow: 'hidden'
          }}>
              <span
                  style={{ color: '#60a5fa', fontFamily: 'monospace', cursor: 'pointer', flexShrink: 0 }}
                  title={pageMint}
                  onClick={() => navigator.clipboard.writeText(pageMint)}>
                  {pageMint.slice(0,6)}...{pageMint.slice(-4)}
              </span>
              <span style={{ color: '#374151', flexShrink: 0 }}>|</span>
              {hookUrlReady === true && <span style={{ color: '#22c55e', flexShrink: 0 }}>✓ Hook可用</span>}
              {hookUrlReady === false && <span style={{ color: '#f59e0b', flexShrink: 0 }}>⚠ 请刷新页面</span>}
              {hookUrlReady === null && <span style={{ color: '#6b7280', flexShrink: 0 }}>· 待检查</span>}
              <span style={{ color: '#374151', flexShrink: 0 }}>|</span>
              <span style={{ color: isStarted ? '#10b981' : '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {startStage}
              </span>
          </div>
      )}

      {/* Content */}
      {isOpen && (
        <>
          {/* 核心指标 */}
          {heliusMetrics && (
              <>
                  {/* 切换按钮 */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                      {metricsUnit === 'USDT' && solUsdtPrice > 0 && (
                          <span style={{ fontSize: '10px', color: '#6b7280' }}>
                              1 SOL ≈ ${solUsdtPrice.toFixed(0)}
                          </span>
                      )}
                      <button onClick={handleMetricsUnitToggle} style={{
                          fontSize: '10px', padding: '2px 8px', borderRadius: '4px',
                          border: '1px solid #374151',
                          backgroundColor: metricsUnit === 'USDT' ? '#1d4ed8' : '#374151',
                          color: '#fff', cursor: 'pointer'
                      }}>
                          {metricsUnit === 'USDT' ? '$ USDT' : '◎ SOL'}
                      </button>
                  </div>
                  {/* 手动输入 SOL 价格弹框 */}
                  {showPriceInput && (
                      <div style={{
                          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
                      }}>
                          <div style={{ backgroundColor: '#1f2937', borderRadius: '8px', padding: '16px', width: '220px' }}>
                              <div style={{ color: '#fff', fontSize: '13px', marginBottom: '8px' }}>
                                  获取价格失败，请手动输入 SOL/USDT 价格：
                              </div>
                              <input
                                  type="number"
                                  value={manualPriceInput}
                                  onChange={e => setManualPriceInput(e.target.value)}
                                  placeholder="例如：150.5"
                                  style={{
                                      width: '100%', padding: '6px', borderRadius: '4px',
                                      border: '1px solid #374151', backgroundColor: '#111827',
                                      color: '#fff', fontSize: '13px', boxSizing: 'border-box'
                                  }}
                              />
                              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                                  <button onClick={() => {
                                      const p = parseFloat(manualPriceInput);
                                      if (p > 0) {
                                          setSolUsdtPrice(p);
                                          setMetricsUnit('USDT');
                                          setShowPriceInput(false);
                                      }
                                  }} style={{
                                      flex: 1, padding: '6px', backgroundColor: '#1d4ed8',
                                      color: '#fff', border: 'none', borderRadius: '4px',
                                      cursor: 'pointer', fontSize: '12px'
                                  }}>确认</button>
                                  <button onClick={() => setShowPriceInput(false)} style={{
                                      flex: 1, padding: '6px', backgroundColor: '#374151',
                                      color: '#fff', border: 'none', borderRadius: '4px',
                                      cursor: 'pointer', fontSize: '12px'
                                  }}>取消</button>
                              </div>
                          </div>
                      </div>
                  )}
                  <div style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '6px',
                      marginBottom: '8px',
                  }}>
                      {/* 本轮下注 - 左上，橙色，紫色背景 */}
                      <div style={{
                          backgroundColor: '#1e0a3c',
                          borderRadius: '8px',
                          padding: '8px 10px',
                          textAlign: 'center',
                          border: '1px solid #5b21b6'
                      }}>
                          <div style={{ color: '#c4b5fd', fontSize: '11px', marginBottom: '4px' }}>本轮下注</div>
                          <div style={{ color: '#f97316', fontWeight: 'bold', fontSize: '18px', lineHeight: 1.2 }}>
                              {(() => { const m = fmtMetric(heliusMetrics.benLunXiaZhu); return <>{m.value}<span style={{ fontSize: '9px', color: '#c4b5fd', marginLeft: '2px' }}>{m.unit}</span></>; })()}
                          </div>
                      </div>
                      {/* 本轮成本 - 右上，青色 */}
                      <div style={{
                          backgroundColor: '#0c1a2e',
                          borderRadius: '8px',
                          padding: '8px 10px',
                          textAlign: 'center',
                          border: '1px solid #1e3a5f'
                      }}>
                          <div style={{ color: styles.colors.textSecondary, fontSize: '11px', marginBottom: '4px' }}>本轮成本</div>
                          <div style={{ color: '#06b6d4', fontWeight: 'bold', fontSize: '18px', lineHeight: 1.2 }}>
                              {(() => { const m = fmtMetric(heliusMetrics.benLunChengBen); return <>{m.value}<span style={{ fontSize: '9px', color: styles.colors.textSecondary, marginLeft: '2px' }}>{m.unit}</span></>; })()}
                          </div>
                      </div>
                      {/* 已落袋 - 左下，绿色 */}
                      <div style={{
                          backgroundColor: '#0c1a2e',
                          borderRadius: '8px',
                          padding: '8px 10px',
                          textAlign: 'center',
                          border: '1px solid #1e3a5f'
                      }}>
                          <div style={{ color: styles.colors.textSecondary, fontSize: '11px', marginBottom: '4px' }}>已落袋</div>
                          <div style={{ color: '#10b981', fontWeight: 'bold', fontSize: '18px', lineHeight: 1.2 }}>
                              {(() => { const m = fmtMetric(heliusMetrics.yiLuDai); return <>{m.value}<span style={{ fontSize: '9px', color: styles.colors.textSecondary, marginLeft: '2px' }}>{m.unit}</span></>; })()}
                          </div>
                      </div>
                      {/* 浮盈浮亏 - 右下，红/绿 */}
                      <div style={{
                          backgroundColor: '#0c1a2e',
                          borderRadius: '8px',
                          padding: '8px 10px',
                          textAlign: 'center',
                          border: '1px solid #1e3a5f'
                      }}>
                          <div style={{ color: styles.colors.textSecondary, fontSize: '11px', marginBottom: '4px' }}>浮盈浮亏</div>
                          <div style={{ color: heliusMetrics.floatingPnL >= 0 ? '#10b981' : '#ef4444', fontWeight: 'bold', fontSize: '18px', lineHeight: 1.2 }}>
                              {(() => { const m = fmtMetric(heliusMetrics.floatingPnL); return <>{m.value}<span style={{ fontSize: '9px', color: styles.colors.textSecondary, marginLeft: '2px' }}>{m.unit}</span></>; })()}
                          </div>
                      </div>
                  </div>
              </>
          )}

          {/* Custom Short Names List */}
          {customShortNames.length > 0 && (
              <div style={styles.shortNamesContainer}>
                  {customShortNames.map(name => (
                      <label key={name} style={styles.shortNameLabel}>
                          <input 
                              type="checkbox" 
                              style={{ margin: 0 }}
                              onChange={(e) => {
                                  if (e.target.checked) {
                                      handleSetBossByShortName(name);
                                  }
                              }}
                          />
                          {name}
                      </label>
                  ))}
              </div>
          )}

          {/* Filter Bar & Column Settings */}
          <div style={styles.filterBar}>
              {/* 分数筛选下拉框 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ color: styles.colors.textSecondary, fontSize: '11px' }}>Score&lt;</span>
                  <select
                      value={minScore}
                      onChange={e => {
                        const val = parseInt(e.target.value);
                        setMinScore(val);
                        chrome.storage.local.set({ score_threshold: val });
                      }}
                      style={{ background: '#374151', border: 'none', color: '#fff', borderRadius: '2px', fontSize: '11px', padding: '2px' }}
                  >
                      <option value="0">0</option>
                      {[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(v => (
                          <option key={v} value={v}>{v}</option>
                      ))}
                  </select>
              </div>

              <div style={{ marginLeft: 'auto', position: 'relative' }}>
                  <button
                      onClick={() => setShowColSettings(!showColSettings)}
                      style={styles.colSettingsBtn}
                  >
                      列设置 {showColSettings ? '▲' : '▼'}
                  </button>
                  {showColSettings && (
                      <div style={styles.colSettingsPanel}>
                          {/* 字体大小设置 & 主题切换 */}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '4px', borderBottom: `1px solid ${currentTheme.border}`, marginBottom: '4px' }}>
                              <span style={{ fontSize: '11px', color: styles.colors.textSecondary }}>字体</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                  <button onClick={() => updateListFontSize(listFontSize - 1)} style={styles.smBtn}>-</button>
                                  <span style={{ fontSize: '11px', color: currentTheme.text, width: '16px', textAlign: 'center' }}>{listFontSize}</span>
                                  <button onClick={() => updateListFontSize(listFontSize + 1)} style={styles.smBtn}>+</button>
                              </div>
                              {/* 主题切换 */}
                              <button onClick={toggleTheme} style={styles.smBtn} title="切换黑/白主题">
                                  {themeMode === 'dark' ? '🌙' : '🌞'}
                              </button>
                          </div>

                          {/* 列表高度设置 */}
                          <div style={{ paddingBottom: '4px', borderBottom: `1px solid ${currentTheme.border}`, marginBottom: '4px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
                                  <span style={{ fontSize: '11px', color: styles.colors.textSecondary }}>实时交易高度</span>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                      <button onClick={() => { const v = Math.max(80, tradeListHeight - 20); setTradeListHeight(v); chrome.storage.local.set({ gmgn_trade_list_height: v }); }} style={styles.smBtn}>-</button>
                                      <span style={{ fontSize: '11px', color: currentTheme.text, width: '28px', textAlign: 'center' }}>{tradeListHeight}</span>
                                      <button onClick={() => { const v = tradeListHeight + 20; setTradeListHeight(v); chrome.storage.local.set({ gmgn_trade_list_height: v }); }} style={styles.smBtn}>+</button>
                                  </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span style={{ fontSize: '11px', color: styles.colors.textSecondary }}>用户列表高度</span>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                      <button onClick={() => { const v = Math.max(60, userListHeight - 20); setUserListHeight(v); chrome.storage.local.set({ gmgn_user_list_height: v }); }} style={styles.smBtn}>-</button>
                                      <span style={{ fontSize: '11px', color: currentTheme.text, width: '28px', textAlign: 'center' }}>{userListHeight}</span>
                                      <button onClick={() => { const v = userListHeight + 20; setUserListHeight(v); chrome.storage.local.set({ gmgn_user_list_height: v }); }} style={styles.smBtn}>+</button>
                                  </div>
                              </div>
                          </div>

                          {/* 列设置 */}
                          {COLUMN_DEFS.map(col => (
                              <div key={col.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: currentTheme.inputText }}>
                                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', flex: 1 }}>
                                      <input
                                          type="checkbox"
                                          checked={visibleColIds.includes(col.id)}
                                          onChange={() => toggleColumn(col.id)}
                                      />
                                      {col.label}
                                  </label>
                                  {visibleColIds.includes(col.id) && (
                                      <input
                                          type="text"
                                          value={colWidths[col.id] || col.width || (col.flex ? 'flex' : '')}
                                          onChange={(e) => updateColWidth(col.id, e.target.value)}
                                          style={{ ...styles.input, width: '40px' }}
                                          title="列宽 (例如: 50px 或 1fr)"
                                      />
                                  )}
                              </div>
                          ))}
                      </div>
                  )}
              </div>
          </div>

          {/* 实时交易列表 */}
          <RecentTradesList trades={recentTrades} sigFeed={sigFeed} minScore={minScore} metricsUnit={metricsUnit} solUsdtPrice={solUsdtPrice} height={tradeListHeight} />

          {/* List Header */}
          <div style={styles.listHeader}>
              {visibleColIds.map(colId => {
                  const col = COLUMN_DEFS.find(c => c.id === colId);
                  if (!col) return null;
                  
                  const customWidth = colWidths[colId];
                  const style = { 
                      textAlign: col.align || 'left',
                      paddingRight: col.align === 'right' ? '4px' : 0
                  };
                  
                  if (customWidth) {
                      if (customWidth === 'flex' || customWidth.includes('fr')) {
                          style.flex = 1;
                      } else {
                          style.width = customWidth;
                      }
                  } else {
                      style.width = col.width;
                      style.flex = col.flex;
                  }

                  return (
                      <div key={col.id} style={style}>
                          {col.label}
                      </div>
                  );
              })}
          </div>

          {/* List Content */}
          <div style={{
              ...styles.listContent,
              transition: 'opacity 0.15s ease-in-out' // 列表容器过渡
          }}>
              {displayItems.map((it) => (
                  <UserListItem
                      key={it.owner}
                      item={it}
                      isSelected={selectedOwner === it.owner}
                      visibleColIds={visibleColIds}
                      colWidths={colWidths}
                      styles={styles}
                      onSelect={setSelectedOwner}
                      currentPrice={heliusMetrics?.currentPrice || currentPrice || 0}
                      metricsUnit={metricsUnit}
                      solUsdtPrice={solUsdtPrice}
                      onStatusChange={(owner, newStatus) => {
                          // 临时更新 UI 显示
                          const item = items.find(i => i.owner === owner);
                          if (item) {
                              item.status = newStatus;
                              setItems(prev => [...prev]);
                          }

                          // 立即通知 Content Script
                          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                              if (tabs[0]?.id) {
                                  chrome.tabs.sendMessage(tabs[0].id, {
                                      type: 'SET_MANUAL_SCORE',
                                      address: owner,
                                      status: newStatus
                                  });
                              }
                          });
                      }}
                  />
              ))}
          </div>

          {/* Helius 指标 */}
          <div style={{
              ...styles.summary,
              marginTop: '8px'
          }}>
              {/* 行1：标题 + Mint + 启用开关 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '4px' }}>
                  <span style={{ fontWeight: 'bold', color: '#10b981', fontSize: '12px' }}>📊 实时指标</span>
                  {pageMint && (
                      <span
                          style={{ color: '#9ca3af', fontFamily: 'monospace', fontSize: '10px', cursor: 'pointer' }}
                          title={pageMint}
                          onClick={() => { navigator.clipboard.writeText(pageMint); addLog('Mint已复制'); }}
                      >
                          {pageMint.slice(0, 6)}...{pageMint.slice(-4)}
                      </span>
                  )}
                  <span style={{ color: styles.colors.border }}>|</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '3px', cursor: 'pointer', fontSize: '10px', color: styles.colors.textSecondary }}
                      title="关闭后仍会接收 GMGN 数据，但不调用 Helius API">
                      <input type="checkbox" checked={heliusMonitorEnabled} onChange={e => toggleHeliusMonitor(e.target.checked)} style={{ cursor: 'pointer', margin: 0 }} />
                      Helius
                  </label>
                  {/* WS状态 */}
                  {heliusMonitorEnabled && (
                      <>
                          <span style={{ color: styles.colors.border }}>|</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '10px' }}
                              title={heliusWsStatus.error ? `错误: ${heliusWsStatus.error}` : (heliusWsStatus.reconnectCount > 0 ? `重连 ${heliusWsStatus.reconnectCount} 次` : '')}>
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: heliusWsStatus.connected ? '#10b981' : '#ef4444', display: 'inline-block', flexShrink: 0 }}></span>
                              <span style={{ color: heliusWsStatus.connected ? '#10b981' : '#ef4444' }}>WS</span>
                          </span>
                      </>
                  )}
              </div>

              {/* 行2：指标数据一行 */}
              {heliusMetrics ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '10px', color: styles.colors.textSecondary }}>
                      <span><span style={{ color: '#9ca3af' }}>活跃</span> {heliusMetrics.activeCount}</span>
                      <span style={{ color: styles.colors.border }}>|</span>
                      <span><span style={{ color: '#9ca3af' }}>退出</span> {heliusMetrics.exitedCount}</span>
                      {heliusStats && (
                          <>
                              <span style={{ color: styles.colors.border }}>|</span>
                              <span title={`Helius获取: ${heliusStats.heliusFetchedTotal || 0} | WS=${heliusStats.bySources.websocket} 插件=${heliusStats.bySources.plugin}`}>
                                  处理 {heliusStats.isProcessed}/{heliusStats.total}
                              </span>
                              <span style={{ color: styles.colors.border }}>|</span>
                              <span style={{ color: heliusStats.needFetch === 0 ? '#10b981' : '#f59e0b' }}>
                                  {heliusStats.needFetch === 0 ? `✓ Sig${heliusStats.total}` : `⚠ Sig${heliusStats.hasData}/${heliusStats.total}`}
                              </span>
                              {heliusMetrics.skippedWhaleCount > 0 && (
                                  <>
                                      <span style={{ color: styles.colors.border }}>|</span>
                                      <span>跳庄 {heliusMetrics.skippedWhaleCount}</span>
                                  </>
                              )}
                          </>
                      )}
                  </div>
              ) : (
                  <div style={{ fontSize: '10px', color: styles.colors.textSecondary, fontStyle: 'italic' }}>等待 mint 数据...</div>
              )}
              {heliusWsStatus.error && (
                  <div style={{ fontSize: '9px', color: '#ef4444', marginTop: '2px' }}>WS错误: {heliusWsStatus.error}</div>
              )}

              {/* 数据流日志控制 */}
              <div style={{
                  marginTop: '8px',
                  padding: '8px',
                  backgroundColor: styles.colors.cardBg,
                  borderRadius: '4px',
                  border: `1px solid ${styles.colors.border}`
              }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 'bold' }}>📋 数据流日志</span>
                      <label style={{
                          fontSize: '10px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          cursor: 'pointer',
                          color: styles.colors.textSecondary
                      }}>
                          <input
                              type="checkbox"
                              checked={dataFlowLoggerEnabled}
                              onChange={e => toggleDataFlowLogger(e.target.checked)}
                              style={{ cursor: 'pointer' }}
                          />
                          启用日志
                      </label>
                  </div>
                  {/* 翻页设置 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', marginBottom: '6px', paddingBottom: '6px', borderBottom: `1px solid ${styles.colors.border}` }}>
                      <span style={{ color: styles.colors.textSecondary, whiteSpace: 'nowrap' }}>最大翻页</span>
                      <input
                          type="number" min="1" max="500"
                          value={maxPages}
                          onChange={e => {
                              const v = Math.max(1, parseInt(e.target.value) || 1);
                              setMaxPages(v);
                              chrome.storage.local.set({ gmgn_max_pages: v });
                          }}
                          style={{ ...styles.input, width: '45px' }}
                          title="每次 GMGN 分页最多翻几页（默认30）"
                      />
                      <span style={{ color: styles.colors.textSecondary, whiteSpace: 'nowrap' }}>间隔(ms)</span>
                      <input
                          type="number" min="0" max="10000"
                          value={pageDelay}
                          onChange={e => {
                              const v = Math.max(0, parseInt(e.target.value) || 0);
                              setPageDelay(v);
                              chrome.storage.local.set({ gmgn_page_delay: v });
                          }}
                          style={{ ...styles.input, width: '55px' }}
                          title="每翻一页前暂停的毫秒数（默认1000）"
                      />
                  </div>

                  <div style={{ display: 'flex', gap: '4px', fontSize: '10px' }}>
                      <button
                          onClick={viewLogs}
                          style={{
                              ...styles.smBtn,
                              flex: 1,
                              padding: '4px 8px',
                              backgroundColor: '#3b82f6',
                              color: '#fff'
                          }}
                      >
                          查看日志 ({logStats.total})
                      </button>
                      <button
                          onClick={exportLogs}
                          style={{
                              ...styles.smBtn,
                              flex: 1,
                              padding: '4px 8px',
                              backgroundColor: '#10b981',
                              color: '#fff'
                          }}
                      >
                          导出
                      </button>
                      <button
                          onClick={clearLogs}
                          style={{
                              ...styles.smBtn,
                              flex: 1,
                              padding: '4px 8px',
                              backgroundColor: '#ef4444',
                              color: '#fff'
                          }}
                      >
                          清空
                      </button>
                  </div>
                  {logStats.total > 0 && (
                      <div style={{ fontSize: '9px', color: styles.colors.textSecondary, marginTop: '4px' }}>
                          来源: {Object.entries(logStats.bySources).map(([source, count]) => `${source}=${count}`).join(' | ')}
                      </div>
                  )}
              </div>
          </div>

          {/* Detail Modal */}
          {selectedItem && (
              <div
                  onClick={() => setSelectedOwner(null)}
                  style={{
                      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                      backgroundColor: 'rgba(0,0,0,0.6)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      zIndex: 9999
                  }}
              >
                  <div
                      onClick={e => e.stopPropagation()}
                      style={{
                          background: styles.colors.cardBg || '#1f2937',
                          border: `1px solid ${styles.colors.border}`,
                          borderRadius: '8px',
                          padding: '12px',
                          width: '92%',
                          maxHeight: '80vh',
                          overflowY: 'auto',
                          fontSize: '11px',
                          color: styles.colors.text,
                          lineHeight: '1.6'
                      }}
                  >
                      {/* Modal Header */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', borderBottom: `1px solid ${styles.colors.border}`, paddingBottom: '6px' }}>
                          <span style={{ fontWeight: 'bold', color: '#60a5fa', fontSize: '12px' }}>📋 用户详情</span>
                          <button
                              onClick={() => setSelectedOwner(null)}
                              style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: '0 4px' }}
                          >×</button>
                      </div>

                      {/* 基本信息 */}
                      <div style={{ color: '#60a5fa', fontWeight: 'bold', marginBottom: '4px' }}>📋 基本信息</div>
                      owner: {selectedItem.owner}<br/>
                      data_source: {selectedItem.data_source || '未知'}<br/>
                      status: {selectedItem.status}<br/>
                      score: {selectedItem.score || 0}<br/>

                      {/* 持仓信息 */}
                      <div style={{ color: '#60a5fa', fontWeight: 'bold', marginTop: '8px', marginBottom: '4px' }}>💰 持仓信息</div>
                      amount: {selectedItem.ui_amount !== undefined && selectedItem.ui_amount !== null ? parseFloat(selectedItem.ui_amount).toFixed(2) : (selectedItem.amount || '-')}<br/>
                      holding_pct: {selectedItem.holding_share_pct || '-'}%<br/>
                      buy_u: {selectedItem.total_buy_u !== undefined && selectedItem.total_buy_u !== null ? parseFloat(selectedItem.total_buy_u).toFixed(6) : '-'} SOL<br/>
                      sell_u: {selectedItem.total_sell_u !== undefined && selectedItem.total_sell_u !== null ? parseFloat(selectedItem.total_sell_u).toFixed(6) : '-'} SOL<br/>
                      netflow: {selectedItem.netflow_amount !== undefined && selectedItem.netflow_amount !== null ? parseFloat(selectedItem.netflow_amount).toFixed(6) : '-'} SOL<br/>
                      计算来源: {selectedItem.trade_sig_count !== undefined ? `${selectedItem.trade_sig_count} 笔 trade sig` : '-'}<br/>

                      {/* 资金来源 */}
                      <div style={{ color: '#60a5fa', fontWeight: 'bold', marginTop: '8px', marginBottom: '4px' }}>🔗 资金来源</div>
                      funding_account: {selectedItem.funding_account || '无'}<br/>
                      source_text: {selectedItem.source_text || '-'}<br/>
                      wallet_age: {selectedItem.wallet_age || '-'}<br/>
                      sol_balance: {selectedItem.sol_balance || '-'}<br/>

                      {/* 时间信息 */}
                      <div style={{ color: '#60a5fa', fontWeight: 'bold', marginTop: '8px', marginBottom: '4px' }}>⏰ 时间信息</div>
                      created_at: {selectedItem.created_at ? new Date(selectedItem.created_at * 1000).toLocaleString('zh-CN') : '-'}<br/>
                      open_timestamp: {selectedItem.open_timestamp ? new Date(selectedItem.open_timestamp * 1000).toLocaleString('zh-CN') : '-'}<br/>

                      {/* Native Transfer 信息 */}
                      {selectedItem.native_transfer && (
                          <>
                              <div style={{ color: '#60a5fa', fontWeight: 'bold', marginTop: '8px', marginBottom: '4px' }}>💸 SOL 转账信息</div>
                              from: {selectedItem.native_transfer.from || '-'}<br/>
                              amount: {selectedItem.native_transfer.amount || '-'} SOL<br/>
                              timestamp: {selectedItem.native_transfer.timestamp ? new Date(selectedItem.native_transfer.timestamp * 1000).toLocaleString('zh-CN') : '-'}<br/>
                          </>
                      )}

                      {/* Trace 信息 */}
                      {selectedItem.trace && selectedItem.trace.length > 0 && (
                          <>
                              <div style={{ color: '#60a5fa', fontWeight: 'bold', marginTop: '8px', marginBottom: '4px' }}>🔍 Trace 信息 ({selectedItem.trace.length}条)</div>
                              {selectedItem.trace.slice(0, 5).map((t, i) => (
                                  <div key={i} style={{ marginLeft: '8px', fontSize: '10px', color: '#9ca3af' }}>
                                      [{i+1}] {t.from ? `${t.from.substring(0,8)}...` : 'unknown'} → {t.amount || 0} SOL
                                  </div>
                              ))}
                              {selectedItem.trace.length > 5 && (
                                  <div style={{ marginLeft: '8px', fontSize: '10px', color: '#6b7280' }}>
                                      ... 还有 {selectedItem.trace.length - 5} 条
                                  </div>
                              )}
                          </>
                      )}

                      {/* 庄家得分详情 */}
                      {(selectedItem.score || 0) > 0 && (
                          <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #374151' }}>
                              <div style={{ color: '#f59e0b', fontWeight: 'bold', marginBottom: '4px' }}>
                                  🎯 庄家得分: {selectedItem.score}
                              </div>
                              <div style={{ fontSize: '10px', color: '#d1d5db', lineHeight: '1.4' }}>
                                  {(selectedItem.score_reasons || []).map((r, i) => (
                                      <div key={i}>• {r}</div>
                                  ))}
                              </div>
                          </div>
                      )}

                      {/* 完整数据（调试用） */}
                      <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #374151' }}>
                          <div style={{ color: '#6b7280', fontSize: '10px', cursor: 'pointer' }}
                               onClick={() => {
                                   navigator.clipboard.writeText(JSON.stringify(selectedItem, null, 2));
                                   addLog('用户数据已复制到剪贴板');
                               }}>
                              💾 点击复制完整数据到剪贴板
                          </div>
                      </div>
                  </div>
              </div>
          )}
          
          {/* Footer Status Bar */}
          <div style={styles.footer}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                  <div style={{ color: '#6b7280', fontFamily: 'monospace', cursor: 'pointer' }} title={pageMint} onClick={() => { navigator.clipboard.writeText(pageMint); addLog('Mint已复制'); }}>
                      Mint: {pageMint ? `${pageMint.slice(0,6)}...${pageMint.slice(-4)}` : 'Scanning...'}
                  </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {/* [新增] 页面观察者状态指示器 (自定义地址) */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginRight: '8px' }}>
                      <span style={{ fontSize: '10px', color: '#9ca3af' }}>自定义地址</span>
                      <div 
                          style={{ 
                              width: '6px', 
                              height: '6px', 
                              borderRadius: '50%', 
                              background: pageObserverStatus.status === 'ok' ? '#22c55e' : (pageObserverStatus.status === 'error' ? '#ef4444' : '#f59e0b'),
                              boxShadow: pageObserverStatus.status === 'ok' ? '0 0 4px #22c55e' : 'none'
                          }} 
                          title={`列表监听状态: ${pageObserverStatus.msg}`}
                      />
                  </div>

                  {/* [新增] 价格监听状态指示器 */}
                  <div 
                      style={{ 
                          width: '6px', 
                          height: '6px', 
                          borderRadius: '50%', 
                          background: priceDomStatus.status === 'ok' ? '#22c55e' : (priceDomStatus.status === 'error' ? '#ef4444' : '#f59e0b'),
                          boxShadow: priceDomStatus.status === 'ok' ? '0 0 4px #22c55e' : 'none'
                      }} 
                      title={`价格监听状态: ${priceDomStatus.msg}`}
                  />
                  {currentPrice > 0 && <div style={{ color: styles.colors.success, fontWeight: 'bold' }}>${currentPrice}</div>}
              </div>
          </div>

          {/* Status Logs */}
          <div style={{ ...styles.statusLogs, maxHeight: '60px' }}>
              {statusLogs.map((log, idx) => (
                  <div key={idx} style={{ marginBottom: '2px' }}>{log}</div>
              ))}
          </div>

          {/* Debug Info Footer */}
          {debugInfo && (
              <div style={styles.debugInfo}>
                  {debugInfo}
              </div>
          )}
        </>
      )}
              

      {/* Modals */}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} onOpenBossSettings={() => setShowBossSettings(true)} onOpenStrategy={() => setShowStrategyModal(true)} scoreManager={scoreManagerRef.current} />}
      {showBossSettings && <BossSettingsModal onClose={() => setShowBossSettings(false)} onAnalyze={() => handleFullRefresh(false)} />}
      {showStrategyModal && <AdvancedStrategyModal onClose={() => setShowStrategyModal(false)} />}

      {/* 日志查看器 */}
      {showLogViewer && (
          <div style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10000
          }}>
              <div style={{
                  backgroundColor: styles.colors.cardBg,
                  borderRadius: '8px',
                  padding: '16px',
                  width: '90%',
                  maxWidth: '800px',
                  maxHeight: '80vh',
                  overflow: 'auto',
                  border: `1px solid ${styles.colors.border}`
              }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <h3 style={{ margin: 0, fontSize: '14px' }}>数据流日志</h3>
                      <button
                          onClick={() => setShowLogViewer(false)}
                          style={{
                              ...styles.smBtn,
                              backgroundColor: '#ef4444',
                              color: '#fff'
                          }}
                      >
                          关闭
                      </button>
                  </div>
                  <div style={{ fontSize: '11px', color: styles.colors.textSecondary, marginBottom: '8px' }}>
                      总计: {logStats.total} 条 | 来源: {Object.entries(logStats.bySources).map(([source, count]) => `${source}=${count}`).join(', ')}
                  </div>
                  <div style={{
                      fontSize: '10px',
                      fontFamily: 'monospace',
                      backgroundColor: '#1f2937',
                      padding: '8px',
                      borderRadius: '4px',
                      maxHeight: '60vh',
                      overflow: 'auto'
                  }}>
                      <div style={{ color: '#9ca3af' }}>
                          查看控制台获取完整日志，或点击"导出"按钮下载日志文件
                      </div>
                  </div>
              </div>
          </div>
      )}
      {showStrategyModal && <AdvancedStrategyModal onClose={() => setShowStrategyModal(false)} mint={pageMint} price={currentPrice} />}
      {showTradePanel && <TradePanel onClose={() => setShowTradePanel(false)} fixedBuyAmounts={fixedBuyAmounts} fixedSellPcts={fixedSellPcts} mint={pageMint} price={currentPrice} />}
    </div>
  );
};

export default App;
