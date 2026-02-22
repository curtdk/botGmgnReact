# Score< 过滤调试日志添加

## 问题描述

用户报告:插件用户列表会瞬间返回显示大于 Score< 的用户。Score< 选择后应该一直保持,但刷新后又显示全部用户。

## 日志分析发现

通过分析 `/www/wwwroot/py/pumpfunbot/gmgn-extension-react/dataweb/浏览器日志.html`,发现:

### 关键问题

1. **scoreThreshold 在变化**:
   - 大部分时候是 20
   - 某些时刻变成了 10

2. **数据不匹配**:
   - HeliusMonitor 过滤: `filteredCount=2, threshold=20`
   - HeliusIntegration 发送: `filteredUsers=1, scoreThreshold=20`

   HeliusMonitor 过滤出了 2 个用户,但 HeliusIntegration 只发送了 1 个用户。

3. **threshold=10 时更明显**:
   - HeliusMonitor 过滤: `filteredCount=1, threshold=10`
   - HeliusIntegration 发送: `filteredUsers=0, scoreThreshold=10`

   HeliusMonitor 过滤出了 1 个用户,但 HeliusIntegration 发送了 0 个用户!

### 分数分布

```
分数 0: 1 个用户 (address: "undefine...")
分数 10: 1 个用户 (address: "r7rV2oHq...")
分数 20: 13 个用户
分数 30: 3 个用户
```

### 问题根源推测

当 threshold=10 时,应该过滤出分数 < 10 的用户,即分数为 0 的那个用户 (address: "undefine...")。

但是 HeliusIntegration.sendDataToSidepanel() 发送了 0 个用户,说明过滤逻辑有问题。

可能的原因:
1. filteredUsers Set 中存储的地址格式与 userInfo 中的 owner 字段不匹配
2. 或者 filteredUsers Set 中的地址是完整地址,而 userInfo 中的 owner 是截断的地址
3. 或者 userInfo[undefined] 没有被 Object.values() 正确处理

## 修复方案

### 步骤 1: 添加详细调试日志

在 `HeliusIntegration.sendDataToSidepanel()` 中添加详细日志:

```javascript
// 调试日志：显示 filteredUsers Set 的内容
console.log('[HeliusIntegration] filteredUsers Set:', Array.from(filteredUsers));
console.log('[HeliusIntegration] userInfo keys:', Object.keys(userInfo));
console.log('[HeliusIntegration] userInfo owners:', Object.values(userInfo).map(u => u.owner));

// 只发送过滤后的用户（score < threshold）
const allUsers = Object.values(userInfo);
console.log('[HeliusIntegration] 过滤前用户数:', allUsers.length);

const holdersData = allUsers
  .filter(info => {
    const isFiltered = filteredUsers.has(info.owner);
    console.log(`[HeliusIntegration] 检查用户 ${info.owner}: isFiltered=${isFiltered}, score=${info.score}`);
    return isFiltered;
  })
  .map(info => ({
    ...info,
    status: info.status || '散户',
    score: info.score || 0,
    score_reasons: info.score_reasons || []
  }));

console.log('[HeliusIntegration] 过滤后用户数:', holdersData.length);
```

### 步骤 2: 测试验证

1. 打开 GMGN mint 页面
2. 在插件中选择 Score< 10
3. 观察控制台日志,查看:
   - filteredUsers Set 中的地址
   - userInfo keys 中的地址
   - userInfo owners 中的地址
   - 每个用户的过滤结果

### 步骤 3: 根据日志结果修复

根据日志输出,确定:
1. filteredUsers Set 和 userInfo 的 key 是否一致
2. info.owner 是否与 filteredUsers Set 中的地址匹配
3. 是否有 undefined 或 null 的地址导致匹配失败

## 预期结果

添加日志后,应该能看到:
- filteredUsers Set 包含哪些地址
- userInfo 中有哪些地址
- 每个用户的 owner 字段值
- 过滤逻辑为什么失败

## 下一步

根据日志输出,修复过滤逻辑,确保:
1. filteredUsers Set 中的地址与 userInfo[address].owner 一致
2. 过滤逻辑正确处理所有用户,包括 undefined 地址
3. Score< 选择后持久化,不会被重置
