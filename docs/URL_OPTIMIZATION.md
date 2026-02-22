# Chrome 扩展 URL 限制优化说明

## 优化日期
2026-02-19

## 优化内容

### 修改前
插件在 **所有网页** 上运行 (`<all_urls>`),包括:
- YouTube
- Google
- GitHub
- 任何你访问的网站

### 修改后
插件 **只在 GMGN token 页面** 运行:
- ✅ `https://gmgn.ai/sol/token/*`
- ❌ 其他所有网站

## 修改的文件

### manifest.json

**1. content_scripts.matches**
```json
// 修改前
"matches": ["<all_urls>"]

// 修改后
"matches": ["*://gmgn.ai/sol/token/*"]
```

**2. web_accessible_resources.matches**
```json
// 修改前
"matches": ["<all_urls>"]

// 修改后
"matches": ["*://gmgn.ai/*"]
```

**3. host_permissions**
```json
// 修改前
"host_permissions": ["<all_urls>"]

// 修改后
"host_permissions": ["*://gmgn.ai/*", "*://mainnet.helius-rpc.com/*"]
```

## 性能提升

### 资源消耗对比

**修改前**:
- 访问 100 个网页 = 100 次插件注入
- 每个页面都会:
  - 注入 hook.js
  - 创建 3+ MutationObserver
  - 启动多个定时器
  - 添加事件监听器
  - 初始化 HeliusIntegration

**修改后**:
- 访问 100 个网页,其中 5 个是 GMGN token 页面
- 只有 5 次插件注入
- **性能提升: 95%**
- **内存节省: 95%**

## 如何测试

### 测试 1: 非 GMGN 页面
1. 访问 YouTube, Google, GitHub
2. 打开浏览器控制台
3. **预期**: 没有任何 GMGN 相关的日志

### 测试 2: GMGN token 页面
1. 访问 `https://gmgn.ai/sol/token/xxx`
2. 打开浏览器控制台
3. **预期**: 看到插件正常运行的日志
   - `[GMGN Content] Hook script injected`
   - `[Helius集成] 检测到 Mint: xxx`

### 测试 3: 插件功能
1. 在 GMGN token 页面
2. 点击浏览器工具栏的插件图标
3. **预期**: Side Panel 正常打开,显示数据

## 重新加载扩展

修改 manifest.json 后,需要重新加载扩展:

1. 打开 `chrome://extensions/`
2. 找到 "GMGN 标准插件"
3. 点击 "重新加载" 按钮 (🔄)
4. 刷新 GMGN token 页面

## 回滚方案

如果出现问题,恢复 manifest.json:

```json
{
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["src/content/index.jsx"],
    "run_at": "document_idle"
  }],
  "web_accessible_resources": [{
    "resources": ["parser.js", "owner-parser.js", "env-keys.json", "chiyouzhe.html", "hook.js", "js/observer_feature.js"],
    "matches": ["<all_urls>"]
  }],
  "host_permissions": ["<all_urls>"]
}
```

## 注意事项

1. **只在 token 页面工作**: 插件现在只在 `/sol/token/` 页面运行
2. **GMGN 首页不运行**: 如果需要在首页也运行,修改 matches 为 `["*://gmgn.ai/*"]`
3. **权限更少**: 插件现在只请求 gmgn.ai 和 Helius API 的权限,更安全

## 优化效果

- ✅ 不再影响其他网站的性能
- ✅ 减少内存占用
- ✅ 减少 CPU 使用
- ✅ 更安全(更少的权限)
- ✅ 符合 Chrome 扩展最佳实践
