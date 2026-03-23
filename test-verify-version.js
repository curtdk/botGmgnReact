const { chromium } = require('playwright');

(async () => {
  console.log('Connecting to Chrome...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  
  const contexts = browser.contexts();
  const pages = contexts[0]?.pages() || [];
  
  // First open the GMGN page and trigger sidepanel
  console.log('1. Opening GMGN page...');
  let gmgnPage = pages.find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
  }
  await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { timeout: 30000 });
  await gmgnPage.waitForTimeout(3000);
  
  // Try to open sidepanel by clicking extension icon
  console.log('2. Trying to trigger sidepanel...');
  
  // Wait a bit for sidepanel to appear
  await gmgnPage.waitForTimeout(5000);
  
  // Check all pages again
  const allPages = browser.contexts()[0].pages();
  console.log('All pages:', allPages.map(p => p.url().substring(0, 60)));
  
  const sidePanel = allPages.find(p => p.url().includes('sidepanel'));
  
  if (sidePanel) {
    console.log('3. Found SidePanel!');
    await sidePanel.waitForTimeout(2000);
    
    const info = await sidePanel.evaluate(() => {
      return {
        bodyText: document.body.innerText
      };
    });
    
    console.log('\n--- Checking for version ---');
    console.log('Has v1.0.2:', info.bodyText.includes('v1.0.2'));
    console.log('Has 测试版:', info.bodyText.includes('测试版'));
    
    // Find version
    const vMatch = info.bodyText.match(/v(\d+\.\d+\.\d+)/);
    console.log('Version found:', vMatch ? vMatch[0] : 'not found');
    
    await sidePanel.screenshot({ path: 'version-check.png' });
    console.log('Saved: version-check.png');
  } else {
    console.log('SidePanel not found - please open it manually');
  }

  console.log('\n✅ Done!');
  await browser.close();
})();
