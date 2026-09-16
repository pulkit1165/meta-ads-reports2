"""Fetches the deterministic fact pack and routes a question to the facts that matter.

The fact pack comes from the same Vedic engine that powers the Crystal Finder page
(crystal-finder/api/_factpack.js) — one source of astrological truth for the whole business.
Topic routing here is keyword-based on purpose: the retrieval step stays deterministic too,
so the model never chooses which facts it gets to see.
"""
from __future__ import annotations

import difflib
import logging
import os
import re
import string
import requests

import store

log = logging.getLogger(__name__)

API_BASE = os.environ.get("ASTRO_API_BASE", "https://crystal-finder-seven.vercel.app")

# Keywords per topic, English/Hinglish plus native script for the major Indian languages a
# customer might actually write in (Hindi Devanagari, Gujarati, Marathi, Bengali, Punjabi
# Gurmukhi, Tamil). classify() is deterministic keyword matching by design — the retrieval
# step must stay non-model so the model never chooses its own evidence — so language coverage
# here has to be real vocabulary, not "the model will figure it out."
TOPIC_KEYWORDS = {
    "career":    ["career", "job", "work", "promotion", "boss", "office", "naukri", "interview",
                  "resign", "salary hike", "profession", "appraisal", "transfer",
                  "नौकरी", "करियर", "प्रमोशन", "तरक्की", "बॉस", "ऑफिस", "नोकरी", "કારકિર્દી",
                  "નોકરી", "ਨੌਕਰੀ", "ਕਰੀਅਰ", "ਤਰੱਕੀ", "চাকরি", "ক্যারিয়ার", "প্রমোশন", "પ્રમોશન",
                  "வேலை", "தொழில்", "பதவி உயர்வு"],
    "money":     ["money", "wealth", "finance", "loan", "debt", "savings", "income", "paisa",
                  "salary", "rich", "investment", "property price", "emi",
                  "पैसा", "धन", "कर्ज", "बचत", "आमदनी", "वित्त", "पैसे", "પૈસા", "ધન", "દેવું",
                  "ਪੈਸਾ", "ਧਨ", "ਕਰਜ਼ਾ", "টাকা", "অর্থ", "আর্থিক", "ঋণ", "சேமிப்பு", "பணம்", "கடன்"],
    "marriage":  ["marriage", "married", "shaadi", "wedding", "spouse", "husband", "wife",
                  "divorce", "engagement", "rishta", "match", "kundli milan",
                  "शादी", "विवाह", "लग्न", "पति", "पत्नी", "तलाक", "सगाई", "લગ્ન", "પતિ", "પત્ની",
                  "ਵਿਆਹ", "ਪਤੀ", "ਪਤਨੀ", "ਤਲਾਕ", "বিয়ে", "বিবাহ", "স্বামী", "স্ত্রী",
                  "திருமணம்", "கணவன்", "மனைவி"],
    "love":      ["love", "relationship", "girlfriend", "boyfriend", "partner", "crush",
                  "breakup", "pyar", "romance", "ex ",
                  "प्यार", "प्रेम", "रिश्ता", "ब्रेकअप", "પ્રેમ", "સંબંધ", "ਪਿਆਰ", "ਰਿਸ਼ਤਾ",
                  "ভালোবাসা", "প্রেম", "সম্পর্ক", "காதல்", "உறவு"],
    "health":    ["health", "illness", "disease", "surgery", "pain", "bimari", "fitness",
                  "anxiety", "sleep", "stress", "recovery",
                  "स्वास्थ्य", "बीमारी", "तबियत", "इलाज", "दर्द", "તબિયત", "આરોગ્ય", "बीमारी",
                  "ਸਿਹਤ", "ਬਿਮਾਰੀ", "ਇਲਾਜ", "স্বাস্থ্য", "অসুখ", "চিকিৎসা", "ஆரோக்கியம்", "நோய்"],
    "education": ["study", "exam", "education", "college", "degree", "padhai", "course",
                  "admission", "result", "upsc", "neet", "jee",
                  "पढ़ाई", "परीक्षा", "कॉलेज", "शिक्षा", "અભ્યાસ", "પરીક્ષા", "શિક્ષણ",
                  "ਪੜ੍ਹਾਈ", "ਪ੍ਰੀਖਿਆ", "ਕਾਲਜ", "পড়াশোনা", "পরীক্ষা", "কলেজ", "படிப்பு", "தேர்வு"],
    "children":  ["child", "children", "baby", "pregnancy", "santan", "conceive", "son", "daughter",
                  "संतान", "बच्चा", "गर्भ", "સંતાન", "બાળક", "ਔਲਾਦ", "ਬੱਚਾ", "সন্তান", "বাচ্চা",
                  "குழந்தை", "கர்ப்பம்"],
    "property":  ["property", "house", "home", "flat", "land", "makan", "plot", "vehicle", "car",
                  "घर", "मकान", "ज़मीन", "ઘર", "મકાન", "જમીન", "ਘਰ", "ਜ਼ਮੀਨ", "বাড়ি", "জমি",
                  "வீடு", "நிலம்"],
    "travel":    ["travel", "abroad", "foreign", "visa", "settle", "immigration", "trip", "videsh",
                  "विदेश", "यात्रा", "वीज़ा", "વિદેશ", "પ્રવાસ", "ਵਿਦੇਸ਼", "ਸਫ਼ਰ", "বিদেশ",
                  "ভ্রমণ", "வெளிநாடு", "பயணம்"],
    "business":  ["business", "startup", "partnership", "venture", "shop", "dhandha", "clients",
                  "company", "trade",
                  "व्यापार", "धंधा", "व्यवसाय", "ધંધો", "વ્યાપાર", "ਵਪਾਰ", "ਕਾਰੋਬਾਰ", "ব্যবসা",
                  "வணிகம்", "தொழில்"],
    "family":    ["family", "mother", "father", "parents", "brother", "sister", "ghar", "in-laws",
                  "परिवार", "माता", "पिता", "કુટુંબ", "પરિવાર", "ਪਰਿਵਾਰ", "পরিবার", "মা", "বাবা",
                  "குடும்பம்", "அம்மா", "அப்பா"],
    "spiritual": ["spiritual", "moksha", "meditation", "puja", "temple", "guru", "mantra",
                  "remedy", "remedies", "gemstone", "dosha", "pooja",
                  "पूजा", "मंत्र", "उपाय", "મંત્ર", "ਪੂਜਾ", "ਮੰਤਰ", "পূজা", "মন্ত্র", "பூஜை", "மந்திரம்"],
}


