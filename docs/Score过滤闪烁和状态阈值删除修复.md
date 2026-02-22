# Score过滤闪烁和状态阈值删除修复

## 问题描述

### 问题 1: Score< 切换时用户列表闪烁
- 切换 Score< 下拉框后，Helius 实时指标没有变化
- 用户列表会闪烁：先显示全部用户，再过滤到选定分数内的用户
- 造成页面晃动，用户体验不好

### 问题 2: 删除状态阈值设置
- 用户不需要"状态≥40 为庄"的设置
- 用户只有分数，不需要状态标签
- 指标应该根据分数计算，不需要状态判断

## 根本原因

### 问题 1 原因

**数据流问题**：
1. HeliusIntegration 发送**所有用户**到 Sidepanel
2. Sidepanel UI 端根据 `minScore` 过滤用户
3. 导致：先渲染所有用户 → 再过滤 → 闪烁

**指标不更新问题**：
- `setScoreThreshold()` 只重新计算指标
- 但没有重新发送数据到 Sidepanel
- 导致 UI 不更新

### 问题 2 原因

- UI 中有"状态≥X 为庄"的下拉框
- 这个设置不再需要

## 修复方案

### 修复 1: 后端过滤，消除闪烁

#### 1.1 修改 sendDataToSidepanel() - 只发送过滤后的用户

**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js:696-750`

```javascript
sendDataToSidepanel() {
  if (!this.monitor) return;

  const userInfo = this.monitor.metricsEngine.userInfo;
  const filteredUsers = this.monitor.metricsEngine.filteredUsers;

  // 只发送过滤后的用户（score < threshold）
  const holdersData = Object.values(userInfo)
    .filter(info => filteredUsers.has(info.owner))  // ← 关键：只发送过滤后的用户
    .map(info => ({
      ...info,
      status: info.status || '散户',
      score: info.score || 0,
      score_reasons: info.score_reasons || []
    }));

  // 记录日志
  dataFlowLogger.log(
    'HeliusIntegration',
    '发送数据到 Sidepanel',
    `发送 ${holdersData.length} 个过滤后的用户数据到 Sidepanel UI`,
    {
      totalUsers: Object.keys(userInfo).length,
      filteredUsers: holdersData.length,
      scoreThreshold: this.monitor.scoreThreshold
    }
  );

  // 发送 Chrome 消息给 sidepanel
  chrome.runtime.sendMessage({
    type: 'UI_RENDER_DATA',
    data: holdersData,
    url: null
  }).then(() => {
    // 成功日志
  }).catch(err => {
    // 失败日志
  });
}
```

**效果**：
- ✅ 只发送符合 Score< 阈值的用户
- ✅ UI 不需要再过滤
- ✅ 消除闪烁

#### 1.2 删除 UI 端的 minScore 过滤

**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/sidepanel/App.jsx:768-777`

```javascript
// 旧代码（已删除）
const displayItems = items.filter(it => {
    // 分数筛选 (Score < X)
    if (minScore > 0 && (it.score || 0) >= minScore) return false;  // ← 删除此行

    const isBoss = (it.status === '庄家');
    if (isBoss && filterBoss) return true;
    if (!isBoss && filterRetail) return true;
    return false;
});

// 新代码
const displayItems = items.filter(it => {
    // 后端已经根据 Score< 过滤，这里只需要根据散户/庄家过滤
    const isBoss = (it.status === '庄家');
    if (isBoss && filterBoss) return true;
    if (!isBoss && filterRetail) return true;
    return false;
});
```

**效果**：
- ✅ UI 不再过滤分数
- ✅ 直接显示后端发送的过滤后用户
- ✅ 无闪烁

#### 1.3 阈值变化时重新发送数据

