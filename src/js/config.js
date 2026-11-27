/* js/config.js — deployment settings. Safe to commit: the anon key is public by design;
   row-level security in supabase/schema.sql is what protects data.
   Leave both blank to run device-only (no sync between devices, no Crew). */
window.IRONLOG_CONFIG = {
  supabaseUrl: 'https://fmbabihfkejpuwtcjsng.supabase.co',
  supabaseAnonKey: 'sb_publishable_DptrGDqk6Z4q8VlfXISP7A_5Ve9YgLx',
  emailDomain: 'users.ironlog.app', // synthetic login addresses: <username>@<emailDomain>; no mail is sent
};
