# KSP Engine Editor — Architecture Map

How engine parts "compile" in this install, and how the GUI editor/plume-visualizer will model it.
Research verified against: ModuleManager 4.2.3 (this install's cache), Waterfall source + wiki (cloned),
B9PartSwitch source (`PartSubtype.cs`, `ModuleModifierInfo.cs`, `ModuleDataHandlerBasic.cs`), and live
configs in `GameData` (CryoEngines Vesuvius, BDB Saturn F-1, SEP Raptor).

---

## 1. The compilation pipeline

An engine you see in-game is the product of four layers:

```
(1) Raw .cfg PART nodes            e.g. Bluedog_DB/Parts/Saturn/Engines/bluedog_Saturn_Engine_F1.cfg
        │
(2) ModuleManager patching          @PART[...]:NEEDS[Waterfall]:AFTER[Bluedog_DB] { !EFFECTS{} MODULE{ModuleWaterfallFX} @MODULE[ModuleB9PartSwitch]{...} }
        ▼
    FINAL PART DATABASE  ══════►  GameData/ModuleManager.ConfigCache   ◄── OUR GROUND TRUTH (57 MB, 11,834 UrlConfig nodes)
        │
(3) B9PartSwitch (runtime)          selected SUBTYPE overlays DATA onto matched modules, toggles meshes, moves transforms
        ▼
(4) Waterfall (runtime)             TEMPLATE refs expanded against EFFECTTEMPLATE library; controllers+modifiers drive shaders per frame
```

**Layers 1–2 are pre-computed for us.** `ModuleManager.ConfigCache` contains every final top-level
node post-patching, wrapped as:

```
patchedNodeCount = 87480
UrlConfig
{
    parentUrl = CryoEngines/Parts/HydroloxEngines/125/cryoengine-vesuvius-1.cfg   // source file, GameData-relative
    PART { ...fully patched... }        // exactly one child node per UrlConfig
}
```

`ModuleManager.ConfigSHA` holds per-file SHA-256s — our cache-staleness check. Root-level cfg files
appear as `/filename.cfg`. Deleted nodes are absent; MM patch nodes are consumed.

**Layers 3–4 the GUI must implement itself** (specs in §3, §4). Waterfall `TEMPLATE` nodes are NOT
expanded in the cache; the 497 `EFFECTTEMPLATE` nodes are separate top-level entries in the same cache.

### Install census (from cache)
- 136 `ModuleEngines` + 1,339 `ModuleEnginesFX` (≈ 1,475 engine modules; a part can host several)
- 1,393 `ModuleWaterfallFX`
- 4,706 `ModuleB9PartSwitch`
- 497 `EFFECTTEMPLATE` plume templates
- Plume providers coexisting: Waterfall + StockWaterfallEffects (owns stock engines, e.g. LV-T45 →
  `waterfall-kerolox-lower-4-SWE`) + RealPlume (defers where Waterfall configs exist)

---

## 2. ModuleManager essentials (for writing patches back)

The GUI **reads** the cache but **writes** edits as MM patch files (like the user's existing
`GameData/AR-1E_patch.cfg`) — never modifying mod files.

> **Full reference: [docs/ModuleManager.md](docs/ModuleManager.md)** — includes the `+PART` copy
> semantics (snapshot-at-pass, mandatory `@name`, new-name wildcard exposure), the bare-`!NODE`
> footgun, variable refs, and the validator lint rules. The summary below is abbreviated.

### Node ops
`@` edit · `+`/`$` copy · `-`/`!` delete (needs `{}`) · `%` edit-or-create · `&` create-if-absent ·
`|` rename · `#` copy-from-path. Selector: `@PART[name|other*]:HAS[...]` `,index` (`,*` all, `-1` last).
Wildcards `*` `?`; `?` also stands for spaces.

### Value ops
`@key = v` edit · `@key += -= *= /= !=`(pow) · `@key ^= :pat:repl:` regex · `!key = _` delete ·
`%key` edit-or-create · `key,i` index · `@key,i[j,sep]` element edit · `#$../path$` / `#$@PART[x]/key$`
variable refs.

### :HAS filters
`@MODULE[x]` has-node · `!MODULE[x]` lacks · `#key[val]` value match (numeric `<` `>` ok) · `~key[val]`
absent/mismatch · nestable.

### Pass order
`:FIRST` → unsuffixed (legacy) → per modname alphabetically (`:BEFORE[mod]` → `:FOR[mod]` → `:AFTER[mod]`)
→ `:LAST[mod]` → `:FINAL`. **User patches should use `:FINAL`** so they land after everything —
that's what our generated patches will use. `:NEEDS[A&!B|C]` gates on mod presence (DLL name, GameData
dir, or any `:FOR` name; case-insensitive).

