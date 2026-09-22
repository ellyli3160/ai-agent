#!/usr/bin/env node
/**
 * 歷史實績回填
 *
 * W4 每日驗證取的是「執行當下」的報價，因此只能驗證從今天起產生的推薦。
 * 既有的歷史推薦，驗證窗口都已經過去，需要用歷史收盤價一次補上。
 * 補完之後記憶層立刻有樣本，不必等三個月。
 *
 * 資料來源：Alpha Vantage TIME_SERIES_DAILY（免費，需申請 API key）
 *   https://www.alphavantage.co/support/#api-key
 *
 * ⚠️ 原本規劃用 Stooq（免 key），但實測後（包含使用者自己的電腦）都連不上，
 *    回傳的是一個網頁而不是 CSV，判斷是該端點加了防爬蟲機制。已改用
 *    Alpha Vantage 作為主要資料源。
 *
 * ⚠️ 免費方案限制：每分鐘 5 次、每天 25 次請求。這支腳本會自動節流
 *    （每次呼叫間隔 13 秒）並在額度用完時優雅停止，已完成的部分不會遺失，
 *    「明天」重新執行同一個指令即可從中斷處接著跑（已驗證過的組合會自動略過）。
 *
 * ⚠️ 免費方案的 TIME_SERIES_DAILY 只能用 outputsize=compact（最近約 100 個
 *    交易日，從「今天」往回算，不是從你指定的日期算），outputsize=full
 *    （完整歷史）已被鎖進付費方案。這代表報告日期太舊的推薦（早於 compact
 *    視窗涵蓋範圍）永遠補不到，不是查不準，是 API 根本不會回傳那麼久以前
 *    的資料。腳本會先用粗略的日期門檻跳過明顯太舊的推薦（省 API 額度），
 *    抓到實際資料後再用真實日期範圍二次確認，兩層都是為了避免把「用視窗
 *    起點誤當成報告日期」算出來的錯誤報酬率寫進資料庫。
 *
 * 用法：
 *   export SUPABASE_URL=https://xxxx.supabase.co
 *   export SUPABASE_SERVICE_KEY=eyJ...          # service_role key
 *   export ALPHA_VANTAGE_KEY=xxxxxxxx           # https://www.alphavantage.co/support/#api-key
 *
 *   node scripts/backfill_verifications.mjs --probe   # 只測資料源是否可用
 *   node scripts/backfill_verifications.mjs           # 試跑，印出結果但不寫入
 *   node scripts/backfill_verifications.mjs --write   # 實際寫入 verifications
 */

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;
const ARGS              = new Set(process.argv.slice(2));
const DO_WRITE          = ARGS.has('--write');
const PROBE_ONLY        = ARGS.has('--probe');

const HORIZONS = [
  { horizon: '3d',  days: 3  },
  { horizon: '7d',  days: 7  },
  { horizon: '30d', days: 30 },
];

// 進場價與當日收盤的合理偏差上限。超過代表資料對不上，該筆不回填。
const ENTRY_TOLERANCE = 0.05;

// 免費方案：每分鐘 5 次、每天 25 次。用 13 秒間隔換算約每分鐘 4.6 次，留一點餘裕。
const CALL_INTERVAL_MS = 13_000;
const DAILY_CALL_CAP   = 25;

