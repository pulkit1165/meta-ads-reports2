"""Conversation state machine for the WhatsApp astro bot.

    new → await_name → await_dob → await_time → await_place → ready
                                                                 ↓
                                        free kundli + numerology reading (deterministic)
                                                                 ↓
                                        paid Q&A, one question per quota unit

The free reading is rendered from the fact pack by template — no model involved, so the
first thing a customer ever sees is incapable of being wrong. Paid answers go through
the model and must clear guard.py before they are sent or billed.
"""
from __future__ import annotations

import logging
import os
import re
import time
from datetime import datetime

import factpack
import guard
import llm
import store
import shopify_verify

log = logging.getLogger(__name__)

PACK_SKUS = {          # handle → questions granted
    "3-questions-for-399": 3,
    "6-questions-for-299": 6,   # SKU NTN1130
    "10-questions-for-999": 10,
    "15-questions-for-1399": 15,
    "20-questions-for-1699": 20,
    "ai-astro-bot": 5,
}
SHOP_URL = "https://studdmuffyn.com/products/10-questions-for-999"

# Emergency/testing switch: ASTRO_PAYWALL=off removes the quota requirement for EVERY customer
# who messages the bot. Off is the exception, never the default — the env var must be set
# explicitly, and it prints a warning on import so it's impossible to miss in the logs.
PAYWALL_OFF = os.environ.get("ASTRO_PAYWALL", "on").strip().lower() in ("off", "false", "0")
if PAYWALL_OFF:
    log.warning("⚠️  ASTRO_PAYWALL=off — quota is NOT enforced. Every customer gets free questions "
               "until this is unset. Set ASTRO_PAYWALL=on (or remove the var) to restore billing.")


def _testing_top_up(phone: str) -> None:
    """While ASTRO_PAYWALL=off, keep everyone's balance topped up so nobody is ever blocked.
    Real purchases (via `order <number>`) still work normally and stack on top of this."""
    if PAYWALL_OFF and store.remaining(phone) < 5:
        store.grant(phone, 50, f"#FREE-TEST-{int(time.time())}", "free-test", source="free-test")

LANG_PROMPT = (
    "🙏 Welcome to {brand}!\n\n"
    "Which language would you like to continue in?\n"
    "Reply 1 for English, 2 for Hindi.\n\n"
    "Hindi mein baat karne ke liye 2 bhejein, English ke liye 1."
)
LANG_PROMPT_RETRY = "Please reply 1 for English or 2 for Hindi.\nEnglish ke liye 1, Hindi ke liye 2 bhejein."

