import React, { useState, useEffect, useRef } from 'react';
import { doTrade } from '../../utils/trade';
// import { getMintFromPage } from '../../utils/api'; // 已废弃，改用 props

const TradePanel = ({ onClose, fixedBuyAmounts = [0.01, 0.05, 0.1], fixedSellPcts = [25, 50, 100], mint, price }) => {
    const [inputBuy, setInputBuy] = useState('');
    const [inputSell, setInputSell] = useState('');
    const [statusMsg, setStatusMsg] = useState(null); // { text, type }

    // 拖拽相关状态
    // 使用简单的初始位置，避免计算问题
    const [position, setPosition] = useState({ x: 200, y: 100 });
    const [isDragging, setIsDragging] = useState(false);
    const dragStartPos = useRef({ x: 0, y: 0 });
    const modalStartPos = useRef({ x: 0, y: 0 });

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
        setIsDragging(true);
        dragStartPos.current = { x: e.clientX, y: e.clientY };
        modalStartPos.current = { ...position };
    };

    const handleTrade = async (type, amount) => {
        if(!amount || parseFloat(amount) <= 0) return;
        
        setStatusMsg({ text: '正在提交...', type: 'info' });

        // 使用 props 传入的 mint，不再从页面获取
        if (!mint) {
            setStatusMsg({ text: '未找到 Mint 地址', type: 'error' });
            return;
        }

        try {
            const val = parseFloat(amount);
            const params = { mint };
            
            if (type === 'buy') {
                params.amount = val; // SOL
            } else {
                params.amount = val + '%'; // Percent string for sell
            }

            const res = await doTrade(type, params);
            
            setStatusMsg({ text: '交易提交成功', type: 'success' });
            
            // 3秒后清除成功消息
            setTimeout(() => setStatusMsg(null), 3000);
        } catch (e) {
            setStatusMsg({ text: `失败: ${e.message}`, type: 'error' });
        }
    };

    const btnStyle = {
        background: '#222', 
        color: '#ddd', 
        border: '1px solid #444', 
        borderRadius: '4px', 
        padding: '4px 8px', 
        cursor: 'pointer'
    };

    return (
        <div style={{
            position: 'fixed',
            left: `${position.x}px`,
            top: `${position.y}px`,
            width: '320px',
            background: '#0b0b0c',
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
                    cursor: 'move',
                    userSelect: 'none'
                }}
            >
                <div style={{ fontWeight: 600 }}>快速交易</div>
                <button 
                    onClick={(e) => { e.stopPropagation(); onClose(); }} 
                    style={{ background: 'transparent', border: 0, color: '#9ca3af', cursor: 'pointer' }}
                >✕</button>
            </div>

            {/* Content */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {/* Buy Section */}
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <input 
                        type="number" 
                        placeholder="SOL" 
                        value={inputBuy}
                        onChange={e => setInputBuy(e.target.value)}
                        style={{ width: '60px', background: '#1f2937', border: '1px solid #374151', color: '#fff', borderRadius: '4px', padding: '6px' }}
                    />
                    <button onClick={() => handleTrade('buy', inputBuy)} style={{ ...btnStyle, background: '#10b981', color: '#fff', border: 'none', padding: '6px 12px' }}>买入</button>
                    <div style={{ display: 'flex', gap: '4px' }}>
                        {fixedBuyAmounts.map((amt, idx) => (
                            <button key={idx} onClick={() => handleTrade('buy', amt)} style={{ ...btnStyle, background: '#065f46', border: 'none', fontSize: '11px', padding: '6px' }}>
                                {amt}
                            </button>
                        ))}
                    </div>
                </div>
                
                {/* Sell Section */}
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <input 
                        type="number" 
                        placeholder="%" 
                        value={inputSell}
                        onChange={e => setInputSell(e.target.value)}
                        style={{ width: '60px', background: '#1f2937', border: '1px solid #374151', color: '#fff', borderRadius: '4px', padding: '6px' }}
                    />
                    <button onClick={() => handleTrade('sell', inputSell)} style={{ ...btnStyle, background: '#ef4444', color: '#fff', border: 'none', padding: '6px 12px' }}>卖出</button>
                    <div style={{ display: 'flex', gap: '4px' }}>
                        {fixedSellPcts.map((pct, idx) => (
                            <button key={idx} onClick={() => handleTrade('sell', pct)} style={{ ...btnStyle, background: '#991b1b', border: 'none', fontSize: '11px', padding: '6px' }}>
                                {pct}%
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Status Message */}
            {statusMsg && (
                <div style={{
                    marginTop: '8px',
                    padding: '6px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    textAlign: 'center',
                    background: statusMsg.type === 'error' ? '#7f1d1d' : (statusMsg.type === 'success' ? '#064e3b' : '#374151'),
                    color: statusMsg.type === 'error' ? '#fca5a5' : (statusMsg.type === 'success' ? '#6ee7b7' : '#d1d5db'),
                    border: `1px solid ${statusMsg.type === 'error' ? '#991b1b' : (statusMsg.type === 'success' ? '#065f46' : '#4b5563')}`
                }}>
                    {statusMsg.text}
                </div>
            )}
        </div>
    );
};

export default TradePanel;
