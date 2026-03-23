const { chromium } = require('playwright');

(async () => {
  console.log('=== Auto Reload Extension Test ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  let pages = contexts[0]?.pages() || [];
  
  // Step 1: Create a new tab for extensions page
  console.log('Step 1: Creating extensions tab...');
  const extPage = await contexts[0].newPage();
  await extPage.goto('chrome://extensions', { timeout: 10000 });
  await extPage.waitForTimeout(2000);
  console.log('   Extensions page loaded\n');

  // Step 2: Try to find and click reload button using JS
  console.log('Step 2: Finding GMGN extension reload button...');
  
  const reloadResult = await extPage.evaluate(() => {
    return new Promise((resolve) => {
      // Method 1: Try to find extension cards
      const findAndClick = () => {
        // Look for the extension by name
        const allDivs = document.querySelectorAll('div');
        
        for (const div of allDivs) {
          const text = div.textContent || '';
          // Look for GMGN extension
          if (text.includes('GMGN') && text.includes('标准')) {
            console.log('Found GMGN card!');
            
            // Look for reload button in this card
            // Try to find button with reload icon or text
            const buttons = div.querySelectorAll('button');
            for (const btn of buttons) {
              const btnText = btn.textContent?.trim() || '';
              const ariaLabel = btn.getAttribute('aria-label') || '';
              
              // Look for reload-related buttons
              if (btnText.includes('Reload') || 
                  btnText.includes('重新加载') || 
                  ariaLabel.includes('reload') ||
                  btnText === '' && btn.querySelector('img')) {
                console.log('Found reload button, clicking...');
                btn.click();
                resolve({ success: true, method: 'GMGN card' });
                return;
              }
            }
            
            // Try to find by traversing up to find the card
            let parent = div;
            for (let i = 0; i < 5; i++) {
              if (!parent) break;
              const siblings = parent.parentElement?.querySelectorAll?.('button') || [];
              for (const btn of siblings) {
                const btnText = btn.textContent?.trim() || '';
                if (btnText.includes('Reload') || btnText.includes('重新加载')) {
                  console.log('Found reload via parent, clicking...');
                  btn.click();
                  resolve({ success: true, method: 'parent' });
                  return;
                }
              }
              parent = parent.parentElement;
            }
          }
        }
        
        resolve({ success: false, reason: 'GMGN not found' });
      };
      
      // Give DOM time to load
      setTimeout(findAndClick, 1000);
    });
  });
  
  console.log('   Result:', JSON.stringify(reloadResult));

  // Wait for reload to complete
  console.log('\nStep 3: Waiting for extension to reload...');
  await extPage.waitForTimeout(5000);

  // Step 4: Go to GMGN page and test
  console.log('\nStep 4: Going to GMGN page...');
  let gmgnPage = pages.find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
  }
  await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump');
  await gmgnPage.waitForTimeout(3000);
  console.log('   GMGN page loaded\n');

  // Wait for sidepanel
  console.log('Step 5: Waiting for SidePanel...');
  await gmgnPage.waitForTimeout(8000);
  
  const allPages = contexts[0].pages();
  const sidePanel = allPages.find(p => p.url().includes('sidepanel'));
  
  if (sidePanel) {
    console.log('   SidePanel found!\n');
    
    // Click start
    console.log('Step 6: Clicking Start button...');
    const startBtn = await sidePanel.$('button:has-text("开始")');
    if (startBtn) {
      await startBtn.click();
      console.log('   Start clicked!\n');
    }
    
    // Wait for data
    console.log('Step 7: Waiting for data...');
    await sidePanel.waitForTimeout(15000);
    
    // Check version
    console.log('Step 8: Checking version...\n');
    const info = await sidePanel.evaluate(() => {
      return { text: document.body.innerText };
    });
    
    console.log('=== RESULT ===');
    console.log('Has v1.0.6:', info.text.includes('v1.0.6'));
    const vMatch = info.text.match(/v(\d+\.\d+\.\d+)/);
    console.log('Version:', vMatch ? vMatch[0] : 'NOT FOUND');
    
    await sidePanel.screenshot({ path: 'auto-reload-result.png', fullPage: true });
    console.log('\nScreenshot: auto-reload-result.png');
  } else {
    console.log('   SidePanel not found - manual open needed');
  }

  console.log('\n=== DONE ===');
  await browser.close();
})();
