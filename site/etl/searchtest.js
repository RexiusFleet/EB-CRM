/* Does the dropdown browse without typing, and match words in any order? */
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await b.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-quote:not(.hide)');
  // wait for the background index
  await page.waitForFunction(() => typeof State !== 'undefined' && Array.isArray(State.index) && State.index.length, null, { timeout: 20000 });
  const n = await page.evaluate(() => State.index.length);
  console.log('index loaded: ' + n.toLocaleString() + ' sites');
  console.log('placeholder : "' + await page.getAttribute('#search', 'placeholder') + '"');

  const results = async () => {
    const c = await page.locator('#results button').count();
    const first = c ? (await page.locator('#results button .a').first().textContent()).trim() : '(none)';
    const sub = c ? (await page.locator('#results button .b').first().textContent()).trim() : '';
    return { c, first, sub };
  };

  // 1. Click with an empty box -> should prepopulate
  await page.click('#search');
  await page.waitForTimeout(400);
  let r = await results();
  console.log('\n1. empty focus       -> ' + r.c + ' rows; first: "' + r.first + '"');
  const head = await page.locator('#results .rhead').count();
  console.log('   header row shown  -> ' + (head ? 'yes' : 'NO'));

  // 2. Word order should not matter
  for (const q of ['cindy couey', 'couey cindy', 'couey spyglass', 'spyglass', '453 spy']) {
    await page.fill('#search', q);
    await page.waitForTimeout(320);
    r = await results();
    console.log(`2. "${q}"`.padEnd(24) + '-> ' + String(r.c).padStart(3) + ' rows; first: "' + r.first + '"');
  }

  // 3. Partial / misspelled-order company name
  for (const q of ['arbor south', 'south arbor', 'corvallis school', 'school corvallis']) {
    await page.fill('#search', q);
    await page.waitForTimeout(320);
    r = await results();
    console.log(`3. "${q}"`.padEnd(24) + '-> ' + String(r.c).padStart(3) + ' rows; first: "' + r.first + '"');
  }

  // 4. City / zip
  for (const q of ['creswell', '97424']) {
    await page.fill('#search', q);
    await page.waitForTimeout(320);
    r = await results();
    console.log(`4. "${q}"`.padEnd(24) + '-> ' + String(r.c).padStart(3) + ' rows; first: "' + r.first + '"');
  }

  // 5. Keyboard: arrow down + enter selects and loads the site
  await page.fill('#search', 'spyglass');
  await page.waitForTimeout(350);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const selText = await page.locator('#results button.sel .a').textContent().catch(() => '(none)');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const addr = await page.inputValue('#q_address');
  const cust = await page.inputValue('#q_customer');
  const hist = (await page.textContent('#histcount')).trim();
  console.log('\n5. keyboard select   -> highlighted "' + selText.trim() + '"');
  console.log('   loaded address    -> "' + addr + '"  customer "' + cust + '"');
  console.log('   history           -> ' + (hist || '(none)'));

  // 6. Nonsense query
  await page.fill('#search', 'zzzzqqq');
  await page.waitForTimeout(320);
  console.log('\n6. no-match message  -> "' + (await page.textContent('#results')).trim().slice(0, 40) + '"');

  await page.fill('#search', '');
  await page.click('#search');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/root/crm/shot-dropdown.png' });

  console.log('\nconsole errors: ' + (errs.length ? errs.join(' | ') : 'none'));
  await b.close();
})();
