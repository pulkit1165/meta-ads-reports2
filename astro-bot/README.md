# Astro Q&A bot — paid Vedic + numerology questions over WhatsApp

Customer buys a question pack → messages WhatsApp → bot builds their **full kundli and
numerology** → answers N questions from that chart, and only from that chart.

## The no-hallucination design

The model has **no astrological knowledge of this customer**. Everything factual is computed
first, and everything the model writes is checked back against those computations.

```
birth details ──▶ deterministic engine ──▶ fact pack ──▶ topic router ──▶ model ──▶ GUARD ──▶ customer
                  (ephemeris + numerology)   (43 atomic     (keywords,     (writes    (verifies      │
                                              facts)         no model)     prose)     every claim)   │
                                                                              ▲                      │
                                                                              └── repair once ───────┘
                                                                                  then template fallback
```

1. **Compute, never recall.** `crystal-finder/api/_factpack.js` computes 9 grahas with dignity
   and retrogression, 12 whole-sign houses with lords, Vimshottari dasha to *pratyantar* level
   with dates, live transits, Sade Sati with real ingress/egress dates bisected from the
   ephemeris, and numerology (mulank, bhagyank, Chaldean + Pythagorean name numbers, personal
   year, Lo Shu grid). Same engine as the live Crystal Finder page.
2. **Deterministic retrieval.** `factpack.classify()` picks the topic by keyword (Hinglish
   included) and hands the model only the relevant facts. The model never chooses its own evidence.
3. **Grounded generation.** The system prompt states the model has no independent knowledge and
   may state only what appears in `FACTS`.
4. **Verification (`guard.py`).** Every checkable claim is matched back against the pack:
   planet-in-sign (natal *and* transit), planet-in-house, birth nakshatra, dasha lords with
   present-tense detection, every 4-digit year, numerology numbers, degrees, and — when birth
   time is missing — any assertion about the ascendant.
5. **Two independent gates, both must pass (`flow._passes_both_gates`).** Gate 1 is
   `guard.py` — deterministic regex against the pack. For every claim shape it recognises it
   cannot be wrong, since it is arithmetic, not judgment. Gate 2 is `llm.verify_second_opinion` —
   a second model call, differently framed, that reads the SAME draft cold and hunts for
   anything gate 1's patterns miss. This matters because gate 1 can only ever check claim
   *types* someone coded in — it has no way to catch a wholesale invented concept (a dosha, a
   yoga, "combust") that isn't even a field in the fact pack. Gate 2 catches exactly that class,
   verified against real fabricated test cases (Kalasarpa dosha, Guru Chandal yoga, combustion —
   none computed by the engine, all caught). It also caught something subtler in production
   testing: a draft that tried to *reassure* the customer by ruling out a dosha it had no
   grounds to rule out — a failure mode no regex could ever express.
6. **Repair, then refuse to guess.** A violation from either gate triggers one repair attempt
   naming the specific contradictions. If the repair still fails either gate, the customer gets
   a deterministic facts-only reply. No unverified sentence is ever delivered, and a failed
   question is **refunded**.

Interpretation ("Saturn in the 6th means you outlast competitors") is the model's job and is not
checked. The facts underneath it are never the model's to invent.

**Cost of the second gate:** every answer now costs up to 4 model calls in the worst case
(draft → gate 2 → repair draft → gate 2 again), versus 2 before. On `claude_cli` this adds real
wall-clock (a repaired answer took 154s in testing, vs ~15-30s for a clean single-pass answer).
On the `api` backend it adds real $ per question, not just latency. This is the deliberate
trade for closing a fabrication class the regex guard structurally cannot reach — worth it for
a service whose one hard requirement is "never hallucinate," but worth knowing before scaling.

## Setup

```bash
cp .env.example .env      # fill WA_ACCESS_TOKEN + WA_VERIFY_TOKEN
pip3 install -r requirements.txt
./run.sh                  # serves :8090
```

Point the Meta webhook at `https://<tunnel>/webhook`.

**LLM backend** — `ASTRO_LLM_BACKEND=claude_cli` runs `claude -p` on this Mac (no API spend, dies
when the Mac sleeps). Set `ASTRO_LLM_BACKEND=api` + `ANTHROPIC_API_KEY` for production; nothing
else changes.

## Question packs

| Shopify handle | ₹ | Questions |
|---|---|---|
| `3-questions-for-399` | 399 | 3 |
| `10-questions-for-999` | 999 | 10 |
| `15-questions-for-1399` | 1399 | 15 |
| `20-questions-for-1699` | 1699 | 20 |
| `ai-astro-bot` | 499 | 5 |

Customer sends `order 1234`; `shopify_verify.py` confirms the order is **paid**, contains a pack
SKU, and matches their phone (last 10 digits) before granting. Grants are idempotent per order line.

## Customer commands

`help` · `balance` · `reading` (kundli again) · `order <number>` · `restart`

## Files

| File | Role |
|---|---|
| `flow.py` | State machine: onboarding → free reading → paid Q&A |
| `guard.py` | Hallucination verification — the safety net |
| `factpack.py` | Fact-pack client + deterministic topic routing |
| `llm.py` | Prompt construction, `claude -p` and Anthropic API backends |
| `store.py` | SQLite: users, quota, question log, message audit |
| `shopify_verify.py` | Order → quota, read-only |
| `server.py` | Flask webhook, dedupe, per-customer lock, rate limit |

The chart engine lives in `../crystal-finder/api/_factpack.js` (deployed to Vercel).

## Operational notes

- **Quota is consumed before generation and refunded on any failure**, so a crash or a model
  refusal never costs the customer a question.
- Meta retries webhooks; `server.py` dedupes on message id, and a per-phone lock stops two fast
  messages double-spending.
- Fact packs are cached 6 h — transits move daily, so they must not be cached longer.
- `questions.guard_status` is the metric to watch: `clean` / `repaired` / `fallback`. A rising
  `fallback` rate means the prompt or the guard needs attention.

## Blocker before launch

The Studd Muffyn production WhatsApp number (+91 80 6808 1730, phone id `781898185017019`)
returns `(#200) You do not have the necessary permissions to send messages on behalf of this
WhatsApp Business Account`. The only sendable number is the 5-recipient test number, which cannot
serve customers. Fix on the Meta side: claim the "NTN Ads Bot" app into the Studd Muffyn business
and regenerate the system-user token there, or grant the Antriksh Bot system user Full Control of
the Studd Muffyn WABA. Everything else is built and tested.

## Running it on WhatsApp (test number)

```bash
./run.sh &      # bot on :8090
./tunnel.sh     # public tunnel + re-points Meta's webhook at it
```

`tunnel.sh` must be re-run whenever the Mac sleeps or the tunnel restarts — quick-tunnel
hostnames rotate, and Meta has to be told the new one. A `{"success":true}` from Meta means it
completed its verification handshake against the tunnel, so the path is proven end to end.

Currently pointed at the **test number +1 555 061 1589** (WABA `101654855980065`), which can only
message 5 pre-registered recipients — fine for testing, useless for customers.

**Rollback:** the NTN Ads Bot webhook on that WABA previously pointed at
`https://meta-ads-cron-pinger.pulkit-studdmuffyn.workers.dev/webhook` (the internal ops bot,
which had received no inbound message since 14 May 2026). To restore it, POST that URL back to
`/{WABA}/subscribed_apps` as `override_callback_uri`.
