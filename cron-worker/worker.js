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
const WA_RECIPIENTS = ['919517744959', '919815610890'];
const SUMMARY = 'https://roas-live.vercel.app/summary.json';
const INR = n => '\u20B9' + Math.round(n).toLocaleString('en-IN');

const CRON_TO_WORKFLOW = {
  '15 * * * *': 'v2-ingest.yml',
  '35 * * * *': 'today-live.yml',
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

async function watchdog(env) {
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

async function morningReport() {
  const s = await getSummary();
  const y = s.yesterday;
  const tp = s.top_products_yday.slice(0, 10)
    .map((p, i) => `${i + 1}. ${p.title} x${p.qty}`).join(' · ');
  const tot = Object.values(y.portals).reduce((a, v) => ({ s: a.s + v.sales, p: a.p + v.spend }), { s: 0, p: 0 });
  return `Yesterday ${y.date} FINAL — ${fmtPortals(y.portals)} — TOTAL ${INR(tot.s)}/${INR(tot.p)} R${(tot.s / tot.p).toFixed(2)}. TOP: ${tp}`;
}

async function eveningReport() {
  const s = await getSummary();
  const c = s.closes_today_sm;
  return `Today ${s.today} live — ${fmtPortals(s.live)}. SM closing: ${c.closes} campaigns paused (${c.early} before 9AM), ${INR(c.sunk)} spent before close. Data as of ${s.built_at.slice(11, 16)} IST`;
}

async function liveReport() {
  const s = await getSummary();
  const t = Object.values(s.live).reduce((a, v) => ({ s: a.s + v.sales, p: a.p + v.spend }), { s: 0, p: 0 });
  return `Live ${s.today} (as of ${s.built_at.slice(11, 16)} IST) — ${fmtPortals(s.live)} — blended R${t.p ? (t.s / t.p).toFixed(2) : '-'} on ${INR(t.p)} spend. Yesterday: ${fmtPortals(s.yesterday.portals)}`;
}

async function sendWaText(env, to, text) {
  return fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4000) } }),
  });
}

async function pushReport(env, kind) {
  let text;
  try { text = kind === 'morning' ? await morningReport() : await eveningReport(); }
  catch (e) { text = `report build failed: ${e.message}`; }
  const title = kind === 'morning' ? 'DAILY REPORT' : 'CLOSING REPORT';
  const out = [];
  for (const to of WA_RECIPIENTS) {
    // template first (works outside 24h window)
    const r = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
        template: { name: 'ntn_daily_meta_report', language: { code: 'en' },
          components: [{ type: 'body', parameters: [
            { type: 'text', text: title },
            { type: 'text', text: text.replace(/[\n\t]+/g, ' · ').replace(/\s{4,}/g, ' ').slice(0, 900) } ] }] } }),
    });
    out.push(`${to}:${r.status}`);
  }
  return `${kind} push → ${out.join(' ')}`;
}

export default {
  async scheduled(event, env, ctx) {
    const ts = new Date().toISOString();
    if (event.cron === '*/15 * * * *') {
      const out = await watchdog(env);
      console.log(`[${ts}] watchdog: ${out}`);
      return;
    }
    if (event.cron === '30 3 * * *') {   // 09:00 IST
      console.log(`[${ts}] ${await pushReport(env, 'morning')}`);
      return;
    }
    if (event.cron === '30 14 * * *') {  // 20:00 IST
      console.log(`[${ts}] ${await pushReport(env, 'evening')}`);
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
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const body = await request.json();
        const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (msg && msg.type === 'text') {
          const from = msg.from;
          if (WA_RECIPIENTS.includes(from)) {
            const q = (msg.text?.body || '').trim().toLowerCase();
            let reply;
            if (/^(roas|report|live|status)/.test(q)) reply = await liveReport();
            else if (/^(yday|yesterday|final)/.test(q)) reply = await morningReport();
            else if (/^clos/.test(q)) reply = await eveningReport();
            else reply = 'Commands: roas (live) · yesterday (final) · closing (SM closes). Reports auto-arrive 9 AM & 8 PM.';
            await sendWaText(env, from, reply);
          }
        }
      } catch (e) { console.error('webhook err', e.message); }
      return new Response('ok', { headers: cors });
    }
    if (url.pathname === '/test-push') {
      return new Response(await pushReport(env, url.searchParams.get('kind') || 'morning'), { headers: cors });
    }
    if (url.pathname === '/test-live') {
      try { return new Response(await liveReport(), { headers: cors }); }
      catch (e) { return new Response('ERR ' + e.message, { headers: cors }); }
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
