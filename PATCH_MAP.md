# Engine Patch Interaction Map

Generated from `GameData/ModuleManager.ConfigCache` (60 MB, `patchedNodeCount = 87480`)
correlated against **12,693** raw `*.cfg` files in `GameData/`.
Data source-of-truth for the EngineEditor GUI indexer. All counts are concrete, extracted by script.

Intermediate TSVs (in `EngineEditor/data/`): `engines.tsv`, `patches.tsv`, `part_patches.tsv`,
`templates.tsv`, plus `global_patches.tsv`, `agg_mod_targets.tsv`, `agg_patcher_counts.tsv`.

---

## 1. Overview stats

| Metric | Value |
|---|---|
| Engine PARTs (contain a top-level `ModuleEngines`/`ModuleEnginesFX`) | **985** |
| Top-level engine modules on those parts | **1,076** (avg 1.09/part) |
| Additional engine-module definitions inside B9PS subtype `DATA` overrides | ~399 (depth 4-6 in cache) |
| Parts with **>1** engine module (multi-mode / clusters) | **74** |
| Parts carrying a `ModuleWaterfallFX` | **679** (69%) |
| Parts with **no** Waterfall module | **306** |
| Parts carrying a `ModuleB9PartSwitch` | **340** |
| Total B9PS subtypes on engine parts | **1,645** |
| Raw top-level PART patch selectors (`^[@+$%!-]PART`) | **11,954** (11,910 `@`, 41 `+`, 3 `!`) |
| Selectors that are bare `*` (global/HAS-gated) | **250** |
| Engine parts touched by ≥1 *targeted* (non-`*`) patch | **879** |
| Engine parts with no targeted patch | **106** |
| EFFECTTEMPLATE plume templates defined | **350** |
| Distinct templates actually consumed by a Waterfall module | **199** |

**Note on multiplicity:** `grep` counts 1,475 `name = ModuleEngines(FX)` lines in the cache, but only
1,078 sit at PART/MODULE depth. The remaining ~400 live *inside* B9PS `SUBTYPE → MODULE → DATA`
override blocks (they redefine an engine per fuel/mount subtype), captured in `engines.tsv:b9OverrideTargets`.

### Pass-order distribution of the 11,954 selectors
`FOR` 4,897 · legacy (no qualifier) 4,916 · `AFTER` 1,377 · `FINAL` 459 · `BEFORE` 151 · `LAST` 132 · `FIRST` 22.
ModuleManager apply order used for chains: `:FIRST → legacy → (BEFORE→FOR→AFTER, sorted by mod name) → :LAST → :FINAL`.

---

## 2. Engine parts by defining mod (top 20)

| Mod (parentUrl root) | Engine parts |
|---|---|
| Bluedog_DB | 237 |
| KIU (Chinese LV pack) | 74 |
| Knes | 59 |
| Squad (+ SquadExpansion 9) | 39 |
| TantaresLV (+ Tantares 24) | 38 |
| SXT | 38 |
| FlipNBurn | 28 |
| NCAP | 27 |
| AirplanePlus | 26 |
| StarshipExpansionProject | 25 |
| Chrayol_Design_Org | 23 |
| KODS | 21 |
| PhotonCorp | 20 |
| CryoEngines (+ CryoEnginesExtensions 11) | 19 |
| Benjee10_Orion | 18 |
| ReStockPlus | 17 |
| NearFuturePropulsion | 15 · NearFutureAeronautics 15 · FarFutureTechnologies 15 |

**Bluedog_DB dominates the entire install** (24% of all engine parts and, as shown below, the overwhelming
majority of patch traffic).

---

## 3. Plume ecosystem ownership

Three plume systems coexist. Ownership per engine part:

| System | Mechanism | Engine parts reached |
|---|---|---|
| **Waterfall** (ModuleWaterfallFX) | mesh/shader plumes via `TEMPLATE{templateName}` | **679 parts carry a WF module** |
| **RealPlume** (RealPlume-Stock) | SmokeScreen `ModelMultiParticlePersistFX`, applied by `@PART:HAS[...]` | **207 parts** targeted + 93 bare-`*` HAS-gated patches |
| **StockWaterfallEffects (SWE)** | ships Waterfall configs for stock/ReStock engines | **35 parts** |
| **RSMP** (RocketSoundEnhancement/plume templates) | Waterfall templates + acoustics | **148 parts** |
| **TURD** (Textures Unlimited Recolour) | switchable recolour/plume subtypes | **50 parts** |
| **Avalanche** | Waterfall plume compat pack | **132 parts** |
| **FLBWF** (FlipNBurn Waterfall) | cluster plume templates | **24 parts** |

