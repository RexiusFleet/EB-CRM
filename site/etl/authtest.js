/* Does the Sign in button work in live mode? Tests three back-end conditions. */
const { chromium } = require('playwright');

const MODE = process.argv[2] || 'ok';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });

  await page.goto('http://localhost:8766/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const bootVisible = await page.isVisible('#boot');
  const bootText = bootVisible ? (await page.textContent('#boot')).trim().slice(0, 90) : '(hidden)';
  const btnVisible = await page.isVisible('#authbtn');

  // THE test: click Sign in and see whether the dialog opens.
  let dialogOpen = false, clickErr = null;
  try {
    await page.click('#authbtn', { timeout: 3000 });
    await page.waitForTimeout(400);
    dialogOpen = await page.evaluate(() => document.getElementById('authdlg').open);
  } catch (e) { clickErr = e.message.split('\n')[0]; }

  let signedIn = false, dataAfter = null;
  if (dialogOpen) {
    await page.fill('#au_email', 'taylora@rexius.com');
    await page.fill('#au_pw', 'correct-horse');
    await page.click('#au_go');
    await page.waitForTimeout(1500);
    // NOTE: `const State` lives in the global lexical scope, not on `window`,
    // so it must be referenced bare -- `window.State` is always undefined.
    signedIn = await page.evaluate(() => typeof State !== 'undefined' && !!State.user);
    dataAfter = await page.evaluate(() =>
      typeof State === 'undefined' ? null : ((State.ref && State.ref.rate_card) || []).length);
  }

  console.log(`\n=== MODE=${MODE} ===`);
  console.log(`  boot panel:        ${bootVisible ? 'VISIBLE -> "' + bootText + '"' : 'hidden (loaded ok)'}`);
  console.log(`  Sign in button:    ${btnVisible ? 'visible' : 'NOT VISIBLE'}`);
  console.log(`  click -> dialog:   ${dialogOpen ? 'OPENS' : '*** DOES NOTHING ***'}${clickErr ? ' (' + clickErr + ')' : ''}`);
  if (dialogOpen) {
    console.log(`  signed in:         ${signedIn}`);
    console.log(`  rate_card rows:    ${dataAfter}`);
  }
  if (errs.length) { console.log('  console errors:'); errs.slice(0, 5).forEach(e => console.log('    ! ' + e)); }
  await browser.close();
})();
