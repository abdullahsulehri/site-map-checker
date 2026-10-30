// Offline tests for build_config.js (no internet needed; spins up a local fake site).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const execFileP = (cmd, args, opts) => new Promise((res, rej) => execFile(cmd, args, opts, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));
const assert = require('assert');
const { classifyByRules, applyCap, locs, normalizeUrl, estimate } = require('../build_config.js');

// ---- unit: rules ----
const t = (p, h = '') => classifyByRules(p, h);
assert.strictEqual(t('/').type, 'Company');
assert.strictEqual(t('/blogs/my-post/').type, 'Blog');
assert.strictEqual(t('/ty-request-demo/').type, 'Thank You Page');
assert.strictEqual(t('/unilever-case-study/').type, 'Case Study');
assert.strictEqual(t('/contact/').contact, true);
assert.strictEqual(t('/request-demo/').type, 'Form');
assert.strictEqual(t('/pricing-plan/').type, 'Pricing');
assert.strictEqual(t('/webinar-the-evolving-role-of-hr/').type, 'Webinar');
assert.strictEqual(t('/something-weird-xyz/').type, 'Other');
assert.strictEqual(t('/2024/some-slug/', 'post-sitemap.xml').type, 'Blog');
assert.ok(t('/something-weird-xyz/').confidence < 0.6);

// ---- unit: parsing ----
assert.deepStrictEqual(locs('<urlset><url><loc> https://a.com/x?a=1&amp;b=2 </loc></url><url><loc><![CDATA[https://a.com/y]]></loc></url></urlset>'),
  ['https://a.com/x?a=1&b=2', 'https://a.com/y']);
assert.strictEqual(normalizeUrl('https://a.com/file.pdf'), null);
assert.strictEqual(normalizeUrl('mailto:x@y.com'), null);
assert.strictEqual(normalizeUrl('https://a.com/p/?utm=1#top').href, 'https://a.com/p/');

// ---- unit: cap keeps core types, samples blogs ----
const mk = (type, i) => ({ type, path: `/${type}/${i}` });
const pages = [...Array(10).fill(0).map((_, i) => mk('Service', i)), ...Array(500).fill(0).map((_, i) => mk('Blog', i))];
const { kept, skipped } = applyCap(pages, 200);
assert.strictEqual(kept.length, 200);
assert.strictEqual(kept.filter((p) => p.type === 'Service').length, 10);
assert.strictEqual(skipped.length, 310);

// ---- unit: estimate grows with pages and links ----
assert.ok(estimate(200, 2000).minutes > estimate(100, 1000).minutes);
assert.ok(estimate(10, 10).low < estimate(10, 10).minutes && estimate(10, 10).minutes < estimate(10, 10).high);