# Every deterministic (non-model) message a customer can see, in both languages. The customer
# picks a language once at first contact (see the "new"/"await_language" states below) and it
# sticks for every template message after that — the model's own answers separately MIRROR
# whatever language the customer actually types in a given message (see llm.SYSTEM_PROMPT);
# this table is only for the scaffolding around those answers.
STRINGS = {
    "en": {
        "greeting": ("🙏 Namaste, welcome to {brand}.\n\n"
                     "Tell me your birth details and I will build your complete kundli and "
                     "numerology reading for you right now — free, from your own chart, not a "
                     "generic horoscope.\n\nWhat should I call you?"),
        "name_retry": "🙏 And your name? Just the name you go by — for example: Ravi Kumar",
        "name_reject_date": ("That looks like a date, not a name — what should I call you? "
                             "I'll ask for your date of birth right after this. 🙂"),
        "name_reject_length": "Please send just your name, as you use it day to day.",
        "name_reject_sentence": ("That reads like a question, not a name — what should I call you? "
                                 "Just your name for now; ask me anything once your kundli is ready. 🙂"),
        "ask_dob": "Lovely to meet you, {name}. 🌙\n\nWhat is your date of birth?\nSend it like 15/08/1995 or 15 Aug 1995.",
        "dob_invalid": "I could not read that date. Please send it as 15/08/1995 or 15 Aug 1995.",
        "ask_time": ("Got it. Now your time of birth, as exactly as you know it — like 10:30 am "
                    "or 22:15.\n\nIf you truly don't know it, reply: dont know\n"
                    "(Without it I can still read your Moon chart and numerology, but not your "
                    "ascendant or houses.)"),
        "time_invalid": ("I could not read that time. Send it like 10:30 am, or 22:15.\n"
                         "If you don't know it, reply: dont know"),
        "ask_place": "Almost there — which city were you born in? (For example: Ludhiana, or Delhi)",
        "place_length": "Please send just the city name — for example: Ludhiana",
        "place_state_only": ("'{place}' is a state, not a city — I need the specific city you "
                             "were born in (for example, the city within that state, not the "
                             "state itself)."),
        "place_not_found": ("I could not find '{place}'. Please send a bigger nearby city "
                            "— for example: Ludhiana, Delhi, Mumbai."),
        "help": ("Here is what you can send me:\n\n"
                "• Any life question — career, marriage, money, health, business\n"
                "• balance — how many questions you have left\n"
                "• reading — your kundli and numerology summary again\n"
                "• order <number> — unlock a question pack you bought\n"
                "• restart — re-enter your birth details\n"
                "• help — this message"),
        "balance_left": "You have {n} question{s} left. 🌙",
        "balance_none": "You have no questions left.\n\nGet a new pack here:\n{shop_url}",
        "order_usage": "Send it like: order 1234  (your Shopify order number from the confirmation email)",
        "order_check_failed": "I could not check that order right now. Please try again in a few minutes. 🙏",
        "order_not_found": ("I could not find a question pack on order #{order_no} for this number. "
                            "Check the order number, or reply with the phone number used at checkout."),
        "order_already_unlocked": "Order #{order_no} is already unlocked. You have {remaining} questions left.",
        "order_greeting": "Hi {name}! ",
        "order_unlocked": "{greeting}✅ Unlocked {total} questions from order #{order_no}. You now have {remaining}.{nudge}",
        "order_nudge": "\n\nFirst, tell me your name so I can build your kundli.",
        "ask_full_question": "Ask me a full question — for example: will I get a promotion this year?",
        "no_quota_first": ("To ask a question I need you to have a question pack. 🌙\n\nGet one here:"
                           "\n{shop_url}\n\nAfter paying, send: order <your order number>"),
        "no_quota_repeat": ("You have used all your questions. 🌙\n\nGet another pack here:"
                            "\n{shop_url}\n\nAfter paying, send: order <your order number>"),
        "answer_could_not": ("I could not answer that one, and I have not counted it against your "
                             "pack. Please rephrase it, or ask about career, marriage, money or health. 🙏"),
        "answer_error": ("Something went wrong reading your chart just now — your question has NOT "
                         "been counted. Please send it again in a minute. 🙏"),
        "reading_tail_ready": "\n\nYou have {n} question{s} ready to ask. Go ahead. 🙏",
        "reading_tail_no_quota": ("\n\nTo ask your questions, get a pack here:\n{shop_url}\n"
                                  "Then send: order <your order number>"),
        "pending_answered": "\n\nYou also asked earlier: \"{pending}\" — here you go:\n\n{answered}",
        "pending_no_quota": ("\n\nYou also asked earlier: \"{pending}\" — once you have a question "
                             "pack I'll answer that for you.\n\nGet one here:\n{shop_url}\n"
                             "Then send: order <your order number>"),
        "answer_trailer_left": "\n\n— {left} question{s} left",
        "answer_trailer_last": "\n\n— that was your last question. New pack: {shop_url}",
    },
    "hi": {
        "greeting": ("🙏 नमस्ते, {brand} में आपका स्वागत है।\n\n"
                     "अपनी जन्म जानकारी बताइए और मैं अभी आपकी पूरी कुंडली और अंक ज्योतिष रीडिंग "
                     "तैयार करूँगा — बिल्कुल मुफ्त, आपकी अपनी कुंडली से, कोई सामान्य राशिफल नहीं।\n\n"
                     "मैं आपको किस नाम से बुलाऊँ?"),
        "name_retry": "🙏 और आपका नाम? बस वो नाम जिससे आप जाने जाते हैं — जैसे: रवि कुमार",
        "name_reject_date": ("यह तो जन्मतिथि जैसा लग रहा है, नाम नहीं — मैं आपको क्या कहकर बुलाऊँ? "
                             "जन्मतिथि मैं इसके ठीक बाद पूछूँगा। 🙂"),
        "name_reject_length": "कृपया सिर्फ अपना नाम भेजें, जैसे आप रोज़मर्रा में इस्तेमाल करते हैं।",
        "name_reject_sentence": ("यह तो एक सवाल जैसा लग रहा है, नाम नहीं — मैं आपको क्या कहकर बुलाऊँ? "
                                 "अभी सिर्फ अपना नाम भेजें; कुंडली तैयार होते ही मुझसे कुछ भी पूछ सकते हैं। 🙂"),
        "ask_dob": "आपसे मिलकर अच्छा लगा, {name}। 🌙\n\nआपकी जन्मतिथि क्या है?\nऐसे भेजें: 15/08/1995 या 15 Aug 1995",
        "dob_invalid": "मैं वो तारीख समझ नहीं पाया। कृपया इस तरह भेजें: 15/08/1995 या 15 Aug 1995",
        "ask_time": ("ठीक है। अब अपना जन्म समय बताइए, जितना सटीक पता हो — जैसे 10:30 am या 22:15।\n\n"
                    "अगर सच में पता नहीं है, तो भेजें: pata nahi\n"
                    "(इसके बिना भी मैं आपकी मून चार्ट और अंक ज्योतिष बता सकता हूँ, लेकिन लग्न और भाव नहीं।)"),
        "time_invalid": ("मैं वो समय समझ नहीं पाया। ऐसे भेजें: 10:30 am या 22:15\n"
                         "अगर पता नहीं है तो भेजें: pata nahi"),
        "ask_place": "बस थोड़ा और — आप किस शहर में पैदा हुए थे? (जैसे: लुधियाना या दिल्ली)",
        "place_length": "कृपया सिर्फ शहर का नाम भेजें — जैसे: लुधियाना",
        "place_state_only": ("'{place}' एक राज्य है, शहर नहीं — मुझे वो सही शहर चाहिए जहाँ आप पैदा हुए थे "
                             "(उस राज्य के अंदर का शहर, राज्य का नाम नहीं)।"),
        "place_not_found": "मुझे '{place}' नहीं मिला। कृपया पास का कोई बड़ा शहर भेजें — जैसे: लुधियाना, दिल्ली, मुंबई।",
        "help": ("आप मुझे ये भेज सकते हैं:\n\n"
                "• कोई भी जीवन से जुड़ा सवाल — करियर, शादी, पैसा, सेहत, बिज़नेस\n"
                "• balance — आपके पास कितने सवाल बचे हैं\n"
                "• reading — आपकी कुंडली और अंक ज्योतिष सारांश दोबारा\n"
                "• order <number> — खरीदा हुआ question pack अनलॉक करें\n"
                "• restart — अपनी जन्म जानकारी दोबारा भरें\n"
                "• help — यही संदेश"),
        "balance_left": "आपके पास {n} सवाल बचे हैं। 🌙",
        "balance_none": "आपके पास अब कोई सवाल नहीं बचा।\n\nनया pack यहाँ से लें:\n{shop_url}",
        "order_usage": "ऐसे भेजें: order 1234  (आपका Shopify order number, confirmation email में मिलेगा)",
        "order_check_failed": "मैं अभी वो order चेक नहीं कर पाया। कृपया कुछ मिनट बाद फिर कोशिश करें। 🙏",
        "order_not_found": ("मुझे इस नंबर पर order #{order_no} में कोई question pack नहीं मिला। "
                            "order number चेक करें, या checkout पर इस्तेमाल किया गया फ़ोन नंबर भेजें।"),
        "order_already_unlocked": "Order #{order_no} पहले से unlock है। आपके पास {remaining} सवाल बचे हैं।",
        "order_greeting": "नमस्ते {name}! ",
        "order_unlocked": "{greeting}✅ Order #{order_no} से {total} सवाल unlock हो गए। अब आपके पास {remaining} हैं।{nudge}",
        "order_nudge": "\n\nपहले अपना नाम बताइए ताकि मैं आपकी कुंडली बना सकूँ।",
        "ask_full_question": "मुझसे पूरा सवाल पूछें — जैसे: क्या इस साल मुझे promotion मिलेगा?",
        "no_quota_first": ("सवाल पूछने के लिए आपके पास question pack होना ज़रूरी है। 🌙\n\nयहाँ से लें:"
                           "\n{shop_url}\n\nपेमेंट के बाद भेजें: order <आपका order number>"),
        "no_quota_repeat": ("आपके सारे सवाल इस्तेमाल हो चुके हैं। 🌙\n\nनया pack यहाँ से लें:"
                            "\n{shop_url}\n\nपेमेंट के बाद भेजें: order <आपका order number>"),
        "answer_could_not": ("मैं वो सवाल जवाब नहीं दे पाया, और इसे आपके pack में नहीं गिना गया है। "
                             "कृपया इसे दोबारा पूछें, या करियर, शादी, पैसा या सेहत के बारे में पूछें। 🙏"),
        "answer_error": ("अभी आपकी कुंडली पढ़ते समय कुछ गड़बड़ हो गई — आपका सवाल count नहीं हुआ है। "
                         "कृपया एक मिनट में दोबारा भेजें। 🙏"),
        "reading_tail_ready": "\n\nआपके पास {n} सवाल पूछने के लिए तैयार हैं। पूछिए। 🙏",
        "reading_tail_no_quota": ("\n\nसवाल पूछने के लिए, यहाँ से pack लें:\n{shop_url}\n"
                                  "फिर भेजें: order <आपका order number>"),
        "pending_answered": "\n\nआपने पहले भी पूछा था: \"{pending}\" — ये रहा जवाब:\n\n{answered}",
        "pending_no_quota": ("\n\nआपने पहले भी पूछा था: \"{pending}\" — question pack मिलते ही मैं "
                             "इसका जवाब दूँगा।\n\nयहाँ से लें:\n{shop_url}\n"
                             "फिर भेजें: order <आपका order number>"),
        "answer_trailer_left": "\n\n— {left} सवाल बचे हैं",
        "answer_trailer_last": "\n\n— यह आपका आखिरी सवाल था। नया pack: {shop_url}",
    },
}


