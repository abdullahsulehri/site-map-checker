// Run: node --experimental-strip-types test/validate_test.mjs
import assert from 'node:assert';
import { validateRequest } from '../ui/supabase/functions/start-job/validate.ts';
const U = 'user-123';
const ok = (b) => { const r = validateRequest(b, U); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
const bad = (b, re) => { const r = validateRequest(b, U); assert.ok(!r.ok, 'should fail'); assert.match(r.error, re); };

assert.strictEqual(ok({ site_name: 'Acme', site_url: 'https://acme.com' }).max_pages, 200);
assert.strictEqual(ok({ site_name: 'Acme', site_url: 'https://acme.com', max_pages: '500' }).max_pages, 500);
assert.strictEqual(ok({ site_name: 'A', input_path: `${U}/list.txt`, estimate_only: true }).estimate_only, true);
bad(null, /Invalid/);
bad({ site_name: '', site_url: 'https://a.com' }, /Site name/);
bad({ site_name: 'A' }, /homepage URL, a sitemap URL, or upload/);
bad({ site_name: 'A', site_url: 'ftp://a.com' }, /http/);
bad({ site_name: 'A', site_url: 'javascript:alert(1)' }, /http/);
bad({ site_name: 'A', site_url: 'https://a.com', max_pages: 1001 }, /1 to 1000/);
bad({ site_name: 'A', site_url: 'https://a.com', max_pages: 0 }, /1 to 1000/);
bad({ site_name: 'A', site_url: 'https://a.com', max_pages: 'abc' }, /1 to 1000/);
bad({ site_name: 'A', site_url: 'https://a.com', max_pages: 12.5 }, /1 to 1000/);
bad({ site_name: 'A', input_path: 'someone-else/list.txt' }, /does not belong/);
bad({ site_name: 'A', input_path: `${U}/../other/list.txt` }, /does not belong/);
bad({ site_name: 'A', site_url: 'https://a.com', recipient_email: 'a@b.com, c@d.com' }, /email/);
assert.strictEqual(ok({ site_name: 'A', site_url: 'https://a.com', estimate_only: 'true' }).estimate_only, false, 'only a real boolean true counts');
console.log('validate: ALL TESTS PASSED');