// ---- integration: fake site with a sitemap index ----
const PAGES = {
  '/': '<title>Acme | Home</title><a href="/about/">a</a><a href="/contact/">c</a><a href="https://ext.example/x">e</a><a href="mailto:a@b.com">m</a><a href="#top">t</a>',
  '/about/': '<title>About Us - Acme</title><a href="/">h</a><a href="/contact/">c</a>',
  '/contact/': '<title>Contact</title><form></form>',
  '/blog/hello-world/': '<title>Hello World | Acme</title><meta property="og:type" content="article">',
  '/mystery-page/': '<title>Mystery</title><form action="/x"></form>',
  '/odd-article/': '<title>Odd</title><script type="application/ld+json">{"@graph":[{"@type":"BlogPosting"}]}</script>',
};
const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.url === '/upload-list.txt') return res.end(`${base}/about/\n${base}/contact/, ${base}/about/\nnot a url\n`);
  if (req.url === '/upload-sitemap.xml') return res.end(`<urlset><url><loc>${base}/about/</loc></url><url><loc>${base}/blog/hello-world/</loc></url></urlset>`);
  if (req.url === '/robots.txt') return res.end(`Sitemap: ${base}/sitemap_index.xml\n`);
  if (req.url === '/sitemap_index.xml') return res.end(`<sitemapindex><sitemap><loc>${base}/page-sitemap.xml</loc></sitemap><sitemap><loc>${base}/post-sitemap.xml</loc></sitemap></sitemapindex>`);
  if (req.url === '/page-sitemap.xml') return res.end(`<urlset>${['/', '/about/', '/contact/', '/mystery-page/', '/odd-article/', '/about/'].map((p) => `<url><loc>${base}${p}</loc></url>`).join('')}<url><loc>https://other-host.com/x</loc></url></urlset>`);
  if (req.url === '/post-sitemap.xml') return res.end(`<urlset><url><loc>${base}/blog/hello-world/</loc></url></urlset>`);
  const body = PAGES[req.url];
  if (body) { res.setHeader('content-type', 'text/html'); return res.end(`<html><head>${body}</head><body></body></html>`); }
  res.statusCode = 404; res.end('nope');
});
server.listen(0, '127.0.0.1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
  const port = server.address().port;
  const run = async (extra) => {
    await execFileP('node', [path.join(__dirname, '..', 'build_config.js')], { cwd: dir, env: { ...process.env, SITE_URL: `http://127.0.0.1:${port}`, SITE_NAME: 'Acme', ...extra } });
    return { cfg: JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))), sum: JSON.parse(fs.readFileSync(path.join(dir, 'build_summary.json'))) };
  };
  try {
    let { cfg, sum } = await run({});
    const pg = Object.fromEntries(cfg.sites[0].pages.map((p) => [p.path, p]));
    assert.strictEqual(cfg.sites[0].pages.length, 6, 'dedupes /about/ and ignores other-host');
    assert.strictEqual(sum.off_host_ignored, 1);
    assert.strictEqual(pg['/'].name, 'Home');
    assert.strictEqual(pg['/about/'].page_type, 'Company');
    assert.strictEqual(pg['/contact/'].expects_lead_form, true);
    assert.strictEqual(pg['/blog/hello-world/'].page_type, 'Blog');
    assert.ok(pg['/blog/hello-world/'].type_confidence >= 0.9, 'rule + signal agreement raises confidence');
    assert.strictEqual(pg['/mystery-page/'].page_type, 'Form');
    assert.ok(pg['/mystery-page/'].type_confidence <= 0.5);
    assert.strictEqual(pg['/mystery-page/'].expects_lead_form, true);
    assert.strictEqual(pg['/odd-article/'].page_type, 'Blog');
    assert.ok(Object.values(pg).every((p) => p.expects_calendly === undefined), 'never infers booking-link expectations');
    // link counting: mailto and #anchors ignored, external counted separately
    assert.ok(sum.est_unique_links >= 4, 'counts links from page HTML');
    assert.ok(sum.est_unique_external >= 1, 'counts external links');
    assert.ok(sum.est_minutes > 0 && sum.est_minutes_high > sum.est_minutes_low);
    assert.strictEqual(sum.cap, 200);
    ({ cfg, sum } = await run({ MAX_PAGES: '3' }));
    assert.ok(/higher max pages/.test(sum.hint), 'tells the user how to include skipped pages');
    assert.strictEqual(cfg.sites[0].pages.length, 3);
    assert.strictEqual(sum.skipped_by_cap, 3);
    // raising the cap past the hard ceiling is clamped and reported
    ({ cfg, sum } = await run({ MAX_PAGES: '5000', MAX_PAGES_CEILING: '4' }));
    assert.strictEqual(sum.cap, 4);
    assert.strictEqual(sum.cap_clamped, true);
    // runtime guard: refuses when the estimate exceeds the limit (exit code 3, summary still written)
    let blocked = false;
    try { await run({ MAX_RUNTIME_MIN: '1' }); } catch (e) { blocked = true; }
    assert.ok(blocked, 'exits non-zero when estimate exceeds runtime limit');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'build_summary.json'))).blocked, true);
    ({ cfg, sum } = await run({ SITE_URL: '', SITEMAP_URL: '', PAGE_LIST: `http://127.0.0.1:${port}/about/\nhttp://127.0.0.1:${port}/contact/` }));
    assert.strictEqual(cfg.sites[0].pages.length, 2);
    // uploaded files (used by the UI): a plain URL list and a sitemap XML
    ({ cfg, sum } = await run({ SITE_URL: '', SITEMAP_URL: '', PAGE_LIST: '', INPUT_FILE_URL: `http://127.0.0.1:${port}/upload-list.txt` }));
    assert.strictEqual(cfg.sites[0].pages.length, 2, 'URL list upload: dedupes and ignores junk lines');
    assert.strictEqual(sum.source, 'uploaded page list');
    ({ cfg, sum } = await run({ SITE_URL: '', SITEMAP_URL: '', PAGE_LIST: '', INPUT_FILE_URL: `http://127.0.0.1:${port}/upload-sitemap.xml` }));
    assert.strictEqual(cfg.sites[0].pages.length, 2);
    assert.strictEqual(sum.source, 'uploaded sitemap file');
    console.log('ALL TESTS PASSED');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
