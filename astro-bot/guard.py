"""Anti-hallucination guard.

The model is only ever allowed to *rephrase* the deterministic fact-pack. This module
checks the reverse direction: every checkable astrological or numerological claim in a
generated answer is matched back against the fact pack, and anything that doesn't match
is a violation. Violations are fed back for one repair attempt; if the repair still fails,
flow.py ships a deterministic template answer instead of the model's text.

What is checked (each of these is a fabricated-fact vector):
  - planet-in-sign claims, natal and transit
  - planet-in-house claims
  - nakshatra names attributed to the person
  - dasha lord claims (maha / antar / pratyantar)
  - every 4-digit year mentioned
  - numerology numbers (mulank / bhagyank / personal year / name number)
  - degrees

Interpretation ("Saturn in the 10th makes career slow to build") is NOT checkable and is
not checked — that is the model's job. The facts underneath it are.
"""
from __future__ import annotations

import re

SIGNS = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio",
         "Sagittarius", "Capricorn", "Aquarius", "Pisces"]
PLANETS = ["Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn", "Rahu", "Ketu"]
# Hindi/Sanskrit names the model may use; mapped back to the canonical English key.
PLANET_ALIASES = {
    "surya": "Sun", "ravi": "Sun", "chandra": "Moon", "mangal": "Mars", "kuja": "Mars",
    "budh": "Mercury", "budha": "Mercury", "guru": "Jupiter", "brihaspati": "Jupiter",
    "shukra": "Venus", "shani": "Saturn", "rahu": "Rahu", "ketu": "Ketu",
}
NAKSHATRAS = ["Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra", "Punarvasu",
              "Pushya", "Ashlesha", "Magha", "Purva Phalguni", "Uttara Phalguni", "Hasta",
              "Chitra", "Swati", "Vishakha", "Anuradha", "Jyeshtha", "Mula", "Purva Ashadha",
              "Uttara Ashadha", "Shravana", "Dhanishta", "Shatabhisha", "Purva Bhadrapada",
              "Uttara Bhadrapada", "Revati"]

_P = "|".join(PLANETS + [a.capitalize() for a in PLANET_ALIASES])
_S = "|".join(SIGNS)
_N = "|".join(sorted(NAKSHATRAS, key=len, reverse=True))   # longest-first: "Purva Ashadha" before "Purva"


def _canon_planet(word: str) -> str:
    w = word.strip()
    return PLANET_ALIASES.get(w.lower(), w.capitalize() if w.lower() in
                              {p.lower() for p in PLANETS} else w)


def _allowed_signs(pack: dict, planet: str) -> set[str]:
    """A planet may legitimately be described in its natal sign or its current transit sign."""
    out = set()
    p = (pack.get("planets") or {}).get(planet)
    if p:
        out.add(p["sign"])
    t = (pack.get("transits") or {}).get(planet)
    if t:
        out.add(t["sign"])
    return out


def _allowed_houses(pack: dict, planet: str) -> set[int]:
    out = set()
    p = (pack.get("planets") or {}).get(planet)
    if p:
        out.add(int(p["house"]))
    t = (pack.get("transits") or {}).get(planet)
    if t:
        out.add(int(t["houseFromMoon"]))
        out.add(int(t["houseFromLagna"]))
    return out


def _pack_years(pack: dict) -> set[str]:
    """Every year the fact pack legitimately contains — dasha dates, sade sati, personal year."""
    years = set()
    for f in pack.get("facts", []):
        years.update(re.findall(r"\b(19\d{2}|20\d{2})\b", f["text"]))
    d = pack.get("dasha") or {}
    for blob in (d.get("current"), d.get("pratyantar")):
        if blob:
            years.update(re.findall(r"\b(19\d{2}|20\d{2})\b", str(blob)))
    for u in (d.get("upcomingAntar") or []) + (d.get("mahaTimeline") or []):
        years.update(re.findall(r"\b(19\d{2}|20\d{2})\b", str(u)))
    ss = pack.get("sadeSati") or {}
    years.update(re.findall(r"\b(19\d{2}|20\d{2})\b", str(ss)))
    years.update(re.findall(r"\b(19\d{2}|20\d{2})\b", str(pack.get("birth", {}).get("dob", ""))))
    years.add(str(pack.get("numerology", {}).get("personalYearOf", "")))
    years.add(str(pack.get("meta", {}).get("generatedAt", ""))[:4])
    return {y for y in years if y}


