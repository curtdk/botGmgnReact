# Score< 过滤持久化修复完成

## 问题描述

用户报告:插件用户列表会瞬间返回显示大于 Score< 的用户。Score< 选择后应该一直保持,但刷新后又显示全部用户。

## 问题根源

通过分析日志文件,发现问题在于 **地址匹配逻辑错误**:

### 数据结构

```javascript
// userInfo 的结构
userInfo = {
  "address1": { owner: "address1", score: 20, ... },
  "address2": { owner: "address2", score: 10, ... },
  "undefined": { owner: undefined, score: 0, ... }  // 问题所在!
}

// filteredUsers Set 的内容
filteredUsers = Set(["address1", "address2", "undefined"])
```

### 问题分析

1. **userInfo 的 key 是字符串**:
   - 当 `holderData.owner` 是 `undefined` 时
   - JavaScript 对象的 key 会自动转换为字符串
   - 所以 `userInfo[undefined]` 实际上是 `userInfo["undefined"]`

2. **userInfo[address].owner 是实际的 undefined 值**:
   - `userInfo["undefined"].owner = undefined` (实际的 undefined 值)

3. **filteredUsers Set 中存储的是字符串**:
   - `scoreMap.set("undefined", {...})`
   - `filteredUsers.add("undefined")`

4. **原来的过滤逻辑失败**:
   ```javascript
   Object.values(userInfo)
     .filter(info => filteredUsers.has(info.owner))
   ```
   - `info.owner` 是 `undefined` (实际的 undefined 值)
   - `filteredUsers.has(undefined)` 返回 `false`
   - 因为 Set 中存储的是字符串 `"undefined"`,不是实际的 `undefined` 值

### 日志证据

```
[10] HeliusMonitor 步骤4: 过滤用户
    根据阈值 10 过滤，保留 1 个用户
    filteredCount: 1

[15] HeliusIntegration 发送数据到 Sidepanel
    发送 0 个过滤后的用户数据到 Sidepanel UI
    filteredUsers: 0
```

HeliusMonitor 过滤出了 1 个用户,但 HeliusIntegration 发送了 0 个用户!

## 修复方案

### 修改文件

`/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js`

### 修改内容

**修改前**:
```javascript
const holdersData = Object.values(userInfo)
  .filter(info => filteredUsers.has(info.owner))
  .map(info => ({
    ...info,
    status: info.status || '散户',
    score: info.score || 0,
    score_reasons: info.score_reasons || []
  }));
```

**修改后**:
```javascript
// 使用 Object.entries() 来同时获取 key 和 value
// 用 key (address) 来匹配 filteredUsers Set,而不是 info.owner
// 这样可以正确处理 undefined 地址的情况
const holdersData = Object.entries(userInfo)
  .filter(([address]) => filteredUsers.has(address))
  .map(([, info]) => ({
    ...info,
    status: info.status || '散户',
    score: info.score || 0,
    score_reasons: info.score_reasons || []
  }));
```

### 修复原理

1. **使用 Object.entries() 而不是 Object.values()**:
   - `Object.entries(userInfo)` 返回 `[["address1", {...}], ["address2", {...}], ["undefined", {...}]]`
   - 同时获取 key (address) 和 value (info)

2. **用 key 来匹配 filteredUsers Set**:
   - `filteredUsers.has(address)` 中的 `address` 是字符串 (包括 `"undefined"`)
   - 与 filteredUsers Set 中存储的字符串完全匹配

3. **正确处理 undefined 地址**:
   - 当 address 是字符串 `"undefined"` 时
   - `filteredUsers.has("undefined")` 返回 `true`
   - 用户被正确过滤出来

## 测试验证

### 测试场景 1: threshold=10, 用户分数=0

**预期**:
- HeliusMonitor 过滤: filteredCount=1
- HeliusIntegration 发送: filteredUsers=1
- 插件显示 1 个用户

### 测试场景 2: threshold=20, 用户分数=10

**预期**:
- HeliusMonitor 过滤: filteredCount=1
- HeliusIntegration 发送: filteredUsers=1
- 插件显示 1 个用户

### 测试场景 3: threshold=20, 多个用户

**预期**:
- 只显示分数 < 20 的用户
- 分数 >= 20 的用户不显示
- 过滤持久化,刷新后保持

## 相关文件

1. `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/content/HeliusIntegration.js` - 修复过滤逻辑
2. `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/HeliusMonitor.js` - 过滤用户方法
3. `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/MetricsEngine.js` - 用户信息管理
4. `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/src/helius/ScoringEngine.js` - 分数计算

## 总结

这次修复解决了 Score< 过滤不生效的问题。问题的根源是:
1. JavaScript 对象的 key 会自动转换为字符串
2. 原来的过滤逻辑使用 `info.owner` (可能是 undefined 值) 来匹配
3. 导致字符串 `"undefined"` 与实际的 `undefined` 值不匹配

修复后,使用 Object.entries() 获取 key,直接用 key 来匹配 filteredUsers Set,确保类型一致,问题得到解决。