Within a pass, files apply in alphabetical path order.

---

## 3. B9PartSwitch — computing post-switch state

### Structure
`ModuleB9PartSwitch { moduleID, switcherDescription, baseVolume, parentID, SUBTYPE+ }`.
Multiple instances per part are common (F-1 has `engineSwitch` + `meshSwitchInsulation`); the GUI
needs **one selector per switcher module**.

### SUBTYPE effects (what the "compiled view" must apply)
- **Geometry:** `transform` / `node` lists — the managed set is the union across all subtypes of the
  module; current subtype's listed ones are enabled, rest disabled. If several modules reference the
  same transform, enabled = AND of all. `TRANSFORM { name, positionOffset, rotationOffset, scaleOffset }`
  moves transforms — **including `thrustTransform`** (F-1B shifts it −0.258 m ⇒ moves the plume!).
- **Stats:** `addedMass`, `addedCost`, `maxTemp`, `crashTolerance`, `upgradeRequired` (tech gate),
  `defaultSubtypePriority` (highest unlocked = default).
- **Tanks:** `tankType` → `B9_TANK_TYPE` (top-level, MM-patchable, in cache).
  `volume = baseVolume*volumeMultiplier + volumeAdded (+ children volumeAddedToParent)`;
  per resource `amountMax = unitsPerVolume*volume`; `dryMassDelta = addedMass + tankMass*volume`.
- **Module rewrites — THE key mechanism:**
  ```
  MODULE {
    IDENTIFIER { name = ModuleEnginesFX  [engineID = X] [moduleID = Y] }   // must match EXACTLY ONE module
    DATA { maxThrust = 2247  atmosphereCurve { key = 0 312 ... } }
    moduleActive = true/false
  }
  ```
  **Algorithm (from source, ModuleDataHandlerBasic):** no merging.
  `effective(module) = Load(prefabNode from post-MM part config) then Load(DATA)` — DATA overlays only
  the fields/nodes it names; FloatCurve nodes (`atmosphereCurve`) are **replaced wholesale**; fields
  absent from DATA keep prefab values. Switching away reloads the full prefab node.
  Blacklisted targets: ModulePartVariants, ModuleB9PartSwitch itself, FS/Interstellar switchers.
- DATA can target `ModuleWaterfallFX` too — swapping the plume `TEMPLATE` per subtype (BDB F-1 variants,
  SEP Raptor fuel-rich/engine-rich modes).

### Order of application within a subtype
part fields → CoM/CoP/CoL → attach nodes → TEXTURE/MATERIAL → stack nodes → resources → transform
toggles/offsets → MODULE data. One B9PS module per part may own any given "aspect" (conflicts are
mod config errors — worth flagging in our validator).

---

## 4. Waterfall — data model & visualizer

### Module layout
```
MODULE { name = ModuleWaterfallFX
  moduleID = X   engineID = Y            // links to ModuleEngines[FX] by engineID
  CONTROLLER { name = throttle  linkedTo = throttle [responseRateUp/Down] }   // legacy form
  THROTTLECONTROLLER { ... }             // typed form (both occur in the wild)
  TEMPLATE { templateName, overrideParentTransform, position, rotation, scale }   // 0..n
  EFFECT { ... }                         // 0..n inline
}
```
Controllers output scalars each frame: throttle, thrust, atmosphere_density (`density^0.5128`),
random/perlin, mach, gimbal, engineEvent (ignition/flameout curve), rcs (multi-value), custom, etc.

### EFFECT
```
EFFECT { name, parentName = thrustTransform
  MODEL { path = Waterfall/FX/fx-cylinder, positionOffset, rotationOffset, scaleOffset
    MATERIAL { transform = Cylinder, shader = Waterfall/Additive (Dynamic), randomizeSeed
      TEXTURE { textureSlotName = _MainTex, texturePath, textureScale, textureOffset }
      COLOR { colorName = _StartTint, colorValue = r,g,b,a }   // HDR >1 allowed
      FLOAT { floatName = _Falloff, value = 3 } }
    LIGHT { ... } }
  FLOATMODIFIER / COLORMODIFIER / SCALEMODIFIER / POSITIONMODIFIER / ROTATIONMODIFIER /
  UVOFFSETMODIFIER / LIGHT*MODIFIER { name, controllerName, transformName,
    combinationType = REPLACE|ADD|SUBTRACT|MULTIPLY, useRandomness, randomnessController,
    floatCurve|xCurve|yCurve|zCurve|rCurve... }   // key = time value [inTan outTan], cubic Hermite
}
```
Per frame: `out = curve(controller.Get())`; modifiers on the same (transform, property) fold in listed
order by combinationType onto the initial value. Root transform is addressed as `<modelpath>(Clone)`.

