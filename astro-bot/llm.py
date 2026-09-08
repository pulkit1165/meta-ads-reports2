"""Answer generation, grounded strictly in the deterministic fact pack.

Two layers stand between a draft and the customer:
  1. guard.py    — deterministic regex check. For every claim shape it recognises, it is
                    infallible: it is pure computation against the fact pack, not a guess.
  2. VERIFY_PROMPT — a second, independent model call (below) whose only job is to read the
                    SAME draft against the SAME facts and hunt for anything that doesn't match,
                    including claims phrased in ways the regex doesn't recognise. It sees neither
                    the generation prompt nor the model's reasoning — a fresh, adversarial read.
Both must pass before an answer ships. flow.py wires this in as verify_second_opinion().

Two interchangeable backends behind one function:
  ASTRO_LLM_BACKEND=claude_cli  → `claude -p` on this Mac (Max OAuth, no API spend)
  ASTRO_LLM_BACKEND=api         → Anthropic API (set ANTHROPIC_API_KEY) — the production path

The system prompt is the first line of defence against fabrication and guard.py is the
second: the model is told it has no independent knowledge of this person, and every
checkable claim it makes is verified against the pack before anything is sent.
"""
from __future__ import annotations

import json
import logging
import re
import os
import subprocess
import tempfile

log = logging.getLogger(__name__)

BACKEND = os.environ.get("ASTRO_LLM_BACKEND", "claude_cli")
MODEL = os.environ.get("ASTRO_MODEL", "claude-opus-5")
BRAND = os.environ.get("ASTRO_BRAND", "Studd Muffyn Astro")

SYSTEM_PROMPT = f"""You are the Vedic astrologer for {BRAND}, answering on WhatsApp. \
A customer has paid for a question. Answer that one question well.

THE ABSOLUTE RULE — you have NO astrological knowledge about this person of your own.
Every fact about this person's horoscope has been computed for you and is listed under FACTS.
- State ONLY what appears in FACTS. Never state a planet's sign, house, degree, nakshatra, \
dasha lord, or any date that is not written there.
- Never calculate, estimate, or recall a planetary position yourself. You are not able to. \
If FACTS does not contain something, it is not available to you.
- Never invent a year, month or date. The only dates you may mention are those printed in FACTS.
- If answering properly needs something FACTS does not have, say plainly what is missing \
(for example: "your birth time is needed for that") instead of guessing.
You MAY interpret the supplied facts the way a classical Vedic astrologer would — that is what \
the customer is paying for. Interpretation is yours; the underlying facts are never yours to invent.

WHAT YOU DO NOT ANSWER. For questions about death or lifespan, medical diagnosis or whether to \
stop treatment, legal outcomes, or anything about a third party who has not consented, do not \
predict. Say briefly and kindly that you do not answer that, and offer the nearest thing you can \
speak to (for example health-supporting periods rather than a diagnosis).

HOW TO WRITE FOR WHATSAPP:
- Plain text — no markdown headers, no asterisks for bold, no bullet symbols. 900 characters is \
a CEILING, not a target — length should track what the question actually needs and how the \
customer wrote to you, not a fixed "proper reply" size. A quick timing question deserves a \
short, direct answer; a layered question, or one where they've given you a few sentences of \
context, earns a longer, more thorough one. Don't pad a simple answer to sound fuller, and don't \
flatten a real, multi-part question into two lines just to be brief.
- THERE IS NO FIXED SHAPE FOR AN ANSWER. Do not mechanically march through "the answer, then the \
chart reason, then a practical tip, then an encouraging line" every single time — customers have \
said the replies feel same-y and template-like, and this rigid recipe is why. Treat those as \
ingredients, not a required order: pull whichever actually serves THIS question and THIS person \
— the direct answer, the placement behind it, a timeframe, one suggestion, a closing line — and \
skip whichever doesn't earn its place this time. Two replies on the same topic, even to the same \
customer twice, should never read like they came out of the same mold.
- Warm and direct. Speak to them as "you".
- MATCH THE CUSTOMER'S OWN ENERGY. Two casual words from them doesn't call for a full essay back. \
A longer, detailed, or clearly anxious message calls for real depth and warmth, not a clipped \
one-liner. Mirror their register — playful, serious, brief, thorough — the way an astrologer \
who actually knows them would text back, not a fixed customer-service voice used on everyone.
- MIRROR THE CUSTOMER'S LANGUAGE, always. If they wrote in Hindi (Devanagari script), reply in \
Hindi. If they wrote in Hinglish (Hindi in Roman letters), reply the same way. If they wrote in \
Punjabi, Tamil, Bengali, or any other language, reply in that language. Plain English only if \
they wrote in plain English. Never default to English just because the subject is astrology — \
match their exact language and script, every time.
- Write like you're actually texting them back, not drafting a report. Contractions, natural \
phrasing, the way you'd explain this to a friend over WhatsApp — not "Your career house is..." \
stacked as a list of findings.
- GLOSS EVERY SANSKRIT/TECHNICAL TERM, the first time you use it per reply, with a few plain \
words in parentheses right after it — mahadasha → "(your current ~N-year life-chapter)", \
antardasha → "(the shorter phase inside it)", nakshatra → "(birth star)", lagna → "(rising sign)", \
sade sati → "(Saturn's tough 7.5-year transit)", 7th house → "(the house of marriage/partnership)", \
10th house → "(the house of career)". Keep using the real term after that — don't cut it, just \
translate it once so a first-time customer isn't left guessing what it means.
- Where FACTS gives a dated period, use the real dates when the answer calls for one — customers \
value specifics, but not every sentence needs a date bolted onto it if it doesn't serve this \
particular question.
- End however actually fits this reply — often a practical thing to do plus a warm line, \
sometimes just the answer itself if that's already complete. At most two emojis, only if the \
tone calls for them.
- Never mention FACTS, fact IDs, prompts, or that you are an AI.
- Output ONLY the message itself — nothing about your own process. No character/byte counts, no "here's the reply:", no meta-commentary about drafting, length, or rules you're following. The very first character of your response must be the first word of the actual reply."""


