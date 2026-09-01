/* What actually autofills, on each entry path? */
const { chromium } = require('playwright');

const FIELDS = ['q_customer','q_phone','q_address','q_city','q_zip','q_drive','q_blow','q_product','q_yards'];

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await b.newPage({ viewport:{width:1400,height:950} });
  await page.goto('http://localhost:8765/index.html', { waitUntil:'networkidle' });
  await page.waitForSelector('#view-quote:not(.hide)');

  const snap = async () => {
    const o = {};
    for (const f of FIELDS) o[f] = await page.inputValue('#'+f);
    o['_history'] = (await page.textContent('#histcount')).trim();
    o['_tag'] = (await page.textContent('#sitetag')).trim();
    return o;
  };
  const show = (label, s) => {
    console.log('\n--- ' + label + ' ---');
    for (const f of FIELDS) console.log(`  ${f.replace('q_','').padEnd(10)} ${s[f] ? '"'+s[f]+'"' : '(empty)'}`);
    console.log(`  history    ${s._history || '(none)'}   ${s._tag}`);
  };

  // PATH 1: pick from the search dropdown, by address
  await page.fill('#search','453 spyglass');
  await page.waitForFunction(() => {
    const b=document.querySelector('#results button .a');
    return b && /453/.test(b.textContent);
  }, null, {timeout:8000});
  await page.locator('#results button').first().click();
  await page.waitForTimeout(800);
  show('PATH 1 · picked from search by ADDRESS', await snap());

  // PATH 2: search by CUSTOMER NAME
  await page.click('#newquote'); await page.waitForTimeout(300);
  await page.fill('#search','Cindy Couey');
  await page.waitForFunction(() => {
    const b=document.querySelector('#results button .a');
    return b && /spyglass/i.test(b.textContent);
  }, null, {timeout:8000}).catch(()=>{});
  const n2 = await page.locator('#results button').count();
  if (n2) { await page.locator('#results button').first().click(); await page.waitForTimeout(800); }
  show(`PATH 2 · searched CUSTOMER NAME (${n2} hits)`, await snap());

  // PATH 3: type an address straight into the form (no search)
  await page.click('#newquote'); await page.waitForTimeout(300);
  await page.fill('#q_address','453 Spyglass Dr');
  await page.dispatchEvent('#q_address','change');
  await page.waitForTimeout(800);
  show('PATH 3 · typed address into the form directly', await snap());

  // PATH 4: a brand-new address with no history
  await page.click('#newquote'); await page.waitForTimeout(300);
  await page.fill('#q_address','12345 Nowhere Ln, Veneta');
  await page.dispatchEvent('#q_address','change');
  await page.waitForTimeout(800);
  show('PATH 4 · brand-new address', await snap());

  // Is there an email field at all?
  const hasEmail = await page.locator('#q_email').count();
  console.log('\n  email field present in the form: ' + (hasEmail ? 'yes' : 'NO'));

  await b.close();
})();
