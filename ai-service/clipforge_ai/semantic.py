"""Speech semantics: reaction lexicon (PT-BR / EN) + generic excitement cues.

The lexicon is a starting point, not the only signal: exclamations, interjections,
word repetition ("corre corre corre"), laughter tokens, short bursty utterances and
speech-rate jumps also contribute, so unlisted expressions can still score.
"""
import re
import unicodedata

# phrase -> (weight, category). Matching is accent/case-insensitive on word boundaries.
LEXICON = {
    # surprise / disbelief
    "meu deus": (5, "surpresa"), "nao acredito": (5, "surpresa"), "que isso": (4, "surpresa"),
    "olha isso": (4, "surpresa"), "olha so": (3, "surpresa"), "como assim": (3, "surpresa"),
    "nao e possivel": (4, "surpresa"), "mentira": (2, "surpresa"), "caraca": (3, "surpresa"),
    "caramba": (3, "surpresa"), "nossa": (2, "surpresa"), "eita": (3, "surpresa"), "vish": (3, "surpresa"),
    "uau": (3, "surpresa"), "socorro": (4, "perigo"), "oh my god": (5, "surpresa"), "omg": (4, "surpresa"),
    "no way": (5, "surpresa"), "what the": (4, "surpresa"), "wtf": (4, "surpresa"), "holy": (3, "surpresa"),
    "are you kidding": (4, "surpresa"), "look at that": (4, "surpresa"), "wow": (3, "surpresa"),
    # intensity / profanity used as reaction
    "caralho": (4, "intensidade"), "porra": (3, "intensidade"), "puta merda": (4, "intensidade"),
    "puta que pariu": (5, "intensidade"), "fuck": (3, "intensidade"), "shit": (2, "intensidade"),
    "insano": (3, "intensidade"), "absurdo": (3, "intensidade"), "insane": (3, "intensidade"), "crazy": (3, "intensidade"),
    # success
    "consegui": (4, "vitoria"), "ganhei": (4, "vitoria"), "ganhamos": (4, "vitoria"), "vitoria": (3, "vitoria"),
    "matei": (3, "vitoria"), "let's go": (4, "vitoria"), "lets go": (4, "vitoria"), "bora": (2, "vitoria"),
    "vamo": (2, "vitoria"), "isso ai": (3, "vitoria"), "we did it": (4, "vitoria"), "i did it": (4, "vitoria"),
    "easy": (2, "vitoria"), "clutch": (4, "vitoria"), "gg": (2, "vitoria"),
    # failure / death
    "morri": (4, "derrota"), "morreu": (3, "derrota"), "perdi": (3, "derrota"), "quase": (3, "derrota"),
    "nao nao nao": (4, "derrota"), "noo": (3, "derrota"), "i died": (4, "derrota"), "i'm dead": (3, "derrota"),
    "almost": (2, "derrota"),
    # danger / chase / GTA-ish
    "corre": (3, "perigo"), "foge": (3, "perigo"), "fuga": (3, "perigo"), "policia": (3, "policia"),
    "os home": (3, "policia"), "viatura": (3, "policia"), "procurado": (2, "policia"), "estrela": (1, "policia"),
    "police": (3, "policia"), "cops": (3, "policia"), "run": (2, "perigo"), "go go go": (4, "perigo"),
    "explodiu": (5, "explosao"), "explosao": (4, "explosao"), "explodir": (3, "explosao"), "boom": (3, "explosao"),
    "explosion": (4, "explosao"), "exploded": (5, "explosao"), "bateu": (2, "acidente"), "capotou": (4, "acidente"),
    "acidente": (3, "acidente"), "crash": (3, "acidente"), "tiro": (3, "combate"), "atira": (3, "combate"),
    "shoot": (3, "combate"), "headshot": (4, "combate"),
}
INTERJECTIONS = {"oh", "ah", "ai", "ui", "opa", "ops", "ei", "hey", "whoa", "woah", "oof", "yes", "sim", "nao", "no"}
LAUGH_RE = re.compile(r"\b(k{3,}|(?:ha){2,}h?|(?:he){2,}|(?:rs){2,}|lol|lmao)\b|\(?(risos|risadas|laughs?|laughter)\)?", re.I)
WORD_RE = re.compile(r"[a-z0-9']+")


def normalize(text):
    text = unicodedata.normalize("NFD", text.lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", text)


_PATTERNS = [(re.compile(r"(?<![a-z0-9])" + re.escape(p) + r"(?![a-z0-9])"), p, w, cat) for p, (w, cat) in LEXICON.items()]


def analyze_text(text):
    """Return excitement score + evidence for a piece of transcript."""
    norm = normalize(text)
    hits = []
    score = 0.0
    for pattern, phrase, weight, cat in _PATTERNS:
        count = len(pattern.findall(norm))
        if count:
            score += weight * min(count, 2)
            hits.append({"phrase": phrase, "category": cat, "count": count})
    words = WORD_RE.findall(norm)
    exclam = text.count("!")
    score += 1.0 * min(exclam, 3)
    laughs = len(LAUGH_RE.findall(text))
    score += 3.0 * min(laughs, 2)
    rep = 0
    for a, b in zip(words, words[1:]):
        if a == b and len(a) > 1:
            rep += 1
    score += 1.5 * min(rep, 3)
    inter = sum(1 for w in words if w in INTERJECTIONS)
    if words and len(words) <= 4 and (exclam or inter):
        score += 1.5  # short exclamatory burst ("Ah não!", "Oh my!")
    return {"score": score, "hits": hits, "exclamations": exclam, "laughs": laughs, "repetitions": rep, "words": len(words)}


def best_phrase(segments, start, end):
    """Most expressive literal phrase said inside [start, end] (for grounded titles)."""
    best = None
    for seg in segments:
        if seg["end"] <= start or seg["start"] >= end:
            continue
        info = analyze_text(seg["text"])
        if info["score"] <= 0:
            continue
        text = seg["text"].strip().strip("-–—").strip()
        if len(text) > 48:
            # Cut around the first lexicon hit to keep the title short.
            norm = normalize(text)
            pos = min((norm.find(h["phrase"]) for h in info["hits"] if norm.find(h["phrase"]) >= 0), default=0)
            text = text[max(0, pos - 12): pos + 36].strip()
            text = text.split(" ", 1)[-1] if pos > 12 else text
        candidate = (info["score"], text, info)
        if best is None or candidate[0] > best[0]:
            best = candidate
    return best
