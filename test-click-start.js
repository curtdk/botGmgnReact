const { chromium } = require('playwright');

(async () => {
  console.log('Connecting to Chrome...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  
  const contexts = browser.contexts();
  const pages = contexts[0]?.pages() || [];
  
  // Find the side panel
  let sidePanel = pages.find(p => p.url().includes('sidepanel'));
  
  if (!sidePanel) {
    console.log('SidePanel not found! Please open it first.');
    await browser.close();
    process.exit(1);
  }

  console.log('Found SidePanel:', sidePanel.url());

  // Try to find and click the Start button
  console.log('Looking for Start button...');
  
  // Try multiple selectors for the start button
  const startButtonSelectors = [
    'button:has-text("开始")',
    'button:has-text("运行")', 
    'button.green',
    'button[class*="green"]',
    '[class*="start"]',
    'button.primary'
  ];

  let clicked = false;
  for (const selector of startButtonSelectors) {
    try {
      const button = await sidePanel.$(selector);
      if (button) {
        const text = await button.textContent();
        console.log(`Found button: ${text?.substring(0, 50)}`);
        await button.click();
        console.log(`Clicked: ${selector}`);
        clicked = true;
        break;
      }
    } catch (e) {
      // continue
    }
  }

  if (!clicked) {
    console.log('Could not find Start button, trying to list all buttons...');
    const buttons = await sidePanel.evaluate(() => {
      const btns = document.querySelectorAll('button');
      return Array.from(btns).map(b => ({ text: b.textContent?.substring(0, 30), class: b.className }));
    });
    console.log('All buttons:', JSON.stringify(buttons, null, 2));
  }

  // Wait for data to flow
  console.log('\nWaiting 20s for data flow...');
  await sidePanel.waitForTimeout(20000);

  // Get metrics
  const metrics = await sidePanel.evaluate(() => {
    const bodyText = document.body.innerText;
    return {
      text: bodyText.substring(0, 3000)
    };
  });

  console.log('\n--- SidePanel Content (first 3000 chars) ---');
  console.log(metrics.text);

  // Screenshot
  await sidePanel.screenshot({ path: 'after-click.png', fullPage: true });
  console.log('\nSaved: after-click.png');

  console.log('\n✅ Done!');
  await browser.close();
})();