# Hindi/Hinglish function words (how/what/is/my/you/in/from/to/...) — short, extremely
# frequent, and carry no topic signal. Critically, they must be excluded from FUZZY matching:
# "kaisa" (how) is edit-distance-1 from "paisa" (money) and would otherwise nudge nearly every
# Hinglish sentence toward "money" regardless of what it's actually about.
HINGLISH_STOPWORDS = {
    "kaisa", "kaisi", "kaise", "kya", "kyun", "kyu", "hai", "hain", "ho", "hoga", "hogi", "honge",
    "mera", "meri", "mere", "tera", "teri", "tere", "uska", "uski", "aap", "aapka", "aapki", "tum",
    "hum", "main", "mein", "yeh", "woh", "wo", "ye", "se", "ko", "ka", "ki", "ke", "wala", "wali",
    "kab", "kaha", "kahan", "kitna", "kitni", "abhi", "sab", "koi", "bhi", "toh", "to", "aur", "ya",
}


# Romanized Hindi/Hinglish words worth typo-tolerance — pulled from TOPIC_KEYWORDS above.
# Deliberately excludes plain English and native-script entries (see classify() for why).
FUZZY_HINGLISH = {
    "career":    ["naukri", "karobar"],
    "money":     ["paisa", "paise"],
    "marriage":  ["shaadi", "rishta"],
    "love":      ["pyar", "pyaar"],
    "health":    ["bimari", "tabiyat"],
    "education": ["padhai"],
    "children":  ["santan"],
    "property":  ["makan", "zameen"],
    "travel":    ["videsh", "pardes"],
    "business":  ["dhandha", "vyapar"],
    "family":    ["parivar"],
    "spiritual": ["moksha", "mantra", "pooja"],
}


