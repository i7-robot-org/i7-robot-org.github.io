#!/usr/bin/env python3
"""Synthesize the four spoken lines of the film with Kokoro (v1.1-zh, Apache-2.0) through sherpa-onnx,
give the robot a light synthetic timbre, and write video/voice/*.wav (48 kHz mono) plus voice.json
(start time, duration and a 30 fps loudness envelope per line, used for lip and light sync).

  pip install sherpa-onnx soundfile numpy
  curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2
  tar xjf kokoro-multi-lang-v1_1.tar.bz2
  python3 make_voice.py kokoro-multi-lang-v1_1

The start times must match VOICE in assets/i7sim.js; make_audio.py reads voice.json.
"""
import json
import os
import sys

import numpy as np
import sherpa_onnx
import soundfile as sf

SR = 48000
PERSON, ROBOT = 60, 3                     # Kokoro speaker ids: a male and a female Mandarin voice
LINES = {                                 # key: (speaker, text, speed, start time in the film)
    'cmd': (PERSON, 'i7，帮我拿杯水。', 1.08, 15.55),
    'ok': (ROBOT, '好的，马上去拿。', 1.05, 17.45),
    'give': (ROBOT, '水来了，请拿好。', 1.0, 54.95),
    'thanks': (PERSON, '谢谢！', 1.0, 59.45),
}


def engine(d):
    d = d.rstrip('/') + '/'
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=d + 'model.onnx', voices=d + 'voices.bin', tokens=d + 'tokens.txt',
                data_dir=d + 'espeak-ng-data', dict_dir=d + 'dict',
                lexicon=d + 'lexicon-us-en.txt,' + d + 'lexicon-zh.txt'),
            num_threads=4),
        rule_fsts=d + 'phone-zh.fst,' + d + 'date-zh.fst,' + d + 'number-zh.fst', max_num_sentences=1)
    return sherpa_onnx.OfflineTts(cfg)


def resample(x, sr_in, sr_out):
    n = int(round(len(x) * sr_out / sr_in))
    return np.interp(np.arange(n) * sr_in / sr_out, np.arange(len(x)), x).astype(np.float32)


def trim(x, thr=0.01):
    idx = np.nonzero(np.abs(x) > thr)[0]
    a, b = max(0, idx[0] - int(0.02 * SR)), min(len(x), idx[-1] + int(0.08 * SR))
    return x[a:b]


def robotize(x):
    """Keep it intelligible: a short swept delay (slight metallic sheen) and a faint 55 Hz ring modulation."""
    t = np.arange(len(x)) / SR
    d = (0.0025 + 0.0012 * np.sin(2 * np.pi * 0.7 * t)) * SR
    src = np.clip(np.arange(len(x)) - d, 0, len(x) - 1)
    delayed = np.interp(src, np.arange(len(x)), x)
    y = x + 0.45 * delayed
    y = 0.88 * y + 0.12 * y * np.sin(2 * np.pi * 55 * t)
    return (y / np.abs(y).max() * 0.95).astype(np.float32)


def envelope(x, fps=30):
    hop = SR // fps
    n = int(np.ceil(len(x) / hop))
    rms = np.array([np.sqrt(np.mean(x[k * hop:(k + 1) * hop] ** 2) + 1e-12) for k in range(n)])
    e = np.clip(rms / np.percentile(rms, 95), 0, 1)
    return ''.join(str(min(9, int(round(v * 9)))) for v in e)


def main():
    tts = engine(sys.argv[1] if len(sys.argv) > 1 else 'kokoro-multi-lang-v1_1')
    here = os.path.dirname(os.path.abspath(__file__))
    out = {}
    for key, (sid, text, speed, t0) in LINES.items():
        a = tts.generate(text, sid=sid, speed=speed)
        x = trim(resample(np.array(a.samples, dtype=np.float32), a.sample_rate, SR))
        x = robotize(x) if sid == ROBOT else (x / np.abs(x).max() * 0.95).astype(np.float32)
        sf.write(os.path.join(here, 'voice', f'{key}.wav'), x, SR, subtype='PCM_16')
        out[key] = {'t0': t0, 'dur': round(len(x) / SR, 3), 'text': text, 'speaker': 'robot' if sid == ROBOT else 'person', 'env': envelope(x)}
        print(f'{key:7s} {t0:6.2f}s +{len(x) / SR:.2f}s  {text}')
    json.dump(out, open(os.path.join(here, 'voice', 'voice.json'), 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