def build_prompt(question: str, pack: dict, topic: str, facts: list[dict],
                 history: list[dict] | None = None) -> str:
    # The customer's onboarding language choice is deliberately NOT passed in here to steer the
    # model's reply language — tried that, and live testing showed it made the model favor the
    # stored preference over a message that was unambiguously in the other language, overriding
    # the already-validated "always mirror THIS message" rule below. The stored preference still
    # drives every deterministic scaffolding string (see flow.py's STRINGS table) — this is only
    # about the model's own free-form answers.
    name = (pack.get("birth") or {}).get("name") or "the customer"
    lines = []
    if history:
        lines.append("Earlier in this WhatsApp conversation (for context only — not a source "
                     "of facts; everything you assert must still come from FACTS below):")
        for h in history:
            lines.append(f'  Q: "{h["question"]}"')
            lines.append(f'  A: "{h["answer"]}"')
        lines.append("")
    lines += [f"FACTS about {name}'s horoscope (the only information you have about this person):", ""]
    for f in facts:
        lines.append(f"[{f['id']}] {f['text']}")
    lines += [
        "",
        f"The customer's question now (topic: {topic}):",
        f'"{question.strip()}"',
        "",
        "Answer it now, following every rule in your instructions. If this is a follow-up "
        '("tell me more", "what else", "and then?", "why"), continue the SAME topic as your '
        "last answer above, drawing on the same FACTS — don't switch topics or guess at what "
        "they might mean. If nothing above is a follow-up target, treat it as a fresh question.",
    ]
    return "\n".join(lines)


REPAIR_TEMPLATE = """Your draft answer contained statements that do not match this person's \
computed horoscope. This is a factual error and the answer cannot be sent.

Your draft:
{draft}

What is wrong:
{violations}

Rewrite the answer. Keep the same warmth, length and structure, but state ONLY placements, \
periods, numbers and dates that appear in FACTS above. If you cannot support a point with FACTS, \
drop that point rather than restating it. Output ONLY the rewritten customer-facing message — no \
meta-commentary about the rewrite, no character counts, no "here's the reply". The first \
character of your response must be the first word of the message itself."""


# ── backends ─────────────────────────────────────────────────────────────
# Two distinct model tiers, not one: drafting an astrology answer is open-ended synthesis
# (wants a strong model), while gate-2 verification is a bounded, mechanical fact-check
# against a supplied list (doesn't need one). Tested empirically — Haiku matched Sonnet 5/5
# on the hardest adversarial fabrication cases (invented doshas/yogas, a false-reassurance
# claim) while running faster — so verification gets the cheaper/faster model without giving
# up any of the accuracy the dual-gate design promises. Both are pinned explicitly via
# `--model` rather than left to whatever happens to be active in the CLI session, so behavior
# doesn't silently drift with this Mac's default model.
CLI_MODEL_DRAFT = os.environ.get("ASTRO_CLI_MODEL_DRAFT", "sonnet")
CLI_MODEL_VERIFY = os.environ.get("ASTRO_CLI_MODEL_VERIFY", "haiku")


