-- ============================================================================
-- Phase 1 延伸：把 VIX 指數與市場情緒存進 recommendations
--
-- 目的：VIX 跟 market_sentiment 是「整份報告」層級的資訊（同一天的每一筆
-- 推薦都共用同一個值），不是個股層級的欄位，但這裡沿用既有表格的設計
-- （沒有另外建 daily_market_context 表），每筆推薦都重複記一份，
-- 用 report_date 就能查到同一天的所有推薦共用同一組數值。
--
-- 這麼做是為了能回頭用資料查證，而不是靠印象判斷：
--   1. 系統在高 VIX（恐慌）環境下的實際勝率是不是真的比較差
--   2. 模型自己寫的 market_sentiment 是否真的符合它自己訂的 VIX 門檻
--      （看多：VIX < 18；中性：18-25；看空：> 25）
--
-- market_sentiment 直接存模型輸出的原始字串（例如「中性｜半導體與量子題材
-- 帶動局部熱度」），不拆解、不限制成 enum——之前分析歷史資料時就發現這個
-- 欄位實際出現過 7 種不同寫法，不是 prompt 定義的三個值，拆解成 enum
-- 反而會遺失原始資訊，之後真的要分類統計再另外處理。
--
-- 執行：在 001~004 之後執行，可重複執行（add column if not exists）
-- ============================================================================

alter table recommendations
  add column if not exists vix_close numeric(6,2),
  add column if not exists vix_date  date,
  add column if not exists market_sentiment text;


-- ----------------------------------------------------------------------------
-- 驗收
-- ----------------------------------------------------------------------------
select column_name, data_type
from information_schema.columns
where table_name = 'recommendations'
  and column_name in ('vix_close', 'vix_date', 'market_sentiment');