**Overlap/conflict:** RealPlume-Stock and StockWaterfallEffects both target several stock engines
(e.g. the Reliant — see §6). They are mutually gated by `:NEEDS[...]`/`!` guards; without those guards a part
would receive two competing plumes. This is the single most important conflict class for the GUI to surface.

---

## 4. Patch-traffic leaderboard (targeted engine-patch applications)

`part × matching-selector` counts from `part_patches.tsv` (bare-`*` globals excluded):

| Patcher mod | Applications | Notes |
|---|---|---|
| **Bluedog_DB** | 33,587 | driven by broad `bluedog*` / `Bluedog*` selectors (each matches ~120 BDB engines) reused across dozens of compat cfgs |
| **Bluedog_DB_Extras** | 7,248 | 7,156 of these re-patch **Bluedog_DB** parts (RO/RF/Waterfall/Tweakscale add-ons) |
| StarshipExpansionProject | 642 | self-patches its own Raptor/Fossil stack |
| KIU | 570 | RO/RealFuels/Waterfall/Tweakscale compat for the Chinese LV pack |
| RealPlume-Stock | 353 | cross-mod plume assignment |
| RSMP | 324 | plume + sound templates |
| Chrayol_Design_Org | 156 · Avalanche 153 · SXT 143 · NCAP 143 | |
| Benjee10_Orion | 135 · SterlingSystems 132 · PhotonCorp 128 · PROXI_Launchers 121 | |

### Top cross-mod relationships (patcher → target part's mod)

| Patcher | Targets parts from | Count |
|---|---|---|
| Bluedog_DB_Extras | Bluedog_DB | 7,156 |
| Bluedog_DB | CryoLME | 272 |
| RSMP | Bluedog_DB | 186 |
| Bluedog_DB | KODS | 137 |
| RealPlume-Stock | Squad | 133 |
| PhotonCorp | Chrayol_Design_Org | 117 |
| Benjee10_Orion | Chrayol_Design_Org | 117 |
| TURD | Squad | 78 |
| Avalanche | Bluedog_DB | 75 |
| RealPlume-Stock | Knes 43 · TantaresLV 26 · SXT 25 · ReStockPlus 19 · NearFuturePropulsion 16 · CRE 16 | — |

**Reading:** the engine ecosystem is a hub-and-spoke around BDB (biggest producer *and* consumer of patches),
with RealPlume-Stock and RSMP acting as cross-cutting plume/sound layers that reach into ~15 other mods each.

---

## 5. Per-mod-family patch chains

### Squad / ReStock
Stock engines defined in `Squad/Parts/Engine/*`, visually replaced by **ReStock** (`ReStock/PatchesLegacy/Engines/*`
with `:FOR[ReStock]`), then plumed by **RealPlume-Stock** (`:FOR`/`:AFTER[RealPlume-Stock]`) **or**
**StockWaterfallEffects** (`:FOR[StockWaterfallEffects]`), and optionally recoloured/plume-switched by **TURD**
(`TURD/TU_Standardised_Switching/*`, `TU_Stock_Recolour/*`). RealPlume applies **133** patches to Squad parts;
ReStock 38; SWE 35; TURD 78. TweakScale and KSPCommunityFixes add global `*` patches.

### Bluedog_DB (BDB)
Parts in `Bluedog_DB/Parts/**`. Patched in-family by BDB's own `Compatibility/**` tree
(Waterfall templates under `Bluedog_DB/Compatibility/WaterfallFX/`, RealFuels, CryoLME/CryoTanks fuel switching,
SystemHeat). **Bluedog_DB_Extras** layers RO/RF realism (7,156 applications). **RSMP** (186) and **Avalanche** (75)
add plume/sound. **ORANGES** ships BDB RCS Waterfall templates (`ORANGES/Compatability/WaterfallFX/Templates/`).
This is the deepest chain: *BDB defines → BDB Compat waterfall → BDB_Extras RO/RF (:FINAL) → RSMP/Avalanche plume*.

### Tantares / TantaresLV / TantaresSP
Engines under `TantaresLV` and `TantaresSP/parts/any_engine/*`. Largely self-contained (own Waterfall configs);
external touch is RealPlume-Stock (26 TantaresLV parts) and RSMP.

