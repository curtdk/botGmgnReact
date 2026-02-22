# GMGN 观察者功能分析 (Observer & Price)

本文档详细解析了扩展程序中两个核心的页面监控功能：**Price Observer** (价格监听) 和 **Page Observer** (页面内容/备注监听)。

## 1. 价格监听 (Price Observer)

### 功能概述
实时监控 GMGN 页面上的代币价格变化，并将最新价格推送到 Side Panel。

### 代码位置
*   **入口**: `src/content/index.jsx`
*   **工具函数**: `src/utils/api.js` (`findPriceDOM`, `getPriceFromPage`)

### 实现原理
1.  **智能定位**: 使用 `findPriceDOM()` 尝试多种 CSS 选择器策略，智能定位包含价格文本的 DOM 节点（通常是 `.info-item-title` 附近的数值）。
2.  **MutationObserver**: 创建一个 `MutationObserver` 实例，监听目标节点及其子树 (`subtree`) 和文本内容 (`characterData`) 的变化。
3.  **生命周期管理**:
    *   **启动**: 页面加载完成 (`DOMContentLoaded`) 时启动。
    *   **重试**: 如果找不到目标节点，会自动延时 2 秒重试 (`setTimeout`)。
    *   **重启**: 当检测到 URL 中的 Mint 地址变化时（意味着切换了代币），会强制销毁旧的 Observer 并重新启动 (`setupPriceObserver`)。

### 消息流
*   **发送**: `PRICE_UPDATE` -> `{ type: 'PRICE_UPDATE', price: 1.23 }`
*   **接收**: `SidePanel` 更新 `currentPrice` 状态，并显示在底部状态栏。

---

## 2. 页面/备注监听 (Page Observer / ObserverFeature)

### 功能概述
监控持仓列表或交易列表的变化，自动提取并同步用户对地址设置的“短名称/备注”。

### 代码位置
*   **入口**: `src/content/index.jsx`
*   **核心类**: `src/utils/ObserverFeature.js`

### 实现原理
1.  **目标锁定**: 监听 `.g-table-body`（表格主体）区域。
2.  **防抖扫描**: 使用 `MutationObserver` 监听 DOM 变化，并通过 `debounce` (防抖，默认 500ms) 机制合并频繁的更新，减少性能消耗。
3.  **智能提取**:
    *   扫描表格中所有指向 `/sol/address/` 的链接。
    *   提取显示的文本内容，识别出“非标准地址格式”的字符串（即用户自定义的备注）。
    *   与本地缓存对比，仅当备注发生变化时才触发更新。
4.  **稳定性增强 (本次重构)**:
    *   **集成到 Mint 检测**: 之前仅在脚本加载时启动。现在已集成到 `mintCheckTimer` 中，当检测到 Mint 地址变化（页面切换）时，会强制重启 Observer，确保在 SPA 应用中持续生效。
    *   **配置联动**: 监听 `chrome.storage`，支持动态开启/关闭和调整频率。

### 消息流
*   **发送**: `OBSERVER_UPDATE` -> `{ type: 'OBSERVER_UPDATE', data: [{ address, shortAddr }] }`
*   **接收**: `SidePanel` 接收后调用 `scoreManager.setShortAddress` 更新内存数据，并实时刷新列表 UI。

---

## 3. 核心交互图解

```mermaid
graph TD
    Page[GMGN 网页]
    MintTimer[Mint 变化检测器 (1s轮询)]
    
    subgraph Content Script
        PriceObs[Price Observer]
        PageObs[Page Observer]
        Hook[XHR Hook]
    end
    
    subgraph Side Panel
        UI[用户界面]
        Manager[WhaleScoreManager]
    end
    
    Page -- DOM变动 --> PriceObs
    Page -- DOM变动 --> PageObs
    Page -- XHR请求 --> Hook
    
    MintTimer -- 触发重启 --> PriceObs
    MintTimer -- 触发重启 --> PageObs
    
    PriceObs -- PRICE_UPDATE --> UI
    PageObs -- OBSERVER_UPDATE --> Manager
    Hook -- HOOK_DATA --> Manager
    
    Manager -- 更新数据 --> UI
```
