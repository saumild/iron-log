-- Iron Log — Supabase schema. Run once in the Supabase SQL editor (or via the Supabase connector).
-- One generic document table; js/platform.js maps the app's doc()/collection() calls onto it.
-- Account data (ilacct/*, data/users/*) is end-to-end encrypted in the browser before it gets here.
--
-- Also required in Supabase → Authentication → Sign In / Providers → Email:
--   turn OFF "Confirm email"  (usernames map to synthetic addresses; no mail is ever sent)

create table if not exists public.docs (
  path       text primary key,
  parent     text not null,
  owner      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint docs_parent_matches check (parent = regexp_replace(path, '/[^/]+$', ''))
);
create index if not exists docs_parent_idx on public.docs (parent);

alter table public.docs enable row level security;

-- helper: does the caller own Iron Log account <acct>?  Lives in a schema the API does not expose.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
create or replace function private.il_owns_acct(acct text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.docs d where d.path = 'ilacct/' || acct and d.owner = auth.uid());
$$;
revoke all on function private.il_owns_acct(text) from public, anon;
grant execute on function private.il_owns_acct(text) to authenticated;

-- helper: is the caller a member of crew group <gid>?  (crews: ilgrp/<gid>/m/<acct>/…)
create or replace function private.il_in_group(gid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.docs d where d.parent = 'ilgrp/' || gid || '/m' and d.owner = auth.uid());
$$;
revoke all on function private.il_in_group(text) from public, anon;
grant execute on function private.il_in_group(text) to authenticated;

-- READ -----------------------------------------------------------------------
-- username directory: needed before sign-in (holds only salts + wrapped keys, never secrets)
drop policy if exists docs_read_users on public.docs;
create policy docs_read_users on public.docs for select to anon, authenticated
  using (parent = 'ilusers');
-- accounts from the first Iron Log wait here (same contents as ilusers: salts + wrapped keys) until their owner signs in
drop policy if exists docs_read_mig on public.docs;
create policy docs_read_mig on public.docs for select to anon, authenticated
  using (parent = 'ilmig');
-- a crew (private group) is visible only to its members; the group id is the invite secret
drop policy if exists docs_read_crew on public.docs;
create policy docs_read_crew on public.docs for select to authenticated
  using (parent like 'ilgrp/%' and private.il_in_group(split_part(path,'/',2)));
-- everything else: only the owner
drop policy if exists docs_read_own on public.docs;
create policy docs_read_own on public.docs for select to authenticated
  using (owner = auth.uid());

-- ACCOUNT MOVE ----------------------------------------------------------------
-- Held rows: ilmig/<username> (directory entry), ilmigd/<username>/{acct,data:<doc>,crew,post:<id>}.
-- They belong to a placeholder user and move under the real login via il_claim().
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values ('00000000-0000-4000-8000-00000000a11d','00000000-0000-0000-0000-000000000000','authenticated','authenticated','account-move@users.ironlog.app',now(),now())
  on conflict (id) do nothing;
-- a held username may only be claimed with the held wrapped key
create or replace function private.il_mig_ok(p text, d jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.docs m where m.path = 'ilmig/' || split_part(p,'/',2))
      or exists (select 1 from public.docs m where m.path = 'ilmig/' || split_part(p,'/',2)
                 and m.data->'wrap' = d->'wrap' and m.data->>'acct' = d->>'acct');
$$;
create or replace function private.il_acct_free(acct text) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.docs m where m.parent = 'ilmig' and m.data->>'acct' = acct);
$$;
revoke all on function private.il_mig_ok(text,jsonb), private.il_acct_free(text) from public, anon;
grant execute on function private.il_mig_ok(text,jsonb), private.il_acct_free(text) to authenticated;

create or replace function public.il_claim(u text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); dir jsonb; mig jsonb; acct text; gid text; r record; n int := 0;
begin
  if me is null then raise exception 'sign in first'; end if;
  select data into mig from public.docs where path = 'ilmig/' || u;
  if mig is null then return jsonb_build_object('ok', false, 'reason', 'nothing to move'); end if;
  select data into dir from public.docs where path = 'ilusers/' || u and owner = me;
  if dir is null or dir->'wrap' is distinct from mig->'wrap' or dir->>'acct' is distinct from mig->>'acct' then
    raise exception 'not your account';
  end if;
  acct := mig->>'acct';
  gid := (select data->>'crew' from public.docs where path = 'ilmigd/' || u || '/acct');
  insert into public.docs(path, parent, owner, data)
    select 'ilacct/' || acct, 'ilacct', me, data from public.docs where path = 'ilmigd/' || u || '/acct'
  on conflict (path) do nothing;
  for r in select path, data from public.docs where parent = 'ilmigd/' || u and split_part(path,'/',3) like 'data:%' loop
    insert into public.docs(path, parent, owner, data)
      values ('ilacct/' || acct || '/data/' || substr(split_part(r.path,'/',3), 6), 'ilacct/' || acct || '/data', me, r.data)
      on conflict (path) do nothing;
    n := n + 1;
  end loop;
  if gid is not null then
    insert into public.docs(path, parent, owner, data)
      select 'ilgrp/' || gid || '/m/' || acct, 'ilgrp/' || gid || '/m', me, data from public.docs where path = 'ilmigd/' || u || '/crew'
    on conflict (path) do nothing;
    for r in select path, data from public.docs where parent = 'ilmigd/' || u and split_part(path,'/',3) like 'post:%' loop
      insert into public.docs(path, parent, owner, data)
        values ('ilgrp/' || gid || '/m/' || acct || '/posts/' || substr(split_part(r.path,'/',3), 6), 'ilgrp/' || gid || '/m/' || acct || '/posts', me, r.data)
        on conflict (path) do nothing;
    end loop;
  end if;
  delete from public.docs where path = 'ilmig/' || u or parent = 'ilmigd/' || u;
  return jsonb_build_object('ok', true, 'chunks', n, 'crew', gid);
end $$;
revoke all on function public.il_claim(text) from public, anon;
grant execute on function public.il_claim(text) to authenticated;

-- WRITE ----------------------------------------------------------------------
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (
    owner = auth.uid() and (
         (parent = 'ilusers' and private.il_mig_ok(path, data))          -- claim a username (held ones need the held key)
      or (parent = 'ilacct' and private.il_acct_free(split_part(path,'/',2)))  -- create my account record
      or (parent like 'ilacct/%/data' and private.il_owns_acct(split_part(path,'/',2)))
      or (parent = 'data/users/' || auth.uid()::text)                    -- my private backup space
      or (path ~ '^ilgrp/[a-z0-9]{20,40}/m/[^/]+(/(posts|likes|comments|nudges)/[^/]+)?$'
          and private.il_owns_acct(split_part(path,'/',4)))              -- crews: only under my own account
    ));
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated
  using (owner = auth.uid());
