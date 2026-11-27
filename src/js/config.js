/* js/config.js — deployment settings. Safe to commit: the anon key is public by design;
   row-level security in supabase/schema.sql is what protects data.
   Leave both blank to run device-only (no accounts sync, no Crew). */
window.IRONLOG_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  emailDomain: 'users.ironlog.app', // synthetic login addresses: <username>@<emailDomain>; no mail is sent
};