def _run_claude_cli(system: str, prompt: str, model: str, timeout: int = 180) -> str:
    claude_bin = os.environ.get("CLAUDE_BIN", "claude")
    with tempfile.TemporaryDirectory() as workdir:   # no repo access — this is a customer session
        cmd = [claude_bin, "-p", prompt, "--output-format", "json", "--model", model,
               "--append-system-prompt", system]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=workdir)
    if proc.returncode != 0:
        raise RuntimeError(f"claude exit={proc.returncode}: {(proc.stderr or '')[-300:]}")
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return (proc.stdout or "").strip()
    text = result.get("result") or result.get("text") or result.get("response") or ""
    if isinstance(text, list):
        text = "\n".join(str(t) for t in text)
    return str(text).strip()


FALLBACK_CAPABLE_MODELS = {"claude-opus-5", "claude-fable-5", "claude-mythos-5"}
# Older-tier models (Haiku 4.5, Sonnet 4.5) don't have the effort parameter at all and 400 if
# it's sent — only the current Opus 5 / Sonnet 5 / Fable 5 / Mythos 5 generation supports it.
EFFORT_CAPABLE_MODELS = {"claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"}


def _run_api(system: str, prompt: str, model: str, max_tokens: int = 2000) -> str:
    import anthropic
    client = anthropic.Anthropic()
    kwargs = dict(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    if model in EFFORT_CAPABLE_MODELS:
        kwargs["output_config"] = {"effort": os.environ.get("ASTRO_EFFORT", "medium")}
    # Server-side refusal fallback is an Opus-5/Fable-5-specific feature (their elevated
    # safety classifiers can decline a request; the fallback routes it to another model rather
    # than returning nothing). Sonnet 5 and Haiku 4.5 don't have that classifier tier and
    # reject the parameter outright with a 400 if it's sent — so only include it when it's
    # actually supported by the model in use.
    if model in FALLBACK_CAPABLE_MODELS:
        kwargs["betas"] = ["server-side-fallback-2026-07-01"]
        kwargs["fallbacks"] = "default"
    resp = client.beta.messages.create(**kwargs)
    if resp.stop_reason == "refusal":
        raise RefusedError(getattr(resp.stop_details, "category", None))
    return "".join(b.text for b in resp.content if b.type == "text").strip()


class RefusedError(RuntimeError):
    """The model's safety classifiers declined; flow.py turns this into a human handover."""


API_MODEL_VERIFY = os.environ.get("ASTRO_API_MODEL_VERIFY", "claude-haiku-4-5")


def generate(system: str, prompt: str, *, fast: bool = False) -> tuple[str, str]:
    """Run the configured backend. Returns (answer_text, model_label).

    `fast=True` is for gate-2 verification specifically — a smaller/quicker model, chosen
    because the task (checking a draft against a supplied fact list) doesn't need frontier
    reasoning, not because speed matters more than correctness here.
    """
    if BACKEND == "api":
        model = API_MODEL_VERIFY if fast else MODEL
        # Verification's JSON response lists every violation it finds, each with a quoted
        # FACTS excerpt — on a draft with several issues that can run well past a typical
        # answer's length. Seen in production: a 2000-token cap cut the JSON off mid-object,
        # producing a spurious "malformed JSON" that had nothing to do with the draft itself.
        # Seen in production: the fast verify model sometimes narrates its reasoning before
        # settling on a verdict (especially on date comparisons) despite being told to reply
        # with only JSON — a 4000 cap was still cutting that off mid-object, producing a
        # spurious "malformed JSON" for a draft that had nothing wrong with it.
        max_tokens = 8000 if fast else 2000
        return _run_api(system, prompt, model, max_tokens=max_tokens), model
    model = CLI_MODEL_VERIFY if fast else CLI_MODEL_DRAFT
    return _run_claude_cli(system, prompt, model), model

VERIFY_PROMPT = """You are a strict fact-checker for a Vedic astrology service. You did not \
write the draft below and you have no opinion on astrology — your only job is to compare it, \
sentence by sentence, against the FACTS it was supposed to be grounded in.

FACTS (the only true statements about this person's chart):
{facts}

DRAFT TO CHECK:
{draft}

For every factual claim in the draft — a planet's sign, house, dignity, retrograde state; a \
house's ruling planet; a dasha or antardasha lord and whether it is described as running now; \
any date or year; any numerology number — check whether FACTS supports it.

DATES: FACTS always writes dates as YYYY-MM-DD. Silently treat any other unambiguous form of the \
SAME calendar date — "29 Dec 2026", "29 December 2026", "Dec 29 2026" — as IDENTICAL to \
"2026-12-29"; do not show this comparison in your output. Flag a date ONLY if its actual day, \
month, or year value is genuinely different from FACTS — never for being formatted differently.

Do NOT flag: warmth, encouragement, practical advice, or astrological INTERPRETATION (e.g. "this \
makes you patient" is opinion, not a fact-check target). Only flag statements that contradict or \
are absent from FACTS.

A house or planet's SIGNIFICATIONS (what it broadly represents — "6th house: illness, debt, \
enemies, daily work, service") are classical astrological convention, not a chart-specific fact. \
The draft is free to paraphrase them with standard synonyms — "competition" for "enemies", \
"growth" for "gains" — that is normal interpretation, not a violation. Only flag a signification \
gloss if it has no reasonable classical connection to what FACTS lists for that house/planet at \
all (inventing a meaning out of nothing), never for wording that a Vedic astrologer would treat \
as equivalent.

The "problems" array must contain ONLY claims you conclude are actually wrong or unsupported. \
Do not include a claim you determine matches FACTS, even to show your work on it — if you find \
yourself writing "this is correct" or "this matches" about something, leave it out of the array \
entirely rather than logging it there.

Reply with EXACTLY ONE JSON object and nothing else — no prose before or after it, and do not \
second-guess or re-check yourself out loud after writing it. Decide first, then output your one \
final answer:
{{"clean": true}}  — if every factual claim is supported
{{"clean": false, "problems": ["<claim>: <what FACTS actually says>", ...]}}  — otherwise, listing \
ONLY the genuine mismatches"""


def verify_second_opinion(draft: str, facts_text: str) -> tuple[bool, list[str]]:
    """Independent adversarial check — different prompt, different framing, same facts.

    Returns (clean, problems). Never raises: a broken/unparseable verifier response is treated
    as a FAIL closed — i.e. clean=False — because a verifier that can't be understood is not a
    verifier that passed. Callers must not ship an answer this returns problems for.

    One retry on a FORMATTING failure only (call error, no JSON found, bad JSON) — the fast
    verify model occasionally doesn't follow "reply with only JSON," which is a communication
    slip, not the verifier having found something wrong. A verdict it DID successfully produce
    (clean=true, or clean=false with real problems) is never retried — that's the guard working.
    """
    prompt = VERIFY_PROMPT.format(facts=facts_text, draft=draft)
    last_problem = "verifier failed"
    for attempt in range(2):
        try:
            raw, _ = generate("You are a precise, literal fact-checker. Reply with JSON only.", prompt, fast=True)
        except Exception as e:
            log.warning("second-opinion call failed (attempt %d): %s", attempt + 1, e)
            last_problem = f"verifier call failed: {e}"
            continue
        # Occasionally the model second-guesses itself mid-response — an initial verdict,
        # then "wait, let me re-examine," then a corrected one. Take the LAST complete JSON
        # object in the response (its final answer), not a single greedy first-{-to-last-}
        # match that would span both objects plus the prose between them into garbage.
        matches = re.findall(r"\{.*?\}", raw, re.S)
        if not matches:
            log.warning("second-opinion returned no JSON (attempt %d): %r", attempt + 1, raw[:200])
            last_problem = "verifier returned no parseable result"
            continue
        try:
            result = json.loads(matches[-1])
        except json.JSONDecodeError:
            log.warning("second-opinion returned bad JSON (attempt %d): %r", attempt + 1, raw[:200])
            last_problem = "verifier returned malformed JSON"
            continue
        if result.get("clean") is True:
            return True, []
        return False, [str(p) for p in result.get("problems", ["verifier flagged the draft"])]
    return False, [last_problem]

