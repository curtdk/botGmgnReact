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
  console.log('=== FULL AUTO TEST v2 ===\n');
  
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
    console.log('   ✓ Reload sent\n');
  }
  
  // Wait for reload
  console.log('2. Waiting 8 seconds for extension to reload...');
  await new Promise(r => setTimeout(r, 8000));
  
  // 2. Connect to Chrome
  console.log('3. Connecting to Chrome...');
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  let pages = contexts[0]?.pages() || [];
  
  // Find GMGN page
  let gmgnPage = pages.find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
  }
  
  console.log('4. Going to GMGN page...');
  await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { timeout: 30000 });
  await gmgnPage.waitForTimeout(5000);
  
  // Wait and check for sidepanel multiple times
  console.log('5. Waiting for SidePanel...\n');
  
  let sidePanel = null;
  for (let i = 0; i < 3; i++) {
    await gmgnPage.waitForTimeout(5000);
    const allPages = contexts[0].pages();
    sidePanel = allPages.find(p => p.url().includes('sidepanel'));
    if (sidePanel) break;
    console.log(`   Attempt ${i+1}: SidePanel not found, retrying...`);
  }
  
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
    console.log('7. Waiting for data (15s)...');
    await sidePanel.waitForTimeout(15000);
    
    // Check version
    console.log('8. Checking version...\n');
    const info = await sidePanel.evaluate(() => {
      return { text: document.body.innerText };
    });
    
    console.log('=== RESULT ===');
    const vMatch = info.text.match(/v(\d+\.\d+\.\d+)/);
    console.log('Version:', vMatch ? vMatch[0] : 'NOT FOUND');
    
    if (info.text.includes('v1.0.6')) {
      console.log('✅ AUTO RELOAD SUCCESSFUL!');
    }
    
    await sidePanel.screenshot({ path: 'full-auto-v2.png', fullPage: true });
    console.log('\nScreenshot: full-auto-v2.png');
  } else {
    console.log('❌ SidePanel not found');
    console.log('Please open SidePanel manually after extension reload');
    
    await gmgnPage.screenshot({ path: 'gmgn-page.png', fullPage: true });
  }

  console.log('\n=== DONE ===');
  await browser.close();
}

runFullTest().catch(console.error);
