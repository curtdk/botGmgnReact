const { chromium } = require('playwright');

(async () => {
  console.log('Connecting to Chrome...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  
  const contexts = browser.contexts();
  const pages = contexts[0]?.pages() || [];
  
  // Go to extensions page
  console.log('1. Opening chrome://extensions...');
  let extPage = pages.find(p => p.url().startsWith('chrome://extensions'));
  if (!extPage) {
    extPage = await contexts[0].newPage();
  }
  await extPage.goto('chrome://extensions', { timeout: 10000 });
  await extPage.waitForTimeout(2000);
  
  // Take screenshot before reload
  await extPage.screenshot({ path: 'ext-before-reload.png' });
  console.log('   Saved: ext-before-reload.png');

  // Try to find and click reload button
  console.log('2. Looking for reload button...');
  
  // Find the GMGN extension card and click reload
  const reloadResult = await extPage.evaluate(() => {
    const cards = document.querySelectorAll('extension-card, div[itemprop="itemListElement"]');
    for (const card of cards) {
      const text = card.textContent || '';
      if (text.includes('GMGN') || text.includes('gmgn')) {
        // Find reload button in this card
        const reloadBtn = card.querySelector('button[id*="reload"], button[title*="Reload"], button[id*="reload"], [aria-label*="reload"]');
        if (reloadBtn) {
          reloadBtn.click();
          return { success: true, text: text.substring(0, 100) };
        }
        // Try to find by icon or other methods
        const buttons = card.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.includes('Reload') || btn.textContent?.includes('重新加载') || btn.getAttribute('aria-label')?.includes('reload')) {
            btn.click();
            return { success: true, found: 'by aria-label' };
          }
        }
        return { success: false, reason: 'no reload button found', text: text.substring(0, 100) };
      }
    }
    return { success: false, reason: 'GMGN not found', cardsCount: cards.length };
  });
  
  console.log('   Result:', JSON.stringify(reloadResult));

  // Wait for reload
  console.log('3. Waiting for reload (5s)...');
  await extPage.waitForTimeout(5000);

  // Take screenshot after reload
  await extPage.screenshot({ path: 'ext-after-reload.png' });
  console.log('   Saved: ext-after-reload.png');

  // Now check the GMGN page version
  console.log('4. Checking version on SidePanel...');
  const sidePanel = pages.find(p => p.url().includes('sidepanel'));
  if (sidePanel) {
    await sidePanel.reload(); // Reload sidepanel too
    await sidePanel.waitForTimeout(3000);
    
    const versionInfo = await sidePanel.evaluate(() => {
      const bodyText = document.body.innerText;
      const versionMatch = bodyText.match(/v(\d+\.\d+\.\d+)/);
      return {
        hasVersion: !!versionMatch,
        version: versionMatch ? versionMatch[1] : 'not found',
        text: bodyText.substring(0, 2000)
      };
    });
    
    console.log('   Version info:', JSON.stringify(versionInfo));
    
    await sidePanel.screenshot({ path: 'sidepanel-version.png' });
    console.log('   Saved: sidepanel-version.png');
  }

  console.log('\n✅ Done!');
  await browser.close();
})();
