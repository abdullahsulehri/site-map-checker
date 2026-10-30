# Prompt to paste into Lovable

Build a small private web app called "Site Map Checker" for a single user. React + Tailwind, using the
connected Supabase project. No sign-up page. Keep it simple and clean.

## Auth
- A sign-in screen (email + password, Supabase Auth). No "create account" option anywhere.
- Everything else requires being signed in. A "Sign out" button in the header.

## Main screen: "New check" form
Fields:
1. **Site name** (required, text)
2. **Homepage URL** (optional, e.g. https://example.com). Helper text: "Used to find the sitemap automatically."
3. **Sitemap URL** (optional)
4. **Or upload a file**: accepts .xml (a sitemap) or .txt / .csv (one URL per line). On selecting a file, upload it to the
   Supabase Storage bucket `inputs` at the path `<user id>/<random uuid>-<original file name>` and remember that path.
5. **Max pages** (number, default 200, min 1, max 1000). Helper text: "Default 200. Raise it for bigger sites. More pages take longer."
6. **Email me the report** (optional, email). Helper text: "Leave blank to just download it here."

At least one of homepage URL / sitemap URL / uploaded file is required (show a clear message otherwise).

Two buttons:
- **Estimate first** → calls the function with `estimate_only: true`.
- **Run check** → calls the function with `estimate_only: false`.

To start a job, call exactly this and nothing else (the GitHub token is never in the browser):
```
const { data, error } = await supabase.functions.invoke('start-job', {
  body: { site_name, site_url, sitemap_url, input_path, max_pages, estimate_only, recipient_email }
});
```
On success show a toast "Started" and add the job to the list. On error show `error.message` or the
`error` field of the response body.

## Jobs list (below the form, newest first)
Read from the `jobs` table (select * order by created_at desc, limit 50) and **subscribe to realtime changes** on `jobs`
so rows update by themselves when a run finishes. Never poll.

Each row shows: site name, status badge, created time, headline.
Status badges: `queued`/`running` (blue, with a spinner and "running for X min"), `success` (green),
`estimate` (purple, label "Estimate"), `failure` (red), `dispatch_failed` (red, label "Could not start").

Clicking a row opens a detail panel with:
- **Headline** (bold)
- **Coverage** (the `coverage` text, preserve line breaks)
- **Issues** (the `issues_text`, in a collapsible monospace block, collapsed by default)
- **Download Excel report** button, shown only when `report_path` is set. It must call
  `supabase.storage.from('reports').createSignedUrl(report_path, 60)` and open the returned URL.
- **View run on GitHub** link (`run_url`) when present
- For jobs with status `estimate`: a **Run the full check now** button that starts a new job with the same
  inputs (site_name, site_url, sitemap_url, input_path, max_pages, recipient_email) and `estimate_only: false`.
- If `build_summary` exists, show a small table: pages found, pages checked, skipped by cap, estimated minutes
  (est_minutes, with est_minutes_low – est_minutes_high), estimated unique links (est_unique_links).
  If `run_stats` exists, also show actual links found, unique links, and `check_seconds` as minutes.

If `build_summary.skipped_by_cap` > 0, show a note: "N pages were skipped by the cap. Raise Max pages to include them."

## Notes
- Do not store or display any API keys. Do not add any server code other than calling the `start-job` function.
- The `jobs` table and storage buckets already exist (created separately). Do not create or alter tables.
- Mobile friendly. Plain, readable design; no marketing text.