def classify(question: str) -> str:
    r"""Pick the topic whose keywords the question hits most. Deterministic, no model involved.

    Tokenizes on whitespace, not `\w`-style regex — Python's `\w` excludes Unicode combining
    marks (Mn/Mc), which are exactly the matras and viramas that hold Indic-script words
    together (e.g. Gujarati "પ્રમોશન" contains a virama and a matra; `\w+` shreds it into
    fragments and every keyword match silently fails). Indic scripts space-delimit words the
    same as English, so plain whitespace splitting is both correct and simple.
    """
    q = (question or "").lower()
    tokens = [t.strip(string.punctuation + "?！？।॥،؟") for t in q.split()]
    tokens = [t for t in tokens if t]
    fuzzy_tokens = [t for t in tokens if t not in HINGLISH_STOPWORDS]  # exact matching still sees all tokens
    best, best_hits = "general", 0
    for topic, words in TOPIC_KEYWORDS.items():
        hits = 0
        for w in words:
            if " " in w:                                    # multi-word phrase ("salary hike") — substring is fine
                hits += w in q
            else:                                            # single word — must match a whole token or its prefix,
                hits += any(t == w or t.startswith(w) for t in tokens)  # never a substring across word boundaries
        # Romanized Hindi/Hinglish has no fixed spelling ("shaadi"/"shadi"/"shadhi" are all the
        # same word) — customers WILL type variants, plus outright typos. Fuzzy-match only
        # against the curated Hinglish list, not plain English: English spelling is standardized
        # enough that typo tolerance there does more harm than good (e.g. a 0.8+ similarity
        # threshold loose enough to catch "shqdi"~"shaadi" also matches "wealth"~"health").
        for w in FUZZY_HINGLISH.get(topic, ()):
            if any(len(t) >= 4 and difflib.SequenceMatcher(None, t, w).ratio() >= 0.72 for t in fuzzy_tokens):
                hits += 1
        if hits > best_hits:
            best, best_hits = topic, hits
    return best


class StateOnlyError(RuntimeError):
    """Customer typed a state/region name with no city in it ("Uttar Pradesh", "up") — there's
    no bigger place to fall back to, so this needs a different message than the generic
    geocoding failure ("send a bigger nearby city" is actively confusing here)."""


def fetch(user: dict, topic: str | None = None, force: bool = False,
          question: str | None = None) -> dict:
    """Return the fact pack for a user, from cache when fresh (transits move, so TTL is short)."""
    phone = user["phone"]
    if not force:
        cached = store.get_factpack(phone)
        if cached:
            if topic:
                cached["topicFacts"] = _filter_topic(cached, topic, question)
            return cached

    params = {"dob": user["dob"], "place": user["place"] or "", "name": user.get("name") or ""}
    if user.get("birth_time"):
        params["time"] = user["birth_time"]
    if user.get("gender"):
        params["gender"] = user["gender"]
    r = requests.get(f"{API_BASE}/api/factpack", params=params, timeout=30)
    if r.status_code == 422:
        try:
            if r.json().get("stateOnly"):
                raise StateOnlyError(params["place"])
        except ValueError:
            pass
    if not r.ok:
        raise RuntimeError(f"factpack API {r.status_code}: {r.text[:200]}")
    pack = r.json()
    store.put_factpack(phone, pack)
    if topic:
        pack["topicFacts"] = _filter_topic(pack, topic, question)
    return pack