def t(who, key: str, **kwargs) -> str:
    """Look up a deterministic string in the customer's chosen language (English default until
    they've picked one). `who` is either a user dict or a raw language code string."""
    lang = (who.get("language") if isinstance(who, dict) else who) or "en"
    table = STRINGS.get(lang, STRINGS["en"])
    s = table.get(key, STRINGS["en"][key])
    return s.format(**kwargs) if kwargs else s


# ── parsing ──────────────────────────────────────────────────────────────
DATE_FORMATS = ["%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y-%m-%d", "%d %b %Y", "%d %B %Y",
                "%b %d %Y", "%B %d %Y", "%d/%m/%y", "%d-%m-%y"]


def parse_dob(text: str) -> str | None:
    """Return YYYY-MM-DD, or None. Day-first, because customers are Indian."""
    t = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", (text or "").strip(), flags=re.I)
    t = re.sub(r"[,\s]+", " ", t).strip()
    for fmt in DATE_FORMATS:
        try:
            d = datetime.strptime(t, fmt)
        except ValueError:
            continue
        if d.year > datetime.now().year or d.year < 1900:
            return None
        return d.strftime("%Y-%m-%d")
    return None


def parse_time(text: str) -> tuple[str | None, bool]:
    """Return (HH:MM or None, known). known=False means the customer said they don't know."""
    t = (text or "").strip().lower()
    if re.search(r"\b(dont know|don't know|dk|no idea|not sure|nahi pata|pata nahi|unknown|no)\b", t):
        return None, False
    m = re.search(r"\b(\d{1,2})[:.\s]?(\d{2})?\s*(am|pm)?\b", t)
    if not m:
        return None, True
    hh, mm, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3)
    if ap == "pm" and hh < 12:
        hh += 12
    if ap == "am" and hh == 12:
        hh = 0
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return None, True
    return f"{hh:02d}:{mm:02d}", True