// compact 大約是最近 100 個交易日，約 140 個日曆日，這裡抓保守值 130 天
// 當作粗篩門檻：report_date 早於這個門檻的推薦，幾乎確定補不到，直接跳過
// 不浪費 API 額度。精確判斷仍以抓到資料後的實際日期範圍為準（見下方主流程）。
const COMPACT_WINDOW_CALENDAR_DAYS = 130;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ymd   = (d) => d.toISOString().slice(0, 10);

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- Supabase
async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${res.status} ${path}：${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// ----------------------------------------------------------- Alpha Vantage
// probe 也會實際打一次 API，必須跟主流程共用同一個計數器，
// 否則單次執行會打到 1(probe) + DAILY_CALL_CAP 次，超過免費方案的每日上限。
let callCount = 0;

/**
 * 取回 { 'YYYY-MM-DD': close }。每次呼叫都計入 callCount（含 probe）。
 *
 * 不接受 from 下限：Alpha Vantage 的 TIME_SERIES_DAILY 不支援日期區間查詢，
 * compact 一次就是回傳最近約 100 個交易日的全部資料。早期沿用 Stooq 版本
 * 留下的「date < from 就丟棄」邏輯是個 bug——會把報告日之前的資料自己砍掉，
 * 導致下游誤判成「視窗涵蓋不到」而跳過，即使 API 明明有回傳那些日期。
 * 這裡只保留 to 上限，避免抓到不必要的未來雜訊。
 */
async function fetchDailyCloses(symbol, to) {
  callCount++;
  const url = 'https://www.alphavantage.co/query'
            + `?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}`
            + `&outputsize=compact&apikey=${ALPHA_VANTAGE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();

  if (data['Error Message']) throw new Error(`代碼無效或不存在：${data['Error Message']}`);
  if (data['Note'])          throw new Error(`已被限流：${data['Note']}`);
  if (data['Information'])   throw new Error(`API 限制：${data['Information']}`);

  const series = data['Time Series (Daily)'];
  if (!series) {
    throw new Error(`回應缺少 Time Series (Daily)，原始回應前 200 字：${JSON.stringify(data).slice(0, 200)}`);
  }

  const out = {};
  for (const [date, ohlc] of Object.entries(series)) {
    if (date > to) continue;
    const close = Number(ohlc['4. close']);
    if (Number.isFinite(close) && close > 0) out[date] = close;
  }
  return out;
}

/** 節流版本：呼叫前檢查每日額度，呼叫後強制間隔，供主流程使用。 */
async function fetchDailyClosesThrottled(symbol, to) {
  if (callCount >= DAILY_CALL_CAP) {
    throw new Error('DAILY_CAP_REACHED');
  }
  const result = await fetchDailyCloses(symbol, to);
  await sleep(CALL_INTERVAL_MS);
  return result;
}

// ------------------------------------------------------------------- main
async function main() {
  if (!ALPHA_VANTAGE_KEY) {
    fail('請先申請並設定環境變數 ALPHA_VANTAGE_KEY（免費：https://www.alphavantage.co/support/#api-key）');
  }
  // --probe 只測資料源，不需要 Supabase 設定
  if (!PROBE_ONLY && (!SUPABASE_URL || !SERVICE_KEY)) {
    fail('請先設定環境變數 SUPABASE_URL 與 SUPABASE_SERVICE_KEY');
  }

  // ---- 資料源探測 ----
  process.stdout.write('探測 Alpha Vantage 是否可用（AAPL compact）… ');
  const probeTo = ymd(new Date());
  let probe;
  try {
    probe = await fetchDailyCloses('AAPL', probeTo);
  } catch (e) {
    console.log('失敗');
    fail(`Alpha Vantage 無法取得資料：${e.message}`);
  }
  const probeDates = Object.keys(probe).sort();
  const probeDays  = probeDates.length;
  // 健檢重點是「有沒有最近的資料」，不是「總共幾天」：
  // 用近 30 天內至少要有幾筆資料，確認回傳的是活資料而不是舊快取或壞掉的 key
  const recentDays = probeDates.filter(d => d >= ymd(new Date(Date.now() - 30 * 86400e3))).length;
  if (probeDays < 5 || recentDays < 3) {
    console.log(`只取到 ${probeDays} 天（近 30 天內 ${recentDays} 天）`);
    fail('資料筆數異常偏少，可能是 API key 無效或被限流，請確認後再跑。');
  }
  console.log(`OK（共 ${probeDays} 個交易日，最新 ${probeDates.at(-1)}）`);
  if (PROBE_ONLY) return;

  // ---- 讀取待回填的推薦 ----
  const allRecs = await sb(
    'recommendations?select=id,report_date,symbol,role,entry_price,target_price,stop_loss'
    + '&entry_price=not.is.null&order=report_date.asc'
  );
  const done = await sb('verifications?select=recommendation_id,horizon');
  const doneSet = new Set(done.map(v => `${v.recommendation_id}|${v.horizon}`));

  // 排除已確認有問題的代碼（例如核對出來是股票分割造成離群值），
  // 用逗號分隔：EXCLUDE_SYMBOLS=AVGO,NVDA node scripts/backfill_verifications.mjs --write
  const excludeSymbols = new Set(
    (process.env.EXCLUDE_SYMBOLS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  );
  if (excludeSymbols.size) console.log(`已排除代碼：${[...excludeSymbols].join(',')}`);

  // 粗篩：report_date 早於 compact 視窗大概涵蓋的範圍，幾乎確定補不到，
  // 先濾掉以免浪費 API 額度去查一檔結果全部落空的股票
  const windowStart = ymd(new Date(Date.now() - COMPACT_WINDOW_CALENDAR_DAYS * 86400e3));
  const notExcluded = allRecs.filter(r => !excludeSymbols.has(r.symbol.toUpperCase()));
  const recs = notExcluded.filter(r => r.report_date >= windowStart);
  const tooOldCount = notExcluded.length - recs.length;

  console.log(
    `推薦紀錄 ${allRecs.length} 筆，已驗證 ${done.length} 筆`
    + (tooOldCount
        ? `\n${tooOldCount} 筆早於 ${windowStart}（compact 視窗大概涵蓋不到），`
          + `本次不處理，除非之後換成有完整歷史的資料源`
        : '')
  );

  const bySymbol = new Map();
  for (const r of recs) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }

  // 這檔股票底下的推薦，是否已經把「所有 horizon」都驗證過了
  // （用來略過已完成的股票，把每日 25 次額度留給還沒做完的）
  const isSymbolFullyDone = (list) =>
    list.every(rec => HORIZONS.every(({ horizon }) => doneSet.has(`${rec.id}|${horizon}`)));

  const remaining = [...bySymbol.entries()].filter(([, list]) => !isSymbolFullyDone(list));
  // probe 已經用掉 1 次額度（callCount 此時是 1），今天實際還能查的檔數要扣掉這次
  const availableToday = Math.max(0, DAILY_CALL_CAP - callCount);
  console.log(
    `共 ${bySymbol.size} 檔，其中 ${bySymbol.size - remaining.length} 檔已全部驗證完畢、`
    + `${remaining.length} 檔待處理。免費額度每天 ${DAILY_CALL_CAP} 次（含剛才 probe 用掉的 1 次），`
    + `今天還可以查 ${availableToday} 檔，`
    + `${remaining.length > availableToday ? `預估還需要 ${Math.ceil((remaining.length - availableToday) / DAILY_CALL_CAP) + 1} 天跑完` : '今天應該可以跑完'}。\n`
  );

  const rows = [];
  const diagnostics = [];   // 只供印出檢查用，不會寫進資料庫
  const problems = [];
  let n = 0;
  let capReached = false;

  for (const [symbol, list] of remaining) {
    n++;
    const last = list.at(-1).report_date;
    // 30 個交易日約 42 個日曆日，多抓 30 天緩衝
    const to = ymd(new Date(new Date(last).getTime() + 72 * 86400e3));

    let series;
    try {
      series = await fetchDailyClosesThrottled(symbol, to);
    } catch (e) {
      if (e.message === 'DAILY_CAP_REACHED') {
        capReached = true;
        break;
      }
      problems.push(`${symbol}：取價失敗（${e.message}）`);
      continue;
    }
    const dates = Object.keys(series).sort();
    if (dates.length < 5) {
      problems.push(`${symbol}：資料僅 ${dates.length} 天，略過`);
      continue;
    }
    process.stdout.write(`\r[${n}/${remaining.length}] ${symbol.padEnd(6)} ${dates.length} 天  `);

    for (const rec of list) {
      const entry = Number(rec.entry_price);

      // 二次確認：compact 只回傳最近約 100 個交易日，如果連 report_date
      // 前一天都不在這個範圍內，代表這筆推薦太舊、視窗涵蓋不到。
      // 這裡必須整筆跳過，不能繼續往下算，否則後面的 after 會誤把
      // 「視窗起點」當成「報告日隔天」，算出一個看似正常、實則錯誤的報酬率。
      if (dates[0] >= rec.report_date) {
        problems.push(`${symbol} ${rec.report_date}：太舊，compact 視窗涵蓋不到（視窗最早 ${dates[0]}），略過`);
        continue;
      }

      // 進場價健檢：報告在盤前產生，進場價應接近「報告日前一個交易日」的收盤
      const before = dates.filter(d => d < rec.report_date);
      const ref = series[before.at(-1)];
      if (Math.abs(ref - entry) / ref > ENTRY_TOLERANCE) {
        problems.push(
          `${symbol} ${rec.report_date}：進場價 ${entry} 與前一收盤 ${ref} `
          + `差距 ${((entry - ref) / ref * 100).toFixed(1)}%，略過`
        );
        continue;
      }

      // 用價格序列本身定義交易日，不需要行事曆
      const after = dates.filter(d => d > rec.report_date);

      for (const { horizon, days } of HORIZONS) {
        if (doneSet.has(`${rec.id}|${horizon}`)) continue;
        if (after.length < days) continue;

        const onDate = after[days - 1];
        const price  = series[onDate];
        const target = Number(rec.target_price);
        const stop   = Number(rec.stop_loss);

        const returnPct = Math.round(((price - entry) / entry) * 100000) / 1000;

        rows.push({
          recommendation_id:    rec.id,
          horizon,
          price_then:           Math.round(price * 10000) / 10000,
          return_pct:           returnPct,
          hit_target:           Number.isFinite(target) && target > 0 ? price >= target : null,
          hit_stop:             Number.isFinite(stop)   && stop   > 0 ? price <= stop   : null,
          elapsed_trading_days: days,
          price_basis:          'close',
          source:               'alphavantage-backfill',
        });
        diagnostics.push({ symbol, report_date: rec.report_date, horizon, entry, price_then: price, return_pct: returnPct });
      }
    }
  }
  console.log('\n');

  if (capReached) {
    console.log(
      `⚠️ 已達今日 ${DAILY_CALL_CAP} 次額度上限，還有 ${remaining.length - n + 1} 檔沒處理。`
      + `明天直接重跑同一個指令即可（已完成的股票與組合會自動略過，不會重複扣額度）。\n`
    );
  }

  // ---- 摘要 ----
  if (problems.length) {
    console.log(`跳過 ${problems.length} 項：`);
    problems.slice(0, 15).forEach(p => console.log('  ', p));
    if (problems.length > 15) console.log(`   …另有 ${problems.length - 15} 項`);
    console.log('');
  }

  if (!rows.length) return console.log('這次沒有可回填的資料。');

  const by = (h) => rows.filter(r => r.horizon === h).map(r => r.return_pct);
  console.log(`這次可回填 ${rows.length} 筆：`);
  for (const { horizon } of HORIZONS) {
    const v = by(horizon).sort((a, b) => a - b);
    if (!v.length) continue;
    const avg = v.reduce((s, x) => s + x, 0) / v.length;
    const win = v.filter(x => x > 0).length;
    console.log(
      `  ${horizon.padEnd(4)} n=${String(v.length).padStart(3)}`
      + `  勝率 ${(win / v.length * 100).toFixed(0).padStart(3)}%`
      + `  平均 ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`
      + `  中位 ${v[Math.floor(v.length / 2)].toFixed(2)}%`
      + `  範圍 ${v[0].toFixed(1)}% ~ ${v.at(-1).toFixed(1)}%`
    );
  }

  // 離群值檢查：TIME_SERIES_DAILY 是未調整的原始收盤價，不會還原股票分割。
  // 一檔流動性好的大型股，正常不會在 3/7/30 天內漲跌超過 30%，出現這種
  // 數字，比較可能是分割造成的價格斷崖被誤判成真實報酬，而不是真的行情。
  const OUTLIER_THRESHOLD = 30;
  const outliers = diagnostics
    .filter(d => Math.abs(d.return_pct) >= OUTLIER_THRESHOLD)
    .sort((a, b) => Math.abs(b.return_pct) - Math.abs(a.return_pct));
  if (outliers.length) {
    console.log(
      `⚠️ ${outliers.length} 筆離群值（|報酬率| >= ${OUTLIER_THRESHOLD}%），`
      + `常見原因是股票分割沒被還原，寫入前建議先核對這些股票在對應日期是否真的有分割：`
    );
    outliers.slice(0, 20).forEach(o => {
      console.log(
        `   ${o.symbol.padEnd(6)} ${o.report_date} ${o.horizon.padEnd(3)}`
        + `  進場 ${o.entry} → ${o.price_then}`
        + `  (${o.return_pct >= 0 ? '+' : ''}${o.return_pct.toFixed(2)}%)`
      );
    });
    if (outliers.length > 20) console.log(`   …另有 ${outliers.length - 20} 筆`);
    console.log('');
  }

  if (!DO_WRITE) {
    console.log('這是試跑，未寫入。確認數字合理後加上 --write 正式執行。');
    if (outliers.length) {
      console.log('偵測到離群值，建議先核對過再決定要不要寫入，或考慮排除可疑的股票代碼。');
    }
    return;
  }

  // ---- 寫入 ----
  console.log('\n寫入中…');
  let written = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await sb('verifications?on_conflict=recommendation_id,horizon', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    written += chunk.length;
    process.stdout.write(`\r  ${written}/${rows.length}`);
  }
  console.log(`\n完成，寫入 ${written} 筆。`);
  if (capReached) {
    console.log('明天可以重新執行同一個指令，繼續處理剩下的股票。');
  }
}

main().catch(e => fail(e.stack || e.message));
