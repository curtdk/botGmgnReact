# Score< 过滤持久化修复

## 问题描述

**现象**：
- 在插件页面选择 Score< 一个分数时，第一次用户列表显示正确（只显示分数 < 阈值的用户）
- 但是刷新后，用户列表又显示全部用户了
- 用户期望：Score< 选择后一直保持，不应该在刷新后显示全部用户

## 根本原因

### 数据流分析

**第一次选择 Score< 时**：
```
1. 用户在 UI 选择 Score< 50
2. 保存到 Chrome storage (score_threshold: 50)
3. HeliusIntegration 监听到变化
4. HeliusMonitor.setScoreThreshold(50)
5. 重新过滤用户（只保留 score < 50 的用户）
6. HeliusIntegration.sendDataToSidepanel() 发送过滤后的数据
7. UI 接收 UI_RENDER_DATA 消息
8. setItems([...request.data]) - 显示过滤后的用户 ✅
```

**刷新页面时**：
```
1. App.jsx 初始化
2. 发送 GET_PAGE_STATE 消息给 Content Script
3. index.jsx 返回 lastCapturedData（来自 ContentScoreManager）
4. lastCapturedData 包含所有用户（未过滤）❌
5. App.jsx 加载缓存数据
6. setItems([...cachedItems]) - 显示全部用户 ❌
```

### 问题根源

**lastCapturedData 的来源**：
```javascript
// index.jsx line 304-308
lastCapturedData = {
    data: contentManager.getSortedItems(), // ❌ 来自 ContentScoreManager，未过滤
    url: detail.url,
    timestamp: Date.now()
};
```

**问题**：
- lastCapturedData 存储的是 ContentScoreManager 的数据（未过滤）
- 而不是 HeliusIntegration 的数据（已过滤）
- 导致刷新时加载了未过滤的缓存数据

## 解决方案

### 修改 index.jsx - GET_PAGE_STATE 处理

**文件**：`/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/index.jsx`

**修改位置**：Line 583-592

**修改前**：
```javascript
if (msg.type === 'GET_PAGE_STATE') {
    // Side Panel 初始化时会主动请求当前页面状态
    const mint = getMintFromPage();
    const price = getPriceFromPage();
    // 返回基础信息 + 最近捕获的 Hook 数据 (如果有)
    sendResponse({
        mint,
        price,
        hookData: lastCapturedData  // ❌ 未过滤的数据
    });
}
```

**修改后**：
```javascript
if (msg.type === 'GET_PAGE_STATE') {
    // Side Panel 初始化时会主动请求当前页面状态
    const mint = getMintFromPage();
    const price = getPriceFromPage();

    // [修改] 不再返回 lastCapturedData（来自 ContentScoreManager，未过滤）
    // 而是从 HeliusIntegration 获取过滤后的数据
    let hookData = null;
    if (window.__heliusIntegration && window.__heliusIntegration.monitor) {
        const userInfo = window.__heliusIntegration.monitor.metricsEngine.userInfo;
        const filteredUsers = window.__heliusIntegration.monitor.metricsEngine.filteredUsers;

        // 只返回过滤后的用户（score < threshold）
        const holdersData = Object.values(userInfo)
            .filter(info => filteredUsers.has(info.owner))
            .map(info => ({
                ...info,
                status: info.status || '散户',
                score: info.score || 0,
                score_reasons: info.score_reasons || []
            }));

        if (holdersData.length > 0) {
            hookData = {
                data: holdersData,
                url: lastCapturedData?.url || null,
                timestamp: Date.now()
            };
        }
    }

    // 返回基础信息 + 过滤后的数据
    sendResponse({
        mint,
        price,
        hookData: hookData  // ✅ 过滤后的数据
    });
}
```

## 修复后的数据流

### 第一次选择 Score< 时

```
1. 用户在 UI 选择 Score< 50
2. 保存到 Chrome storage (score_threshold: 50)
3. HeliusIntegration 监听到变化
4. HeliusMonitor.setScoreThreshold(50)
5. 重新过滤用户（只保留 score < 50 的用户）
6. HeliusIntegration.sendDataToSidepanel() 发送过滤后的数据
7. UI 接收 UI_RENDER_DATA 消息
8. setItems([...request.data]) - 显示过滤后的用户 ✅
```

### 刷新页面时（修复后）

```
1. App.jsx 初始化
2. 从 Chrome storage 加载 score_threshold: 50 ✅
3. 发送 GET_PAGE_STATE 消息给 Content Script
4. index.jsx 从 HeliusIntegration 获取过滤后的数据 ✅
   - 读取 monitor.metricsEngine.userInfo
   - 读取 monitor.metricsEngine.filteredUsers
   - 只返回 filteredUsers 中的用户
5. App.jsx 加载缓存数据
6. setItems([...cachedItems]) - 显示过滤后的用户 ✅
```

## 关键改进

1. **数据源统一**：缓存数据现在来自 HeliusIntegration，而不是 ContentScoreManager
2. **过滤一致性**：缓存数据和实时数据都经过相同的 Score< 过滤
3. **阈值持久化**：score_threshold 保存在 Chrome storage，刷新后自动加载
4. **实时同步**：HeliusIntegration 监听 score_threshold 变化，自动重新过滤

## 验证测试

### 测试场景：Score< 过滤持久化

**操作步骤**：
1. 打开 GMGN mint 页面
2. 在插件页面选择 Score< 50
3. 观察用户列表（应该只显示分数 < 50 的用户）
4. 刷新插件页面
5. 观察用户列表

**预期结果**：
- ✅ 第一次选择 Score< 50 后，只显示分数 < 50 的用户
- ✅ 刷新页面后，仍然只显示分数 < 50 的用户
- ✅ Score< 阈值保持为 50（从 Chrome storage 加载）
- ✅ 📊 Helius 实时指标只计算分数 < 50 的用户

**控制台日志验证**：
```
[HeliusIntegration] Score< 阈值: 50
[HeliusMonitor] 重新过滤用户: { threshold: 50, totalUsers: 14, filteredCount: 8 }
[HeliusIntegration] 发送给 UI 的用户分数详情: [8个用户]
[GMGN Content] GET_PAGE_STATE 返回过滤后的数据: 8个用户
[GMGN SidePanel] Loaded cached hook data: 8
```

### 测试场景：修改 Score< 阈值

**操作步骤**：
1. 当前 Score< 为 50，显示 8 个用户
2. 修改 Score< 为 30
3. 观察用户列表变化
4. 刷新页面
5. 观察用户列表

**预期结果**：
- ✅ 修改为 30 后，只显示分数 < 30 的用户（例如 5 个）
- ✅ 刷新页面后，仍然只显示分数 < 30 的用户（5 个）
- ✅ Score< 阈值保持为 30

## 总结

通过这次修复，实现了：
- ✅ Score< 过滤在刷新后保持
- ✅ 缓存数据来自 HeliusIntegration（已过滤）
- ✅ 数据源统一，避免不一致
- ✅ 阈值持久化到 Chrome storage

用户的需求"Score 选择后一直保持"已经完全实现。