# ── deterministic renderings (no model) ──────────────────────────────────
def render_reading(pack: dict, lang: str = "en") -> str:
    """The free kundli + numerology summary. Pure template over computed values."""
    b, num = pack["birth"], pack["numerology"]
    moon, sun = pack["planets"]["Moon"], pack["planets"]["Sun"]
    d = (pack.get("dasha") or {}).get("current") or {}
    ss = pack.get("sadeSati") or {}
    first = (b.get("name") or "").strip().split(" ")[0]

    if lang == "hi":
        L = [f"✨ {first + ' की' if first else 'आपकी'} कुंडली तैयार है।", ""]
        L.append(f"मून साइन (राशि): {moon['sign']}  •  नक्षत्र: {moon['nakshatra']} (पद {moon['pada']})")
        L.append(f"सूर्य राशि (वैदिक): {sun['sign']}")
        if pack["meta"]["birthTimeKnown"]:
            L.append(f"लग्न: {pack['lagna']['sign']}")
        else:
            L.append("लग्न: गणना नहीं हुई — जन्म समय नहीं दिया गया।")
        L.append("")
        if d:
            L.append(f"चल रहा है: {d['maha']['lord']} महादशा — आपका मौजूदा जीवन-अध्याय "
                     f"({d['maha']['end']} तक)")
            L.append(f"इसके अंदर: {d['antar']['lord']} अंतरदशा — इसके अंदर का छोटा चरण "
                     f"({d['antar']['end']} तक)")
        if ss.get("active"):
            L.append(f"साढ़े साती: चल रही है, {ss['phase']} चरण"
                     + (f", लगभग {ss['endsApprox']} तक खत्म होगी" if ss.get("endsApprox") else ""))
        else:
            L.append("साढ़े साती: अभी नहीं चल रही।")
        L.append("")
        L.append(f"अंक ज्योतिष — मूलांक {num['mulank']}, भाग्यांक {num['bhagyank']}"
                 + (f" (मास्टर {num['bhagyankMaster']})" if num.get("bhagyankMaster") else "")
                 + f", पर्सनल ईयर {num['personalYear']}, {num['personalYearOf']} के लिए")
        if num.get("nameChaldean"):
            L.append(f"नाम अंक (Chaldean): {num['nameChaldean']['reduced']}")
        miss = num["loShu"]["missing"]
        if miss:
            L.append(f"Lo Shu में गायब अंक: {', '.join(str(m) for m in miss)}")
        L.append("")
        L.append("यहाँ से जो भी मैं आपको बताऊँगा, वो इसी कुंडली से पढ़ा गया है। करियर, शादी, पैसा, "
                 "सेहत या बिज़नेस के बारे में कुछ भी पूछें। 🌸")
        return "\n".join(L)

    L = [f"✨ {first + chr(39) + 's' if first else 'Your'} kundli is ready.", ""]
    L.append(f"Moon sign (rashi): {moon['sign']}  •  Nakshatra: {moon['nakshatra']} (pada {moon['pada']})")
    L.append(f"Sun sign (vedic): {sun['sign']}")
    if pack["meta"]["birthTimeKnown"]:
        L.append(f"Ascendant (lagna): {pack['lagna']['sign']}")
    else:
        L.append("Ascendant: not calculated — birth time was not given.")
    L.append("")
    if d:
        L.append(f"Running period: {d['maha']['lord']} mahadasha — your current life-chapter "
                 f"(till {d['maha']['end']})")
        L.append(f"Within it: {d['antar']['lord']} antardasha — the shorter phase inside it "
                 f"(till {d['antar']['end']})")
    if ss.get("active"):
        L.append(f"Sade Sati: active, {ss['phase']} phase"
                 + (f", ends around {ss['endsApprox']}" if ss.get("endsApprox") else ""))
    else:
        L.append("Sade Sati: not running right now.")
    L.append("")
    L.append(f"Numerology — Mulank {num['mulank']}, Bhagyank {num['bhagyank']}"
             + (f" (master {num['bhagyankMaster']})" if num.get("bhagyankMaster") else "")
             + f", Personal year {num['personalYear']} for {num['personalYearOf']}")
    if num.get("nameChaldean"):
        L.append(f"Name number (Chaldean): {num['nameChaldean']['reduced']}")
    miss = num["loShu"]["missing"]
    if miss:
        L.append(f"Lo Shu missing numbers: {', '.join(str(m) for m in miss)}")
    L.append("")
    L.append("Everything I tell you from here is read from this chart. Ask me anything about "
             "career, marriage, money, health or business. 🌸")
    return "\n".join(L)


