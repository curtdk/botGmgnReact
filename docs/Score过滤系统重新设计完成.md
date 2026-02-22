# Score< 过滤系统重新设计完成

## 修复概述

根据用户要求,删除了 ContentScoreManager 的评分功能,重新设计了 Score< 过滤系统,确保数据源保持数据分数,更新后的分数根据固定的 Score< 阈值提前在数据源中刷新计算后给 UI。

## 核心问题

**双重数据处理系统导致的问题**:
1. ContentScoreManager 和 HeliusMonitor 并行运行,各自处理相同的数据
2. 两个系统都使用 BossLogic 进行评分,但维护各自的数据副本
3. 数据流冲突导致过滤失效和状态不一致
4. Score< 选择后,用户列表会瞬间返回显示大于 Score< 的用户

## 修复方案

### 1. 删除 ContentScoreManager 的评分功能

**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/index.jsx`

**修改内容**:
- 删除 Line 777: `contentManager.updateHolders(items)` 调用
- 删除 Line 788: `const holders = Array.from(contentManager.dataMap.values())`
- 删除 Line 795-799: `safeSendMessage({ type: 'UI_RENDER_DATA', data: contentManager.getSortedItems() })`
- 删除 Line 923: `newCount = contentManager.updateTrades(trades)` 调用
- 删除 Line 927: `const holders = Array.from(contentManager.dataMap.values())`
- 删除 Line 951-955: `safeSendMessage({ type: 'UI_RENDER_DATA', data: contentManager.getSortedItems() })`

**修改后的逻辑**:
```javascript
// EXECUTE_HOOK_REFRESH 处理器
if (items && Array.isArray(items) && items.length > 0) {
    // 只调用 HeliusIntegration,不再调用 contentManager
    window.dispatchEvent(new CustomEvent('HOOK_HOLDERS_EVENT', {
        detail: { holders: items }
    }));

    if (window.__heliusIntegration) {
        window.__heliusIntegration.updateGmgnHolders(items);
    }
}

// EXECUTE_TRADES_REFRESH 处理器
if (trades.length > 0) {
    // 只调用 HeliusIntegration,不再调用 contentManager
    if (window.__heliusIntegration) {
        window.dispatchEvent(new CustomEvent('HOOK_FETCH_XHR_EVENT', {
            detail: {
                type: 'fetch',
                url: currentUrl,
                responseBody: JSON.stringify({ data: { history: trades } })
            }
        }));
    }
}
```

### 2. 统一配置默认值

**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js`

**修改内容**:
```javascript
// 统一默认值,明确检查 undefined
this.scoreThreshold = res.score_threshold !== undefined ? res.score_threshold : 100;
this.statusThreshold = res.status_threshold !== undefined ? res.status_threshold : 50;
```

**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/sidepanel/App.jsx`

**修改内容**:
```javascript
// 统一默认值为 100
setMinScore(res.score_threshold !== undefined ? res.score_threshold : 100);
// 统一默认值为 50
setStatusThreshold(res.status_threshold !== undefined ? res.status_threshold : 50);
```

### 3. 数据流简化

**修改前**:
```
GMGN API 数据
    ↓
[分支 1] ContentScoreManager.updateHolders()
    ↓ 评分计算 (BossLogic)
    ↓ contentManager.dataMap
    ↓ getSortedItems() → UI

[分支 2] HeliusIntegration.updateGmgnHolders()
    ↓ HeliusMonitor.updateHolderData()
    ↓ ScoringEngine.calculateScores() (BossLogic)
    ↓ 过滤 (score < threshold)
    ↓ sendDataToSidepanel() → UI
```

**修改后**:
```
GMGN API 数据
    ↓
HeliusIntegration.updateGmgnHolders()
    ↓ HeliusMonitor.updateHolderData()
    ↓ ScoringEngine.calculateScores() (BossLogic)
    ↓ 过滤 (score < threshold)
    ↓ sendDataToSidepanel() → 只发送过滤后的数据
    ↓ UI 接收并显示
```

## 关键改进

1. **唯一数据源**: HeliusMonitor 作为唯一的数据处理和存储中心
2. **提前过滤**: 在数据源中根据 Score< 阈值提前过滤,然后发送给 UI
3. **配置持久化**: 所有配置从 Chrome Storage 加载,默认值一致
4. **简化数据流**: 删除 ContentScoreManager 的评分功能,避免重复处理
5. **配置监听**: HeliusIntegration 监听 Chrome Storage 变化,配置变化时实时同步并重新过滤

## 验证测试

### 测试场景 1: 配置加载验证

**操作**:
1. 清空 Chrome Storage
2. 刷新页面
3. 观察控制台日志

**预期**:
- ✅ HeliusIntegration 加载配置,默认值 score_threshold = 100
- ✅ UI 显示 Score< 选择器,默认值 100
- ✅ 前后端配置一致

### 测试场景 2: Score< 过滤验证

**操作**:
1. 打开 GMGN mint 页面
2. 在 UI 中选择 Score< 50
3. 观察用户列表

**预期**:
- ✅ 只显示分数 < 50 的用户
- ✅ 刷新页面后过滤保持
- ✅ 不会瞬间显示全部用户

### 测试场景 3: 配置变化验证

**操作**:
1. 在 UI 中修改 Score< 阈值
2. 观察控制台日志和用户列表

**预期**:
- ✅ Chrome Storage 更新
- ✅ HeliusIntegration 接收配置变化
- ✅ HeliusMonitor 重新过滤
- ✅ UI 实时更新

### 测试场景 4: 无干扰验证

**操作**:
1. 确认 contentManager.updateHolders 已删除
2. 只有 HeliusIntegration 处理数据
3. 观察数据流

**预期**:
- ✅ 没有重复处理
- ✅ 没有数据竞争
- ✅ 过滤逻辑清晰

## 修改文件清单

1. `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/index.jsx`
   - 删除 contentManager.updateHolders/updateTrades 调用
   - 只保留 HeliusIntegration 调用

2. `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js`
   - 统一配置默认值 (score_threshold = 100)
   - 配置变化时重新过滤并发送数据

3. `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/sidepanel/App.jsx`
   - 统一默认值为 100
   - 确保 UI 与后端配置一致

## 总结

通过这次重新设计,实现了:

1. ✅ **删除重复处理**: 只有 HeliusMonitor 处理数据,避免 ContentScoreManager 干扰
2. ✅ **统一配置**: 所有配置从 Chrome Storage 加载,默认值一致
3. ✅ **提前过滤**: 在数据源中根据 Score< 阈值过滤,然后发送给 UI
4. ✅ **简化数据流**: GMGN → HeliusIntegration → HeliusMonitor → UI
5. ✅ **配置持久化**: 配置变化时实时同步并重新过滤

这个方案删除了造成干扰的旧功能,重新设计了 Score< 过滤系统,确保数据源保持数据分数,更新后的分数根据固定的 Score< 阈值提前在数据源中刷新计算后给 UI。