### Template resolution (GUI must replicate)
Find `EFFECTTEMPLATE[templateName]` → clone its EFFECTs → override each `parentName` with
`overrideParentTransform` → apply TEMPLATE position/rotation/scale as extra offsets. Controllers are
NOT in templates; the host module must define the names the template's modifiers reference
(convention: `throttle`, `atmosphereDepth`, `random`).

### Rendering (WebGL preview)
Two model workflows:
- **Dynamic** (`fx-cylinder`, mesh `Cylinder`): unit cylinder deformed in the vertex shader —
  `disp(normal) = _ExpandOffset + _ExpandLinear·d + _ExpandSquare·d² + _ExpandBounded·(1−e^(−3d))`
  where d = distance down plume axis. This makes bells/cones.
- **Skinned** (`fx-simple-plume-1`, `fx-simple-shock-1`...): shape driven by POSITION/SCALE modifiers
  on bone transforms.

Fragment (Additive Dynamic, additive blend, no ZWrite, no cull):
```
scrollUV = uv + (_SpeedX,_SpeedY)·t + _Seed;  c = tex(_MainTex, scrollUV·(_TileX,_TileY))
rim = smoothstep(0,1,|dot(N,V)|)
fade = (min(1,(1+_FalloffStart)·uv.g)) ^ _Falloff            // uv.g: 1 throat → 0 tip
tint = lerp(_EndTint, _StartTint, (fade·(rim·.5+.5))^_TintFalloff)
noise = lerp(lerp(.5,c,_Noise), 1, fade)
fade *= fadeIn/fadeOut/symmetry terms (_FadeIn,_FadeOut,_Symmetry,_SymmetryStrength)
Emission = clamp(tint · rim^(k·_Fresnel) · (1-rim)^(k·_FresnelInvert) · fade · noise · _Brightness, 0, _ClipBrightness)
```
Param intuitions: `_Fresnel` bright-core/thin-edge; `_FresnelInvert` hollow core; `_Falloff` plume
length; `_TintFalloff` color transition point; `_Noise` turbulence texture visibility; `_SpeedY`
scroll rate. Slider ranges for every param ship in `GameData/Waterfall/WaterfallShaders.cfg`
(`WATERFALL_SHADER_PARAM { name, type, range }`). Noise textures: `Waterfall/FX/fx-noise-*.dds`.
Shaders: Additive/Alpha (Dynamic), Additive [Directional], Distortion, Additive Echo, Billboard,
Volumetric cones, Procedural Particles.

---

## 5. Worked example: bluedog_Saturn_Engine_F1

1. Raw cfg: `ModuleEnginesFX` (1944 kN), `ModuleB9PartSwitch[engineSwitch]` with 6 subtypes
   (F1/F1A/F1V/F1AV/F1B/F1CW) each overlaying maxThrust + atmosphereCurve (+ F1B: `powerEffectName`,
   thrustTransform −0.258 m), plus `meshSwitchInsulation` switcher.
2. MM patch `Bluedog_DB/Compatibility/WaterfallFX/Saturn.cfg` (`:AFTER[Bluedog_DB]:NEEDS[Waterfall]`):
   `!EFFECTS{}`, adds base `ModuleWaterfallFX` (template `BDB_F1_film`, scale 4.24), then
   `@MODULE[ModuleB9PartSwitch]:HAS[#moduleID[engineSwitch]] { @SUBTYPE[F1B] { MODULE { IDENTIFIER
   { name = ModuleWaterfallFX } DATA { TEMPLATE { templateName = BDB_F1 ... } } } } ... }` — per-variant
   plume swaps injected into the switcher.
3. GUI compiled view for subtype F1B = cache PART + DATA overlay (thrust 2277, running_f1B, template
   BDB_F1 @ scale 4.17) + thrustTransform shifted, meshes F1B enabled.

---

## 5b. Worst case: cross-mod generated switchers (AlcoholicAeronautics × CryoTanks)

Fuel switches are often not written per-part at all — they're **generated by wildcard patch chains**:

