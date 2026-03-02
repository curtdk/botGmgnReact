# 保证 Sig 顺序处理计算

## 核心目标

4 大参数（持仓轮次、买卖统计、胜率等）的计算必须满足两个条件：

1. **排序正确**：按 Helius API 返回的链上顺序（slot ASC，区块内 blockIndex ASC）从旧到新处理
2. **连续完整**：只计算到第一个数据缺口（`hasData=false`）为止；缺口补全后，从中断处继续计算，不重复已处理的交易

---

## 实现机制

### 关键方法：`getReadySignaturesSequential()`

**位置**：`src/helius/SignatureManager.js`

**逻辑**：

```
1. 收集所有 isProcessed=false 的 sig（含 hasData=false 的 gap）
2. 按时序从旧到新排序（同 getReadySignatures 的排序规则）
3. 遍历排序结果：
     - hasData=true  → 加入返回列表
     - hasData=false → 立即 break（停在缺口前）
4. 返回连续完整的前段
```

**水位线自动推进**：
已处理的 sig（`isProcessed=true`）被过滤掉，下次调用时扫描自然从缺口处开始，无需额外维护水位线变量。

---

### 排序规则（与 `getReadySignatures` 完全一致）

| 情况 | 排序方式 |
|---|---|
| `blockTime > 0`（Helius 链上 sig） | 按 `blockTime * 1000`（毫秒）ASC |
| `blockTime = 0`（GMGN 插件 sig） | 按 `timestamp` ASC |
| 同时间，均为 GMGN sig（`slot=0`） | 按 `createdAt DESC`（因 GMGN API 返回最新在前，createdAt 越大反而越旧） |
| 同时间，Helius sig | 按 `blockIndex` ASC（区块内执行顺序） |

---

### 调用流程

```
start() 初始化流程：
  Step 6: fetchMissingTransactions()          ← 尽量填满所有 gap
  Step 7: performInitialCalculation()
           └─ getReadySignaturesSequential()  ← 顺序计算，遇 gap 停止
  Step 7.5: 桥接 WS init 窗口 gap
           ├─ fetchMissingTransactions()      ← 重试填充剩余 gap
           └─ getReadySignaturesSequential()  ← 继续顺序计算（已处理的自动跳过）
  Step 8: isInitialized = true → 进入实时模式

实时模式（gap 补全触发续算）：
  verifySignatures() 发现并处理新 sig 后
  └─ _tryProcessUnblocked()
       └─ getReadySignaturesSequential()     ← 检查历史 gap 是否被解锁
```

---

### `_tryProcessUnblocked()`

**位置**：`src/helius/HeliusMonitor.js`

**作用**：当任何机制补全了历史 gap 后，调用此方法尝试续算被阻塞的后续 sig。

**当前调用时机**：
- `verifySignatures()` 处理完新发现的 tx 后

**调用方可按需扩展**，例如未来如果 `fetchMissingTransactions` 在实时模式下被调用，也应在之后调用此方法。

---

## 状态流转示意

```
初始状态（fetchMissingTransactions 后）：

 sig  | slot | hasData | isProcessed
------+------+---------+------------
  A   | 100  |  true   |   false      ← 待处理
  B   | 101  |  true   |   false      ← 待处理
  C   | 102  |  false  |   false      ← GAP（fetch 失败）
  D   | 103  |  true   |   false      ← 被 C 阻塞
  E   | 104  |  true   |   false      ← 被 C 阻塞

performInitialCalculation() 后：

  A   | 100  |  true   |   true       ← 已计算
  B   | 101  |  true   |   true       ← 已计算
  C   | 102  |  false  |   false      ← 水位线停在这里
  D   | 103  |  true   |   false      ← 等待
  E   | 104  |  true   |   false      ← 等待

C 被补全（hasData → true）后调用 _tryProcessUnblocked()：

  A   | 100  |  true   |   true       ← 已处理，跳过
  B   | 101  |  true   |   true       ← 已处理，跳过
  C   | 102  |  true   |   true       ← 续算
  D   | 103  |  true   |   true       ← 续算
  E   | 104  |  true   |   true       ← 续算
```

---

## 与 `getReadySignatures()` 的区别

| | `getReadySignatures()` | `getReadySignaturesSequential()` |
|---|---|---|
| 返回内容 | 所有 `hasData=true` 且未处理的 sig | 连续完整前段（遇 gap 停止） |
| 适用场景 | earlyPublish 预览、旧版历史计算 | 4 大参数的正式计算（保证顺序和完整性） |
| gap 的处理 | 跳过，继续返回后面的 sig | 在 gap 处停止，后面的全部不返回 |

---

## 涉及文件

| 文件 | 变更 |
|---|---|
| `src/helius/SignatureManager.js` | 新增 `getReadySignaturesSequential()` |
| `src/helius/HeliusMonitor.js` | `performInitialCalculation()` 改用 Sequential；step 7.5 改用 Sequential；新增 `_tryProcessUnblocked()`；`verifySignatures()` 后调用续算 |
