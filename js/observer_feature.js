(() => {
    "use strict";

    class ObserverFeature {
        constructor() {
            this.activityMap = new Map();
            this.colorMap = new Map();
            this.observer = null;
            this.debounceTimer = null;
            this.periodicTimer = null;
            this.enabled = false;
            this.interval = 500;
            this.processedAddresses = new Set();
        }

        init() {
            console.log('[Observer Feature] Initializing...');
            this.injectGlobalCSS();
            
            // 监听来自 content.js 的控制消息
            window.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'GMGN_OBSERVER_TOGGLE') {
                    console.log('[Observer Feature] Received toggle message:', event.data);
                    const { enabled, interval } = event.data;
                    
                    if (interval) this.interval = parseInt(interval) || 500;
                    
                    if (enabled !== undefined) {
                        this.enabled = !!enabled;
                        if (this.enabled) {
                            this.start();
                        } else {
                            this.stop();
                        }
                    }
                }
                
                // 接收活跃度数据
                if (event.data && event.data.type === 'GMGN_ACTIVITY_UPDATE') {
                    if (event.data.data) {
                        this.activityMap = new Map(Object.entries(event.data.data));
                        console.log('[Observer Feature] Activity map updated, size:', this.activityMap.size);
                    }
                }
            });

            this.loadConfig().then(() => {
                console.log(`[Observer Feature] Init config loaded. Enabled: ${this.enabled}`);
                if (this.enabled) {
                    this.start();
                } else {
                    console.log('[Observer Feature] Disabled by config, not starting.');
                }
            });
            // this.listenForConfigChanges(); // 移除旧的 storage 监听，改用消息控制
        }

        async loadConfig() {
            try {
                const cfg = await this.stoGet(['observer_enabled', 'observer_interval']);
                this.enabled = !!cfg.observer_enabled;
                this.interval = parseInt(cfg.observer_interval) || 500;
                console.log(`[Observer Feature] Config loaded: enabled=${this.enabled}, interval=${this.interval}`);
            } catch (e) {
                console.warn('[Observer Feature] Failed to load config', e);
                this.enabled = false; // Default to false on error
            }
        }

        async stoGet(keys) {
            if (window.chrome && chrome.storage && chrome.storage.local) {
                return await chrome.storage.local.get(keys);
            }
            const out = {};
            for (const k of keys) {
                const raw = localStorage.getItem(k);
                try { out[k] = JSON.parse(raw); } catch (_) { out[k] = raw; }
            }
            return out;
        }

        start() {
            console.log('[Observer Feature] Starting...');
            this.startObserving();
            this.startPeriodicCheck();
        }

        stop() {
            console.log('[Observer Feature] Stopping...');
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
            if (this.periodicTimer) {
                clearInterval(this.periodicTimer);
                this.periodicTimer = null;
            }
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
                this.debounceTimer = null;
            }
            // Optional: remove injected tags
            document.querySelectorAll('[data-gmgn-activity]').forEach(el => el.removeAttribute('data-gmgn-activity'));
            document.querySelectorAll('[data-amount-level]').forEach(el => el.removeAttribute('data-amount-level'));
        }

        injectGlobalCSS() {
            if (document.getElementById('gmgn-observer-style')) return;
            const style = document.createElement('style');
            style.id = 'gmgn-observer-style';
            style.textContent = `
              a[data-gmgn-activity="true"]::after {
                content: "🌼";
                display: inline-flex;
                align-items: center;
                margin-left: 4px;
                font-size: 14px;
                white-space: nowrap;
                pointer-events: none;
                background-color: var(--gmgn-tag-bg, transparent);
                padding: 2px 6px;
                border-radius: 4px;
                transition: background-color 0.2s ease;
              }
              .flex.flex-row:has(a[data-gmgn-activity="true"]) div[data-amount-level]::after { margin-left: 4px; font-size: 14px; }
              .flex.flex-row:has(a[data-gmgn-activity="true"]) div[data-amount-level="fire1"]::after { content: "🔥"; }
              .flex.flex-row:has(a[data-gmgn-activity="true"]) div[data-amount-level="fire2"]::after { content: "🔥🔥"; }
              .flex.flex-row:has(a[data-gmgn-activity="true"]) div[data-amount-level="fire3"]::after { content: "🔥🔥🔥"; }
              .flex.flex-row:has(a[data-gmgn-activity="true"]) div[data-amount-level="diamond"]::after { content: "💎"; }
            `;
            document.head.appendChild(style);
        }

        startObserving() {
            const checkAndStart = () => {
                // 严格检查启用状态，防止递归死灰复燃
                if (!this.enabled) {
                    return;
                }

                const targetNode = document.querySelector('.g-table-body');
                if (!targetNode) {
                    setTimeout(checkAndStart, 1000);
                    return;
                }
                
                // 清理旧的 observer（如果存在）
                if (this.observer) this.observer.disconnect();
                
                this.observer = new MutationObserver(() => this.scheduleInject());
                this.observer.observe(targetNode, { childList: true, subtree: true, attributes: true, characterData: true });
                this.scheduleInject();
            };
            checkAndStart();
        }

        startPeriodicCheck() {
            if (this.periodicTimer) clearInterval(this.periodicTimer);
            this.periodicTimer = setInterval(() => this.injectAllTags(), this.interval);
        }

        scheduleInject() {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                this.injectAllTags();
                this.debounceTimer = null;
            }, 100); // Debounce 100ms
        }

        injectAllTags() {
            if (!this.enabled) return;

            const addressLinks = document.querySelectorAll('a[href*="/sol/address/"]');
            
            // 收集本次扫描到的数据
            const updates = [];
            
            console.log(`[Observer Feature] Scanning... Found ${addressLinks.length} address links.`);
            
            let matchedCount = 0;

            addressLinks.forEach(link => {
                const address = this.extractAddress(link.href);
                if (!address) return;
                
                if (this.activityMap.has(address)) matchedCount++;

                // 提取 Short Address
                const row = link.closest('.flex.flex-row') || link.parentElement;
                let result = null;
                if (row) {
                    var lineText=(row.textContent||'').trim();
                    // 尝试从链接文本提取
                    result = this.extractMainShort(lineText);
                }

                if (result && result.shortAddr) {
                    updates.push({ address, shortAddr: result.shortAddr, shouldSave: result.shouldSave });
                }

                // 4. 样式注入
                this.injectTags(link, address);
            });

            if (updates.length > 0) {
                console.log(`[Observer Feature] Found ${updates.length} potential short addresses.`);
                // 发送事件通知 content.js
                window.dispatchEvent(new CustomEvent('GMGN_OBSERVER_UPDATE', { 
                    detail: updates 
                }));
            }
            
            if (matchedCount > 0) {
                console.log(`[Observer Feature] Matched ${matchedCount} addresses with activity data.`);
            } else {
                // 调试：如果没匹配上，打印几个地址和 Map 中的 key 比较
                if (this.activityMap.size > 0 && addressLinks.length > 0) {
                     const sampleLinkAddr = this.extractAddress(addressLinks[0].href);
                     const sampleMapKey = this.activityMap.keys().next().value;
                     console.warn(`[Observer Feature] No match. Sample Link: ${sampleLinkAddr}, Sample Map Key: ${sampleMapKey}`);
                     console.warn(`[Observer Feature] Map has ${this.activityMap.size} keys.`);
                }
            }
        }

        extractAddress(href) {
            const match = href.match(/\/sol\/address\/([A-Za-z0-9]+)/);
            return match ? match[1] : null;
        }

        injectTags(link, address) {
            // 1. 获取颜色/活跃度
            // 颜色暂时没有传，先处理活跃度
            // const color = this.colorMap.get(address);
            
            // 2. 注入活跃度标签 (花/火/钻)
            if (this.activityMap.has(address)) {
                // 如果已经有标记，先不处理（或者更新）
                if (link.getAttribute('data-gmgn-activity') === 'true') return;
                
                const count = this.activityMap.get(address) || 0;
                let level = '';
                
                // 简单规则：次数 >= 10 -> 钻， >= 5 -> 火3， >= 3 -> 火2， >= 1 -> 火1， 否则 -> 花
                if (count >= 10) level = 'diamond';
                else if (count >= 5) level = 'fire3';
                else if (count >= 3) level = 'fire2';
                else if (count >= 1) level = 'fire1';
                else level = 'flower'; // 0次但也出现在列表里（可能是被手动标记或仅持有）

                // 标记 A 标签
                link.setAttribute('data-gmgn-activity', 'true');
                
                // 查找金额容器注入
                // 假设结构: .flex.flex-row > div (金额)
                // 原版逻辑是查找金额 div 并添加 data-amount-level
                // 这里简化为：尝试找到同行的金额 div
                const row = link.closest('.flex.flex-row') || link.parentElement;
                if (row) {
                    // 假设金额是行内的第二个或最后一个 div，这里需要启发式查找
                    // 暂时只给 link 添加样式，CSS 中 ::after 会显示图标
                    // 如果 CSS 是针对 div[data-amount-level] 的，则需要找到那个 div
                    
                    // 尝试找到包含 $ 或数字的 div
                    const divs = row.querySelectorAll('div');
                    let amountDiv = null;
                    divs.forEach(d => {
                        if (d.textContent.includes('$') || /[\d,\.]+/.test(d.textContent)) amountDiv = d;
                    });
                    
                    if (amountDiv) {
                        // 强制覆盖旧值，以防更新不生效
                        if (amountDiv.getAttribute('data-amount-level') !== level) {
                             amountDiv.setAttribute('data-amount-level', level);
                        }
                    } else {
                        // 找不到金额，就加在 link 上 (需修改 CSS 支持)
                        if (link.getAttribute('data-amount-level') !== level) {
                             link.setAttribute('data-amount-level', level); 
                        }
                    }
                } else {
                     // 没有 row，直接加在 link 上
                     if (link.getAttribute('data-amount-level') !== level) {
                          link.setAttribute('data-amount-level', level);
                     }
                }
            }
        }
        
        extractMainShort(str) {
            // 1. 尝试标准 "ABCD...WXYZ" 格式
            var m=str.match(/(?:^|\s)\d{0,3}\s*([1-9A-HJ-NP-Za-km-z]{4,})\.\.\.([1-9A-HJ-NP-Za-km-z]{4})/);
            if(m){ 
                var pre=m[1].slice(0,4); 
                var suf=m[2]; 
                // 标准格式不持久化
                return { shortAddr: pre+'...'+suf, shouldSave: false };
            }
            
            // 2. 尝试仅有前缀的情况 (用户案例: "1ac💦..." -> "1ac" -> "ac")
            // 规则：捕获行首的字符，如果是数字开头后跟Base58字符，则去除开头的数字(Rank 1-1000)
            var m2 = str.match(/^(\d*[1-9A-HJ-NP-Za-km-z]+)/);
            if(m2){ 
                // 去除开头的数字，只保留后面的地址部分
                const s = m2[1].replace(/^\d+/, '');
                // 非标准格式(前缀)需要持久化
                return { shortAddr: s, shouldSave: true };
            }
            
            return null;
        }
        
        listenForConfigChanges() {
             if (window.chrome && chrome.storage) {
                chrome.storage.onChanged.addListener((changes, area) => {
                    if (area === 'local') {
                        if (changes.observer_enabled) {
                            this.enabled = !!changes.observer_enabled.newValue;
                            if (this.enabled) this.start(); else this.stop();
                        }
                        if (changes.observer_interval) {
                            this.interval = parseInt(changes.observer_interval.newValue) || 500;
                            if (this.enabled) this.startPeriodicCheck();
                        }
                    }
                });
            }
        }
    }

    // 挂载到 window 以便 content.js 调用（如果需要）
    window.GmgnObserverFeature = new ObserverFeature();
    // 自动初始化
    window.GmgnObserverFeature.init();

})();
