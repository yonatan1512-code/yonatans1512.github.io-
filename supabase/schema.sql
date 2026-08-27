-- ============================================================================
-- SmartSaver AI — סכימת Supabase
--
-- מריצים את כל הקובץ פעם אחת ב-Supabase → SQL Editor → New query → Run.
-- אפשר להריץ אותו שוב בבטחה: הכול idempotent (if not exists / drop policy).
--
-- שתי טבלאות:
--   profiles — רשומה אחת לכל משתמש. היעד, ההכנסות, ההוצאות, ההפקדות
--              וההעדפות, בדיוק באותו מבנה שהאתר שומר ב-localStorage.
--   events   — יומן פעולות append-only. מחליף את הגיליון של Google Sheets.
--
-- RLS מופעל על שתיהן, וכל משתמש רואה אך ורק את השורות של עצמו.
-- ============================================================================


-- ============================================================================
-- 1. PROFILES
-- ============================================================================

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  -- כל רשומת המשתמש כ-JSON אחד. אותו מבנה בדיוק כמו smartsaver_user:<email>
  -- ב-localStorage, כדי שהאתר יוכל לקרוא ולכתוב בלי שכבת תרגום.
  data       jsonb       not null default '{}'::jsonb,
  -- חותמת הזמן של הלקוח (Date.now, מילישניות). זה מה שמכריע מי מנצח
  -- בסנכרון בין שני מכשירים — לא now() של השרת, שמושפע משעון ומרשת.
  saved_at   bigint      not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- כל אחת מהפוליסות מוגדרת מחדש בכל הרצה, כדי שהקובץ יהיה בטוח להרצה חוזרת
drop policy if exists "profiles: read own"   on public.profiles;
drop policy if exists "profiles: insert own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;

create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);

-- insert ו-update שניהם נחוצים: הלקוח כותב ב-upsert אחד
-- (POST עם Prefer: resolution=merge-duplicates), וזה נבדק מול שתי הפוליסות.
create policy "profiles: insert own" on public.profiles
  for insert with check (auth.uid() = id);

create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- אין פוליסת delete בכוונה: מחיקת חשבון עוברת דרך auth.users,
-- ו-on delete cascade כבר מנקה מכאן.


-- ============================================================================
-- 2. יצירת פרופיל אוטומטית בהרשמה
-- ============================================================================
-- בלי זה, ההרשמה הראשונה מצליחה אבל אין לאן לכתוב את היעד עד לשמירה הראשונה.
-- security definer נחוץ כי הטריגר רץ בהקשר של auth, שאין לו הרשאה ל-public.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================================
-- 3. updated_at אוטומטי
-- ============================================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();


-- ============================================================================
-- 4. EVENTS — יומן הפעולות
-- ============================================================================
-- אותם שדות בדיוק שהגיליון קיבל, פחות עמודת הסיסמה: מהרגע שיש Supabase Auth
-- אין שום סיבה שסיסמה תעבור בבקשה, ובוודאי לא שתישמר בטבלה.

create table if not exists public.events (
  id        bigserial   primary key,
  user_id   uuid        not null references auth.users(id) on delete cascade,
  ts        timestamptz not null default now(),
  event     text        not null,
  email     text,
  goal_name text,
  goal_cost numeric,
  saved     numeric,
  amount    numeric,
  pct       numeric,
  device    text
);

alter table public.events enable row level security;

drop policy if exists "events: read own"   on public.events;
drop policy if exists "events: insert own" on public.events;

create policy "events: read own" on public.events
  for select using (auth.uid() = user_id);

create policy "events: insert own" on public.events
  for insert with check (auth.uid() = user_id);

-- אין update ואין delete: יומן שאפשר לערוך אותו אינו יומן.

-- השאילתה היחידה שמעניינת היא "הפעולות שלי, החדשות קודם"
create index if not exists events_user_ts_idx on public.events (user_id, ts desc);


-- ============================================================================
-- 5. תצוגה נוחה למי שרוצה להסתכל על הנתונים ב-Table Editor
-- ============================================================================
-- security_invoker=on חשוב: בלעדיו התצוגה הייתה עוקפת את ה-RLS של הטבלה
-- ומחזירה למשתמש גם שורות של אחרים.

create or replace view public.my_progress
with (security_invoker = on) as
select
  p.email,
  p.data->>'goalName'                             as goal_name,
  (p.data->>'goalCost')::numeric                  as goal_cost,
  (p.data->>'alreadySaved')::numeric              as saved,
  jsonb_array_length(coalesce(p.data->'deposits', '[]'::jsonb)) as deposits_count,
  to_timestamp(p.saved_at / 1000.0)               as last_saved,
  p.updated_at
from public.profiles p;