def render_fallback_answer(pack: dict, topic: str, lang: str = "en") -> str:
    """Used only when the model's answer cannot be verified twice over. Facts only, no reading."""
    d = (pack.get("dasha") or {}).get("current") or {}
    ss = pack.get("sadeSati") or {}
    moon = pack["planets"]["Moon"]

    if lang == "hi":
        L = ["मैं आपको आपकी कुंडली की सीधी जानकारी देता हूँ, ताकि कुछ भी अंदाज़े से न कहा जाए:", ""]
        L.append(f"मून {moon['sign']} राशि में, {moon['nakshatra']} नक्षत्र।")
        if d:
            L.append(f"आप {d['maha']['lord']} महादशा में हैं, {d['maha']['end']} तक, साथ में "
                     f"{d['antar']['lord']} अंतरदशा {d['antar']['end']} तक।")
        L.append(f"शनि {pack['transits']['Saturn']['sign']} में और गुरु "
                 f"{pack['transits']['Jupiter']['sign']} में transit कर रहे हैं।")
        if ss.get("active"):
            L.append(f"साढ़े साती चल रही है ({ss['phase']} चरण)।")
        L.append("")
        L.append("मैं आपको ऐसी सटीक जानकारी देना पसंद करूँगा बजाय ऐसी रीडिंग के जिस पर मैं भरोसा न कर "
                 "सकूँ। अपना सवाल दोबारा एक-दो लाइन में भेजें और मैं इसे ठीक से पढ़कर बताऊँगा। 🙏")
        return "\n".join(L)

    L = ["Let me give you what your chart says plainly, so nothing is guessed:", ""]
    L.append(f"Moon in {moon['sign']}, {moon['nakshatra']} nakshatra.")
    if d:
        L.append(f"You are running {d['maha']['lord']} mahadasha till {d['maha']['end']}, "
                 f"with {d['antar']['lord']} antardasha till {d['antar']['end']}.")
    L.append(f"Saturn is transiting {pack['transits']['Saturn']['sign']} and Jupiter "
             f"{pack['transits']['Jupiter']['sign']}.")
    if ss.get("active"):
        L.append(f"Sade Sati is running ({ss['phase']} phase).")
    L.append("")
    L.append("I would rather give you these exact positions than a reading I cannot stand behind. "
             "Send your question once more in a line or two and I will read it properly for you. 🙏")
    return "\n".join(L)


