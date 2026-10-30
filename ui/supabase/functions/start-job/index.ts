// Supabase Edge Function: start-job
// Called by the web UI. Checks you are the one allowed user, records a job, and starts the
// GitHub workflow. The GitHub token lives only here (as a function secret), never in the browser.
//
// Secrets to set:  GH_TOKEN (fine-grained, this repo only, Actions: Read and write),
//                  GH_REPO (owner/repo), ALLOWED_EMAIL (your login email)
// Provided automatically by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateRequest } from './validate.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // 1) Who is calling? Only ALLOWED_EMAIL may start jobs.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: { user }, error: authErr } = await supa.auth.getUser(token);
  const allowed = (Deno.env.get('ALLOWED_EMAIL') ?? '').toLowerCase();
  if (authErr || !user) return json({ error: 'Not signed in' }, 401);
  if (!allowed || (user.email ?? '').toLowerCase() !== allowed) return json({ error: 'Not allowed' }, 403);

  // 2) Validate the request.
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const v = validateRequest(body, user.id);
  if (!v.ok) return json({ error: v.error }, 400);
  const r = v.value;

  // 3) Simple brake: at most 3 unfinished jobs at a time.
  const { count } = await supa.from('jobs').select('id', { count: 'exact', head: true })
    .eq('user_id', user.id).in('status', ['queued', 'running']);
  if ((count ?? 0) >= 3) return json({ error: 'You already have 3 jobs running. Wait for one to finish.' }, 429);

  // 4) Record the job.
  const { data: job, error: insErr } = await supa.from('jobs').insert({
    user_id: user.id, site_name: r.site_name, site_url: r.site_url || null, sitemap_url: r.sitemap_url || null,
    input_path: r.input_path || null, max_pages: r.max_pages, estimate_only: r.estimate_only,
    recipient_email: r.recipient_email || null, status: 'queued',
  }).select('id').single();
  if (insErr || !job) return json({ error: 'Could not create job: ' + (insErr?.message ?? 'unknown') }, 500);

  // 5) A one-hour link to the uploaded file, so the workflow can read it from the private bucket.
  let inputUrl = '';
  if (r.input_path) {
    const { data: signed, error: sErr } = await supa.storage.from('inputs').createSignedUrl(r.input_path, 3600);
    if (sErr || !signed) {
      await supa.from('jobs').update({ status: 'dispatch_failed', headline: 'Could not read the uploaded file' }).eq('id', job.id);
      return json({ error: 'Could not read the uploaded file' }, 400);
    }
    inputUrl = signed.signedUrl;
  }

  // 6) Start the workflow. Empty inputs are left out.
  const inputs: Record<string, string> = {
    site_name: r.site_name, job_id: job.id, max_pages: String(r.max_pages), estimate_only: String(r.estimate_only),
  };
  if (r.site_url) inputs.site_url = r.site_url;
  if (r.sitemap_url) inputs.sitemap_url = r.sitemap_url;
  if (inputUrl) inputs.input_file_url = inputUrl;
  if (r.recipient_email) inputs.recipient_email = r.recipient_email;

  const gh = await fetch(`https://api.github.com/repos/${Deno.env.get('GH_REPO')}/actions/workflows/site-map-check.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('GH_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (gh.status !== 204) {
    const msg = `GitHub refused to start the run (HTTP ${gh.status})`;
    await supa.from('jobs').update({ status: 'dispatch_failed', headline: msg }).eq('id', job.id);
    return json({ error: msg, detail: (await gh.text()).slice(0, 300) }, 502);
  }
  await supa.from('jobs').update({ status: 'running' }).eq('id', job.id);
  return json({ id: job.id });
});
