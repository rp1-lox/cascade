# Waterfall Template Patterns — Curated From Battle-Tested Installs

Scope: content/authoring patterns (not rendering math — see `RenderingGroundTruth.md` /
`RenderPasses.md` for that). Source: live queries against this install's Waterfall server
(`GET /api/template?name=X`) against `EngineEditor/data/templates.tsv`, cross-referenced with
`usageCount` (how many installed engine `.cfg`s actually reference each template — the best
proxy for "battle-tested" we have). All EFFECTTEMPLATEs quoted below are **waterfall-native**
(bundled Waterfall, Nertea's `NearFuture*`/`KerbalAtomics`, Bluedog_DB `BDB_*`, RSMP/katniss,
`StockWaterfallEffects`/NCAP `stock-*`) — RealPlume is explicitly out of scope for this doc.

All colors are RGBA in the 0-1 range as stored in the `.cfg` (gamma space — see
`RenderPasses.md` Q2, no linearization). All curves are Waterfall `FloatCurve` key lists
`(time, value, inTangent, outTangent)`; the controller's `[0,1]`-normalized output is `time`.

---

## 1. Effect layering patterns

Every high-usage template is built from the **same handful of layer roles**, stacked as
independent `EFFECT` blocks under one `EFFECTTEMPLATE`, each with its own `MODIFIER`s. A
plume is never one mesh — it's 6-15 of these layered and independently curve-driven. Layer
roles seen repeatedly, in typical back-to-front (core-to-envelope) order:

| Role | Typical name(s) | Mesh | Shader | Purpose |
|---|---|---|---|---|
| **Core** | `Core`, `Core1`, `core`, `flame` | `fx-cylinder` (very short/thin), `fx-simple-plume-1` | `Additive (Dynamic)` | Tight, bright, near-nozzle hot spot |
| **Main plume body** | `plume`, `plume1`, `plume2`, `MainPlume(Dyn)` | `fx-cylinder` (long) | `Additive (Dynamic)` | The dominant visible cone; usually 2+ nested copies at different scale/color for a hot-inner/cool-outer look |
| **Cold/vac envelope** | `redVacEffect`, `blueVacEffect`, `vac`, `plume-vac` | `fx-cylinder`, larger radius | `Additive (Dynamic)` | Faint, wide, only visible once `atmosphereDepth`→0 (vacuum bloom) |
| **Shock diamonds** | `shock1/2/3`, `shockMain`, `shock01` | `fx-cylinder` stack at increasing Z offset, or `fx-simple-shock-1` (dedicated diamond mesh) | `Additive (Dynamic)` / `Additive` | 2-4 short segments positioned along the plume axis (`POSITIONMODIFIER` on Z), only bright at mid-throttle **and** partial atmosphere — the classic over/under-expanded diamond look |
| **Wisp/tail** | `wisp`, `EndFlame`, `EndFlame2`, `plume_end` | `fx-cylinder`, long, low brightness | `Additive (Dynamic)` | Very faint outer tail extending past the main cone, brightness usually `<0.3` |
| **Film cooling / smoke** | `film` | `fx-cylinder` | **`Alpha (Dynamic)`** (only alpha-blended layer in most templates) | Dark, low-alpha soot/kerosene-film-cooling streak (kerolox/BDB F-1 pattern) |
| **Inner glow / nozzle throat** | `innerGlow`, `core2` | `fx-complex-plume-1` / `fx-simple-plume-1` (multi-submesh: `CylinderMesh` + `PlaneMesh` + bone-driven `B_Tail`/`B_Throat`/`B_Exit`/`B_PostExit1`) | `Additive Directional` (both submeshes) | A dedicated 2-material bone-rigged mesh that hugs the nozzle interior; the `PlaneMesh` submesh is a flat "hot metal" glow disc, the `CylinderMesh` is the throat cone |
| **Distortion / heat shimmer** | `distort` | `fx-cylinder`, wide | `Distortion (Dynamic)` | Present in almost every high-usage template; strength kept tiny (`_Strength` 0.01-0.1 at throttle) |
| **Engine light** | `engineLight`, `throttleLight` | `fx-point-light` | n/a (Unity `Light`) | Point light co-located with the plume, `LIGHTFLOATMODIFIER`/`LIGHTCOLORMODIFIER` driven the same way as material floats |
| **Nozzle metal glow** | standalone templates: `waterfall-nozzle-glow-{orange,blue,white,yellow}-1`, `BDB_CryoGlow`, `BDB_SRMGlow` | `fx-cylinder`, tiny, at nozzle exit only | `Additive (Dynamic)` | Single-effect templates meant to be **stacked onto** a plume template, not used alone — see §3 |

