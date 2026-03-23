const { chromium } = require('playwright');

(async () => {
  console.log('Connecting to Chrome via CDP...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  
  // Get all targets
  const target = browser._channel._connection._transport._url;
  console.log('CDP URL:', target);

  // Use Chrome DevTools Protocol to reload extension
  // First, get the extension ID
  const cdp = await chromium._core.createCDPSession();
  
  // Get extension ID by name
  const extId = 'dmlldkkgjgpaipnfgijhahncbohnfmkj'; // This is the ID from the URL we saw earlier
  
  console.log('Reloading extension:', extId);
  
  try {
    // Reload the extension using CDP
    await cdp.send('Extension.reload', { extensionId: extId });
    console.log('Extension reload command sent!');
  } catch (e) {
    console.log('CDP reload failed:', e.message);
    console.log('Trying alternative method...');
  }

  // Wait for reload
  console.log('Waiting 5s...');
  await new Promise(r => setTimeout(r, 5000));

  // Check the sidepanel for new version
  const contexts = browser.contexts();
  const pages = contexts[0]?.pages() || [];
  const sidePanel = pages.find(p => p.url().includes('sidepanel'));
  
  if (sidePanel) {
    console.log('\nChecking SidePanel version...');
    
    // Reload sidepanel page
    await sidePanel.reload();
    await sidePanel.waitForTimeout(3000);
    
    const versionInfo = await sidePanel.evaluate(() => {
      return {
        bodyText: document.body.innerText
      };
    });
    
    console.log('\n--- SidePanel Text ---');
    console.log(versionInfo.bodyText.substring(0, 2000));
    
    await sidePanel.screenshot({ path: 'sidepanel-after-reload.png' });
    console.log('\nSaved: sidepanel-after-reload.png');
  }

  console.log('\n✅ Done!');
  await browser.close();
})();
