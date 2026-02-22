# Side Panel 架构迁移说明

## 概述
为了解决原插件界面遮挡网页原生内容（如支付弹窗）的问题，我们将架构从 **Content Script Injection**（页面注入）完全迁移到了 **Chrome Side Panel**（侧边栏）。

本次迁移实现了逻辑与视图的分离，确保了功能的独立性和用户体验的提升。

## 架构变更

### 1. 视图层 (Side Panel)
- **位置**: `src/sidepanel/`
- **入口**: `src/sidepanel/index.html` -> `index.jsx` -> `App.jsx`
- **职责**: 
  - 负责所有 UI 渲染（列表、设置、图表）。
  - 负责逻辑处理（数据排序、筛选、API 请求）。
  - 管理应用状态（配置、用户信息）。
- **通信**: 通过 `chrome.runtime.onMessage` 接收来自 Content Script 的数据（Hook 数据、价格更新）。

### 2. 数据层 (Content Script - Headless)
- **位置**: `src/content/index.jsx` (已重构)
- **状态**: **无头模式 (Headless)** - 不再渲染任何 DOM 元素。
- **职责**:
  - **Hook 注入**: 注入 `hook.js` 拦截网络请求。
  - **数据采集**: 监听 `HOOK_FETCH_XHR_EVENT`，解析并转发数据。
  - **DOM 监听**: 使用 `MutationObserver` 监听页面价格变化。
  - **环境感知**: 监听 URL 变化（Mint 地址变更）并通知 Side Panel。
- **通信**: 使用 `chrome.runtime.sendMessage` 将采集的数据发送给 Side Panel。

### 3. 通信协议
Side Panel 与 Content Script 之间的消息类型定义：

| 消息类型 | 方向 | 描述 | 携带数据 |
|---------|------|------|----------|
| `HOOK_DATA` | Content -> SidePanel | 拦截到的 Token Holders 数据 | `{ data: [...], url: "..." }` |
| `PRICE_UPDATE` | Content -> SidePanel | 实时价格更新 | `{ price: 123.45 }` |
| `MINT_CHANGED` | Content -> SidePanel | 页面 Token 发生变化 | `{ mint: "..." }` |
| `GET_PAGE_INFO` | SidePanel -> Content | 获取当前页面状态 (初始化用) | (Response) `{ mint, price }` |

## 迁移注意事项

1. **Storage 迁移**: 
   - 旧版主要使用 `localStorage` (绑定在 gmgn.ai 域名下)。
   - 新版全面迁移至 `chrome.storage.local` (扩展独立存储)。
   - **注意**: 用户旧的配置（如 Key、列宽设置）在升级后可能需要重新配置一次。

2. **API 请求**:
   - `handleFullRefresh` (Birdeye API) 现直接在 Side Panel 发起请求。
   - 依赖 `host_permissions` 权限跨域访问。

3. **Hook 刷新**:
   - 依赖 Content Script 捕获的 URL。
   - Side Panel 尝试直接复用该 URL 发起请求（可能受 Cookie 限制，如失效需手动刷新网页）。

## 开发指南

- **修改 UI**: 编辑 `src/sidepanel/App.jsx`。
- **修改抓取逻辑**: 编辑 `src/content/index.jsx` 或 `src/utils/api.js`。
- **添加样式**: 编辑 `src/content/styles.js` (Side Panel 仍引用此文件)。

## 优势
1. **零遮挡**: 侧边栏独立于网页内容，互不干扰。
2. **持久化**: 切换 Tab 或页面刷新时，Side Panel 状态更容易保持（虽然目前设计随 Tab 变化，但架构上更灵活）。
3. **性能**: UI 渲染不在宿主页面主线程，减少对网页性能的影响。