**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js:983-989`

```javascript
if (changes.score_threshold) {
  this.scoreThreshold = changes.score_threshold.newValue;
  console.log('[Helius集成] Score< 阈值已更新:', this.scoreThreshold);
  if (this.monitor) {
    this.monitor.setScoreThreshold(this.scoreThreshold);
    // 重新发送过滤后的数据到 Sidepanel
    this.sendDataToSidepanel();  // ← 新增：重新发送数据
  }
}
```

**效果**：
- ✅ 阈值变化时，立即重新发送过滤后的数据
- ✅ UI 实时更新
- ✅ Helius 实时指标实时更新

### 修复 2: 删除状态阈值设置

#### 2.1 删除状态阈值 UI

**文件**: `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/sidepanel/App.jsx:1136-1154`

**删除的代码**:
```jsx
{/* 状态阈值配置 */}
<div style={{ marginLeft: '8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
    <span style={{ color: styles.colors.textSecondary, fontSize: '11px' }}>状态≥</span>
    <select
        value={statusThreshold}
        onChange={e => {
          const val = parseInt(e.target.value);
          setStatusThreshold(val);
          chrome.storage.local.set({ status_threshold: val });
        }}
        style={{ background: '#374151', border: 'none', color: '#fff', borderRadius: '2px', fontSize: '11px', padding: '2px' }}
        title="分数 >= 此阈值显示为庄家，< 此阈值显示为散户"
    >
        {[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(v => (
            <option key={v} value={v}>{v}</option>
        ))}
    </select>
    <span style={{ color: styles.colors.textSecondary, fontSize: '10px' }}>为庄</span>
</div>
```

**效果**：
- ✅ 删除"状态≥40 为庄"设置
- ✅ UI 更简洁

## 数据流

### 修复前（有闪烁）

```
HeliusMonitor 计算分数并过滤
    ↓
HeliusIntegration.sendDataToSidepanel()
    ↓
发送所有用户（10个）
    ↓
Sidepanel 接收所有用户
    ↓
UI 渲染所有用户（闪烁开始）
    ↓
displayItems 过滤（minScore）
    ↓
UI 重新渲染过滤后的用户（闪烁结束）
    ↓
❌ 用户看到闪烁
```

### 修复后（无闪烁）

```
HeliusMonitor 计算分数并过滤
    ↓
HeliusIntegration.sendDataToSidepanel()
    ↓
只发送过滤后的用户（例如 5个，score < 30）
    ↓
Sidepanel 接收过滤后的用户
    ↓
UI 直接渲染（无需再过滤）
    ↓
✅ 无闪烁，流畅显示
```

### Score< 阈值变化流程

```
用户切换 Score< 下拉框（例如从 30 改为 50）
    ↓
App.jsx: setMinScore(50)
    ↓
chrome.storage.local.set({ score_threshold: 50 })
    ↓
HeliusIntegration 监听 storage 变化
    ↓
HeliusIntegration.scoreThreshold = 50
    ↓
monitor.setScoreThreshold(50)
    ↓
HeliusMonitor.setScoreThreshold(50)
    ├─ 重新过滤用户（score < 50）
    ├─ 更新 filteredUsers
    └─ 重新计算指标
    ↓
HeliusIntegration.sendDataToSidepanel()  ← 新增
    ↓
只发送过滤后的用户
    ↓
Sidepanel 接收新数据
    ↓
✅ UI 实时更新，无闪烁
✅ Helius 实时指标实时更新
```

## 验证测试

### 测试 1: Score< 切换无闪烁

1. 打开 GMGN mint 页面
2. 打开 Sidepanel
3. 点击"持有人启动"
4. 观察用户列表（例如显示 10 个用户）
5. 切换 Score< 下拉框（例如从 0 改为 30）
6. 观察用户列表

**预期结果**：
- ✅ 用户列表直接更新为过滤后的用户（例如 5 个）
- ✅ 无闪烁，无晃动
- ✅ Helius 实时指标立即更新
- ✅ 已落袋、本轮下注等数值变化

### 测试 2: 状态阈值设置已删除

1. 打开 Sidepanel
2. 查看用户列表上方的过滤栏

**预期结果**：
- ✅ 只有 Score< 下拉框
- ✅ 没有"状态≥40 为庄"设置
- ✅ UI 更简洁

### 测试 3: 日志验证

1. 切换 Score< 阈值
2. 导出数据流日志
3. 查看日志

**预期日志**：
```
[HeliusIntegration] 发送数据到 Sidepanel
    发送 5 个过滤后的用户数据到 Sidepanel UI
    数据: {
      totalUsers: 10,
      filteredUsers: 5,
      scoreThreshold: 30
    }

[HeliusIntegration] Sidepanel 消息发送成功
    成功发送 5 个用户数据
```

## 技术细节

### 为什么会闪烁？

**React 渲染机制**：
1. `setItems([...allUsers])` - 设置所有用户
2. React 渲染所有用户
3. `displayItems` 过滤用户
4. React 重新渲染过滤后的用户
5. 用户看到：全部 → 过滤后（闪烁）

**解决方案**：
- 后端过滤，只发送需要显示的用户
- UI 直接渲染，无需再过滤
- 只有一次渲染，无闪烁

### filteredUsers 的作用

`MetricsEngine.filteredUsers` 是一个 Set，存储所有符合 Score< 阈值的用户地址：

```javascript
// 例如：scoreThreshold = 30
filteredUsers = Set([
  "7fqnQtQc...",  // score: 25
  "Gygj9QQb...",  // score: 15
  "CMbC79R1..."   // score: 20
])

// 不包含：
// "6A9bU54h..."  // score: 35 (>= 30)
```

**用途**：
1. 指标计算：只计算 filteredUsers 中的用户
2. 数据发送：只发送 filteredUsers 中的用户到 UI

## 相关文档

- [Score过滤和UI清理修复.md](./Score过滤和UI清理修复.md) - Score< 过滤生效修复
- [ContentManager命名清理和消息发送优化.md](./ContentManager命名清理和消息发送优化.md) - 消息发送优化
- [用户列表不显示分数问题修复.md](./用户列表不显示分数问题修复.md) - 分数显示修复

## 总结

通过这次修复：

1. ✅ **消除闪烁**：后端过滤，UI 直接显示，无需再过滤
2. ✅ **实时更新**：阈值变化时重新发送数据，UI 和指标实时更新
3. ✅ **删除冗余设置**：删除"状态≥40 为庄"设置，UI 更简洁
4. ✅ **优化日志**：日志显示过滤前后的用户数量，方便调试

**关键改进**：
- 数据过滤从 UI 端移到后端
- 阈值变化时触发数据重新发送
- 删除不需要的状态阈值设置
- 用户体验更流畅，无闪烁
