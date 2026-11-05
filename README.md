# BanJo

A physically modelled five-string banjo for the browser, with picking hands. Nothing is sampled. Every note comes from five simulated steel strings driving a drumhead through a three-footed bridge, with the air behind the head and a tone ring at its edge. All of it is computed live in an AudioWorklet. You can play it from a MIDI keyboard, the computer keyboard or chord pads, or by tapping the banjo itself.

It's the banjo sibling of [Acoustic](https://github.com/samuelling/Acoustic). The string engine's modal core is borrowed from Acoustic. Everything that makes a banjo a banjo is new: the pot, the bridge, the picks and the hands.

**Play:** https://samuelling.github.io/BanJo/

## 1. The pot (`src/pot.js`)

A banjo is a drum with a neck. The head is a film about 0.18 mm thick with an areal mass near 0.3 kg/m². A guitar top is far heavier, so the banjo's bridge moves 10–20 dB more easily than a guitar's. That mobility is most of the banjo's voice: string energy drains fast, giving loud, bright, short notes.

| Part | Model | Numbers from |
|---|---|---|
| Head | Circular membrane modes φ = J_m(j_mn r/a)·{cos, sin}(mθ) up to ~7 kHz. Bessel functions come from Miller recurrence and the zeros from a scan plus bisection. Air loading adds areal mass ρα/k, with extra mass for the breathing (m = 0) modes. | Woodhouse, Politzer & Mansour 2021: 268 mm head, 0.30 kg/m², lowest mode 380 Hz in vacuo and 290 Hz with air loading |
| Head tension | DrumDial reading → tension, about 4% per point. Calibrated so a bare 11" frosted head over an open pot rings at 290 Hz at DD 90 (6.15 kN/m in this model). | The calibration is an assumption; Woodhouse et al. estimated 5.33 kN/m from their FE model |
| Bridge | A rigid bar on three feet with four motions: heave, roll about the string axis, first free-free bending, and the top swaying on its legs. Strings press at their own positions across it, so each string sees its own 2×2 admittance: the 1st and 5th strings rock it most, the 3rd not at all. | 2.2 g, 78 mm footprint, 5/8" high. Bending lands near 5 kHz and sway near 3 kHz, the two "bridge hill" formants Woodhouse et al. found |
| Bridge springs | String stretching EA sin²β/(L+a), plus tension over the afterlength T cos²β/a, plus head stiffening under the down-force, scaled with break angle and head tension | Woodhouse et al. eqs. 15–16; their fitted total of 20 kN/m. Politzer 2021 on head vs. string spring forces |
| Feet | Contact springs: the wood foot in series with the head compliance that the truncated modes leave out. That compliance is the Dirichlet disc Green's function regularized over the foot. | — |
| Air, open back | The air in the pot is a short pipe closed by the head, lumped as a plug in the opening on the pot's air spring. Its length is matched to the pipe's quarter-wave resonance. A belly against the back closes part of the opening and absorbs. | Politzer, "The open back of the open-back banjo" |
| Air, resonator | A closed cavity that vents through the gap around the flange (a Helmholtz resonator). It splits the head's lowest mode into a pair and lowers it. | Woodhouse et al. 2021 |
| Coupled solve | M diagonal, so after M^-1/2 scaling the problem is a symmetric eigenproblem (Householder + QL). The bridge sits on the string axis with symmetric feet, so the problem splits exactly into symmetric (cos modes, heave, bending, air) and antisymmetric (sin modes, roll, sway) halves. About 0.15 s for 11", built off the audio thread. | — |
| Damping | Film loss, plus edge loss into the rim (less with a heavy tone ring), plus stuffing behind the head. Radiation damping is computed from each mode's own sources: point monopoles at the region centroids, so front/back and opposite-phase regions cancel at long wavelengths. | Bare-head loss factors (~0.02–0.03 low, ~1e-3 high) from Woodhouse et al. 2021 |
| Above ~6 kHz | Statistical modes continue the dense model's trend in conductance per bridge coordinate. Q is capped so neighbours overlap. | Woodhouse 2004 (statistical body) |
| Tone ring | Out-of-plane bending modes of a bell-bronze ring, driven one way by the head's edge force and radiating from the rim | Ring theory; the cross-sections are estimates |

