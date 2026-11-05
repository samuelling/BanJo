"""Peak list and octave-band levels of a WAV: python3 test/spectrum.py file.wav [t0 t1]"""
import sys, numpy as np, scipy.io.wavfile as w
sr, x = w.read(sys.argv[1]); x = x.astype(float); x = x.mean(1) if x.ndim > 1 else x
t0 = float(sys.argv[2]) if len(sys.argv) > 2 else 0; t1 = float(sys.argv[3]) if len(sys.argv) > 3 else len(x) / sr
x = x[int(t0 * sr):int(t1 * sr)]
X = np.abs(np.fft.rfft(x * np.hanning(len(x)))); f = np.fft.rfftfreq(len(x), 1 / sr)
db = 20 * np.log10(X + 1e-9); db -= db.max()
pk = [i for i in range(2, len(X) - 2) if X[i] > X[i - 1] and X[i] > X[i + 1] and X[i] == X[max(0, i - 20):i + 20].max() and db[i] > -40]
print('peaks:', ' '.join(f'{f[i]:.0f}({db[i]:.0f})' for i in sorted(pk, key=lambda i: -db[i])[:14]))
bands = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
P = X ** 2; tot = P.sum()
print('octaves:', ' '.join(f'{b}:{10*np.log10(P[(f>=b/1.414)&(f<b*1.414)].sum()/tot+1e-12):.0f}' for b in bands))
