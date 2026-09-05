#!/usr/bin/env node
/**
 * 歷史實績回填
 *
 * W4 每日驗證取的是「執行當下」的報價，因此只能驗證從今天起產生的推薦。
 * 既有的 89 筆歷史首選推薦，驗證窗口都已經過去，需要用歷史收盤價一次補上。
 * 補完之後記憶層立刻有樣本，不必等三個月。
 *
 * 資料來源：Stooq 的免費每日 CSV（不需 API key）
 *   https://stooq.com/q/d/l/?s=nvda.us&d1=20260824&d2=20261030&i=d
 *
 * ⚠️ 這個端點無法在開發環境中實測（proxy 阻擋外部網域），請先用 --probe
 *    確認能取到資料再跑正式回填。若 Stooq 不可用，見檔案末端的替代方案。
 *
 * 用法：
 *   export SUPABASE_URL=https://xxxx.supabase.co
 *   export SUPABASE_SERVICE_KEY=eyJ...          # service_role key
 *
 *   node scripts/backfill_verifications.mjs --probe   # 只測資料源是否可用
 *   node scripts/backfill_verifications.mjs           # 試跑，印出結果但不寫入
 *   node scripts/backfill_verifications.mjs --write   # 實際寫入 verifications
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ARGS         = new Set(process.argv.slice(2));
const DO_WRITE     = ARGS.has('--write');
const PROBE_ONLY   = ARGS.has('--probe');

const HORIZONS = [
  { horizon: '3d',  days: 3  },
  { horizon: '7d',  days: 7  },
  { horizon: '30d', days: 30 },
];

// 進場價與當日收盤的合理偏差上限。超過代表資料對不上，該筆不回填。
const ENTRY_TOLERANCE = 0.05;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ymd   = (d) => d.toISOString().slice(0, 10);
const compact = (s) => s.replaceAll('-', '');

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

// ------------------------------------------------------------------ Stooq
/** 美股代碼轉 Stooq 格式：BRK.B → brk-b.us */
const toStooq = (symbol) =>
  `${symbol.toLowerCase().replaceAll('.', '-')}.us`;