1. CryoTanks (`:FOR[zzz_CryoTanks]`, named `zzz_` to sort last among mods):
   `@PART[*]:HAS[@RESOURCE[LiquidFuel],@RESOURCE[Oxidizer],!MODULE[ModuleEngines],...]` — computes
   temp keys on the part with MM arithmetic (`%massOffset = #$totalCap$`, `@massOffset *= 0.000625`,
   `*= -1`), then builds a `ModuleB9PartSwitch[fuelSwitch]` with LF/O, LH2, LH2/O, Methane... subtypes,
   each `addedMass = #$../../massOffset$`.
2. AlcoholicAeronautics (`:AFTER[zzz_CryoTanks]`) matches parts *that now have* the generated module
   (`@PART:HAS[#massOffset,#costOffset,@MODULE[ModuleB9PartSwitch]:HAS[#moduleID[fuelSwitch],@SUBTYPE[LiquidFuel]]]`)
   and appends `aa-Ethanol` subtypes referencing its own `B9_TANK_TYPE`s.

**And CryoTanks is not the only generator.** At least three independent fuel-switch ecosystems
coexist in this install, each with its own tank-type namespace and generated switcher modules:
- **CryoTanks** — `moduleID = fuelSwitch`, `:FOR[zzz_CryoTanks]`, wildcard over all LF/O and LH2 tanks
- **Bluedog_DB** — its own `:FOR[Bluedog_DB_1]` wildcard patches over `@PART[bluedog*,Bluedog*]`,
  10 `bdb*` tank types (bdbLFOX, bdbLH2O, bdbBalloon*, ...), switchers keyed off marker keys like
  `#bdbTankType[bdbBalloon]`, plus cargoSwitch (Ore/Water/H2O2) with `switchInFlight`
- **AlcoholicAeronautics** — its own `aa-*` tank types, appended as subtypes into *CryoTanks'*
  generated fuelSwitch `:AFTER[zzz_CryoTanks]`

They avoid colliding purely via pass ordering and exclusion filters: `Bluedog_DB_1` sorts before
`zzz_CryoTanks`, so BDB converts its tanks (deleting the RESOURCE nodes) before CryoTanks' wildcard
`:HAS[@RESOURCE[LiquidFuel],...]` scans — the tanks no longer match. CryoTanks' filter also excludes
engines and rival switch mods explicitly.

**Design rule for the GUI:** never hardcode a specific switcher. Treat every `ModuleB9PartSwitch`
in the cache generically (moduleID is just a label; a part can carry mount + insulation + texture +
fuel switchers simultaneously) and enumerate `B9_TANK_TYPE`s from the cache, which already contains
the merged set from all three mods post-MM.

So a switcher's existence, membership, and numbers can depend on multi-stage cross-mod patch
arithmetic over injected temp keys. **All of it is resolved in `ModuleManager.ConfigCache`** (temp
keys like `massOffset` survive as inert part keys) — confirming that parsing the cache, not
re-implementing MM patching, is the only sane read path. MM syntax knowledge (§2) is still needed,
but only for the *write* path.

Additional surface area seen in AlcoholicAeronautics parts (aa-1):
- `ModuleB9DisableTransform` — permanently hides meshes (complement of subtype `transform` sets)
- Subtype `NODE { name, position }` — moves stack nodes per mount variant
- Subtype `TEXTURE` switches + `SHABBY_MATERIAL_REPLACE:NEEDS[Resurfaced]` PBR material swaps
- Custom resources (Ethanol) via CommunityResourcePack; engine PROPELLANT with `ignoreForIsp`
  (MonoPropellant turbine feed) and an onboard `RESOURCE` on the engine part itself
- One `ModuleWaterfallFX` holding **two** TEMPLATEs (main alcolox plume + `BDB_alcolox_lower_vanes`
  for the four exhaust vanes) — template lists, not single refs
- Mods freely patch *other* mods' parts (aa-part-changes.cfg edits stock/ReStock+ tech tree slots)

---

## 6. GUI architecture (proposed)

**Stack:** local web app — a small backend (file IO, cfg parse/serialize, cache indexing, patch
writing) + browser UI with a WebGL plume preview implementing §4's shader math.

**Automated indexer (implemented — `EngineEditor/indexer/`, `python run_index.py`, ~18 s):**
1. `parse_cache.py` — streams ConfigCache → `engines.tsv`, `templates.tsv`
2. `scan_patches.py` + `match.py` — selector-level patch matching → `part_patches.tsv`, aggregates
3. `scan_patch_bodies.py` — parses every raw cfg's patch *bodies* → `patch_bodies.tsv`
   (236k rows of touchOp ∈ {W write, D delete, I insert, R replace} × config path)
