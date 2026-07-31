// Cloudflare Worker — cron pinger + INDEPENDENT WATCHDOG for the NTN pipeline.
// Lives outside GitHub Actions, Vercel, and the operator's Mac, so it survives
// every failure mode seen so far (GHA billing, dead tokens, Mac asleep).
//
// Crons:
//   :15 / :35 hourly  → dispatch ingest + today-live (legacy pinger role)
//   */15              → watchdog: check roas-live.vercel.app freshness;
//                       stale >80 min → re-dispatch the pipeline workflows;
//                       stale >150 min → WhatsApp the operator.
//
// Secrets: GITHUB_PAT, WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID

const REPO = 'pulkit1165/meta-ads-reports2';
const REF  = 'main';
const PAGE = 'https://roas-live.vercel.app/';
// Per-person report subscriptions — edit + redeploy to change who gets what.
const RECIPIENTS = {
  '919517744959': { morning: true, evening: true, hourly: true },   // Pulkit
  '919815610890': { morning: true, evening: true, hourly: false },
  '919988048804': { morning: false, evening: false, hourly: true },
  '919915868288': { morning: false, evening: false, hourly: true },
  '919988090074': { morning: false, evening: false, hourly: true },
  '919592573796': { morning: false, evening: false, hourly: true },
  '918283901380': { morning: false, evening: false, hourly: true },
};
const WA_RECIPIENTS = Object.keys(RECIPIENTS);
const PORTAL_LABELS = { SM: 'Studd Muffyn', SML: 'SM Life', NBP: 'Nuskhe by Paras' };
const SUMMARY = 'https://roas-live.vercel.app/summary.json';
const WA_TABLE = 'https://roas-live.vercel.app/wa_table.json';
const WA_TABLE_PNG = 'https://roas-live.vercel.app/wa_table.png';
const INR = n => '\u20B9' + Math.round(n).toLocaleString('en-IN');

const CRON_TO_WORKFLOW = {
  '15 * * * *': 'v2-ingest.yml',
  '35 * * * *': 'today-live.yml',
  '25 * * * *': 'camp-snapshots.yml',   // IST :55 — the :58 measurement dispatch
};

