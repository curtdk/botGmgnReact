const { chromium } = require('playwright');

(async () => {
  console.log('=== Auto Reload Extension v3 ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  
  // Create extensions page
  const extPage = await contexts[0].newPage();
  await extPage.goto('chrome://extensions');
  await extPage.waitForTimeout(3000);
  
  console.log('Extensions page loaded');
  
  // Try to get page source to analyze
  const pageHtml = await extPage.content();
  console.log('Page length:', pageHtml.length);
  
  // Try different approach - use CDP to call extension reload directly
  console.log('\nTrying CDP method...');
  
  // Get all targets
  const version = await extPage.evaluate(() => {
    // Try to access the extension management API
    // The chrome://extensions page has chrome.management API available
    return new Promise((resolve) => {
      // List all extensions
      chrome.management.getAll((extensions) => {
        const gmgn = extensions.find(ext => ext.name && ext.name.includes('GMGN'));
        if (gmgn) {
          console.log('Found GMGN:', gmgn.name, gmgn.id);
          // Try to reload
          chrome.management.reload(gmgn.id, () => {
            if (chrome.runtime.lastError) {
              resolve({ error: chrome.runtime.lastError.message });
            } else {
              resolve({ success: true, id: gmgn.id });
            }
          });
        } else {
          resolve({ error: 'GMGN not found', extensions: extensions.map(e => e.name) });
        }
      });
    });
  });
  
  console.log('CDP Result:', JSON.stringify(version));

  await extPage.waitForTimeout(3000);
  console.log('\n=== DONE ===');
  await browser.close();
})();
