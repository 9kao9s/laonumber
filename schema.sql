-- ============================================================================
-- LUCKY LIFF  ·  Supabase schema
-- วางทั้งไฟล์นี้ใน Supabase Dashboard > SQL Editor > Run  (ครั้งเดียว)
-- ============================================================================

create extension if not exists pg_cron;

-- ── ตาราง ───────────────────────────────────────────────────────────────────

create table if not exists draws (
  id            bigserial primary key,
  draw_date     date        not null unique,
  status        text        not null default 'open'
                            check (status in ('open','closed','settled')),
  opens_at      timestamptz,
  closes_at     timestamptz,
  top_result    char(2),
  bottom_result char(2),
  settled_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists line_users (
  line_user_id text primary key,
  display_name text,
  picture_url  text,
  blocked      boolean     not null default false,
  block_reason text,
  play_count   int         not null default 0,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

create table if not exists entries (
  id            bigserial primary key,
  draw_id       bigint      not null references draws(id) on delete cascade,
  line_user_id  text        references line_users(line_user_id),
  display_name  text        not null,
  top_number    char(2)     not null check (top_number ~ '^[0-9]{2}$'),
  bottom_number char(2)     not null check (bottom_number ~ '^[0-9]{2}$'),
  source        text        not null default 'liff'
                            check (source in ('liff','admin')),
  ref_code      text,
  invite_token  text,
  admin_note    text,
  created_by    uuid        references auth.users(id),
  won_top       boolean     not null default false,
  won_bottom    boolean     not null default false,
  payout        numeric(10,2) not null default 0,
  created_at    timestamptz not null default now()
);

-- เลขหนึ่งตัวมีเจ้าของได้คนเดียวต่อหนึ่งงวด
create unique index if not exists uq_entries_top
  on entries (draw_id, top_number);
create unique index if not exists uq_entries_bottom
  on entries (draw_id, bottom_number);

-- 1 บัญชี LINE = 1 สิทธิ์ต่องวด  (แถวที่แอดมินเพิ่มเองไม่นับ)
create unique index if not exists uq_entries_user
  on entries (draw_id, line_user_id) where source = 'liff';

create index if not exists idx_entries_draw    on entries (draw_id);
create index if not exists idx_entries_ref     on entries (ref_code);
create index if not exists idx_entries_created on entries (created_at desc);

-- ทุกครั้งที่มีคนเปิดลิงก์ จะถูกบันทึกที่นี่
create table if not exists link_clicks (
  id           bigserial primary key,
  ref_code     text,
  invite_token text,
  line_user_id text,
  referrer     text,
  user_agent   text,
  in_line_app  boolean,
  entry_id     bigint      references entries(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_clicks_ref     on link_clicks (ref_code);
create index if not exists idx_clicks_created on link_clicks (created_at desc);
create index if not exists idx_clicks_user    on link_clicks (line_user_id);

create table if not exists app_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

create table if not exists draw_notes (
  draw_id    bigint primary key references draws(id) on delete cascade,
  note       text,
  updated_at timestamptz not null default now()
);

create table if not exists admin_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text        not null default 'admin',
  created_at timestamptz not null default now()
);

create table if not exists admin_logs (
  id         bigserial primary key,
  actor      uuid,
  action     text not null,
  details    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_logs_created on admin_logs (created_at desc);


-- ── ค่าตั้งต้น ───────────────────────────────────────────────────────────────

insert into app_settings (key, value) values
  ('site_title',        'เลขนำโชค Free ทุกวันที่มีหวยลาว'),
  ('site_subtitle',     'แทงฟรี หวยลาว ทุกวัน จันทร์ - ศุกร์'),
  ('hero_text',         'เล่นฟรีวันละ 1 ครั้ง · เงินรางวัลเลขละ 100 บาท'),
  ('receipt_title',     'LUCKY'),
  ('receipt_subtitle',  'ส่งภาพนี้ให้แอดมินทันที รับรางวัลก่อน 20.40 น.'),
  ('prize_per_number',  '100'),
  ('open_time',         '09:00'),
  ('close_time',        '20:10'),
  ('open_days',         '1,2,3,4,5'),
  ('admin_line_url',    ''),
  ('result_url',        ''),
  ('closed_message',    'ยังไม่ถึงเวลาเปิดรับเลขของวันนี้')
on conflict (key) do nothing;


-- ── ฟังก์ชัน ────────────────────────────────────────────────────────────────

create or replace function bkk_today() returns date
language sql stable as $$
  select (now() at time zone 'Asia/Bangkok')::date;
$$;

create or replace function setting(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select value from app_settings where key = p_key;
$$;

-- สร้างงวดของวันนี้ถ้ายังไม่มี แล้วคืนแถวนั้นกลับมา
-- ทำงานตามเวลา Asia/Bangkok และตามวันที่ตั้งไว้ใน open_days
create or replace function ensure_today_draw() returns draws
language plpgsql security definer set search_path = public as $$
declare
  v_today date := bkk_today();
  v_dow   int  := extract(isodow from v_today);
  v_open  time := coalesce(setting('open_time'),  '09:00')::time;
  v_close time := coalesce(setting('close_time'), '20:10')::time;
  v_days  text := coalesce(setting('open_days'),  '1,2,3,4,5');
  v_draw  draws;
begin
  if position(v_dow::text in v_days) = 0 then
    select * into v_draw from draws where draw_date = v_today;
    return v_draw;                                    -- วันหยุด ไม่เปิดงวดใหม่
  end if;

  insert into draws (draw_date, status, opens_at, closes_at)
  values (
    v_today,
    'open',
    ((v_today + v_open) at time zone 'Asia/Bangkok'),
    ((v_today + v_close) at time zone 'Asia/Bangkok')
  )
  on conflict (draw_date) do nothing;

  select * into v_draw from draws where draw_date = v_today;
  return v_draw;
end;
$$;

-- งวดที่ "เปิดรับเลขอยู่ตอนนี้จริง ๆ" (ผ่านทั้งสถานะและช่วงเวลา)
create or replace function current_draw() returns draws
language plpgsql stable security definer set search_path = public as $$
declare v_draw draws;
begin
  select * into v_draw from draws where draw_date = bkk_today();
  if v_draw.id is null or v_draw.status <> 'open' then
    return null;
  end if;
  if v_draw.opens_at  is not null and now() < v_draw.opens_at  then return null; end if;
  if v_draw.closes_at is not null and now() > v_draw.closes_at then return null; end if;
  return v_draw;
end;
$$;

-- ปิดงวดที่เลยเวลาปิดแล้ว (ให้ pg_cron เรียก)
create or replace function close_expired_draws() returns void
language sql security definer set search_path = public as $$
  update draws set status = 'closed'
  where status = 'open' and closes_at is not null and now() > closes_at;
$$;

/*
 * จองเลข — หัวใจของระบบ
 * เรียกจาก Edge Function เท่านั้น (service_role) หลังจาก verify LINE token แล้ว
 * ทุกเงื่อนไขถูกบังคับที่นี่ ไม่ใช่ที่หน้าเว็บ
 */
create or replace function claim_entry(
  p_line_user_id text,
  p_display_name text,
  p_top          char(2),
  p_bottom       char(2),
  p_ref          text default null,
  p_invite       text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_draw    draws;
  v_entry   entries;
  v_blocked boolean;
begin
  if p_top !~ '^[0-9]{2}$' or p_bottom !~ '^[0-9]{2}$' then
    return json_build_object('ok', false, 'code', 'BAD_NUMBER',
      'message', 'เลขบนและล่างต้องเป็นตัวเลข 2 หลัก');
  end if;

  perform ensure_today_draw();
  v_draw := current_draw();

  if v_draw.id is null then
    return json_build_object('ok', false, 'code', 'CLOSED',
      'message', coalesce(setting('closed_message'), 'ยังไม่ถึงเวลาเปิดรับเลข'));
  end if;

  select blocked into v_blocked from line_users where line_user_id = p_line_user_id;
  if coalesce(v_blocked, false) then
    return json_build_object('ok', false, 'code', 'BLOCKED',
      'message', 'บัญชีนี้ถูกระงับสิทธิ์ ติดต่อแอดมิน');
  end if;

  if exists (select 1 from entries
             where draw_id = v_draw.id and line_user_id = p_line_user_id
               and source = 'liff') then
    return json_build_object('ok', false, 'code', 'ALREADY_PLAYED',
      'message', 'บัญชี LINE นี้ใช้สิทธิ์ของวันนี้แล้ว');
  end if;

  if exists (select 1 from entries where draw_id = v_draw.id and top_number = p_top) then
    return json_build_object('ok', false, 'code', 'TOP_TAKEN',
      'message', '2 ตัวบน ' || p_top || ' มีคนเลือกไปแล้ว');
  end if;

  if exists (select 1 from entries where draw_id = v_draw.id and bottom_number = p_bottom) then
    return json_build_object('ok', false, 'code', 'BOTTOM_TAKEN',
      'message', '2 ตัวล่าง ' || p_bottom || ' มีคนเลือกไปแล้ว');
  end if;

  insert into entries (draw_id, line_user_id, display_name, top_number,
                       bottom_number, source, ref_code, invite_token)
  values (v_draw.id, p_line_user_id, left(trim(p_display_name), 40), p_top,
          p_bottom, 'liff', p_ref, p_invite)
  returning * into v_entry;

  update line_users
     set play_count = play_count + 1, last_seen = now()
   where line_user_id = p_line_user_id;

  -- ผูกคลิกล่าสุดของคนนี้เข้ากับ entry เพื่อวัด conversion ของลิงก์
  update link_clicks
     set entry_id = v_entry.id
   where id = (select id from link_clicks
                where line_user_id = p_line_user_id and entry_id is null
                order by created_at desc limit 1);

  return json_build_object('ok', true, 'entry', row_to_json(v_entry),
                           'draw', row_to_json(v_draw));

exception
  when unique_violation then
    return json_build_object('ok', false, 'code', 'RACE',
      'message', 'มีคนจองเลขนี้ตัดหน้าไปพอดี กรุณาเลือกใหม่');
end;
$$;

-- ประกาศผลและคำนวณเงินรางวัล
create or replace function settle_draw(
  p_draw_id bigint, p_top char(2), p_bottom char(2)
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_prize numeric := coalesce(setting('prize_per_number'), '100')::numeric;
  v_count int;
begin
  update entries
     set won_top    = (top_number = p_top),
         won_bottom = (bottom_number = p_bottom),
         payout     = (case when top_number    = p_top    then v_prize else 0 end)
                    + (case when bottom_number = p_bottom then v_prize else 0 end)
   where draw_id = p_draw_id;

  get diagnostics v_count = row_count;

  update draws
     set top_result = p_top, bottom_result = p_bottom,
         status = 'settled', settled_at = now()
   where id = p_draw_id;

  return json_build_object('ok', true, 'updated', v_count);
end;
$$;

-- สรุปรายวันสำหรับหน้าหลังบ้าน
create or replace view v_draw_summary
with (security_invoker = on) as
select d.id,
       d.draw_date,
       d.status,
       d.top_result,
       d.bottom_result,
       count(e.id)                                        as entry_count,
       count(distinct e.line_user_id)                     as player_count,
       200 - (count(e.id) * 2)                            as numbers_left,
       count(*) filter (where e.won_top or e.won_bottom)  as winner_count,
       coalesce(sum(e.payout), 0)                         as total_payout,
       n.note
  from draws d
  left join entries    e on e.draw_id = d.id
  left join draw_notes n on n.draw_id = d.id
 group by d.id, n.note
 order by d.draw_date desc;


-- ── ความปลอดภัย ─────────────────────────────────────────────────────────────
-- หลักการ: anon key อ่านได้อย่างเดียว การเขียนทุกอย่างผ่าน Edge Function
--          ที่ verify LINE token แล้วเท่านั้น

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admin_users where user_id = auth.uid());
$$;

alter table draws       enable row level security;
alter table entries     enable row level security;
alter table line_users  enable row level security;
alter table link_clicks enable row level security;
alter table app_settings enable row level security;
alter table draw_notes  enable row level security;
alter table admin_users enable row level security;
alter table admin_logs  enable row level security;

-- หน้าลูกค้าอ่านกระดานเลขได้
drop policy if exists p_draws_read on draws;
create policy p_draws_read on draws
  for select to anon, authenticated using (true);

drop policy if exists p_entries_read on entries;
create policy p_entries_read on entries
  for select to anon, authenticated using (true);

drop policy if exists p_settings_read on app_settings;
create policy p_settings_read on app_settings
  for select to anon, authenticated using (true);

-- แต่ anon เห็นได้แค่ 4 คอลัมน์นี้ของ entries เท่านั้น
-- line_user_id / ref_code / admin_note ถูกกันไว้ที่ระดับ column grant
revoke all on entries from anon;
grant select (draw_id, top_number, bottom_number, display_name, created_at, won_top, won_bottom)
  on entries to anon;

revoke all on line_users, link_clicks, admin_users, admin_logs, draw_notes from anon;

-- แอดมินทำได้ทุกอย่าง
do $$
declare t text;
begin
  foreach t in array array['draws','entries','line_users','link_clicks',
                           'app_settings','draw_notes','admin_users','admin_logs']
  loop
    execute format('drop policy if exists p_%1$s_admin on %1$s', t);
    execute format(
      'create policy p_%1$s_admin on %1$s for all to authenticated
       using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;


-- ฟังก์ชันที่เขียนข้อมูลต้องเรียกได้เฉพาะ service_role (Edge Function)
-- หรือแอดมินที่ล็อกอินแล้วเท่านั้น
revoke execute on function claim_entry(text, text, char, char, text, text)
  from anon, authenticated;
revoke execute on function ensure_today_draw()  from anon;
revoke execute on function close_expired_draws() from anon, authenticated;
revoke execute on function settle_draw(bigint, char, char) from anon;

-- กันไว้อีกชั้น เผื่อมีคนยิง rpc ตรงด้วย anon key
create or replace function settle_draw(
  p_draw_id bigint, p_top char(2), p_bottom char(2)
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_prize numeric := coalesce(setting('prize_per_number'), '100')::numeric;
  v_count int;
begin
  if not is_admin() then
    raise exception 'ต้องเป็นแอดมินเท่านั้น';
  end if;

  update entries
     set won_top    = (top_number = p_top),
         won_bottom = (bottom_number = p_bottom),
         payout     = (case when top_number    = p_top    then v_prize else 0 end)
                    + (case when bottom_number = p_bottom then v_prize else 0 end)
   where draw_id = p_draw_id;

  get diagnostics v_count = row_count;

  update draws
     set top_result = p_top, bottom_result = p_bottom,
         status = 'settled', settled_at = now()
   where id = p_draw_id;

  insert into admin_logs (actor, action, details)
  values (auth.uid(), 'SETTLE_DRAW',
          jsonb_build_object('draw_id', p_draw_id, 'top', p_top, 'bottom', p_bottom));

  return json_build_object('ok', true, 'updated', v_count);
end;
$$;


-- ── Realtime : กระดานเลขอัปเดตสดโดยไม่ต้อง poll ─────────────────────────────
alter publication supabase_realtime add table entries;


-- ── งานอัตโนมัติ ────────────────────────────────────────────────────────────
-- เปิดงวดใหม่ทุกวัน 09:00 และปิดทุก ๆ 10 นาทีถ้าเลยเวลา (เวลา UTC ในตาราง cron)
select cron.schedule('lucky-open-draw',  '0 2 * * *',   $$select ensure_today_draw()$$);
select cron.schedule('lucky-close-draw', '*/10 * * * *', $$select close_expired_draws()$$);
