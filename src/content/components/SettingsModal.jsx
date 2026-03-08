import React, { useState, useEffect, useRef } from 'react';
import { stoSet } from '../../utils/api';

const SettingsModal = ({ onClose, onSave, scoreManager }) => {
    // 基础配置
    const [envKeys, setEnvKeys] = useState('');
    const [holderLimit, setHolderLimit] = useState(100);
    const [holderMax, setHolderMax] = useState(1000);
    const [autoUpdateSec, setAutoUpdateSec] = useState(2);
    const [bossDetectSec, setBossDetectSec] = useState(10); // 新增状态
    
    // 开关配置
    const [hookRefreshEnabled, setHookRefreshEnabled] = useState(false); // Hook 自动刷新

    const [apiRefreshEnabled, setApiRefreshEnabled] = useState(false);   // API 自动刷新
    const [activityMonitorEnabled, setActivityMonitorEnabled] = useState(false); // 活动数据监听
    const [activityMonitorInterval, setActivityMonitorInterval] = useState(3);   // 活动数据刷新间隔
    const [observerEnabled, setObserverEnabled] = useState(false);
    const [observerInterval, setObserverInterval] = useState(500);
    // [新增] 火焰阈值
    const [fireThreshold1, setFireThreshold1] = useState(100);
    const [fireThreshold2, setFireThreshold2] = useState(200);
    const [fireThreshold3, setFireThreshold3] = useState(300);

    // [新增] 自动同步备注
    const [autoSyncRemarks, setAutoSyncRemarks] = useState(false);

    // Helius 配置
    const [heliusApiKey, setHeliusApiKey] = useState('');

    // 交易配置
    const [tradeMode, setTradeMode] = useState('backend');
    const [pumpPortalKey, setPumpPortalKey] = useState('');
    const [slippage, setSlippage] = useState(10);
    const [priorityFee, setPriorityFee] = useState(0.00005);
    const [pool, setPool] = useState('auto');
    
    // 固定买卖
    const [fixedBuy1, setFixedBuy1] = useState(0.01);
    const [fixedBuy2, setFixedBuy2] = useState(0.05);
    const [fixedBuy3, setFixedBuy3] = useState(0.1);
    const [fixedSell1, setFixedSell1] = useState(25);
    const [fixedSell2, setFixedSell2] = useState(50);
    const [fixedSell3, setFixedSell3] = useState(100);

    // 文件输入引用
    const fileShortRef = useRef(null);
    const fileStatusRef = useRef(null);
    const bossConfigRef = useRef({});
    const [statusMsg, setStatusMsg] = useState('');

    useEffect(() => {
        chrome.storage.local.get([
            'env_keys', 'holder_limit', 'holder_max', 'auto_update_sec', 'boss_detect_sec',
            'hook_refresh_enabled',
            'api_refresh_enabled', 'activity_monitor_enabled', 'activity_monitor_interval', 'observer_enabled', 'observer_interval', 'boss_rule_source_empty', 'boss_rule_activity',
            'auto_sync_remarks', // [新增]
            'helius_api_key',
            'trade_mode', 'pumpportal_key', 'slippage', 'priority_fee', 'pool',
            'fixed_buy_sol', 'fixed_sell_pct'
        ], (res) => {
            if(res.env_keys) setEnvKeys(Array.isArray(res.env_keys) ? res.env_keys.join('\n') : '');
            if(res.holder_limit) setHolderLimit(res.holder_limit);
            if(res.holder_max) setHolderMax(res.holder_max);
            if(res.auto_update_sec) setAutoUpdateSec(res.auto_update_sec);
            if(res.boss_detect_sec) setBossDetectSec(res.boss_detect_sec);
            
            if(res.hook_refresh_enabled !== undefined) setHookRefreshEnabled(res.hook_refresh_enabled);

            if(res.api_refresh_enabled !== undefined) setApiRefreshEnabled(res.api_refresh_enabled);
            if(res.activity_monitor_enabled !== undefined) setActivityMonitorEnabled(res.activity_monitor_enabled);
            if(res.activity_monitor_interval) setActivityMonitorInterval(res.activity_monitor_interval);
            if(res.observer_enabled !== undefined) setObserverEnabled(res.observer_enabled);
            if(res.observer_interval) setObserverInterval(res.observer_interval);
            
            if(res.auto_sync_remarks !== undefined) setAutoSyncRemarks(res.auto_sync_remarks);

            if(res.boss_config) {
                bossConfigRef.current = res.boss_config;
                const ft = res.boss_config.fire_thresholds;
                if(Array.isArray(ft)) {
                    setFireThreshold1(ft[0] ?? 100);
                    setFireThreshold2(ft[1] ?? 200);
                    setFireThreshold3(ft[2] ?? 300);
                }
            }

            if(res.helius_api_key) setHeliusApiKey(res.helius_api_key);
            if(res.trade_mode) setTradeMode(res.trade_mode);
            if(res.pumpportal_key) setPumpPortalKey(res.pumpportal_key);
            if(res.slippage) setSlippage(res.slippage);
            if(res.priority_fee) setPriorityFee(res.priority_fee);
            if(res.pool) setPool(res.pool);

            if(Array.isArray(res.fixed_buy_sol)) {
                setFixedBuy1(res.fixed_buy_sol[0] ?? 0.01);
                setFixedBuy2(res.fixed_buy_sol[1] ?? 0.05);
                setFixedBuy3(res.fixed_buy_sol[2] ?? 0.1);
            }
            if(Array.isArray(res.fixed_sell_pct)) {
                setFixedSell1(res.fixed_sell_pct[0] ?? 25);
                setFixedSell2(res.fixed_sell_pct[1] ?? 50);
                setFixedSell3(res.fixed_sell_pct[2] ?? 100);
            }
        });
    }, []);

    const handleSave = async () => {
        const keys = envKeys.split(/[\n,;]+/).map(k => k.trim()).filter(Boolean);
        const config = {
            env_keys: keys,
            holder_limit: parseInt(holderLimit),
            holder_max: parseInt(holderMax),
            auto_update_sec: parseInt(autoUpdateSec),
            boss_detect_sec: parseInt(bossDetectSec),
            
            hook_refresh_enabled: hookRefreshEnabled,

            api_refresh_enabled: apiRefreshEnabled,
            activity_monitor_enabled: activityMonitorEnabled,
            activity_monitor_interval: parseInt(activityMonitorInterval),
            observer_enabled: observerEnabled,
            observer_interval: parseInt(observerInterval),
            
            auto_sync_remarks: autoSyncRemarks,

            boss_config: {
                ...bossConfigRef.current,
                fire_thresholds: [
                    parseInt(fireThreshold1) || 100,
                    parseInt(fireThreshold2) || 200,
                    parseInt(fireThreshold3) || 300
                ]
            },

            helius_api_key: heliusApiKey.trim(),
            trade_mode: tradeMode,
            pumpportal_key: pumpPortalKey.trim(),
            slippage: parseFloat(slippage),
            priority_fee: parseFloat(priorityFee),
            pool: pool,

            fixed_buy_sol: [parseFloat(fixedBuy1), parseFloat(fixedBuy2), parseFloat(fixedBuy3)].filter(n => !isNaN(n)),
            fixed_sell_pct: [parseInt(fixedSell1), parseInt(fixedSell2), parseInt(fixedSell3)].filter(n => !isNaN(n))
        };
        
        await stoSet(config);
        
        // 发送消息通知 observer 更新
        window.postMessage({
            type: 'GMGN_OBSERVER_TOGGLE',
            enabled: observerEnabled,
            interval: parseInt(observerInterval)
        }, '*');

        onSave && onSave();
        onClose();
    };

    // 数据管理函数
    const handleExport = (type) => {
        const manager = scoreManager || window.gmgnScoreManager;
        if(!manager) {
            setStatusMsg('错误: Manager 未初始化');
            return;
        }
        const json = type === 'short' ? manager.exportShortAddressMap() : manager.exportStatusMap();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = type === 'short' ? 'gmgn_short_map.json' : 'gmgn_holder_status.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setStatusMsg(`已导出${type === 'short' ? '短地址' : '持有者状态'}数据`);
    };

    const handleImport = (e, type) => {
        const file = e.target.files[0];
        if(!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            const manager = scoreManager || window.gmgnScoreManager;
            if(manager) {
                const count = type === 'short' 
                    ? manager.importShortAddressMap(evt.target.result)
                    : manager.importStatusMap(evt.target.result);
                setStatusMsg(`成功导入 ${count} 条数据`);
                if(window.gmgnRender) window.gmgnRender(manager.getSortedItems(), true);
            } else {
                setStatusMsg('错误: Manager 未初始化');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const handleClear = (type) => {
        if(!confirm(`确定要清空所有${type === 'short' ? '短地址' : '持有者状态'}数据吗？此操作不可撤销。`)) return;
        const manager = scoreManager || window.gmgnScoreManager;
        if(manager) {
            type === 'short' ? manager.clearShortAddressMap() : manager.clearStatusMap();
            setStatusMsg(`已清空${type === 'short' ? '短地址' : '持有者状态'}数据`);
            // 触发刷新
            if(window.gmgn_doFull) window.gmgn_doFull(true);
        } else {
            setStatusMsg('错误: Manager 未初始化');
        }
    };

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.7)', zIndex: 2147483647,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px'
        }}>
            <div style={{
                background: '#1f2937', color: '#e5e7eb', width: '450px', maxHeight: '90vh', overflowY: 'auto',
                padding: '20px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                display: 'flex', flexDirection: 'column', gap: '10px'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ margin: 0 }}>设置</h3>
                    <span style={{ color: '#10b981' }}>{statusMsg}</span>
                </div>

                {/* 功能入口 (已移回主界面) */}
                {/* <div style={{ display: 'flex', gap: '10px', margin: '10px 0', paddingBottom: '10px', borderBottom: '1px dashed #374151' }}>
                    <button onClick={() => { 
                        if (onOpenBossSettings) onOpenBossSettings();
                        setTimeout(onClose, 50); 
                    }} style={{ flex: 1, background: '#f59e0b', color: '#000', border: 'none', padding: '8px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                        庄家判断
                    </button>
                    <button onClick={() => { 
                        if (onOpenStrategy) onOpenStrategy();
                        setTimeout(onClose, 50);
                    }} style={{ flex: 1, background: '#7c3aed', color: '#fff', border: 'none', padding: '8px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                        高级策略
                    </button>
                </div> */}
                
                {/* 基础设置 */}
                <div className="section" style={sectionStyle}>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>Limit / Max</label>
                        <input type="number" value={holderLimit} onChange={e=>setHolderLimit(e.target.value)} style={inputStyle} placeholder="100"/>
                        <input type="number" value={holderMax} onChange={e=>setHolderMax(e.target.value)} style={inputStyle} placeholder="1000"/>
                    </div>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>API Keys</label>
                        <textarea value={envKeys} onChange={e=>setEnvKeys(e.target.value)} rows={2} style={{...inputStyle, resize:'vertical'}} placeholder="Birdeye Key, 每行一个"></textarea>
                    </div>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>Helius Key</label>
                        <input type="password" value={heliusApiKey} onChange={e=>setHeliusApiKey(e.target.value)} style={inputStyle} placeholder="Helius API Key"/>
                    </div>
                </div>

                {/* 交易设置 */}
                <div className="section" style={sectionStyle}>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>支付模式</label>
                        <select value={tradeMode} onChange={e=>setTradeMode(e.target.value)} style={inputStyle}>
                            <option value="backend">后端 API (Local)</option>
                            <option value="frontend">前端支付 (Portal)</option>
                        </select>
                    </div>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>Portal Key</label>
                        <input type="password" value={pumpPortalKey} onChange={e=>setPumpPortalKey(e.target.value)} style={inputStyle} placeholder="PumpPortal API Key"/>
                    </div>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>滑点(%) / 优先费</label>
                        <input type="number" value={slippage} onChange={e=>setSlippage(e.target.value)} style={inputStyle} placeholder="10"/>
                        <input type="number" value={priorityFee} onChange={e=>setPriorityFee(e.target.value)} style={inputStyle} placeholder="0.00005"/>
                    </div>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>Pool</label>
                        <select value={pool} onChange={e=>setPool(e.target.value)} style={inputStyle}>
                            <option value="auto">auto (默认)</option>
                            <option value="pump">pump</option>
                            <option value="raydium">raydium</option>
                            <option value="pump-amm">pump-amm</option>
                            <option value="launchlab">launchlab</option>
                            <option value="raydium-cpmm">raydium-cpmm</option>
                            <option value="bonk">bonk</option>
                        </select>
                    </div>
                </div>

                {/* 快捷金额 */}
                <div className="section" style={sectionStyle}>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>买入 SOL</label>
                        <input type="number" value={fixedBuy1} onChange={e=>setFixedBuy1(e.target.value)} style={inputStyle}/>
                        <input type="number" value={fixedBuy2} onChange={e=>setFixedBuy2(e.target.value)} style={inputStyle}/>
                        <input type="number" value={fixedBuy3} onChange={e=>setFixedBuy3(e.target.value)} style={inputStyle}/>
                    </div>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>卖出 %</label>
                        <input type="number" value={fixedSell1} onChange={e=>setFixedSell1(e.target.value)} style={inputStyle}/>
                        <input type="number" value={fixedSell2} onChange={e=>setFixedSell2(e.target.value)} style={inputStyle}/>
                        <input type="number" value={fixedSell3} onChange={e=>setFixedSell3(e.target.value)} style={inputStyle}/>
                    </div>
                </div>

                {/* 定时与开关 */}
                <div className="section" style={sectionStyle}>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>刷新间隔(秒)</label>
                        <input type="number" value={autoUpdateSec} onChange={e=>setAutoUpdateSec(e.target.value)} style={inputStyle} title="自动更新间隔"/>
                        <input type="number" value={bossDetectSec} onChange={e=>setBossDetectSec(e.target.value)} style={inputStyle} title="庄家判断间隔"/>
                    </div>
                    <div className="row" style={{...rowStyle, alignItems: 'flex-start'}}>
                        <label style={{...labelStyle, paddingTop: '4px'}}>持有人启动</label>
                        <div style={{display:'flex', flexDirection:'column', gap:'5px', flex:1}}>
                            <label style={checkLabelStyle}>
                                <input
                                    type="checkbox"
                                    checked={hookRefreshEnabled}
                                    onChange={e => setHookRefreshEnabled(e.target.checked)}
                                />
                                开启自动刷新
                            </label>
                        </div>
                    </div>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>自动刷新源</label>
                        {/* 移除旧的 Hook 选项，保留 API 选项 */}
                        <label style={checkLabelStyle}><input type="checkbox" checked={apiRefreshEnabled} onChange={e=>setApiRefreshEnabled(e.target.checked)}/> Birdeye(API)</label>
                        <label style={{...checkLabelStyle, marginLeft:'10px'}} title="自动获取GMGN备注并同步"><input type="checkbox" checked={autoSyncRemarks} onChange={e=>setAutoSyncRemarks(e.target.checked)}/> 同步GMGN备注</label>
                    </div>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>活动监听</label>
                        <label style={checkLabelStyle}><input type="checkbox" checked={activityMonitorEnabled} onChange={e=>setActivityMonitorEnabled(e.target.checked)}/> 开启交易监听</label>
                        <div style={{display:'flex', alignItems:'center', gap:'4px', marginLeft:'8px'}}>
                            <input 
                                type="number" 
                                value={activityMonitorInterval} 
                                onChange={e => setActivityMonitorInterval(e.target.value)} 
                                style={{...inputStyle, maxWidth:'60px'}} 
                                min="1"
                                title="活动数据刷新间隔 (秒)"
                            />
                            <span style={{color:'#9ca3af'}}>s</span>
                        </div>
                    </div>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>页面功能</label>
                        <label style={checkLabelStyle}><input type="checkbox" checked={observerEnabled} onChange={e=>setObserverEnabled(e.target.checked)}/> 页面监听</label>
                        <div style={{display:'flex', alignItems:'center', gap:'4px', marginLeft:'8px'}}>
                            <input 
                                type="number" 
                                value={observerInterval / 1000} 
                                onChange={e => setObserverInterval(Math.round(parseFloat(e.target.value) * 1000))} 
                                style={{...inputStyle, maxWidth:'60px'}} 
                                step="0.1"
                                title="防抖间隔 (秒)"
                            />
                            <span style={{color:'#9ca3af'}}>s</span>
                        </div>
                    </div>
                    {/* [新增] 火焰阈值设置 */}
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>火焰阈值($)</label>
                        <input type="number" value={fireThreshold1} onChange={e=>setFireThreshold1(e.target.value)} style={inputStyle} placeholder="1火" title="1个火焰的买入USD阈值"/>
                        <input type="number" value={fireThreshold2} onChange={e=>setFireThreshold2(e.target.value)} style={inputStyle} placeholder="2火" title="2个火焰的买入USD阈值"/>
                        <input type="number" value={fireThreshold3} onChange={e=>setFireThreshold3(e.target.value)} style={inputStyle} placeholder="3火" title="3个火焰的买入USD阈值"/>
                    </div>
                </div>

                {/* 数据管理 */}
                <div className="section" style={{...sectionStyle, borderTop:'1px dashed #374151', paddingTop:'10px'}}>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>短地址</label>
                        <button onClick={()=>handleExport('short')} style={smBtnStyle}>导出</button>
                        <button onClick={()=>fileShortRef.current.click()} style={smBtnStyle}>导入</button>
                        <button onClick={()=>handleClear('short')} style={{...smBtnStyle, background:'#dc2626'}}>清除</button>
                        <input type="file" ref={fileShortRef} onChange={(e)=>handleImport(e, 'short')} style={{display:'none'}} accept=".json"/>
                    </div>
                    <div className="row" style={rowStyle}>
                        <label style={labelStyle}>持有者状态</label>
                        <button onClick={()=>handleExport('status')} style={smBtnStyle}>导出</button>
                        <button onClick={()=>fileStatusRef.current.click()} style={smBtnStyle}>导入</button>
                        <button onClick={()=>handleClear('status')} style={{...smBtnStyle, background:'#dc2626'}}>清除</button>
                        <input type="file" ref={fileStatusRef} onChange={(e)=>handleImport(e, 'status')} style={{display:'none'}} accept=".json"/>
                    </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
                    <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #4b5563', color: '#e5e7eb', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer' }}>取消</button>
                    <button onClick={handleSave} style={{ background: '#2563eb', border: 'none', color: '#fff', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer' }}>保存</button>
                </div>
            </div>
        </div>
    );
};

// 样式定义
const sectionStyle = { marginBottom: '10px' };
const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' };
const labelStyle = { width: '80px', fontSize: '12px', color: '#9ca3af', flexShrink: 0 };
const inputStyle = { flex: 1, background: '#111827', border: '1px solid #374151', color: '#fff', borderRadius: '4px', padding: '4px', minWidth: '0' };
const checkLabelStyle = { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', cursor: 'pointer', color: '#e5e7eb' };
const smBtnStyle = { background: '#4b5563', color: '#fff', border: 'none', borderRadius: '4px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer' };

export default SettingsModal;
