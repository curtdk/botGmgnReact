const CDP = require('chrome-remote-interface');
const http = require('http');

async function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function runFullTest() {
  console.log('=== FULL AUTO TEST ===\n');
  
  const targets = await getTargets();
  
  // 1. Reload Extension via CDP
  console.log('1. Reloading extension via CDP...');
  const gmgnTarget = targets.find(t => 
    t.url && t.url.includes('dmlldkkgjgpaipnfgijhahncbohnfmkj') && t.type === 'page'
  );
  
  if (gmgnTarget) {
    const client = await CDP({ target: gmgnTarget.webSocketDebuggerUrl });
    await client.Runtime.evaluate({ expression: 'chrome.runtime.reload()' });
    await client.close();
    console.log('   ✓ Reload command sent\n');
  }
  
  // Wait for reload
  console.log('2. Waiting for extension to reload...');
  await new Promise(r => setTimeout(r, 5000));
  
  // 2. Connect to existing Chrome for testing
  console.log('3. Connecting to Chrome for testing...');
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  let pages = contexts[0]?.pages() || [];
  
  // Find or open GMGN page
  let gmgnPage = pages.find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
  }
  
  console.log('4. Opening GMGN page...');
  await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { timeout: 30000 });
  await gmgnPage.waitForTimeout(5000);
  
  // Wait for sidepanel
  console.log('5. Waiting for SidePanel...');
  await gmgnPage.waitForTimeout(8000);
  
  const allPages = contexts[0].pages();
  const sidePanel = allPages.find(p => p.url().includes('sidepanel'));
  
  if (sidePanel) {
    console.log('   ✓ SidePanel found!\n');
    
    // Click start
    console.log('6. Clicking Start button...');
    const startBtn = await sidePanel.$('button:has-text("开始")');
    if (startBtn) {
      await startBtn.click();
      console.log('   ✓ Start clicked!\n');
    }
    
    // Wait for data
    console.log('7. Waiting for data...');
    await sidePanel.waitForTimeout(15000);
    
    // Check version
    console.log('8. Checking version...\n');
    const info = await sidePanel.evaluate(() => {
      return { text: document.body.innerText };
    });
    
    console.log('=== RESULT ===');
    console.log('Has v1.0.6:', info.text.includes('v1.0.6'));
    const vMatch = info.text.match(/v(\d+\.\d+\.\d+)/);
    console.log('Version:', vMatch ? vMatch[0] : 'NOT FOUND');
    
    await sidePanel.screenshot({ path: 'full-auto-test.png', fullPage: true });
    console.log('\nScreenshot: full-auto-test.png');
  } else {
    console.log('❌ SidePanel not found');
  }

  console.log('\n=== FULL AUTO TEST COMPLETE ===');
  await browser.close();
}

runFullTest().catch(console.error);
