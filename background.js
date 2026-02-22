// -------------------------------------------------------------------------
// 核心配置
// -------------------------------------------------------------------------

// 配置点击图标直接打开 Side Panel (Chrome 114+)
// 注意：这会覆盖 manifest.json 中的 default_popup 配置（如果有）
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
        .catch((error) => console.error(error));
}

// -------------------------------------------------------------------------
// URL 监听逻辑 (保留)
// -------------------------------------------------------------------------

// 监听 URL 变化，主动通知 content.js
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' || changeInfo.url) {
        const url = changeInfo.url || tab.url;
        if (url && (url.includes('/sol/token/') || url.includes('gmgn.ai'))) {
            // 尝试提取 Mint
            const match = url.match(/\/token\/([a-zA-Z0-9]{30,})/);
            if (match && match[1]) {
                const mint = match[1];
                chrome.tabs.sendMessage(tabId, {
                    type: 'TAB_URL_CHANGED',
                    mint: mint,
                    url: url
                }).catch(() => {
                    // Content script 可能尚未加载，忽略错误
                });
            }
        }
    }
});
