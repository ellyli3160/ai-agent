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
| `sql/003_backfill_watchlist_heat.sql` | 補齊 002 漏掉的 watchlist `heat` 欄位 |
| `sql/004_symbol_track_record_view.sql` | 候選標的歷史推薦彙總 view（記憶層第一步） |
| `n8n/patch_write_recommendations.json` | 加進現有工作流的兩個節點，讓每日推薦寫進 `recommendations` |
| `n8n/patch_history_check.json` | 加進現有工作流的兩個節點，讓報告生成前先看候選標的的歷史推薦紀錄 |
| `n8n/patch_vix_quote.json` | 加進現有工作流的兩個節點，用 CBOE 官方資料取代模型自己猜的 VIX 指數 |
| `n8n/w4_performance_verification.json` | W4 績效驗證工作流，每交易日盤後回填實際報酬 |
| `scripts/backfill_verifications.mjs` | 一次性補上歷史推薦的實際績效 |
| `.github/workflows/backfill-verifications.yml` | 每天自動跑上面那支腳本，直到全部補完 |

---

## 目前狀態（2026-09-23）

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
- [x] 貼上 `n8n/patch_write_recommendations.json` 的兩個節點：已貼上並用
      Pin Data 對今天已執行的報告測試過，轉換邏輯正確（撞到的
      duplicate key 錯誤是因為當天資料已被回填過，非 bug）
- [x] `sql/003_backfill_watchlist_heat.sql` 已執行，補齊 002 漏掉的
      watchlist `heat` 欄位（355 筆空值補到剩 164 筆，剩下的是資料源頭
      本來就沒有這項資訊，非腳本問題）
- [~] `scripts/backfill_verifications.mjs` 歷史實績回填：資料源已從
      Stooq（使用者的電腦也連不上，判斷加了防爬蟲機制）改為 Alpha
      Vantage，Secrets 已設定、排程已跑過兩次。目前進度：
      **239 筆驗證資料、95 檔不重複推薦已補上，只剩 10 筆還在等待窗口內**，
      零重複列。排程會每天自動接續處理剩下的，不需要再手動介入
- [x] `sql/004_symbol_track_record_view.sql`（`v_symbol_track_record`）已在
      正式專案執行並核對正確；查詢窗口是最近 28 天（使用者指定）
- [x] `n8n/patch_history_check.json` 的兩個節點：已貼進正式工作流並實測成功。
      測試報告正確做到：全新標的（IONQ）被選為首選，已推薦過的標的
      （INTC／AVGO／NVDA）留在觀察名單並標註歷史驗證結果。第一版
      systemMessage 規則有個小問題（reason 欄位誤把統計數字當理由寫進去，
      連從沒推薦過的標的都寫），已修正見下方「安裝順序」第 7 步 e
- [ ] `n8n/patch_vix_quote.json` 的兩個節點：已寫好、Code 節點邏輯已用
      使用者實測拿到的真實 CBOE 回應格式測過，**尚未貼進正式工作流**，
      需要你自己操作，步驟見下方「安裝順序」第 8 步

### 排程自動化過程中發現並修正的 bug

第一次正式執行時，寫入 Supabase 那一步噴了 `SyntaxError: Unexpected
end of JSON input`。原因是 PostgREST 搭配 `Prefer: return=minimal`
寫入成功時回的是 201（不是 204）加空字串 body，程式碼只對 204 特別
處理，對空字串呼叫 `res.json()` 就炸掉。改成先讀 `res.text()`，有
內容才解析，任何狀態碼的空 body 都安全處理。

**這裡有個容易誤判的地方，記錄一下**：一開始以為這次失敗代表資料
完全沒寫入，但事後查資料庫的 `verified_at` 時間戳才發現，失敗的那
兩次執行其實都已經把資料寫進 Supabase 了（各 100 筆）——因為
POST 請求在資料庫端已經完成寫入並回傳 201，只是程式碼在「確認寫入
成功」這一步解析空字串時才拋錯，不代表寫入本身失敗。`verifications`
表有唯一鍵限制，就算同一批資料被重複嘗試寫入，也不會產生重複列
（已查證零重複）。判斷「有沒有寫入」要看資料庫的實際內容與時間戳，
不能只看腳本自己回報的成功或失敗。

### 資料源限制：Alpha Vantage 免費方案只能查最近約 100 個交易日

`TIME_SERIES_DAILY` 的 `outputsize=full`（完整歷史）最近被鎖進付費方案，
免費方案只能用 `outputsize=compact`，回傳「從今天往回數的最近約 100 個
交易日」，不是你指定的日期區間。

