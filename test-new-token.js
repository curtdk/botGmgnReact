const { chromium } = require('playwright');

(async () => {
  console.log('=== Testing Different Token ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  
  // Try a different token - PEPE
  const tokenAddress = '85VBFQZC8TZkfaptBWqv14ALD8fHBTzE6v5UUonkKwt6'; // PEPE
  
  console.log('Testing token:', tokenAddress);
  
  let gmgnPage = contexts[0]?.pages().find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
  }
  
  console.log('Loading GMGN page...');
  await gmgnPage.goto(`https://gmgn.ai/sol/token/${tokenAddress}`, { timeout: 30000 });
  await gmgnPage.waitForTimeout(5000);
  
  // Find sidepanel
  await gmgnPage.waitForTimeout(8000);
  let sidePanel = contexts[0]?.pages().find(p => p.url().includes('sidepanel'));
  
  if (!sidePanel) {
    sidePanel = await contexts[0].newPage();
    await sidePanel.goto('chrome-extension://dmlldkkgjgpaipnfgijhahncbohnfmkj/src/sidepanel/index.html');
    await sidePanel.waitForTimeout(3000);
  }
  
  // Click start
  const startBtn = await sidePanel.$('button:has-text("开始")');
  if (startBtn) {
    await startBtn.click();
    console.log('Start clicked!\n');
  }
  
  // Wait for data
  console.log('Waiting for data (30s)...');
  await sidePanel.waitForTimeout(30000);
  
  // Get the text
  const text = await sidePanel.evaluate(() => document.body.innerText);
  
  // Extract metrics
  const benLunMatch = text.match(/本轮下注[：:\s]*([\d.]+)/);
  const yiLuMatch = text.match(/已落袋[：:\s]*([\d.-]+)/);
  const benLunCostMatch = text.match(/本轮成本[：:\s]*([\d.-]+)/);
  const fuYingMatch = text.match(/浮盈浮亏[：:\s]*([\d.-]+)/);
  
  console.log('\n========== NEW TOKEN TEST ==========\n');
  console.log('Token: PEPE (85VBFQZC8TZkfaptBWqv14ALD8fHBTzE6v5UUonkKwt6)');
  console.log('\n【本轮下注】', benLunMatch ? benLunMatch[1] + ' SOL' : 'N/A');
  console.log('【已落袋】', yiLuMatch ? yiLuMatch[1] + ' SOL' : 'N/A');
  console.log('【本轮成本】', benLunCostMatch ? benLunCostMatch[1] + ' SOL' : 'N/A');
  console.log('【浮盈浮亏】', fuYingMatch ? fuYingMatch[1] + ' SOL' : 'N/A');
  
  // Extract user details
  console.log('\n【用户明细】');
  const userLines = text.match(/[A-Za-z0-9]{4}\.\.[A-Za-z0-9]{4}.*?[\d.-]+/g) || [];
  userLines.slice(0, 5).forEach(u => console.log('  ', u));
  
  // Verify formula
  if (benLunMatch && yiLuMatch && benLunCostMatch) {
    const benLun = parseFloat(benLunMatch[1]);
    const yiLu = parseFloat(yiLuMatch[1]);
    const cost = parseFloat(benLunCostMatch[1]);
    const calculated = benLun - yiLu;
    
    console.log('\n【公式验证】');
    console.log(`本轮成本 = 本轮下注 - 已落袋`);
    console.log(`${cost.toFixed(4)} = ${benLun.toFixed(4)} - ${yiLu.toFixed(4)}`);
    console.log(`计算值: ${calculated.toFixed(4)}`);
    console.log(`实际值: ${cost.toFixed(4)}`);
    console.log(`结果: ${Math.abs(calculated - cost) < 0.001 ? '✅ 正确' : '❌ 错误'}`);
  }
  
  await sidePanel.screenshot({ path: 'new-token-test.png', fullPage: true });
  console.log('\nScreenshot: new-token-test.png');
  
  await browser.close();
})();
