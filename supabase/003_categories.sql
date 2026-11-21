-- Photo Vote: two categories (entree, dessert), one vote per voter per category.
-- Run once in the Supabase SQL Editor AFTER 002_admin.sql.
-- Existing photos are put in "entree"; delete or re-add them from /admin/ as needed.

-- ---------- Entries get a category ----------

alter table public.entries
  add column if not exists category text not null default 'entree'
  check (category in ('entree', 'dessert'));
alter table public.entries alter column category drop default;  -- admin must choose from now on

-- Lets votes reference (entry, category) together, so a vote's category always matches its entry.
alter table public.entries add constraint entries_id_category_key unique (id, category);

-- ---------- Votes: one per voter per category ----------

alter table public.votes add column if not exists category text;
update public.votes v set category = e.category from public.entries e where e.id = v.entry_id;
alter table public.votes alter column category set not null;

alter table public.votes drop constraint if exists votes_voter_id_key;
alter table public.votes add constraint votes_voter_category_key unique (voter_id, category);

alter table public.votes drop constraint if exists votes_entry_id_fkey;
alter table public.votes add constraint votes_entry_category_fkey
  foreign key (entry_id, category) references public.entries (id, category) on delete cascade;

-- ---------- Functions whose signatures change ----------

drop function if exists public.my_vote(uuid);
drop function if exists public.results();
drop function if exists public.admin_results(text);
drop function if exists public.admin_add_entry(text, text, text);

-- Cast or change this browser's vote in the entry's category. Only while results are hidden.
create or replace function public.cast_vote(p_voter_id uuid, p_voter_name text, p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category text;
begin
  if private.results_visible() then
    raise exception 'Voting is closed' using errcode = 'PV001';
  end if;
  if p_voter_name is null or char_length(btrim(p_voter_name)) not between 1 and 60 then
    raise exception 'Name must be 1 to 60 characters' using errcode = 'PV002';
  end if;
  select category into v_category from public.entries where id = p_entry_id;
  if v_category is null then
    raise exception 'That photo no longer exists' using errcode = 'PV003';
  end if;
  insert into public.votes (entry_id, voter_id, voter_name, category)
  values (p_entry_id, p_voter_id, btrim(p_voter_name), v_category)
  on conflict (voter_id, category) do update
    set entry_id = excluded.entry_id, voter_name = excluded.voter_name, updated_at = now();
end;
$$;

-- This browser's current votes, one row per category voted in.
create function public.my_vote(p_voter_id uuid)
returns table (category text, entry_id uuid)
language sql
stable
security definer
set search_path = ''
as $$ select category, entry_id from public.votes where voter_id = p_voter_id $$;

-- Vote counts per category, returned only once the admin has made results visible.
create function public.results()
returns table (entry_id uuid, category text, name text, photo_path text, votes integer)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.category, e.name, e.photo_path, count(v.id)::integer
  from public.entries e
  left join public.votes v on v.entry_id = e.id
  where private.results_visible()
  group by e.id
  order by e.category desc, count(v.id) desc, e.created_at asc;  -- entree before dessert
$$;

create function public.admin_add_entry(p_code text, p_name text, p_photo_path text, p_category text)
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
  insert into public.entries (name, photo_path, category) values (btrim(p_name), p_photo_path, p_category)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.admin_results(p_code text)
returns table (entry_id uuid, category text, name text, photo_path text, votes integer, voters text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin(p_code);
  return query
    select e.id, e.category, e.name, e.photo_path, count(v.id)::integer,
           coalesce(array_agg(coalesce(v.voter_name, '(no name)') order by v.voter_name)
                    filter (where v.id is not null), '{}')
    from public.entries e
    left join public.votes v on v.entry_id = e.id
    group by e.id
    order by e.category desc, e.created_at asc;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.cast_vote(uuid, text, uuid)',
    'public.my_vote(uuid)',
    'public.results()',
    'public.admin_add_entry(text, text, text, text)',
    'public.admin_results(text)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;
