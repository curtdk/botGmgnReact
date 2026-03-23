const { chromium } = require('playwright');

(async () => {
  console.log('=== Extension Reload via Internal API ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  
  // Get extensions page
  let extPage = contexts[0]?.pages().find(p => p.url() === 'chrome://extensions/');
  if (!extPage) {
    extPage = await contexts[0].newPage();
    await extPage.goto('chrome://extensions/');
    await extPage.waitForTimeout(2000);
  }
  
  console.log('1. On extensions page, trying to reload via internal API...');
  
  // Try to call chrome.management API via the extensions page
  const result = await extPage.evaluate(async () => {
    // This might work if we can access chrome API
    try {
      // Try to find the extension and reload it
      // First, let's see what APIs are available
      return {
        hasChrome: typeof chrome !== 'undefined',
        hasManagement: typeof chrome?.management !== 'undefined',
        location: window.location.href
      };
    } catch (e) {
      return { error: e.message };
    }
  });
  
  console.log('API check:', JSON.stringify(result));
  
  // Try a different approach - use the contextMenus or shortcuts
  // Actually, let's try to use the update button directly via JS click
  
  // First, get all clickable elements on the page
  const elements = await extPage.evaluate(() => {
    const allElements = Array.from(document.querySelectorAll('*'));
    const clickable = allElements.filter(el => {
      const style = window.getComputedStyle(el);
      return style.cursor === 'pointer' || el.getAttribute('role') === 'button';
    });
    return clickable.slice(0, 20).map(el => ({
      tag: el.tagName,
      text: el.textContent?.substring(0, 30),
      aria: el.getAttribute('aria-label'),
      id: el.id,
      class: el.className?.substring(0, 30)
    }));
  });
  
  console.log('\nClickable elements:', JSON.stringify(elements, null, 2));
  
  // Try clicking the first reload-like button we can find
  const clickResult = await extPage.evaluate(() => {
    // Find buttons with "Reload" text
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      const text = btn.textContent || '';
      const aria = btn.getAttribute('aria-label') || '';
      if (text.includes('Reload') || aria.includes('Reload') || text.includes('重新加载')) {
        btn.click();
        return { success: true, text: text.substring(0, 30) };
      }
    }
    return { success: false };
  });
  
  console.log('\nClick result:', JSON.stringify(clickResult));
  
  await extPage.waitForTimeout(3000);
  
  // Now check if extension was reloaded by looking at GMGN page
  console.log('\n2. Checking GMGN page...');
  const gmgnPage = contexts[0]?.pages().find(p => p.url().includes('gmgn.ai/sol/token'));
  
  if (gmgnPage) {
    // Wait for sidepanel
    await gmgnPage.waitForTimeout(5000);
    const pages = contexts[0].pages();
    const sidePanel = pages.find(p => p.url().includes('sidepanel'));
    
    if (sidePanel) {
      await sidePanel.waitForTimeout(2000);
      
      // Click start
      const startBtn = await sidePanel.$('button:has-text("开始")');
      if (startBtn) {
        await startBtn.click();
        console.log('Start clicked!');
      }
      
      await sidePanel.waitForTimeout(10000);
      
      // Check version
      const info = await sidePanel.evaluate(() => {
        return {
          text: document.body.innerText,
          url: window.location.href
        };
      });
      
      console.log('\n=== VERSION CHECK ===');
      console.log('Has v1.0.2:', info.text.includes('v1.0.2'));
      console.log('Has 测试版:', info.text.includes('测试版'));
      
      const vMatch = info.text.match(/v(\d+\.\d+\.\d+)/);
      console.log('Version:', vMatch ? vMatch[0] : 'NOT FOUND');
      
      await sidePanel.screenshot({ path: 'version-final.png', fullPage: true });
      console.log('\nSaved: version-final.png');
    }
  }
  
  console.log('\n=== DONE ===');
  await browser.close();
})();