async function dispatchWorkflow(env, file) {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${file}/dispatches`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'meta-ads-cron-pinger',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: REF }),
  });
}

// Parse "figures through 27 Jul, 23:04 IST" from the live page → staleness minutes.
async function pageStalenessMinutes() {
  const r = await fetch(PAGE + '?wd=' + Date.now(), { cf: { cacheTtl: 0 } });
  if (!r.ok) return { err: `page HTTP ${r.status}`, mins: 9999 };
  const html = await r.text();
  const m = html.match(/figures through (\d{1,2}) (\w{3}), (\d{2}):(\d{2}) IST/);
  if (!m) {
    if (html.includes('no snapshot yet')) return { err: 'no snapshot yet', mins: 9999 };
    return { err: 'stamp not found', mins: 9999 };
  }
  const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const nowIst = new Date(Date.now() + 330 * 60000); // UTC+5:30, treat as UTC fields
  const stamp = new Date(Date.UTC(nowIst.getUTCFullYear(), months[m[2]], +m[1], +m[3], +m[4]));
  let diff = (nowIst - stamp) / 60000;
  if (diff < -60 * 24 * 300) diff += 0; // year wrap not worth handling
  return { mins: Math.round(diff), stamp: m[0] };
}

async function sendWhatsApp(env, text) {
  // Template ntn_daily_meta_report: {{1}} = date-ish, {{2}} = body (no newlines).
  const flat = text.replace(/[\n\t]+/g, ' · ').replace(/\s{4,}/g, ' ');
  const results = [];
  for (const to of WA_RECIPIENTS) {
    const r = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name: 'ntn_daily_meta_report', language: { code: 'en' },
          components: [{ type: 'body', parameters: [
            { type: 'text', text: 'DASHBOARD ALERT' },
            { type: 'text', text: flat.slice(0, 900) } ] }] },
      }),
    });
    results.push(`${to}:${r.status}`);
  }
  return results.join(' ');
}

async function whapiHealthAlert(env) {
  // If the WhatsApp gateway itself is down, alert via the Meta Cloud API path
  // (independent of Whapi) so the operator hears about it.
  if (!env.WHAPI_TOKEN) return '';
  try {
    const r = await fetch('https://gate.whapi.cloud/health', {
      headers: { 'Authorization': `Bearer ${env.WHAPI_TOKEN}` } });
    const d = await r.json();
    const st = d?.status?.text || 'UNKNOWN';
    if (st === 'AUTH') { await env.WA_STATE.delete('whapi:down'); return ''; }
    // down — alert once per 3h
    const k = 'whapi:down';
    const last = await env.WA_STATE.get(k);
    if (last && Date.now() - Number(last) < 3 * 3600 * 1000) return `whapi:${st}(alerted)`;
    await env.WA_STATE.put(k, String(Date.now()), { expirationTtl: 86400 });
    await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '919517744959', type: 'template',
        template: { name: 'ntn_daily_meta_report', language: { code: 'en' },
          components: [{ type: 'body', parameters: [
            { type: 'text', text: 'WHAPI DOWN' },
            { type: 'text', text: `WhatsApp gateway status ${st} — hourly reports blocked. Rescan QR at panel.whapi.cloud (channel DRSTRG-ZHSR9).` } ] }] } }),
    });
    return `whapi:${st}(ALERT SENT)`;
  } catch (e) { return 'whapi:check-err'; }
}

async function watchdog(env) {
  const wh = await whapiHealthAlert(env);
  if (wh) console.log('whapi-health:', wh);
  const { mins, err, stamp } = await pageStalenessMinutes();
  const note = err ? err : `data age ${mins}m (${stamp})`;
  if (mins <= 80) return `OK — ${note}`;

  // Stale: kick the whole chain. Order matters: snapshots feed the page.
  const kicked = [];
  for (const wf of ['keepalive.yml', 'camp-snapshots.yml', 'roas-email.yml']) {
    const r = await dispatchWorkflow(env, wf);
    kicked.push(`${wf}:${r.status}`);
  }

  let alert = '';
  // Alert once per ~2.5h while down (fires when staleness crosses each 150m band).
  if (mins >= 150 && (mins % 150) < 16) {
    alert = await sendWhatsApp(env,
      `ROAS dashboard STALE ${mins} min (${note}). Auto-restart dispatched: ${kicked.join(', ')}. If this repeats, check github.com/${REPO}/actions and the Mac deploy agent.`);
  }
  return `STALE ${mins}m — kicked [${kicked.join(', ')}] wa=[${alert}]`;
}


async function getSummary() {
  const r = await fetch(SUMMARY + '?t=' + Date.now(), { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error('summary HTTP ' + r.status);
  return r.json();
}

function fmtPortals(obj) {
  return ['SM', 'SML', 'NBP'].filter(p => obj[p]).map(p => {
    const v = obj[p];
    return `${p} ${INR(v.sales)}/${INR(v.spend)} R${v.roas ?? '-'}`;
  }).join(' | ');
}

function portalLine(v) {
  return `${INR(v.sales)} / ${INR(v.spend)} · ROAS ${v.roas ?? '-'}`;
}
function totals(portals) {
  const t = Object.values(portals).reduce((a, v) => ({ s: a.s + v.sales, p: a.p + v.spend }), { s: 0, p: 0 });
  return { line: `${INR(t.s)} / ${INR(t.p)} · ROAS ${t.p ? (t.s / t.p).toFixed(2) : '-'}` };
}

async function morningReport() {
  const s = await getSummary();
  const y = s.yesterday;
  const tp = s.top_products_yday.slice(0, 10)
    .map((p, i) => `${i + 1}. ${p.title} ×${p.qty}`);
  return {
    title: `Daily Final — ${y.date}`,
    sm: portalLine(y.portals.SM || {sales:0,spend:0}),
    sml: portalLine(y.portals.SML || {sales:0,spend:0}),
    nbp: portalLine(y.portals.NBP || {sales:0,spend:0}),
    total: totals(y.portals).line,
    details: 'Top products: ' + tp.map(t => t.replace(/\s+/g,' ')).join(', ').slice(0, 500),
    pretty: `📊 *Daily Final — ${y.date}*\n\nSM: ${portalLine(y.portals.SM)}\nSML: ${portalLine(y.portals.SML)}\nNBP: ${portalLine(y.portals.NBP)}\n*TOTAL: ${totals(y.portals).line}*\n\n*Top 10 by units:*\n${tp.join('\n')}`,
  };
}

async function eveningReport() {
  const s = await getSummary();
  const c = s.closes_today_sm;
  const closing = `${c.closes} campaigns paused today (${c.early} before 9 AM) · ${INR(c.sunk)} spent before close`;
  return {
    title: `Evening — ${s.today}`,
    sm: portalLine(s.live.SM),
    sml: portalLine(s.live.SML),
    nbp: portalLine(s.live.NBP),
    total: totals(s.live).line,
    details: `SM closing: ${closing}. Data as of ${s.built_at.slice(11, 16)} IST`,
    pretty: `🌙 *Evening Report — ${s.today}* (as of ${s.built_at.slice(11, 16)} IST)\n\nSM: ${portalLine(s.live.SM)}\nSML: ${portalLine(s.live.SML)}\nNBP: ${portalLine(s.live.NBP)}\n*TOTAL: ${totals(s.live).line}*\n\n*SM closing:* ${closing}`,
  };
}

async function liveReport() {
  const s = await getSummary();
  const t = Object.values(s.live).reduce((a, v) => ({ s: a.s + v.sales, p: a.p + v.spend }), { s: 0, p: 0 });
  return `Live ${s.today} (as of ${s.built_at.slice(11, 16)} IST) — ${fmtPortals(s.live)} — blended R${t.p ? (t.s / t.p).toFixed(2) : '-'} on ${INR(t.p)} spend. Yesterday: ${fmtPortals(s.yesterday.portals)}`;
}

async function sendWaText(env, to, text) {
  // Unofficial gateways first (no templates/windows); Meta Cloud API as fallback.
  if (env.WHAPI_TOKEN) {
    return fetch('https://gate.whapi.cloud/messages/text', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.WHAPI_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: to + '@s.whatsapp.net', body: text.slice(0, 4000) }),
    });
  }
  if (env.WASSENGER_KEY) {
    return fetch('https://api.wassenger.com/v1/messages', {
      method: 'POST',
      headers: { 'Token': env.WASSENGER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+' + to, message: text.slice(0, 4000) }),
    });
  }
  return fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4000) } }),
  });
}

const YDAY_JSON = 'https://roas-live.vercel.app/yday_report.json';
const YDAY_PNG  = 'https://roas-live.vercel.app/yday_report.png';

async function ydayPush(env, only) {
  // Yesterday-final digest: sales / spend / ROAS / budget allocated vs closed vs
  // still-live-at-10PM, plus day-over-day deltas. Feed built by build_yday_report.py.
  const r = await fetch(YDAY_JSON + '?t=' + Date.now(), { cf: { cacheTtl: 0 } });
  if (!r.ok) return 'yday_report fetch failed ' + r.status;
  const d = await r.json();
  const pcts = v => v == null ? '–' : (v > 0 ? '+' : '') + v + '%';
  const rds  = v => v == null ? '–' : (v > 0 ? '+' : '') + v;
  const block = x => {
    const v = x.vs_prev || {};
    return `*${PORTAL_LABELS[x.portal] || x.portal}*\n` +
      `Sales ${INR(x.sales)} (${pcts(v.sales_pct)}) · ${x.orders} orders (${pcts(v.orders_pct)})\n` +
      `Spend ${INR(x.spend)} (${pcts(v.spend_pct)}) · ROAS ${x.roas ?? '-'} (${rds(v.roas_delta)})\n` +
      `Budget ${INR(x.budget_alloc)} → closed ${INR(x.budget_closed)} · live @10PM ${INR(x.live_10pm)}`;
  };
  const a = d.all, av = a.vs_prev || {};
  const text = `📋 *Yesterday Final — ${d.day}* (vs ${d.prev_day})\n\n` +
    d.rows.map(block).join('\n\n') + '\n\n' +
    `*ALL* — Sales ${INR(a.sales)} (${pcts(av.sales_pct)}) · ${a.orders} orders (${pcts(av.orders_pct)})\n` +
    `Spend ${INR(a.spend)} (${pcts(av.spend_pct)}) · ROAS ${a.roas ?? '-'} (${rds(av.roas_delta)})\n` +
    `Budget ${INR(a.budget_alloc)} → closed ${INR(a.budget_closed)} · live @10PM ${INR(a.live_10pm)}`;
  const out = [];
  const caption = `📋 *Yesterday Final — ${d.day}* · Sales ${INR(a.sales)} / Spend ${INR(a.spend)} · ROAS ${a.roas ?? '-'}`;
  for (const [to, subs] of Object.entries(RECIPIENTS)) {
    if (only && to !== only) continue;
    if (!only && !subs.morning) continue;
    let ok = false;
    if (env.WHAPI_TOKEN) {
      const ir = await fetch('https://gate.whapi.cloud/messages/image', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.WHAPI_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to + '@s.whatsapp.net',
          media: YDAY_PNG + '?t=' + Date.now(), caption }),
      });
      if (ir.ok) { out.push(`${to}:img`); ok = true; }
    }
    if (!ok) {
      const tr = await sendWaText(env, to, text);
      out.push(`${to}:${tr.ok ? 'text' : 'fail-' + tr.status}`);
    }
  }
  return 'yday → ' + out.join(' ');
}

async function sendReport(env, to, rep) {
  if (env.WHAPI_TOKEN || env.WASSENGER_KEY) {
    const r = await sendWaText(env, to, rep.pretty);
    return `${to}:${r.ok ? 'gateway' : 'gateway-fail-' + r.status}`;
  }
  // 1. free-form text — ONLY if the 24h window is verifiably open (user messaged
  // us <23h ago). The API accepts text outside the window but silently drops it.
  const last = await env.WA_STATE.get('last:' + to);
  if (last && Date.now() - Number(last) < 23 * 3600 * 1000) {
    const r = await sendWaText(env, to, rep.pretty);
    const body = await r.json().catch(() => ({}));
    if (r.ok && !body.error) return `${to}:text`;
  }
  // 2. structured template ntn_report_v2 (multiline layout, single-line params)
  const clean = x => String(x).replace(/[\n\t]+/g, ' ').replace(/\s{4,}/g, ' ');
  const t = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
      template: { name: 'ntn_report_v2', language: { code: 'en' },
        components: [{ type: 'body', parameters: [
          rep.title, rep.sm, rep.sml, rep.nbp, rep.total, rep.details,
        ].map(x => ({ type: 'text', text: clean(x).slice(0, 500) })) }] } }),
  });
  if (t.ok) return `${to}:template`;
  // 3. last resort: old single-blob template
  const f = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
      template: { name: 'ntn_daily_meta_report', language: { code: 'en' },
        components: [{ type: 'body', parameters: [
          { type: 'text', text: clean(rep.title) },
          { type: 'text', text: clean(`${rep.sm} | ${rep.sml} | ${rep.nbp} | TOTAL ${rep.total} · ${rep.details}`).slice(0, 900) } ] }] } }),
  });
  return `${to}:fallback:${f.status}`;
}

async function hourlyPush(env, only) {
  const r = await fetch(WA_TABLE + '?t=' + Date.now(), { cf: { cacheTtl: 0 } });
  if (!r.ok) return 'wa_table fetch failed ' + r.status;
  const t = await r.json();
  const line = x => `${x.website}: Rs ${x.sales.toLocaleString('en-IN')} / Rs ${x.spend.toLocaleString('en-IN')} · ROAS ${x.roas ?? '-'}`;
  let caption = `⏱ *Report @ ${t.data_through || '?'} IST — day so far*\n` + t.rows.map(line).join('\n');
  if (t.hour_slice?.length) {
    const hh = parseInt(t.data_through) - 1;
    caption += `\n\n*Last hour (${String(hh).padStart(2,'0')}:00–${String(hh).padStart(2,'0')}:59):*\n` +
      t.hour_slice.map(line).join('\n');
  }
  const out = [];
  for (const [to, subs] of Object.entries(RECIPIENTS)) {
    if (only && to !== only) continue;
    if (!only && !subs.hourly) continue;
    if (env.WHAPI_TOKEN) {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        const ir = await fetch('https://gate.whapi.cloud/messages/image', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.WHAPI_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: to + '@s.whatsapp.net',
            media: WA_TABLE_PNG + '?t=' + Date.now(), caption }),
        });
        if (ir.ok) { out.push(`${to}:img`); ok = true; break; }
        if (attempt === 1) out.push(`${to}:img-fail-${ir.status}`);
        await new Promise(r => setTimeout(r, 1500));
      }
      if (ok) continue;
    }
    const tr = await sendWaText(env, to, caption);
    out.push(`${to}:${tr.ok ? 'txt' : 'txt-fail'}`);
  }
  return `hourly → ${out.join(' ')}`;
}

async function pushReport(env, kind, only) {
  let rep;
  try { rep = kind === 'morning' ? await morningReport() : await eveningReport(); }
  catch (e) { return `report build failed: ${e.message}`; }
  const out = [];
  for (const [to, subs] of Object.entries(RECIPIENTS)) {
    if (only && to !== only) continue;
    if (!only && !subs[kind]) continue;
    out.push(await sendReport(env, to, rep));
  }
  return `${kind} push → ${out.join(' ') || 'no subscribers'}`;
}

export default {
  async scheduled(event, env, ctx) {
    const ts = new Date().toISOString();
    if (event.cron === '*/15 * * * *') {
      const out = await watchdog(env);
      console.log(`[${ts}] watchdog: ${out}`);
      // Report scheduling rides the 15-min tick (free plan = max 5 crons).
      // KV keys dedupe so each report fires exactly once per slot.
      const ist = new Date(Date.now() + 330 * 60000);
      const ymd = ist.toISOString().slice(0, 10);
      const h = ist.getUTCHours(), m = ist.getUTCMinutes();
      const fire = async (key, fn) => {
        if (await env.WA_STATE.get(key)) return;
        await env.WA_STATE.put(key, '1', { expirationTtl: 172800 });
        console.log(`[${ts}] ${await fn()}`);
      };
      if (h === 9 && m < 15) await fire(`push:morning:${ymd}`, () => pushReport(env, 'morning'));
      if (h === 8 && m < 15) await fire(`push:yday:${ymd}`, () => ydayPush(env));
      if (h === 20 && m < 15) await fire(`push:evening:${ymd}`, () => pushReport(env, 'evening'));
      // Backstop only: if the :58-notify path failed and the table is fresh
      // (<25 min old), send at the :15 tick. Same dedupe key as notify-hourly.
      if (m >= 15 && m < 30 && !(await env.WA_STATE.get('pause:hourly'))) {
        try {
          const tr = await fetch(WA_TABLE + '?t=' + Date.now(), { cf: { cacheTtl: 0 } });
          if (tr.ok) {
            const tt = await tr.json();
            const age = Date.now() - Date.parse(tt.built_at);
            const kvKey = `push:hourly58:${tt.day}:${tt.data_through}`;
            if (age < 25 * 60000 && !(await env.WA_STATE.get(kvKey))) {
              await env.WA_STATE.put(kvKey, '1', { expirationTtl: 172800 });
              console.log(`[${ts}] backstop ${await hourlyPush(env)}`);
            }
          }
        } catch (e) { console.error('hourly backstop err', e.message); }
      }
      return;
    }
    const file = CRON_TO_WORKFLOW[event.cron];
    if (!file) { console.error(`[${ts}] unknown cron "${event.cron}"`); return; }
    const r = await dispatchWorkflow(env, file);
    console.log(`[${ts}] cron "${event.cron}" → ${file} ${r.ok ? 'ok' : 'FAIL ' + r.status}`);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' };
    if (url.pathname === '/webhook' && request.method === 'GET') {
      // Meta webhook verification handshake
      if (url.searchParams.get('hub.verify_token') === env.WA_VERIFY_TOKEN) {
        return new Response(url.searchParams.get('hub.challenge'), { headers: cors });
      }
      return new Response('bad verify token', { status: 403, headers: cors });
    }
    if (url.pathname === '/whapi' && request.method === 'POST') {
      try {
        const b = await request.json();
        for (const m of (b?.messages || [])) {
          if (m.from_me) continue;
          const from = String(m.from || m.chat_id || '').replace(/@.*/, '').replace(/[^0-9]/g, '');
          if (!WA_RECIPIENTS.includes(from)) continue;
          const q = String(m.text?.body || m.body || '').trim().toLowerCase();
          let reply;
          if (/^(roas|report|live|status)/.test(q)) reply = await liveReport();
          else if (/^(yday|yesterday|final)/.test(q)) reply = (await morningReport()).pretty;
          else if (/^clos/.test(q)) reply = (await eveningReport()).pretty;
          else reply = 'Commands: roas · yesterday · closing. Auto-reports 9 AM & 8 PM.';
          await sendWaText(env, from, reply);
        }
      } catch (e) { console.error('whapi webhook err', e.message); }
      return new Response('ok', { headers: cors });
    }
    if (url.pathname === '/wassenger' && request.method === 'POST') {
      try {
        const b = await request.json();
        const ev = b?.event || b?.type || '';
        const data = b?.data || {};
        if (String(ev).includes('message:in')) {
          const from = String(data.fromNumber || data.phone || '').replace(/[^0-9]/g, '');
          if (WA_RECIPIENTS.includes(from)) {
            const q = String(data.body || '').trim().toLowerCase();
            let reply;
            if (/^(roas|report|live|status)/.test(q)) reply = await liveReport();
            else if (/^(yday|yesterday|final)/.test(q)) reply = (await morningReport()).pretty;
            else if (/^clos/.test(q)) reply = (await eveningReport()).pretty;
            else reply = 'Commands: roas · yesterday · closing. Auto-reports 9 AM & 8 PM.';
            await sendWaText(env, from, reply);
          }
        }
      } catch (e) { console.error('wassenger webhook err', e.message); }
      return new Response('ok', { headers: cors });
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const body = await request.json();
        const val = body?.entry?.[0]?.changes?.[0]?.value;
        for (const st of (val?.statuses || [])) {
          console.log(`wa-status ${st.recipient_id} ${st.status} ${JSON.stringify(st.errors || '')}`);
        }
        const msg = val?.messages?.[0];
        if (msg && msg.type === 'text') {
          const from = msg.from;
          if (WA_RECIPIENTS.includes(from)) {
            await env.WA_STATE.put('last:' + from, String(Date.now()));
            const q = (msg.text?.body || '').trim().toLowerCase();
            let reply;
            if (/^(roas|report|live|status)/.test(q)) reply = await liveReport();
            else if (/^(yday|yesterday|final)/.test(q)) reply = (await morningReport()).pretty;
            else if (/^clos/.test(q)) reply = (await eveningReport()).pretty;
            else reply = 'Commands: roas (live) · yesterday (final) · closing (SM closes). Reports auto-arrive 9 AM & 8 PM.';
            await sendWaText(env, from, reply);
          }
        }
      } catch (e) { console.error('webhook err', e.message); }
      return new Response('ok', { headers: cors });
    }
    if (url.pathname === '/notify-hourly') {
      if (url.searchParams.get('key') !== 'ntnhourly2026') {
        return new Response('nope', { status: 403, headers: cors });
      }
      // Dedupe on the table's data_through stamp so retries can't double-send.
      const tr = await fetch(WA_TABLE + '?t=' + Date.now(), { cf: { cacheTtl: 0 } });
      if (!tr.ok) return new Response('table fetch fail', { headers: cors });
      const tt = await tr.json();
      const kvKey = `push:hourly58:${tt.day}:${tt.data_through}`;
      if (await env.WA_STATE.get(kvKey)) return new Response('already sent ' + tt.data_through, { headers: cors });
      await env.WA_STATE.put(kvKey, '1', { expirationTtl: 172800 });
      const out = await hourlyPush(env);
      return new Response(out, { headers: cors });
    }
    if (url.pathname === '/test-yday') {
      return new Response(await ydayPush(env, url.searchParams.get('to') || null), { headers: cors });
    }
    if (url.pathname === '/test-hourly') {
      return new Response(await hourlyPush(env, url.searchParams.get('to') || null), { headers: cors });
    }
    if (url.pathname === '/test-push') {
      return new Response(await pushReport(env, url.searchParams.get('kind') || 'morning',
        url.searchParams.get('to') || null), { headers: cors });
    }
    if (url.pathname === '/test-live') {
      try { return new Response(await liveReport(), { headers: cors }); }
      catch (e) { return new Response('ERR ' + e.message, { headers: cors }); }
    }
    if (url.pathname === '/wa-debug') {
      const r = await fetch(WA_TABLE + '?t=' + Date.now(), {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
      });
      const body = r.ok ? await r.json() : { err: r.status };
      const hdrs = {};
      for (const k of ['x-vercel-id', 'x-vercel-cache', 'age', 'last-modified', 'etag', 'date']) hdrs[k] = r.headers.get(k);
      return new Response(JSON.stringify({
        colo: request.cf?.colo, stamp: body.stamp, day: body.day,
        data_through: body.data_through, built_at: body.built_at, vercel: hdrs,
      }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/whapi-status') {
      try {
        const hdr = { 'Authorization': `Bearer ${env.WHAPI_TOKEN}` };
        const [h, m] = await Promise.all([
          fetch('https://gate.whapi.cloud/health', { headers: hdr }).then(r => r.json()).catch(e => ({ err: e.message })),
          fetch('https://gate.whapi.cloud/messages/list?count=100', { headers: hdr }).then(r => r.json()).catch(e => ({ err: e.message })),
        ]);
        const chats = {}; const recent = [];
        for (const msg of (m.messages || [])) {
          if (!msg.from_me) continue;
          chats[msg.chat_id] = (chats[msg.chat_id] || 0) + 1;
          if (recent.length < 30) recent.push({
            to: msg.chat_id, type: msg.type, at: new Date(msg.timestamp * 1000).toISOString(),
            caption: ((msg.image?.caption || msg.text?.body || '')).slice(0, 60),
            status: msg.status,
          });
        }
        return new Response(JSON.stringify({ health: h, sent_total: m.total, distinct_outbound_chats: Object.keys(chats).length, per_chat: chats, recent_outbound: recent }, null, 2),
          { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) { return new Response('ERR ' + e.message, { headers: cors }); }
    }
    if (url.pathname === '/watchdog') {
      return new Response(await watchdog(env), { headers: cors });
    }
    if (url.pathname === '/ping-ingest') {
      const r = await dispatchWorkflow(env, 'v2-ingest.yml');
      return new Response(`ingest dispatch: ${r.status}`, { headers: cors });
    }
    if (url.pathname === '/ping-deploy') {
      const r = await dispatchWorkflow(env, 'today-live.yml');
      return new Response(`deploy dispatch: ${r.status}`, { headers: cors });
    }
    return new Response('meta-ads-cron-pinger: /watchdog /ping-ingest /ping-deploy', { headers: cors });
  },
};
