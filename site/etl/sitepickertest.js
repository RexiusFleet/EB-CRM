/* The Job Site address field should have its own browsable dropdown, without
   breaking free-text entry of a genuinely new address. */
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('#view-quote:not(.hide)');
  await p.waitForFunction(() => typeof State !== 'undefined' && Array.isArray(State.index) && State.index.length, null, { timeout: 20000 });

  const pass = [], fail = [];
  const ck = (n, c, x) => (c ? pass : fail).push(n + (x ? ' -> ' + x : ''));

  console.log('build stamp: ' + (await p.textContent('#modepill')));

  // 1. click the address field -> browsable list appears
  await p.click('#q_address');
  await p.waitForTimeout(400);
  let n = await p.locator('#addrresults button').count();
  const head = await p.textContent('#addrresults .rhead').catch(() => '');
  ck('address field opens a browsable list', n > 0, n + ' rows');
  ck('list has its own heading', /Previous job sites/.test(head), head.trim());

  // 2. typing filters it, word order independent
  await p.fill('#q_address', 'couey spyglass');
  await p.waitForTimeout(350);
  n = await p.locator('#addrresults button').count();
  const first = n ? (await p.locator('#addrresults button .a').first().textContent()).trim() : '';
  ck('filters on words in any order', n === 1 && /spyglass/i.test(first), n + ' rows, first "' + first + '"');

  // 3. picking loads the site
  await p.locator('#addrresults button').first().click();
  await p.waitForTimeout(900);
  const addr = await p.inputValue('#q_address');
  const cust = await p.inputValue('#q_customer');
  const hist = (await p.textContent('#histcount')).trim();
  ck('picking loads the site', /spyglass/i.test(addr) && cust.length > 0, addr + ' / ' + cust + ' / ' + hist);
  ck('dropdown closes after picking',
    await p.locator('#addrresults').evaluate(e => e.classList.contains('hide')));

  // 4. a genuinely NEW address must survive typing + Enter (not be hijacked)
  await p.click('#newquote'); await p.waitForTimeout(300);
  await p.click('#q_address');
  await p.fill('#q_address', '9821 Brand New Rd, Veneta');
  await p.waitForTimeout(350);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(600);
  const newAddr = await p.inputValue('#q_address');
  ck('free-text new address is not hijacked by Enter',
    newAddr === '9821 Brand New Rd, Veneta', '"' + newAddr + '"');

  // 5. the two dropdowns are independent
  await p.click('#newquote'); await p.waitForTimeout(300);
  await p.click('#search'); await p.waitForTimeout(300);
  const hOpen = !(await p.locator('#results').evaluate(e => e.classList.contains('hide')));
  const aOpen = !(await p.locator('#addrresults').evaluate(e => e.classList.contains('hide')));
  ck('header dropdown open, address dropdown closed', hOpen && !aOpen, 'header=' + hOpen + ' addr=' + aOpen);

  // 6. arrow keys in the address field only move the address list
  await p.keyboard.press('Escape');
  await p.click('#q_address'); await p.waitForTimeout(350);
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown');
  const selA = await p.locator('#addrresults button.sel').count();
  const selH = await p.locator('#results button.sel').count();
  ck('arrow keys scoped to their own list', selA === 1 && selH === 0, 'addr sel=' + selA + ' header sel=' + selH);

  await p.keyboard.press('Escape');
  await p.click('#q_address'); await p.waitForTimeout(500);
  await p.screenshot({ path: '/root/crm/shot-sitepicker.png' });

  console.log('\nPASS (' + pass.length + ')'); pass.forEach(x => console.log('  ✓ ' + x));
  if (fail.length) { console.log('FAIL (' + fail.length + ')'); fail.forEach(x => console.log('  ✗ ' + x)); }
  console.log('console errors: ' + (errs.length ? errs.join(' | ') : 'none'));
  await b.close();
  process.exit(fail.length || errs.length ? 1 : 0);
})();
