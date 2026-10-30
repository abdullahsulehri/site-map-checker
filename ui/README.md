# Web UI (private, single user)

```
Browser (Lovable app) --start-job--> Supabase Edge Function --dispatch--> GitHub Actions (the checker)
        ^                                                                        |
        |   realtime updates + signed download link                              |
        +------------ Supabase: jobs table + 'reports' bucket <-- workflow PATCHes row and uploads .xlsx
```
The checker still runs on GitHub Actions (it needs a real browser). The UI starts it and shows results.
The GitHub token lives only in the Edge Function. The UI never sees it.

## Setup (about 20 minutes)
1. **Supabase project** (free): create one at supabase.com.
2. **SQL editor**: paste and run `ui/supabase/schema.sql`.
3. **Lock it to you**: Authentication > Sign In / Providers > turn OFF "Allow new users to sign up".
   Then Authentication > Users > Add user (your email + a strong password).
4. **Edge Function**: install the Supabase CLI, then from this repo:
   ```
   supabase login
   supabase link --project-ref <your project ref>
   supabase secrets set GH_TOKEN=<fine-grained token> GH_REPO=abdullahsulehri/site-map-checker ALLOWED_EMAIL=<your login email>
   supabase functions deploy start-job
   ```
   `GH_TOKEN`: fine-grained, this repo only, permission **Actions: Read and write**.
5. **GitHub secrets** (repo Settings > Secrets and variables > Actions):
   - `SUPABASE_URL` = `https://<ref>.supabase.co`
   - `SUPABASE_SERVICE_KEY` = the **service_role** key (Supabase > Project Settings > API).
     It can read and write everything in the project, so keep the repo private and never put it anywhere else.
6. **Lovable**: create a project, connect it to this Supabase project, paste `ui/LOVABLE_PROMPT.md`.
7. **Test**: in the UI, run **Estimate first** on a small site. The row should flip from running to Estimate within a couple of minutes.

## Good to know
- "Private" means you don't share the link. A published Lovable URL can still be opened by anyone,
  which is why `start-job` checks your login AND `ALLOWED_EMAIL`, and signups are off.
- Uploaded files are read by the workflow through a link that expires after one hour.
- Limit: at most 3 unfinished jobs at a time (`start-job`). Max pages hard limit is 1000.
- Email is optional and still works through the Apps Script mailer if you set it up.

## Tests
`npm test` covers the checker and the request validation. The Edge Function itself and the Supabase
policies have NOT been run against a live project.
