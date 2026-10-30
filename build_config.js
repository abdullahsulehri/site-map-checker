#!/usr/bin/env node
// build_config.js — turns a sitemap (or a pasted list of URLs) into config.json
// for check.js. Classifies each page and records HOW sure it is.
//
// Inputs (env vars):
//   SITE_NAME     label for the report (optional)
//   SITE_URL      homepage, e.g. https://example.com (used to auto-find the sitemap)
//   SITEMAP_URL   direct link to sitemap.xml / sitemap index (optional)
//   PAGE_LIST     newline- or comma-separated URLs (optional, overrides sitemaps)
//   INPUT_FILE_URL  link to an uploaded sitemap.xml or a text/CSV list of URLs (optional)
//   MAX_PAGES     cap on pages checked (default 200)
//   NO_FETCH=1    skip loading pages for titles/signals (used by tests)
//
// Output: config.json  (+ build_summary.json with counts for the email)

const fs = require('fs');
const zlib = require('zlib');

const DEFAULT_CAP = 200;
const CEILING = parseInt(process.env.MAX_PAGES_CEILING || '1000', 10); // hard safety limit
const REQUESTED = parseInt(process.env.MAX_PAGES || String(DEFAULT_CAP), 10);
const MAX_PAGES = Math.max(1, Math.min(Number.isFinite(REQUESTED) ? REQUESTED : DEFAULT_CAP, CEILING));
const CAP_CLAMPED = Number.isFinite(REQUESTED) && REQUESTED > CEILING;
// Time model (seconds). Rough defaults; tune from the "estimated vs actual" line in each report.
const SETUP_S = parseFloat(process.env.EST_SETUP_S || '90');      // checkout + npm + browser install
const PAGE_S = parseFloat(process.env.EST_PAGE_S || '3');         // one page load; 4 run in parallel
const LINK_S = parseFloat(process.env.EST_LINK_S || '2');         // one unique link check; 12 in parallel
const MAX_RUNTIME_MIN = parseFloat(process.env.MAX_RUNTIME_MIN || '300'); // refuse runs estimated above this
const UA = 'Mozilla/5.0 (compatible; SiteMapperChecker/1.0)';
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|ico|zip|docx?|xlsx?|pptx?|mp4|mp3|css|js|json|xml|txt)$/i;
const MAX_CHILD_SITEMAPS = 50;
const MAX_RAW_URLS = 20000;

async function fetchBuf(url, timeoutMs = 20000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return buf;
}
const fetchText = async (u, t) => (await fetchBuf(u, t)).toString('utf-8');

function decodeXml(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"); }
function locs(xml) {
  const out = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]*?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1].trim()));
  return out;
}

// Returns [{url, hint}] where hint = file name of the (child) sitemap it came from.
async function collectSitemap(url, depth, state) {
  let xml;
  try { xml = await fetchText(url); } catch (e) { state.errors.push(`${url}: ${e.message}`); return []; }
  const hint = url.split('?')[0].split('/').pop().toLowerCase();
  if (/<sitemapindex/i.test(xml)) {
    if (depth >= 2) return [];
    const out = [];
    for (const child of locs(xml)) {
      if (state.children++ >= MAX_CHILD_SITEMAPS) { state.errors.push('Too many child sitemaps; stopped at ' + MAX_CHILD_SITEMAPS); break; }
      out.push(...await collectSitemap(child, depth + 1, state));
      if (out.length >= MAX_RAW_URLS) break;
    }
    return out;
  }
  return locs(xml).map((u) => ({ url: u, hint }));
}

async function discoverSitemaps(siteUrl) {
  const base = new URL(siteUrl).origin;
  const found = [];
  try {
    const robots = await fetchText(base + '/robots.txt');
    for (const line of robots.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) found.push(m[1]);
    }
  } catch (_) { /* no robots.txt */ }
  if (found.length) return found;
  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml']) {
    try { const t = await fetchText(base + p); if (/<(urlset|sitemapindex)/i.test(t)) return [base + p]; } catch (_) {}
  }
  return [];
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw.trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    u.search = '';
    if (SKIP_EXT.test(u.pathname)) return null;
    return u;
  } catch (_) { return null; }
}

