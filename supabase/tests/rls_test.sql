-- Row-level-security check for public.docs. Safe to run on the live project:
-- creates two throwaway users, probes as each, then deletes them (their rows cascade away).
-- Run in the Supabase SQL editor; every row's result should match its "expect".
create temp table if not exists rls_results(n int, test text, result text);
truncate rls_results;
do $$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); r text; c int;
begin
  insert into auth.users(id, email, aud, role, instance_id) values
    (a,'rlstest-a@users.ironlog.app','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
    (b,'rlstest-b@users.ironlog.app','authenticated','authenticated','00000000-0000-0000-0000-000000000000');
  grant insert on rls_results to authenticated, anon;
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  set local role authenticated;
  begin insert into docs(path,parent,data) values ('ilusers/rlsalice','ilusers','{"acct":"acctA"}'); r:='ok'; exception when others then r:='denied: '||sqlerrm; end; insert into rls_results values (1,'alice claims username (expect ok)', r);
  begin insert into docs(path,parent,data) values ('ilacct/acctA','ilacct','{}'); r:='ok'; exception when others then r:='denied: '||sqlerrm; end; insert into rls_results values (2,'alice creates account record (expect ok)', r);
  begin insert into docs(path,parent,data) values ('ilacct/acctA/data/m','ilacct/acctA/data','{"secret":1}'); r:='ok'; exception when others then r:='denied: '||sqlerrm; end; insert into rls_results values (3,'alice writes own data (expect ok)', r);
  begin insert into docs(path,parent,data) values ('ilcrew/acctA','ilcrew','{"name":"Alice"}'); r:='ok'; exception when others then r:='denied: '||sqlerrm; end; insert into rls_results values (4,'alice joins crew (expect ok)', r);
  begin insert into docs(path,parent,data) values ('ilcrew/acctA/posts/p1','ilcrew/acctA/posts','{}'); r:='ok'; exception when others then r:='denied: '||sqlerrm; end; insert into rls_results values (5,'alice posts (expect ok)', r);
  begin insert into docs(path,parent,data) values ('data/users/'||a||'/bk','data/users/'||a,'{}'); r:='ok'; exception when others then r:='denied: '||sqlerrm; end; insert into rls_results values (6,'alice writes private backup (expect ok)', r);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub',b,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into c from docs where path='ilacct/acctA/data/m'; insert into rls_results values (7,'bob reads alice data (expect 0)', c::text);
  select count(*) into c from docs where parent='ilcrew'; insert into rls_results values (8,'bob reads crew (expect 1)', c::text);
  update docs set data='{}' where path='ilusers/rlsalice'; get diagnostics c = row_count; insert into rls_results values (9,'bob overwrites alice username (expect 0)', c::text);
  update docs set data='{}' where path='ilacct/acctA/data/m'; get diagnostics c = row_count; insert into rls_results values (10,'bob overwrites alice data (expect 0)', c::text);
  delete from docs where path like 'ilcrew/acctA%'; get diagnostics c = row_count; insert into rls_results values (11,'bob deletes alice crew card (expect 0)', c::text);
  begin insert into docs(path,parent,data) values ('ilacct/acctA/data/c9','ilacct/acctA/data','{}'); r:='ALLOWED'; exception when others then r:='denied'; end; insert into rls_results values (12,'bob injects into alice data (expect denied)', r);
  begin insert into docs(path,parent,data) values ('ilcrew/acctA/posts/p2','ilcrew/acctA/posts','{}'); r:='ALLOWED'; exception when others then r:='denied'; end; insert into rls_results values (13,'bob posts as alice (expect denied)', r);
  begin insert into docs(path,parent,owner,data) values ('ilusers/rlsfake','ilusers',a,'{}'); r:='ALLOWED'; exception when others then r:='denied'; end; insert into rls_results values (14,'bob inserts a row owned by alice (expect denied)', r);
  begin insert into docs(path,parent,data) values ('data/users/'||a||'/x','data/users/'||a,'{}'); r:='ALLOWED'; exception when others then r:='denied'; end; insert into rls_results values (15,'bob writes into alice private space (expect denied)', r);
  begin insert into docs(path,parent,data) values ('ilcrew/acctA/comments/c1','ilcrew/acctA/comments','{}'); r:='ok'; exception when others then r:='denied: '||sqlerrm; end; insert into rls_results values (16,'bob comments on alice (expect ok)', r);
  begin insert into docs(path,parent,data) values ('evil/x','evil','{}'); r:='ALLOWED'; exception when others then r:='denied'; end; insert into rls_results values (17,'bob writes outside allowed paths (expect denied)', r);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  set local role anon;
  select count(*) into c from docs where path='ilusers/rlsalice'; insert into rls_results values (18,'anon reads username directory (expect 1)', c::text);
  select count(*) into c from docs where parent<>'ilusers'; insert into rls_results values (19,'anon reads anything else (expect 0)', c::text);
  begin insert into docs(path,parent,data) values ('ilusers/anon','ilusers','{}'); r:='ALLOWED'; exception when others then r:='denied'; end; insert into rls_results values (20,'anon writes (expect denied)', r);
  reset role;
  delete from auth.users where id in (a,b);
  select count(*) into c from docs where path like 'ilusers/rls%' or path like 'ilacct/acctA%' or path like 'ilcrew/acctA%'; insert into rls_results values (21,'cleanup (expect 0)', c::text);
end $$;
select n, test, result from rls_results order by n;
