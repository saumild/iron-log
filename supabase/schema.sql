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

-- READ -----------------------------------------------------------------------
-- username directory: needed before sign-in (holds only salts + wrapped keys, never secrets)
drop policy if exists docs_read_users on public.docs;
create policy docs_read_users on public.docs for select to anon, authenticated
  using (parent = 'ilusers');
-- Crew is visible to every signed-in member
drop policy if exists docs_read_crew on public.docs;
create policy docs_read_crew on public.docs for select to authenticated
  using (parent = 'ilcrew' or parent like 'ilcrew/%');
-- everything else: only the owner
drop policy if exists docs_read_own on public.docs;
create policy docs_read_own on public.docs for select to authenticated
  using (owner = auth.uid());

-- WRITE ----------------------------------------------------------------------
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (
    owner = auth.uid() and (
         parent = 'ilusers'                                              -- claim a username
      or parent = 'ilacct'                                               -- create my account record
      or (parent like 'ilacct/%/data'  and private.il_owns_acct(split_part(path,'/',2)))
      or (parent = 'data/users/' || auth.uid()::text)                    -- my private backup space
      or (parent = 'ilcrew'            and private.il_owns_acct(split_part(path,'/',2)))   -- my member card
      or (parent like 'ilcrew/%/posts' and private.il_owns_acct(split_part(path,'/',2)))   -- my posts
      or parent ~ '^ilcrew/[^/]+/(likes|comments|nudges)$'               -- interact with others
    ));
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated
  using (owner = auth.uid());
