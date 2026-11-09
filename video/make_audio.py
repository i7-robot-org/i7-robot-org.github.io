#!/usr/bin/env python3
"""Synthesize the film's soundtrack: a soft chord pad, a quiet pluck arpeggio, UI and gripper sound
effects placed on the same timeline as assets/i7sim.js, and the dialogue from voice/ (make_voice.py),
with the music ducked under speech. Writes a 48 kHz stereo WAV.

  python3 make_audio.py out.wav          then normalise, e.g.
  ffmpeg -i out.wav -af loudnorm=I=-14:TP=-1.5:LRA=11 -ar 48000 mix.wav
"""
import json
import os
import sys
import wave

import numpy as np

SR = 48000
DUR = 65.5
D = 8.5        # the grasp, return and hand-over run D seconds later than in the first 57 s cut (i7sim.js)
N = int(SR * DUR)
rng = np.random.default_rng(7)
t_all = np.arange(N) / SR


def note(m):  # MIDI note -> Hz
    return 440.0 * 2 ** ((m - 69) / 12)


def env_adsr(n, a, d, s, r):
    e = np.ones(n) * s
    ia, idd, ir = int(a * SR), int(d * SR), int(r * SR)
    e[:ia] = np.linspace(0, 1, ia, endpoint=False)
    e[ia:ia + idd] = np.linspace(1, s, idd, endpoint=False)
    e[-ir:] *= np.linspace(1, 0, ir)
    return e


def place(buf, start, sig, gain=1.0, pan=0.0):
    i = int(start * SR)
    j = min(len(buf), i + len(sig))
    if j <= i:
        return
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[i:j, 0] += sig[: j - i] * gain * l
    buf[i:j, 1] += sig[: j - i] * gain * r


def lowpass(x, cutoff):
    """One-pole lowpass. Uses scipy when it is installed (same filter, much faster than the Python loop)."""
    a = np.exp(-2 * np.pi * cutoff / SR)
    try:
        from scipy.signal import lfilter
        return lfilter([1 - a], [1, -a], x)
    except ImportError:
        pass
    y = np.empty_like(x); acc = 0.0
    for k in range(len(x)):
        acc = (1 - a) * x[k] + a * acc; y[k] = acc
    return y


def reverb(x, mix=0.25):
    """Cheap stereo-ish reverb: a few feedback combs."""
    out = np.zeros_like(x)
    for d, g in [(0.0297, 0.72), (0.0371, 0.70), (0.0411, 0.68), (0.0437, 0.66)]:
        n = int(d * SR); y = x.copy()
        for k in range(n, len(y), n):
            y[k:k + n] += y[k - n:k][: len(y[k:k + n])] * g
        out += y
    return x * (1 - mix) + out / 4 * mix


mix = np.zeros((N, 2))      # music bed (ducked under speech)
fx = np.zeros((N, 2))       # sound effects
vox = np.zeros((N, 2))      # dialogue

# ---------------------------------------------------------------- pad: Cmaj9 / Am9 / Fmaj9 / G6sus, 84 bpm, 2 bars each
BAR = 60 / 84 * 4
chords = [[48, 55, 59, 62, 64], [45, 52, 55, 59, 60], [41, 48, 52, 55, 57], [43, 50, 52, 55, 60]]
pad = np.zeros(N)
k = 0; t0 = 0.0
while t0 < DUR:
    ln = min(2 * BAR + 0.8, DUR - t0)
    n = int(ln * SR); tt = np.arange(n) / SR
    sig = np.zeros(n)
    for m in chords[k % 4]:
        for det in (-0.12, 0.12):
            f0 = note(m) * 2 ** (det / 12)
            sig += np.sin(2 * np.pi * f0 * tt) * 0.6 + np.sin(2 * np.pi * 2 * f0 * tt) * 0.12
    sig *= env_adsr(n, 1.2, 0.5, 0.85, 1.0) / 10
    i = int(t0 * SR); pad[i:i + n] += sig[: N - i]
    t0 += 2 * BAR; k += 1
pad = lowpass(pad, 2400)
fade = np.clip(t_all / 2.5, 0, 1) * np.clip((DUR - t_all) / 3.5, 0, 1)
pad *= fade
mix[:, 0] += pad * 0.9; mix[:, 1] += pad * 0.9