實際影響：287 筆有進場價的推薦裡，**172 筆（約 2026-05 之後）補得到，
115 筆（2025-03 到 2026-04）補不到**。這不是查不準，是 API 根本不會
回傳那麼久以前的資料。已決定先用選項 A：補這 172 筆，較舊的 115 筆
之後如果要補，需要換一個有免費完整歷史的資料源（候選：Twelve Data、
Polygon.io，但條款常變動，需自行申請 key 實測）。

腳本已加兩層防護，避免把「compact 視窗起點」誤當成「報告日隔天」算出
錯誤報酬率：讀取推薦時先用日期粗篩跳過明顯太舊的（省 API 額度），
抓到實際資料後再用真實日期範圍二次確認，兩層都沒過才會計算。已用
模擬資料測試過邊界情況（太舊的推薦、粗篩沒濾掉但實際視窗更短的推薦），
確認不會有錯誤資料寫進資料庫。

### 試跑時發現並修正的兩個問題

**1. 自己寫的日期過濾邏輯，誤判了本來補得到的推薦。**
使用者第一次試跑時，24 筆推薦被判定「太舊補不到」，但仔細看會發現
這些全部都是「視窗最早日期」剛好等於「報告日期」本身，這不是巧合。
原因是 `fetchDailyCloses` 還留著從 Stooq 版本沿用的過濾邏輯
`date < from` 會把報告日之前的資料自己砍掉——Stooq 的 API 接受日期
區間參數，這個過濾本來是對的，但 Alpha Vantage 的 `TIME_SERIES_DAILY`
不接受日期區間，compact 一次就是回傳全部約 100 個交易日，不該再自己
砍一次，砍了之後下游的「找不到報告日前一天資料」防護就會誤判成
「視窗涵蓋不到」。已移除這個多餘的過濾，只保留 `to` 上限。

**2. 加了離群值偵測，避免股票分割污染統計。**
`TIME_SERIES_DAILY`（免費版）是未調整的原始收盤價，不會還原股票分割。
一檔流動性好的大型股，正常不會在 3/7/30 天內漲跌超過 30%，出現這種
數字通常是分割造成的價格斷崖被誤判成真實報酬。腳本現在會在摘要裡
列出所有 `|報酬率| >= 30%` 的個別列（股票代碼、日期、進場價、收盤價），
方便寫入前人工核對是否為分割造成。也加了 `EXCLUDE_SYMBOLS=AVGO,NVDA`
環境變數，核對出問題的代碼後可以直接排除，不用重新耗用當天額度。

兩個修正都已用模擬資料測試過：分割情境能正確算出報酬率並標記為離群值，
先前測過的額度上限、可續跑、太舊過濾邏輯也重新驗證過沒有回歸問題。

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
既有歷史推薦的驗證窗口都已經過去，要用歷史收盤價一次補上：

```bash
export SUPABASE_URL=https://xxxx.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...          # service_role key
export ALPHA_VANTAGE_KEY=xxxxxxxx           # 免費申請：https://www.alphavantage.co/support/#api-key

node scripts/backfill_verifications.mjs --probe   # 先確認資料源可用
node scripts/backfill_verifications.mjs           # 試跑，只印結果不寫入
node scripts/backfill_verifications.mjs --write   # 確認數字合理後正式寫入
```

免費方案一天只能查 25 檔，這批推薦涉及約 54 檔股票，一次跑不完；跑到
額度上限會自動優雅停止，隔天重跑同一個指令即可自動接續，不用自己追蹤
進度。如果摘要裡出現離群值警告，先核對是不是股票分割造成的，再決定
要不要寫入，或用 `EXCLUDE_SYMBOLS=AVGO,XXX` 排除有問題的代碼。

### 6. 設定自動排程（選用，省得每天手動重跑）

`.github/workflows/backfill-verifications.yml` 會每天自動跑一次第 5 步
的腳本，用 `--skip-outliers`（排程沒有人盯著，偵測到離群值會自動跳過
不寫入，但會留在 Actions 的 log 裡）。全部補完之前你不需要手動做任何事。

到 repo 的 **Settings → Secrets and variables → Actions**：

**Secrets**（New repository secret，三個都要）：
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `ALPHA_VANTAGE_KEY`

**Variables**（選用，New repository variable）：
- `EXCLUDE_SYMBOLS`：核對出有問題的股票代碼後填在這裡（例如
  `AVGO,NVDA`），不需要改程式碼，下次排程執行就會生效

設定完可以到 **Actions** 分頁找到「歷史實績回填」這個 workflow，手動
按 **Run workflow** 先測一次，確認 log 沒有噴錯。全部補完之後
（log 會顯示「這次沒有可回填的資料」），這個排程可以停用，繼續開著
也無害，只是每天都會是空跑。

### 7. 加入歷史紀錄檢查（讓報告生成前先看候選標的的過去表現）