/** 取回 { 'YYYY-MM-DD': close } */
async function fetchDailyCloses(symbol, from, to) {
  const url = `https://stooq.com/q/d/l/?s=${toStooq(symbol)}`
            + `&d1=${compact(from)}&d2=${compact(to)}&i=d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2 || !lines[0].toLowerCase().startsWith('date')) {
    throw new Error(`回應非預期格式：${text.slice(0, 80)}`);
  }

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const iDate  = header.indexOf('date');
  const iClose = header.indexOf('close');
  if (iDate < 0 || iClose < 0) throw new Error('CSV 缺少 Date 或 Close 欄位');

  const out = {};
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const close = Number(cells[iClose]);
    if (cells[iDate] && Number.isFinite(close) && close > 0) out[cells[iDate]] = close;
  }
  return out;
}

// ------------------------------------------------------------------- main
async function main() {
  // --probe 只測資料源，不需要 Supabase 設定
  if (!PROBE_ONLY && (!SUPABASE_URL || !SERVICE_KEY)) {
    fail('請先設定環境變數 SUPABASE_URL 與 SUPABASE_SERVICE_KEY');
  }

  // ---- 資料源探測 ----
  process.stdout.write('探測 Stooq 是否可用（AAPL 近 30 天）… ');
  const probeTo   = ymd(new Date());
  const probeFrom = ymd(new Date(Date.now() - 30 * 86400e3));
  let probe;
  try {
    probe = await fetchDailyCloses('AAPL', probeFrom, probeTo);
  } catch (e) {
    console.log('失敗');
    fail(`Stooq 無法取得資料：${e.message}\n  請改用檔案末端說明的替代資料源。`);
  }
  const probeDays = Object.keys(probe).length;
  if (probeDays < 5) {
    console.log(`只取到 ${probeDays} 天`);
    fail('資料筆數異常偏少，可能被限流或代碼格式不符，請人工確認後再跑。');
  }
  console.log(`OK（${probeDays} 個交易日）`);
  if (PROBE_ONLY) return;

  // ---- 讀取待回填的推薦 ----
  const recs = await sb(
    'recommendations?select=id,report_date,symbol,role,entry_price,target_price,stop_loss'
    + '&entry_price=not.is.null&order=report_date.asc'
  );
  const done = await sb('verifications?select=recommendation_id,horizon');
  const doneSet = new Set(done.map(v => `${v.recommendation_id}|${v.horizon}`));

  console.log(`推薦紀錄 ${recs.length} 筆，已驗證 ${done.length} 筆`);

  const bySymbol = new Map();
  for (const r of recs) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }
  console.log(`需查詢 ${bySymbol.size} 檔歷史報價\n`);

  const rows = [];
  const problems = [];
  let n = 0;

  for (const [symbol, list] of bySymbol) {
    n++;
    const first = list[0].report_date;
    const last  = list.at(-1).report_date;
    // 30 個交易日約 42 個日曆日，多抓 30 天緩衝
    const to = ymd(new Date(new Date(last).getTime() + 72 * 86400e3));

    let series;
    try {
      series = await fetchDailyCloses(symbol, first, to);
    } catch (e) {
      problems.push(`${symbol}：取價失敗（${e.message}）`);
      continue;
    }
    const dates = Object.keys(series).sort();
    if (dates.length < 5) {
      problems.push(`${symbol}：資料僅 ${dates.length} 天，略過`);
      continue;
    }
    process.stdout.write(`\r[${n}/${bySymbol.size}] ${symbol.padEnd(6)} ${dates.length} 天  `);

    for (const rec of list) {
      const entry = Number(rec.entry_price);

      // 進場價健檢：報告在盤前產生，進場價應接近「報告日前一個交易日」的收盤
      const before = dates.filter(d => d < rec.report_date);
      if (before.length) {
        const ref = series[before.at(-1)];
        if (Math.abs(ref - entry) / ref > ENTRY_TOLERANCE) {
          problems.push(
            `${symbol} ${rec.report_date}：進場價 ${entry} 與前一收盤 ${ref} `
            + `差距 ${((entry - ref) / ref * 100).toFixed(1)}%，略過`
          );
          continue;
        }
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

        rows.push({
          recommendation_id:    rec.id,
          horizon,
          price_then:           Math.round(price * 10000) / 10000,
          return_pct:           Math.round(((price - entry) / entry) * 100000) / 1000,
          hit_target:           Number.isFinite(target) && target > 0 ? price >= target : null,
          hit_stop:             Number.isFinite(stop)   && stop   > 0 ? price <= stop   : null,
          elapsed_trading_days: days,
          price_basis:          'close',
          source:               'stooq-backfill',
        });
      }
    }
    await sleep(400);   // 對免費資料源客氣一點
  }
  console.log('\n');

  // ---- 摘要 ----
  if (problems.length) {
    console.log(`跳過 ${problems.length} 項：`);
    problems.slice(0, 15).forEach(p => console.log('  ', p));
    if (problems.length > 15) console.log(`   …另有 ${problems.length - 15} 項`);
    console.log('');
  }

  if (!rows.length) return console.log('沒有可回填的資料。');

  const by = (h) => rows.filter(r => r.horizon === h).map(r => r.return_pct);
  console.log(`可回填 ${rows.length} 筆：`);
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

  if (!DO_WRITE) {
    console.log('\n這是試跑，未寫入。確認數字合理後加上 --write 正式執行。');
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
}

main().catch(e => fail(e.stack || e.message));

/*
 * 替代資料源（若 Stooq 不可用）
 *
 * 1. Finnhub /stock/candle
 *    https://finnhub.io/api/v1/stock/candle?symbol=NVDA&resolution=D&from=<unix>&to=<unix>
 *    最直接，但歷史資料端點近年多半需要付費方案，先確認你的額度。
 *
 * 2. Alpha Vantage TIME_SERIES_DAILY
 *    免費方案每日 25 次請求，124 檔要分五天跑完，但完全免費且穩定。
 *
 * 兩者都只需替換 fetchDailyCloses()，回傳同樣的 { 'YYYY-MM-DD': close } 結構，
 * 其餘邏輯不必更動。
 */
