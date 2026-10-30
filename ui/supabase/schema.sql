-- Run once in the Supabase SQL editor.

create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  user_id       uuid not null references auth.users(id) on delete cascade,
  site_name     text not null,
  site_url      text,
  sitemap_url   text,
  input_path    text,                       -- uploaded file in the 'inputs' bucket
  max_pages     int  not null default 200 check (max_pages between 1 and 1000),
  estimate_only boolean not null default false,
  recipient_email text,
  status        text not null default 'queued',  -- queued | running | success | failure | estimate | dispatch_failed
  headline      text,
  coverage      text,
  issues_text   text,
  run_url       text,
  report_path   text,                       -- path in the 'reports' bucket
  build_summary jsonb,
  run_stats     jsonb
);

alter table public.jobs enable row level security;

-- The UI may only READ its own jobs. Inserts/updates are done by the start-job
-- function and the GitHub workflow, both with the service role key.
drop policy if exists "read own jobs" on public.jobs;
create policy "read own jobs" on public.jobs for select to authenticated using (auth.uid() = user_id);

-- Live updates in the UI when the workflow finishes.
alter publication supabase_realtime add table public.jobs;

-- Private buckets.
insert into storage.buckets (id, name, public) values ('inputs', 'inputs', false), ('reports', 'reports', false)
on conflict (id) do nothing;

-- You can upload files only into your own folder of 'inputs' (path: <your user id>/<file>).
drop policy if exists "upload own inputs" on storage.objects;
create policy "upload own inputs" on storage.objects for insert to authenticated
  with check (bucket_id = 'inputs' and (storage.foldername(name))[1] = auth.uid()::text);

-- You can download a report only if it belongs to one of your jobs.
drop policy if exists "read own reports" on storage.objects;
create policy "read own reports" on storage.objects for select to authenticated
  using (bucket_id = 'reports' and exists (
    select 1 from public.jobs j where j.report_path = storage.objects.name and j.user_id = auth.uid()));
