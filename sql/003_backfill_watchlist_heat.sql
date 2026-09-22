-- ============================================================================
-- Phase 1 附加：補齊 watchlist 的 heat 欄位
--
-- 002_backfill_recommendations.sql 的 watchlist 回填語句漏掉了 heat，
-- 只處理了 theme／entry_price／note。這裡用同樣的邏輯（從
-- themes[].stocks[] 找同代碼的資料）補上 heat，只更新目前是 null 的列，
-- 不會動到未來由 n8n「拆出推薦紀錄」節點正常寫入的資料
-- （那個節點從一開始就有處理 heat，不受影響）。
--
-- 執行：在 002_backfill_recommendations.sql 之後執行，可重複執行
-- （只更新 heat is null 的列，已經補過的不會被覆蓋）
--
-- ⚠️ 同樣要處理 json_data 雙重編碼，見 002 檔案開頭的說明
-- ============================================================================

update recommendations r
set heat = px.heat
from (
  select distinct on (sr.report_date, upper(trim(s->>'symbol')))
    sr.report_date,
    upper(trim(s->>'symbol')) as symbol,
    nullif(trim(coalesce(t->>'heat', '')), '') as heat
  from stock_reports sr
  cross join lateral jsonb_array_elements(
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
  where s->>'symbol' is not null
  order by sr.report_date, upper(trim(s->>'symbol'))
) px
where r.role = 'watchlist'
  and r.heat is null
  and r.report_date = px.report_date
  and r.symbol = px.symbol
  and px.heat is not null;

-- ----------------------------------------------------------------------------
-- 驗收
-- ----------------------------------------------------------------------------
-- 已在 daily-us-stock 專案實測（2026-09-22）：355 筆 null 補到剩 164 筆。
-- 剩下的 164 筆是那些標的本來就沒出現在 themes[].stocks[] 裡，
-- 資料源頭沒有這項資訊，不是這支腳本的問題。
select heat, count(*) from recommendations where role = 'watchlist' group by heat order by count(*) desc;
