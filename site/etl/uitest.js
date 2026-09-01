/* Headless smoke + behaviour test of the app against the demo bundle. */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  const fail = [];
  const ok = [];
  const check = (name, cond, extra) => (cond ? ok : fail).push(name + (extra ? ' -> ' + extra : ''));

  await page.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-quote:not(.hide)', { timeout: 20000 });

  check('app boots', await page.isVisible('#view-quote'));
  check('demo pill shown', (await page.textContent('#modepill')).includes('Demo'));

  /* ---- default quote computes ---- */
  const target0 = await page.textContent('#o_target');
  check('target price computed on load', /\$[\d,]+/.test(target0), target0);

  /* ---- search finds a known repeat address ---- */
  await page.fill('#search', 'spyglass');
  await page.waitForSelector('#results button', { timeout: 8000 });
  const nres = await page.locator('#results button').count();
  check('search returns results', nres > 0, nres + ' hits');
  const firstText = await page.locator('#results button .a').first().textContent();
  await page.locator('#results button').first().click();
  await page.waitForTimeout(600);

  const hist = await page.textContent('#histcount');
  check('history loads for picked site', /\d/.test(hist), 'picked "' + firstText.trim() + '" -> ' + hist.trim());
  const tl = await page.locator('.tl').count();
  check('timeline renders entries', tl > 0, tl + ' entries');

  /* ---- estimator shows a basis, not a bare number ---- */
  const db = await page.textContent('#drivebasis');
  const bb = await page.textContent('#blowbasis');
  check('drive basis explained', db.trim().length > 10, db.trim().slice(0, 60));
  check('blow basis explained', bb.trim().length > 10, bb.trim().slice(0, 60));

  /* ---- changing yards moves the price ---- */
  await page.fill('#q_yards', '30');
  await page.waitForTimeout(250);
  const t30 = await page.textContent('#o_target');
  await page.fill('#q_yards', '8');
  await page.waitForTimeout(250);
  const t8 = await page.textContent('#o_target');
  const n = s => Number(String(s).replace(/[^0-9.]/g, ''));
  check('price scales with yards', n(t30) > n(t8), `30yd ${t30} > 8yd ${t8}`);

  /* ---- overhead switches mode at 16 yards ---- */
  await page.fill('#q_yards', '15'); await page.waitForTimeout(200);
  const oh15 = await page.textContent('#k_oh');
  await page.fill('#q_yards', '16'); await page.waitForTimeout(200);
  const oh16 = await page.textContent('#k_oh');
  check('overhead switches per-yard -> hourly at 16 yd',
    oh15.includes('/yd') && oh16.includes('equip hr'), `15yd "${oh15.trim()}" | 16yd "${oh16.trim()}"`);

  /* ---- manual override sticks ---- */
  await page.fill('#q_blow', '9');
  await page.waitForTimeout(250);
  const blowVal = await page.inputValue('#q_blow');
  const bb2 = await page.textContent('#blowbasis');
  check('manual blow override is kept', blowVal === '9', 'value=' + blowVal);
  check('override is flagged in UI', bb2.includes('overridden'), bb2.trim().slice(-40));

  /* ---- underwater bid warns ---- */
  await page.fill('#q_bid', '50');
  await page.waitForTimeout(250);
  const warn = await page.textContent('#marginnote');
  check('below-cost bid warns', /below cost/i.test(warn), warn.trim().slice(0, 70));

  /* ---- needs-cost product blocks pricing ---- */
  await page.selectOption('#q_product', 'Quarter Ten from RiverBend').catch(() => {});
  await page.waitForTimeout(300);
  const cw = await page.textContent('#costwarn');
  check('product without a cost is blocked', /no 2026 cost/i.test(cw), cw.trim().slice(0, 60));

  /* ---- save a quote ---- */
  await page.selectOption('#q_product', 'Hemlock');
  await page.fill('#q_yards', '18'); await page.fill('#q_bid', '');
  await page.fill('#q_customer', 'UI Test'); await page.fill('#q_address', '999 Test St, Eugene');
  await page.waitForTimeout(300);
  await page.click('#savequote');
  await page.waitForTimeout(500);
  const sm = await page.textContent('#savemsg');
  check('quote saves', /saved/i.test(sm), sm.trim().slice(0, 50));

  /* ---- other tabs render ---- */
  for (const [tab, sel] of [['quotes', '#quoteslist table'], ['dash', '#dashstats .s'], ['rates', '#ratetable table']]) {
    await page.click(`#tabs button[data-view="${tab}"]`);
    try { await page.waitForSelector(sel, { timeout: 8000 }); check(tab + ' tab renders', true); }
    catch (e) { check(tab + ' tab renders', false, 'no ' + sel); }
  }

  /* ---- rate card edit recalculates ---- */
  await page.click('#tabs button[data-view="rates"]');
  await page.waitForSelector('#ratetable input[data-p]');
  const inp = page.locator('#ratetable input[data-p="Hemlock"]');
  if (await inp.count()) {
    await inp.fill('300'); await inp.dispatchEvent('change'); await page.waitForTimeout(400);
    await page.click('#tabs button[data-view="quote"]'); await page.waitForTimeout(300);
    const after = await page.textContent('#o_mat');
    check('rate card edit flows into the quote', n(after) > 0, 'material now ' + after);
  }

  await page.click('#tabs button[data-view="quote"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/root/crm/screenshot-quote.png', fullPage: false });
  await page.click('#tabs button[data-view="dash"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/root/crm/screenshot-dash.png', fullPage: false });

  console.log('PASS (' + ok.length + ')');
  ok.forEach(o => console.log('  ✓ ' + o));
  if (fail.length) { console.log('\nFAIL (' + fail.length + ')'); fail.forEach(f => console.log('  ✗ ' + f)); }
  if (errors.length) { console.log('\nCONSOLE ERRORS (' + errors.length + ')'); errors.slice(0, 10).forEach(e => console.log('  ! ' + e)); }
  await browser.close();
  process.exit(fail.length || errors.length ? 1 : 0);
})();