# ── question answering ───────────────────────────────────────────────────
def _facts_text(facts: list[dict]) -> str:
    return "\n".join(f"[{f['id']}] {f['text']}" for f in facts)


def _passes_both_gates(draft: str, pack: dict, facts_text: str) -> tuple[bool, list[str]]:
    """A draft ships only if BOTH independent checks agree it is grounded.

    Gate 1 is deterministic regex against the pack — for the claim shapes it recognises it
    cannot be wrong, since it is arithmetic, not judgment. Gate 2 is a second, differently-
    framed model call that reads the SAME draft cold and hunts for anything gate 1's patterns
    don't catch. Requiring both is strictly stronger than either alone: gate 1 has zero false
    negatives on covered claim types but limited phrasing coverage; gate 2 has broad phrasing
    coverage but is itself a model call and could in principle miss something gate 1 catches.
    """
    regex_violations = guard.dedupe(guard.verify(draft, pack))
    if regex_violations:
        return False, regex_violations
    clean, problems = llm.verify_second_opinion(draft, facts_text)
    if not clean:
        return False, problems
    return True, []


# A handful of HINGLISH_STOPWORDS double as common standalone English words ("to", "main"
# street, "hum" a tune, "ho ho ho", "ya" know) — trustworthy as topic-classifier noise to
# ignore, but not as a signal that a whole message is Hindi. Excluded here for that reason.
_LANG_DETECT_AMBIGUOUS = {"to", "main", "hum", "ho", "ya"}


def _detect_message_lang(text: str, default: str) -> str:
    """Best-effort per-message language for the rare deterministic fallback answer — mirrors
    what the customer actually typed THIS message, the same principle the model's own answers
    follow (SYSTEM_PROMPT's mirror rule), rather than falling back to their stored onboarding
    preference regardless of what this particular question was written in."""
    if re.search(r"[ऀ-ॿ]", text):
        return "hi"
    words = re.findall(r"[a-zA-Z]+", text.lower())
    if any(w in factpack.HINGLISH_STOPWORDS and w not in _LANG_DETECT_AMBIGUOUS for w in words):
        return "hi"
    return "en" if words else default


def answer_question(user: dict, question: str) -> tuple[str, str, str]:
    """Returns (answer, guard_status, notes). Never returns unverified model text.

    Every candidate answer must clear BOTH the deterministic guard and an independent second
    model opinion before it ships — see _passes_both_gates(). One repair attempt is allowed,
    naming whichever gate rejected the draft; a second rejection ships the deterministic
    facts-only fallback instead of guessing again.
    """
    history = store.get_recent_qa(user["phone"], limit=3)
    topic = factpack.classify(question)
    # A vague follow-up ("tell me more", "what else", "why") carries no topic keywords of its
    # own and would otherwise fall through to generic facts, even though there's an obvious
    # topic sitting one message back. Inherit the last topic rather than genericizing —
    # only when classify() found nothing to go on and only when there IS a last topic.
    if topic == "general" and history and history[-1].get("topic") and history[-1]["topic"] != "general":
        topic = history[-1]["topic"]
    pack = factpack.fetch(user, topic=topic)
    facts = pack.get("topicFacts") or pack["facts"]
    facts_text = _facts_text(facts)
    prompt = llm.build_prompt(question, pack, topic, facts, history=history)

    draft, model = llm.generate(llm.SYSTEM_PROMPT, prompt)
    ok, violations = _passes_both_gates(draft, pack, facts_text)
    if ok:
        return draft, "clean", ""

    # One repair attempt, with the specific contradictions named — from whichever gate caught them.
    log.warning("gate rejected draft for %s: %s", user["phone"], violations)
    repair = prompt + "\n\n" + llm.REPAIR_TEMPLATE.format(
        draft=draft, violations="\n".join(f"- {v}" for v in violations))
    draft2, model = llm.generate(llm.SYSTEM_PROMPT, repair)
    ok2, violations2 = _passes_both_gates(draft2, pack, facts_text)
    if ok2:
        return draft2, "repaired", "; ".join(violations)

    log.error("gate rejected repair for %s: %s", user["phone"], violations2)
    lang = _detect_message_lang(question, user.get("language") or "en")
    return render_fallback_answer(pack, topic, lang), "fallback", "; ".join(violations + violations2)


