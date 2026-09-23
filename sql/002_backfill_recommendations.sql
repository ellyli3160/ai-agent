-- ============================================================================
-- Phase 1 附加：從既有的 stock_reports 回填 recommendations
--
-- 為什麼值得做：既有的報告包含大量首選標的與觀察名單。回填之後，
-- 記憶層立刻就有樣本可用，不必等三個月才累積出第一批統計。
--
-- 執行：在 001_phase1_schema.sql 之後執行，可重複執行（on conflict do nothing）
--
-- ⚠️ json_data 是雙重編碼，這份腳本已針對此修正
-- ----------------------------------------------------------------------------
-- 在正式的 daily-us-stock 專案上實測時發現：stock_reports.json_data
-- 的 jsonb_typeof 對所有列都回傳 'string'，不是預期的 'object'。追查到
-- n8n 工作流的「supabase」Code 節點寫的是：
--
--     json_data: JSON.stringify(item.json.json_data)
--
-- 物件先被字串化一次，Supabase 節點寫入 jsonb 欄位時又編碼一次，結果是
-- 「一個字串，內容剛好是 JSON 文字」，不是真正的 JSON 物件。這個問題從
-- 第一筆資料（2025-03-23）就存在，不是最近才壞的。
--
-- 下面所有查詢都用 (json_data #>> '{}')::jsonb 多解開一層。
-- 建議另外把 n8n 那個節點改成 `json_data: item.json.json_data`（不要再
-- JSON.stringify），讓未來寫入的資料是正常的 jsonb 物件；這份回填腳本
-- 不受影響，因為已經處理了雙重編碼，但其他直接查 stock_reports 的工具
-- 會需要記得這一層，源頭修掉比較乾淨。
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
  -- json_data 是雙重編碼：先解開外層字串，再轉一次 jsonb，才是真正的物件
  select ((sr.json_data #>> '{}')::jsonb) -> 'primary_pick' as pp
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
    when jsonb_typeof(((sr.json_data #>> '{}')::jsonb) -> 'watchlist') = 'array'
      then ((sr.json_data #>> '{}')::jsonb) -> 'watchlist'
    else '[]'::jsonb
  end
) w
left join lateral (
  select
    (s->>'price')::numeric              as price,
    nullif(trim(coalesce(t->>'name','')), '') as theme
  from jsonb_array_elements(
         case
           when jsonb_typeof(((sr.json_data #>> '{}')::jsonb) -> 'themes') = 'array'
             then ((sr.json_data #>> '{}')::jsonb) -> 'themes'
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
-- 已在 daily-us-stock 專案實測（2026-09-22）：primary 98 筆、watchlist 355 筆

select count(*) as 可驗證筆數 from recommendations where entry_price is not null;