# Mirrors TOPIC_MAP in crystal-finder/api/_factpack.js — which houses/planets a question depends on.
TOPIC_MAP = {
    "career":    {"houses": [10, 6, 2, 11], "planets": ["Saturn", "Sun", "Mercury"]},
    "money":     {"houses": [2, 11, 5, 9],  "planets": ["Jupiter", "Venus", "Mercury"]},
    "marriage":  {"houses": [7, 2, 4, 8],   "planets": ["Venus", "Jupiter", "Mars"]},
    "love":      {"houses": [5, 7, 11],     "planets": ["Venus", "Moon", "Mars"]},
    "health":    {"houses": [1, 6, 8],      "planets": ["Sun", "Moon", "Saturn"]},
    "education": {"houses": [4, 5, 9],      "planets": ["Mercury", "Jupiter"]},
    "children":  {"houses": [5, 9],         "planets": ["Jupiter"]},
    "property":  {"houses": [4, 2, 11],     "planets": ["Mars", "Venus", "Saturn"]},
    "travel":    {"houses": [12, 9, 3],     "planets": ["Rahu", "Moon"]},
    "business":  {"houses": [7, 10, 11, 3], "planets": ["Mercury", "Rahu", "Saturn"]},
    "family":    {"houses": [2, 4, 3, 9],   "planets": ["Moon", "Jupiter"]},
    "spiritual": {"houses": [12, 9, 5, 8],  "planets": ["Ketu", "Jupiter"]},
    "general":   {"houses": [1, 10, 7, 2],  "planets": ["Moon", "Saturn", "Jupiter"]},
}


# ── entity routing ───────────────────────────────────────────────────────
# TOPIC_MAP alone decides which facts a question sees, and it is keyed on life-topics only.
# A question that names an astrological ENTITY ("Mera Rahu 1st house mein hai") matches no
# topic keyword, falls through to "general", and general's planet list does not contain Rahu
# — so the model was handed no Rahu fact and correctly refused to answer, while the pack held
# the answer all along. That refusal is worse than useless: the customer sees the bot deny
# data it has. Entity hits are therefore ADDED on top of the topic's facts, never substituted,
# so retrieval stays deterministic and can only ever widen, never narrow.
PLANET_ALIASES = {
    "Sun":     ["sun", "surya", "soorya", "ravi", "सूर्य", "सुर्य", "रवि", "સૂર્ય", "ਸੂਰਜ", "সূর্য", "சூரியன்"],
    "Moon":    ["moon", "chandra", "chandrama", "chand", "चंद्र", "चन्द्र", "चाँद", "ચંદ્ર", "ਚੰਦਰਮਾ", "চন্দ্র", "சந்திரன்"],
    "Mars":    ["mars", "mangal", "mangala", "kuja", "मंगल", "मङ्गल", "મંગળ", "ਮੰਗਲ", "মঙ্গল", "செவ்வாய்"],
    "Mercury": ["mercury", "budh", "budha", "बुध", "બુધ", "ਬੁੱਧ", "বুধ", "புதன்"],
    "Jupiter": ["jupiter", "guru", "brihaspati", "brihaspathi", "गुरु", "बृहस्पति", "ગુરુ", "ਗੁਰੂ", "বৃহস্পতি", "குரு"],
    "Venus":   ["venus", "shukra", "shukr", "शुक्र", "શુક્ર", "ਸ਼ੁਕਰ", "শুক্র", "சுக்கிரன்"],
    "Saturn":  ["saturn", "shani", "shanidev", "sade sati", "sadesati", "शनि", "शनी", "શનિ", "ਸ਼ਨੀ", "শনি", "சனி"],
    "Rahu":    ["rahu", "राहु", "રાહુ", "ਰਾਹੂ", "রাহু", "ராகு"],
    "Ketu":    ["ketu", "केतु", "કેતુ", "ਕੇਤੂ", "কেতু", "கேது"],
}
SIGN_ALIASES = {
    "Aries": ["aries", "mesh", "मेष"], "Taurus": ["taurus", "vrishabh", "vrish", "वृषभ"],
    "Gemini": ["gemini", "mithun", "मिथुन"], "Cancer": ["cancer", "kark", "karka", "कर्क"],
    "Leo": ["leo", "simha", "sinh", "सिंह"], "Virgo": ["virgo", "kanya", "कन्या"],
    "Libra": ["libra", "tula", "तुला"], "Scorpio": ["scorpio", "vrishchik", "वृश्चिक"],
    "Sagittarius": ["sagittarius", "dhanu", "धनु"], "Capricorn": ["capricorn", "makar", "मकर"],
    "Aquarius": ["aquarius", "kumbh", "कुंभ", "कुम्भ"], "Pisces": ["pisces", "meen", "मीन"],
}
NAKSHATRAS = ["Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra", "Punarvasu",
              "Pushya", "Ashlesha", "Magha", "Purva Phalguni", "Uttara Phalguni", "Hasta",
              "Chitra", "Swati", "Vishakha", "Anuradha", "Jyeshtha", "Mula", "Purva Ashadha",
              "Uttara Ashadha", "Shravana", "Dhanishta", "Shatabhisha", "Purva Bhadrapada",
              "Uttara Bhadrapada", "Revati"]