**Concrete example — `waterfall-kerolox-lower-4`** (Waterfall bundled, usageCount 10) has
13 `EFFECT`s: `redVacEffect`, `blueVacEffect`, `redMidEffect`, `plume`, `wisp`, `shock1`,
`shock2`, `shock3`, `throttleFX`, `EndFlame`, `EndFlame2`, `innerGlow`, `distort`,
`engineLight` — i.e. **3 concentric main-body copies at different tint/scale**, a 3-segment
shock stack, 2 tail/wisp fades, one bone-rigged throat glow, one distortion cone, one light.
This 13-effect structure (or a close variant) recurs almost verbatim across
`waterfall-kerolox-upper-3`, `BDB_F1`, `BDB_F1_film` (same author lineage, same effect names)
— i.e. it is *the* reference kerolox skeleton to offer as a starter.

**Nested-cone technique**: nearly every main-body layer is actually **2-3 duplicate
`fx-cylinder` meshes at slightly different `scaleOffset`, each with its own tint**, not one
mesh with a gradient. E.g. `waterfall-hydrolox-lower-4`'s `MainPlumeDyn` effect appears
**twice** back to back at the same transform (scale `0.75,4,0.75`): once tinted red-orange
(`_StartTint=0.78,0.20,0.20,0` → `0.78,0.20,0.10,1`) at `Brightness` throttle-curve peak `5`,
once tinted blue (`_StartTint=0.20,0.39,0.51,1` → `0.20,0.20,1,1`) at throttle-curve peak
`0.2` — the red layer dominates near the nozzle (hot core), the blue layer only becomes
visible where/when the red layer's brightness drops, producing a red→blue core-to-envelope
gradient **through** additive layering rather than a single shader gradient.

---

## 2. Controller usage: throttle vs. atmosphereDepth vs. random

Every `FLOATMODIFIER`/`COLORMODIFIER`/`SCALEMODIFIER`/`POSITIONMODIFIER` declares a
`controllerName` (`ctrl=` in the notes below) and a `combinationType` (`REPLACE` or
`MULTIPLY`, occasionally `SUBTRACT`). The near-universal pattern in every high-usage
template:

- **One `REPLACE` modifier per property, driven by `throttle`** — sets the baseline value as
  a function of throttle (0-1).