回應上面「從績效資料看到的問題」那個發現：重複推薦同一檔股票的達標率
明顯較低，但模型目前完全看不到自己過去推薦過什麼。這一步要做的事：
在「整合報價」跟「報告」中間插入兩個節點，把每檔候選標的的歷史推薦
紀錄整理成文字，餵給「報告」節點參考。`v_symbol_track_record` 只看
最近 28 天內的推薦，超過 28 天的舊推薦不會算進次數裡。

**a. 先建立 view（在第 1 步的 schema 之後執行）**

```
sql/004_symbol_track_record_view.sql
```

**b. 貼上 `n8n/patch_history_check.json` 的兩個節點**

複製檔案內容貼到畫布上，會出現「查詢股票歷史紀錄」與「整理歷史紀錄文字」
兩個節點。「查詢股票歷史紀錄」記得指定 Supabase 憑證（跟 W4 用的同一組）。

**c. 改接線：把「整合報價」直接接「報告」的那條線，改成中間經過這兩個新節點**

```
改之前：整合報價 ──────────────────────────────→ 報告
改之後：整合報價 → 查詢股票歷史紀錄 → 整理歷史紀錄文字 → 報告
```

也就是刪掉「整合報價 → 報告」這條線，改成「整合報價 → 查詢股票歷史紀錄」，
再從「查詢股票歷史紀錄 → 整理歷史紀錄文字」（貼上節點時已經幫你接好這段），
最後補「整理歷史紀錄文字 → 報告」。

**d. 修改「報告」節點的 prompt，插入歷史紀錄區塊**

在 `text` 欄位裡找到這一段：

```
## 即時報價數據
{{ JSON.stringify($json.stockQuotes, null, 2) }}

請生成繁體中文的投資分析報告，並在報告最後額外輸出一個JSON物件，格式如下：
```

在中間插入新的一段，改成：

```
## 即時報價數據
{{ JSON.stringify($json.stockQuotes, null, 2) }}

## 候選標的歷史推薦紀錄
{{ $json.historyText }}

請生成繁體中文的投資分析報告，並在報告最後額外輸出一個JSON物件，格式如下：
```

**e. 修改「報告」節點的 systemMessage，加一條規則**

在「## 規則」清單最後一條（目前是第 12 條，VIX 那條）後面，加一條：

```
13. 挑選首選標的前，請參考「候選標的歷史推薦紀錄」：若候選標的近期已推薦過、
    且沒有出現新的催化事件，優先考慮其他候選標的。reason 欄位只寫這檔股票
    本身值得推薦的理由（催化劑、基本面、技術面等），不要引用歷史達標率的
    統計數字。只有在確實要再次推薦同一檔已推薦過的股票時，才需要在 reason
    額外說明「這次為何不同於上次」。
```

> 第一版規則要求 reason 說明「為何不同於上次」，結果模型把這句話誤解成
> 「每次都要引用 62%／38% 這個統計數字當理由」，連從沒推薦過的標的也寫了
> 一次。已改成只在「reason」欄位描述個股本身的理由，統計數字不寫進 reason，
> 「說明為何不同於上次」也限定在真的要重複推薦同一檔股票時才需要。

**f. 測試**

用 Pin Data 固定「整合報價」節點今天的輸出，手動執行「查詢股票歷史紀錄」
與「整理歷史紀錄文字」，確認 `historyText` 的內容跟 Supabase 裡的資料對得
起來，再執行「報告」節點看輸出有沒有受到歷史紀錄影響。

> `整理歷史紀錄文字` 的 JS 邏輯已用模擬資料測過四種情境（正常情況、
> Supabase 回傳重複列、查詢結果為空、候選清單為空），行為都符合預期，
> 但沒有在正式的 n8n 環境跑過，第一次上線請照上面 f 步驟手動測一次。

### 8. 加入真實的 VIX 指數（取代模型自己猜）

第 12 條規則要求報告「確保 VIX 指數為當天的」，但模型自己並不知道今天的
VIX 是多少，只能用訓練資料裡記得的舊數字，或乾脆編一個。這一步改成用
CBOE 官方資料（不需要 API key）查真實的 VIX 收盤價，插進「報告」節點
的輸入裡，讓模型直接引用，不用自己猜。

只有前一交易日收盤，沒有當日盤中——這跟「整合報價」在盤前拿到的也是
前一日收盤價一致，時間基準沒有不一致的問題。

**a. 貼上 `n8n/patch_vix_quote.json` 的兩個節點**

複製檔案內容貼到畫布上，會出現「查詢VIX指數」與「解析VIX指數」兩個節點，
不需要設定任何憑證。

**b. 改接線：接在「整理歷史紀錄文字」跟「報告」中間**

