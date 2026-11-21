-- Photo Vote: each entry has a dish name as well as the person's name.
-- Run once in the Supabase SQL Editor AFTER 003_categories.sql.
-- Existing entries get no dish name; add one with the Edit button on /admin/.

alter table public.entries
  add column if not exists dish text
  check (dish is null or char_length(btrim(dish)) between 1 and 80);

-- ---------- Functions whose signatures change ----------

drop function if exists public.results();
drop function if exists public.admin_results(text);
drop function if exists public.admin_add_entry(text, text, text, text);

create function public.results()
returns table (entry_id uuid, category text, name text, dish text, photo_path text, votes integer)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.category, e.name, e.dish, e.photo_path, count(v.id)::integer
  from public.entries e
  left join public.votes v on v.entry_id = e.id
  where private.results_visible()
  group by e.id
  order by e.category desc, count(v.id) desc, e.created_at asc;  -- entree before dessert
$$;

create function public.admin_results(p_code text)
returns table (entry_id uuid, category text, name text, dish text, photo_path text, votes integer, voters text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin(p_code);
  return query
    select e.id, e.category, e.name, e.dish, e.photo_path, count(v.id)::integer,
           coalesce(array_agg(coalesce(v.voter_name, '(no name)') order by v.voter_name)
                    filter (where v.id is not null), '{}')
    from public.entries e
    left join public.votes v on v.entry_id = e.id
    group by e.id
    order by e.category desc, e.created_at asc;
end;
$$;

-- Dish name is required for new entries.
create function public.admin_add_entry(p_code text, p_name text, p_dish text, p_photo_path text, p_category text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_admin(p_code);
  if p_dish is null or btrim(p_dish) = '' then
    raise exception 'Dish name is required';
  end if;
  delete from private.pending_uploads where path = p_photo_path;
  if not found then
    raise exception 'Upload path was not reserved';
  end if;
  insert into public.entries (name, dish, photo_path, category)
  values (btrim(p_name), btrim(p_dish), p_photo_path, p_category)
  returning id into v_id;
  return v_id;
end;
$$;

-- Edit an entry's person name and dish name (e.g. to add dish names to older entries).
create or replace function public.admin_update_entry(p_code text, p_entry_id uuid, p_name text, p_dish text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin(p_code);
  if p_dish is null or btrim(p_dish) = '' then
    raise exception 'Dish name is required';
  end if;
  update public.entries set name = btrim(p_name), dish = btrim(p_dish) where id = p_entry_id;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.results()',
    'public.admin_results(text)',
    'public.admin_add_entry(text, text, text, text, text)',
    'public.admin_update_entry(text, uuid, text, text)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;
