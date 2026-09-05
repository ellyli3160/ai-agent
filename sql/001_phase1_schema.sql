-- ============================================================================
-- Phase 1：績效驗證的資料基礎
--
-- 目的：讓每日推薦可被追蹤，並在 3 / 7 / 30 個交易日後回填實際報酬。
-- 執行：Supabase Dashboard → SQL Editor → 整份貼上執行（可重複執行）
--
-- 這份 schema 不動既有的 stock_reports 表，分析工作流的邏輯也完全不變。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 市場行事曆
--
-- 用於計算「經過幾個交易日」。日期依 NYSE / Nasdaq 假期規則推算，
-- 上線前請對照 NYSE 官方行事曆確認一次，特別是 Good Friday（隨復活節浮動）。
-- ----------------------------------------------------------------------------
create table if not exists market_holidays (
  holiday_date date primary key,
  name         text not null
);

insert into market_holidays (holiday_date, name) values
  ('2025-01-01', 'New Year''s Day'),
  ('2025-01-09', 'National Day of Mourning (Carter)'),
  ('2025-01-20', 'Martin Luther King Jr. Day'),
  ('2025-02-17', 'Washington''s Birthday'),
  ('2025-04-18', 'Good Friday'),
  ('2025-05-26', 'Memorial Day'),
  ('2025-06-19', 'Juneteenth'),
  ('2025-07-04', 'Independence Day'),
  ('2025-09-01', 'Labor Day'),
  ('2025-11-27', 'Thanksgiving Day'),
  ('2025-12-25', 'Christmas Day'),
  ('2026-01-01', 'New Year''s Day'),
  ('2026-01-19', 'Martin Luther King Jr. Day'),
  ('2026-02-16', 'Washington''s Birthday'),
  ('2026-04-03', 'Good Friday'),
  ('2026-05-25', 'Memorial Day'),
  ('2026-06-19', 'Juneteenth'),
  ('2026-07-03', 'Independence Day (observed)'),
  ('2026-09-07', 'Labor Day'),
  ('2026-11-26', 'Thanksgiving Day'),
  ('2026-12-25', 'Christmas Day'),
  ('2027-01-01', 'New Year''s Day'),
  ('2027-01-18', 'Martin Luther King Jr. Day'),
  ('2027-02-15', 'Washington''s Birthday'),
  ('2027-03-26', 'Good Friday'),
  ('2027-05-31', 'Memorial Day'),
  ('2027-06-18', 'Juneteenth (observed)'),
  ('2027-07-05', 'Independence Day (observed)'),
  ('2027-09-06', 'Labor Day'),
  ('2027-11-25', 'Thanksgiving Day'),
  ('2027-12-24', 'Christmas Day (observed)')
on conflict (holiday_date) do nothing;


-- 計算兩個日期之間經過的交易日數（不含起始日，含結束日）
create or replace function trading_days_between(from_date date, to_date date)
returns integer
language sql
stable
as $$
  select coalesce(count(*), 0)::integer
  from generate_series(from_date + 1, to_date, interval '1 day') as d
  where extract(isodow from d) < 6
    and not exists (
      select 1 from market_holidays h where h.holiday_date = d::date
    );
$$;


-- ----------------------------------------------------------------------------
-- 2. 推薦紀錄
--
-- 從報告 JSON 裡拆出來獨立成表，因為驗證與統計都是以「單筆推薦」為單位，
-- 留在 json_data 欄位裡查不動也算不了。
--
-- entry_price 說明：報告在盤前產生，Finnhub /quote 此時回傳的是前一交易日
-- 收盤價，所以進場價基準是「報告日的前一個收盤」。這代表 3 日報酬實際涵蓋
-- 報告當日在內的 4 個交易日。這是一致的偏移，跨筆比較不受影響，但解讀
-- 絕對數字時要記得。
-- ----------------------------------------------------------------------------
create table if not exists recommendations (
  id           bigserial primary key,
  report_date  date not null,
  symbol       text not null,
  role         text not null check (role in ('primary', 'watchlist')),
  theme        text,
  entry_price  numeric(12,4),
  target_price numeric(12,4),
  stop_loss    numeric(12,4),
  confidence   text,
  hold_period  text,
  heat         text,
  reason       text,
  note         text,
  model        text not null default 'claude',
  created_at   timestamptz not null default now(),
  unique (report_date, symbol, role)
);

create index if not exists idx_rec_symbol_date on recommendations (symbol, report_date desc);
create index if not exists idx_rec_report_date on recommendations (report_date desc);
create index if not exists idx_rec_role        on recommendations (role, report_date desc);


