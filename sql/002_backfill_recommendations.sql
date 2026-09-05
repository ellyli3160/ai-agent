-- ============================================================================
-- Phase 1 附加：從既有的 stock_reports 回填 recommendations
--
-- 為什麼值得做：既有的 100 份報告（2025-03-23 至 2026-09-04）包含 100 筆
-- 首選標的與 324 筆觀察名單。回填之後，記憶層立刻就有樣本可用，
-- 不必等三個月才累積出第一批統計。
--
-- 執行：在 001_phase1_schema.sql 之後執行，可重複執行（on conflict do nothing）
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 回填首選標的
--
-- 過濾條件說明：
--   symbol 需符合美股代碼格式。既有資料中有 9 天的 symbol 是 "N/A"、"暫不推薦"、
--   "無"、"市場觀望"，那是模型在表達「今天不建議進場」卻被迫塞進 symbol 欄位。
--   這些不是標的，不回填；Phase 3 會用獨立的 has_recommendation 欄位正確承接。
--
--   entry_price 需為正數。既有資料有 11 筆缺少有效 price，無法計算報酬，一併排除。
-- ----------------------------------------------------------------------------
insert into recommendations (
  report_date, symbol, role, theme,
  entry_price, target_price, stop_loss,
  confidence, hold_period, heat, reason, note, model, created_at
)
select
  sr.report_date,
  upper(trim(pp->>'symbol')),
  'primary',
  nullif(trim(coalesce(pp->>'theme', '')), ''),
  (pp->>'price')::numeric,
  case when pp->>'target'    ~ '^[0-9]+(\.[0-9]+)?$' then (pp->>'target')::numeric    end,
  case when pp->>'stop_loss' ~ '^[0-9]+(\.[0-9]+)?$' then (pp->>'stop_loss')::numeric end,
  nullif(trim(coalesce(pp->>'confidence',   '')), ''),
  nullif(trim(coalesce(pp->>'hold_time',    '')), ''),
  nullif(trim(coalesce(pp->>'heat',         '')), ''),
  nullif(trim(coalesce(pp->>'reason',       '')), ''),
  nullif(trim(coalesce(pp->>'entry_timing', '')), ''),
  coalesce(sr.model, 'claude'),
  sr.created_at
from stock_reports sr
cross join lateral (
  select (sr.json_data::jsonb) -> 'primary_pick' as pp
) j
where jsonb_typeof(j.pp) = 'object'
  and upper(trim(j.pp->>'symbol')) ~ '^[A-Z][A-Z.\-]{0,5}$'
  and j.pp->>'price' ~ '^[0-9]+(\.[0-9]+)?$'
  and (j.pp->>'price')::numeric > 0
on conflict (report_date, symbol, role) do nothing;


-- ----------------------------------------------------------------------------
-- 2. 回填觀察名單
--
-- watchlist 項目只有 symbol 與 note，沒有價格。進場價從同一份報告的
-- themes[].stocks[] 裡找同代碼的報價補上；找不到就留空，該筆不會進入驗證。
-- ----------------------------------------------------------------------------
insert into recommendations (
  report_date, symbol, role, theme, entry_price, note, model, created_at
)
select
  sr.report_date,
  upper(trim(w->>'symbol')),
  'watchlist',
  px.theme,
  px.price,
  nullif(trim(coalesce(w->>'note', '')), ''),
  coalesce(sr.model, 'claude'),
  sr.created_at
from stock_reports sr
cross join lateral jsonb_array_elements(
  case
    when jsonb_typeof((sr.json_data::jsonb) -> 'watchlist') = 'array'
      then (sr.json_data::jsonb) -> 'watchlist'
    else '[]'::jsonb
  end
) w
left join lateral (
  select
    (s->>'price')::numeric              as price,
    nullif(trim(coalesce(t->>'name','')), '') as theme
  from jsonb_array_elements(
         case
           when jsonb_typeof((sr.json_data::jsonb) -> 'themes') = 'array'
             then (sr.json_data::jsonb) -> 'themes'
           else '[]'::jsonb
         end
       ) t
  cross join lateral jsonb_array_elements(
         case
           when jsonb_typeof(t -> 'stocks') = 'array' then t -> 'stocks'
           else '[]'::jsonb
         end
       ) s
  where upper(trim(s->>'symbol')) = upper(trim(w->>'symbol'))
    and s->>'price' ~ '^[0-9]+(\.[0-9]+)?$'
  limit 1
) px on true
where upper(trim(w->>'symbol')) ~ '^[A-Z][A-Z.\-]{0,5}$'
on conflict (report_date, symbol, role) do nothing;


-- ----------------------------------------------------------------------------
-- 驗收
-- ----------------------------------------------------------------------------
select role, count(*) as 筆數, min(report_date) as 最早, max(report_date) as 最新
from recommendations
group by role
order by role;
-- 預期：primary 約 89 筆、watchlist 約 300 筆上下
-- （primary 100 筆扣掉 9 筆觀望日與部分缺價的列）

select count(*) as 可驗證筆數 from recommendations where entry_price is not null;
