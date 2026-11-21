-- Photo Vote schema. Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.

-- ---------- Tables ----------

create table if not exists public.entries (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  photo_path  text not null unique
              check (photo_path ~ '^[0-9a-f-]{36}\.(jpg|png|webp|gif)$'),
  created_at  timestamptz not null default now()
);

create table if not exists public.votes (
  id          bigint generated always as identity primary key,
  entry_id    uuid not null references public.entries (id) on delete cascade,
  voter_id    uuid not null unique,  -- one vote per browser
  created_at  timestamptz not null default now()
);

create index if not exists votes_entry_id_idx on public.votes (entry_id);

-- ---------- Row Level Security ----------
-- The public key is shipped to every browser, so these policies are the real access control.

alter table public.entries enable row level security;
alter table public.votes   enable row level security;

create policy "Anyone can read entries"
  on public.entries for select to anon, authenticated using (true);

create policy "Anyone can submit an entry"
  on public.entries for insert to anon, authenticated with check (true);

create policy "Anyone can vote"
  on public.votes for insert to anon, authenticated with check (true);

-- No select/update/delete policies on votes: voter ids are never readable,
-- and nobody can change or remove votes from the browser.

-- ---------- Results ----------
-- Runs with the owner's rights so it can count votes without exposing the votes table.

create or replace function public.results()
returns table (entry_id uuid, name text, photo_path text, votes integer)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.name, e.photo_path, count(v.id)::integer
  from public.entries e
  left join public.votes v on v.entry_id = e.id
  group by e.id
  order by count(v.id) desc, e.created_at asc;
$$;

revoke execute on function public.results() from public;
grant execute on function public.results() to anon, authenticated;

-- ---------- Photo storage ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- Public bucket = anyone can view photos by URL. Uploads are allowed; overwrites and deletes are not.
create policy "Anyone can upload photos"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'photos');
