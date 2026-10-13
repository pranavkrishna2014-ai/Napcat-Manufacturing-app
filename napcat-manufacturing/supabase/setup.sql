-- Napcat Manufacturing app — Invoice & Tally WO documents
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run again: everything is "if not exists" / "on conflict do nothing".

-- 1) Table that lists every uploaded PDF and its Claude check result
create table if not exists public.wo_docs (
  id         text primary key,
  wo_id      text not null,
  kind       text not null check (kind in ('invoice', 'tally')),
  data       jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists wo_docs_wo_id_idx on public.wo_docs (wo_id);

-- Same access model as the app's other tables (the app has its own logins).
alter table public.wo_docs enable row level security;
drop policy if exists "app access" on public.wo_docs;
create policy "app access" on public.wo_docs
  for all to anon, authenticated using (true) with check (true);

-- 2) Private storage bucket for the PDFs (PDF only, max 10 MB each)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wo-docs', 'wo-docs', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "wo-docs read"   on storage.objects;
drop policy if exists "wo-docs upload" on storage.objects;
drop policy if exists "wo-docs delete" on storage.objects;
create policy "wo-docs read"   on storage.objects for select to anon, authenticated using (bucket_id = 'wo-docs');
create policy "wo-docs upload" on storage.objects for insert to anon, authenticated with check (bucket_id = 'wo-docs');
create policy "wo-docs delete" on storage.objects for delete to anon, authenticated using (bucket_id = 'wo-docs');