# ── router ───────────────────────────────────────────────────────────────
def handle(phone: str, text: str) -> str:
    text = (text or "").strip()
    low = text.lower()
    _testing_top_up(phone)
    user = store.get_user(phone) or store.upsert_user(phone)
    brand = llm.BRAND

    if low in ("help", "/help", "menu"):
        return t(user, "help")
    if low in ("restart", "/restart", "reset", "/reset"):
        lang = user.get("language")
        store.reset_user(phone)
        if not lang:
            return LANG_PROMPT.format(brand=brand)
        store.upsert_user(phone, state="await_name")
        return t(lang, "greeting", brand=brand)
    if low in ("balance", "/balance", "left"):
        n = store.remaining(phone)
        return (t(user, "balance_left", n=n, s="s" if n != 1 else "") if n else
                t(user, "balance_none", shop_url=SHOP_URL))
    if low.startswith(("order", "/order")):
        return _handle_order(phone, text)
    if low in ("reading", "/reading", "kundli", "my kundli") and user.get("dob"):
        return render_reading(factpack.fetch(user), user.get("language") or "en")

    state = user.get("state") or "new"

    if state == "new":
        # A customer's first message is often a real question ("which crystal should I use"),
        # not a greeting — asked before the bot has any chart to answer it with. Losing that
        # question and making them realize on their own that they need to re-ask it later is
        # exactly the "doesn't remember what I told it" complaint. Save it if it looks
        # substantive; it gets answered automatically once onboarding finishes.
        stripped = text.strip()
        looks_like_greeting = re.fullmatch(
            r"(hi|hii+|hey|hello|namaste|namaskar|ram ram|yes|ok|okay|start|hlo)\W*",
            stripped, flags=re.I)
        fields = {}
        if not looks_like_greeting and len(stripped) >= 8:
            fields["pending_question"] = stripped[:500]
        # Language is asked once per phone number, ever — a restart shouldn't re-ask it.
        if user.get("language"):
            fields["state"] = "await_name"
            store.upsert_user(phone, **fields)
            return t(user, "greeting", brand=brand)
        fields["state"] = "await_language"
        store.upsert_user(phone, **fields)
        return LANG_PROMPT.format(brand=brand)

    if state == "await_language":
        low_t = text.strip().lower()
        if low_t in ("1", "english", "eng", "en"):
            lang = "en"
        elif low_t in ("2", "hindi", "hindi mein", "hi") or "हिंदी" in text or "हिन्दी" in text:
            lang = "hi"
        else:
            return LANG_PROMPT_RETRY
        store.upsert_user(phone, language=lang, state="await_name")
        return t(lang, "greeting", brand=brand)

    if state == "await_name":
        name = re.sub(r"^(my name is|i am|im|this is)\s+", "", text, flags=re.I).strip()
        if re.fullmatch(r"(hi|hii+|hey|hello|namaste|namaskar|ram ram|yes|ok|okay|start|hlo)\W*",
                        name, flags=re.I):
            return t(user, "name_retry")
        # A name never contains a digit — catches customers who jump ahead with their DOB
        # ("2nd september 1989", "18/09/2001") before we've asked for it, so we never store
        # a date fragment as someone's name.
        if re.search(r"\d", name):
            return t(user, "name_reject_date")
        if not (2 <= len(name) <= 60):
            return t(user, "name_reject_length")
        # A real question/sentence sent instead of a name passes every check above (no digits,
        # 2-60 chars) — confirmed in production: "exactly aapko kya information chiye meri" and
        # "tell me about my nature and future" both got stored as someone's literal name. Names
        # are almost never more than 4 words; anything longer, or carrying an obvious
        # question/sentence word, isn't one.
        words = name.split()
        SENTENCE_WORDS = {"kya", "kaise", "kyun", "kyu", "chahiye", "chiye", "batao", "bata",
                          "please", "tell", "what", "how", "why", "about", "information",
                          "hai", "hoon", "mujhe", "karo", "karna", "the", "is", "are"}
        looks_like_sentence = len(words) > 4 or any(w.lower() in SENTENCE_WORDS for w in words)
        if looks_like_sentence:
            return t(user, "name_reject_sentence")
        store.upsert_user(phone, name=name, state="await_dob")
        return t(user, "ask_dob", name=name.split()[0])

    if state == "await_dob":
        dob = parse_dob(text)
        if not dob:
            return t(user, "dob_invalid")
        store.upsert_user(phone, dob=dob, state="await_time")
        return t(user, "ask_time")

    if state == "await_time":
        parsed_time, known = parse_time(text)
        if known and not parsed_time:
            return t(user, "time_invalid")
        store.upsert_user(phone, birth_time=parsed_time, state="await_place")
        return t(user, "ask_place")

    if state == "await_place":
        place = text.strip()
        if not (2 <= len(place) <= 60):
            return t(user, "place_length")
        user = store.upsert_user(phone, place=place, state="ready")
        store.clear_factpack(phone)
        try:
            pack = factpack.fetch(user, force=True)
        except factpack.StateOnlyError:
            store.upsert_user(phone, state="await_place")
            return t(user, "place_state_only", place=place)
        except Exception:
            log.exception("factpack failed")
            store.upsert_user(phone, state="await_place")
            return t(user, "place_not_found", place=place)
        reading = render_reading(pack, user.get("language") or "en")
        n = store.remaining(phone)
        tail = (t(user, "reading_tail_ready", n=n, s="s" if n != 1 else "") if n else
                t(user, "reading_tail_no_quota", shop_url=SHOP_URL))

        pending = user.get("pending_question")
        if not pending:
            return reading + tail
        store.upsert_user(phone, pending_question=None)   # one-shot — never replay it twice
        if n <= 0:
            # No quota yet — surface their original question rather than silently dropping
            # it a second time; they still need to buy a pack before it can be answered.
            return reading + t(user, "pending_no_quota", pending=pending, shop_url=SHOP_URL)
        answered = _answer_billed(phone, store.get_user(phone), pending)
        return reading + t(user, "pending_answered", pending=pending, answered=answered)

    # state == ready → a question
    if len(text) < 6:
        return t(user, "ask_full_question")
    if store.remaining(phone) <= 0:
        ever = store.question_count(phone) > 0
        key = "no_quota_repeat" if ever else "no_quota_first"
        return t(user, key, shop_url=SHOP_URL)

    result = _answer_billed(phone, user, text)
    return result if result else t(user, "balance_none", shop_url=SHOP_URL)


