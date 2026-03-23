const { chromium } = require('playwright');

(async () => {
  console.log('=== Verifying v1.0.3 Update ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const pages = contexts[0]?.pages() || [];
  
  // Find GMGN page
  let gmgnPage = pages.find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
    await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { timeout: 30000 });
    await gmgnPage.waitForTimeout(3000);
  }
  
  console.log('GMGN page:', gmgnPage.url());
  
  // Wait for sidepanel
  console.log('Waiting for SidePanel...');
  await gmgnPage.waitForTimeout(8000);
  
  const allPages = contexts[0].pages();
  const sidePanel = allPages.find(p => p.url().includes('sidepanel'));
  
  if (sidePanel) {
    console.log('SidePanel found!\n');
    
    // Check version
    const info = await sidePanel.evaluate(() => {
      const bodyText = document.body.innerText;
      return {
        hasV103: bodyText.includes('v1.0.3'),
        hasMetrics: bodyText.includes('实时指标'),
        hasBenLun: bodyText.includes('本轮下注'),
        hasDataLog: bodyText.includes('数据流日志'),
        text: bodyText.substring(0, 3000)
      };
    });
    
    console.log('=== VERSION CHECK ===');
    console.log('Version 1.0.3:', info.hasV103);
    console.log('Has 实时指标 (should be FALSE):', info.hasMetrics);
    console.log('Has 本轮下注 (should be FALSE):', info.hasBenLun);
    console.log('Has 数据流日志 (should be FALSE):', info.hasDataLog);
    
    console.log('\n=== SidePanel Content ===');
    console.log(info.text);
    
    await sidePanel.screenshot({ path: 'verify-v1.0.3.png', fullPage: true });
    console.log('\nSaved: verify-v1.0.3.png');
    
  } else {
    console.log('SidePanel not found - please open it');
  }

  console.log('\n=== DONE ===');
  await browser.close();
})();
