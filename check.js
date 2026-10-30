// site-checker/check.js
//
// For every page in config.json:
// - loads the page, records HTTP status
// - flags broken assets (images/css/js/fonts returning 4xx/5xx)
// - flags images that return 200 but fail to actually render (naturalWidth=0
//   — a corrupt file, wrong format, etc. — a pure status-code check misses this)
// - flags console/JS errors
// - if expects_lead_form: checks a form is present and visible (READ ONLY —
//   never fills in or submits it, so it can never create a fake lead)
// - if expects_calendly: checks a Calendly booking link/embed is present
//   (some landing pages use a Calendly link instead of a lead form)
// - collects every link/CTA on the page
//
// Then, for every unique link found across the whole crawl:
// - internal links: loads the destination, records status + page title
//   (title lets you eyeball whether a CTA landed on the *right* page,
//   not just *a* page — a retired page can still return 200)
// - external links: lightweight HEAD/GET check, status only (no full
//   render — keeps runtime sane when there are many outbound links)
//
// Every issue found (page-level or link-level) is tagged with a standardized
// category code, a severity, and a suggested fix — see ISSUE_CATALOG below.
// This is what makes the report traceable: instead of free-text messages,
// every row can be filtered/sorted by Category or Severity, and comes with
// a concrete next step.
//
// Every row also carries a Page URL — the actual link to the page the issue
// is on, so you can click straight to it. For a broken link/CTA, that's
// separate from the broken destination itself (shown in "Where"/"Destination
// URL") — the report gives you both ends: the page it's on, and the URL it's
// pointing to.
//
// For issues that are tied to one specific element on the page (a broken
// image, a broken link, a hidden lead form, etc.), the report also captures:
//   - a plain-language Page Location, e.g. "Footer, under 'Quick Links'"
//     or "Top navigation bar" — so you don't have to hunt for it visually.
//   - a short Relevant Code snippet — the actual HTML tag involved (e.g.
//     the <img> with the broken src, the <a> with the dead link) — so
//     whoever fixes it doesn't have to go find it in the page source first.
// Page-level issues that aren't tied to one element (page failed to load,
// console error, missing Calendly link, etc.) leave these two columns
// blank — there's no single tag to point at.
//
// Page crawls and link-destination checks both run with bounded concurrency
// (not fully sequential, not unlimited) — see runPool() below — to keep the
// total run time reasonable without hammering the target sites hard enough
// to trigger rate-limiting.
//
// Output: report.json, summary.md, and Website_Health_Report_<date>_<time>.xlsx (Pakistan time)
//
// This script always exits 0. Finding site issues is the expected, useful
// output of a health check — it is not a failure of the automation itself.
// Only an uncaught crash (a real bug in this script, or something like the
// browser failing to launch) should fail the GitHub Actions job.
//
// Run: node check.js
// Requires: npm install && npx playwright install chromium

const { chromium } = require('playwright');
const fs = require('fs');
const ExcelJS = require('exceljs');

const config = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH || './config.json', 'utf-8'));
const RUN_START = Date.now();

// Date/time stamp used in the report filename and inside the report
// (Excel Summary sheet + report header), e.g.
// Website_Health_Report_2026-08-12_14-30-00.xlsx — computed once here,
// in Pakistan time (Asia/Karachi), and reused everywhere so every run's
// report has its own name and you never have to rename/overwrite the
// previous one by hand.
function pakistanTimestamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    fileTime: `${get('hour')}-${get('minute')}-${get('second')}`,
    displayTime: `${get('hour')}:${get('minute')}:${get('second')} PKT`,
  };
}
const REPORT_TS = pakistanTimestamp();
const REPORT_DATE = REPORT_TS.date;
const REPORT_FILENAME = `Website_Health_Report_${REPORT_TS.date}_${REPORT_TS.fileTime}.xlsx`;

// ---------------------------------------------------------------------------
// Small bounded-concurrency pool. Runs `worker` over every item in `items`,
// never more than `limit` at a time. Keeps runtime sane (vs. one-at-a-time)
// without firing everything at once (which risks tripping rate-limiting on
// the target sites).
// ---------------------------------------------------------------------------
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Issue taxonomy — every issue anywhere in this report carries one of these
// codes. Keep codes stable across runs so filtering/sorting stays useful
// over time (e.g. in a spreadsheet pivot, or when diffing two reports).
// ---------------------------------------------------------------------------
const ISSUE_CATALOG = {
  PAGE_LOAD_FAILED: {
    severity: 'Critical',
    label: 'Page failed to load',
    fix: 'Confirm the URL is reachable and DNS is resolving; check hosting/server status.',
  },
  PAGE_HTTP_ERROR: {
    severity: 'Critical',
    label: 'Page returned an error status',
    fix: 'Check server logs or the redirect chain; confirm the page still exists at this path.',
  },
  BROKEN_ASSET: {
    severity: 'Medium',
    label: 'Broken asset (bad HTTP status)',
    fix: 'Re-upload or fix the asset path; check CDN/theme configuration for this file.',
  },
  IMAGE_RENDER_FAIL: {
    severity: 'Medium',
    label: 'Image returned OK but failed to render',
    fix: 'Re-export/re-upload the image — the file is likely corrupt or in an unsupported format.',
  },
  CONSOLE_ERROR: {
    severity: 'Low',
    label: 'JavaScript console error',
    fix: 'Open the page with browser DevTools open and resolve the script error shown.',
  },
  LEAD_FORM_MISSING: {
    severity: 'High',
    label: 'Expected lead form not found',
    fix: 'Add the lead-capture form back to this page — likely removed by a template/theme change.',
  },
  LEAD_FORM_HIDDEN: {
    severity: 'High',
    label: 'Lead form present but not visible',
    fix: 'Inspect CSS on this page — the form may be hidden by display:none or a style/JS conflict.',
  },
  LEAD_FORM_CHECK_ERROR: {
    severity: 'Low',
    label: 'Could not check for a lead form',
    fix: 'Re-run the check — the page may have timed out or errored before the form could be evaluated.',
  },
  CALENDLY_LINK_MISSING: {
    severity: 'High',
    label: 'Expected Calendly booking link not found',
    fix: 'Add the Calendly link/embed back to this page — likely removed by a template/content change.',
  },
  CALENDLY_CHECK_ERROR: {
    severity: 'Low',
    label: 'Could not check for a Calendly link',
    fix: 'Re-run the check — the page may have timed out or errored before the Calendly link could be evaluated.',
  },
  LINK_DNS_FAILURE: {
    severity: 'Critical',
    label: 'Destination domain does not resolve',
    fix: 'Check DNS records and domain registration/expiry for this domain — the site may be down.',
  },
  LINK_HTTP_4XX: {
    severity: 'Medium',
    label: 'Broken link — client error',
    fix: 'Destination page is missing or access-restricted — fix the link or restore the page.',
  },
  LINK_HTTP_5XX: {
    severity: 'High',
    label: 'Broken link — server error',
    fix: 'Destination server is erroring — check hosting/server health for that domain.',
  },
  LINK_LOAD_ERROR: {
    severity: 'Medium',
    label: 'Failed to load destination',
    fix: 'Destination timed out or refused the connection — retest manually; may be a transient issue.',
  },
  MALFORMED_LINK: {
    severity: 'Medium',
    label: 'Link could not be parsed as a valid URL',
    fix: 'Fix the href — likely missing a "tel:"/"mailto:" prefix, or contains a stray space/invalid character.',
  },
};

const SEVERITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const SEVERITY_COLOR = {
  Critical: 'FFF8D7DA', // red
  High: 'FFFCE8D6', // orange
  Medium: 'FFFFF3CD', // yellow
  Low: 'FFE2E3E5', // grey
};

function issue(code, message, extra) {
  const meta = ISSUE_CATALOG[code];
  if (!meta) throw new Error(`Unknown issue code: ${code}`);
  return { code, severity: meta.severity, label: meta.label, fix: meta.fix, message, ...extra };
}

function worstSeverity(issues) {
  if (!issues.length) return null;
  return issues.reduce((worst, i) => (SEVERITY_ORDER[i.severity] < SEVERITY_ORDER[worst] ? i.severity : worst), 'Low');
}

const pageResults = []; // per-page health
const linkSightings = []; // every link found: {site, sourcePage, sourcePath, pageType, text, url, html, location}
const linkDestCache = new Map(); // url -> {status, title, error}

function isSameHost(url, base) {
  try {
    return new URL(url).host === new URL(base).host;
  } catch {
    return false;
  }
}

// Domains confirmed (by a human checking manually) to block automated
// checkers with a 403 even though the page works fine for real visitors.
// Add to this list as more of these get confirmed — do NOT add a domain here
// just because it 403s once; confirm manually first, since a 403 can also
// mean genuinely broken/access-restricted content.
const KNOWN_BOT_BLOCKING_HOSTS = [
  'privacypolicyonline.com',
];
function hostMatches(url, host) {
  try {
    const h = new URL(url).host.replace(/^www\./, '');
    return h === host || h.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

function classifyLinkIssue(status, error, url) {
  if (error) {
    if (/ERR_NAME_NOT_RESOLVED/.test(error)) return 'LINK_DNS_FAILURE';
    return 'LINK_LOAD_ERROR';
  }
  if (status == null) return 'LINK_LOAD_ERROR';
  // A 429 means the target is rate-limiting automated requests, not that the
  // link is broken — never worth reporting as an issue at all.
  if (status === 429) return null;
  // 999 is a known anti-scraping status (LinkedIn uses it deliberately
  // against automated/headless traffic) — not a real server error, and not
  // worth reporting: it never indicates the link is actually broken.
  if (status === 999) return null;
  // A handful of specific domains are confirmed to 403 automated checks
  // while working fine for humans — treat those 403s the same way. Any
  // other domain's 403 still gets reported (could be genuinely broken).
  if (status === 403 && url && KNOWN_BOT_BLOCKING_HOSTS.some((h) => hostMatches(url, h))) return null;
  if (status >= 500) return 'LINK_HTTP_5XX';
  if (status >= 400) return 'LINK_HTTP_4XX';
  return null; // no issue
}

// File extensions that trigger a browser *download* rather than a normal
// navigation. A full page.goto() on one of these makes Playwright throw
// ("Download is starting") even though the file downloads perfectly fine for
// a real visitor — so these are checked the lightweight way (a plain HTTP
// request, like external links) instead of a full render.
const DOWNLOADABLE_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|mp3|mp4|mov|dmg|exe)(\?.*)?$/i;
function isDownloadableFile(url) {
  try {
    return DOWNLOADABLE_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Injected into every page this script visits (re-injected automatically on
// every navigation via addInitScript). Gives us two helpers inside the
// browser context so every DOM-level check below can attach a plain-language
// location and a short HTML snippet to the element it's flagging, instead of
// just a bare URL.
// ---------------------------------------------------------------------------
async function injectLocationHelpers(page) {
  await page.addInitScript(() => {
    window.__locateElement = function (el) {
      if (!el) return '';
      const landmarkTags = { header: 'Header', nav: 'Navigation menu', footer: 'Footer', aside: 'Sidebar', main: 'Main content area' };
      let landmark = 'Main content area';
      let node = el;
      while (node && node !== document.body) {
        const tag = node.tagName ? node.tagName.toLowerCase() : '';
        if (landmarkTags[tag]) { landmark = landmarkTags[tag]; break; }
        node = node.parentElement;
      }
      // Nearest heading (h1-h4) that appears before this element in the page
      // — gives a plain-English anchor like "under 'Our Services'" so
      // non-technical readers can find the spot without reading code.
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'));
      let nearest = null;
      for (const h of headings) {
        if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
          nearest = h.innerText.trim().slice(0, 60);
        } else {
          break;
        }
      }
      return nearest ? `${landmark}, under "${nearest}"` : landmark;
    };
    window.__snippetOf = function (el) {
      if (!el) return '';
      let html = el.outerHTML || '';
      if (html.length > 300) html = html.slice(0, 300) + '…';
      return html;
    };
  });
}

async function crawlPage(browser, site, pageConfig) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await injectLocationHelpers(page);
  const pageUrl = new URL(pageConfig.path, site.base_url).toString();
  const pageType = pageConfig.page_type || 'Other';
  const issues = [];
  const brokenAssets = [];
  const consoleErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  page.on('response', (response) => {
    const status = response.status();
    const resourceType = response.request().resourceType();
    if (status >= 400 && ['image', 'stylesheet', 'script', 'font'].includes(resourceType)) {
      brokenAssets.push({ url: response.url(), status, type: resourceType });
    }
  });

  let mainStatus = null;
  try {
    // 'domcontentloaded' is the gate for pass/fail — it fires as soon as the
    // HTML is parsed, so it doesn't hang on continuous background network
    // chatter (chat widgets, analytics beacons, ad pixels) the way
    // 'networkidle' can, and doesn't compound under crawl concurrency the
    // way waiting for the full 'load' event (all images/fonts) did.
    const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    mainStatus = resp ? resp.status() : null;
    // Best-effort extra wait for the full load event (images etc.) so the
    // broken-image-render check below has something to check — but this is
    // NOT allowed to fail the page; if it doesn't finish in time we just
    // check whatever rendered so far.
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    // Trigger lazy-loaded content (images with loading="lazy", scroll-reveal
    // forms/sections) before any checks below run. A headless crawl never
    // scrolls on its own, so without this, anything gated on scroll position
    // reads as "missing"/"broken" even though a real visitor scrolling down
    // the page would never see a problem. A single scroll-to-bottom-and-back
    // is enough to satisfy most lazy-load/IntersectionObserver triggers.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(300);
  } catch (e) {
    issues.push(issue('PAGE_LOAD_FAILED', `Page failed to load: ${e.message}`));
    await context.close();
    return {
      site: site.name, page: pageConfig.name, path: pageConfig.path, url: pageUrl, pageType,
      status: null, issues, broken_assets: [], console_errors: [], broken_images_rendered: [], ctaCount: 0,
    };
  }

  if (mainStatus && mainStatus >= 400) {
    issues.push(issue('PAGE_HTTP_ERROR', `Page returned HTTP ${mainStatus}`));
  }

  // Broken assets (images/css/js/fonts with a bad HTTP status) — match each
  // one back to the actual tag on the page (where possible) so the report
  // shows the element and where it sits, not just the request URL.
  const brokenAssetDetails = await page.evaluate((assets) => {
    return assets.map((a) => {
      let el = null;
      if (a.type === 'image') {
        el = Array.from(document.images).find((img) => img.src === a.url || img.currentSrc === a.url);
      } else if (a.type === 'script') {
        el = Array.from(document.scripts).find((s) => s.src === a.url);
      } else if (a.type === 'stylesheet') {
        el = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((l) => l.href === a.url);
      }
      if (!el) {
        return { ...a, location: "Referenced in the page's code (not a directly visible element, e.g. a font or background image)", html: '' };
      }
      return { ...a, location: window.__locateElement(el), html: window.__snippetOf(el) };
    });
  }, brokenAssets).catch(() => brokenAssets.map((a) => ({ ...a, location: '', html: '' })));

  if (brokenAssetDetails.length) {
    const first = brokenAssetDetails[0];
    const extraNote = brokenAssetDetails.length > 1 ? ` (+${brokenAssetDetails.length - 1} more — see "Broken Media" tab)` : '';
    issues.push(issue(
      'BROKEN_ASSET',
      `${brokenAssetDetails.length} broken asset(s) (bad HTTP status): ${brokenAssetDetails.map(a => `${a.type} ${a.url} (${a.status})`).join('; ')}${extraNote}`,
      { location: first.location, elementHtml: first.html || undefined },
    ));
  }
  // Filter out console errors that are known noise rather than real problems:
  //   - Chrome's exact generic form "Failed to load resource: the server
  //     responded with a status of NNN ()" with no URL attached. Chrome only
  //     strips the URL like this for CROSS-ORIGIN resource failures (a CORS
  //     privacy restriction) — same-origin failures always include the URL.
  //     So this exact bare pattern is by definition about a third-party
  //     resource, never your own page's content, and safe to ignore anywhere.
  //   - requestStorageAccess permission-denied messages — a browser same-site
  //     cookie API notice thrown by third-party iframes/embeds, not a bug.
  //   - Anything naming bookings.cloud.microsoft — noise from the Outlook
  //     Bookings widget (used intentionally on pages like Request Demo).
  //   - "%c%d ... NaN" — a known artifact of how some analytics/tag-manager
  //     scripts format their own console output; not an error in your page.
  const BENIGN_CONSOLE_PATTERNS = [
    /^Failed to load resource: the server responded with a status of \d+ \(\)$/,
    /requestStorageAccess/i,
    /bookings\.cloud\.microsoft/i,
    /%c%d/,
  ];
  const realConsoleErrors = consoleErrors.filter((msg) => !BENIGN_CONSOLE_PATTERNS.some((rx) => rx.test(msg)));
  if (realConsoleErrors.length) {
    issues.push(issue(
      'CONSOLE_ERROR',
      `${realConsoleErrors.length} console error(s): ${realConsoleErrors.slice(0, 3).join(' | ')}`,
    ));
  }

  // Images that returned 200 but didn't actually render (corrupt/wrong format/etc.)
  // Only counts elements that are actually visible on screen — an <img> that
  // is display:none / visibility:hidden / zero-size (e.g. a duplicate logo
  // swapped in only at a different breakpoint, or an off-canvas menu clone)
  // was never going to be seen by a visitor either way, so naturalWidth===0
  // on it isn't a real defect. Also covers CSS background-images referenced
  // via inline style or a stylesheet, which the plain <img> check misses
  // entirely (the earlier PPW-logo false positive was one of these).
  const brokenImagesRendered = await page.evaluate(async () => {
    function isVisible(el) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    const results = Array.from(document.querySelectorAll('img'))
      .filter(img => img.src && img.naturalWidth === 0 && isVisible(img))
      .map(img => ({ url: img.src, location: window.__locateElement(img), html: window.__snippetOf(img) }));

    // CSS background-image url() checks: probe each unique visible
    // background-image URL with a fresh Image() and see if it actually loads.
    const bgUrls = new Map(); // url -> first element with it
    for (const el of document.querySelectorAll('*')) {
      if (!isVisible(el)) continue;
      const bg = getComputedStyle(el).backgroundImage;
      const match = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (match && !bgUrls.has(match[1])) bgUrls.set(match[1], el);
    }
    const bgChecks = await Promise.all(Array.from(bgUrls.entries()).map(([url, el]) => new Promise((resolve) => {
      const img = new Image();
      const done = (ok) => resolve(ok ? null : { url, location: window.__locateElement(el), html: window.__snippetOf(el) });
      img.onload = () => done(img.naturalWidth > 0);
      img.onerror = () => done(false);
      img.src = url;
      setTimeout(() => done(false), 8000); // don't hang the whole crawl on one stuck background image
    })));
    return results.concat(bgChecks.filter(Boolean));
  }).catch(() => []);
  if (brokenImagesRendered.length) {
    const first = brokenImagesRendered[0];
    const extraNote = brokenImagesRendered.length > 1 ? ` (+${brokenImagesRendered.length - 1} more — see "Broken Media" tab)` : '';
    issues.push(issue(
      'IMAGE_RENDER_FAIL',
      `${brokenImagesRendered.length} image(s) returned OK but failed to render: ${brokenImagesRendered.map(i => i.url).join(', ')}${extraNote}`,
      { location: first.location, elementHtml: first.html || undefined },
    ));
  }

  // Lead form presence — read only, never submits.
  // Two allowances for false positives seen in practice: (1) some forms are
  // lazy-rendered after the initial DOM settles, so we give the page a brief
  // scroll + wait before concluding a form is really missing; (2) some forms
  // live inside an iframe (a hosted form builder), which page.locator only
  // searches in the main frame by default — so we also check every frame.
  if (pageConfig.expects_lead_form) {
    try {
      // (Lazy-loaded content has already been nudged into view once, right
      // after page load — see the scroll-to-bottom-and-back above.)
      let formCount = await page.locator('form').count();
      let formsInFrames = 0;
      if (formCount === 0) {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          formsInFrames += await frame.locator('form').count().catch(() => 0);
        }
      }
      if (formCount === 0 && formsInFrames === 0) {
        issues.push(issue('LEAD_FORM_MISSING', 'Expected a lead form on this page, but no <form> element was found (checked main frame, all iframes, and after a scroll/wait for lazy-loaded content)'));
      } else if (formCount > 0) {
        const formLocator = page.locator('form').first();
        const visible = await formLocator.isVisible().catch(() => false);
        if (!visible) {
          const formHandle = await formLocator.elementHandle().catch(() => null);
          let formLoc = '';
          let formHtml = '';
          if (formHandle) {
            formLoc = await page.evaluate((el) => window.__locateElement(el), formHandle).catch(() => '');
            formHtml = await page.evaluate((el) => window.__snippetOf(el), formHandle).catch(() => '');
          }
          issues.push(issue('LEAD_FORM_HIDDEN', 'Lead form exists but is not visible (possibly hidden/broken CSS)', { location: formLoc, elementHtml: formHtml || undefined }));
        }
      }
      // else: form only found inside an iframe — present and out of our
      // reach to render-check further, so no issue is raised.
    } catch (e) {
      issues.push(issue('LEAD_FORM_CHECK_ERROR', `Could not check for lead form: ${e.message}`));
    }
  }

  // Booking-widget link presence — read only, never opens/books anything.
  // Some landing pages use a scheduling widget instead of a lead form as
  // their conversion point — originally just Calendly, now also Microsoft/
  // Outlook Bookings (bookings.cloud.microsoft, outlook.office.com/bookings),
  // since at least one page (Request Demo) intentionally uses that instead.
  if (pageConfig.expects_calendly) {
    try {
      const hasBookingWidget = await page.evaluate(() => {
        const pattern = /calendly\.com|bookings\.cloud\.microsoft|outlook\.office(365)?\.com\/(book|owa\/calendar)/i;
        const links = Array.from(document.querySelectorAll('a[href]'))
          .some(a => pattern.test(a.getAttribute('href') || ''));
        const iframes = Array.from(document.querySelectorAll('iframe[src]'))
          .some(f => pattern.test(f.getAttribute('src') || ''));
        const inlineWidget = !!document.querySelector('[class*="calendly"], [id*="calendly"], [class*="booking"], [id*="booking"]');
        return links || iframes || inlineWidget;
      }).catch(() => false);
      if (!hasBookingWidget) {
        issues.push(issue('CALENDLY_LINK_MISSING', 'Expected a booking link/embed (Calendly or Outlook/Microsoft Bookings) on this page, but none was found'));
      }
    } catch (e) {
      issues.push(issue('CALENDLY_CHECK_ERROR', `Could not check for a booking link: ${e.message}`));
    }
  }

  // Collect every link/CTA on the page — including its own HTML snippet and
  // plain-language location, so if it turns out to be broken (checked in
  // Pass 2, below) the report can point straight at where it lives.
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]')).map(a => ({
      text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80) || '(no text)',
      href: a.getAttribute('href'),
      html: window.__snippetOf(a),
      location: window.__locateElement(a),
    }));
  }).catch(() => []);

  let ctaCount = 0;
  for (const link of links) {
    if (!link.href || link.href.startsWith('#') || link.href.startsWith('mailto:') || link.href.startsWith('tel:') || link.href.startsWith('javascript:')) {
      continue;
    }
    let absoluteUrl;
    try {
      absoluteUrl = new URL(link.href, pageUrl).toString();
    } catch {
      // href couldn't be parsed as a URL at all (e.g. a phone number typed
      // as "http://+000-000-0000" with a space, or some other malformed
      // value) — previously this was silently dropped, meaning a genuinely
      // broken link never showed up anywhere in the report. Flag it instead.
      issues.push(issue(
        'MALFORMED_LINK',
        `Link "${link.text}" has an href that could not be parsed as a URL: "${link.href}"`,
        { location: link.location, elementHtml: link.html || undefined },
      ));
      continue;
    }
    ctaCount++;
    linkSightings.push({
      site: site.name,
      sourcePage: pageConfig.name,
      sourcePath: pageConfig.path,
      sourceUrl: pageUrl, // the actual URL of the page this link sits on
      pageType,
      text: link.text,
      url: absoluteUrl,
      html: link.html,
      location: link.location,
    });
  }

  await context.close();

  return {
    site: site.name,
    page: pageConfig.name,
    path: pageConfig.path,
    url: pageUrl,
    pageType,
    status: mainStatus,
    issues,
    broken_assets: brokenAssetDetails,
    console_errors: consoleErrors,
    broken_images_rendered: brokenImagesRendered,
    ctaCount,
    typeConfidence: pageConfig.type_confidence,
    classifiedBy: pageConfig.classified_by,
  };
}

