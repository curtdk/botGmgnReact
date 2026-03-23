const { chromium } = require('playwright');

(async () => {
  console.log('=== Full Upgrade Test ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  let pages = contexts[0]?.pages() || [];
  
  // Step 1: Go to extensions page and reload
  console.log('Step 1: Reloading extension...');
  let extPage = pages.find(p => p.url() === 'chrome://extensions/') || await contexts[0].newPage();
  await extPage.goto('chrome://extensions/');
  await extPage.waitForTimeout(2000);
  
  // Try to find and click reload button using JS
  const reloadResult = await extPage.evaluate(() => {
    // Try multiple selectors for the reload button
    const selectors = [
      'button[aria-label*="Reload"]',
      'button[id*="reload"]', 
      'button[title*="Reload"]',
      'button[data-tooltip*="Reload"]',
      'div[role="button"][aria-label*="Reload"]'
    ];
    
    // Also try finding by finding GMGN card first
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = btn.textContent || '';
      const aria = btn.getAttribute('aria-label') || '';
      if (text.includes('Reload') || text.includes('重新加载') || aria.includes('Reload')) {
        btn.click();
        return { success: true, method: 'text match', text: text.substring(0, 50) };
      }
    }
    
    // Try clicking the first button that might be reload
    const extensionCards = document.querySelectorAll('extension-card');
    for (const card of extensionCards) {
      const cardText = card.textContent || '';
      if (cardText.includes('GMGN') || cardText.includes('gmgn')) {
        const btns = card.querySelectorAll('button');
        for (const b of btns) {
          if (b.textContent?.trim() === 'Reload' || b.getAttribute('aria-label')?.includes('Reload')) {
            b.click();
            return { success: true, method: 'in card' };
          }
        }
      }
    }
    
    return { success: false, buttonsFound: allButtons.length };
  });
  
  console.log('Reload result:', JSON.stringify(reloadResult));
  
  // Wait for reload
  await extPage.waitForTimeout(3000);
  console.log('Extension reloaded!\n');

  // Step 2: Open GMGN page
  console.log('Step 2: Opening GMGN page...');
  let gmgnPage = pages.find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
  }
  await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump');
  await gmgnPage.waitForTimeout(3000);
  console.log('GMGN page loaded\n');

  // Step 3: Wait for SidePanel to appear (it should auto-open or be triggered)
  console.log('Step 3: Waiting for SidePanel...');
  await gmgnPage.waitForTimeout(5000);
  
  // Check for new pages
  pages = contexts[0].pages();
  console.log('All pages:', pages.length);
  
  let sidePanel = pages.find(p => p.url().includes('sidepanel'));
  
  // If no sidepanel, try triggering it
  if (!sidePanel) {
    console.log('No sidepanel yet, trying to trigger...');
    // Wait more
    await gmgnPage.waitForTimeout(5000);
    pages = contexts[0].pages();
    sidePanel = pages.find(p => p.url().includes('sidepanel'));
  }
  
  if (sidePanel) {
    console.log('Found SidePanel!\n');
    
    // Wait for it to load
    await sidePanel.waitForTimeout(2000);
    
    // Click start button
    console.log('Step 4: Clicking Start button...');
    const startBtn = await sidePanel.$('button:has-text("开始")');
    if (startBtn) {
      await startBtn.click();
      console.log('Start clicked!\n');
    }
    
    // Wait for data
    console.log('Step 5: Waiting for data...');
    await sidePanel.waitForTimeout(15000);
    
    // Check version
    console.log('Step 6: Checking version...\n');
    const versionInfo = await sidePanel.evaluate(() => {
      const bodyText = document.body.innerText;
      return {
        hasV102: bodyText.includes('v1.0.2'),
        hasTest: bodyText.includes('测试版'),
        text: bodyText
      };
    });
    
    console.log('=== VERSION CHECK ===');
    console.log('Has v1.0.2:', versionInfo.hasV102);
    console.log('Has 测试版:', versionInfo.hasTest);
    
    // Extract version
    const vMatch = versionInfo.text.match(/v(\d+\.\d+\.\d+)/);
    console.log('Version found:', vMatch ? vMatch[0] : 'NOT FOUND');
    
    // Get key metrics
    const metricsMatch = versionInfo.text.match(/本轮下注\s*([\d.]+)/);
    console.log('本轮下注:', metricsMatch ? metricsMatch[1] + ' SOL' : 'NOT FOUND');
    
    await sidePanel.screenshot({ path: 'final-test-result.png', fullPage: true });
    console.log('\nScreenshot saved: final-test-result.png');
    
  } else {
    console.log('SidePanel not found after all attempts');
    console.log('Please open SidePanel manually');
  }

  console.log('\n=== TEST COMPLETE ===');
  await browser.close();
})();
