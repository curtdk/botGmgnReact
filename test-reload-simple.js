const { chromium } = require('playwright');

(async () => {
  console.log('Connecting to Chrome...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  
  const contexts = browser.contexts();
  const pages = contexts[0]?.pages() || [];
  
  // Find SidePanel
  let sidePanel = pages.find(p => p.url().includes('sidepanel'));
  
  if (sidePanel) {
    console.log('Found SidePanel:', sidePanel.url());
    
    // Reload the side panel to get new version
    console.log('Reloading SidePanel...');
    await sidePanel.reload();
    await sidePanel.waitForTimeout(3000);
    
    // Check for version text
    const info = await sidePanel.evaluate(() => {
      const bodyText = document.body.innerText;
      return {
        hasV102: bodyText.includes('v1.0.2'),
        hasTest: bodyText.includes('测试'),
        text: bodyText
      };
    });
    
    console.log('\n--- Version Check ---');
    console.log('Has v1.0.2:', info.hasV102);
    console.log('Has 测试:', info.hasTest);
    
    // Find the version text in the page
    const versionMatch = info.text.match(/v\d+\.\d+\.\d+/);
    console.log('Found version:', versionMatch ? versionMatch[0] : 'not found');
    
    await sidePanel.screenshot({ path: 'sidepanel-version-check.png' });
    console.log('\nSaved: sidepanel-version-check.png');
  } else {
    console.log('SidePanel not found!');
  }

  console.log('\n✅ Done!');
  await browser.close();
})();
