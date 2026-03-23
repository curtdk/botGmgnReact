const { chromium } = require('playwright');

(async () => {
  console.log('=== Getting Real Calculation Data ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  
  // Find GMGN page and sidepanel
  let gmgnPage = contexts[0]?.pages().find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
    await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { timeout: 30000 });
    await gmgnPage.waitForTimeout(5000);
  }
  
  await gmgnPage.waitForTimeout(8000);
  const sidePanel = contexts[0].pages().find(p => p.url().includes('sidepanel'));
  
  if (!sidePanel) {
    console.log('SidePanel not found');
    await browser.close();
    return;
  }
  
  // Click start
  const startBtn = await sidePanel.$('button:has-text("开始")');
  if (startBtn) await startBtn.click();
  
  // Wait for data
  console.log('Waiting for data (20s)...');
  await sidePanel.waitForTimeout(20000);
  
  // Get all the data
  const data = await sidePanel.evaluate(() => {
    const bodyText = document.body.innerText;
    
    // Extract metrics
    const benLunMatch = bodyText.match(/本轮下注[：:\s]*([\d.]+)/);
    const yiLuMatch = bodyText.match(/已落袋[：:\s]*([\d.-]+)/);
    const benLunCostMatch = bodyText.match(/本轮成本[：:\s]*([\d.-]+)/);
    
    // Extract user list data (from the table)
    const userLines = bodyText.match(/[A-Za-z0-9]{6}\.\.[A-Za-z0-9]{4}\s+\d+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+/g) || [];
    
    return {
      benLunXiaZhu: benLunMatch ? benLunMatch[1] : 'N/A',
      yiLuDai: yiLuMatch ? yiLuMatch[1] : 'N/A',
      benLunChengBen: benLunCostMatch ? benLunCostMatch[1] : 'N/A',
      userCount: userLines.length,
      users: userLines.slice(0, 10),
      fullText: bodyText
    };
  });
  
  console.log('\n=== REAL CALCULATION DATA ===\n');
  console.log('本轮下注:', data.benLunXiaZhu, 'SOL');
  console.log('已落袋:', data.yiLuDai, 'SOL');
  console.log('本轮成本:', data.benLunChengBen, 'SOL');
  console.log('\n用户数据条数:', data.userCount);
  console.log('\n前10条用户数据:');
  data.users.forEach((u, i) => console.log(`  ${i+1}. ${u}`));
  
  // Extract more detail from text
  console.log('\n=== FULL TEXT (relevant parts) ===');
  const lines = data.fullText.split('\n');
  const relevant = lines.filter(l => 
    l.includes('本轮') || 
    l.includes('持仓成本') || 
    l.includes('SOL') ||
    l.includes('持有')
  );
  relevant.forEach(l => console.log(l));
  
  await sidePanel.screenshot({ path: 'real-data.png', fullPage: true });
  console.log('\nScreenshot: real-data.png');
  
  await browser.close();
})();
