// Offline tests for the CloudFront Function terraform/admin-auth.js. The file is
// loaded the way Terraform deploys it — with the ${session_key} and ${admin_users}
// placeholders filled in —
// and run in Node with a require() that only offers 'crypto', as CloudFront does.
// Cookies are signed by the Lambda's own sessionValue(), so both sides must agree.
// Run with:  npm test
//
// Each check prints PASS or FAIL; the process exits non-zero if any check fails.

import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const KEY = 'b'.repeat(64);
Object.assign(process.env, { ADMIN_USERS: JSON.stringify({ markus: 'x', marie: 'x' }), SESSION_KEY: KEY, SESSION_HOURS: '12', AWS_REGION: 'eu-central-1' });
const lambda = await import('../lambda/index.mjs?gate');

const template = await readFile(new URL('../terraform/admin-auth.js', import.meta.url), 'utf8');
const source = template.replace('${session_key}', KEY).replace('${admin_users}', JSON.stringify(['markus', 'marie']));
const handler = new Function('require', `${source}\nreturn handler;`)(
  (name) => { if (name !== 'crypto') throw new Error(`no module ${name}`); return crypto; });

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// Terraform's templatefile() would also interpret any other ${...} or %{...} in the code.
ok(template.split('${').length === 3 && !template.includes('%{'), 'only template sequences are ${session_key} and ${admin_users}');

// CloudFront event shape: lowercase header names, cookies as { name: { value } }.
const run = (uri, cookie, headers = {}) => handler({
  request: { uri, headers, cookies: cookie === undefined ? {} : { '__Host-mem_admin': { value: cookie } } },
});
const session = lambda.sessionValue('markus');
const [, exp, sig] = session.split('.');
const mac = (payload, key = KEY) => crypto.createHmac('sha256', key).update(payload).digest('hex');
const signed = (user, expiry) => `${user}.${expiry}.${mac(`${user}.${expiry}`)}`;

// Without a valid session.
for (const uri of ['/admin', '/admin/', '/admin/index.html', '/admin/gallery/', '/admin/files/2026-10-03T19-04-11Z_gast_0a1b2c3d.jpg']) {
  const r = run(uri);
  ok(r.statusCode === 302 && r.headers.location.value === `/login/index.html?next=${encodeURIComponent(uri)}`
    && r.headers['cache-control'].value === 'no-store', `no session: ${uri} -> 302 login`);
}
ok(run('/admin/api/list').statusCode === 401, 'no session: API -> 401');
const past = Math.floor(Date.now() / 1000) - 1;
for (const [label, cookie] of [
  ['empty', ''],
  ['expired', signed('markus', past)],
  ['forged signature', `markus.${exp}.${'0'.repeat(64)}`],
  ['extended expiry', `markus.${Number(exp) + 3600}.${sig}`],
  ['other user, same signature', `marie.${exp}.${sig}`],
  ['validly signed, user not configured', signed('hannah', exp)],
  ['old format without user', `${exp}.${mac(exp)}`],
  ['signed with another key', `markus.${exp}.${mac(`markus.${exp}`, 'c'.repeat(64))}`],
  ['uppercase hex', `markus.${exp}.${sig.toUpperCase()}`],
  ['extra part', `${session}.x`],
]) ok(run('/admin/', cookie).statusCode === 302, `${label} cookie denied`);
ok(run('/admin/', undefined, { authorization: { value: 'Basic dXNlcjpwYXNz' } }).statusCode === 302, 'old Basic Auth header denied');

// With a valid session from the Lambda.
const pass = (uri) => run(uri, session);
ok(pass('/admin').statusCode === 301 && pass('/admin').headers.location.value === '/admin/', '/admin -> 301 /admin/');
ok(pass('/admin/gallery').headers.location.value === '/admin/gallery/', '/admin/gallery -> 301 /admin/gallery/');
ok(pass('/admin/').uri === '/admin/index.html', '/admin/ -> index.html');
ok(pass('/admin/gallery/').uri === '/admin/gallery/index.html', '/admin/gallery/ -> index.html');
ok(pass('/admin/index.html').uri === '/admin/index.html', 'file path unchanged');
ok(pass('/admin/api/list').uri === '/admin/api/list', 'API path unchanged');
ok(pass('/admin/files/a%20b%2Bc.jpg').uri === '/uploads/a%20b%2Bc.jpg', 'original -> uploads/<key>, encoding kept');
ok(pass('/admin/files/noextension').uri === '/uploads/noextension', 'original without extension is not redirected');

console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
