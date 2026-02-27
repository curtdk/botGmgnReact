import React, { useState, useEffect } from 'react';
import { stoSet } from '../../utils/api';

const BossSettingsModal = ({ onClose, onAnalyze }) => {
    const [config, setConfig] = useState({
        // 原有策略
        enable_no_source: true,
        weight_no_source: 10,
        enable_hidden_relay: false,
        weight_hidden_relay: 15,
        hidden_relay_max_pages: 10,
        verify_interval_sec: 30,

        enable_same_source: false,
        same_source_n: 5,
        same_source_exclude: '',
        weight_same_source: 10,

        enable_time_cluster: false,
        time_cluster_n: 5,
        time_cluster_j: 1,
        weight_time_cluster: 10,

        // 新增策略
        rule_gas: { enabled: false, threshold: 0.01, weight: 10 },
        rule_amount_sim: { enabled: false, count: 5, range: 100, weight: 10 },
        rule_large_holding: { enabled: false, top_pct: 5, min_usd: 1000, logic: 'OR', weight: 10 },
        rule_sol_balance: { enabled: false, count: 3, range: 0.1, weight: 10 },
        // [新增] 资金来源时间
        rule_source_time: { enabled: false, diff_sec: 10, weight: 10 }
    });

    useEffect(() => {
        chrome.storage.local.get(['boss_config'], (res) => {
            if(res.boss_config) {
                // 合并配置，确保新字段有默认值
                setConfig(prev => {
                    const merged = { ...prev, ...res.boss_config };
                    // 深度合并对象类型的规则配置
                    ['rule_gas', 'rule_amount_sim', 'rule_large_holding', 'rule_sol_balance', 'rule_source_time'].forEach(key => {
                        if (res.boss_config[key]) {
                            merged[key] = { ...prev[key], ...res.boss_config[key] };
                        }
                    });
                    return merged;
                });
            }
        });
    }, []);

    const handleChange = (key, val) => {
        setConfig(prev => ({ ...prev, [key]: val }));
    };

    const handleRuleChange = (ruleKey, field, val) => {
        setConfig(prev => ({
            ...prev,
            [ruleKey]: {
                ...prev[ruleKey],
                [field]: val
            }
        }));
    };

    const handleSave = async () => {
        const finalConfig = JSON.parse(JSON.stringify(config));
        const errors = [];

        // 辅助处理函数
        const processNum = (name, val, isInt = false) => {
            if (val === '' || val === null || val === undefined) return 0;
            const num = parseFloat(val);
            if (isNaN(num)) {
                errors.push(`${name} 必须是有效数字`);
                return 0;
            }
            return isInt ? parseInt(num) : num;
        };

        // 1. 基础规则
        finalConfig.weight_no_source = processNum('无资金来源权重', config.weight_no_source, true);
        finalConfig.weight_hidden_relay = processNum('隐藏中转权重', config.weight_hidden_relay, true);
        finalConfig.hidden_relay_max_pages = processNum('中转检测最多翻页数', config.hidden_relay_max_pages, true);
        finalConfig.verify_interval_sec = processNum('定期校验间隔(秒)', config.verify_interval_sec, true);
        
        finalConfig.same_source_n = processNum('同源账户数量', config.same_source_n, true);
        finalConfig.weight_same_source = processNum('同源账户权重', config.weight_same_source, true);
        
        finalConfig.time_cluster_n = processNum('时间聚类数量', config.time_cluster_n, true);
        finalConfig.time_cluster_j = processNum('时间聚类窗口', config.time_cluster_j, true);
        finalConfig.weight_time_cluster = processNum('时间聚类权重', config.weight_time_cluster, true);

        // 2. 新增规则
        if (finalConfig.rule_gas) {
            finalConfig.rule_gas.threshold = processNum('Gas 阈值', config.rule_gas.threshold);
            finalConfig.rule_gas.weight = processNum('Gas 权重', config.rule_gas.weight, true);
        }

        if (finalConfig.rule_amount_sim) {
            finalConfig.rule_amount_sim.count = processNum('金额相似数量', config.rule_amount_sim.count, true);
            finalConfig.rule_amount_sim.range = processNum('金额相似范围', config.rule_amount_sim.range);
            finalConfig.rule_amount_sim.weight = processNum('金额相似权重', config.rule_amount_sim.weight, true);
        }

        if (finalConfig.rule_large_holding) {
            finalConfig.rule_large_holding.top_pct = processNum('大额持仓比例', config.rule_large_holding.top_pct);
            finalConfig.rule_large_holding.min_usd = processNum('大额持仓金额', config.rule_large_holding.min_usd);
            finalConfig.rule_large_holding.weight = processNum('大额持仓权重', config.rule_large_holding.weight, true);
        }

        if (finalConfig.rule_sol_balance) {
            finalConfig.rule_sol_balance.count = processNum('余额相似数量', config.rule_sol_balance.count, true);
            finalConfig.rule_sol_balance.range = processNum('余额相似范围', config.rule_sol_balance.range);
            finalConfig.rule_sol_balance.weight = processNum('余额相似权重', config.rule_sol_balance.weight, true);
        }

        if (finalConfig.rule_source_time) {
            finalConfig.rule_source_time.diff_sec = processNum('同源时间间隔', config.rule_source_time.diff_sec, true);
            finalConfig.rule_source_time.weight = processNum('同源时间权重', config.rule_source_time.weight, true);
            finalConfig.rule_source_time.count = processNum('同源时间数量', config.rule_source_time.count, true);
        }

        if (errors.length > 0) {
            alert("配置错误：\n" + errors.join("\n"));
            return;
        }

        // 更新全局 manager 配置
        if(window.gmgnScoreManager) {
            window.gmgnScoreManager.bossConfig = finalConfig;
        }
        await stoSet({ boss_config: finalConfig });
        onClose();
    };

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.7)', zIndex: 2147483647,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
            <div style={{
                background: '#1f2937', color: '#e5e7eb', width: '500px', maxHeight: '90vh',
                padding: '20px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                display: 'flex', flexDirection: 'column'
            }}>
                <div style={{ marginBottom: '16px' }}>
                    <h3 style={{ margin: 0, color: '#f59e0b' }}>庄家智能筛选配置</h3>
                    <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
                        勾选即标记为庄家；权重分用于排序，无论是否勾选都会计算。
                    </div>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto', paddingRight: '4px' }}>
                    
                    {/* 1. 无资金来源 */}
                    <Card 
                        title="无资金来源" 
                        checked={config.enable_no_source} 
                        onCheck={v => handleChange('enable_no_source', v)}
                        weight={config.weight_no_source}
                        onWeightChange={v => handleChange('weight_no_source', v)}
                    >
                        标记 Funding Address 为空的账户
                    </Card>

                    {/* 1.5. 无资金来源-隐藏中转 */}
                    <Card
                        title="无资金来源-隐藏中转"
                        checked={config.enable_hidden_relay}
                        onCheck={v => handleChange('enable_hidden_relay', v)}
                        weight={config.weight_hidden_relay}
                        onWeightChange={v => handleChange('weight_hidden_relay', v)}
                    >
                        <div>第一笔交易含 Create+CloseAccount 指令（资金隐藏中转到此钱包）</div>
                        <div style={{ marginTop: '4px' }}>
                            最多翻 <NumberInput value={config.hidden_relay_max_pages} onChange={v => handleChange('hidden_relay_max_pages', v)} width="45px" /> 页（每页1000条）
                        </div>
                    </Card>

                    {/* 2. 同源账户 */}
                    <Card 
                        title="同源账户 (老鼠仓)" 
                        checked={config.enable_same_source} 
                        onCheck={v => handleChange('enable_same_source', v)}
                        weight={config.weight_same_source}
                        onWeightChange={v => handleChange('weight_same_source', v)}
                    >
                        <div>
                            同源数量 ≥ <NumberInput value={config.same_source_n} onChange={v => handleChange('same_source_n', v)} /> 个
                        </div>
                        <div style={{ marginTop: '4px' }}>
                            <div style={{ fontSize: '11px', color: '#9ca3af' }}>排除地址 (逗号分隔):</div>
                            <textarea 
                                value={config.same_source_exclude}
                                onChange={e => handleChange('same_source_exclude', e.target.value)}
                                rows={1}
                                style={{ width: '100%', background: '#374151', border: 'none', color: '#fff', fontSize: '11px', padding: '4px', resize: 'vertical' }}
                            />
                        </div>
                    </Card>

                    {/* 3. 时间聚类 */}
                    <Card 
                        title="时间聚类 (批量并发)" 
                        checked={config.enable_time_cluster} 
                        onCheck={v => handleChange('enable_time_cluster', v)}
                        weight={config.weight_time_cluster}
                        onWeightChange={v => handleChange('weight_time_cluster', v)}
                    >
                        在 <NumberInput value={config.time_cluster_j} onChange={v => handleChange('time_cluster_j', v)} /> 秒内，
                        创建 &gt; <NumberInput value={config.time_cluster_n} onChange={v => handleChange('time_cluster_n', v)} /> 个账户
                    </Card>

                    {/* 4. Gas 异常 */}
                    <Card 
                        title="Gas 费用异常 (Low Gas)" 
                        checked={config.rule_gas.enabled} 
                        onCheck={v => handleRuleChange('rule_gas', 'enabled', v)}
                        weight={config.rule_gas.weight}
                        onWeightChange={v => handleRuleChange('rule_gas', 'weight', v)}
                    >
                        单笔交易 Gas 费 &lt; <NumberInput value={config.rule_gas.threshold} onChange={v => handleRuleChange('rule_gas', 'threshold', v)} step={0.001} width="60px" /> SOL
                    </Card>

                    {/* 5. 金额相似 */}
                    <Card 
                        title="金额相似群组" 
                        checked={config.rule_amount_sim.enabled} 
                        onCheck={v => handleRuleChange('rule_amount_sim', 'enabled', v)}
                        weight={config.rule_amount_sim.weight}
                        onWeightChange={v => handleRuleChange('rule_amount_sim', 'weight', v)}
                    >
                        相似金额 (范围 ±<NumberInput value={config.rule_amount_sim.range} onChange={v => handleRuleChange('rule_amount_sim', 'range', v)} width="50px" /> USD)
                        的交易数 &gt; <NumberInput value={config.rule_amount_sim.count} onChange={v => handleRuleChange('rule_amount_sim', 'count', v)} /> 个
                    </Card>

                    {/* 6. 大额持仓 */}
                    <Card 
                        title="大额持仓" 
                        checked={config.rule_large_holding.enabled} 
                        onCheck={v => handleRuleChange('rule_large_holding', 'enabled', v)}
                        weight={config.rule_large_holding.weight}
                        onWeightChange={v => handleRuleChange('rule_large_holding', 'weight', v)}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            前 <NumberInput value={config.rule_large_holding.top_pct} onChange={v => handleRuleChange('rule_large_holding', 'top_pct', v)} /> %
                            <select 
                                value={config.rule_large_holding.logic} 
                                onChange={e => handleRuleChange('rule_large_holding', 'logic', e.target.value)}
                                style={{ background: '#374151', border: 'none', color: '#fff', padding: '2px', borderRadius: '2px', fontSize: '11px' }}
                            >
                                <option value="OR">或</option>
                                <option value="AND">且</option>
                            </select>
                            持仓 &gt; <NumberInput value={config.rule_large_holding.min_usd} onChange={v => handleRuleChange('rule_large_holding', 'min_usd', v)} width="60px" /> USD
                        </div>
                    </Card>

                    {/* 7. SOL 余额 */}
                    <Card 
                        title="SOL 余额关联" 
                        checked={config.rule_sol_balance.enabled} 
                        onCheck={v => handleRuleChange('rule_sol_balance', 'enabled', v)}
                        weight={config.rule_sol_balance.weight}
                        onWeightChange={v => handleRuleChange('rule_sol_balance', 'weight', v)}
                    >
                        余额相似 (范围 ±<NumberInput value={config.rule_sol_balance.range} onChange={v => handleRuleChange('rule_sol_balance', 'range', v)} step={0.1} width="50px" /> SOL)
                        的账户数 &gt; <NumberInput value={config.rule_sol_balance.count} onChange={v => handleRuleChange('rule_sol_balance', 'count', v)} /> 个
                    </Card>

                    {/* [新增] 8. 资金来源时间 */}
                    <Card 
                        title="同源时间" 
                        checked={config.rule_source_time.enabled} 
                        onCheck={v => handleRuleChange('rule_source_time', 'enabled', v)}
                        weight={config.rule_source_time.weight}
                        onWeightChange={v => handleRuleChange('rule_source_time', 'weight', v)}
                    >
                        来源时间相差 &le; <NumberInput value={config.rule_source_time.diff_sec} onChange={v => handleRuleChange('rule_source_time', 'diff_sec', v)} width="50px" /> 秒
                        且数量 &ge; <NumberInput value={config.rule_source_time.count} onChange={v => handleRuleChange('rule_source_time', 'count', v)} width="40px" /> 个
                    </Card>

                    {/* 定期校验间隔 */}
                    <div style={{ background: '#111827', padding: '10px', borderRadius: '4px', border: '1px solid #374151' }}>
                        <div style={{ fontWeight: 'bold', color: '#f59e0b', marginBottom: '8px' }}>定期校验间隔</div>
                        <div style={{ paddingLeft: '24px', fontSize: '12px', color: '#d1d5db' }}>
                            每 <NumberInput value={config.verify_interval_sec} onChange={v => handleChange('verify_interval_sec', v)} width="45px" /> 秒重新校验一次持仓数据（默认30秒）
                        </div>
                    </div>

                </div>

                {/* 庄家档案库管理 */}
                <BossProfileManager />

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #374151' }}>
                    <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #4b5563', color: '#e5e7eb', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer' }}>取消</button>
                    <button onClick={handleSave} style={{ background: '#f59e0b', border: 'none', color: '#000', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>保存配置</button>
                </div>
            </div>
        </div>
    );
};