Resulting bridge admittance (3rd string, bluegrass setup): about −27 dB re 1 m/Ns at 200 Hz, a principal formant peaking near −10 dB around 500–1000 Hz, a lateral hill near 3 kHz and a vertical hill near 5 kHz. Run `node test/pot_report.js` to print it.

## 2. The strings (`src/engine.js`)

- Five steel strings with the short 5th starting at its pip at the 5th fret. Sets: light, medium and medium-heavy, with a wound 4th. Tension follows the tuning.
- Each string is modal: two components per partial, one per polarization. Pitch comes from bending stiffness. Decay comes from Woodhouse's string losses plus what the string's own spot on the bridge drains: ds = −(T/L)·Y₂(ω). Partials that land on the formant drain in a fraction of a second.
- **Picks.** The pick model is Acoustic's cantilever, here for nickel-silver and brass fingerpicks and plastic or metal thumbpicks. Fingers pull the string up, the thumb pushes it down.
- **Clawhammer.** The back of the nail falls through the string toward the head. Part of the excitation is a pluck and part is momentum (a struck share started in sine phase, with a 1/k spectrum). The direction is mostly normal to the head.
- **String stretching.** The tension wobble from each string's own motion, and the longitudinal modes it drives, push down on the bridge over the break angle (Politzer 2014).
- **Left-hand legato.** Hammer-ons, pull-offs and fretted slides use Acoustic's legato and finger-friction models. Chokes are per-string bends.
- **Natural places.** Besides rooms there are forests, rock and a cave. *Deciduous forest*, *pine forest* and *winter woods in snow*: the ground reflects (leaf litter, needles and snow are porous and soak up treble), each trunk adds one scattered arrival (single-scattering cylinders after Kaneko & Gamper 2021, weak while ka < 1), and a statistical tail with T60 of roughly 1.1–2 s, mostly above 1 kHz (Albert et al. 2015 measured ~2 s in most forest stands and 1.2–3 s at the extremes; Yang et al. 2013 found tree scattering matters mainly above 1 kHz). *Slot canyon*, *canyon 40 m wide* and *mountain lake with a cliff across the water*: open sky, with image sources run long enough to keep the flutter and echoes. *Limestone cave*: a stone room with a long tail. *Open snowfield* is close to anechoic. Ground absorption values are typical published ranges, not site measurements.
- **Radiation.** The pot's modal velocities become volume velocity in five head regions, the rim, and the open back or resonator gap. Each region is a monopole, ρ/(4π)·dU/dt, reaching the mics at its own delay. Mics and rooms use Acoustic's image-source space (`src/space.js`) with banjo geometry. No measured banjo directivity is used.

## 3. The hands (`src/hand.js`)

- **Left hand.** Held notes become a banjo shape on the four long strings, judged on span, fingers, open strings, position, whether the root is in the bass, and distance from the last shape. Standard shapes come out on their own: G 0000, C 2012, D 0234, F 3213, Em 2002, D7 0214. The 5th string drones open unless "drone follows the chord" is on. Backup uses closed shapes up the neck.
- **Scruggs rolls**, eight eighths per bar: forward, backward, forward-reverse, alternating-thumb, Foggy Mountain, pinch-and-roll, pinches. The thumb takes the 3rd or 4th string, whichever carries the root. Notes played over a running roll become melody: the next finger that can reach that string plays it, accented.
- **Licks.** A thumb note on a fretted chord tone sometimes slides in from two frets below or hammers in. An open string sometimes hammers up two frets and pulls back off.
- **Clawhammer:** bum-ditty, double thumbing, drop thumb and frailing brushes. The nail strikes, the brush comes down across the top three or four strings, and the thumb catches the 5th.
- **Backup chop:** a pinch on 2 and 4, damped right away by easing the fretting fingers.
- **Free notes.** *Melodic* spreads consecutive notes across strings so they ring together, using the 5th string's g. *Single-string* stays in one position and alternates thumb and index. A note pressed while the last one is held becomes a hammer-on, pull-off or slide.
- **Timing.** A slow AR(1) drift of the whole hand plus note-to-note jitter, per-pluck level scatter, finger repetition limits, swing and bluegrass push. The magnitudes are the guitar measurements Acoustic uses; there are no comparable banjo measurements, so they are estimates.