// ---------- classification ----------
// Each result: {type, confidence 0-1, by}
function classifyByRules(path, hint) {
  const p = path.toLowerCase();
  const segs = p.split('/').filter(Boolean);
  if (segs.length === 0) return { type: 'Company', confidence: 0.95, by: 'rule: homepage' };
  if (/(^|\/)(ty|thank-?you|thanks)(-|\/|$)/.test(p)) return { type: 'Thank You Page', confidence: 0.9, by: 'rule: url thank-you' };
  if (/case-?stud/.test(p) || /case-?stud/.test(hint)) return { type: 'Case Study', confidence: 0.9, by: 'rule: case study' };
  if (/^\/?(blogs?|news|articles?|insights|posts?)(\/|$)/.test(p)) return { type: 'Blog', confidence: segs.length > 1 ? 0.85 : 0.8, by: 'rule: url blog/news' };
  if (/(^|[-_])(blog|post)s?[-_.]/.test(hint) || /^(post|blog)/.test(hint)) return { type: 'Blog', confidence: 0.7, by: 'rule: sitemap file ' + hint };
  if (/webinar|summit|disrupthr|^\/?events?(\/|$)/.test(p)) return { type: 'Webinar', confidence: 0.75, by: 'rule: url webinar/event' };
  if (/(^|\/)(contact|contact-us|get-in-touch)(-[a-z]+)?\/?$/.test(p)) return { type: 'Company', confidence: 0.85, by: 'rule: url contact', contact: true };
  if (/(^|\/)(about|about-us|careers?|jobs|privacy|privacy-policy|terms|terms-conditions|team|resources)\/?$/.test(p)) return { type: 'Company', confidence: 0.85, by: 'rule: url company' };
  if (/(request-?demo|book-?a?-?demo|get-?a?-?quote|registration|register|sign-?up|-reg\/?$|-form\/?$)/.test(p)) return { type: 'Form', confidence: 0.8, by: 'rule: url form/demo' };
  if (/(^|\/)(pricing|plans?|price)(-plan)?\/?$/.test(p)) return { type: 'Pricing', confidence: 0.85, by: 'rule: url pricing' };
  if (/(portal|login)/.test(p)) return { type: 'Portal', confidence: 0.7, by: 'rule: url portal' };
  if (/(^|\/)(lp|landing|campaign|ad|ads)(\/|-|$)|-ad-page|-ppa\/?$/.test(p)) return { type: 'Landing Page', confidence: 0.7, by: 'rule: url landing' };
  if (/(services?|solutions?|consulting|outsourcing|management|recruitment|training|payroll)/.test(p)) return { type: 'Service', confidence: 0.6, by: 'rule: url service keywords' };
  return { type: 'Other', confidence: 0.3, by: 'no rule matched' };
}

function classifyBySignals(sig, ruleResult) {
  if (!sig) return ruleResult;
  let cand = null;
  if (sig.jsonLd.some((t) => /^(Article|BlogPosting|NewsArticle)$/.test(t)) || sig.ogType === 'article') {
    cand = { type: 'Blog', confidence: 0.7, by: 'signal: article markup' };
  } else if (sig.jsonLd.includes('Event')) {
    cand = { type: 'Webinar', confidence: 0.65, by: 'signal: Event markup' };
  } else if (sig.jsonLd.includes('Product') || sig.jsonLd.includes('Offer')) {
    cand = { type: 'Pricing', confidence: 0.5, by: 'signal: Product markup' };
  } else if (ruleResult.type === 'Other' && sig.formCount > 0) {
    cand = { type: 'Form', confidence: 0.5, by: 'signal: page has a form' };
  }
  if (!cand) return ruleResult;
  // Agreement raises confidence; a signal only overrides a rule when it is more confident.
  if (cand.type === ruleResult.type) {
    return { ...ruleResult, confidence: Math.min(0.95, ruleResult.confidence + 0.1), by: ruleResult.by + ' + ' + cand.by };
  }
  return cand.confidence > ruleResult.confidence ? cand : ruleResult;
}

