"""Generate a synthetic "gameplay recording" with known events for real end-to-end tests.

Timeline (default 300 s, 1280×720 @30 fps):
  30 s   calm talking (normal volume)
  60–90  loud steady music (should be penalised: loud but irrelevant)
  ~120 s explosion-like noise burst + white flash + loud reaction + desaturated screen
  200 s  calm talking
  ~239 s intense visual noise (motion) + loud reaction ("Corre! A polícia!")
Speech uses espeak-ng when available; otherwise voice-band tone bursts are used.

    python make_fixture.py OUT.mp4 [--lang pt|en] [--duration 300]
"""
import argparse
import os
import shutil
import subprocess
import tempfile

LINES = {
    "pt": {
        "chat1": "Então pessoal, vamos continuar aqui a missão, devagarzinho.",
        "react1": "Meu Deus! Não acredito! Explodiu tudo!",
        "chat2": "Bom, agora a gente vai até a loja comprar umas coisas.",
        "react2": "Corre! Corre! A polícia! Foge!",
        "voice": "pt-br",
        "bed": "Então, aqui no jogo a gente tem que pegar o carro e ir até o outro lado da cidade. "
               "Vou passar pelo centro, depois pela praia, e aí a gente vê o que acontece. "
               "Olha o chat aí, valeu pela presença de todo mundo, sigam a live. "
               "Agora deixa eu ver o mapa, acho que é por aqui mesmo, vamos com calma.",
    },
    "en": {
        "chat1": "Alright everyone, let's keep going with this mission, slowly.",
        "react1": "Oh my God! No way! Everything exploded!",
        "chat2": "Okay, now we are going to the shop to buy some stuff.",
        "react2": "Run! Run! The police! Go go go!",
        "voice": "en-us",
        "bed": "So in this game we need to grab the car and drive to the other side of the city. "
               "I will go through downtown, then the beach, and we will see what happens. "
               "Thanks chat for being here, follow the stream. Let me check the map, I think it is this way.",
    },
}
EVENTS = {"chat1": (30.0, 60), "react1": (120.5, 200), "chat2": (200.0, 60), "react2": (239.0, 200)}


def speech(tmp, lang):
    files = {}
    espeak = shutil.which("espeak-ng") or shutil.which("espeak")
    for key, (_, amp) in EVENTS.items():
        out = os.path.join(tmp, f"{key}.wav")
        if espeak:
            subprocess.run([espeak, "-v", LINES[lang]["voice"], "-s", "165", "-a", str(amp), LINES[lang][key], "-w", out], check=True)
        else:
            vol = 0.9 if amp > 100 else 0.25
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                            f"aevalsrc='{vol}*sin(2*PI*(180+40*sin(2*PI*3*t))*t)*(0.6+0.4*sin(2*PI*5*t))':s=16000:d=3", out], check=True)
        files[key] = out
    bed = os.path.join(tmp, "bed.wav")
    if espeak:
        subprocess.run([espeak, "-v", LINES[lang]["voice"], "-s", "150", "-a", "35", LINES[lang]["bed"], "-w", bed], check=True)
        files["bed"] = bed
    return files


def build(out, lang="pt", duration=300, ffmpeg="ffmpeg"):
    with tempfile.TemporaryDirectory() as tmp:
        voices = speech(tmp, lang)
        inputs = ["-f", "lavfi", "-i", f"testsrc2=s=1280x720:r=30:d={duration}",
                  "-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude=0.05:d={duration}:r=48000",
                  "-f", "lavfi", "-i", f"aevalsrc='if(between(t,60,90),0.35*sin(2*PI*220*t)+0.25*sin(2*PI*330*t)+0.2*sin(2*PI*440*t),0)':s=48000:d={duration}",
                  "-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=1.0:d=1.4:r=48000"]
        order = list(EVENTS)
        for key in order:
            inputs += ["-i", voices[key]]
        if "bed" in voices:  # continuous low-level talking, like a real stream
            inputs += ["-stream_loop", "-1", "-i", voices["bed"]]
        vf = ("[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=white@0.92:t=fill:enable='between(t,119.8,120.5)',"
              "hue=s=0:enable='between(t,122,127)',"
              "noise=alls=90:allf=t:enable='between(t,236,247)',format=yuv420p[v]")
        parts = [vf, "[3:a]afade=t=out:st=0.3:d=1.1,volume=2.5,adelay=119800|119800[boom]"]
        mix = ["[1:a]", "[2:a]", "[boom]"]
        for i, key in enumerate(order):
            ms = int(EVENTS[key][0] * 1000)
            parts.append(f"[{4 + i}:a]aresample=48000,adelay={ms}|{ms}[s{i}]")
            mix.append(f"[s{i}]")
        if "bed" in voices:
            parts.append(f"[{4 + len(order)}:a]aresample=48000,atrim=0:{duration},volume='if(between(t,115,130)+between(t,235,250),0,1)':eval=frame[bed]")
            mix.append("[bed]")
        parts.append("".join(mix) + f"amix=inputs={len(mix)}:normalize=0:duration=first,alimiter=limit=0.97[a]")
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(parts),
               "-map", "[v]", "-map", "[a]", "-t", str(duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
               "-g", "60", "-c:a", "aac", "-b:a", "128k", out]
        subprocess.run(cmd, check=True)
    return out


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("out")
    p.add_argument("--lang", default="pt")
    p.add_argument("--duration", type=int, default=300)
    a = p.parse_args()
    build(a.out, a.lang, a.duration)
    print(a.out)
