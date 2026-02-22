/**
 * FlowerMarker.js
 * 负责在页面 DOM 元素上添加标记（小花/火焰）的模块
 */

export default class FlowerMarker {
    constructor() {
        this.enabled = false;
        // 使用 WeakSet 追踪已处理的 DOM 元素，防止重复处理
        // WeakSet 会自动处理元素被移除的情况，不会造成内存泄漏
        this.markedElements = new WeakSet();
    }

    /**
     * 设置是否启用标记
     * @param {boolean} enabled 
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.clearAll();
        }
    }

    /**
     * 清除所有标记
     */
    clearAll() {
        document.querySelectorAll('.gmgn-flower-icon').forEach(el => el.remove());
        // 清除标记状态
        document.querySelectorAll('[data-gmgn-marked="true"]').forEach(el => {
            delete el.dataset.gmgnMarked;
        });
        // WeakSet 无法清空，但在 DOM 元素被移除后会自动失效
        // 对于保留在页面上的元素，上面的 remove 和 delete dataset 已经足够重置状态
        // 如果需要彻底重置，可以创建一个新的 WeakSet
        this.markedElements = new WeakSet();
    }

    /**
     * 执行标记逻辑
     * @param {Map} dataMap - 包含用户数据的 Map (address -> userInfo)
     * @param {Object} config - (可选) 配置对象，包含 fire_thresholds
     */
    mark(dataMap, config) {
        if (!this.enabled || !dataMap || dataMap.size === 0) return;
        
        // 默认阈值
        const thresholds = config?.fire_thresholds || [100, 200, 300];

        // 查找所有地址链接
        const links = document.querySelectorAll('a[href*="/sol/address/"]');
        
        links.forEach(link => {
            // 优化：跳过不包含可见文本的链接（例如头像链接），避免视觉上的重复标记
            if (!link.textContent || link.textContent.trim() === '') {
                return;
            }

            // 防重检查 1: WeakSet (内存级检查)
            if (this.markedElements.has(link)) return;

            // 防重检查 2: dataset 标记 (DOM级检查)
            if (link.dataset.gmgnMarked) return;

            // 过滤容器链接 (Container Link Filter)
            // 策略1: 复杂度检查。如果链接包含超过 2 个 div 子元素，视为容器链接并跳过。
            // (内层地址链接通常只有 1 个 div 用于显示文本，外层容器包含布局、图标等多个 div)
            if (link.getElementsByTagName('div').length > 2) return;

            // 策略2: 嵌套检查。如果链接内部还包含其他链接，视为容器链接并跳过。
            // (虽然 HTML5 禁止 a 嵌套 a，但部分浏览器或框架可能会渲染出此结构，或者 querySelector 能检测到)
            if (link.querySelector('a')) return;

            const href = link.getAttribute('href');
            const match = href.match(/\/sol\/address\/([A-Za-z0-9]+)/);
            if (!match) return;

            const address = match[1];
            const user = dataMap.get(address);

            if (user) {
                // 仅标记 散户 (status !== '庄家')
                if (user.status === '庄家') return;

                // 统一显示为 小花 (根据最新指示：用户是散户不是庄家就有小花，这是唯一条件)
                // 修正2：根据用户最新指示 "显示小火焰的 也一定是 散户 也应该显示 小花" -> 意味着要组合显示
                // 修正3：位置向左移动约 6个小花位置 -> left: -90px
                
                // 基础图标：小花
                let icon = '🌸';
                let title = '散户';
                
                // 计算购买金额 (优先取 trade 累积的 total_buy_u，其次取 history_bought_cost)
                const buyAmount = parseFloat(user.total_buy_u || user.history_bought_cost || 0);

                // 根据阈值追加火焰
                if (buyAmount > thresholds[2]) {
                    icon += ' 🔥🔥🔥';
                    title += ` | 买入 > $${thresholds[2]} (${buyAmount.toFixed(0)})`;
                } else if (buyAmount > thresholds[1]) {
                    icon += ' 🔥🔥';
                    title += ` | 买入 > $${thresholds[1]} (${buyAmount.toFixed(0)})`;
                } else if (buyAmount > thresholds[0]) {
                    icon += ' 🔥';
                    title += ` | 买入 > $${thresholds[0]} (${buyAmount.toFixed(0)})`;
                }

                if (icon) {
                    // 查找行容器 (参考 observer_feature.js 逻辑)
                    // 行容器通常是 .flex.flex-row
                    const row = link.closest('.flex.flex-row');

                    if (row) {
                        // 策略 A: 注入到行容器最左侧 (锁定本行)
                        
                        // 防重检查 3: 检查行容器是否已处理
                        if (row.querySelector('.gmgn-flower-icon')) return;

                        const span = document.createElement('span');
                        span.className = 'gmgn-flower-icon';
                        span.textContent = icon;
                        span.title = title;
                        
                        // 样式优化：绝对定位到行首
                        span.style.position = 'absolute';
                        span.style.left = '4px'; // 紧贴行首 (时间列左侧或上方)
                        span.style.top = '50%';
                        span.style.transform = 'translateY(-50%)';
                        span.style.cursor = 'help';
                        span.style.fontSize = '12px';
                        span.style.whiteSpace = 'nowrap'; 
                        span.style.pointerEvents = 'auto'; 
                        span.style.zIndex = '100'; // 确保在最上层

                        // 确保行容器有定位上下文
                        const computedStyle = window.getComputedStyle(row);
                        if (computedStyle.position === 'static') {
                            row.style.position = 'relative';
                        }
                        
                        // 插入到行容器的最前面
                        row.insertBefore(span, row.firstChild);
                        
                        // 标记链接已处理 (虽然图标不在链接里，但避免重复扫描)
                        link.dataset.gmgnMarked = 'true';
                        this.markedElements.add(link);
                        
                    } else {
                        // 策略 B: 找不到行容器时的回退 (注入到链接内部，同旧逻辑)
                        // 防重检查
                        if (link.querySelector('.gmgn-flower-icon')) return;

                        const span = document.createElement('span');
                        span.className = 'gmgn-flower-icon';
                        span.textContent = icon;
                        span.title = title;
                        
                        span.style.position = 'absolute';
                        span.style.left = '-90px'; 
                        span.style.top = '50%';
                        span.style.transform = 'translateY(-50%)';
                        span.style.zIndex = '100';
                        span.style.whiteSpace = 'nowrap';

                        if (link.style.position !== 'absolute' && link.style.position !== 'fixed') {
                            link.style.position = 'relative';
                        }
                        link.style.overflow = 'visible'; // 尝试强制显示
                        
                        link.appendChild(span);
                        link.dataset.gmgnMarked = 'true';
                        this.markedElements.add(link);
                    }
                }
            }
        });
    }
}