// 样式组件 (移到外部，防止重绘导致光标丢失)
const NumberInput = ({ value, onChange, width = '40px' }) => (
    <input 
        type="text" 
        value={value} 
        onChange={e => onChange(e.target.value)}
        style={{ width, background: '#374151', border: 'none', color: '#fff', textAlign: 'center', borderRadius: '2px', padding: '2px', margin: '0 4px', outline: 'none' }} 
    />
);

const Card = ({ children, title, checked, onCheck, weight, onWeightChange }) => (
    <div style={{ background: '#111827', padding: '10px', borderRadius: '4px', border: '1px solid #374151' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 'bold', color: '#f59e0b' }}>
                <input type="checkbox" checked={checked} onChange={e => onCheck(e.target.checked)} />
                {title}
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
                <span style={{ color: '#9ca3af' }}>权重:</span>
                <NumberInput value={weight} onChange={onWeightChange} />
            </div>
        </div>
        <div style={{ paddingLeft: '24px', fontSize: '12px', color: '#d1d5db' }}>
            {children}
        </div>
    </div>
);

const btnStyle = (bg) => ({ background: bg, border: 'none', color: '#fff', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' });

const BossProfileManager = () => {
    const [count, setCount] = useState(0);

    const loadCount = () => {
        chrome.storage.local.get(null, (all) => {
            const keys = Object.keys(all).filter(k => k.startsWith('hidden_relay_'));
            setCount(keys.length);
        });
    };

    useEffect(() => { loadCount(); }, []);

    const handleExport = () => {
        chrome.storage.local.get(null, (all) => {
            const data = {};
            Object.keys(all).filter(k => k.startsWith('hidden_relay_')).forEach(k => { data[k] = all[k]; });
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `hidden_relay_cache_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });
    };

    const handleImport = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const imported = JSON.parse(ev.target.result);
                    const toSet = {};
                    Object.keys(imported).filter(k => k.startsWith('hidden_relay_')).forEach(k => { toSet[k] = imported[k]; });
                    chrome.storage.local.set(toSet, () => {
                        loadCount();
                        alert(`导入成功：共 ${Object.keys(toSet).length} 条缓存`);
                    });
                } catch (err) {
                    alert('导入失败：JSON 格式错误');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    };

    const handleClear = () => {
        if (!window.confirm(`确认清空全部 ${count} 条隐藏中转缓存？此操作不可恢复`)) return;
        chrome.storage.local.get(null, (all) => {
            const keys = Object.keys(all).filter(k => k.startsWith('hidden_relay_'));
            chrome.storage.local.remove(keys, () => setCount(0));
        });
    };

    return (
        <div style={{ borderTop: '1px solid #374151', paddingTop: '10px', marginTop: '10px' }}>
            <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '6px' }}>
                隐藏中转缓存：<span style={{ color: '#f59e0b' }}>{count}</span> 条记录
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
                <button onClick={handleExport} style={btnStyle('#1d4ed8')}>导出</button>
                <button onClick={handleImport} style={btnStyle('#065f46')}>导入</button>
                <button onClick={handleClear} style={btnStyle('#7f1d1d')}>清空</button>
            </div>
        </div>
    );
};

export default BossSettingsModal;