# ---------------------------------------------------------------- pluck arpeggio on eighth notes from the map chapter to the end card
EIGHTH = 60 / 84 / 2
arp_env = lambda tt: np.exp(-tt * 9)
step = 0
t0 = 4.0
while t0 < 53.0 + D:
    ch = chords[int(t0 // (2 * BAR)) % 4]
    m = ch[[1, 2, 3, 4, 3, 2][step % 6]] + 12
    n = int(0.6 * SR); tt = np.arange(n) / SR
    s = (np.sin(2 * np.pi * note(m) * tt) + 0.3 * np.sin(4 * np.pi * note(m) * tt)) * arp_env(tt)
    place(mix, t0, s, 0.045, pan=0.35 * np.sin(step * 0.9))
    t0 += EIGHTH; step += 1


# ---------------------------------------------------------------- sound effects
def blip(f, ln=0.09, decay=40):
    tt = np.arange(int(ln * SR)) / SR
    return np.sin(2 * np.pi * f * tt) * np.exp(-tt * decay)


def click():
    tt = np.arange(int(0.03 * SR)) / SR
    return (rng.standard_normal(len(tt)) * 0.4 + np.sin(2 * np.pi * 2200 * tt)) * np.exp(-tt * 160)


def chime(f, ln=1.6):
    tt = np.arange(int(ln * SR)) / SR
    return sum(np.sin(2 * np.pi * f * h * tt) * a for h, a in [(1, 1), (2.01, 0.35), (3.02, 0.12)]) * np.exp(-tt * 3.2)


def thump(f=90, ln=0.18):
    tt = np.arange(int(ln * SR)) / SR
    return np.sin(2 * np.pi * f * tt * (1 - tt * 1.5)) * np.exp(-tt * 28)


def servo(ln, f0, f1):
    """Small gear motor: a buzzy tone gliding from f0 to f1 with a soft start and stop."""
    tt = np.arange(int(ln * SR)) / SR
    ph = 2 * np.pi * np.cumsum(f0 + (f1 - f0) * tt / ln) / SR
    s = np.sin(ph) + 0.45 * np.sin(2 * ph) + 0.25 * np.sin(3 * ph) + 0.15 * rng.standard_normal(len(tt))
    return lowpass(s, 3000) * np.clip(tt / 0.04, 0, 1) * np.clip((ln - tt) / 0.06, 0, 1)


for t in [4.0, 12.0, 14.5, 19.0, 24.5, 31.0, 36.5, 45.5, 53.5]:   # chapter changes
    place(fx, t, click(), 0.22)
# vision and depth camera: table found, navigation goal set, front plane fitted, squared up
place(fx, 22.3, chime(1174.7, 1.2), 0.09, pan=0.3)
place(fx, 23.25, blip(1568) + blip(2349), 0.06, pan=-0.2)
place(fx, 31.6, blip(1318.5) + blip(1975.5), 0.06, pan=0.2)
place(fx, 35.3, reverb(chime(1568, 1.4), 0.3), 0.08)
place(fx, 12.2, reverb(chime(880, 2.0), 0.4), 0.16)            # localisation pulse
place(fx, 17.2, chime(1320, 1.2), 0.08, pan=-0.3)              # return point pinned
for t, f, pan in [(15.45, 990, -0.4), (17.35, 1320, 0.4), (46.4 + D, 1320, 0.4), (50.8 + D, 990, -0.4)]:   # speech bubbles
    place(fx, t, blip(f) + blip(f * 1.5), 0.08, pan)
# gripper (i7sim.js gripAt, plus D): opens 30.2-31.0, closes on the bottle 32.55-32.9, lets go 49.3-49.6, rests 51.0-52.2
place(fx, 30.2 + D, servo(0.8, 520, 610), 0.07, pan=0.2)
place(fx, 32.55 + D, servo(0.32, 640, 520), 0.08, pan=0.2)
place(fx, 32.86 + D, thump(110), 0.4, pan=0.2); place(fx, 32.88 + D, click(), 0.22, pan=0.2)
place(fx, 49.3 + D, servo(0.3, 560, 660), 0.08, pan=-0.2); place(fx, 49.3 + D, click(), 0.2, pan=-0.2)
place(fx, 49.4 + D, reverb(chime(1046.5, 1.8), 0.35), 0.1)
place(fx, 51.0 + D, servo(1.2, 600, 500), 0.04, pan=-0.2)
place(fx, 53.4 + D, reverb(chime(784, 2.6), 0.4), 0.12)                              # end card

# lidar whir while mapping: band-limited noise with a slow rotation flutter
i0, i1 = int(4.2 * SR), int(11.8 * SR)
nz = lowpass(lowpass(rng.standard_normal(i1 - i0), 1200), 1200)   # two poles, so it stays a soft whir rather than hiss
tt = np.arange(i1 - i0) / SR
nz *= (0.6 + 0.4 * np.sin(2 * np.pi * 10 * tt)) * np.clip(tt / 0.6, 0, 1) * np.clip((tt[-1] - tt) / 0.6, 0, 1)
place(fx, 4.2, nz / max(1e-9, np.abs(nz).max()), 0.035)


# ---------------------------------------------------------------- dialogue: the person in a small room, the robot dry (it is the speaker)
def read_wav(path):
    with wave.open(path) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2") / 32768.0


def room(x):
    """Short early reflections, so the person sounds like they stand in the lab rather than in the mic."""
    y = x.copy()
    for d, g in [(0.011, 0.32), (0.017, 0.24), (0.026, 0.18), (0.037, 0.12), (0.049, 0.08)]:
        n = int(d * SR); y[n:] += x[:-n] * g
    return reverb(y, 0.12)


VOICE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice")
for key, line in json.load(open(os.path.join(VOICE_DIR, "voice.json"))).items():
    sig = read_wav(os.path.join(VOICE_DIR, f"{key}.wav"))
    sig = sig / max(1e-9, np.abs(sig).max())
    if line["speaker"] == "person":
        place(vox, line["t0"], room(sig), 1.0, pan=-0.25)
    else:
        place(vox, line["t0"], sig, 1.1, pan=0.2)

# duck the music about 10 dB while anyone speaks (fast attack, slow release)
speech = np.abs(vox).max(1) > 0.02
win_n = int(0.25 * SR)
active = np.convolve(speech.astype(float), np.ones(win_n) / win_n, mode="same") > 0
duck = np.where(active, 0.3, 1.0)
duck = lowpass(duck, 3.0)

mix = 0.55 * mix * duck[:, None] + fx + vox
mix /= max(1e-9, np.abs(mix).max()) / 0.8
pcm = (mix * 32767).astype("<i2")
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "soundtrack.wav", "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