_ORDINALS = {
    "first": 1, "pehla": 1, "pehle": 1, "second": 2, "dusra": 2, "doosra": 2, "third": 3,
    "teesra": 3, "tisra": 3, "fourth": 4, "chautha": 4, "fifth": 5, "panchva": 5, "sixth": 6,
    "chhata": 6, "chhta": 6, "seventh": 7, "satva": 7, "saatva": 7, "eighth": 8, "aathva": 8,
    "ninth": 9, "navva": 9, "tenth": 10, "dasva": 10, "dashva": 10, "eleventh": 11,
    "gyarahva": 11, "twelfth": 12, "barahva": 12,
}
_HOUSE_WORD = r"(?:house|houses|bhav|bhaav|bhava|ghar|भाव|घर|ਘਰ|ઘર)"
_HOUSE_PATTERNS = [
    re.compile(r"\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*" + _HOUSE_WORD, re.I),
    re.compile(_HOUSE_WORD + r"\s*(?:no\.?|number|#)?\s*(\d{1,2})\b", re.I),
    re.compile(r"(\d{1,2})\s*(?:वें|वाँ|वा|व)?\s*(?:भाव|घर)"),
]


def entities(question: str) -> dict:
    """Astrological entities named outright in the question. Deterministic, no model."""
    q = (question or "").lower()
    tokens = {t.strip(string.punctuation + "?！？।॥،؟") for t in q.split()}
    tokens.discard("")

    def _hit(alias: str) -> bool:
        a = alias.lower()
        if " " in a or not a.isascii():
            return a in q                       # phrases and Indic scripts: substring
        return any(t == a or t.startswith(a) for t in tokens)   # latin: whole token/prefix

    planets = {p for p, al in PLANET_ALIASES.items() if any(_hit(a) for a in al)}
    signs = {sg for sg, al in SIGN_ALIASES.items() if any(_hit(a) for a in al)}
    naks = {n for n in NAKSHATRAS if n.lower() in q}
    houses = set()
    for pat in _HOUSE_PATTERNS:
        for m in pat.finditer(q):
            try:
                n = int(m.group(1))
            except (TypeError, ValueError):
                continue
            if 1 <= n <= 12:
                houses.add(n)
    if re.search(_HOUSE_WORD, q, re.I):
        for word, n in _ORDINALS.items():
            if word in tokens:
                houses.add(n)
    return {"planets": planets, "signs": signs, "nakshatras": naks, "houses": houses}


def _filter_topic(pack: dict, topic: str, question: str | None = None) -> list[dict]:
    m = TOPIC_MAP.get(topic, TOPIC_MAP["general"])
    always = {"birth", "dasha", "transit", "numerology"}
    ents = entities(question) if question else {"planets": set(), "signs": set(),
                                                "nakshatras": set(), "houses": set()}
    out = []
    for f in pack.get("facts", []):
        t, txt = f["topic"], f["text"]
        if t in always:
            out.append(f)
            continue
        keep = False
        if t == "chart":
            keep = (any(txt.startswith(p + " ") for p in m["planets"])
                    or txt.startswith(("Moon ", "Sun ", "Ascendant "))
                    # named outright, or the fact places a planet in a sign/nakshatra the
                    # customer asked about
                    or any(txt.startswith(p + " ") for p in ents["planets"])
                    or any(sg in txt for sg in ents["signs"])
                    or any(nk in txt for nk in ents["nakshatras"]))
        elif t == "houses":
            keep = (any(txt.startswith(f"House {h} ") for h in m["houses"])
                    or any(txt.startswith(f"House {h} ") for h in ents["houses"])
                    # "which house is my Rahu in" also wants the house Rahu sits in
                    or any(p in txt for p in ents["planets"])
                    or any(sg in txt for sg in ents["signs"]))
        if keep:
            out.append(f)
    return out