- **One `MULTIPLY` modifier on the *same* property, driven by `atmosphereDepth`** — scales
  that baseline by atmosphere (`atmosphereDepth` is 1 at sea level, 0 in vacuum per Waterfall
  convention — confirmed by every `_Falloff`/`_Noise` curve below being *higher* at key
  `time=0` and *lower* at `time=1`, i.e. "tight/turbulent at sea level, smooth/spread in
  vacuum").
- **A third, smaller `MULTIPLY` modifier driven by `random`** on brightness/expand/position —
  adds ±10-20% per-frame jitter for a "living flame" flicker, never a REPLACE (randomness is
  always multiplicative noise on top of the throttle/atmo baseline, not a driver of shape).

This throttle-then-atmosphere-then-random layering (in `combinationType` terms:
`REPLACE(throttle) × MULTIPLY(atmosphereDepth) × MULTIPLY(random)`) is the single most
consistent authoring convention across every mod studied.

### Throttle curves (sea-level "punchy" vs. vacuum-relative shape)

Real multi-key curve from `waterfall-kerolox-lower-4`, `plume` effect, `brightnessThrottle`
(`ctrl=throttle`, floatName=`_Brightness`):

```
(0, 0) → (0.01, 0.1) → (0.1, 0.5) → (1, 2)
```

i.e. **not linear** — brightness is clamped near-zero below 1% throttle (engine "off" reads
as truly dark, not just dim), jumps fast through the first 10% (an near-instant "catching
fire" visual as soon as thrust starts), then ramps the rest of the way to a peak of `2×` at
full throttle. The `blueVacEffect` in the same template goes further —
`(0,0) → (0.01,1) → (0.3,1) → (1,2)`: the blue (cold/under-expanded) layer snaps to nearly
full brightness within the first 1% of throttle and *plateaus*, only climbing further above
30% — i.e. the vacuum-look layer is "on or off", not gradual, which is what makes low-throttle
RCS-style burns look flame-y rather than washed out.

### AtmosphereDepth curves (sea-level → vacuum silhouette change)

Same template, `plume` effect, `atmoFalloff` (`ctrl=atmosphereDepth`, floatName=`_Falloff`,
`combine=REPLACE`):

```
(0, 70) → (0.2, 30) → (0.7, 10) → (1, 3)
```

`_Falloff` controls edge sharpness/taper (see §4); **high falloff at sea level (atm=0... wait,
convention check: key `time` here is the *controller's normalized output*, and Waterfall's
`AtmosphereDensityController` reports 1.0 at sea level / 0.0 in vacuum — so `time=0` in these
curves is actually *vacuum*, `time=1` is *sea level*.** Re-reading with that convention:
`_Falloff` is **70 in vacuum, 3 at sea level** — i.e. the plume edge is *very* soft/diffuse in
vacuum (a barely-bounded haze) and *sharp/contained* at sea level (a crisp, needle-like
core), which matches the classic over-expanded-vacuum-plume look. Similarly `noiseAtmo`
(`0,8 → 1,35`) — turbulence/noise is low in vacuum, high at sea level (shock-diamond
turbulence only reads at sea level, consistent with §1's shock-diamond layer being
brightest at mid-throttle *and* partial atmosphere). `brightnessAtmo` on the `redMidEffect`
layer: `(0,0) → (0.2,2) → (0.3,8) → (0.5,12) → (0.7,1) → (1,0)` — a **sharp mid-atmosphere
brightness spike** (peaking around 30-50% atmospheric density) then collapsing to zero at
both true vacuum and true sea level — this is the layer responsible for the "green/red flash"
visible during ascent through the upper atmosphere on real kerolox boosters.

**Practical takeaway for starter defaults**: don't author a single `_Falloff`/`_Brightness`
value — author a 3-5 key `atmosphereDepth` curve that's high at `time≈0.3-0.5` (mid-atmosphere)
and tapers at both ends, plus a `throttle` curve with an early near-zero dead zone
(`0→0.01: 0→0.1`) so idle/low throttle doesn't look "half-lit."

### Scale/expand curves

`SCALEMODIFIER scaleAtmo` (kerolox lower-4, `redVacEffect`): `yCurve = (1,1)→(1,2)` in the
abbreviated form (single key shown per axis in some templates; multi-key when the mod author
wants a shaped vacuum bloom) — Y-scale (length along thrust axis) roughly doubles from sea
level to vacuum, i.e. **vacuum plumes are authored ~2× longer**, not just brighter/fainter.
`_ExpandBounded`/`_ExpandLinear` (the shader-side radial-growth parameters, not mesh scale)
are the finer-grained version of the same idea — see the `aExpandBound`/`aExpBounded` curves
throughout §1's `plume`/`vac_plume_blue` effects, typically ramping radial expansion up 2-6×
between sea level and vacuum.

### `random` controller usage

Always `MULTIPLY`, always small: `waterfall-kerolox-lower-4`'s `randBound` modifiers use
`(0,0.9)→(1,1.1)` (±10% jitter), `engineLight`'s `rBright` uses `(1,1.2)` (single-key, i.e. a
constant 1.2× multiply — some templates use `random` as a static "always slightly brighter
than baseline" multiplier rather than true per-frame jitter; check whether the installed
Waterfall's `RandomnessController` re-samples every frame or every N seconds before assuming
motion). `POSITIONMODIFIER randPos`/`posRandom` on shock-segment Z position use the same
±10-20% pattern to keep diamond spacing from looking perfectly regular.

---

## 3. Per-propellant visual conventions

Colors below are `_StartTint` → `_EndTint` (RGBA, gamma space) for the **dominant main-plume
layer** of each representative template, plus brightness-curve peak where notable.

| Propellant | Signature | Representative templates | `_StartTint` → `_EndTint` |
|---|---|---|---|
| **Kerolox** | Warm orange core, red-brown envelope; visible, "solid-looking" flame even in vacuum | `waterfall-kerolox-lower-4`/`-upper-3` (`plume`), `BDB_F1`, `stock-kerolox-generator` | `(1, 0.58, 0.39, 1)` → `(0.92, 0.51, 0.10, 1)` — orange→amber. Core layer (`redVacEffect`) is darker/redder: `(0.81,0.50,0.34)`→`(0.55,0.23,0.21)`. `stock-kerolox-generator`'s `flame`: `(1,0.85,0.48)`→`(1,0.39,0)`, brightness peak `1.35×`. |
| **Hydrolox** | Near-invisible blue-white; low overall brightness (peaks 0.1-1.0× vs kerolox's 2-5×); relies on shock diamonds + distortion for visibility | `waterfall-hydrolox-lower-4`, `-upper-1`, `-rs25-{1,2}` | `MainPlumeDyn` "blue" pass: `(0.20,0.39,0.51,1)`→`(0.20,0.20,1,1)`, throttle-brightness peak only `0.2×` (vs. the paired red/orange pass peaking `5×`). `plume2`: `(0.23,0.51,0.65)`→`(0.51,0.73,0.91)` pale sky-blue. Shock diamonds: `(0.38,0.51,1,1)`→`(0.24,0.33,1,0.1)` (note alpha fade on the end tint). |
| **Methalox** | Distinct **purple/violet/magenta** cast, not a orange/blue blend — this is Waterfall's own stylistic signature for CH4, seen consistently across BE-4 and Raptor-style templates | `waterfall-methalox-upper-1`, `-lower-BE4-1`, `-lower-raptor-1` | `plume2`: `(0.74,0.41,1,1)`→`(0.55,0.13,0.43,1)` — bright violet to deep magenta. `plume2-2`: `(0.23,0.22,0.54)`→`(0.64,0.27,0.22)`. `MainPlume` core: `(0.95,0.39,0.09)`→`(1,1,1)` (white-hot core, same as kerolox — the purple is carried by the *outer* plume layers, not the core). |
| **Hypergolic** | Reddish-pink core fading to pale blue/white envelope (NTO/UDMH "toxic pink" look), or deep orange-red-brown for storable oxidizer variants | `waterfall-hypergolic-white-upper-1` (usage 42, top hypergolic template), `-aerozine50-upper-1` (usage 20), `-UDMH-NTO-upper-1` (usage 16) | white-upper `plume1`: `(0.93,0.58,0.58,1)`→`(0.60,0.84,0.97,1)` pink→pale-blue. UDMH-NTO `plume1`: `(0.87,0.32,0.05)`→`(0.89,0.46,0.05)` deep orange-red (visually closer to kerolox but darker/more saturated). `coreBlue` layer common to both: `(0.84,0.51,0.93)`→`(0.38,0.57,0.81)` violet-blue — hypergolics get a distinct violet core tint not seen on kerolox. |
| **Solid (SRB)** | Bright orange-white core, heavy tan/beige smoke trail, sparkout/burnout FX at end of burn | `srb-waterfall` (usage 106, top solid template), `lemon-SRB-core` (90), `lemon-srb-sep` (63), `BDB_SRM_upper` (26) | `srb-waterfall` `mainPlume`: `(0.91,0.79,0.61,1)`→`(0.59,0.45,0.31,1)` tan smoke. `plumeGlow` (core): `(0.95,0.05,0.05,0)`→`(0.81,0.78,0.69,1)` — starts near-transparent red, ends opaque near-white (hot flash). `sparkout`/`sparkout2` (burnout spark shower): `(0.87,0.80,0.57)`→`(0.91,0.33,0.11)`. `BDB_SRM_upper` `plumeOuter`: `(0.95,0.92,0.86)`→`(0.93,0.48,0.09)` white-to-orange. |
| **Ion / electric** | Saturated blue-violet-cyan, small/tight geometry, often multiple concentric rings (`centerSource`/`ringSource`/`ringFlame`) rather than a cone | `template-nfp-ion-gridded-xenon-1`, `stock-xenon-ion`, `waterfall-ion-xenon-1` | `griddedPlume1`: `(0.19,0.59,0.88)`→`(0,0.40,1)` sky-blue→pure blue. `stock-xenon-ion` `centerSource`: `(0.84,0.70,1)`→`(0.55,0.86,1)` lavender-white→cyan; `ringSource`: `(0.43,0,1)`→`(0.06,0.44,1)` deep violet→blue. |
| **NTR (nuclear thermal)** | Pale blue-violet plume (near-hydrolox, since LH2 propellant) *plus* a distinct pink/magenta **Cherenkov glow** layer unique to this category | `waterfall-ka-ntr-lh2-1`, `BDB_nuclear_vac`, `stock-nuclear-upper-2` | `plume-core`: `(0.79,0.60,0.92)`→`(1,0.20,1)` lilac→magenta. `plume-vac`: `(0.29,0.54,0.91)`→`(0.60,0.44,0.63)`. `cherenkov` (BDB): `(0.45,0.49,0.95)`→`(0.41,0.25,0.73)` blue-violet, low-alpha, additive — the diagnostic "reactor glow" layer to include whenever the mission calls for an NTR starter. `coreArea`: `(0.43-0.71, 0.07, 0.07)`→`(0.79-0.91, 0.25, 0.09-0.73)` dark red core fading into pink/orange. |

**Generic nozzle-metal-glow overlays** (propellant-agnostic, meant to be layered onto any of
the above, not used standalone): `waterfall-nozzle-glow-orange-1` `(0.99,0.49,0.02)→(0.54,0.53,1)`,
`-blue-1` `(0.42,0.65,0.87)→(0.93,0.96,0.97)`, `BDB_CryoGlow` (cyrogenic-tank-adjacent nozzle
chill) `(0.32,0.45,0.80)→(0.93,0.96,0.97)`, `BDB_SRMGlow` near-white `(1,0.99,0.87)→(1,1,0.97)`.
All four share the exact same mesh/scale/position (`fx-cylinder` at `pos=0,0,-0.585`,
`scale=0.6,0.6,0.6`) and a single `glow` `FLOATMODIFIER` (`ctrl=throttle`,
`floatCurve=(1,2)` or `(0.7,1)`) — this is Waterfall's own minimal "add a hot-metal ring to
any nozzle" pattern; worth exposing as a one-click add-on independent of the main plume
template.

---

## 4. Material param sweet-spots (cross-ref `WaterfallShaders.cfg`)

Aggregated ranges actually observed across the templates studied (not the shader's declared
min/max, but what good authors actually dial in):

| Param | Typical sea-level (`atm→1`) | Typical vacuum (`atm→0`) | Notes |
|---|---|---|---|
| `_Falloff` | 1-5 (sharp/contained) | 15-70 (soft/diffuse) | Single biggest lever for the sea-level-vs-vacuum silhouette change; author as a 3-5 key `atmosphereDepth` curve, not a constant |
| `_Fresnel` | 0.5-2 | 1.8-7 | Rim-brightening; hydrolox templates push this highest (up to 7 on `waterfall-hydrolox-upper-1`) since the plume body itself is nearly invisible and needs edge glow to read at all |
| `_Noise` | 15-35 | 2-8 | Turbulence texture scroll intensity; consistently *higher* at sea level (denser atmosphere = visible turbulent mixing) |
| `_TintFalloff` | ~0.5 (near-constant across templates) | 0.5 | One of the few params authors *don't* bother curving — usually a flat `0.5` |
| `_Brightness` (main body) | kerolox/methalox 1-2×, up to 5× on secondary "hot flash" layers | 0.1-0.5× on the same layers (paired with a *separate* faint vacuum-only layer going the other way) | Never a single global brightness — always split across 2-3 layers with opposing throttle/atmo curves so total output stays readable at every altitude |
| `_ExpandLinear` / `_ExpandBounded` | 0-1 | 1-6 | Radial growth; vacuum values 2-6× sea-level |
| `_Strength` (Distortion shader) | ~0.1 at full throttle | scaled by `atmosphereDepth` MULTIPLY, same curve shape as brightness | Kept deliberately tiny (`0.01-0.1`) — distortion is a subtle accent in every template studied, never a dominant effect (consistent with `RenderPasses.md`'s finding that `Distort Dynamic` warps, doesn't add light) |

---

## 5. Startup / ignition effects

**Correction after a second, wider pass:** an initial grep for the literal node name
`ENGINEEVENTCONTROLLER` across `GameData` returned nothing, which is what the templates
catalogued in `templates.tsv` (EFFECTTEMPLATE files) confirm — **none of the
EFFECTTEMPLATEs studied in §1-4 use it.** But a follow-up grep for the broader key
`eventName` (the controller can also be declared as `CONTROLLER { linkedTo = engineEvent }`,
not only as a dedicated `ENGINEEVENTCONTROLLER {}` node) found **~95 files**, almost all
under `GameData/Avalanche/Configs/**` — the Avalanche compatibility pack, which patches
`eventName = ignition` / `eventName = flameout` controllers directly into individual engine
part `.cfg`s (not into reusable EFFECTTEMPLATEs), overwhelmingly on **solid separation
motors, retro-rockets, and ullage motors** (`Boostersep.cfg`, `AJ260_Sepatron.cfg`,
`Titan_III_Separator.cfg`, `Saturn_V_SII_Ullage.cfg`, etc.) rather than primary/sustainer
engines. Two concrete real patterns found:

**One-shot ignition burn** (`GameData/Avalanche/Configs/ACK/Boostersep.cfg`):
```
CONTROLLER
{
  name = firing
  linkedTo = engineEvent
  eventName = ignition
  eventDuration = 9.02
  eventCurve { key = 0 0   key = 9.02 1 }
}
```
A simple linear 0→1 ramp over the motor's full 9-second burn, triggered once at ignition —
used to drive a `RetroRocket` plume template's overall visibility/intensity for a motor that
fires exactly once and is done (sepratrons, retro-rockets). This is the "the whole effect is
gated by the ignition event" pattern, distinct from a brief flash.

**Burnout tail-off** (`GameData/Avalanche/Configs/Bluedog_Design_Bureau/Castor_2.cfg`):
```
ENGINEEVENTCONTROLLER
{
  eventName = flameout
  eventDuration = 60
  name = Burnout
  eventCurve
  {
    key = 0 0 0 0
    key = 0.01 0.01 0 0
    key = 10 1.5 0 0
    key = 30 1.5 0 0
    key = 60 0 0 0
  }
}
```
Note the curve's `time` axis here is **seconds since flameout** (not normalized 0-1 — this
controller's output domain is the raw `eventDuration` window), spiking to `1.5` by 10s,
holding until 30s, then decaying to `0` by 60s — i.e. a **smoke/afterglow effect that peaks
several seconds *after* the engine cuts off** and fades over a full minute, layered onto
`BDB_SRM_upper`'s burnout look. This is a materially different, and better, technique than
the throttle-curve hack described below for anything that needs to persist *after* the
engine has already gone to zero throttle (a throttle-driven curve can't do this — throttle is
already 0 by the time burnout smoke should still be visible).

**Net finding for the mission's original question**: the primary chemical-engine
EFFECTTEMPLATEs (Waterfall bundled, Nertea, BDB's main-engine templates, RSMP, stock-effects)
studied in §1-4 do **not** use `EngineEventController` for their startup flash — see the
throttle-curve technique below, which remains the dominant approach for *sustainer* engines.
`EngineEventController` **is** real, shipped, and actively used in this install, but
specifically by one third-party compatibility pack (Avalanche) for **one-shot solid motors**
(separation, retro, ullage) where "ignition" and "burnout" are the entire lifecycle rather
than a transient at the start/end of a long throttleable burn. Source confirmation
(`Source/Waterfall/EffectControllers/EngineEventController.cs:25-28`):

```csharp
// EngineEventController.cs:25-28
private static readonly Dictionary<string, Func<ModuleEngines, bool>> EngineStateFuncs = new()
{
  { "flameout", (engineModule) => engineModule.flameout || !engineModule.EngineIgnited},
  { "ignition", (engineModule) => engineModule.EngineIgnited}
};
```

It takes `eventName` (`"ignition"` or `"flameout"`), an `engineID`, an `eventCurve`
(evaluated over a `[0, eventDuration]` window after the transition fires, in **seconds**, not
normalized 0-1 — see the Castor_2 example above), and drives a one-shot spike-then-decay
independent of the throttle level. It is real, shipped, and actively used by the Avalanche
pack for one-shot solid motors (see above) — but is **not** used by any main-engine
EFFECTTEMPLATE studied in §1-4. Worth flagging to the editor's "guidance" feature as: use
`EngineEventController` when authoring a starter for a **one-shot solid** (separation/retro/
ullage motor, or SRB burnout smoke that must persist after throttle hits 0); use the
throttle-curve technique below for a **throttleable sustainer/booster** engine's ignition
flash, matching what every high-usage sustainer template in this install actually does.

### What sustainer-engine authors actually do instead: throttle-curve engineering

Every "startup-looking" flash in this install is achieved by shaping the **throttle** curve
of an existing brightness/expand modifier to spike hard in the first 1-10% of throttle, then
settle — i.e. simulating an ignition transient by exploiting the fact that real engines pass
through low throttle on the way to 100% at T-0. Concrete examples, all `ctrl=throttle`,
`combine=REPLACE`:

- `waterfall-kerolox-lower-4` `blueVacEffect.brightnessThrottle`:
  `(0,0)→(0.01,1)→(0.3,1)→(1,2)` — snaps to near-full brightness within the first 1% of
  throttle and *holds*, only climbing further past 30%. This reads as a bright flash the
  instant the engine lights, well before the plume reaches full length/brightness.
- `waterfall-kerolox-lower-4` `plume.brightnessThrottle`:
  `(0,0)→(0.01,0.1)→(0.1,0.5)→(1,2)` — a slower catch, avoiding a flash on *this* layer so
  the "flash" reads as coming from one specific sub-effect (the blue vac layer), not the
  whole plume uniformly brightening — **layering the flash onto one sub-effect while the
  others ramp normally is the actual authored technique for a believable ignition look**.
- `waterfall-kerolox-lower-4` `engineLight.tBright` (the point light):
  `(0,0)→(0.01,0.1)→(1,2)` — same early-spike shape applied to the light intensity too, so
  the light and the plume flash are consistent.
- `srb-waterfall`'s `plumeGlow` core layer has its **color alpha itself animate**:
  `_StartTint=(0.95,0.05,0.05,0)` (alpha 0 — invisible red) →
  `_EndTint=(0.81,0.78,0.69,1)` (alpha 1, near-white) — combined with a throttle curve this
  produces a "catches fire and flashes white-hot" look purely from color-alpha animation, no
  brightness modifier needed.

### Burnout / flameout (the mirror case)

Templates authored for **solid-rocket burnout** (not covered by any `flameout` controller
either) use dedicated low-thrust-tail `EFFECT`s that are always-on but tuned to only be
visually significant once the main plume's brightness has collapsed:
`srb-waterfall`'s `sparkout`, `sparkout2`, `trickleout`, `Fireball`, `smokeout`, `smokeout2`
— six separate small effects, each with steep-onset color-alpha curves like `trickleout`'s
`_StartTint=(0.97,0.87,0.73, 0.0019)` (near-zero alpha baseline) →
`_EndTint=(0.99,0.40,0.11,1)` (opaque orange), meant to become visible only in the throttle
tail-off. `Avalanche`'s dedicated `Burnout`/`BurnoutFireball`/`BurnoutPlume` templates (not
deep-dived here, usageCount 0 in this install — no engine currently references them, so
treat as unverified/example-only) follow the same naming convention and are worth a follow-up
look if a burnout-specific starter is wanted later.

### Candidate templates for a follow-up ignition-effects task

Ranked by how much ignition-relevant curve shaping they contain (all verified to resolve via
`/api/template` in this install):

1. **`waterfall-kerolox-lower-4`** (usage 10) — clearest layered-flash technique (see above),
   also the reference kerolox skeleton from §1. Best single template to prototype an
   `EngineEventController`-based replacement against, since its current throttle-curve hack
   is fully documented above as a baseline to compare against.
2. **`BDB_F1`** / **`BDB_F1_film`** (usage 0/1) — same author lineage as #1 (near-identical
   structure, minor film-cooling-layer variant), good second data point.
3. **`srb-waterfall`** (usage 106, the single most-referenced template in this install) —
   alpha-animated ignition flash + a full 6-effect burnout sequence; best candidate for
   testing a *solid-motor*-specific ignition/burnout controller pair.
4. **`BDB_RS68_ablative`** (usage 2) — RS-68-style ablative-nozzle engine; distinct
   `shock01` startup shock geometry (`fx-simple-shock-1` with `topPos`/`bottomPos` bone
   modifiers) not seen on the pure-`fx-cylinder` shock stacks elsewhere — worth checking if
   its startup look differs from the generic pattern once dived into further.
5. **`GameData/Avalanche/Configs/Bluedog_Design_Bureau/Castor_2.cfg`** — not a catalogued
   EFFECTTEMPLATE (a direct part-level `EFFECT`/`CONTROLLER` patch, so it won't show up in
   `templates.tsv` or resolve via `/api/template`), but the clearest **real, working**
   `ENGINEEVENTCONTROLLER` example in this install (`flameout` → 60s decaying burnout-smoke
   curve, quoted in full above) — reference this file directly, not the templates API, when
   prototyping event-controller support.
6. **`GameData/Avalanche/Configs/ACK/Boostersep.cfg`** — the one-shot `ignition`-linked
   `CONTROLLER { linkedTo = engineEvent }` pattern for separation/retro motors, also quoted
   above. Same caveat: direct part patch, not an EFFECTTEMPLATE.
