const { chromium } = require('playwright');

(async () => {
  console.log('Connecting to Chrome...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  
  const contexts = browser.contexts();
  const pages = contexts[0]?.pages() || [];
  
  // Find the side panel
  let sidePanel = pages.find(p => p.url().includes('sidepanel'));
  let mainPage = pages.find(p => p.url().includes('gmgn.ai/sol/token'));
  
  console.log('Found pages:', pages.map(p => ({ url: p.url().substring(0, 80) })));

  if (sidePanel) {
    console.log('\nUsing SidePanel:', sidePanel.url());
    
    // Wait for data
    console.log('Waiting 15s for data...');
    await sidePanel.waitForTimeout(15000);
    
    // Extract metrics from side panel
    const metrics = await sidePanel.evaluate(() => {
      const results = { source: 'sidepanel' };
      const bodyText = document.body.innerText;
      
      // Extract key metrics
      const patterns = [
        { key: '本轮下注', pattern: /本轮下注[：:\s]*([\d.]+)/ },
        { key: '本轮成本', pattern: /本轮成本[：:\s]*([\d.-]+)/ },
        { key: '已落袋', pattern: /已落袋[：:\s]*([\d.-]+)/ },
        { key: '浮盈浮亏', pattern: /浮盈浮亏[：:\s]*([\d.-]+)/ },
        { key: '活跃用户', pattern: /活跃[:\s]*(\d+)/ },
        { key: '已退出', pattern: /已退出[:\s]*(\d+)/ },
        { key: '当前价格', pattern: /当前价格[：:\s]*([\d.]+)/ },
      ];
      
      patterns.forEach(({ key, pattern }) => {
        const match = bodyText.match(pattern);
        if (match) results[key] = match[1];
      });
      
      return results;
    });
    
    console.log('\n--- Metrics from SidePanel ---');
    console.log(JSON.stringify(metrics, null, 2));
    
    // Get console logs from sidepanel
    sidePanel.on('console', msg => {
      const text = msg.text();
      if (text.includes('本轮') || text.includes('下注') || text.includes('成本') || text.includes('落袋') || text.includes('SOL') || text.includes('持仓')) {
        console.log('[CONSOLE]', text);
      }
    });
    
    await sidePanel.screenshot({ path: 'sidepanel-metrics.png', fullPage: true });
    console.log('\nSaved: sidepanel-metrics.png');
  }

  if (mainPage) {
    console.log('\n--- Main Page ---');
    console.log('URL:', mainPage.url());
  }

  console.log('\n✅ Done!');
  await browser.close();
})();
