-- Photo Vote: reserve a thumbnail path alongside each photo upload.
-- Run once in the Supabase SQL Editor AFTER 004_dish_name.sql.
--
-- For a photo at <uuid>.<ext>, the admin page also uploads <uuid>.thumb.jpg
-- (small JPEG for the grid/results). The thumbnail path is derived, so no table changes.

create or replace function public.admin_reserve_upload(p_code text, p_ext text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
begin
  perform private.require_admin(p_code);
  if p_ext not in ('jpg', 'png', 'webp', 'gif') then
    raise exception 'Unsupported file type';
  end if;
  delete from private.pending_uploads where created_at < now() - interval '1 day';
  v_id := gen_random_uuid()::text;
  insert into private.pending_uploads (path) values (v_id || '.' || p_ext), (v_id || '.thumb.jpg');
  return v_id || '.' || p_ext;
end;
$$;

create or replace function public.admin_add_entry(p_code text, p_name text, p_dish text, p_photo_path text, p_category text)
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
  -- The thumbnail reservation is no longer needed either (uploaded or not).
  delete from private.pending_uploads where path = regexp_replace(p_photo_path, '\.[a-z]+$', '.thumb.jpg');
  insert into public.entries (name, dish, photo_path, category)
  values (btrim(p_name), btrim(p_dish), p_photo_path, p_category)
  returning id into v_id;
  return v_id;
end;
$$;
