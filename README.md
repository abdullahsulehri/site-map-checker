# Site Map Checker

Give it a website's sitemap (or a list of URLs). It works out what each page is,
then runs the same health check as the original Site Checker (page loads, images
actually render, assets, console errors, every link/CTA followed) and emails an
Excel report: **All Issues**, **Page Health**, **Links & CTAs**, **Broken Media**.

## How it works
1. **Google Form** (you fill it in) -> `apps_script/Code.gs` calls GitHub.
2. **`build_config.js`** finds the sitemap (`robots.txt`, `/sitemap.xml`, WordPress
   `wp-sitemap.xml`, or the one you give), follows sitemap indexes, de-duplicates,
   ignores other hosts, and **caps at 200 pages by default**. If a site has more, every
   non-blog page is kept and blog/other pages are sampled evenly. It never silently
   drops pages: the email says how many were skipped and how to include them.
   **To raise the cap**, set *Max pages* on the form (or the `max_pages` input in the
   Actions tab). Hard limit: 1000 (`MAX_PAGES_CEILING` in the workflow).
   **Links and time:** it counts links from each page's HTML, then estimates run time
   (`setup + pages/4 x 3s + unique links/12 x 2s`, constants in `build_config.js`).
   It refuses a run estimated above 300 minutes. The email shows the estimate AND the
   actual time so you can tune the constants. JavaScript-added links aren't counted
   up front, so treat the estimate as a lower bound. Tick **Estimate only** to get
   the page/link counts and time estimate without crawling.
3. **Page typing**, cheapest signal first: sitemap file name (`post-sitemap.xml`),
   URL patterns, then page signals (article markup, Event markup, has a form).
   No AI calls, no cost. Each page gets a **Type Confidence** and **Classified By**
   in the *Page Health* tab. Anything under 0.6 is a guess: look at those first.
4. **`check.js`** is the original checker, unchanged except it reads the generated
   config and shows the two confidence columns.
5. The workflow posts the summary and the `.xlsx` to a small **Google Apps Script mailer**
   (`doPost` in `apps_script/Code.gs`), which emails it from your Google account.
   No Zapier and no mail passwords: the only secrets are a mailer URL and a shared secret.

## What it will NOT do
- It never fills or submits forms.
- It does not infer "this page should have a booking link". Booking-link checks
  stay off. A lead form is expected only on obvious Contact / Form / Request-Demo
  URLs. To turn on stricter expectations for a site, edit the generated
  `config.json` (see `expects_lead_form`, `expects_calendly`).
- Only crawl sites you own or have permission to test.

## Setup (once)
1. Create the Google Form with these questions (titles must match exactly):
   `Site name`, `Homepage URL`, `Sitemap URL (optional)`, `Page list (optional)`,
   `Email to send the report to`, `Max pages (optional)`, `Estimate only?` (No / Yes).
2. In the Form: three dots > Script editor > paste `apps_script/Code.gs`. Project Settings >
   Script properties:
   - `GITHUB_TOKEN`: fine-grained token for THIS repo only, permission Actions: Read and write
   - `GITHUB_REPO`: `owner/repo`
   - `MAIL_SECRET`: any long random string
3. Triggers > add `onFormSubmit` (from form, on form submit) and approve permissions.
4. Deploy > New deployment > Web app > Execute as **Me**, access **Anyone**. Copy the URL.
5. In GitHub: Settings > Secrets and variables > Actions, add
   `MAIL_WEBHOOK_URL` (the URL from step 4) and `MAIL_SECRET` (same string as step 2).
6. Test: Actions tab > **Site map check** > Run workflow (try *Estimate only* first).

Notes: the mailer URL is public, so keep `MAIL_SECRET` private. Emails come from the Google
account that owns the script. Consumer Gmail allows roughly 100 emails/day via Apps Script.
After editing `Code.gs`, redeploy (Manage deployments > New version) or the old code keeps running.
Set `ALLOWED_RECIPIENT_DOMAINS` in `Code.gs` to limit who can receive reports.

## Tests
`npm test` (offline, uses a local fake site).
