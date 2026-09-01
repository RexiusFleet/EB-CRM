/* Mock Supabase for reproducing client-side auth bugs.
 *
 * Mimics the two behaviours that matter:
 *   - /auth/v1/token?grant_type=password  -> issues a token
 *   - /rest/v1/<table>                    -> RLS-like: signed OUT returns [],
 *                                            signed IN returns real rows.
 *
 * MODE env var switches the failure being reproduced:
 *   ok        normal Supabase behaviour
 *   badurl    every REST call 404s (what a trailing slash in SUPABASE_URL does)
 *   norls     REST calls 401 when signed out (missing GRANT / policy mistake)
 *   hang      REST calls never respond (paused project / dead endpoint)
 */
const http = require('http');
const fs = require('fs');
const B = JSON.parse(fs.readFileSync(__dirname + '/data/bundle.json'));
const MODE = process.env.MODE || 'ok';
const TOKEN = 'mock-access-token';

const TABLES = {
  rate_card: B.rate_card,
  markup_curve: B.markup_curve,
  settings: Object.entries(B.settings).map(([key, value]) => ({ key, value })),
  blow_benchmarks: B.blow_benchmarks,
  drive_zones: B.drive_zones,
  profiles: [{ id: 'u1', is_admin: true, full_name: 'taylora@rexius.com' }],
  quotes: [],
  site_index: (() => {
    const m = new Map();
    const add=(k,a,c,z,n,d,kind)=>{ if(!k) return;
      let e=m.get(k); if(!e){e={site_key:k,address1:null,city:null,zip:null,customer_name:null,
        n_orders:0,n_quotes:0,last_activity:null,_n:new Set()}; m.set(k,e);}
      if(kind==='order') e.n_orders++; else e.n_quotes++;
      if(n) e._n.add(n);
      const newer = d && (!e.last_activity || d > e.last_activity);
      if(newer) e.last_activity=d;
      if(a&&(newer||!e.address1)) e.address1=a;
      if(c&&(newer||!e.city)) e.city=c;
      if(z&&(newer||!e.zip)) e.zip=z;
      if(n&&(newer||!e.customer_name)) e.customer_name=n; };
    B.orders.forEach(o=>add(o.site_key,o.ship_addr1,o.ship_city,o.ship_zip,o.customer_name,o.ord_date,'order'));
    B.quote_history.forEach(q=>add(q.site_key,q.address_raw,q.city,q.zip,q.customer_name,q.quote_date,'quote'));
    const rows=[...m.values()];
    rows.forEach(r=>{ r.all_names=[...r._n].join(' | '); delete r._n; });
    rows.sort((a,b)=>String(b.last_activity||'').localeCompare(String(a.last_activity||'')));
    return rows;
  })(),
  orders: B.orders.slice(0, 200),
  quote_history: B.quote_history.slice(0, 200),
  order_lines: []
};

const send = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
  });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const authed = (req.headers.authorization || '').includes(TOKEN);

  if (url.pathname === '/auth/v1/token') {
    let body = '';
    req.on('data', d => body += d);
    return req.on('end', () => {
      let j = {}; try { j = JSON.parse(body); } catch (e) {}
      if (url.searchParams.get('grant_type') === 'refresh_token')
        return send(res, 400, { error: 'invalid_grant' });
      if (!j.email || !j.password)
        return send(res, 400, { error_description: 'missing credentials' });
      if (j.password === 'wrong')
        return send(res, 400, { error_description: 'Invalid login credentials' });
      return send(res, 200, {
        access_token: TOKEN, refresh_token: 'mock-refresh',
        user: { id: 'u1', email: j.email }
      });
    });
  }

  if (url.pathname.startsWith('/rest/v1/')) {
    if (MODE === 'hang') return;                       // never respond, ever
    if (MODE === 'badurl') return send(res, 404, { message: 'not found' });
    if (MODE === 'norls' && !authed) return send(res, 401, { message: 'permission denied' });
    const table = url.pathname.replace('/rest/v1/', '').split('?')[0];
    if (MODE === 'noview' && table === 'site_index')
      return send(res, 404, { message: 'relation "public.site_index" does not exist' });
    const rows = TABLES[table] || [];
    if (req.method === 'POST') {
      let body = ''; req.on('data', d => body += d);
      return req.on('end', () => send(res, 201, [Object.assign({ id: 'q1' }, JSON.parse(body || '{}'))]));
    }
    // RLS: signed-out users see nothing
    return send(res, 200, authed ? rows : []);
  }

  if (url.pathname === '/rest/v1/' || url.pathname === '/') return send(res, 200, {});
  send(res, 404, { message: 'no route' });
}).listen(9999, () => console.log('mock supabase on :9999 MODE=' + MODE));
