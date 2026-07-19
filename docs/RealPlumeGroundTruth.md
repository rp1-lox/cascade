# RealPlume Ground Truth: Config Structure, Particle Model, and a Rendering Plan

Status: primary-source research, mirroring `docs/RenderingGroundTruth.md` / `docs/RenderPasses.md`
in depth and citation style. Goal: let `EngineEditor` catalog/edit RealPlume plumes and plan a
WebGL render path alongside Waterfall.

Sources actually read for this doc:

- Local install, read in full or in relevant part:
  - `GameData/RealPlume/000_Generic_Plumes/000_zRealPlume.cfg` (defaulting patch)
  - `GameData/RealPlume/000_Generic_Plumes/000_EFFECTS_Remover.cfg` (stock-FX cleanup patch)
  - `GameData/RealPlume/000_Generic_Plumes/Kerolox_LowerAlt.cfg` (full generic-template patch, read end to end)
  - `GameData/RealPlume/000_Generic_Plumes/*.cfg` directory listing (67 templates — enumerated in Q4)
  - `GameData/RealPlume/GlobalSettings.cfg` (`@SmokeScreen:FINAL` — `atmDensityExp` per solar-system scale)
  - `GameData/SmokeScreen/SmokeScreen.cfg` (plugin-wide `maximumActiveParticles`, `atmDensityMult`)
  - `GameData/RealPlume-Stock/RealPlume-Stock.version` (identifies this as the `KSP-RO/RealPlume-StockConfigs` release, v4.0.6)
  - `GameData/Bluedog_DB/Compatibility/RealPlumes/BDB_Saturn_AJ260_solids.cfg` (full applied
    example, read end to end — this is the actual patch giving `bluedog_Saturn_AJ260*` its plume)
  - `GameData/Bluedog_DB/Parts/Saturn/bluedog_Saturn_AJ260.cfg` (confirms base part has no PLUME/EFFECTS of its own — RealPlume patch supplies everything)
  - `EngineEditor/indexer/parse_cache.py` (confirms the indexer already reads
    `GameData/ModuleManager.ConfigCache`, i.e. **fully MM-patched** output — RealPlume's generated
    `EFFECTS{MODEL_MULTI_SHURIKEN_PERSIST{...}}` blocks are already visible there, same as Waterfall's)
  - `EngineEditor/web/plume.js` (current Waterfall renderer, scanned for reusable primitives)
- Web (`sarbian/SmokeScreen` on GitHub, fetched live):
  - `ModelMultiShurikenPersistFX.cs` — the effect-module field list
  - `MultiInputCurve.cs` — the multi-input curve evaluator

---

## Q1 — Config structure: `PLUME[template]` application, template definition, `processed` flag, MM patch chain

RealPlume is a three-package pipeline, and the naming is a common source of confusion:

- **`RealPlume`** (`GameData/RealPlume/`) — the *engine*: `000_Generic_Plumes/` holds the reusable
  `PLUME` **template library** (67 `.cfg` files, one plume "look" each) plus two bootstrap patches
  that apply to *any* part carrying a `PLUME` block, regardless of mod.
- **`RealPlume-Stock`** (`GameData/RealPlume-Stock/`, on disk from the `RealPlume-StockConfigs`
  GitHub repo — confirmed by `.version`) — **per-mod compatibility patches** that attach a
  `PLUME` block (referencing a template by name) to specific parts, organized in one subfolder per
  supported mod (`Squad`, `CryoEngines`, `KWRocketryRedux`, `Bluedog_DB` is *not* here — BDB ships
  its own compatibility patch instead, see below).
- **`SmokeScreen`** — the plugin DLL. It has no plume knowledge; it only implements the
  `EFFECTS`-sub-node types (`MODEL_MULTI_SHURIKEN_PERSIST`, `AUDIO`, etc.) that RealPlume's MM
  patches ultimately generate.

### Step 1 — a mod's own patch attaches a `PLUME` block to the part

`GameData/Bluedog_DB/Compatibility/RealPlumes/BDB_Saturn_AJ260_solids.cfg` (read in full) is BDB's
own equivalent of a `RealPlume-Stock` entry:

```
@PART[bluedog_Saturn_AJ260_Radial]:NEEDS[RealPlume,SmokeScreen,!RealismOverhaul]//dep
{
    @MODULE[ModuleEngines*] { @name = ModuleEnginesFX  %powerEffectName = Solid-Lower }
    PLUME
    {
      name = Solid-Lower
      transformName = thrustTransform
      localRotation = 0,0,0
      localPosition = 0,0,0
      plumePosition = 0,0,0.8
      flarePosition = 0,0,0.7
      fixedScale = 3
      energy = 2
      speed = 2
    }
}
```

Key points visible here:
- `name` inside `PLUME` is **the template selector** — it must match a top-level node name in one
  of the `000_Generic_Plumes/*.cfg` files (`Solid-Lower.cfg` here).
- The rest of the block (`transformName`, per-sub-effect `*Position`, `fixedScale`, `energy`,
  `speed`, …) are **override parameters** the template will substitute in via MM's `#$...$`
  value-reference syntax (see Step 2). Anything omitted falls back to the defaulting patch (Step 0).
- `ModuleEngines*` is renamed to `ModuleEnginesFX` and given `powerEffectName` — this is what tells
  stock KSP's effects system which `EFFECTS` node name corresponds to the running/throttle-driven
  effect (the vanilla `ModuleEngines`→`EFFECTS` wiring RealPlume rides on top of; unrelated to
  RealPlume itself, and worth noting because it means a `PLUME` name and the `%powerEffectName`
  string **must match** for the plume to actually play).
- `bluedog_Saturn_AJ260.cfg` (base part) confirmed to have **no** `PLUME` or `EFFECTS` node of its
  own — the entire visual is patch-supplied, which is exactly why parts using RealPlume "look
  empty" to a reader of the base cfg alone and why the editor must resolve the *patched* config
  (see the `parse_cache.py` note below).

### Step 0 — the defaulting patch (runs on every `PLUME`, any mod)

`000_zRealPlume.cfg`:
```
@PART[*]:HAS[@PLUME[*]]:FOR[zRealPlume]:NEEDS[SmokeScreen]
{
    @description ^= :$: Plume configured by RealPlume.:
    @PLUME,*
    {
        &transformName = thrustTransform
        &localRotation = 0,0,0
        &localPosition = 0,0,0
        &fixedScale = 1
        &energy = 1
        &emissionMult = 0.5
        &saturationMult = 1
        &alphaMult = 1
        &speed = 1
        &blazeScale = #$fixedScale$
        ... (13 more "&<subeffect>Scale = #$fixedScale$" fallbacks)
        &blazePosition = #$localPosition$
        ... (13 more "&<subeffect>Position = #$localPosition$" fallbacks)
        &plumeIdentifier = #$name$
    }
}
```
`&key = value` in MM syntax means "set only if missing" — this runs at pass `FOR[zRealPlume]`
(early), *before* any template patch, and fills every `PLUME` node on every part with defaults for
~15 named sub-effect slots (`blaze`, `core`, `exhaust`, `flare`, `fume`, `lamp`, `plume`, `plume2`,
`plume3`, `smoke`, `shock`, `shockcone`, `slag`, `stream`) so a template can freely reference
e.g. `#$/PLUME[X]/flarePosition$` even if the applying mod's patch never set it — it silently
inherits `localPosition`. `plumeIdentifier` defaults to the `PLUME` node's own `name` (i.e. the
template name) unless the applying patch overrides it — this is what makes the generated
`EFFECTS`/`AUDIO` node names unique when the *same* template is applied to many different parts.