### Nertea suite (NearFuture* / CryoEngines / CryoTanks / KerbalAtomics / FarFuture)
CryoEngines 19 parts, NearFuturePropulsion 16, NF Aeronautics 15, FarFutureTechnologies 15, KerbalAtomics 9,
NF Spacecraft 6, NF LaunchVehicles 12, CryoTanks 2. **CryoTanks** provides the `boiloff`/hydrolox fuel-switch
`B9_TANK_TYPE`s consumed across the suite; **CryoEngines** injects LH2/LH2O engine-config subtypes.
FarFutureTechnologies and NearFuturePropulsion also *provide* Waterfall templates (13 + 9).

### Tundra / SEP / Starship (StarshipExpansionProject, TundraExploration, SEP)
SEP and FNB define engine **clusters** (`SEP_26_BOOSTER_CLUSTER`, `FNB_*_BOOSTERCLUSTER` — 4 engine modules each,
see §7). StarshipExpansionProject self-patches (642) and provides Raptor/`FossilRCS` templates. TundraExploration
ships 9 bare-`*` global patches and its own tank types (`tundraSupplyOre`).

### AlcoholicAeronautics (AA)
9 engine parts; provides its own `aa-Ethanol`/`aa-EthanolOxidizer` B9 tank types and Ethanol engine-config subtypes.

### KIU (Chinese Launch Vehicles)
74 engine parts, heavily compat-gated: each engine gets RO, RealFuels, Tweakscale, VABOrganizer and Waterfall
patches, most as **`:FINAL`** (e.g. `KIU/.../Compatibility/Waterfall/YF-100.cfg`, `RealFuels/YF-100.cfg`).

---

## 6. Representative chain — stock Reliant (`liquidEngine`)

Ordered by MM apply pass (from `part_patches.tsv`):

```
legacy  RealPlume-Stock  RealPlume-Stock/ReStock/liquidEngine_reliant.cfg
FOR     ReStock          ReStock/PatchesLegacy/Engines/restock-engines-liquid-125.cfg
FOR     TURD             TURD/TU_Standardised_Switching/112x_Standardised_Switching.cfg
FOR     RealPlume-Stock  RealPlume-Stock/MissingHistory/liquidEngineLV-T30.cfg
FOR     RealPlume-Stock  RealPlume-Stock/Squad/liquidEngine_Reliant.cfg
FOR     RealPlume-Stock  RealPlume-Stock/VenStockRevamp/liquidEngine.cfg
FOR     StockWaterfallEffects  StockWaterfallEffects/Engine Configurations/Reliant_Depricated.cfg
AFTER   RealPlume-Stock  RealPlume-Stock/ReStock/liquidEngine_reliant.cfg   (×3)
FOR     TURD             TURD/TU_Stock_Recolour/112x_Standardised_Recolour.cfg
```
Illustrates: model swap (ReStock) → **two competing plume systems** (RealPlume-Stock *and* SWE) → switching/recolour (TURD).

---

## 7. Anomalies

| Anomaly | Count | Detail |
|---|---|---|
| Engine parts with **no Waterfall** module | **306** | many are RealPlume/SmokeScreen-only (stock-style), jets, or ion/nuclear; expected but flagged for GUI |
| Engine parts with **no targeted patch at all** | **106** | self-contained defs; 204 of the no-WF parts *do* still get a targeted patch |
| Parts with **multiple engine modules** (multi-mode/cluster) | **74** | max = **4** on `SEP_26_BOOSTER_CLUSTER`, `FNB_R3_CLUSTER`, `FNB_BL1_BOOSTERCLUSTER`, `FNB_BL0_BOOSTERCLUSTER`; several 3-module LES/fairing parts |
| B9PS subtype overrides **ModuleWaterfallFX** on a part with **no WF module** | **1** | `bluedog_UA120` (`Bluedog_DB/Parts/Titan/bluedog_UA120.cfg`) — subtype DATA targets a module that isn't present |
| B9PS subtype overrides **ModuleEnginesFX** on a part whose engine is plain `ModuleEngines` | **0** | clean |
| `templateName` referenced but **no matching EFFECTTEMPLATE** | **1** | `lemon-srb-2` (consumed by an RSMP/lemon SRB config; provider missing) |

---

## 8. Template provider/consumer matrix

### Most-consumed plume templates
| Template | Uses | Provider mod |
|---|---|---|
| Full | 317 | FLBWF |
| Gimbal | 195 | FLBWF |
| srb-waterfall | 106 | RSMP |
| lemon-SRB-core | 90 | RSMP |
| lemon-srb-sep | 63 | RSMP |
| waterfall-hypergolic-white-upper-1 | 42 | Waterfall (base) |
| Core | 42 | FLBWF |
| waterfall-hydrolox-lower-4 | 28 | Waterfall |
| BDB_SRM_upper | 26 | Bluedog_DB |
| waterfall-kerolox-upper-3 | 23 | Waterfall |
| BDB_RCS_small_1 | 19 | ORANGES |
| BDB_CryoGlow | 17 | Benjee10_Orion |
| BDB_SRMGlow | 15 | Bluedog_DB |

