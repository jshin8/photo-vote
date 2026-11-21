-- Photo Vote: admin passcode, voter names, changeable votes, results toggle.
-- Run once in the Supabase SQL Editor AFTER schema.sql.
--
-- BEFORE RUNNING: replace CHANGE-ME at the bottom of this file with your admin
-- passcode (edit it in the SQL Editor; don't save your real passcode into the repo).
-- Use a long phrase: anyone who guesses it is a full admin.

create extension if not exists pgcrypto with schema extensions;

-- ---------- Private schema (not reachable through the public API) ----------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.admin_passcode (
  id   boolean primary key default true check (id),  -- single row
  hash text not null
);

-- Upload paths the admin has reserved. Storage only accepts uploads to these paths.
create table if not exists private.pending_uploads (
  path       text primary key,
  created_at timestamptz not null default now()
);

create table if not exists private.settings (
  id              boolean primary key default true check (id),  -- single row
  results_visible boolean not null default false
);
insert into private.settings default values on conflict (id) do nothing;

create or replace function private.require_admin(p_code text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_code is null or p_code = 'CHANGE-ME' or not exists (
    select 1 from private.admin_passcode where hash = extensions.crypt(p_code, hash)
  ) then
    raise exception 'Wrong admin passcode' using errcode = '28P01';
  end if;
end;
$$;

create or replace function private.results_visible()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select results_visible from private.settings $$;

-- ---------- Lock down direct writes from the browser ----------
-- Entries are now added only by the admin, and votes only through cast_vote().

drop policy if exists "Anyone can submit an entry" on public.entries;
drop policy if exists "Anyone can vote" on public.votes;
revoke insert on public.entries from anon, authenticated;
revoke insert on public.votes   from anon, authenticated;

drop policy if exists "Anyone can upload photos" on storage.objects;

-- ---------- Votes: voter name, one changeable vote per browser ----------

alter table public.votes
  add column if not exists voter_name text
  check (voter_name is null or char_length(btrim(voter_name)) between 1 and 60);
alter table public.votes
  add column if not exists updated_at timestamptz not null default now();

-- ---------- Public functions (anyone) ----------

create or replace function public.results_visible()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select private.results_visible() $$;

-- Cast or change a vote. Allowed only while results are hidden.
create or replace function public.cast_vote(p_voter_id uuid, p_voter_name text, p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.results_visible() then
    raise exception 'Voting is closed' using errcode = 'PV001';
  end if;
  if p_voter_name is null or char_length(btrim(p_voter_name)) not between 1 and 60 then
    raise exception 'Name must be 1 to 60 characters' using errcode = 'PV002';
  end if;
  insert into public.votes (entry_id, voter_id, voter_name)
  values (p_entry_id, p_voter_id, btrim(p_voter_name))
  on conflict (voter_id) do update
    set entry_id = excluded.entry_id, voter_name = excluded.voter_name, updated_at = now();
end;
$$;

-- The entry this browser currently votes for (null if none).
create or replace function public.my_vote(p_voter_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$ select entry_id from public.votes where voter_id = p_voter_id $$;

-- Vote counts, returned only once the admin has made results visible.
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
  where private.results_visible()
  group by e.id
  order by count(v.id) desc, e.created_at asc;
$$;

-- Used by the storage policy below: is this path one the admin reserved?
create or replace function public.upload_reserved(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select exists (select 1 from private.pending_uploads where path = p_path) $$;

create policy "Uploads only to admin-reserved paths"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'photos' and public.upload_reserved(name));

-- ---------- Admin functions (passcode required) ----------

create or replace function public.admin_login(p_code text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin(p_code);
  return true;
end;
$$;

-- Step 1 of adding a photo: reserve a random upload path.
create or replace function public.admin_reserve_upload(p_code text, p_ext text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  perform private.require_admin(p_code);
  if p_ext not in ('jpg', 'png', 'webp', 'gif') then
    raise exception 'Unsupported file type';
  end if;
  delete from private.pending_uploads where created_at < now() - interval '1 day';
  v_path := gen_random_uuid()::text || '.' || p_ext;
  insert into private.pending_uploads (path) values (v_path);
  return v_path;
end;
$$;

-- Step 2 (after uploading the file): create the entry.
create or replace function public.admin_add_entry(p_code text, p_name text, p_photo_path text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_admin(p_code);
  delete from private.pending_uploads where path = p_photo_path;
  if not found then
    raise exception 'Upload path was not reserved';
  end if;
  insert into public.entries (name, photo_path) values (btrim(p_name), p_photo_path)
  returning id into v_id;
  return v_id;
end;
$$;

-- Deletes the entry and its votes. The photo file stays in Storage (harmless;
-- remove it from the dashboard if you want).
create or replace function public.admin_delete_entry(p_code text, p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin(p_code);
  delete from public.entries where id = p_entry_id;
end;
$$;

create or replace function public.admin_set_results_visible(p_code text, p_visible boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin(p_code);
  update private.settings set results_visible = p_visible;
end;
$$;

-- Full results with voter names, regardless of the visibility switch.
create or replace function public.admin_results(p_code text)
returns table (entry_id uuid, name text, photo_path text, votes integer, voters text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin(p_code);
  return query
    select e.id, e.name, e.photo_path, count(v.id)::integer,
           coalesce(array_agg(coalesce(v.voter_name, '(no name)') order by v.voter_name)
                    filter (where v.id is not null), '{}')
    from public.entries e
    left join public.votes v on v.entry_id = e.id
    group by e.id
    order by e.created_at asc;
end;
$$;

-- ---------- Function permissions ----------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.results_visible()',
    'public.cast_vote(uuid, text, uuid)',
    'public.my_vote(uuid)',
    'public.results()',
    'public.upload_reserved(text)',
    'public.admin_login(text)',
    'public.admin_reserve_upload(text, text)',
    'public.admin_add_entry(text, text, text)',
    'public.admin_delete_entry(text, uuid)',
    'public.admin_set_results_visible(text, boolean)',
    'public.admin_results(text)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

-- ---------- Set the admin passcode ----------
-- Replace CHANGE-ME with your passcode. To change it later, re-run just this statement.

insert into private.admin_passcode (hash)
values (extensions.crypt('CHANGE-ME', extensions.gen_salt('bf', 8)))
on conflict (id) do update set hash = excluded.hash;