### Step 2 — the template patch (`000_Generic_Plumes/<Template>.cfg`) builds the actual `EFFECTS`

`Kerolox_LowerAlt.cfg` (read in full) is representative of every generic-plume file:

```
@PART[*]:HAS[@PLUME[Kerolox_LowerAlt]:HAS[~processed[*]]]:AFTER[zRealPlume]:NEEDS[SmokeScreen]
{
    %EFFECTS
    {
        %Kerolox_LowerAlt
        {
          plumeIdentifier = #$/PLUME[Kerolox_LowerAlt]:HAS[~processed[*]]/plumeIdentifier$
          MODEL_MULTI_SHURIKEN_PERSIST { ... flare sub-effect ... }
          MODEL_MULTI_SHURIKEN_PERSIST { ... plume sub-effect ... }
          MODEL_MULTI_SHURIKEN_PERSIST { ... plume2 (red) sub-effect ... }
          MODEL_MULTI_SHURIKEN_PERSIST { ... plume3 (blue) sub-effect ... }
          MODEL_MULTI_SHURIKEN_PERSIST { ... blaze sub-effect ... }
          MODEL_MULTI_SHURIKEN_PERSIST { ... flame sub-effect ... }
          AUDIO { ... looping engine sound, volume keyed on plumeScale ... }
        }
        &engage    { AUDIO { clip = .../sound_liq10 ... } }
        &disengage { AUDIO { clip = sound_vent_soft ... } }
        &flameout  { AUDIO { clip = sound_explosion_low ... } }
    }
    @PLUME[Kerolox_LowerAlt]:HAS[~processed[*]] { processed = true }
    MM_PATCH_LOOP { }
}
```

This is the real generative core:
- **The template file is itself an MM patch**, gated by `:HAS[@PLUME[Kerolox_LowerAlt]:HAS[~processed[*]]]`
  — it only fires on parts that (a) have a `PLUME` node named exactly `Kerolox_LowerAlt` and
  (b) have not yet been processed. This is how one `.cfg` in the shared template library can apply
  itself, unmodified, to any number of parts across any number of mods that reference it by name.