### Template providers (350 EFFECTTEMPLATEs defined)
NCAP 61 · **Waterfall** (base library) 59 · **FLBWF** 56 · Benjee10_Orion 23 · **Bluedog_DB** 19 ·
SterlingSystems 13 · FarFutureTechnologies 13 · StarshipExpansionProject 11 · NearFutureLaunchVehicles 10 ·
NearFuturePropulsion 9 · KODS 8 · Avalanche 8 · TundraExploration 7 · RSMP 6 · KerbalAtomics 6 · FlipNBurn 6.

**Provider vs consumer:** FLBWF and RSMP are *net providers* (their generic `Full`/`Gimbal`/`srb-*` templates are
consumed hundreds of times across other mods' clusters). Waterfall's base library is the shared fuel-chemistry
vocabulary (hydrolox/kerolox/hypergolic). BDB/Benjee10/ORANGES provide BDB-specific glows consumed only within
the BDB family. 350 defined but only **199 consumed** → 151 templates are defined-but-unused in this install
(candidate dead-weight list for the GUI).

---

## 9. Fuel-switcher / B9PS ecosystems

340 engine parts carry `ModuleB9PartSwitch`, 1,645 subtypes total.

### What subtypes override (B9PS `SUBTYPE → MODULE → DATA` targets)
| Target module | Subtype overrides |
|---|---|
| ModuleEnginesFX | 283 |
| ModuleWaterfallFX | 145 |
| ModuleDeployableEngine | 55 |
| ModuleSystemHeatEngine | 26 |
| ModuleGimbal | 18 |
| ModuleRCSFX 3 · ModuleSimpleAdjustableFairing 3 · ModuleCargoBay 2 · ModuleAlternator 1 | — |

So B9PS is used primarily to **re-stat the engine and swap its plume per subtype** (engine + waterfall = 428 of 536
module overrides). Example: `eisenhower_rd191` — 10 subtypes across "Mount" and "Engine Config" switchers, alternating
ModuleEnginesFX/ModuleWaterfallFX overrides per config.

### Common switcher axes (`switcherDescription`)
Mount 83 · Engine Config 82 · Paintjob 64 · Type 19 · Subtype 16 · Housing 12 · Engine Mount 12 · Fuel Switch 11 ·
Plume 8 · TVC Tank 8.

### Tank-type ecosystems (referenced `tankType`)
- **CryoTanks / Nertea**: hydrolox/methalox boiloff types (`LH2`, `LH2O`, `LMOx`, `OX`, `LF`) — the shared cryo standard.
- **Bluedog_DB (`bdb*`)**: `bdbLFOX`, `bdbLMOX`, `bdbLH2`, `bdbLH2O`, `bdbMonoProp`, `bdbX15SCRAM` — BDB-private tank types.
- **AlcoholicAeronautics**: `aa-Ethanol`, `aa-EthanolOxidizer`.
- **SEP**: `SEPLMOX` (11 refs, most-referenced single type). **Tundra**: `tundraSupplyOre`.

These four fuel-switch dialects (Cryo/BDB/AA/SEP) do **not** interoperate — each mod ships its own `B9_TANK_TYPE`
definitions, so the GUI must namespace tank types by provider.

---

## 10. Files for the GUI indexer

| File | Rows | Purpose |
|---|---|---|
| `data/engines.tsv` | 985 | per-part: parentUrl, engine modules/IDs/thrust, WF moduleIDs+templates, B9PS subtypes/targets/tankTypes |
| `data/patches.tsv` | 11,954 | every top-level PART selector: file, mod, op, selector, pass order, NEEDS/FOR/BEFORE/AFTER |
| `data/part_patches.tsv` | ~52k | part → each matching patch file, in MM apply order |
| `data/templates.tsv` | 350+ | templateName → provider parentUrl → consume count |
| `data/global_patches.tsv` | 250 | bare-`*` HAS-gated patches (RealPlume 93, BDB 53, …) applied across all matching engines |
| `data/agg_mod_targets.tsv` / `agg_patcher_counts.tsv` | — | cross-mod patch-relationship aggregates |

**Matcher semantics implemented:** case-insensitive, `*`→`.*`, `?`→`.`, `|` and `,` as alternates; bare `*`
selectors routed to `global_patches.tsv` (they are HAS-gated and would otherwise match all 985 engines).
