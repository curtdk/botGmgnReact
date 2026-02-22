import React, { useState, useEffect, useRef } from 'react';
import PortalPay from '../../utils/PortalPay';
import { doTrade } from '../../utils/trade';
// import { getPriceFromPage } from '../../utils/api'; // 已废弃，改用 props

const AdvancedStrategyModal = ({ onClose, mint, price }) => {
    const [jsonConfig, setJsonConfig] = useState('');
    const [logs, setLogs] = useState([]);
    const [status, setStatus] = useState('就绪');
    const [isRunning, setIsRunning] = useState(false);
    const [template, setTemplate] = useState('');
    
    // 拖拽相关状态
    const [position, setPosition] = useState({ x: window.innerWidth / 2 - 250, y: window.innerHeight / 2 - 300 });
    const [isDragging, setIsDragging] = useState(false);
    const dragStartPos = useRef({ x: 0, y: 0 });
    const modalStartPos = useRef({ x: 0, y: 0 });

    const logsEndRef = useRef(null);

    // 绑定日志回调
    useEffect(() => {
        // 加载当前状态
        if (PortalPay.isActive()) {
            setIsRunning(true);
            setLogs(PortalPay.getLogs());
            setStatus('策略运行中...');
            
            // 恢复配置显示
            const cfg = PortalPay._strategy.config;
            if (cfg) setJsonConfig(JSON.stringify(cfg, null, 2));
        }

        // 设置回调
        PortalPay.setLogCallback((msg) => {
            setLogs(prev => [...prev, msg].slice(-100)); // 保留最后100条
            setStatus(msg.split(']').pop().trim().slice(0, 20) + '...');
        });

        return () => {
            PortalPay.setLogCallback(null);
        };
    }, []);

    // 自动滚动日志
    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [logs]);

    // 拖拽事件处理
    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - dragStartPos.current.x;
            const dy = e.clientY - dragStartPos.current.y;
            setPosition({
                x: modalStartPos.current.x + dx,
                y: modalStartPos.current.y + dy
            });
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        if (isDragging) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging]);

    const handleMouseDown = (e) => {
        // 只有点击 Header 区域才触发拖拽 (Header 是第一个子元素)
        // 但我们在 Header div 上直接绑定即可，这里不需要判断 target
        setIsDragging(true);
        dragStartPos.current = { x: e.clientX, y: e.clientY };
        modalStartPos.current = { ...position };
    };

    const handleFillTemplate = () => {
        let currentPrice = price; // 优先使用 props 中的实时价格
        
        // 如果无法自动获取，提示用户手动输入
        if (!currentPrice || currentPrice <= 0) {
            // 尝试旧方法作为 fallback (虽然在 Side Panel 中通常无效)
            // currentPrice = getPriceFromPage(); 
        }

        if (!currentPrice || currentPrice <= 0) {
            const manual = prompt("未自动获取到当前价格，请输入当前价格 (例如 0.00123):");
            if (manual) {
                const parsed = parseFloat(manual);
                if (!isNaN(parsed) && parsed > 0) {
                    currentPrice = parsed;
                } else {
                    alert("输入的价格无效");
                    return;
                }
            } else {
                // 用户取消
                return; 
            }
        }
        
        let json = {};
        switch (template) {
            case 'buy_now':
                json = {
                    "name": "立即买入",
                    "mode": "immediate",
                    "mint": mint,
                    "actions": [
                        { "action": "buy", "amount": 0.1 }
                    ]
                };
                break;
            case 'sell_now':
                json = {
                    "name": "立即卖出",
                    "mode": "immediate",
                    "mint": mint,
                    "actions": [
                        { "action": "sell", "amount": "50%" }
                    ]
                };
                break;
            case 'monitor_profit':
                json = {
                    "name": "止盈止损监控",
                    "mode": "monitor",
                    "mint": mint,
                    "base_price": currentPrice,
                    "conditions": [
                        { "type": "up_pct", "value": 50, "action": "sell", "amount": "50%" },
                        { "type": "down_pct", "value": -20, "action": "sell", "amount": "100%" }
                    ]
                };
                break;
            case 'monitor_dip':
                json = {
                    "name": "自动抄底",
                    "mode": "monitor",
                    "mint": mint,
                    "base_price": currentPrice,
                    "conditions": [
                        { "type": "down_pct", "value": -10, "action": "buy", "amount": 0.2 }
                    ]
                };
                break;
            default:
                return;
        }
        setJsonConfig(JSON.stringify(json, null, 2));
    };

    const handleRun = () => {
        try {
            if (!jsonConfig.trim()) return;
            const config = JSON.parse(jsonConfig);
            
            // 定义交易回调
            const tradeCallback = async (params) => {
                // params: { action, amount, mint }
                // 调用封装好的 doTrade
                return await doTrade(params.action, params);
            };

            PortalPay.startStrategy(config, (msg) => {
                setLogs(prev => [...prev, msg].slice(-100));
                setStatus(msg.split(']').pop().trim().slice(0, 20) + '...');
            }, tradeCallback);

            setIsRunning(true);
            setStatus('策略已启动');
        } catch (e) {
            alert('JSON 格式错误: ' + e.message);
        }
    };

    const handleStop = () => {
        PortalPay.stopStrategy();
        setIsRunning(false);
        setStatus('策略已停止');
    };

    return (
        <div style={{
            position: 'fixed',
            left: `${position.x}px`,
            top: `${position.y}px`,
            width: '500px',
            background: '#0f1115',
            color: '#e5e7eb',
            border: '1px solid #1f2937',
            borderRadius: '8px',
            boxShadow: '0 12px 28px rgba(0,0,0,.45)',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            zIndex: 2147483647
        }}>
            {/* Header - 可拖拽区域 */}
            <div 
                onMouseDown={handleMouseDown}
                style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    borderBottom: '1px solid #1f2937', 
                    paddingBottom: '8px',
                    cursor: 'move', // 鼠标变成移动图标
                    userSelect: 'none' // 防止拖拽时选中文本
                }}
            >
                <div style={{ fontWeight: 600 }}>高级策略交易 (JSON)</div>
                <button 
                    onClick={(e) => { e.stopPropagation(); onClose(); }} // 防止触发拖拽
                    style={{ background: 'transparent', border: 0, color: '#9ca3af', cursor: 'pointer' }}
                >✕</button>
            </div>

            {/* Toolbar */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <select 
                    value={template} 
                    onChange={e => setTemplate(e.target.value)}
                    style={{ flex: 1, background: '#111827', color: '#e5e7eb', border: '1px solid #1f2937', borderRadius: '4px', padding: '6px' }}
                >
                    <option value="">-- 选择策略模板 --</option>
                    <option value="buy_now">立即买入 (普通)</option>
                    <option value="sell_now">立即卖出 (普通)</option>
                    <option value="monitor_profit">监控: 止盈(+50%) 止损(-20%)</option>
                    <option value="monitor_dip">监控: 抄底(-10% 买入)</option>
                </select>
                <button onClick={handleFillTemplate} style={{ background: '#374151', color: '#fff', border: 0, borderRadius: '4px', padding: '6px 10px', cursor: 'pointer' }}>
                    填充模板
                </button>
            </div>

            {/* Editor */}
            <textarea
                value={jsonConfig}
                onChange={e => setJsonConfig(e.target.value)}
                rows={12}
                placeholder={`// 在此输入 JSON 配置...\n{\n  "mode": "monitor",\n  "base_price": 0.00123,\n  ...\n}`}
                style={{
                    width: '100%',
                    background: '#0b0b0c',
                    color: '#a3e635',
                    fontFamily: 'monospace',
                    border: '1px solid #374151',
                    borderRadius: '4px',
                    padding: '8px',
                    resize: 'vertical'
                }}
            />

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '8px', borderTop: '1px solid #1f2937' }}>
                <div style={{ fontSize: '12px', color: '#9ca3af' }}>{status}</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={handleStop} style={{ background: '#dc2626', color: '#fff', border: 0, borderRadius: '4px', padding: '6px 12px', cursor: 'pointer' }}>
                        停止/清空
                    </button>
                    <button onClick={handleRun} style={{ background: '#2563eb', color: '#fff', border: 0, borderRadius: '4px', padding: '6px 12px', cursor: 'pointer' }}>
                        {isRunning ? '重启策略' : '执行策略'}
                    </button>
                </div>
            </div>

            {/* Logs */}
            <div style={{
                height: '100px',
                overflowY: 'auto',
                background: '#000',
                color: '#6b7280',
                fontSize: '11px',
                padding: '4px',
                border: '1px solid #1f2937',
                borderRadius: '4px',
                marginTop: '4px'
            }}>
                {logs.map((log, idx) => (
                    <div key={idx}>{log}</div>
                ))}
                <div ref={logsEndRef} />
            </div>
        </div>
    );
};

export default AdvancedStrategyModal;
