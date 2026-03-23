const { chromium } = require('playwright');

(async () => {
  console.log('Connecting to Chrome...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  
  const contexts = browser.contexts();
  const pages = contexts[0]?.pages() || [];
  console.log('Available pages:', pages.length);
  
  let page = pages.find(p => p.url().includes('gmgn.ai'));
  if (!page && pages.length > 0) {
    page = pages[0];
  }
  
  if (!page) {
    page = await contexts[0].newPage();
  }

  console.log('Using page:', page.url());

  // Wait for data and capture logs
  console.log('\nWaiting 20s for data flow...');
  await page.waitForTimeout(20000);

  // Get metrics from page
  console.log('\n--- Extracting metrics from page ---');
  const metrics = await page.evaluate(() => {
    // Try to find the metrics in the DOM
    const results = {
      url: window.location.href,
      title: document.title,
    };
    
    // Look for specific text
    const bodyText = document.body.innerText;
    
    // Extract numbers
    const benLunMatch = bodyText.match(/本轮下注[：:]\s*([\d.]+)/);
    const benLunCostMatch = bodyText.match(/本轮成本[：:]\s*([\d.-]+)/);
    const yiLuMatch = bodyText.match(/已落袋[：:]\s*([\d.-]+)/);
    
    if (benLunMatch) results.benLunXiaZhu = benLunMatch[1];
    if (benLunCostMatch) results.benLunChengBen = benLunCostMatch[1];
    if (yiLuMatch) results.yiLuDai = yiLuMatch[1];
    
    return results;
  });
  
  console.log('Metrics found:', JSON.stringify(metrics, null, 2));

  // Screenshot
  await page.screenshot({ path: 'current-metrics.png', fullPage: true });
  console.log('\nSaved: current-metrics.png');

  // Get console logs from localStorage if available
  const storageData = await page.evaluate(() => {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.includes('helius') || key.includes('metrics') || key.includes('gmgn')) {
        data[key] = localStorage.getItem(key).substring(0, 500);
      }
    }
    return data;
  });
  
  console.log('\nLocalStorage keys:', Object.keys(storageData));

  console.log('\n✅ Done!');
  await browser.close();
})();
