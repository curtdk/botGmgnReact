export default class ObserverFeature {
    constructor(onUpdate, onGetShort, onLog, interval = 500) {
        this.observer = null;
        this.debounceTimer = null;
        this.onUpdate = onUpdate; // Callback(updates[])
        this.onGetShort = onGetShort; // Callback(address) -> shortName
        this.onLog = onLog; // Callback(msg) -> void
        this.interval = interval;
        this.isActive = false; // 内部状态，仅用于控制循环
    }

    log(msg) {
        if (this.onLog) this.onLog(msg);
    }

    // 仅用于更新参数
    setInterval(interval) {
        this.interval = interval;
    }

    start() {
        if (this.isActive) return;
        this.isActive = true;
        this.log('服务启动');
        this.startObserving();
    }

    stop() {
        this.log('服务停止');
        this.isActive = false;
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    restart() {
        this.log('正在重启...');
        this.stop();
        this.start();
    }

    startObserving() {
        const checkAndStart = () => {
            if (!this.isActive) return;

            // GMGN 的表格体 class 通常是 .g-table-body
            const targetNode = document.querySelector('.g-table-body');
            if (!targetNode) {
                // 如果还没加载出来，稍后重试
                setTimeout(checkAndStart, 2000);
                return;
            }

            // 清理旧的 observer
            if (this.observer) this.observer.disconnect();

            // 创建新的 observer
            this.observer = new MutationObserver(() => this.scheduleScan());
            this.observer.observe(targetNode, { childList: true, subtree: true, characterData: true });
            this.log('Observer 已绑定到 .g-table-body');
            
            // 立即扫描一次
            this.scheduleScan();
        };
        checkAndStart();
    }

    scheduleScan() {
        this.log('scheduleScan11');
        this.log(this.interval);

        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.log('scheduleScan12');

            this.scanAndProcess();
            this.debounceTimer = null;
        }, this.interval || 500); // 使用配置的间隔
    }

    scanAndProcess() {
        this.log('scanAndProcess');
        if (!this.isActive) return;
        this.log('执行扫描...');

        const addressLinks = document.querySelectorAll('a[href*="/sol/address/"]');
        const updates = [];

        addressLinks.forEach(link => {
            const address = this.extractAddress(link.href);
            if (!address) return;
            // this.log('address: ' + address);

            // 1. 获取已保存的短名称
            const savedShort = this.onGetShort ? this.onGetShort(address) : null;
            // this.log('获取已保存的短名称: ' + savedShort);

            // 尝试获取所在行文本
            const row = link.closest('.flex.flex-row') || link.parentElement;
            if (row) {
                let currentText = (row.textContent || '').trim();
                
                // 2. 尝试提取当前显示的有效短名称
                const extracted = this.extractMainShort(currentText);
                // this.log('currentText: ' + currentText);

                if (extracted && extracted.shouldSave) {
                    
                    // 情况 A: 页面显示了一个有效的用户备注
                    if (extracted.shortAddr !== savedShort) {
                        // 如果与已保存的不同，说明用户刚刚修改了它 -> 视为新更新
                        updates.push({ address, shortAddr: extracted.shortAddr });
                        this.log(' updates.push '+extracted.shortAddr);
                    }
                }
            }
        });

        if (updates.length > 0) {
            this.onUpdate(updates);
            this.log('执行扫描...this.onUpdate(updates);');
        }
    }

    extractAddress(href) {
        const match = href.match(/\/sol\/address\/([A-Za-z0-9]+)/);
        return match ? match[1] : null;
    }

    extractMainShort(str) {
        // 1. 尝试标准 "ABCD...WXYZ" 格式 (这种不需要保存，因为是默认显示)
        var m = str.match(/(?:^|\s)\d{0,3}\s*([1-9A-HJ-NP-Za-km-z]{4,})\.\.\.([1-9A-HJ-NP-Za-km-z]{4})/);
        if(m){ 
            // 标准格式不持久化
            return null; 
        }
        
        // 2. 尝试仅有前缀的情况 (用户案例: "1ac💦..." -> "1ac" -> "ac")
        // 规则：捕获行首的字符，如果是数字开头后跟Base58字符，则去除开头的数字(Rank 1-1000)
        var m2 = str.match(/^(\d*[1-9A-HJ-NP-Za-km-z]+)/);
        if(m2){ 
            // 去除开头的数字，只保留后面的地址部分
            const s = m2[1].replace(/^\d+/, '');
            
            // 简单的过滤：如果看起来像是一个完整的长地址，也不保存（可能是数据未截断）
            if (s.length > 30) return null;

            // 非标准格式(前缀/备注)需要持久化
            return { shortAddr: s, shouldSave: true };
        }
        
        return null;
    }
}