def _answer_billed(phone: str, user: dict, question: str) -> str | None:
    """Consume a question, answer it, log it, refund on failure. Returns None only if there
    was no quota to consume (caller decides the message for that — differs by context: the
    main Q&A path already checked remaining() itself, the pending-question replay has its
    own "no quota yet" phrasing). Shared by the main ready-state handler and the
    pending-question replay in await_place, so billing/logging can't drift between the two."""
    ent_id = store.consume(phone)
    if ent_id is None:
        return None
    try:
        answer, status, notes = answer_question(user, question)
    except llm.RefusedError:
        store.refund(ent_id)
        return t(user, "answer_could_not")
    except Exception:
        store.refund(ent_id)
        log.exception("answer failed")
        return t(user, "answer_error")

    store.log_question(phone, factpack.classify(question), question, answer, status, notes,
                       llm.MODEL if llm.BACKEND == "api" else "claude-cli", ent_id)
    left = store.remaining(phone)
    return answer + (t(user, "answer_trailer_left", left=left, s="s" if left != 1 else "")
                     if left else t(user, "answer_trailer_last", shop_url=SHOP_URL))


def _handle_order(phone: str, text: str) -> str:
    user = store.get_user(phone)
    m = re.search(r"#?(\d{3,})", text)
    if not m:
        return t(user, "order_usage")
    order_no = m.group(1)
    try:
        grants = shopify_verify.verify_order(order_no, phone, PACK_SKUS)
    except Exception:
        log.exception("order verify failed")
        return t(user, "order_check_failed")
    if not grants:
        return t(user, "order_not_found", order_no=order_no)
    total = 0
    for g in grants:
        if store.grant(phone, g["questions"], f"#{order_no}", g["sku"]):
            total += g["questions"]
    if total == 0:
        return t(user, "order_already_unlocked", order_no=order_no, remaining=store.remaining(phone))
    nudge = "" if (user and user.get("dob")) else t(user, "order_nudge")
    return t(user, "order_unlocked", total=total, order_no=order_no, greeting="",
             remaining=store.remaining(phone), nudge=nudge)