```
改之前：整理歷史紀錄文字 ──────────────→ 報告
改之後：整理歷史紀錄文字 → 查詢VIX指數 → 解析VIX指數 → 報告
```

也就是刪掉「整理歷史紀錄文字 → 報告」這條線，改成「整理歷史紀錄文字 →
查詢VIX指數」（貼上節點時已經幫你接好「查詢VIX指數 → 解析VIX指數」這段），
最後補「解析VIX指數 → 報告」。

**c. 修改「報告」節點的 prompt，插入 VIX 區塊**

延續第 7 步已經插入「候選標的歷史推薦紀錄」的地方，繼續加一段：

```
## 即時報價數據
{{ JSON.stringify($json.stockQuotes, null, 2) }}

## 候選標的歷史推薦紀錄
{{ $json.historyText }}

## VIX 指數
{{ $json.vixDate }} 收盤：{{ $json.vixClose }}

請生成繁體中文的投資分析報告，並在報告最後額外輸出一個JSON物件，格式如下：
```

**d. 修改「報告」節點的 systemMessage，把第 12 條規則換掉**

原本的第 12 條要求模型「確保 VIX 指數為當天的」，這件事模型自己做不到，
改成要求模型直接引用上面插入的實際數值：

```
12. VIX 指數請直接引用「## VIX 指數」區塊裡提供的實際數值和日期，不要
    自行估算、也不要用你記憶中的舊數字。如果沒有看到這個區塊，在報告裡
    註明「VIX 資料暫缺」，不要假裝有這個資訊。
```

**e. 測試**

用 Pin Data 固定「整理歷史紀錄文字」節點的輸出，手動執行「查詢VIX指數」，
確認回傳的 JSON 裡有 `data` 欄位、內容是 CSV 字串（已用使用者實測的真實
回應格式核對過）。如果 `$json` 底下看不到 `data`（例如 n8n 把整包內容當
純文字沒有解析成 JSON），要調整「解析VIX指數」節點裡讀取欄位的方式，
細節看該節點的 notes。再執行「解析VIX指數」，確認 `vixClose`／`vixDate`
是合理的數字與最近的日期，最後執行「報告」節點看輸出有沒有正確引用。

> 「解析VIX指數」的 JS 邏輯已用使用者實測拿到的真實 CBOE 回應格式測過，
> 也測過資料過期、`data` 不是字串、CSV 只剩標題列三種異常情境，行為都
> 符合預期，但沒有在正式的 n8n 環境跑過，第一次上線請照上面 e 步驟手動
> 測一次。

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

## 從績效資料看到的問題：重複推薦同一檔股票，表現明顯較差

有了 W4 回填的實際績效資料後，比對「首次推薦」與「重複推薦（同一檔股票
曾經推薦過）」的達標率，差距很明顯：**首次推薦達標率 62%，重複推薦只有
38%**。這個模式在 LMT、CRWD、XOM 三個彼此不相關的產業上獨立驗證過，
不是單一個股或單一題材造成的巧合。

過程中也檢驗並推翻了兩個容易先入為主的解釋：
- 「是不是重複推薦時容易追高」→ 查了進場當日漲跌幅，**停損組反而
  平均漲幅較小**（+3.98% vs 達標組 +6.78%），追高解釋不成立
- 「是不是超過某個天數（例如 30 天）沒新催化劑，表現就會變差」→
  按重複間隔天數分組查過，**沒有隨天數增加而衰減或回穩的乾淨模式**，
  且每組樣本數只有 3-5 筆，不足以訂出具體的天數門檻

目前站得住腳、且已跨產業驗證過的結論只有一句：**「這檔股票是否被推薦
過」這件事本身，就是一個有效訊號**，不需要（也還沒有足夠資料）進一步
細分成天數規則。這正是下面「歷史紀錄檢查」要處理的問題：使用者確認
目前的工作流完全沒有記憶功能，模型在挑選首選標的時看不到自己過去推薦
過這檔股票、結果好不好。

---

## 設計上的兩個決定

**驗證窗口有上限。** `v_pending_verifications` 的條件是「已滿 N 個交易日且不超過 N+3」。
下限放寬讓工作流某天沒跑成功時隔天能補上；上限是必要的防護，
因為 W4 取的是執行當下的報價，沒有上限的話，一筆三個月前的推薦會被用今天的收盤價
記成它的 3 日報酬。錯過窗口的推薦寧可留白，也不要填進假資料。

**進場價的基準是報告日的前一個收盤。** 報告在盤前產生，Finnhub `/quote` 此時回傳的是
前一交易日收盤價。所以「3 日報酬」實際涵蓋含報告當日在內的 4 個交易日。
這是一致的偏移，跨筆比較不受影響，但解讀絕對數字時要記得。
