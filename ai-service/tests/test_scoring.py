import numpy as np

from clipforge_ai.scoring import Timeline, combine, select, make_window, find_peaks

HOP = 0.5


def make_audio(duration, events=(), base_db=-30.0, voice=True):
    n = int(duration / HOP)
    rel = np.zeros(n, dtype=np.float32)
    db = np.full(n, base_db, dtype=np.float32)
    burst = np.zeros(n, dtype=np.float32)
    voice_like = np.zeros(n, dtype=bool)
    for t, length, gain, is_burst in events:
        a, b = int(t / HOP), int((t + length) / HOP)
        rel[a:b] = gain
        db[a:b] = base_db + gain
        if is_burst:
            burst[a] = 1.0
        if voice:
            voice_like[a:b] = True
    return {"db": db, "rel": rel, "silent": np.zeros(n, bool), "burst": burst, "voice_like": voice_like, "steady_loud": np.zeros(n, bool)}


def test_flat_video_produces_no_highlights():
    tl = Timeline(600, make_audio(600), segments=[], vis_act=np.full(1200, 3.0), vis_scene=np.zeros(1200))
    moments, stats = select(tl, 5, 30, {}, 50)
    assert moments == []
    assert stats["selected"] == 0


def test_event_is_selected_with_context_and_reaction():
    segs = [
        {"start": 100.0, "end": 103.0, "text": "vamos lá então"},
        {"start": 110.5, "end": 113.5, "text": "Meu Deus! Não acredito!"},
    ]
    audio = make_audio(600, [(110.0, 4.0, 15.0, True)])
    tl = Timeline(600, audio, segments=segs, vis_act=np.full(1200, 5.0), vis_scene=np.zeros(1200))
    moments, _ = select(tl, 3, 30, {}, 50)
    assert len(moments) == 1, "only one real event: must not invent more"
    m = moments[0]
    assert m["start"] <= 108 and m["end"] >= 114.5  # build-up kept and full reaction kept
    assert abs((m["end"] - m["start"]) - 30) <= 4.5
    assert m["score"] >= 60
    assert any("Meu Deus" in r or "meu deus" in r for r in m["reasons"])
    assert m["title"].startswith("“")


def test_cut_does_not_split_sentences():
    segs = [{"start": 95.0, "end": 104.0, "text": "e aí eu peguei o carro e fui embora pela avenida"},
            {"start": 110.0, "end": 113.0, "text": "Caralho! Explodiu!"},
            {"start": 113.5, "end": 126.0, "text": "olha o tamanho dessa explosão que coisa"}]
    tl = Timeline(400, make_audio(400, [(110.0, 3.0, 14.0, True)]), segments=segs)
    for s, e, _ in [make_window(tl, int(111 / HOP), 30)]:
        for seg in segs:
            inside_start = seg["start"] < s < seg["end"]
            inside_end = seg["start"] < e < seg["end"]
            # When a cut lands inside a sentence it must be a long one that can't be snapped within tolerance.
            if inside_start:
                assert min(s - seg["start"], seg["end"] - s) > 3.0
            if inside_end:
                assert min(e - seg["start"], seg["end"] - e) > 3.0


def test_non_overlap_and_count_limit():
    events = [(t, 3.0, 14.0, True) for t in (50, 150, 250, 350, 450)]
    tl = Timeline(600, make_audio(600, events), segments=None, vis_act=np.full(1200, 10.0), vis_scene=np.zeros(1200))
    moments, _ = select(tl, 3, 30, {}, 30)
    assert len(moments) == 3
    spans = sorted((m["start"], m["end"]) for m in moments)
    for (a1, b1), (a2, b2) in zip(spans, spans[1:]):
        assert a2 >= b1 - 0.25 * 30


def test_repetition_penalty_prefers_diverse_clips():
    segs = []
    for t in (100, 200, 300):
        segs.append({"start": t, "end": t + 3, "text": "nossa que isso olha isso meu deus"})
    segs.append({"start": 400, "end": 403, "text": "consegui ganhei a corrida finalmente"})
    events = [(t, 3.0, 12.0, False) for t in (100, 200, 300, 400)]
    tl = Timeline(600, make_audio(600, events), segments=segs)
    moments, _ = select(tl, 2, 15, {}, 30)
    starts = [m["peak"] for m in moments]
    assert any(abs(p - 401) < 6 for p in starts), "different content should beat a repeated one"
    repeated = [m for m in moments if any("Parecido" in p for p in m["penalties"])]
    assert len(repeated) <= 1


def test_loud_only_is_penalised():
    n = 1200
    audio = make_audio(600, voice=False)
    audio["rel"][200:260] = 20.0  # 30 s of loud steady music
    audio["steady_loud"][200:260] = True
    tl = Timeline(600, audio, segments=[], vis_act=np.full(n, 3.0), vis_scene=np.zeros(n))
    moments, _ = select(tl, 3, 30, {}, 50)
    assert moments == []


def test_auto_duration_is_bounded():
    tl = Timeline(600, make_audio(600, [(300.0, 2.0, 15.0, True)]), segments=[])
    s, e, _ = make_window(tl, int(301 / HOP), "auto")
    assert 12 <= e - s <= 75


def test_short_video_uses_whole_video():
    tl = Timeline(20, make_audio(20), segments=[])
    moments, _ = select(tl, 3, 30, {}, 50)
    assert len(moments) == 1
    assert moments[0]["start"] == 0 and moments[0]["end"] == 20
    assert "Vídeo mais curto" in moments[0]["reasons"][0]


def test_weights_change_ranking():
    comps = {"audio": 1.0, "speech": 0.0, "reaction": 0.0, "visual": 0.0, "context": 0.5, "scene": 0.0}
    pens = {"silence": 0, "loudOnly": 0, "repetition": 0}
    assert combine(comps, pens, {"audio": 3.0}) > combine(comps, pens, {"audio": 0.1})


def test_find_peaks_respects_separation():
    e = np.zeros(200, dtype=np.float32)
    e[50], e[55], e[150] = 1.0, 0.9, 0.8
    peaks = find_peaks(e, 5, 20)
    assert 50 in peaks and 150 in peaks and 55 not in peaks