async function pageSignals(url) {
  try {
    const buf = await fetchBuf(url, 15000);
    const html = buf.subarray(0, 300000).toString('utf-8');
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const ogType = (html.match(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)/i) || [])[1];
    const jsonLd = [];
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const walk = (n) => { if (!n) return; if (Array.isArray(n)) return n.forEach(walk); if (typeof n === 'object') { if (n['@type']) [].concat(n['@type']).forEach((t) => jsonLd.push(String(t))); if (n['@graph']) walk(n['@graph']); } };
        walk(JSON.parse(m[1]));
      } catch (_) {}
    }
    const links = [];
    for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#][^"']*)["']/gi)) {
      const h = decodeXml(m[1].trim());
      if (/^(mailto:|tel:|javascript:|data:|sms:)/i.test(h)) continue;
      try { const u = new URL(h, url); if (/^https?:$/.test(u.protocol)) { u.hash = ''; links.push(u.toString()); } } catch (_) {}
    }
    return { title: title ? decodeXml(title.replace(/\s+/g, ' ').trim()) : '', ogType: (ogType || '').toLowerCase(), jsonLd, formCount: (html.match(/<form[\s>]/gi) || []).length, links };
  } catch (_) { return null; }
}

function slugName(path) {
  const seg = path.split('/').filter(Boolean).pop();
  if (!seg) return 'Home Page';
  return decodeURIComponent(seg).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
// "Page | Brand" or "Brand | Page": drop the part that is the brand, keep the page part.
function cleanTitle(t, brandWords) {
  if (!t) return '';
  const parts = t.split(/\s[|–—-]\s/).map((x) => x.trim()).filter(Boolean);
  const isBrand = (x) => brandWords.some((b) => b && x.toLowerCase().replace(/[^a-z0-9]/g, '').includes(b));
  const rest = parts.filter((x) => !isBrand(x));
  return (rest[0] || parts[0] || '').slice(0, 80);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Keep the home page and all non-bulk types; sample evenly from the biggest bulk type(s).
function applyCap(pages, cap) {
  if (pages.length <= cap) return { kept: pages, skipped: [] };
  const bulk = new Set(['Blog', 'Other']);
  const core = pages.filter((p) => !bulk.has(p.type));
  let kept;
  if (core.length >= cap) {
    kept = core.slice(0, cap);
  } else {
    const room = cap - core.length;
    const bulkPages = pages.filter((p) => bulk.has(p.type));
    const take = Math.min(room, bulkPages.length);
    const step = bulkPages.length / take;
    const pick = new Set();
    for (let k = 0; k < take; k++) pick.add(bulkPages[Math.floor(k * step)]);
    kept = [...core, ...pick];
  }
  const keptSet = new Set(kept);
  const order = new Map(pages.map((p, i) => [p, i]));
  kept.sort((a, b) => order.get(a) - order.get(b));
  return { kept, skipped: pages.filter((p) => !keptSet.has(p)) };
}

function estimate(pages, uniqueLinks) {
  const secs = SETUP_S + (pages / 4) * PAGE_S + (uniqueLinks / 12) * LINK_S;
  return { minutes: Math.round(secs / 60 * 10) / 10, low: Math.round(secs * 0.6 / 60 * 10) / 10, high: Math.round(secs * 1.6 / 60 * 10) / 10 };
}

async function main() {
  const state = { errors: [], children: 0 };
  let siteUrl = process.env.SITE_URL || '';
  const list = (process.env.PAGE_LIST || '').split(/[\s,]+/).filter(Boolean);
  let raw = []; // [{url, hint}]
  let source;

  let fileText = '';
  if (process.env.INPUT_FILE_URL) {
    try { fileText = await fetchText(process.env.INPUT_FILE_URL, 30000); }
    catch (e) { console.error('Could not read the uploaded file: ' + e.message); process.exit(2); }
  }

  if (fileText && /<(urlset|sitemapindex)/i.test(fileText)) {
    // Uploaded sitemap XML (or a sitemap index: follow its children).
    if (/<sitemapindex/i.test(fileText)) {
      for (const child of locs(fileText)) raw.push(...await collectSitemap(child, 1, state));
    } else {
      raw = locs(fileText).map((u) => ({ url: u, hint: '' }));
    }
    source = 'uploaded sitemap file';
  } else if (fileText || list.length) {
    const fromFile = fileText.split(/[\s,;]+/).filter((u) => /^https?:\/\//i.test(u));
    raw = [...fromFile, ...list].map((u) => ({ url: u, hint: '' }));
    source = fileText ? 'uploaded page list' : 'pasted page list';
  } else {
    let sitemaps = process.env.SITEMAP_URL ? [process.env.SITEMAP_URL] : [];
    if (!sitemaps.length && siteUrl) sitemaps = await discoverSitemaps(siteUrl);
    if (!sitemaps.length) { console.error('No sitemap given or found. Provide SITEMAP_URL, SITE_URL or PAGE_LIST.'); process.exit(2); }
    for (const s of sitemaps) raw.push(...await collectSitemap(s, 0, state));
    source = 'sitemap: ' + sitemaps.join(', ');
  }

  const first = raw.map((r) => normalizeUrl(r.url)).find(Boolean);
  if (!first) { console.error('No usable URLs found. ' + state.errors.join('; ')); process.exit(2); }
  const base = siteUrl ? new URL(siteUrl).origin : first.origin;
  const baseHost = new URL(base).host.replace(/^www\./, '');

  const seen = new Set();
  const pages = [];
  let offHost = 0;
  for (const r of raw) {
    const u = normalizeUrl(r.url);
    if (!u) continue;
    if (u.host.replace(/^www\./, '') !== baseHost) { offHost++; continue; }
    const key = u.origin + u.pathname.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push({ url: u, path: u.pathname || '/', hint: r.hint });
  }
  const totalFound = pages.length;

  for (const p of pages) Object.assign(p, classifyByRules(p.path, p.hint));
  const { kept, skipped } = applyCap(pages, MAX_PAGES);

  if (process.env.NO_FETCH !== '1') {
    await pool(kept, 8, async (p) => {
      p.sig = await pageSignals(new URL(p.path, base).toString());
      Object.assign(p, classifyBySignals(p.sig, p));
    });
  }

  // Link counts + time estimate, from the HTML we already downloaded.
  const sighted = [];
  let fetchFailed = 0;
  for (const p of kept) { if (p.sig) sighted.push(...p.sig.links); else fetchFailed++; }
  const uniq = new Set(sighted);
  const isInternal = (u) => { try { return new URL(u).host.replace(/^www\./, '') === baseHost; } catch (_) { return false; } };
  const uniqInternal = [...uniq].filter(isInternal).length;
  const noFetch = process.env.NO_FETCH === '1';
  const est = estimate(kept.length, uniq.size);
  const siteName = process.env.SITE_NAME || baseHost;
  const brandWords = [siteName, baseHost.split('.')[0]].map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((x) => x.length > 2);
  const config = {
    sites: [{
      name: siteName,
      base_url: base,
      pages: kept.map((p) => {
        const isFormish = p.type === 'Form' && !/request-?demo|book-?a?-?demo/.test(p.path.toLowerCase());
        return {
          path: p.path,
          name: (p.sig && cleanTitle(p.sig.title, brandWords)) || slugName(p.path),
          page_type: p.type,
          // Only obvious cases expect a lead form; booking-link checks are never inferred.
          expects_lead_form: isFormish || !!p.contact,
          type_confidence: Math.round(p.confidence * 100) / 100,
          classified_by: p.by,
        };
      }),
    }],
  };
  fs.writeFileSync('config.json', JSON.stringify(config, null, 2));

  const byType = {};
  for (const p of kept) byType[p.type] = (byType[p.type] || 0) + 1;
  const lowConf = kept.filter((p) => p.confidence < 0.6).length;
  const summary = {
    site: siteName, source, found: totalFound, checked: kept.length, cap: MAX_PAGES, cap_clamped: CAP_CLAMPED, cap_ceiling: CEILING,
    skipped_by_cap: skipped.length, off_host_ignored: offHost, low_confidence_pages: lowConf, by_type: byType, errors: state.errors,
    est_link_sightings: noFetch ? null : sighted.length, est_unique_links: noFetch ? null : uniq.size,
    est_unique_internal: noFetch ? null : uniqInternal, est_unique_external: noFetch ? null : uniq.size - uniqInternal,
    pages_not_fetched: fetchFailed,
    est_minutes: est.minutes, est_minutes_low: est.low, est_minutes_high: est.high,
    est_note: 'Counted from raw page HTML; links added by JavaScript are not counted, so real numbers can be higher.',
  };
  if (skipped.length) summary.hint = `${skipped.length} more pages exist. Re-run with a higher max pages (limit ${CEILING}) to include them.`;
  if (est.high > MAX_RUNTIME_MIN) {
    summary.blocked = true;
    summary.message = `Not run: estimated ${est.minutes} min (up to ${est.high}) exceeds the ${MAX_RUNTIME_MIN} min limit for ${kept.length} pages / ~${uniq.size} unique links. Lower max pages and try again.`;
  }
  fs.writeFileSync('build_summary.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.blocked) process.exit(3);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { estimate, classifyByRules, classifyBySignals, applyCap, locs, normalizeUrl, slugName };