def _person_nakshatras(pack: dict) -> set[str]:
    out = set()
    for p in (pack.get("planets") or {}).values():
        if p.get("nakshatra"):
            out.add(p["nakshatra"])
    lag = pack.get("lagna") or {}
    if lag.get("nakshatra"):
        out.add(lag["nakshatra"])
    for f in pack.get("facts", []):
        for n in NAKSHATRAS:
            if n in f["text"]:
                out.add(n)
    return out



def _sentence_around(text: str, idx: int) -> str:
    """The sentence containing position `idx` — tense checks need clause-level context."""
    start = max(text.rfind(".", 0, idx), text.rfind("\n", 0, idx), text.rfind("!", 0, idx)) + 1
    end = min([x for x in (text.find(".", idx), text.find("\n", idx), len(text)) if x != -1] or [len(text)])
    return text[start:end]


def verify(answer: str, pack: dict) -> list[str]:
    """Return a list of violation strings. Empty list == every checkable claim matched."""
    v: list[str] = []
    text = answer or ""

    # 1. Planet in sign — natal ("Saturn is in Pisces") and transit ("Saturn is transiting Pisces")
    for m in re.finditer(rf"\b({_P})\b[^.\n]{{0,60}}?\b(?:in|transiting|transits|through|occupies|placed in|sits in)\s+(?:the\s+)?({_S})\b",
                         text, re.I):
        planet, sign = _canon_planet(m.group(1)), m.group(2).capitalize()
        allowed = _allowed_signs(pack, planet)
        if allowed and sign not in allowed:
            v.append(f"{planet} is not in {sign} — the chart has {planet} in {'/'.join(sorted(allowed))}.")

    # 2. Planet in house — "Saturn in the 6th house", "Saturn sits in house 6"
    for m in re.finditer(rf"\b({_P})\b[^.\n]{{0,60}}?\b(?:in|occupies|sits in|placed in)\s+(?:the\s+)?(?:house\s+)?(\d{{1,2}})(?:st|nd|rd|th)?\s*(?:house)?",
                         text, re.I):
        planet, house = _canon_planet(m.group(1)), int(m.group(2))
        if not (1 <= house <= 12):
            continue
        allowed = _allowed_houses(pack, planet)
        if allowed and house not in allowed:
            v.append(f"{planet} is not in house {house} — the chart has it in house "
                     f"{'/'.join(str(h) for h in sorted(allowed))}.")

    # 3. Nakshatra attributed to the person
    person_naks = _person_nakshatras(pack)
    for m in re.finditer(rf"\b({_N})\b", text):
        nak = m.group(1)
        if person_naks and nak not in person_naks:
            v.append(f"{nak} nakshatra does not appear in this chart.")

    # 3b. "your nakshatra" / "born under X" means the Moon's nakshatra specifically.
    moon_nak = ((pack.get("planets") or {}).get("Moon") or {}).get("nakshatra")
    if moon_nak:
        for m in re.finditer(rf"(?:born (?:in|under)|your|birth)\s+(?:the\s+)?({_N})\b\s*(?:nakshatra|star)?",
                             text, re.I):
            if m.group(1) != moon_nak:
                v.append(f"The birth nakshatra is {moon_nak}, not {m.group(1)}.")
        for m in re.finditer(rf"(?:nakshatra|birth star)\s+(?:is\s+)?({_N})\b", text, re.I):
            if m.group(1) != moon_nak:
                v.append(f"The birth nakshatra is {moon_nak}, not {m.group(1)}.")

    # 4. Dasha lords
    d = (pack.get("dasha") or {}).get("current") or {}
    praty = (pack.get("dasha") or {}).get("pratyantar") or {}
    upcoming = {u["lord"] for u in ((pack.get("dasha") or {}).get("upcomingAntar") or [])}
    maha_lord = (d.get("maha") or {}).get("lord")
    antar_lord = (d.get("antar") or {}).get("lord")
    # Every lord appears somewhere in a 120-year Vimshottari cycle, so membership proves nothing.
    # What matters is whether the answer claims the period is running NOW.
    RUNNING = re.compile(r"\b(currently|right now|at present|presently|you are (?:in|running|under)|"
                         r"is running|now running|these days|at the moment)\b", re.I)
    for m in re.finditer(rf"\b({_P})\b(?:'s|’s)?\s*(mahadasha|maha dasha|major period)", text, re.I):
        lord = _canon_planet(m.group(1))
        sentence = _sentence_around(text, m.start())
        present = bool(RUNNING.search(sentence)) or sentence.strip().lower().startswith(("you are", "your current"))
        if maha_lord and present and lord != maha_lord:
            v.append(f"{lord} mahadasha is not running — the running mahadasha is {maha_lord}.")
    for m in re.finditer(rf"\b({_P})\b(?:'s|’s)?\s*(antardasha|antar dasha|sub-period|sub period)", text, re.I):
        lord = _canon_planet(m.group(1))
        sentence = _sentence_around(text, m.start())
        present = bool(RUNNING.search(sentence))
        if antar_lord and present and lord != antar_lord:
            v.append(f"{lord} antardasha is not running — the running antardasha is {antar_lord}.")
        elif antar_lord and lord != antar_lord and lord not in upcoming:
            v.append(f"{lord} antardasha is neither running nor in the upcoming list "
                     f"(running: {antar_lord}).")
    for m in re.finditer(rf"\b({_P})\b(?:'s|’s)?\s*(pratyantar\w*)", text, re.I):
        lord = _canon_planet(m.group(1))
        if praty.get("lord") and lord != praty["lord"]:
            v.append(f"{lord} pratyantardasha is not running (currently: {praty['lord']}).")

    # 5. Years — every year stated must come from the pack
    allowed_years = _pack_years(pack)
    for y in set(re.findall(r"\b(19\d{2}|20\d{2})\b", text)):
        if y not in allowed_years:
            v.append(f"The year {y} is not derived from this chart's dasha or transit dates.")

    # 6. Numerology numbers
    num = pack.get("numerology") or {}
    checks = [
        (r"(?:mulank|birth number|driver number)\D{0,25}?(\d{1,2})", {num.get("mulank")}, "Mulank"),
        (r"(?:bhagyank|destiny number|life[- ]?path)\D{0,25}?(\d{1,2})",
         {num.get("bhagyank"), num.get("bhagyankMaster")}, "Bhagyank"),
        (r"(?:personal year)\D{0,25}?(\d{1,2})", {num.get("personalYear")}, "Personal year"),
        (r"(?:name number)\D{0,25}?(\d{1,2})",
         {(num.get("nameChaldean") or {}).get("reduced"),
          (num.get("namePythagorean") or {}).get("reduced")}, "Name number"),
    ]
    for pattern, allowed, label in checks:
        allowed = {a for a in allowed if a is not None}
        for m in re.finditer(pattern, text, re.I):
            got = int(m.group(1))
            if allowed and got not in allowed:
                v.append(f"{label} is not {got} — it is {'/'.join(str(a) for a in sorted(allowed))}.")

    # 7. Degrees attributed to a planet
    for m in re.finditer(rf"\b({_P})\b[^.\n]{{0,40}}?(\d{{1,2}}(?:\.\d)?)\s*(?:°|deg\b|degrees\b)", text, re.I):
        planet, deg = _canon_planet(m.group(1)), float(m.group(2))
        p = (pack.get("planets") or {}).get(planet)
        t = (pack.get("transits") or {}).get(planet)
        allowed = {round(x["degreeInSign"]) for x in (p, t) if x}
        if allowed and round(deg) not in allowed:
            v.append(f"{planet} is not at {deg}° — chart value is "
                     f"{'/'.join(str(a) for a in sorted(allowed))}°.")

    # 8. Birth-time honesty: without a birth time nothing may be asserted about the ascendant.
    if not (pack.get("meta") or {}).get("birthTimeKnown"):
        if re.search(r"\b(ascendant|lagna|rising sign)\b", text, re.I) and \
           not re.search(r"\b(without|unknown|not (?:provided|known)|need|cannot|can't)\b", text, re.I):
            v.append("Birth time is unknown, so the ascendant/lagna cannot be stated as fact.")
    # 9. House-lord claims — "your 10th house is ruled by X" / "X rules your 2nd house".
    # This is the construction real answers lean on most for career/money/marriage questions.
    for m in re.finditer(rf"(\d{{1,2}})(?:st|nd|rd|th)\s+house\s+is\s+ruled\s+by\s+({_P})\b", text, re.I):
        house, lord = int(m.group(1)), _canon_planet(m.group(2))
        hh = next((h for h in pack.get("houses", []) if h["house"] == house), None)
        if hh and lord != hh["lord"]:
            v.append(f"House {house} is ruled by {hh['lord']}, not {lord}.")
    for m in re.finditer(rf"\b({_P})\b\s+rules\s+your\s+(\d{{1,2}})(?:st|nd|rd|th)\s+house", text, re.I):
        lord, house = _canon_planet(m.group(1)), int(m.group(2))
        hh = next((h for h in pack.get("houses", []) if h["house"] == house), None)
        if hh and lord != hh["lord"]:
            v.append(f"House {house} is ruled by {hh['lord']}, not {lord}.")

    # 10. Dispositor claims — "its dispositor is X" / "Saturn's dispositor is X".
    for m in re.finditer(rf"\b({_P})\b(?:'s|’s)?\s+dispositor\s+is\s+({_P})\b", text, re.I):
        planet, claimed = _canon_planet(m.group(1)), _canon_planet(m.group(2))
        p_ = (pack.get("planets") or {}).get(planet)
        if p_ and claimed != p_["dispositor"]:
            v.append(f"{planet}'s dispositor is {p_['dispositor']}, not {claimed}.")

    # 11. Dignity claims — exalted / debilitated / own sign.
    DIGNITY_WORDS = {"exalted": "exalted", "debilitated": "debilitated",
                     "own sign": "own sign", "in its own sign": "own sign"}
    for m in re.finditer(rf"\b({_P})\b[^.\n]{{0,40}}?\b(exalted|debilitated|own sign|in its own sign)\b",
                         text, re.I):
        planet, claimed = _canon_planet(m.group(1)), DIGNITY_WORDS[m.group(2).lower()]
        p_ = (pack.get("planets") or {}).get(planet)
        if p_ and p_["dignity"] != claimed:
            v.append(f"{planet} is not {claimed} — its dignity in this chart is {p_['dignity']}.")

    # 12. Retrograde claims.
    for m in re.finditer(rf"\b({_P})\b[^.\n]{{0,30}}?\bretrograde\b", text, re.I):
        planet = _canon_planet(m.group(1))
        p_ = (pack.get("planets") or {}).get(planet)
        t_ = (pack.get("transits") or {}).get(planet)
        # natal retrograde and current transit retrograde are different facts; either satisfies "retrograde"
        known = [x["retrograde"] for x in (p_, t_) if x is not None]
        if known and not any(known):
            v.append(f"{planet} is not shown as retrograde in this chart.")

    # 13. Sade Sati / Dhaiya active-state claims — a boolean the model must not invent.
    ss = pack.get("sadeSati") or {}
    if re.search(r"\bsade\s*sati\s+is\s+(active|running|on)\b", text, re.I) and not ss.get("active"):
        v.append("Sade Sati is not active in this chart right now.")
    if re.search(r"\bsade\s*sati\s+is\s+not\s+(active|running)\b", text, re.I) and ss.get("active"):
        v.append("Sade Sati IS active in this chart right now.")
    dh = pack.get("dhaiya") or {}
    if re.search(r"\b(dhaiya|panoti|ashtama\s*shani)\s+is\s+(active|running|on)\b", text, re.I) \
       and not dh.get("active"):
        v.append("Neither Dhaiya nor Ashtama Shani is active in this chart right now.")

    return v


def dedupe(violations: list[str]) -> list[str]:
    seen, out = set(), []
    for x in violations:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out
