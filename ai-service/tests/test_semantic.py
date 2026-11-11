from clipforge_ai.semantic import analyze_text, best_phrase, normalize
from clipforge_ai.titles import make_title


def test_lexicon_matches_without_accents_and_case():
    info = analyze_text("MEU DEUS, não acredito!")
    phrases = {h["phrase"] for h in info["hits"]}
    assert {"meu deus", "nao acredito"} <= phrases
    assert info["exclamations"] == 1
    assert info["score"] >= 10


def test_word_boundaries_avoid_false_hits():
    # "corredor" must not match "corre"; "mortadela" must not match "morreu"
    info = analyze_text("passei pelo corredor comendo mortadela")
    assert info["hits"] == []
    assert info["score"] == 0


def test_generic_cues_score_unlisted_expressions():
    # Not in the lexicon, but repetition + exclamations + short burst still count.
    info = analyze_text("Vai vai vai!!")
    assert info["repetitions"] >= 2
    assert info["score"] > 3


def test_laughter_and_english():
    assert analyze_text("kkkkkk que isso")["laughs"] == 1
    assert analyze_text("hahaha no way")["laughs"] == 1
    assert any(h["phrase"] == "oh my god" for h in analyze_text("Oh my God!")["hits"])


def test_normalize():
    assert normalize("Não  ACREDITO") == "nao acredito"


def test_title_quotes_streamer_words_only():
    segs = [{"start": 10, "end": 12, "text": "Meu Deus, explodiu tudo!"}, {"start": 40, "end": 42, "text": "vamos ali"}]
    title = make_title(segs, 5, 20, {"reaction": 0.9}, [], "pt")
    assert title == "“MEU DEUS, EXPLODIU TUDO!”"
    # Without speech evidence the title only describes measured signals.
    assert make_title([], 0, 10, {"reaction": 0.1, "visual": 0.8}, [], "pt") == "AÇÃO INTENSA NA GAMEPLAY"
    assert make_title([], 0, 10, {}, [{"type": "flash", "t": 1}], "en") == "SUDDEN IMPACT IN THE GAMEPLAY"
    assert best_phrase(segs, 30, 50) is None