## Controls

- MIDI: notes, sustain (holds the pattern), pitch bend (choke the last string up to a whole step), mod wheel (licks), clock (tempo).
- Computer keys: `A W S E D F T G Y H U J K O L P ;` play notes, `Z`/`X` change octave, `Space` holds, `1`–`0` are chord pads, `C` chokes.
- The picture: tap a string on the head to pick it, swipe across the strings to brush, tap the neck to fret a string, and tap the bare head to hear it (useful when setting tension).
- Record captures the exact output as a 48 kHz WAV.

## Calibration loop

`test/` renders through the same engine offline in Node and compares against real recordings. This is the same workflow as Acoustic:

```bash
node test/render.js note out.wav '{"s":2,"seconds":4}'                 # one string (0 = 5th ... 4 = 1st)
node test/render.js roll out.wav '{"style":"forward","bpm":120}'      # a roll over G C D G through the real hand
node test/render.js roll out.wav '{"style":"claw","preset":"openback"}'
node test/render.js tap out.wav                                        # the head alone
python3 test/analyze.py real_G3.wav out.wav --midi 55 --png compare.png   # per-partial level and T60, inharmonicity, centroid, LTAS
python3 test/spectrum.py out.wav 0.3 4                                  # peaks and octave-band balance
node test/pot_report.js                                                 # pot modes and bridge admittance per string
python3 test/browser_test.py http://localhost:8765/index.html shot.png take.wav   # run the page headless and record a take
```

Record a real banjo (one open string at a time, close mic, quiet room) or a take from the app, and compare. The parameters most worth fitting against a real banjo are: the DrumDial-to-tension mapping, the head and edge loss factors, the bridge's bending and sway frequencies, the air-loading coefficients and the tone-ring modes.

## Build

`src/` is the source. `node build.mjs` inlines it into the single-file `index.html` served by GitHub Pages.

## Sources

- Woodhouse, Politzer & Mansour (2021), "Acoustics of the banjo: measurements and sound synthesis," *Acta Acustica* 5, 15 (doi 10.1051/aacus/2021009), and "Acoustics of the banjo: theoretical and numerical modelling," *Acta Acustica* 5, 16 (doi 10.1051/aacus/2021008).
- Politzer, D. (2014), "Banjo timbre from string stretching and frequency modulation," arXiv:1406.4907; (2015) "The plucked string: an example of non-normal dynamics," *Am. J. Phys.* 83; (2016) "Banjo rim height and sound in the pot," arXiv:1608.04620; (2017) "Banjo drum physics — theoretical preliminaries," arXiv:1709.00574; (2018) "Banjo drum physics — sound experiments," arXiv:1806.08857; (2021) "Arithmetic of spring forces on the banjo bridge," arXiv:2104.06616; "The open back of the open-back banjo" (HDP 13-02).
- Stephey & Moore (2008), "Experimental investigation of an American five-string banjo," *JASA* 124, 3276.
- Dickey, J. (2003), "The structural dynamics of the American five-string banjo," *JASA* 114, 2958.
- Woodhouse, J. (2004), "On the synthesis of guitar plucks," *Acta Acustica* 90; Woodhouse et al. (2012), string damping, *Acta Acustica* 98.
- Albert, Swearingen, Perron & Carbee (2015), "Low frequency acoustic pulse propagation in temperate forests," *JASA* 138, 735; Kaneko & Gamper (2021), "A fast forest reverberator using single scattering cylinders," IEEE MMSP; Yang, Kang & Cheal (2013), "Quantifying scattered sound energy from a single tree by means of reverberation time," *JASA* 134.
- Allen & Berkley (1979), image method; Heijink & Meulenbroek (2002); Nézio Malta (2012). See Acoustic's README for the space and timing sources.
