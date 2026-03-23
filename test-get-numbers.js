const { chromium } = require('playwright');

(async () => {
  console.log('=== Getting Real Calculation Numbers ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  
  // Get the GMGN page
  let gmgnPage = contexts[0]?.pages().find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
    await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { timeout: 30000 });
  }
  
  await gmgnPage.waitForTimeout(5000);
  
  // Wait for sidepanel
  await gmgnPage.waitForTimeout(8000);
  
  const sidePanel = contexts[0]?.pages().find(p => p.url().includes('sidepanel'));
  
  if (!sidePanel) {
    console.log('SidePanel not found');
    await browser.close();
    return;
  }
  
  // Click start button
  const startBtn = await sidePanel.$('button:has-text("开始")');
  if (startBtn) {
    await startBtn.click();
    console.log('Clicked Start\n');
  }
  
  // Wait for data
  console.log('Waiting for data (25s)...');
  await sidePanel.waitForTimeout(25000);
  
  // Try to get the data via chrome storage
  const data = await sidePanel.evaluate(() => {
    return new Promise((resolve) => {
      // Try to get data from chrome storage
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get(null, (items) => {
          const metrics = {};
          for (const key in items) {
            if (key.includes('metric') || key.includes('holder') || key.includes('trade') || key.includes('stats')) {
              metrics[key] = typeof items[key] === 'object' ? JSON.stringify(items[key]).substring(0, 500) : items[key];
            }
          }
          resolve({ fromStorage: metrics });
        });
      } else {
        resolve({ fromStorage: 'no chrome storage' });
      }
    });
  });
  
  console.log('Storage data:', JSON.stringify(data, null, 2).substring(0, 1000));
  
  // Get page text for any numbers
  const pageText = await sidePanel.evaluate(() => document.body.innerText);
  
  // Extract numbers that look like SOL values
  const solNumbers = pageText.match(/[\d.]+\s*SOL/gi) || [];
  const uniqueSol = [...new Set(solNumbers)];
  
  console.log('\n=== SOL Values Found ===');
  uniqueSol.forEach(v => console.log('  ', v));
  
  // Look for table data
  const tableData = await sidePanel.evaluate(() => {
    const rows = document.querySelectorAll('table tr, [class*="row"], [class*="list"]');
    const data = [];
    rows.forEach((row, i) => {
      if (i < 20) {
        data.push(row.textContent.substring(0, 100));
      }
    });
    return data;
  });
  
  console.log('\n=== Table Rows ===');
  tableData.forEach((r, i) => console.log(`${i}: ${r}`));
  
  await sidePanel.screenshot({ path: 'numbers-test.png', fullPage: true });
  console.log('\nScreenshot: numbers-test.png');
  
  await browser.close();
})();
