# 功能更新：WhaleScoreManager 优化与修复

## 概述
本次更新主要修复了 **Side Panel 模式下** 短地址（Short Address）的更新不生效以及设置页面无法导出/导入数据的问题。

## 变更内容

### 1. 实时更新优化 (`src/utils/WhaleScoreManager.js`)
**修改点**：`setShortAddress` 方法
**说明**：之前该方法仅更新了底层的 `shortAddressMap` 存储，但没有同步更新当前内存中用于渲染的列表项。
**修复**：增加了实时更新内存索引 (`this.index`) 的逻辑。现在调用该方法后，无需全量刷新数据，UI 即可反映最新的短名称。

```javascript
setShortAddress(owner, shortAddr) {
    // ...
    if (this.shortAddressMap[owner] !== shortAddr) {
        this.shortAddressMap[owner] = shortAddr;
        this.saveShortAddressMap();
        
        // [新增] 实时更新内存索引，确保 UI 立即响应
        const item = this.index.get(owner);
        if (item) {
            item.main_address_short = shortAddr;
        }
    }
}
```

### 2. Side Panel 逻辑修正 (`src/sidepanel/App.jsx`)
**修改点 1**：`OBSERVER_UPDATE` 消息处理
**说明**：之前是调用 `updateData` 进行部分更新，但这可能导致非预期的数据覆盖。
**修复**：改为直接调用 `setShortAddress`，这是专门处理备注更新的正确方法。

**修改点 2**：`SettingsModal` 传参
**说明**：Side Panel 架构下，`window.gmgnScoreManager` 并不总是可用（或与当前实例不同步）。
**修复**：将 `scoreManagerRef.current` 作为 prop 显式传递给 `SettingsModal`，解决了导出/导入按钮点击无反应的问题。

### 3. 导出/导入功能修复 (`src/content/components/SettingsModal.jsx`)
**修改点**：`handleExport` / `handleImport` / `handleClear`
**说明**：增加了对 `props.scoreManager` 的支持，优先使用传入的实例，回退到全局实例。增加了错误提示。

## 验证步骤
1.  **备注同步**：在 GMGN 网页上修改某个地址的备注，Side Panel 列表应立即更新显示该备注。
2.  **数据导出**：在 Side Panel 设置中点击“短地址 -> 导出”，应正常下载 `gmgn_short_map.json` 文件。
