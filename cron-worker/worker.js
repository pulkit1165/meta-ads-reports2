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

export default {
  async scheduled(event, env, ctx) {
    const ts = new Date().toISOString();
    if (event.cron === '*/15 * * * *') {
      const out = await watchdog(env);
      console.log(`[${ts}] watchdog: ${out}`);
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