- **One `PLUME` template = one named `EFFECTS` sub-node** (here `Kerolox_LowerAlt`, i.e. the
  `powerEffectName` the applying part's `ModuleEnginesFX` must reference) **= a fixed *stack* of
  several `MODEL_MULTI_SHURIKEN_PERSIST` blocks**, each an independent particle-system layer
  (flare/plume/plume2/plume3/blaze/flame in this example — 6 layers for one "Kerolox lower" look)
  plus one looping `AUDIO` block. Real engines are visually a composite of several billboard
  streams, not one.
- Every field inside each `MODEL_MULTI_SHURIKEN_PERSIST` is populated via MM's `#$path$`
  value-reference operator pulling from the **original, unprocessed** `PLUME` node
  (`#$/PLUME[Kerolox_LowerAlt]:HAS[~processed[*]]/flarePosition$` etc.) — i.e. the template supplies
  *shape* (which curves exist, particle model names, layer count) and the applying part's `PLUME`
  block supplies *placement/scale* (position offsets, `fixedScale`, `energy`, `speed`). This
  is the core template/instance split the editor's data model should preserve (see Integration plan).
- **`processed = true` is written back onto the `PLUME` node** at the end of the patch. Because the
  patch's own `:HAS[...HAS[~processed[*]]]` selector requires the flag be *absent*, this is a
  one-shot latch: it guarantees exactly one template's patch ever fires per `PLUME` node even
  though MM re-evaluates all patches to a fixed point, and it's also the tell-tale a reader can grep
  for to confirm a `PLUME` was successfully resolved (an unresolved one, e.g. referencing a template
  name that doesn't exist in `000_Generic_Plumes/`, is left with **no** `processed` flag and
  **no** generated `EFFECTS` node — silently invisible, exactly BDB/AJ260's original "no plume" bug
  class if a template name typo'd or the template pack were missing).
- `MM_PATCH_LOOP { }` is the standard MM idiom forcing another patch pass, needed because the
  `AFTER[zRealPlume]` template patches are order-independent relative to each other and one part
  can carry multiple different `PLUME[...]` nodes for different engines (as AJ260's multi-part
  patch shows — main + radial + inline each get their own `PLUME`).
- `000_EFFECTS_Remover.cfg`, run `:AFTER[RealPlume]`, then deletes every stock/legacy
  `fx_*`/`sound_*` key still on the part (`!fx_exhaustFlame_yellow = DELETE`, etc.) and clears any
  pre-existing `EFFECTS` nodes on engine parts (`!EFFECTS,*{}`) before generation — this is why a
  RealPlume-driven part shows *only* the generated `MODEL_MULTI_SHURIKEN_PERSIST` stack in the final
  `ModuleManager.ConfigCache`, with no stock KSP particle emitters left over to confuse a reader.
  It also has special-case handling for `ModuleRCSFX` (`plumeToKeep`) so multi-`PLUME` RCS parts keep
  only the plume matching their `runningEffectName`.

BDB's own `EFFECTS`-block append shown at the bottom of `BDB_Saturn_AJ260_solids.cfg` — a second
`@PART[...]:AFTER[zzRealPlume]` patch that reaches into the *already-generated* `EFFECTS` node
(`@BDB_Solid-Lower{ MODEL_MULTI_SHURIKEN_PERSIST { ... Solid-Sepmotor-plume ... } }`) and appends a
7th particle layer (vernier motor smoke, `Squad/FX/SRB_Large` prefab) plus a `flameout`
`PREFAB_PARTICLE` — proves the template system is meant to be extended per-part, not just consumed
verbatim; a fully faithful RealPlume-in-editor model has to support arbitrary post-template
`MODEL_MULTI_SHURIKEN_PERSIST` injection, not just "pick one of 67 templates."

---

## Q2 — The effect primitive: `MODEL_MULTI_SHURIKEN_PERSIST` fields and what actually renders

Source: `ModelMultiShurikenPersistFX.cs` (`sarbian/SmokeScreen`, fetched live) plus every field
observed in the local `.cfg`s above.

**What it is, mechanically:** each `MODEL_MULTI_SHURIKEN_PERSIST` node instantiates one Unity
prefab (`modelName`, a `.mu`/asset path like `RealPlume/Jade_FX/Engines/Generic/keroEagleStream`)
that already contains a Shuriken (`ParticleSystem`) component, parents it under the named part
transform (`transformName`, e.g. `thrustTransform`) with a `localPosition`/`localRotation` offset,
and then **drives that Shuriken system's emission/velocity/size/color every frame from KSP flight
state** via `MultiInputCurve` fields (Q3). It is fundamentally a **GPU billboard-particle system**,
not a mesh+shader effect like Waterfall — there is no equivalent of Waterfall's per-frame vertex
deformation or `WaterfallMaterial` shader graph; all the visual variety comes from (a) which
pre-authored particle-texture prefab is used and (b) how its emission rate / size / speed / alpha
respond to the input curves.

Fields confirmed (grouped):

| Group | Fields | Purpose |
|---|---|---|
| Model/placement | `modelName`, `transformName`, `localPosition`, `localRotation`, `fixedScale` | which prefab, where it's parented, static offset/scale multiplier |
| Curve-driven (all `MultiInputCurve`, see Q3) | `emission`, `energy` (≈lifetime), `speed`, `size`, `logGrow`/`linGrow` (size-over-life growth), `xyForce`/`zForce`/`force`, `offset`, `randConeEmit`, `alphaMult`, `saturationMult`, `brightnessMult` (color/alpha modulation), `sizeClamp` | per-frame modulation of the underlying Shuriken emission/shape/size-over-lifetime/color-over-lifetime modules from live flight data |
| Emission behavior | `emissionMult` (base rate multiplier), `fixedEmissions` (bool — ignore curve, emit constant rate), `emitOnUpdate` (emit in `LateUpdate` vs `FixedUpdate`, for visual smoothness), `decluster` (nudge particle spawn positions along velocity to avoid a "stacked" look at high emission rate), `randomInitalVelocityOffsetMaxRadius` (random velocity jitter radius) | shapes how "busy"/organic the stream looks, independent of the curve values |
| Physical particle sim (optional) | `physical` (apply gravity/drag/Archimedes buoyancy), `collide`/`collideRatio`/`stickiness`, `initialDensity`, `dragCoefficient` | used for smoke/vapor trails that should visibly drift/dissipate with local atmosphere, not used by the pure-flame layers in `Kerolox_LowerAlt` |
| Rendering | `layer` (defaults `TransparentFX`), `renderMode` (billboard orientation) | Unity render layer + billboard facing mode |

**What actually renders, at the Unity level:** a Shuriken `ParticleSystem` with (per the fields
above being fed in): emission rate (particles/sec, from `emission` curve × `emissionMult`),
particle lifetime (`energy` curve), start speed (`speed` curve, along the transform's local +Z /
thrust axis, jittered by `randomInitalVelocityOffsetMaxRadius` and `xyForce`), start size (`size`
curve) with a size-over-lifetime curve built from `logGrow`/`linGrow` (particles visibly expand as
they age — this is *the* visual signature of a rocket exhaust plume widening downstream, and it's
absent from Waterfall's mesh-stretch approach), a texture-sheet/color-over-lifetime driven by
`alphaMult`/`saturationMult`/`brightnessMult`, and additive-blended billboard quads (`TransparentFX`
layer, standard KSP particle shader — same additive-blend family already implemented in
`plume.js`'s mode 0). Multiple `MODEL_MULTI_SHURIKEN_PERSIST` blocks in one `EFFECTS` sub-node are
simply several independent particle systems layered at (usually) the same transform with different
offsets (`offset = 0.2`, `offset = -0.1` seen in `Kerolox_LowerAlt`) — e.g. that template's
"plume2"/"plume3" are red/blue color-fringe layers offset slightly downstream of the main white
plume, and "blaze"/"flame" are separate near-nozzle brightness layers — additively composited so
the final look is the sum of all six.

---

## Q3 — Controllers/inputs: `MultiInputCurve` and what drives it

Source: `MultiInputCurve.cs` (`sarbian/SmokeScreen`, fetched live).

`MultiInputCurve` parses a named ConfigNode sub-block of `MODEL_MULTI_SHURIKEN_PERSIST` (e.g. the
`emission { }`, `speed { }`, `energy { }` blocks seen throughout `Kerolox_LowerAlt.cfg`) as **up to
six independent `FloatCurve`s**, one per member of an `Inputs` enum: `power`, `density`, `mach`,
`parttemp`, `externaltemp`, `time`. Each is written as repeated `<inputname> = <x> <y>` keyframe
lines inside the block (`power = 0.0 0` / `power = 1.0 1.5`, `density = 0.7 1` / `density = 0.02
0.75`, as seen throughout the local `.cfg`s). An input can additionally have a `log<name>` variant
that applies a base-10 log transform to the raw input value before the curve is sampled — useful
for `density`, which otherwise spans many orders of magnitude between sea level and vacuum.

**Combination rule:** at evaluation time the six input values (supplied externally as a
`float[]`, populated once per frame by the SmokeScreen/KSP effects-update loop from live vessel
state) are looked up against whichever named curves exist on that field, and the per-curve results
are combined via a per-`MultiInputCurve` `additive` flag — **default is multiplicative**
(`result *= curves[i].Value(input)` for each configured input), an explicit `additive = true`
switches to summation. Concretely, for `Kerolox_LowerAlt`'s `emission` block (which defines both
`density` and `power` keyframes with no `additive` flag) the final emission multiplier is
`density_curve(atmDensity) × power_curve(throttle)` — this is exactly why the config data shows
two independently-authored curves per field: one shaping the response to throttle, one shaping the
response to ambient atmosphere, multiplied together every frame.

**What the six inputs mean, in KSP terms** (inferred from field names + how RealPlume templates use
them, since `MultiInputCurve.cs` itself only defines the enum and receives raw floats — the
producer of those floats is the surrounding SmokeScreen effect-update code, not read verbatim here
but corroborated by every generic-plume `.cfg` using `power` as a 0..1 throttle-like value and
`density` as a 0..~1 atmosphere-like value matching `GlobalSettings.cfg`'s `atmDensityExp` scaling
comment "Scale atmosphere to stock solar system"):
- `power` — the KSP stock effects-system "power" value for the named `EFFECTS` node, i.e. engine
  throttle/response-curve output, 0..1 (the same `power` concept stock `EFFECTS` and Waterfall's
  own throttle-driven controllers use — this is the point of contact between RealPlume and the
  engine's `ModuleEngines*` state).
  
  Test-idle plates on ground exposed `power = 0.0 0` / `power = 0.001 0.7` idle-blip keyframes in
  every template — a deliberate near-zero-throttle flicker before full ignition.
- `density` — local atmospheric density, exponent-scaled per `GlobalSettings.cfg`'s
  `@SmokeScreen:FINAL { %atmDensityExp = 0.5128 }` (stock system) / `= 1` (RealSolarSystem) /
  `= 0.714` (64k rescale) and further globally multiplied by `SmokeScreen.cfg`'s `atmDensityMult`.
  This is the variable that makes a plume visibly "bloom" into a wide diffuse flame in vacuum
  (`density = 0.02` keyframes, near-vacuum) vs a tight blue-core flame at sea level
  (`density = 0.7` keyframes) — the signature RealPlume vacuum/sea-level plume-shape difference.
- `mach` — local mach number (airspeed/local speed of sound) — used by aerospike/turbine/shock
  templates (`Hydrolox_Aerospike.cfg`, `Turbofan.cfg`, `*Shock*.cfg` seen in the template list) for
  shock-diamond and mach-tuck effects, not exercised by the plain `Kerolox_LowerAlt` example read.
- `parttemp` / `externaltemp` — engine part temperature and external (ambient) temperature, used
  by templates wanting heat-soak-driven effects (e.g. nuclear-core glow ramping with
  `Nuclear_*_LH2.cfg` templates) — not exercised in the example read either, flagged as unverified
  beyond the field name.
- `time` — wall/mission time modulo `timeModulo` (from `ModelMultiShurikenPersistFX.cs`'s field
  list) or countdown time during a `singleEmitTimer`-gated burst — used for one-shot burst effects
  (e.g. `Solid-Sepmotor` separation flares) rather than continuous thrust plumes.

---

## Q4 — Generic plume template library present in this install

`GameData/RealPlume/000_Generic_Plumes/` (67 `.cfg` files, one `PLUME` template name per file
matching the filename in essentially every case). Grouped by propellant/engine family, from the
directory listing:

- **Kerolox (RP-1/LOX)**: `Kerolox-Exhaust`, `Kerolox_LowerAlt` (read in full — 6-layer white/red/blue
  fringed sea-level flame, F-1/BDB-Saturn style), `Kerolox_LowerAspirated`, `Kerolox_LowerFlame`,
  `Kerolox_LowerNK33`, `Kerolox_SL_FilmCooled`, `Kerolox_TurboExhaust`, `Kerolox_Upper`,
  `Kerolox_VernierEagle`
- **Hydrolox (LH2/LOX)**: `Hydrolox_Aerospike`, `Hydrolox_UpperBlue`
- **Hydynelox / Alcolox / Ammonialox**: `Hydynelox`, `Alcolox_Lower`, `Ammonialox`
- **Hypergolic (NTO/UDMH/Aerozine-family)**: `Hypergolic-Apollo-SM`, `Hypergolic-Lower`,
  `Hypergolic-OMS-White`, `Hypergolic-Vernier`, `Hypergolic_Aerozine50Lower`,
  `Hypergolic_LowerOrangeShock`, `Hypergolic_LowerRed_shock`, `Hypergolic_UpperAerozine`,
  `Hypergolic_UpperOrange`, `Hypergolic_UpperRed`, `Hypergolic_UpperWhite`, `Hypergolic_UpperYellow`,
  `Hypergolic_VernierOrange`, `Hypergolic_VernierRed`
- **Methalox**: `Methalox_AirBreathingMode`, `Methalox_Lower`, `Methalox_LowerShock`, `Methalox_Upper`
- **Cryogenic (generic cryo look, non-hydrolox-specific naming)**: `Cryogenic_LowerAblative_CE`,
  `Cryogenic_LowerRed_CE`, `Cryogenic_LowerSSME_CE`, `Cryogenic_OrangeVernier`,
  `Cryogenic_UpperBlue_CE` (`_CE` suffix = CryoEngines mod tie-in)
- **Solid rocket motors**: `Solid-LES` (launch escape), `Solid-Lower`, `Solid-Sepmotor`,
  `Solid-Upper`, `Solid-Vacuum`
- **Nuclear thermal**: `Nuclear_GasCore_LH2`, `Nuclear_GasCore_Open_LH2`, `Nuclear_SolidCore_LH2`,
  `Nuclear_SolidCore_LOX`, `Nuclear_VernierExhaust`
- **Air-breathing**: `Turbofan`, `TurbofanOxPlume`, `Turbojet`, `TurbojetOxPlume`
- **Electric propulsion**: `Ion_Argon_Gridded_NFP`, `Ion_Argon_Hall_NFP`, `Ion_Xenon_Gridded_NFP`,
  `Ion_Xenon_Hall_NFP` (NFP = Near Future Propulsion tie-in), `MagnetoPlasmaDynamicThruster`,
  `PulsedInductiveThruster_Argon`, `VASIMIR_Argon`, `VASIMIR_Xenon`
- **Miscellaneous**: `HTP_RP1_lower` (peroxide/kerosene hybrid), `Penataborane_Lower`,
  `zRN_Decoupler` (a non-engine plume: staging-decoupler gas puff)
- **`Deprecated/`** subfolder — older superseded templates kept for backward-compat MM matching,
  not enumerated individually here.
- **Bootstrap patches** (not templates): `000_zRealPlume.cfg`, `000_EFFECTS_Remover.cfg` (Q1).

`RealPlume-Stock/` (the compatibility layer proper) then has one subfolder per supported mod —
observed: `Squad`, `ReStock`/`ReStockPlus`, `KWRocketryRedux`, `CryoEngines`, `Kerbal Atomics`,
`SpaceY-Lifters`/`SpaceY-Expanded`, `Knes`, `FASA`, `KSO`, `DIRECT_LV`, `RealScaleBoosters`,
`ProceduralParts`, and ~25 more (full list in the earlier directory scan) — each subfolder's `.cfg`s
apply these same 67 templates to that mod's specific parts, exactly like BDB's own
`Compatibility/RealPlumes/` folder does independently for Bluedog_DB.

---

## Q5 — Detecting which plume subsystem a compiled part uses

Because `EngineEditor`'s indexer already parses `GameData/ModuleManager.ConfigCache`
(`parse_cache.py` line 4 — confirmed reading the *post-patch* cache, not raw `GameData/**/*.cfg`),
detection can be a single pass over each part's `MODULE` and `EFFECTS` children, no MM-order
resolution needed on the editor's side:

1. **Waterfall**: `MODULE { name = ModuleWaterfallFX }` present (already what `parse_cache.py`
   checks at line 98, `mn == 'ModuleWaterfallFX'`). Effect data lives in that module's own
   `TEMPLATE`/`EFFECT` children, not in the part-level `EFFECTS` node.
2. **RealPlume / SmokeScreen**: part-level `EFFECTS` node has a child whose name matches an engine
   module's `powerEffectName` (or `runningEffectName` for RCS) and that child contains one or more
   `MODEL_MULTI_SHURIKEN_PERSIST` sub-nodes. Concretely: `EFFECTS/<name>/MODEL_MULTI_SHURIKEN_PERSIST`
   present anywhere under the part. A secondary, cheap tell for provenance is a leftover
   `plumeIdentifier` key inside that node (RealPlume's `000_zRealPlume.cfg` sets this on every
   `PLUME`, and the template patches copy it straight into the generated `EFFECTS` sub-node) — its
   presence indicates this specific `EFFECTS` sub-node was RealPlume-*generated* rather than a
   `MODEL_MULTI_SHURIKEN_PERSIST` some other mod authored directly by hand (SmokeScreen itself is
   used standalone by a few mods without going through RealPlume's template system at all).
3. **Stock**: part-level `EFFECTS/<name>/MODEL_MULTI_PARTICLE` (the pre-SmokeScreen stock particle
   effect type — grep of `GameData/Squad` confirms it's still used on a handful of untouched stock
   parts like `rcsSmallLinear`, `launchEscapeSystem`) and/or legacy `fx_*`/`sound_*` string keys
   directly on the `MODULE[ModuleEngines*]` (the pattern `000_EFFECTS_Remover.cfg` exists
   specifically to strip once RealPlume takes over — so their *presence* in the compiled cache is
   itself proof RealPlume did *not* patch this part).
4. **None**: no `ModuleWaterfallFX`, no `EFFECTS/*/MODEL_MULTI_SHURIKEN_PERSIST`, no
   `EFFECTS/*/MODEL_MULTI_PARTICLE`, and no legacy `fx_*` keys — the "no plume" case the mission
   statement calls out for `bluedog_Saturn_AJ260`. Given Q1's finding that BDB *does* ship a working
   `RealPlumes` compatibility patch gated `:NEEDS[RealPlume,SmokeScreen,!RealismOverhaul]`, if this
   install's `ModuleManager.ConfigCache` still shows AJ260 with none of the above, the most likely
   explanation is a `NEEDS` gate failing at MM-patch time (`RealismOverhaul` present when it
   shouldn't be, or `RealPlume`/`SmokeScreen` not actually loaded/mis-versioned) rather than a
   modeling gap in RealPlume itself — worth an actual cache grep for `bluedog_Saturn_AJ260` as a
   follow-up, since this doc is scoped to research, not to fixing that specific part.

Priority for routing when a part has more than one signal present (e.g. a part mid-migration with
both legacy `fx_*` keys and a `ModuleWaterfallFX`): Waterfall > RealPlume/SmokeScreen >
stock `MODEL_MULTI_PARTICLE` > legacy `fx_*` — this matches `000_EFFECTS_Remover.cfg`'s own
priority (it deletes legacy keys once RealPlume applies, implying RealPlume always wins over
raw stock leftovers) and is the common real-world case of a newer FX system overriding but not
always fully cleaning up an older one.

---

## Q6 — Rendering-approach assessment: RealPlume in WebGL2

**The core problem is a paradigm mismatch with the existing Waterfall renderer.** `plume.js`
currently renders Waterfall effects as **pre-authored, deforming meshes** (skinned `.mu` geometry,
per-node TRS "growth"/scroll/UV-scroll modifiers, `Additive`/`Directional`/`AlphaDynamic` shader
modes — see `docs/RenderingGroundTruth.md` and `docs/RenderPasses.md`). RealPlume/SmokeScreen has
**no meshes to place at all** — every visual layer is a live-simulated Shuriken particle *system*
(spawn → advect → age → die), driven every frame by the six-input `MultiInputCurve` evaluator (Q3).
There is no static geometry to load and pose; the "content" is emission-rate/size/color-over-life
*curves* plus a small particle *texture* (the `.mu` "prefab" referenced by `modelName` is really
just a container asset carrying the Shuriken component's texture/material — confirmed by prefab
names like `RealPlume/Jade_FX/Engines/Generic/keroEagleStream` living under an `Engines/` texture
tree, not a modeled-geometry tree like Waterfall's `Waterfall/FX/*.mu`).

**Option A — faithful port (real per-particle simulation).** Implement an actual CPU or GPU
particle system in JS/WebGL2: a fixed-size particle pool per `MODEL_MULTI_SHURIKEN_PERSIST` layer,
spawn `N = emission.Value(inputs) × emissionMult × dt` particles/frame along `transformName`'s +Z
axis with `speed.Value(inputs)` initial velocity (jittered by `randomInitalVelocityOffsetMaxRadius`,
`xyForce`), age each particle against `energy.Value(inputs)` lifetime, grow size over life per
`logGrow`/`linGrow`, fade alpha/color per `alphaMult`/`saturationMult`, and draw as camera-facing
additive billboards (instanced quad, `gl.blendFunc(ONE,ONE)` — same additive family `plume.js`
already implements for mode 0). This is a real GPU-particle system: a `GL_POINTS` or
instanced-quad draw call per layer, updated with a compute-like pass (transform-feedback or a
ping-pong position/age buffer, since WebGL2 has no compute shaders) or, more pragmatically, CPU-side
particle-array update with a typed-array-backed instanced draw (thousands of particles per plume ×
up to ~6 layers is well within CPU-update budget at 60fps for a single-engine viewer — this is not
a full-vessel flight sim). **Effort: high.** Needs: (1) a curve evaluator matching `MultiInputCurve`
exactly (multiplicative combine, optional `log` variant, six named inputs — Q3, all logic is small
and portable), (2) an instanced-billboard draw path (new, `plume.js` currently draws skinned
triangle meshes, not point sprites — the additive blend state and shader *mode 0 numerics* are
reusable but the vertex pipeline is not), (3) DDS/texture loading for each layer's particle texture
(`plume.js`'s existing `decodeDDS()` at line 298 is directly reusable — RealPlume textures are the
same Unity-authored DDS format), (4) size/color-over-lifetime curve baking, (5) real particle-count
tuning per layer to avoid overdraw blowing out bloom (the existing HDR+bloom pipeline at
`plume.js` line 1069+ is reusable as-is for tone-mapping the additive accumulation, same as it
already handles overlapping Waterfall cones — see that file's own note "several thin, near-axis
additive cones... sum to a large HDR value").

**Option B — cheap approximation (parametrized billboard cone/stack, no true particle sim).**
Render each `MODEL_MULTI_SHURIKEN_PERSIST` layer as a small stack of 3-6 camera-facing additive
quads along the thrust axis (a "flip-book cone"), with per-quad size/alpha driven directly by
sampling the *same* curves (`emission`→overall opacity, `size`+`logGrow`/`linGrow` at a few
fixed t-along-length samples→per-quad scale, `alphaMult`/`saturationMult`→per-quad tint) evaluated
once per frame rather than per-particle. No spawn/age/death simulation, no particle pool, no
per-particle randomness (or only a cheap per-quad jitter via a hash of layer index + time).
**Effort: low-to-moderate**, and it reuses almost everything `plume.js` already has: the additive
blend state, the HDR/bloom pipeline, `decodeDDS()` for textures, and — most importantly — the
existing **controller-slider infrastructure** (`plume.js`'s `controllers` object / `setController`
at line 1034-1044, currently driving Waterfall's `throttle`/`atmosphereDepth`/`random` — RealPlume's
`power`/`density`/`mach` inputs map almost 1:1 onto those same three sliders, so the *UI* for
scrubbing a RealPlume preview needs no new work, only a new curve-sampling code path feeding the
existing sliders' values into `MultiInputCurve.Value()` instead of Waterfall's controller lookup).
This will not reproduce the organic, spawn-and-drift look of real Shuriken particles (no visible
individual puffs, no drift/turbulence, no true size-over-life billowing of *individual* particles —
just a shaped, animatable cone), but it will correctly reproduce the *macro* signature RealPlume is
actually configured to control: plume width/length/color/brightness responding to throttle and
altitude, and the vacuum-bloom vs sea-level-taper silhouette difference that's the whole point of
the `density` curves in every template read.

**Recommendation:** do Option B first, because (1) it is a straight reuse of ~80% of the existing
`plume.js` machinery (additive blend, bloom, DDS decode, controller sliders) versus Option A's need
for an entirely new particle-simulation and instanced-rendering subsystem; (2) it directly answers
the stated goal — visually distinguishing "this engine has a plume, shaped like X" from the current
blank "no plume" state — without first building general GPU-particle infrastructure the project
doesn't have yet; (3) the curve-evaluation code (`MultiInputCurve` semantics, Q3) is shared between
both options and is the part actually worth getting exactly right first, since it's what makes a
rendered plume *correct* rather than just present — building and testing that evaluator against
Option B's cheap geometry is materially faster to validate (three sliders, watch a cone stretch and
fade correctly) than debugging it simultaneously with a new particle simulator. Option A remains the
long-term target once RealPlume plumes are common enough in the editor's catalog that the cone
approximation's limits (no per-particle drift, no billowing) start to visibly matter — likely worth
revisiting after a first pass over how many of this install's engines actually route to RealPlume
vs Waterfall (a cheap census: grep the `ModuleManager.ConfigCache` for
`EFFECTS/*/MODEL_MULTI_SHURIKEN_PERSIST` vs `ModuleWaterfallFX` counts, not done here as this doc
is scoped to config/render-model research, not a codebase census).

---

## Integration plan: a plume-system-agnostic data model, and phased implementation

**Common concepts, shared across Waterfall and RealPlume** (the editor's core data model should be
built on these, with subsystem-specific data hanging off a tagged variant):

- **Template library**: Waterfall's `EFFECTTEMPLATE` catalog and RealPlume's 67
  `000_Generic_Plumes/*.cfg` files are structurally the same idea — a named, reusable "look" that
  gets parametrized per part. Both are worth exposing in the editor as a browsable template
  catalog independent of any specific engine (`plumelib.html`/`plumelib.js` already exist for
  Waterfall templates — the natural home for a RealPlume template browser too).
- **Per-engine assignment**: Waterfall's `MODULE[ModuleWaterfallFX]/TEMPLATE` instantiation and
  RealPlume's `PART/PLUME[templateName]{ overrides }` are both "pick a template by name, override a
  handful of placement/scale/intensity params" — the editor's per-engine plume-assignment UI can
  share one form shape (template picker + transform/offset/scale fields + intensity fields) across
  both systems.
- **Controllers**: Waterfall's named controllers (`throttle`, `atmosphere_density`, etc.) and
  RealPlume's `MultiInputCurve` inputs (`power`, `density`, `mach`, `parttemp`, `externaltemp`,
  `time`) overlap enough (throttle↔power, atmosphere↔density) that the existing three-slider
  preview UI (`controllers.throttle`/`atmosphereDepth`/`random` in `plume.js`) can drive both,
  with RealPlume needing two more sliders added later for `mach` and temperature if/when those
  inputs matter for a cataloged part.
- **Offsets/transforms**: both systems place effects relative to a named part transform
  (`transformName`, `localPosition`/`localRotation`) — identical concept, identical editor field.

**Divergent concepts** (need subsystem-specific handling, not forced into one shape):

- **Particles vs mesh.** Waterfall = static/skinned mesh + shader material; RealPlume = simulated
  particle system + curve-sampled emission. The *renderer* must branch on this per effect layer;
  the *editor's read/edit data model* mostly doesn't need to (both are "a named effect with a
  template reference, placement, and a set of scalar/curve parameters" at the data-model level —
  it's only the render backend that differs).
- **Multi-layer composition.** A single RealPlume `PLUME` instantiates a *fixed stack* of several
  `MODEL_MULTI_SHURIKEN_PERSIST` layers baked into the template (6 layers in `Kerolox_LowerAlt`)
  that the applying part cannot restructure, only override shared params (position/scale/energy)
  and append extra layers post-hoc (as BDB's `Solid-Sepmotor` append shows in Q1). Waterfall
  effects are more granularly composed at the per-effect level. The editor's RealPlume model should
  treat a resolved `PLUME` as "one template + N generated layers it doesn't get to reorder", vs
  Waterfall's more freely-composed effect list.
- **`processed`-flag one-shot resolution.** RealPlume templates only resolve via MM's patch-time
  substitution — there is no equivalent of inspecting an unresolved `PLUME[name]{overrides}` block
  directly and knowing what it will render without also having the referenced template's `.cfg`
  loaded. This is actually simpler for the editor than it sounds *given* `parse_cache.py` already
  reads MM's own resolved output (`ModuleManager.ConfigCache`) — no need to reimplement MM's `#$path$`
  substitution logic at all; just read the already-generated `MODEL_MULTI_SHURIKEN_PERSIST` nodes,
  same as Waterfall's `TEMPLATE`s are read today (Q5, point 1 confirms `parse_cache.py`'s existing
  design already reads post-patch data). The one thing worth *additionally* capturing at index time
  (not currently done) is the originating `PLUME` template name and the raw override params, by
  keeping `plumeIdentifier` and cross-referencing which `000_Generic_Plumes` template name matches —
  useful for "edit the template assignment" UX later, distinct from "edit the resolved curve".

**Recommended phased approach:**

1. **Read/catalog (no render).** Extend `parse_cache.py`'s `process_part()` to detect the
   RealPlume/SmokeScreen case per Q5 (a new `elif` branch parallel to the existing
   `ModuleWaterfallFX` one at line 98, scanning `EFFECTS/*/MODEL_MULTI_SHURIKEN_PERSIST`), extract
   per-layer fields (modelName, transformName, position/scale, and the raw `MultiInputCurve`
   keyframe lists for `emission`/`speed`/`energy`/`size`/`logGrow`/`linGrow`/`alphaMult` at
   minimum), and surface them in whatever UI currently lists Waterfall templates/effects — this
   alone fixes "no plume" showing for RealPlume engines by at least *listing* what's configured,
   with zero rendering work.
2. **Edit.** Expose the extracted per-layer params as editable fields (same shape as Waterfall's
   effect-param editing, per the "common concepts" section above), writing back through whatever
   the editor's existing patch-authoring path is for Waterfall `TEMPLATE` overrides — RealPlume's
   own MM idiom (`@PLUME[name]{ @fixedScale = X }`) is directly analogous.
3. **Render — Option B (cheap cone approximation).** Build the `MultiInputCurve` evaluator (small,
   self-contained, shared by both edit-preview and eventual Option A), wire it to the existing
   controller sliders, and render each layer as a shaped additive quad-stack reusing `plume.js`'s
   blend/bloom/DDS-decode machinery, per Q6.
4. **Render — Option A (true particle sim), later.** Only once Option B's approximation is visibly
   limiting for the catalog's actual RealPlume population — build a real instanced-billboard
   particle pool per layer, reusing the same curve evaluator from phase 3.