async function checkDestinationOnce(browser, url) {
  // Full render so we can read the title (needed to spot soft-404s /
  // wrong-page landings, which a status code alone won't catch)
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const status = resp ? resp.status() : null;
    const title = await page.title().catch(() => '');
    return { status, title, error: null };
  } catch (e) {
    return { status: null, title: null, error: e.message };
  } finally {
    await context.close();
  }
}

async function checkDestination(browser, url, base) {
  if (linkDestCache.has(url)) return linkDestCache.get(url);

  let result;
  if (isDownloadableFile(url)) {
    // A page.goto() on a PDF/DOCX/ZIP/etc. makes the browser start a file
    // download instead of navigating, which Playwright reports as a failed
    // navigation ("Download is starting") even though the file is perfectly
    // fine for a real visitor. Check these the lightweight way instead —
    // status code only, same as an external link — regardless of host.
    const context = await browser.newContext();
    try {
      const resp = await context.request.get(url, { timeout: 15000, failOnStatusCode: false });
      result = { status: resp.status(), title: '(downloadable file — not rendered)', error: null };
    } catch (e) {
      result = { status: null, title: null, error: e.message };
    } finally {
      await context.close();
    }
  } else if (isSameHost(url, base)) {
    // Internal link: full render, with a couple of retries before treating a
    // timeout/load failure as real. Occasional single-attempt timeouts are
    // common under concurrent crawling (heavy pages, transient CDN/bot-check
    // hiccups) even when the page loads fine for a normal visitor — retrying
    // once or twice before flagging avoids reporting those as broken.
    const attempts = 3;
    for (let i = 0; i < attempts; i++) {
      result = await checkDestinationOnce(browser, url);
      if (result.status != null && result.status < 400) break; // success, stop retrying
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000)); // brief backoff
    }
  } else {
    // External link: lightweight request, status only
    const context = await browser.newContext();
    try {
      const resp = await context.request.get(url, { timeout: 15000, failOnStatusCode: false });
      result = { status: resp.status(), title: null, error: null };
    } catch (e) {
      result = { status: null, title: null, error: e.message };
    } finally {
      await context.close();
    }
  }
  linkDestCache.set(url, result);
  return result;
}

