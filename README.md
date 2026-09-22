# 美股盤前分析 · 績效驗證層

這個 repo 存放 n8n 每日盤前分析工作流的資料層與驗證機制。

完整的架構規劃見 [美股盤前分析架構](https://claude.ai/code/artifact/159eaf9a-f5ca-484c-9ba5-74b6521f3b57)。
目前實作的是 **Phase 1：建資料層與驗證迴路**，分析工作流的邏輯完全不動。

Phase 1 要解決的問題只有一個：**現在的系統不知道自己準不準**。
Google Sheets 的「驗證狀態」永遠停在待驗證，3 / 7 / 30 日報酬欄位從未寫入過。
沒有這批資料，之後的記憶層與自我修正都沒有依據。

---

## 檔案

| 路徑 | 用途 |
|---|---|
| `sql/001_phase1_schema.sql` | 市場行事曆、`recommendations`、`verifications`，以及兩個 view |
| `sql/002_backfill_recommendations.sql` | 從既有 `stock_reports` 回填 100 份歷史報告的推薦紀錄 |
| `n8n/patch_write_recommendations.json` | 加進現有工作流的兩個節點，讓每日推薦寫進 `recommendations` |
| `n8n/w4_performance_verification.json` | W4 績效驗證工作流，每交易日盤後回填實際報酬 |
| `scripts/backfill_verifications.mjs` | 一次性補上歷史推薦的實際績效 |

---

## 目前狀態（2026-09-22）

Supabase 端已經在正式專案 `daily-us-stock` 上直接執行完成：schema 建好、
歷史報告已回填。n8n 端沒有可用的連線工具，需要你自己在 n8n 介面上操作。

- [x] `sql/001_phase1_schema.sql` 已執行，`market_holidays`／`recommendations`／
      `verifications` 三張表與兩個 view 都在
- [x] `sql/002_backfill_recommendations.sql` 已執行（過程中發現並修正了下面的
      雙重編碼問題），回填出 **98 筆 primary、355 筆 watchlist**
- [x] `v_pending_verifications` 驗證正常，目前有 9 筆進入 3 日窗口、9 筆進入 7 日窗口
- [x] Finnhub Header Auth 憑證：已建立
- [x] 匯入 `n8n/w4_performance_verification.json`：已匯入並手動執行成功，
      端到端跑通（抓待驗證清單 → 查報價 → 算報酬 → 寫回 Supabase →
      彙總 → 更新 Google Sheets），7 筆推薦正確寫入
- [ ] 貼上 `n8n/patch_write_recommendations.json` 的兩個節點：待你操作
- [ ] `scripts/backfill_verifications.mjs` 歷史實績回填：待你在自己的環境跑
      `--probe`（Stooq 在這裡的開發環境被 proxy 擋掉，你的環境不一定會）

### W4 試跑時發現並修正的兩個 bug

1. **`整理 Sheets 更新` 把「還沒驗證」誤判成「結果是 0%」。**
   `fmt()` 對 `null` 呼叫 `Number(null)` 會得到 `0`（不是 `NaN`），
   導致只驗證了 1 個 horizon 的列，另外兩個沒驗證過的 horizon 也顯示
   `0.00%`。已修正為先擋掉 `null`/`undefined`。

2. **`讀取彙總結果`（Supabase 節點）在單次執行裡把資料重複吐出很多份。**
   實測時 18 筆真實資料被吐成上百筆，已在資料庫端確認
   `v_recommendation_results` 本身沒有重複（`view_total_rows` 等於
   `distinct recommendation_id` 數），問題出在 n8n 節點的分頁行為。
   不深究節點內部實作，改在下游用 `recommendation_id` 去重防護。

兩個修正都已推上 `n8n/w4_performance_verification.json`，並在使用者的
正式環境重跑驗證過：輸出收斂回正確的 7 筆，數值也都正確
（例如 `2026-09-08` → `7日 -9.44%`，不再有假的 `0.00%`）。

### 過程中發現的問題：`json_data` 是雙重編碼

實測時發現 `stock_reports.json_data` 的 `jsonb_typeof` 對全部 110 列都回傳
`'string'`，不是預期的 `'object'`。追查到 n8n 工作流「supabase」Code 節點：

```js
json_data: JSON.stringify(item.json.json_data)
```

物件先被字串化一次，Supabase 節點寫入 jsonb 欄位時又編碼一次，結果變成
「一個字串，內容剛好是 JSON 文字」。**從第一筆資料（2025-03-23）就是這樣，
不是最近才壞的。** `sql/002_backfill_recommendations.sql` 已經用
`(json_data #>> '{}')::jsonb` 多解開一層處理過，回填結果是正確的。

建議你把 n8n 那個節點改成：

```js
json_data: item.json.json_data
```

不要再 `JSON.stringify`，讓未來寫入的資料是正常的 jsonb 物件。這不影響
`recommendations` 的寫入（`拆出推薦紀錄` 節點是從報告物件直接讀，不經過
`stock_reports`），只影響任何直接查 `stock_reports.json_data` 的工具，源頭修掉比較乾淨，但不改也不會壞任何東西。

---

## 安裝順序

### 1. 建立 schema

Supabase Dashboard → SQL Editor，依序執行：

```
sql/001_phase1_schema.sql
sql/002_backfill_recommendations.sql
```

> 已在 `daily-us-stock` 專案上實際執行過，見上方「目前狀態」。
> 如果你要在別的專案重新跑一次，檔案最後有驗收查詢可以核對。

### 2. 建立 Finnhub 憑證

W4 用 Header Auth 帶 API key，不再明文寫在節點裡：

n8n → Credentials → New → **Header Auth**
- Name：`X-Finnhub-Token`
- Value：你的 Finnhub API key

> 現有工作流的「工作流配置」節點裡是明文金鑰，會隨 JSON 匯出流出。
> 那份 JSON 已經傳過對話，**建議先到 Finnhub 後台重新產生一組金鑰**再做搬遷。

### 3. 匯入 W4 工作流

匯入 `n8n/w4_performance_verification.json`，然後：

- **Settings → Timezone 設為 `America/New_York`**（cron 是 `0 17 * * 1-5`，時區錯了就不是收盤後）
- 在「取得收盤報價」節點選擇上一步建立的 Header Auth 憑證
- 確認 Supabase 與 Google Sheets 憑證有正確帶入

### 4. 修改現有工作流

把 `n8n/patch_write_recommendations.json` 的內容複製後直接貼到畫布上，會出現兩個節點。
接法是從既有的 **`Code in JavaScript`** 節點拉一條線到 **`拆出推薦紀錄`**，
與 `每日報告`、`google sheet`、`supabase` 三條並行。

```
Code in JavaScript ─┬─→ 每日報告 → Telegram / LINE
                    ├─→ google sheet → Switch → 主要標的 / 觀察名單
                    ├─→ supabase → Create a row
                    └─→ 拆出推薦紀錄 → 寫入推薦紀錄     ← 新增
```

### 5. 回填歷史實績（選用，但建議做）

W4 取的是執行當下的報價，只能驗證從今天起產生的推薦。
既有 89 筆歷史推薦的驗證窗口都已經過去，要用歷史收盤價一次補上：

```bash
export SUPABASE_URL=https://xxxx.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...          # service_role key

node scripts/backfill_verifications.mjs --probe   # 先確認資料源可用
node scripts/backfill_verifications.mjs           # 試跑，只印結果不寫入
node scripts/backfill_verifications.mjs --write   # 確認數字合理後正式寫入
```

回填完成後就有約 250 筆實績可以統計，不必等三個月。

---

## 驗證狀況

**已在正式 Supabase 專案上實測：**
- `sql/001_phase1_schema.sql` 執行成功，三張表、兩個 view、`trading_days_between()`
  函式都正常。`security_invoker` 語法在 PG17 上沒問題
- `sql/002_backfill_recommendations.sql` 執行成功，回填 98 筆 primary、355 筆 watchlist
- `v_pending_verifications` 邏輯正確：9 筆在 3 日窗口、9 筆在 7 日窗口
- 過程中抓到並修正了 `json_data` 雙重編碼的問題（見上方說明）
- 也抓到並修正了我自己寫錯的一則測試案例註解（`001` 檔案最後，
  跨勞動節的交易日數原本誤寫成 3，實際是 2）

**已用 CSV 快照實測（邏輯驗證，非正式環境）：**
- `拆出推薦紀錄` 的邏輯跑過 100 份歷史報告快照，無無效代碼、無唯一鍵衝突，
  觀望日正確略過（正式環境上跑出的數字略有不同是因為多了 10 天資料，
  以及套用了雙重編碼修正，以正式環境的 98／355 為準）
- 所有 n8n Code 節點的 JS 通過 `node --check`
- 兩份工作流 JSON 可正確解析

**未能實測，請自行確認：**
- Stooq 歷史報價端點（開發環境的 proxy 阻擋外部網域，`--probe` 直接回 403）。
  若不可用，腳本末端有 Finnhub `/stock/candle` 與 Alpha Vantage 的替代方案，
  只需替換 `fetchDailyCloses()` 一個函式
- 行事曆的 Good Friday 依復活節推算，建議對照 NYSE 官方行事曆確認
- n8n Supabase 節點讀取 view 的行為。若 `tableId` 下拉選單看不到 view，
  改用 HTTP Request 節點打 `{SUPABASE_URL}/rest/v1/v_pending_verifications`
- 這個 session 沒有 n8n 的連線工具，W4 匯入、patch 節點、Finnhub 憑證
  這幾步無法由我直接操作，需要你自己在 n8n 介面上完成

---

## 從歷史資料看到的問題

分析 100 份報告（2025-03-23 至 2026-09-04）時發現的，都會影響後續的統計品質：

**1. 模型已經在嘗試說「今天不推薦」，但沒有欄位承接**

有 10 天的 `primary_pick.symbol` 是 `N/A`、`暫不推薦`、`無`、`市場觀望`。
模型判斷得出「今天不該進場」，卻被格式逼著填進代碼欄位。
Phase 3 的 `has_recommendation` 布林欄位就是為了正確承接這件事。

**2. 風險報酬比普遍偏低**

88 筆有完整目標價與停損價的推薦中，**中位數 1.46，53% 低於 1.5**。
我在架構文件裡提的「S5 風報比至少 1.5」如果照搬，會擋掉超過一半的報告。
建議先設 1.2 且只警告不擋，等實際績效數據出來再決定門檻，
或是改從 prompt 端要求把目標價設寬一點。

**3. 列舉值沒有被遵守**

`market_sentiment` 的 prompt 只允許看多 / 中性 / 看空，實際出現 7 種值，
包含 `中性偏多`（9 次）、`中性偏謹慎`（2 次）、`極度看空`、`謹慎看多`。
`confidence` 也出現 prompt 沒定義的 `Medium-High`（4 次）。
`hold_time` 更有八種以上寫法表達同樣的三個概念（`中（一個月內）`、`中期（一個月內）`、
`中期(一個月內)`、`中期(1個月內)` 都出現過）。
這些都會讓分組統計失真，接 Structured Output Parser 加 enum 約束可以一次解決。

**4. 有系統性追高後才推薦的傾向**

有 9 筆首選標的的當日漲跌超過 10%（DDOG +31.33%、CRWD +20.50%、MU +19.29%），
集中在財報季。這些多半是真實的財報跳空，不是資料錯誤，
但代表模型傾向在大漲之後才把標的列為首選，進場價就是跳空後的價格。
這正是架構文件裡 `priced_in` 欄位要處理的問題，等實績數據回來就能驗證這個模式的勝率。

**5. 資料品質雜項**

- 1 筆目標價低於進場價、1 筆停損價高於進場價（邏輯矛盾，S5 應該擋掉）
- 11 筆首選標的沒有有效報價，無法驗證
- 324 筆觀察名單只有 172 筆能取得進場價（`watchlist` 項目本身不含價格，
  要靠 `themes[].stocks[]` 補，補不到就無法驗證）
- 頂層欄位從 `risks` 改成 `macro_risks`（98 比 2），schema 中途變更過
- 看空佔 54%，中性 26%，看多僅 7%

---

## 設計上的兩個決定

**驗證窗口有上限。** `v_pending_verifications` 的條件是「已滿 N 個交易日且不超過 N+3」。
下限放寬讓工作流某天沒跑成功時隔天能補上；上限是必要的防護，
因為 W4 取的是執行當下的報價，沒有上限的話，一筆三個月前的推薦會被用今天的收盤價
記成它的 3 日報酬。錯過窗口的推薦寧可留白，也不要填進假資料。

**進場價的基準是報告日的前一個收盤。** 報告在盤前產生，Finnhub `/quote` 此時回傳的是
前一交易日收盤價。所以「3 日報酬」實際涵蓋含報告當日在內的 4 個交易日。
這是一致的偏移，跨筆比較不受影響，但解讀絕對數字時要記得。