-- ----------------------------------------------------------------------------
-- 3. 驗證結果
--
-- price_basis 固定為 'close'：W4 在收盤後執行，取當日收盤價。
-- 因此 hit_target / hit_stop 是「收盤價是否已達標」，不是「盤中是否觸及」。
-- 要做到盤中觸價判斷需要逐日追蹤高低點，留待後續階段。
-- ----------------------------------------------------------------------------
create table if not exists verifications (
  id                   bigserial primary key,
  recommendation_id    bigint not null references recommendations(id) on delete cascade,
  horizon              text not null check (horizon in ('3d', '7d', '30d')),
  price_then           numeric(12,4),
  return_pct           numeric(8,3),
  hit_target           boolean,
  hit_stop             boolean,
  elapsed_trading_days integer not null,
  price_basis          text not null default 'close',
  source               text not null default 'finnhub',
  verified_at          timestamptz not null default now(),
  unique (recommendation_id, horizon)
);

create index if not exists idx_ver_rec on verifications (recommendation_id);


-- ----------------------------------------------------------------------------
-- 4. 待驗證清單（W4 每日讀這張 view）
--
-- 條件是「已滿 N 個交易日，但不超過 N + 3」。
--
-- 下限放寬（不是「剛好第 N 天」）是為了讓工作流某天沒跑成功時隔天能自動補上；
-- 上限則是必要的防護：W4 取的是「執行當下」的報價，若不設上限，一筆三個月前的
-- 推薦會被用今天的收盤價記成它的 3 日報酬，產生完全錯誤的統計。
-- 錯過窗口的推薦寧可留白不驗證，也不要填進假資料。
--
-- 實際延後幾天記錄在 elapsed_trading_days，統計時可據此判斷資料新鮮度。
-- ----------------------------------------------------------------------------
create or replace view v_pending_verifications as
with et as (
  select (now() at time zone 'America/New_York')::date as today
)
select
  r.id          as recommendation_id,
  r.report_date,
  r.symbol,
  r.role,
  r.entry_price,
  r.target_price,
  r.stop_loss,
  h.horizon,
  trading_days_between(r.report_date, et.today) as elapsed_trading_days
from recommendations r
cross join et
cross join (values ('3d', 3), ('7d', 7), ('30d', 30)) as h(horizon, required_days)
where r.entry_price is not null
  and r.report_date >= et.today - interval '120 days'
  and trading_days_between(r.report_date, et.today) >= h.required_days
  and trading_days_between(r.report_date, et.today) <= h.required_days + 3
  and not exists (
    select 1 from verifications v
    where v.recommendation_id = r.id
      and v.horizon = h.horizon
  );


-- ----------------------------------------------------------------------------
-- 5. 推薦結果彙總（回寫 Google Sheets 用，也是之後記憶層的統計來源）
-- ----------------------------------------------------------------------------
create or replace view v_recommendation_results as
select
  r.id as recommendation_id,
  r.report_date,
  r.symbol,
  r.role,
  r.theme,
  r.confidence,
  r.entry_price,
  max(v.return_pct) filter (where v.horizon = '3d')  as return_3d,
  max(v.return_pct) filter (where v.horizon = '7d')  as return_7d,
  max(v.return_pct) filter (where v.horizon = '30d') as return_30d,
  max(v.price_then) filter (where v.horizon = '3d')  as price_3d,
  max(v.price_then) filter (where v.horizon = '7d')  as price_7d,
  max(v.price_then) filter (where v.horizon = '30d') as price_30d,
  bool_or(v.hit_target) as ever_hit_target,
  bool_or(v.hit_stop)   as ever_hit_stop,
  count(v.id)           as verified_count
from recommendations r
join verifications v on v.recommendation_id = r.id
where r.report_date >= (now() at time zone 'America/New_York')::date - interval '180 days'
group by r.id, r.report_date, r.symbol, r.role, r.theme, r.confidence, r.entry_price;


-- ----------------------------------------------------------------------------
-- 6. 權限與安全
--
-- 開啟 RLS 且不建立任何 policy，代表只有 service_role 能存取。
-- n8n 的 Supabase 憑證使用 service_role key，因此工作流不受影響，
-- 而 anon key（前端可見）完全讀不到這些資料。
-- ----------------------------------------------------------------------------
alter table market_holidays  enable row level security;
alter table recommendations  enable row level security;
alter table verifications    enable row level security;

-- PostgreSQL 15 以上才支援 security_invoker，若報錯可略過這兩行
alter view v_pending_verifications  set (security_invoker = on);
alter view v_recommendation_results set (security_invoker = on);

grant select on v_pending_verifications, v_recommendation_results to service_role;


-- ----------------------------------------------------------------------------
-- 驗收：執行後應該看到三張表、兩個 view，且交易日函式回傳正確值
-- ----------------------------------------------------------------------------
-- 2026-08-24（一）到 2026-08-27（四）應為 3 個交易日
select trading_days_between('2026-08-24', '2026-08-27') as should_be_3;
-- 跨越勞動節（2026-09-07 週一）：09-04（五）到 09-09（三）應為 3 個交易日
select trading_days_between('2026-09-04', '2026-09-09') as should_be_3_across_holiday;