// ---------------------------------------------------------------------------
// Collapse site-wide issues (the same broken element sitting in a header,
// footer, or nav bar that's shared across every page) down to a single row.
// A template element is broken once — reporting it 20+ times, once per page
// it happens to appear on, exaggerates the real scope of the problem and
// buries genuinely page-specific issues in the same list. Only issues whose
// Page Location names a shared landmark (Header/Footer/Navigation menu) are
// eligible; ordinary page-specific issues are left exactly as-is.
// ---------------------------------------------------------------------------
const SITE_WIDE_LANDMARK = /^(Header|Footer|Navigation menu)\b/;

function dedupeSiteWideIssues(rows) {
  const groups = new Map(); // groupKey -> rows[]
  const passthrough = [];
  for (const row of rows) {
    if (!row.location || !SITE_WIDE_LANDMARK.test(row.location)) {
      passthrough.push(row);
      continue;
    }
    const identity = (row.elementHtml && row.elementHtml.trim()) || row.where || row.message;
    const key = `${row.site}||${row.code}||${identity}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const collapsed = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      collapsed.push(group[0]);
      continue;
    }
    // Prefer to attribute the single surviving row to the Home Page, if it's
    // one of the affected pages, so the report points somewhere predictable.
    const homeIdx = group.findIndex((r) => /home/i.test(r.page || ''));
    const canonical = { ...group[homeIdx >= 0 ? homeIdx : 0] };
    const otherPages = group
      .filter((r) => r !== group[homeIdx >= 0 ? homeIdx : 0])
      .map((r) => r.page);
    const shown = otherPages.slice(0, 5).join(', ') + (otherPages.length > 5 ? ', …' : '');
    canonical.message = `${canonical.message} [Same element sits in the site-wide ${canonical.location.split(',')[0]} — also appears on ${otherPages.length} other page(s): ${shown}]`;
    collapsed.push(canonical);
  }
  return passthrough.concat(collapsed);
}

// ---------------------------------------------------------------------------
// Excel report
// ---------------------------------------------------------------------------

function styleHeaderRow(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF33475B' } };
  row.alignment = { vertical: 'middle' };
}

function fillSeverity(cell, severity) {
  if (!severity) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SEVERITY_COLOR[severity] || 'FFFFFFFF' } };
}

async function writeExcelReport(pageResults, linkRows, allIssueRows) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(0); // deterministic; the run timestamp is in the Summary sheet text instead

  const totalPages = pageResults.length;
  const totalLinks = linkRows.length;
  // NOTE: was `l.category` (a field that doesn't exist on link rows — they
  // carry `code`), which meant this was always an empty array and silently
  // undercounted every broken link in the per-site rollup below. Fixed.
  const brokenLinks = linkRows.filter(l => l.code);
  const severityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const row of allIssueRows) severityCounts[row.severity] = (severityCounts[row.severity] || 0) + 1;

  // --- Sheet 1: Summary ---
  const wsSummary = wb.addWorksheet('Summary');
  wsSummary.columns = [{ width: 28 }, { width: 60 }];
  wsSummary.addRow(['Site Health Report', '']).font = { bold: true, size: 14 };
  wsSummary.addRow(['Generated', REPORT_TS.displayTime + ' on ' + REPORT_TS.date]);
  wsSummary.addRow(['Pages checked', totalPages]);
  wsSummary.addRow(['Links/CTAs checked', totalLinks]);
  wsSummary.addRow(['Broken links/CTAs', brokenLinks.length]);
  wsSummary.addRow([]);
  const sevHeaderRow = wsSummary.addRow(['Issues by severity', 'Count']);
  styleHeaderRow(sevHeaderRow);
  for (const sev of ['Critical', 'High', 'Medium', 'Low']) {
    const r = wsSummary.addRow([sev, severityCounts[sev] || 0]);
    fillSeverity(r.getCell(1), sev);
  }
  wsSummary.addRow([]);
  const bySiteHeader = wsSummary.addRow(['Site', 'Pages', 'Issues found']);
  styleHeaderRow(bySiteHeader);
  const siteNames = [...new Set(pageResults.map(r => r.site))];
  for (const site of siteNames) {
    const sitePages = pageResults.filter(r => r.site === site);
    const siteIssueCount = sitePages.reduce((n, r) => n + r.issues.length, 0)
      + brokenLinks.filter(l => l.site === site).length;
    wsSummary.addRow([site, sitePages.length, siteIssueCount]);
  }
  wsSummary.addRow([]);
  wsSummary.addRow(['How to read this report']).font = { bold: true };
  wsSummary.addRow(['Every issue anywhere in this workbook has a standardized Category, a Severity, and a']);
  wsSummary.addRow(['Suggested Fix — sort/filter the "All Issues" tab by either to triage. "Page URL" is the actual']);
  wsSummary.addRow(['page the issue is on (click straight to it); for a broken link, "Where" is the broken link\'s own']);
  wsSummary.addRow(['destination, not the page. Where an issue is tied to one specific element, "Page Location" says']);
  wsSummary.addRow(['where on the page it sits (in plain language) and "Relevant Code" shows the actual HTML tag']);
  wsSummary.addRow(['involved. The "Links & CTAs" tab is grouped by source page (use the outline +/- on the left']);
  wsSummary.addRow(['margin to expand a page and see every CTA on it) and includes that page\'s own URL too.']);
  wsSummary.addRow(['If the same broken element lives in a shared header/footer/nav bar (so it would otherwise']);
  wsSummary.addRow(['show up once per page), "All Issues" collapses it to a single row and names the other pages']);
  wsSummary.addRow(['it also appears on, so a template-wide problem isn\'t overcounted as many separate failures.']);

  // --- Sheet 2: All Issues — one row per issue, across pages, links, and media ---
  const wsAll = wb.addWorksheet('All Issues');
  wsAll.columns = [
    { header: 'Severity', key: 'severity', width: 12 },
    { header: 'Category', key: 'code', width: 22 },
    { header: 'Site', key: 'site', width: 18 },
    { header: 'Page', key: 'page', width: 28 },
    { header: 'Page Type', key: 'pageType', width: 16 },
    { header: 'Page URL', key: 'pageUrl', width: 45 },
    { header: 'Page Location', key: 'location', width: 32 },
    { header: 'Where', key: 'where', width: 45 },
    { header: 'Details', key: 'message', width: 60 },
    { header: 'Relevant Code', key: 'elementHtml', width: 55 },
    { header: 'Suggested Fix', key: 'fix', width: 55 },
  ];
  styleHeaderRow(wsAll.getRow(1));
  wsAll.views = [{ state: 'frozen', ySplit: 1 }];
  const sortedIssues = [...allIssueRows].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  for (const row of sortedIssues) {
    const r = wsAll.addRow(row);
    fillSeverity(r.getCell('severity'), row.severity);
  }
  wsAll.autoFilter = { from: 'A1', to: 'K1' };

  // --- Sheet 3: Page Health — one row per page ---
  const wsPages = wb.addWorksheet('Page Health');
  wsPages.columns = [
    { header: 'Site', key: 'site', width: 20 },
    { header: 'Page', key: 'page', width: 30 },
    { header: 'Page Type', key: 'pageType', width: 16 },
    { header: 'Type Confidence', key: 'typeConfidence', width: 16 },
    { header: 'Classified By', key: 'classifiedBy', width: 30 },
    { header: 'Path', key: 'path', width: 35 },
    { header: 'HTTP Status', key: 'status', width: 12 },
    { header: 'CTAs Found', key: 'ctaCount', width: 12 },
    { header: 'Highest Severity', key: 'severity', width: 16 },
    { header: 'Issue Categories', key: 'categories', width: 40 },
    { header: 'Details', key: 'issues', width: 70 },
  ];
  styleHeaderRow(wsPages.getRow(1));
  wsPages.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of pageResults) {
    const severity = worstSeverity(r.issues);
    const row = wsPages.addRow({
      site: r.site,
      page: r.page,
      pageType: r.pageType,
      typeConfidence: r.typeConfidence === undefined ? '' : r.typeConfidence,
      classifiedBy: r.classifiedBy || '',
      path: r.path,
      status: r.status,
      ctaCount: r.ctaCount,
      severity: severity || 'OK',
      categories: r.issues.length ? [...new Set(r.issues.map(i => i.code))].join(', ') : '—',
      issues: r.issues.length ? r.issues.map(i => `[${i.code}] ${i.message}`).join(' | ') : 'OK',
    });
    fillSeverity(row.getCell('severity'), severity);
  }
  wsPages.autoFilter = { from: 'A1', to: 'K1' };

  // --- Sheet 4: Links & CTAs — grouped by source page so "where do this
  // page's 10 CTAs go" is a single expandable outline group, not a search
  // through a flat list. ---
  const wsLinks = wb.addWorksheet('Links & CTAs');
  wsLinks.columns = [
    { header: 'Site', key: 'site', width: 18 },
    { header: 'Source Page', key: 'sourcePage', width: 28 },
    { header: 'Source Page URL', key: 'sourceUrl', width: 45 },
    { header: 'Page Type', key: 'pageType', width: 16 },
    { header: 'Page Location', key: 'location', width: 30 },
    { header: 'Link/CTA Text', key: 'text', width: 35 },
    { header: 'Destination URL', key: 'url', width: 55 },
    { header: 'Destination Status', key: 'status', width: 16 },
    { header: 'Destination Page Title', key: 'title', width: 35 },
    { header: 'Internal/External', key: 'scope', width: 16 },
    { header: 'Category', key: 'code', width: 20 },
    { header: 'Relevant Code', key: 'elementHtml', width: 45 },
    { header: 'Suggested Fix', key: 'fix', width: 50 },
  ];
  styleHeaderRow(wsLinks.getRow(1));
  wsLinks.views = [{ state: 'frozen', ySplit: 1 }];
  wsLinks.properties.outlineLevelRow = 1;

  const linksByPage = new Map(); // "site||sourcePage" -> rows
  for (const row of linkRows) {
    const key = `${row.site}||${row.sourcePage}`;
    if (!linksByPage.has(key)) linksByPage.set(key, []);
    linksByPage.get(key).push(row);
  }
  // Stable order: by site, then by first-seen page order
  const pageOrder = [];
  const seenKeys = new Set();
  for (const row of linkRows) {
    const key = `${row.site}||${row.sourcePage}`;
    if (!seenKeys.has(key)) { seenKeys.add(key); pageOrder.push(key); }
  }

  for (const key of pageOrder) {
    const rows = linksByPage.get(key);
    const [site, sourcePage] = key.split('||');
    const brokenCount = rows.filter(r => r.code).length;
    const headerRow = wsLinks.addRow({
      site,
      sourcePage,
      sourceUrl: rows[0] ? rows[0].sourceUrl : '',
      pageType: rows[0] ? rows[0].pageType : '',
      text: `${rows.length} CTA(s) on this page — ${brokenCount} flagged`,
    });
    headerRow.font = { bold: true };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
    for (const row of rows) {
      const r = wsLinks.addRow(row);
      r.outlineLevel = 1;
      if (row.severity) fillSeverity(r.getCell('code'), row.severity);
    }
  }
  wsLinks.autoFilter = { from: 'A1', to: 'M1' };

  // --- Sheet 5: Broken Media ---
  const wsMedia = wb.addWorksheet('Broken Media');
  wsMedia.columns = [
    { header: 'Site', key: 'site', width: 20 },
    { header: 'Page', key: 'page', width: 30 },
    { header: 'Page Location', key: 'location', width: 30 },
    { header: 'Asset URL', key: 'url', width: 60 },
    { header: 'Category', key: 'code', width: 20 },
    { header: 'Reason', key: 'reason', width: 30 },
    { header: 'Relevant Code', key: 'elementHtml', width: 45 },
    { header: 'Suggested Fix', key: 'fix', width: 50 },
  ];
  styleHeaderRow(wsMedia.getRow(1));
  wsMedia.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of pageResults) {
    for (const a of r.broken_assets) {
      const row = wsMedia.addRow({
        site: r.site, page: r.page, location: a.location || '', url: a.url, code: 'BROKEN_ASSET',
        reason: `HTTP ${a.status}`, elementHtml: a.html || '', fix: ISSUE_CATALOG.BROKEN_ASSET.fix,
      });
      fillSeverity(row.getCell('code'), ISSUE_CATALOG.BROKEN_ASSET.severity);
    }
    for (const img of r.broken_images_rendered) {
      const row = wsMedia.addRow({
        site: r.site, page: r.page, location: img.location || '', url: img.url, code: 'IMAGE_RENDER_FAIL',
        reason: 'Returned OK but failed to render', elementHtml: img.html || '', fix: ISSUE_CATALOG.IMAGE_RENDER_FAIL.fix,
      });
      fillSeverity(row.getCell('code'), ISSUE_CATALOG.IMAGE_RENDER_FAIL.severity);
    }
  }
  wsMedia.autoFilter = { from: 'A1', to: 'H1' };

  await wb.xlsx.writeFile(`./${REPORT_FILENAME}`);
}

(async () => {
  const browser = await chromium.launch();

  // Pass 1: crawl every configured page — bounded concurrency (4 at a time)
  // instead of one at a time. This is the single biggest speedup: most of a
  // run's wall-clock time was pages sitting idle waiting their turn. Kept at
  // 4 rather than higher — 6 concurrent full-page loads against the same
  // site overloaded the shared GitHub Actions runner enough to time out
  // every single page on the two largest sites in an earlier test run.
  const crawlTargets = [];
  for (const site of config.sites) {
    for (const pageConfig of site.pages) crawlTargets.push({ site, pageConfig });
  }
  const crawlResults = await runPool(crawlTargets, 4, ({ site, pageConfig }) => crawlPage(browser, site, pageConfig));
  pageResults.push(...crawlResults);

  // Pass 2: check every unique link/CTA destination found during the crawl —
  // also bounded concurrency (12 at a time). Kept moderate rather than maxed
  // out so we don't look like a flood of requests to the target sites.
  const uniqueUrls = [...new Set(linkSightings.map(l => l.url))];
  const siteBaseByHost = {};
  for (const site of config.sites) siteBaseByHost[new URL(site.base_url).host] = site.base_url;

  await runPool(uniqueUrls, 12, async (url) => {
    const host = (() => { try { return new URL(url).host; } catch { return null; } })();
    const base = siteBaseByHost[host] || url;
    await checkDestination(browser, url, base);
  });

  await browser.close();

  // Build link report rows, each tagged with a standardized category if broken
  const linkRows = linkSightings.map(l => {
    const dest = linkDestCache.get(l.url) || {};
    const internal = Object.values(siteBaseByHost).some(b => isSameHost(l.url, b));
    const code = classifyLinkIssue(dest.status, dest.error, l.url);
    const meta = code ? ISSUE_CATALOG[code] : null;
    return {
      site: l.site,
      sourcePage: l.sourcePage,
      sourcePath: l.sourcePath,
      sourceUrl: l.sourceUrl || '',
      pageType: l.pageType,
      text: l.text,
      url: l.url,
      status: dest.status ?? '(error)',
      title: dest.title || '',
      scope: internal ? 'Internal' : 'External',
      code: code || '',
      severity: meta ? meta.severity : null,
      fix: meta ? meta.fix : '',
      location: l.location || '',
      elementHtml: l.html || '',
      _rawError: dest.error || null,
    };
  });

  // Unified issue list across pages, links, and media — this is the sheet
  // that answers "what's broken, how bad is it, and how do I fix it" without
  // needing to cross-reference multiple tabs.
  const allIssueRows = [];
  for (const r of pageResults) {
    for (const i of r.issues) {
      allIssueRows.push({
        severity: i.severity, code: i.code, site: r.site, page: r.page, pageType: r.pageType,
        pageUrl: r.url, where: r.url, message: i.message, fix: i.fix,
        location: i.location || '', elementHtml: i.elementHtml || '',
      });
    }
  }
  for (const l of linkRows) {
    if (!l.code) continue;
    const detail = l._rawError ? `${l._rawError} (from "${l.sourcePage}", link text: "${l.text}")` : `HTTP ${l.status} (from "${l.sourcePage}", link text: "${l.text}")`;
    allIssueRows.push({
      severity: l.severity, code: l.code, site: l.site, page: l.sourcePage, pageType: l.pageType,
      pageUrl: l.sourceUrl || '', where: l.url, message: detail, fix: l.fix,
      location: l.location || '', elementHtml: l.elementHtml || '',
    });
  }

  // report.json keeps the full, un-collapsed list (every occurrence on every
  // page) as the raw audit trail; everything the user actually reads (Excel
  // All Issues tab, summary.md, severity counts) uses the deduped list below.
  fs.writeFileSync('./report.json', JSON.stringify({ pages: pageResults, links: linkRows, issues: allIssueRows }, null, 2));

  const dedupedIssueRows = dedupeSiteWideIssues(allIssueRows);
  const collapsedCount = allIssueRows.length - dedupedIssueRows.length;

  const severityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const row of dedupedIssueRows) severityCounts[row.severity] = (severityCounts[row.severity] || 0) + 1;

  let summary = `# Site Check Report — ${REPORT_TS.date} ${REPORT_TS.displayTime}\n\n`;
  summary += `**${dedupedIssueRows.length} issue(s) found** across ${pageResults.length} pages and ${linkRows.length} links checked — `;
  summary += `${severityCounts.Critical} Critical, ${severityCounts.High} High, ${severityCounts.Medium} Medium, ${severityCounts.Low} Low.\n\n`;
  summary += `Open \`${REPORT_FILENAME}\` → **All Issues** tab for the full triage list (sortable by Severity/Category/Page Type,\n`;
  summary += `and now including Page Location + Relevant Code for issues tied to a specific element),\n`;
  summary += `or **Links & CTAs** to see every CTA grouped by the page it's on.\n\n`;
  if (collapsedCount > 0) {
    summary += `_(${collapsedCount} issue occurrence(s) in a shared header/footer/nav element were collapsed into a single row per issue below, so a template-wide problem isn't overcounted as N separate page failures.)_\n\n`;
  }

  let currentSite = null;
  for (const r of pageResults) {
    if (r.site !== currentSite) { currentSite = r.site; summary += `\n## ${currentSite}\n\n`; }
    const ok = r.issues.length === 0;
    summary += `### ${r.page} [${r.pageType}] (${r.path}) — ${ok ? 'OK' : 'ISSUES FOUND'}\n`;
    r.issues.forEach(i => {
      summary += `- [${i.severity}/${i.code}] ${i.message}`;
      if (i.location) summary += ` (Location: ${i.location})`;
      summary += '\n';
      if (i.elementHtml) summary += `  Code: \`${i.elementHtml}\`\n`;
    });
    summary += '\n';
  }
  const brokenLinks = linkRows.filter(l => l.code);
  summary += `\n## Broken links/CTAs (${brokenLinks.length})\n\n`;
  brokenLinks.forEach(l => {
    summary += `- [${l.severity}/${l.code}] "${l.sourcePage}" → "${l.text}" → ${l.url}`;
    if (l.location) summary += ` (Location: ${l.location})`;
    summary += '\n';
    if (l.elementHtml) summary += `  Code: \`${l.elementHtml}\`\n`;
  });

  fs.writeFileSync('./summary.md', summary);
  await writeExcelReport(pageResults, linkRows, dedupedIssueRows);

  const internalHosts = new Set(config.sites.map((x) => new URL(x.base_url).host.replace(/^www\./, '')));
  const uniqueInternal = uniqueUrls.filter((u) => { try { return internalHosts.has(new URL(u).host.replace(/^www\./, '')); } catch (_) { return false; } }).length;
  fs.writeFileSync('./run_stats.json', JSON.stringify({
    pages: pageResults.length,
    link_sightings: linkRows.length,
    unique_links: uniqueUrls.length,
    unique_internal: uniqueInternal,
    unique_external: uniqueUrls.length - uniqueInternal,
    check_seconds: Math.round((Date.now() - RUN_START) / 1000),
  }, null, 2));

  console.log(summary);
  console.log(`\nExcel report: ${REPORT_FILENAME} (${linkRows.length} links checked across ${pageResults.length} pages, ${dedupedIssueRows.length} issues tagged, ${collapsedCount} shared-template occurrence(s) collapsed)`);
  // Always exit 0 — finding site issues is the point of this report, not a
  // failure of the automation. Only an uncaught exception (a real bug) should
  // fail the CI job, and that happens naturally without an explicit exit here.
  process.exit(0);
})();