4. `provenance.py` — per engine part, orders all touches by MM pass rules, evaluates `:NEEDS`
   against the installed mod set and `:HAS` against the base part (approximation: base state, not
   mid-patch state), skips no-op deletions → `part_provenance.tsv` (final writer + full chain per
   path) and `part_warnings.tsv` (~59k "this value is dead/overwritten" flags)
5. `run_index.py` — orchestrates; skips rebuild when `ModuleManager.ConfigSHA` is unchanged

This is what lets the browser mark fields as **safe to edit at source** vs **overwritten later**
(edit the winning patch or emit `:FINAL`), e.g.: SSALAD's `F1Ethalox.cfg` deletes and replaces the
F-1's entire `ModuleB9PartSwitch` and `ModuleWaterfallFX` at `:FINAL` — editing BDB's Waterfall
compat for that part would silently do nothing.

**Copy patches (`+PART`/`$PART`)** create a *new* part from a snapshot of the matched part at that
pass (body must `@name = newName`); the indexer attributes their touches to the new part, and the
new part inherits every later wildcard patch that matches its new name. This is the recommended
"derive a new engine" workflow (user's `GameData/AR-1E_patch.cfg` and SSALAD's F1 Ethalox both do
it) and will be the GUI's **Clone Engine** feature. Validator lessons from those two files:
- `engineID` mismatch between ModuleWaterfallFX and the engine module is common and benign
  (Waterfall falls back to the first engine) — warn, don't error.
- `!NODE` without `{}` is silently ignored by MM — SSALAD's `!EFFECTS` (no braces) leaves the
  Ethalox copy with TWO EFFECTS blocks in the final database. Lint for this exact mistake.

Known approximations (acceptable, GUI writes `:FINAL` anyway): `:HAS` evaluated against base part
state rather than mid-patch state; MM value-arithmetic/variables not simulated (final values come
from the cache, provenance only attributes writers).

**Modules:**
1. **ConfigNode parser/serializer** — KSP grammar (`key = value`, nested `NODE {}`, `//` comments),
   round-trip faithful.
2. **Cache indexer** — parse `ModuleManager.ConfigCache` → index PARTs with engine modules,
   EFFECTTEMPLATEs, B9_TANK_TYPEs, PARTUPGRADEs; staleness via `ModuleManager.ConfigSHA`.
   Localization: resolve `#LOC_` tags from `Localization` nodes (also in cache).
3. **Switch resolver** — §3 algorithm: per-part switcher selectors → effective module set
   (engine stats, active Waterfall TEMPLATE, transform positions).
4. **Waterfall compiler + renderer** — §4: template expansion, controller simulation (throttle /
   atmosphere sliders), modifier evaluation, WebGL shaders ported from ShaderLab sources
   (cloned in scratchpad: `Waterfall/Source/ShaderLab`).
5. **Editor + validator** — schema-checked field editing (types/ranges from §3–4 tables +
   WaterfallShaders.cfg ranges), curve editor for FloatCurves.
6. **Patch writer** — emit `:FINAL` MM patches into `GameData/zzzz_EngineEditor/` computed as a diff
   between edited state and cache state; never touch mod files.

### Write-path correctness strategy (predict → verify loop)

Decision: do NOT reimplement MM's full patcher ("rebuild the database like KSP does") — the cache
already *is* MM's own output, and a reimplementation can silently diverge. Instead:

1. **Read** final state from the cache (exact by construction).
2. **Predict**: apply only our own generated patch to that state in-memory. Our patches are a
   closed, simulable subset: exact part names (no wildcards), `:FINAL` pass, `%`/`@`/`!NODE {}`
   ops, no variables/arithmetic. Prediction is provably identical to MM's application of the same
   patch. Two enumerable threats, detected via `patches.tsv` rather than simulated:
   (a) `:FINAL` patches sorting after `zzzz_EngineEditor` alphabetically — verify none exist;
   (b) wildcard selectors matching a cloned part's new name — check every selector against the
   proposed name before committing; warn on hits.
3. **Verify**: after the next KSP launch, `ConfigSHA` changes → indexer re-runs → GUI diffs the
   actual new cache against the prediction. Match ⇒ edit confirmed; mismatch ⇒ show which field
   diverged and which patch took it. The game is always the final arbiter, so a wrong prediction
   can never persist silently.

Escalation path if ever needed (live preview of arbitrary third-party patch edits): run the real
ModuleManager.dll headless — heavy (it's welded to KSP's GameDatabase/Unity loader), not required
for the engine-editing workflow.
