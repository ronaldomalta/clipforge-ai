"""Grounded title suggestions.

Titles only use evidence actually found in the clip: preferably the streamer's own
words (quoted), otherwise a neutral description of the measured signals. Nothing like
"police chase" is claimed unless it was literally said.
"""
from .semantic import best_phrase

TEMPLATES = {
    "pt": {
        "laugh": "MOMENTO DE MUITA RISADA",
        "impact": "IMPACTO SÚBITO NA GAMEPLAY",
        "death": "A TELA PERDEU A COR DE REPENTE",
        "reaction": "REAÇÃO INTENSA AO VIVO",
        "action": "AÇÃO INTENSA NA GAMEPLAY",
        "default": "MOMENTO EM DESTAQUE",
    },
    "en": {
        "laugh": "COULDN'T STOP LAUGHING",
        "impact": "SUDDEN IMPACT IN THE GAMEPLAY",
        "death": "THE SCREEN SUDDENLY LOST ITS COLOR",
        "reaction": "INTENSE LIVE REACTION",
        "action": "INTENSE GAMEPLAY ACTION",
        "default": "HIGHLIGHT MOMENT",
    },
}


def make_title(segments, start, end, comps, events, language):
    lang = "en" if (language or "").startswith("en") else "pt"
    t = TEMPLATES[lang]
    phrase = best_phrase(segments or [], start, end)
    if phrase and phrase[0] >= 3:
        text = phrase[1].strip(" .,;:")
        if text:
            text = text.upper()
            if not text.endswith(("!", "?")):
                text += "!"
            return f"“{text}”"
    if phrase and phrase[2].get("laughs"):
        return t["laugh"]
    types = {e["type"] for e in events or []}
    if "flash" in types or comps.get("burst", 0) >= 0.4:
        return t["impact"]
    if "desaturate" in types:
        return t["death"]
    if comps.get("reaction", 0) >= 0.45:
        return t["reaction"]
    if comps.get("visual", 0) >= 0.45:
        return t["action"]
    return t["default"]
