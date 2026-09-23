-- ============================================================================
-- Phase 1 延伸：候選標的歷史推薦紀錄（記憶層第一步）
--
-- 目的：讓報告生成的 AI 在挑選首選標的之前，能看到每檔候選標的過去被
-- 推薦過幾次、結果如何。這是直接回應一個從真實資料觀察到的現象：
-- 重複推薦同一檔股票的達標率明顯低於首次推薦（62% vs 38%，橫跨
-- LMT / CRWD / XOM 三個不相關的產業獨立驗證過），但目前的工作流完全沒有
-- 記憶，模型看不到自己過去推薦過這檔股票、結果好不好。
--
-- 這個 view 本身不改變任何既有資料，只是彙總 recommendations 與
-- verifications，供 n8n 在生成報告前查詢。
--
-- ⚠️ 刻意不透過 v_recommendation_results：那個 view 限制只看「報告日在過去
-- 180 天內」的資料（給 Google Sheets 同步用，設計上沒問題）。如果這裡借用
-- 它，會在資料變舊之後出現詭異的回歸：一筆推薦已經在 verifications 表裡有
-- 真實的驗證結果，但報告日一旦超過 180 天，就會從 v_recommendation_results
-- 消失，導致這裡把「早就驗證過」的推薦誤算成「尚未驗證」，達標/停損次數
-- 隨時間悄悄減少。這裡直接對 verifications 表算 bool_or，不受 180 天限制，
-- 歷史紀錄的次數不會因為時間經過而改變。
--
-- 執行：在 001~003 之後執行，可重複執行（create or replace view）
-- ============================================================================

create or replace view v_symbol_track_record as
select
  r.symbol,
  count(*) as primary_rec_count,
  max(r.report_date) as last_primary_date,
  count(*) filter (where ver.ever_hit_target) as target_hit_count,
  count(*) filter (where ver.ever_hit_stop) as stop_hit_count,
  count(*) filter (where ver.recommendation_id is null) as unverified_count
from recommendations r
left join (
  select
    recommendation_id,
    bool_or(hit_target) as ever_hit_target,
    bool_or(hit_stop)   as ever_hit_stop
  from verifications
  group by recommendation_id
) ver on ver.recommendation_id = r.id
where r.role = 'primary'
group by r.symbol;

-- PostgreSQL 15 以上才支援 security_invoker，若報錯可略過這行
alter view v_symbol_track_record set (security_invoker = on);

grant select on v_symbol_track_record to service_role;


-- ----------------------------------------------------------------------------
-- 驗收
-- ----------------------------------------------------------------------------
-- 已在 daily-us-stock 專案實測（2026-09-23），對照已知案例：
-- CRWD: 5 次 / 1 次達標 / 3 次停損 / 1 次未驗證
-- LMT : 8 次 / 1 次達標 / 3 次停損 / 3 次未驗證
-- MU  : 5 次 / 3 次達標 / 1 次停損 / 2 次未驗證
-- XOM : 8 次 / 1 次達標 / 3 次停損 / 4 次未驗證
select * from v_symbol_track_record order by primary_rec_count desc;
