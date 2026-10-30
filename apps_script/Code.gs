/**
 * Google Form -> GitHub Actions.
 *
 * Form questions (titles must match exactly):
 *   Site name                       (short answer, required)
 *   Homepage URL                    (short answer, required)  e.g. https://example.com
 *   Sitemap URL (optional)          (short answer)
 *   Page list (optional)            (paragraph)               one URL per line
 *   Email to send the report to     (short answer, required)  (turn on email validation)
 *   Max pages (optional)            (short answer)            blank = 200; hard limit 1000
 *   Estimate only?                  (multiple choice: No / Yes)  Yes = count pages+links and email a time estimate, no crawl
 *
 * Setup (once):
 *   1. In the Form: three dots menu > Script editor. Paste this file.
 *   2. Project Settings > Script properties, add:
 *        GITHUB_TOKEN  fine-grained token, ONLY this repo, permission Actions: Read and write
 *        GITHUB_REPO   owner/repo   (e.g. abdullahsulehri/site-mapper-checker)
 *   3. Triggers (clock icon) > Add trigger: function onFormSubmit, event source
 *      "From form", event type "On form submit". Approve the permissions.
 *   4. MAILER (replaces Zapier): add script properties MAIL_SECRET (any long random string).
 *      Deploy > New deployment > type Web app > Execute as: Me > Who has access: Anyone.
 *      Copy the Web app URL. In the GitHub repo add secrets MAIL_WEBHOOK_URL (that URL) and
 *      MAIL_SECRET (same string). After editing this file later: Deploy > Manage deployments >
 *      edit > Version: New version, or the old code keeps running.
 *   5. Optional: restrict who can submit (Form settings > Responses > limit to your org)
 *      and only allow recipient domains you trust (ALLOWED_RECIPIENT_DOMAINS below).
 */
var ALLOWED_RECIPIENT_DOMAINS = []; // e.g. ['peopleperfect.com']; empty = any

function onFormSubmit(e) {
  var v = e.namedValues;
  var get = function (k) { return ((v[k] && v[k][0]) || '').trim(); };
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('GITHUB_TOKEN');
  var repo = props.getProperty('GITHUB_REPO');

  var recipient = get('Email to send the report to');
  if (ALLOWED_RECIPIENT_DOMAINS.length) {
    var domain = recipient.split('@')[1] || '';
    if (ALLOWED_RECIPIENT_DOMAINS.indexOf(domain.toLowerCase()) === -1) {
      throw new Error('Recipient domain not allowed: ' + domain);
    }
  }

  var inputs = {
    site_name: get('Site name'),
    site_url: get('Homepage URL'),
    sitemap_url: get('Sitemap URL (optional)'),
    page_list: get('Page list (optional)'),
    recipient_email: recipient,
    max_pages: (get('Max pages (optional)').match(/^\d+$/) || ['200'])[0],
    estimate_only: /^yes/i.test(get('Estimate only?')) ? 'true' : 'false'
  };
  // GitHub rejects empty-string inputs for some clients; drop blanks.
  Object.keys(inputs).forEach(function (k) { if (!inputs[k]) delete inputs[k]; });

  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/actions/workflows/site-map-check.yml/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ ref: 'main', inputs: inputs }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 204) {
    throw new Error('GitHub dispatch failed: ' + res.getResponseCode() + ' ' + res.getContentText());
  }
}


/**
 * Mailer. The GitHub workflow POSTs JSON here when a run finishes:
 *   {secret, to, subject, body, filename, report_b64}
 * and this sends it from the Google account that owns the script, with the Excel attached.
 * The web app URL is public, so the shared secret is what protects it.
 */
function doPost(e) {
  try {
    var p = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('MAIL_SECRET');
    if (!secret || p.secret !== secret) return json_({ ok: false, error: 'unauthorized' });
    var to = String(p.to || '').trim();
    if (!/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(to)) return json_({ ok: false, error: 'bad recipient' });
    if (ALLOWED_RECIPIENT_DOMAINS.length && ALLOWED_RECIPIENT_DOMAINS.indexOf(to.split('@')[1].toLowerCase()) === -1) {
      return json_({ ok: false, error: 'recipient domain not allowed' });
    }
    var mail = { to: to, subject: String(p.subject || 'Site check report').slice(0, 200), body: String(p.body || '') };
    if (p.report_b64) {
      mail.attachments = [Utilities.newBlob(
        Utilities.base64Decode(p.report_b64),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        String(p.filename || 'Website_Health_Report.xlsx')
      )];
    }
    MailApp.sendEmail(mail);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
