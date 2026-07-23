# Plume Editing Suite — Design Proposal

> **Scope decision (user, 2026-07-18): Waterfall ONLY.** RealPlume support is explicitly
> dropped — do not build a RealPlume renderer or editor path. Engines that use RealPlume
> (not Waterfall) simply show the existing "No Waterfall plume configured" note. This keeps
> one render pipeline and one plume data model. `docs/RealPlumeGroundTruth.md` is retained as
> reference only.
>
> **Added asks (same message):**
> - **Good-template library** — study the install's working/high-quality Waterfall templates,
>   extract what makes them good, and offer curated "known-good" starter templates when
>   creating a new plume (so generated configs are good by default).
> - **Startup / ignition effects** — engines like the F-1 and RS-68 have startup-sequence
>   effects (ignition flash, spool-up). Model them fully: implement Waterfall's event/ignition
>   controllers so these effects animate. Suspected link: some "black/vestigial" elements are
>   startup-effect meshes sitting at a controller value of 0 in our static preview; driving the
>   controller (throttle- and ignition-event-bound) should make them render correctly.


Covers the four asks: (1) split-screen layout, (2) drag handles for plume position,
(3) in-editor plume editing that forks templates and generates a B9PS plume-switcher,
(4) managing existing plumes + adding new ones.

The hard part is (3), because "add a plume switch to every engine" collides with a KSP
rule we already documented. The rest is mostly layout + wiring onto systems we have.

---

## 1. Layout — three columns

```
┌ catalog ─┬─ CONFIG (scrolls) ───────────┬─ 3D VIEWER (sticky) ────┐
│ search   │ Engine title / id            │ ┌─────────────────────┐ │
│ filters  │ Part switches (B9PS)         │ │  model + plume      │ │
│ list     │ Engine stats · ISP table     │ │  grid · dims · gizmo│ │
│          │ ── PLUME EDITOR ──           │ └─────────────────────┘ │
│          │ Warnings / tree (collapsed)  │ Heat Throttle Atmo …    │
└──────────┴──────────────────────────────┴─────────────────────────┘
```

The 3D viewer moves out of the scrolling flow into a **sticky right column** so it stays
visible while you edit and while you drag plume handles. The GL context already persists
across detail re-renders (`MODEL_BOX`), so this is a layout change, not a viewer change.
Collapses to stacked single-column under a width breakpoint.

### 1a. Layout & viewer-interaction refinements (user notes)
- **3D viewer is full-height** and scales with the window — not a fixed 340–380px box. It fills
  its column top-to-bottom and grows/shrinks with the screen.
- **Draggable vertical splitter** between the config column and the 3D-viewer column: a grab
  handle on the gutter lets the user widen either side. Persist the chosen width (localStorage)
  across parts and sessions. (Catalog sidebar width can stay fixed, or become a second splitter
  later.)
- **Blender-style camera** in the viewer (extend the existing orbit camera to a pivot model):
  - LMB drag = orbit (current behavior).
  - Wheel = zoom (current).
  - **Shift + MMB drag = pan** — slides the view and moves the orbit pivot with it ("recenter
    yourself" on what you dragged to).
  - **Double MMB click = reset pivot** — recenters back to the model's origin / original framing.
  - Keep it feeling like Blender: pan moves the look-at target; orbit/zoom operate about the
    current pivot; double-middle-click restores the default pivot+distance (frame the model).

## 2. Plume position drag handles

The overlay already draws an axis gizmo (`drawGizmo`) and already has position/rotation/
scale steppers wired bidirectionally to the `EDITS` map. Add **interactive** handles:
raycast the mouse against the three gizmo axis arrows, drag along the constrained axis,
convert the world-space delta into the plume's parent-transform local frame, and feed the
result into the **same `TEMPLATE position` edit path** the steppers already use. So the
gizmo is just a third input method (drag / stepper / text box) onto one value — no new
plumbing, and it moves the plume live. Rotation ring + scale handle are the same pattern
later. This edits the **TEMPLATE** position offset (whole-plume move), which is what the
existing steppers target.

## 3. Plume editing + template forking + B9PS switcher — the core

### Non-destructive editing
Templates are shared (one `EFFECTTEMPLATE` used by many engines — `templates.tsv` has the
usage counts). Editing a plume must **never mutate a mod-shipped template**. So: the moment
you change any field of a shipped plume, the tool **forks** it into a new
`EFFECTTEMPLATE` named `<orig>_ee<hash>` under our ownership, and the engine now references
the fork. Mod templates stay read-only; ours are freely editable.

### How the swap reaches the game — B9PS, exactly like BDB/SEP already do it
We already documented the native mechanism (ARCHITECTURE.md §5b, SEP Raptor / BDB F-1):
a `ModuleB9PartSwitch` whose subtypes carry
`MODULE { IDENTIFIER { name = ModuleWaterfallFX } DATA { TEMPLATE {…} } }` swaps the plume
per subtype. That's our generation target — a switcher titled **"EngineEditor Plume"**:

```
MODULE {
  name = ModuleB9PartSwitch
  moduleID = eePlumeSwitch
  switcherDescription = EngineEditor Plume
  SUBTYPE { name = Default }                 // no override → the shipped plume, untouched
  SUBTYPE {
    name = MyCustomPlume
    MODULE {
      IDENTIFIER { name = ModuleWaterfallFX  moduleID = <the part's WF moduleID> }
      DATA { !TEMPLATE,*{}  TEMPLATE { templateName = MyCustomPlume_eeXXXX  overrideParentTransform=…  position=… rotation=… scale=… } }
    }
  }
}
```
B9PS semantics make "Default" free: a subtype with no DATA leaves the prefab module intact,
and switching away from a custom subtype reloads the prefab — so Default always = the plume
the part shipped with.

### The catch: only ONE B9PS may manage the WF template (aspect lock)
B9PS forbids two modules DATA-targeting the same module aspect (documented in
docs/ModuleManager.md §7 / B9PS notes). So "add our switcher to every engine" is **not**
universally safe. Three cases, and the tool already has the data to tell them apart
(`subtypeOverlays` computes per-subtype WF overrides today):

| Case | Engine | Action |
|---|---|---|
| **A** | No B9PS touches the WF template (most engines, incl. those with fuel/mount/texture switches) | Add a fresh **EngineEditor Plume** switcher. Default + custom subtypes. |
| **B** | An existing switcher already swaps the plume per subtype (BDB F-1, SEP Raptor) | Do **not** add a parallel switcher (would be a fatal aspect-lock error). Instead the editor switches to **per-subtype mode**: you edit the plume of each existing subtype (F-1, F-1B, …) in place, overriding that subtype's own TEMPLATE DATA. |
| **C** | No B9PS at all | Same as A — create the switcher (B9PS module is added wholesale). |

This is the honest, KSP-correct rule, and it's a payoff of the provenance groundwork: the
tool knows, per engine, which case it's in, and the UI adapts (either "＋ Add plume variant"
or "editing the F-1B subtype's plume"). We surface the case to the user, not hide it.

## 4. Storage — a manifest the tool owns, compiled to .cfg

Everything we generate lives in `GameData/zzzz_EngineEditor/` (sorts last, `:FINAL` — beats
every other patch, per our write-path strategy). But the **source of truth** is a manifest
the tool round-trips, not the .cfg (parsing our own generated cfg back is fragile):

```
EngineEditor/data/plume_project.json
{
  "templates": { "MyCustomPlume_eeXXXX": { <full EFFECTTEMPLATE tree, editable> } },
  "engines":   { "bluedog_Saturn_Engine_F1": { case:"B", subtypes:{ F1B:"MyCustomPlume_eeXXXX" } },
                 "someEngine": { case:"A", variants:[ {name:"Default"}, {name:"Blue", template:"…"} ] } }
}
```

A **Compile** action regenerates `zzzz_EngineEditor/templates.cfg` (our EFFECTTEMPLATEs) and
`zzzz_EngineEditor/<engine>.cfg` (the B9PS patches) from the manifest. The manifest is
editable, diffable, and lets "manage existing plumes" (#4) be a real CRUD view. Editing is
always: manifest → live preview → Compile → in-game next launch (then our indexer's
post-launch verify loop confirms it landed, per the write-path strategy).

## 5. Managing plumes (#4)

A **Plume Manager** view (extend the existing plumelib page, or a modal): lists every
template — mod-shipped (read-only, clone-to-edit) and EngineEditor-owned (edit/rename/delete)
— each showing its usage count and which engines reference it (reverse of templates.tsv),
with a live preview. "＋ New plume" clones any template into an editable fork; "Assign to
engine" drops it into an engine's plume switcher. Broken references from
`scan_wf_assets.py` surface here too.

## 5c. Phase-1 spec: the Plume Manager (concrete)

Build the Manager as an evolution of the existing `web/plumelib.html`/`plumelib.js` (already
lists + renders templates via `/api/templates` + `/api/template`). Phase 1 = library browsing +
CRUD on OUR templates + a manifest. NO cfg generation yet (that's phase 2 — the manifest just
stores; nothing is written to GameData in phase 1).

**Manifest (tool-owned source of truth):** `EngineEditor/data/plume_project.json`
```
{ "version": 1,
  "templates": {
     "<customName>": { "base": "<origTemplateName|null>", "tree": { <EFFECTTEMPLATE node JSON {h,k,c}> } }
  },
  "engines": {}   // phase-2: per-engine plume-switch assignments
}
```
A "custom template" is one we own and can edit/rename/delete. Mod/bundled templates (from the
ConfigCache) are READ-ONLY — you clone them to get an editable custom copy.

**Backend (server.py + new `indexer/plume_manifest.py` for load/save/mutate):**
- `GET /api/plume/list` → every template: `{name, source:"mod"|"custom", providedBy, usageCount,
  usedByEngines:[partNames], base}` — mod ones from templates.tsv + the reverse engine map (from
  the engines index / part_provenance), custom ones from the manifest. Deprecated filtered unless `?all=1`.
- `GET /api/plume/get?name=X` → the EFFECTTEMPLATE tree: custom from manifest, mod from ConfigCache
  (via existing `/api/template`). Include `source` + `editable`.
- `POST /api/plume/clone` `{source, newName}` → deep-copy source tree into manifest.templates[newName]
  (base=source), save manifest, return it. Reject name collisions / invalid names (kebab/alnum+dashes).
- `POST /api/plume/rename` `{name, newName}`, `POST /api/plume/delete` `{name}` — custom only.
- `POST /api/plume/save` `{name, tree}` — overwrite a custom template's tree (used later by the editor).
- All mutations write `data/plume_project.json` (pretty JSON, atomic write). Never touch GameData in phase 1.

**Frontend (extend plumelib into the Manager):**
- Left list: templates grouped — **"My plumes" (custom, editable)** section first, then mod templates
  grouped by providing mod. Each row: name, source badge (mod=read-only / custom=editable),
  usageCount + "used by N engines" (hover → list), deprecated dimmed (existing filter).
- Search (existing). "＋ New plume" → pick a base from `data/starter_templates.json` (the curated set)
  OR clone the selected template; prompts for a name; creates a custom template and selects it.
- Selecting a template renders it live (existing PlumeRenderer + throttle/atmo/bloom sliders).
- For a **custom** template: Rename / Delete buttons; the material-param panel edits are enabled and
  "Save" persists to the manifest (`/api/plume/save`). For a **mod** template: params are read-only
  with a "Clone to edit" button.
- Keep the standalone in-viewer preview working; keep `?template=` deep-link.

Phase-1 acceptance: can clone a mod template into "My plumes", rename/delete it, edit its params and
save (persisted in the manifest across reloads), all previewing live. Nothing written to GameData yet.

## 5d. Effect-level editor UX (the "powerful editor")

A template is a stack of EFFECT nodes (core, envelope, shock, film, glow, distort, light…). The
editor must expose them as an editable, understandable list — not a flat wall of params.

**No browser modals.** `prompt`/`alert`/`confirm` are banned (see memory) — every name-entry,
confirm, and picker is a custom in-page dialog/inline form styled to the dark theme. Retrofit the
existing plumelib new-plume/clone/rename/delete flows to custom UI.

**Per-effect accordion list (in the plume editor, plumelib):**
- One collapsible row per EFFECT. Row header = the effect's `name` (click the name to expand/
  collapse the row's body). Show a compact summary on the header when collapsed: shader/role +
  parent transform (e.g. "MainPlume · Additive Dynamic").
- **Enable/disable toggle** per effect (a switch on the header). Disabled effects are excluded from
  the live preview AND from the saved/compiled template. Implement as a soft flag on the EFFECT node
  (a tool-only key, e.g. `_eeDisabled = true`, stored in the manifest tree, stripped at cfg-compile;
  the renderer simply skips flagged effects). Toggling re-renders live.
- Expanded body: the effect's editable params — MATERIAL FLOAT (sliders + numeric, ranges from
  WaterfallShaders.cfg), COLOR (picker + HDR multiplier), shader name (read-only for now), texture
  slot(s); and a list of the effect's MODIFIERs (name, type, controller) — modifier curve editing can
  come next, but at minimum list them so the user sees what drives the effect. Position/rotation/scale
  offsets per effect where present.
- Reorder is nice-to-have later; draw order matters (RenderPasses.md) but leave ordering alone for now.

**Add / remove / duplicate effects (build now if cheap, else stub the buttons):**
- "＋ Add effect" → custom picker to add a new EFFECT (from a small palette of common roles, or
  duplicate an existing one). Duplicate-effect and delete-effect per row.

**Persistence:** all edits (param values, enable flags, added/removed effects) mutate the custom
template's tree and Save (`/api/plume/save`) to the manifest. Live preview reflects the current
(enabled) effect set continuously.

## 5e. Phase-2 spec: apply plumes in-game (compile + assign + Case A)

The payoff: assign a custom plume to an engine → **Compile** → it appears in-game as a switchable
option. First slice = **Case A only** (engines with NO existing plume-switching B9PS). Case B
(engines that already switch plumes — F-1, RL10) is Phase 3.

**Manifest gains an `engines` map:**
```
"engines": {
  "<partName>": { "case": "A", "wfModuleID": "<the ModuleWaterfallFX moduleID>",
                  "variants": [ { "name": "Stock" },                       // default, no override
                                { "name": "<label>", "template": "<customTemplateName>",
                                  "overrideParentTransform": "thrustTransform",
                                  "position": "0,0,0", "rotation": "0,0,0", "scale": "1,1,1" } ] }
}
```

**Case detection (server, from the compiled cache — reuse existing part analysis):** an engine is
**Case A** iff it has ≥1 ModuleWaterfallFX and NO ModuleB9PartSwitch whose SUBTYPEs carry a
`MODULE{IDENTIFIER{name=ModuleWaterfallFX}}` override (i.e. nothing already switches its plume).
Otherwise Case B — for Phase 2, DETECT and REFUSE Case B with a clear "this engine already switches
its plume (Phase 3)" message; do not misgenerate.

**The compile (`indexer/plume_compile.py`, invoked by a `POST /api/plume/compile` endpoint):**
regenerate `GameData/zzzz_EngineEditor/` from the manifest (folder name sorts last → our `:FINAL`
patches win; see docs/ModuleManager.md):
1. `zzzz_EngineEditor/EngineEditor_templates.cfg` — every custom template as
   `EFFECTTEMPLATE { templateName = <name> <EFFECT nodes…> }`. STRIP tool-only keys (`_eeDisabled`)
   and OMIT `_eeDisabled=true` effects entirely (serialize the cfg from the manifest tree; reuse the
   plumelib export-cfg serializer logic).
2. `zzzz_EngineEditor/<part>.cfg` per assigned engine — the Case-A switcher:
   ```
   @PART[<part>]:FINAL   // generated by EngineEditor — do not edit by hand
   {
     MODULE
     {
       name = ModuleB9PartSwitch
       moduleID = eePlumeSwitch
       switcherDescription = EngineEditor Plume
       SUBTYPE { name = Stock }                       // no MODULE override → shipped plume, untouched
       SUBTYPE
       {
         name = <label>
         MODULE
         {
           IDENTIFIER { name = ModuleWaterfallFX  moduleID = <wfModuleID> }
           DATA { !TEMPLATE,*{}  TEMPLATE { templateName = <customTemplate>  overrideParentTransform=<…> position=<…> rotation=<…> scale=<…> } }
         }
       }
     }
   }
   ```
   (One `SUBTYPE` per variant; "Stock" first = default.) The whole `zzzz_EngineEditor/` dir is
   rewritten each compile (idempotent) — delete stale files for removed assignments.
3. VALIDATE before writing (docs/ModuleManager.md §7 lint): `!TEMPLATE,*{}` has braces; the
   `wfModuleID` matches a real ModuleWaterfallFX on the part; every referenced `templateName` exists
   (custom or a real EFFECTTEMPLATE); no name collision with an existing B9PS `moduleID` on the part
   (if `eePlumeSwitch` collides, error). Report violations; refuse to compile a bad assignment.

**Assign UI:** an "Assign to engine" action (from the Manager, or the main editor's Waterfall panel):
pick a target engine (search the engine catalog), confirm it's Case A, add a variant referencing the
selected custom template (with the engine's current plume attach as defaults). A "Compile / Apply"
button calls `/api/plume/compile` and reports what was written; a note that it takes effect next KSP
launch, and that the indexer's post-launch verify loop will confirm it landed.

NO browser modals — assign/compile dialogs are custom UI. Nothing is written to GameData until the
user clicks Compile.

## 5f. Phase-3 spec: Case B (engines that already switch their plume)

Case B engines (F-1, RL10, SEP Raptor, UA120) already have a B9PS whose subtypes override the
ModuleWaterfallFX TEMPLATE. We must NOT add a parallel plume switcher (B9PS aspect-lock: two modules
DATA-targeting the same WF TEMPLATE = fatal). Instead we work INSIDE the existing switcher. Two user
operations, both editing that one switcher:

**(a) Retexture an existing subtype's plume** (e.g. "give the F-1B my custom plume").
**(b) Add a new plume variant** by duplicating an existing subtype and swapping its plume (reuses all
the existing engine config — thrust, meshes, transforms — per the user's "add variants using existing").

**engine-info (extend Phase-2 `/api/plume/engine-info`):** for Case B also return the plume-switching
B9PS `moduleID`, its subtypes list, and per subtype: does it already carry a
`MODULE{IDENTIFIER{name=ModuleWaterfallFX...}}` override (+ its current template/attach), or does it
fall through to the base ModuleWaterfallFX template. Plus the base WF module's moduleID + template.

**Manifest (engines map, Case B):**
```
"<part>": { "case":"B", "b9ModuleID":"engineSwitch", "wfModuleID":"F1",
  "editSubtypes": { "<subtypeName>": { "template":"<custom>", "overrideParentTransform":..,"position":..,"rotation":..,"scale":.. } },
  "editBase": { "template":.., ...} | null,
  "addVariants": [ { "name":"<new>", "copyFrom":"<existingSubtype>", "template":"<custom>", ...attach } ] }
```

**Compile — exact MM patterns (indexer/plume_compile.py; validate each, ModuleManager.md §7):**
- **Edit a subtype that ALREADY has a WF override:**
  ```
  @MODULE[ModuleB9PartSwitch]:HAS[#moduleID[<b9>]] { @SUBTYPE[<sub>] {
    @MODULE:HAS[@IDENTIFIER[ModuleWaterfallFX]] { @DATA { !TEMPLATE,*{}  TEMPLATE { templateName=<custom> overrideParentTransform=.. position=.. rotation=.. scale=.. } } } } }
  ```
- **Edit a subtype with NO WF override (add one):**
  ```
  @MODULE[ModuleB9PartSwitch]:HAS[#moduleID[<b9>]] { @SUBTYPE[<sub>] {
    MODULE { IDENTIFIER { name = ModuleWaterfallFX  moduleID = <wf> }  DATA { !TEMPLATE,*{}  TEMPLATE { templateName=<custom> .. } } } } }
  ```
- **Edit the base/default plume (used by subtypes with no override):**
  ```
  @MODULE[ModuleWaterfallFX]:HAS[#moduleID[<wf>]] { !TEMPLATE,*{}  TEMPLATE { templateName=<custom> .. } }
  ```
- **Add a new variant (copy an existing subtype, rename, swap plume):**
  ```
  @MODULE[ModuleB9PartSwitch]:HAS[#moduleID[<b9>]] { +SUBTYPE[<copyFrom>] {
    @name = <newName>
    <one of the two subtype-edit blocks above, targeting the copy's WF override or adding one> } }
  ```
All emitted in `zzzz_EngineEditor/ee_plume_<part>.cfg` as `@PART[<part>]:FINAL { … }`. LINT: `<b9>`/`<wf>`
moduleIDs exist on the part; `<sub>`/`<copyFrom>` are real subtypes; `!TEMPLATE,*{}` braced;
templateName resolves; the `@MODULE:HAS[@IDENTIFIER[ModuleWaterfallFX]]` selector matches exactly one
MODULE in that subtype (else use the add-a-MODULE form). Refuse + report on any violation.

**UI (Case B branch of the assign flow):** when the picked engine is Case B, show its subtypes; for each,
let the user set a custom plume (operation a) — flag whether it currently has an override or inherits base;
offer "edit base plume" separately; and "＋ Add variant" → pick a subtype to copy + a custom plume
(operation b). Custom dialogs only. Compile/Apply as in Phase 2.

Test against `bluedog_Saturn_Engine_F1` (subtypes F1/F1A/F1V/F1AV/F1B/F1CW; F1B etc. have WF overrides,
F1 base does not) and `bluedog_CentaurD_RL10` (engineSwitch; RL10-B2 uses a variant-specific transform).

## 6. Build order (phased, each independently shippable)

1. **Layout** → three-column split, viewer sticky. Pure CSS/DOM. (small)
2. **Gizmo drag** → interactive position handle onto the existing edit path. (medium)
3. **Fork-on-edit + manifest** → editing a plume forks it; manifest read/write; Compile to
   .cfg for the **Case A** path (fresh switcher) first — it's the common, simple case. (large)
4. **Case B per-subtype mode** → edit plumes of engines that already switch them. (medium)
5. **Plume Manager** → the CRUD/library view. (medium)

Ship 1–2 first (immediate UX win, low risk), then the generation stack 3–5.


## 7. Engine-config VARIANTS — full subtypes (thrust / ISP / heat / fuel + optional plume)

Goal: from the engine editor, add a whole new **engine-config subtype** (like BDB's H1-C / H1-D / H2)
with editable engine stats and propellants, plus an optional custom plume. Same `:FINAL` + B9PS
`+SUBTYPE` machinery as the plume Case A/B path, but the DATA target is the **engine module**
(`ModuleEnginesFX` or `ModuleEngines`) instead of `ModuleWaterfallFX`.

### 7.1 Aspect-lock (which B9PS to write into)
Exactly like plumes. The "engine aspect owner" = a `ModuleB9PartSwitch` on the part with at least one
`SUBTYPE` whose `MODULE{IDENTIFIER{name=ModuleEnginesFX|ModuleEngines} DATA{...}}` overrides the engine
module.
- **>=1 such B9PS exists** -> we MUST `+SUBTYPE` into it (`b9ModuleID` = its moduleID). Minting a parallel
  B9PS that also DATA-targets the engine module is a fatal aspect conflict — refuse.
- **none exists** -> mint our own `ModuleB9PartSwitch moduleID = eeEngineSwitch` with a no-op `Stock`
  default subtype (first => default) + our new subtype. Lint: `eeEngineSwitch` must not already exist.
- **>1 B9PS DATA-targets the engine module** -> ambiguous; refuse with a clear message.

### 7.2 Manifest (data/plume_project.json) — new top-level `engineVariants` (parallel to `engines`)
```
"engineVariants": {
  "<part>": {
    "b9ModuleID": "<existing engine-aspect B9PS moduleID>" | null,   // null => mint eeEngineSwitch
    "targetModule": "ModuleEnginesFX" | "ModuleEngines",
    "subtypes": [ {
      "name":  "<new subtype name>",         // unique vs real subtypes AND other added (letters/digits/space/_/-)
      "title": "<display title>" | "",       // optional
      "copyFrom": "<real subtype name>" | null,   // null => copy part's stock base config
      "fields": {                            // ONLY present keys are written; omit => inherit copyFrom
        "maxThrust": "<num-str>", "minThrust": "<num-str>", "heatProduction": "<num-str>",
        "ispCurve": [["0","289"],["1","257"],["7","0.001"]]     // [] => leave atmosphereCurve untouched
      },
      "addedMass": "<num-str>" | "",         // optional
      "addedCost": "<num-str>" | "",         // optional
      "propellants": [ {"name":"LiquidFuel","ratio":"0.9","DrawGauge":"True"}, ... ] | null,  // null => untouched
      "plume": {"template":..,"overrideParentTransform":..,"position":..,"rotation":..,"scale":..} | null
    } ]
  }
}
```
`load()` gains `data.setdefault('engineVariants', {})`.

### 7.3 plume_manifest.py ops (new)
- `list_engine_variants()` -> `load().get('engineVariants', {})`
- `add_engine_variant(part, b9_module_id, target_module, subtype)` — validate `name` (`_VARIANT_NAME_RE`,
  not "Stock"); require `targetModule`; replace-by-name; append. Persists.
- `remove_engine_variant(part, name)` — drop; if a part has no subtypes left, drop the part key.
Name-collision vs REAL subtypes is enforced at **compile lint** (needs part ctx), not here.

### 7.4 server.py extraction — `engine_variant_info(part)`
Reuse the `extract_block` / `_node_children` / `_node_key` helpers; generalize
`_subtype_wf_override_modules` to any module name (`_subtype_module_overrides(sub, modName)`). Returns:
```
{ part,
  targetModule: "ModuleEnginesFX"|"ModuleEngines"|null,
  base: { maxThrust, minThrust, heatProduction, ispCurve:[[k,v],...], propellants:[{name,ratio,DrawGauge}] },
  engineB9: { moduleID, switcherDescription } | null,   // the single engine-aspect owner (null if none)
  engineB9Count: <int>,                                 // #B9PS that DATA-target the engine module (>1 => refuse)
  b9ModuleIDs: [ ... all B9PS moduleIDs ... ],           // collision lint for eeEngineSwitch
  wfModuleID: "<first ModuleWaterfallFX moduleID>" | "", // for optional per-variant plume
  subtypes: [ { name, title, isBase:false, hasEngineOverride:bool, overrideCount:int,
                maxThrust, minThrust, heatProduction, ispCurve, propellants, addedMass, addedCost } ] }
```
Resolved stats per subtype = base overlaid with that subtype's engine-DATA override (so the UI can
prefill "copy H1-D" with H1-D's real numbers). Include a synthetic `{name:"(stock)", isBase:true, ...base...}`
entry first so the UI can offer "copy the base config".

### 7.5 API endpoints (server.py)
- `GET  /api/variant/info?part=<p>`   -> `engine_variant_info(p)`
- `GET  /api/variant/list`            -> manifest `engineVariants`
- `POST /api/variant/add`  `{part, b9ModuleID|null, targetModule, subtype{...}}`  -> add_engine_variant, return manifest
- `POST /api/variant/remove` `{part, name}` -> remove_engine_variant
Compile is folded into the EXISTING `POST /api/plume/compile`: the handler now also builds
`variant_ctx[part] = engine_variant_info(part)` for every part in `engineVariants`, and passes it to
`compile_all(...)`. Backwards compatible — plume-only manifests behave exactly as before.

### 7.6 plume_compile.py — generation + lint
New file prefix `ee_variant_` (owned/rewritten/pruned like `ee_plume_`). `compile_all` gains a
`variant_ctx` param (default `{}`) and, after the plume loop, emits one `ee_variant_<part>.cfg` per part
in `manifest['engineVariants']` via `engine_variant_cfg(part, ev, variant_ctx[part])`.

`engine_variant_cfg(part, ev, ctx)` -> `@PART[<part>]:FINAL { ... }` containing, per added subtype:

**A) existing B9PS (`ev.b9ModuleID` set AND copyFrom non-null):**
```
@MODULE[ModuleB9PartSwitch]:HAS[#moduleID[<b9>]] {
  +SUBTYPE[<copyFrom>] {
    @name = <newName>
    [ %title = <title> ]
    [ %addedMass = <m> ] [ %addedCost = <c> ]
    <engine-DATA edit block>     // see 7.6.1
    [ <plume MODULE block> ]     // reuse _subtype_edit_block(plume, has_wf_override_of_copyFrom, wfID, ...)
  } }
```

**B) mint our own (`ev.b9ModuleID` null OR copyFrom null):**
```
MODULE {
  name = ModuleB9PartSwitch
  moduleID = eeEngineSwitch
  switcherDescription = EngineEditor Config
  SUBTYPE { name = Stock }                       // no-op => part's stock config, and default (first)
  SUBTYPE {
    name = <newName>
    [ title = <title> ] [ addedMass = <m> ] [ addedCost = <c> ]
    MODULE { IDENTIFIER { name = <engMod> } DATA { <plain field/curve/propellant writes> } }
    [ MODULE { IDENTIFIER { name = ModuleWaterfallFX  moduleID = <wf> } DATA { !TEMPLATE,*{} TEMPLATE {...} } } ]
  } }
```
Note: `copyFrom=null` (copy stock base) always takes the mint path — a fresh B9PS is the only way to
expose "stock vs new" when the part had no config switch.

#### 7.6.1 engine-DATA edit block (case A, editing a copied subtype's DATA of unknown content)
Use MM `%` (edit-or-create) for scalars and `!node{} node{}` replace for curve/propellants, so it works
whether or not `copyFrom` already had that key. If `copyFrom` HAS an engine override MODULE
(`overrideCount==1`): `@MODULE:HAS[@IDENTIFIER[<engMod>]] { @DATA { ... } }`. If it has none: add a fresh
`MODULE { IDENTIFIER { name=<engMod> } DATA { ... } }` (plain writes, new DATA). If `overrideCount>1`: refuse.
```
@DATA {
  [ %maxThrust = <v> ] [ %minThrust = <v> ] [ %heatProduction = <v> ]
  [ !atmosphereCurve {}  atmosphereCurve { key = <k> <v> ... } ]        // only if ispCurve non-empty
  [ !PROPELLANT,*{}  PROPELLANT { name=.. ratio=.. [DrawGauge=..] } ... ] // only if propellants non-null
}
```
(In the **mint/new-DATA** path these are plain `maxThrust = v`, `atmosphereCurve {...}`, `PROPELLANT {...}` —
no `%`/`!` needed since the DATA is brand new.)

#### 7.6.2 lint (`_validate_engine_variants`, called from `validate`)
- `ctx.targetModule` present (part has an engine module) — else refuse.
- `ev.targetModule == ctx.targetModule`.
- `ctx.engineB9Count <= 1` — else "ambiguous engine-config B9PS; refused".
- If `ev.b9ModuleID` set: it == `ctx.engineB9.moduleID`; every `copyFrom` (non-null) is a real subtype;
  `copyFrom`'s `overrideCount <= 1`.
- If mint path taken (`b9ModuleID` null or any `copyFrom` null): `ctx.engineB9` is null (nothing else owns
  the engine aspect) AND `eeEngineSwitch` not in `ctx.b9ModuleIDs`.
- new `name` unique vs real subtype names (from ctx) AND vs other added names; not "Stock".
- `ispCurve` keys/values numeric; `propellants[].name` non-empty, `ratio` numeric; scalar fields numeric.
- If `plume` set: part has a `wfModuleID` (`ctx.wfModuleID` non-empty) and `plume.template` in known_templates.
- Refuse (write nothing) on any violation — same contract as plumes.

### 7.7 UI (engine editor, app.js + style.css) — demo-style, plume stays on Library page
- Catalog list items get **WF** and **B9xN** chips (mockup `.chip.wf` / `.chip.b9`).
- Config column: a **variant tab strip** (`.petabs`) listing the engine-config B9PS subtypes
  (Default/shipped + each) + a `+ New variant` tab. Selecting a shipped subtype just drives the existing
  B9PS selector; `+ New variant` opens the **variant editor form** (name/title, thrust/min/heat steppers,
  ISP table reusing the isptable widget, addedMass/Cost, an editable PROPELLANT list, and an optional
  "custom plume" picker that links to the Library). Save -> `/api/variant/add` then a status line telling
  the user to Compile in the Manager. Remove tab -> `/api/variant/remove`.
- A **Case-B-style banner** when the part already has an engine-config B9PS ("this engine already switches
  configs; a new variant is added to its existing switch") vs. when we'll mint one.
- Custom in-page UI only — no native dialogs.


### 7.8 Model-element (transform) show/hide for variants + UI integration

B9PS subtypes show/hide meshes via repeated `transform = <name>` keys. A subtype makes its listed
transforms visible and hides transforms that OTHER subtypes list but it does not. The "switchable pool"
for a part = the union of all `transform=` values across the engine-config B9PS's subtypes. A variant
picks a SUBSET of that pool (checked = shown; unchecked pool members are auto-hidden by B9PS).

**Extraction (`engine_variant_info`) additions:**
- top-level `transformPool: [ ...unique transform names across the engine-aspect B9PS subtypes... ]`
  (`[]` if no engine B9PS or none use transforms).
- each `subtypes[]` entry gains `transforms: [ ...that subtype's own transform= values... ]`
  (the synthetic `(stock)` entry gets `transforms: []`).

**Manifest schema (§7.2 subtype):** add `"transforms": [ <names> ] | null`
(null/absent ⇒ inherit copyFrom for the +SUBTYPE path, or none for the mint path). `_clean_variant_subtype`
normalizes: a list of non-empty strings, or None.

**`/api/variant/add` payload:** `subtype.transforms` carries the checkbox selection (array; may be `[]`
meaning "hide all pool meshes"; omit/null ⇒ inherit).

**Compile generation:**
- Existing-B9PS `+SUBTYPE[copyFrom]` path: if `transforms` is a LIST (incl. empty), the copied subtype's
  transforms must be reset then re-set. Emit, inside the `+SUBTYPE` body (right after `@name`):
  `!transform,*` (delete ALL copied transform keys — verify this multi-value-delete syntax against
  docs/ModuleManager.md; use the repo's documented form) then one `transform = <name>` per checked entry.
  If `transforms` is null/absent ⇒ emit nothing (inherit copyFrom's).
- Mint path: the new SUBTYPE emits `transform = <name>` per checked entry (no delete; brand-new subtype).
  The `Stock` subtype emits none.

**Lint (`_validate_engine_variants`):** if `transforms` is a non-empty list, every name must be in
`ctx.transformPool`; if the pool is empty, refuse with "no switchable model elements known for this part".
Empty list `[]` is always allowed (means hide-all).

### 7.9 UI integration + reorder (app.js) — user decision 2026-07-19
- **Move the variants block to the TOP** of the config column (before Part/Engines/Waterfall).
- **Unify** it with the B9PS part-switch selectors into one "Variants & switches" section:
  - The engine-config B9PS's subtypes render as the `.petabs` tab strip AND are the LIVE selector:
    clicking a shipped-subtype tab sets `SUBSEL[<engineB9 moduleID>]` to that subtype's index and calls
    `refresh()` (updates the 3D model). Highlight the active tab. This REPLACES the old dropdown for the
    engine-config switch (`renderSwitchers` no longer renders that one).
  - All OTHER B9PS switches (insulation, fuel, …) render as compact dropdowns in the SAME section
    (reuse the `renderSwitchers` row markup, but skip the engine-config B9PS moduleID).
  - `+ New variant` tab + EE variant tabs + the variant form stay as-is, now at top.
- **Variant form gains a "Model elements" control:** a checkbox per `info.transformPool` entry, prefilled
  from the copy-from subtype's `transforms` (checked = present in that subtype). Include the checked set as
  `subtype.transforms` in the Save payload. Hide the control entirely when `transformPool` is empty.


### 7.10 Per-variant plume selection (configurable in the main editor form)

The variant form must let the user pick a plume template for the variant (not just "customize via Library").
Backend already stores `subtype.plume` and generates a WF override; this makes it selectable + correct for
Case-B copy-from (whose copied subtype ALREADY has a WF override → must edit-in-place, not double-add).

**Extraction (`engine_variant_info`) additions:**
- top-level `basePlume: {template, overrideParentTransform, position, rotation, scale} | null` — the part's
  first ModuleWaterfallFX first TEMPLATE + attach (via `_template_and_attach`); null if no WF.
- each `subtypes[]` entry gains `hasWfOverride: bool`, `wfOverrideCount: int`
  (`_subtype_module_overrides(sub, 'ModuleWaterfallFX')`), and `plume: {template, ...attach}` = the
  subtype's own WF override template/attach if it has one, else `basePlume`. `(stock)` → `basePlume`.

**Generation (`engine_variant_cfg`):** the existing-B9PS `+SUBTYPE[copyFrom]` plume block must branch on
copyFrom's WF-override state (from `ctx.subtypes` detail): `wf_ovr = hasWfOverride and wfOverrideCount==1`;
call `_subtype_edit_block(s['plume'], wf_ovr, wf, 3)`. Mint path keeps `has_override=False` (fresh subtype).

**Lint:** if `plume` set — part must have a WF module (existing check), `plume.template` ∈ known_templates,
and for the +SUBTYPE path copyFrom `wfOverrideCount <= 1` (else refuse: ambiguous WF override).

**Frontend (variant form):** replace the "not set here" note with:
- a template picker (datalist input listing custom templates from `/api/plume/list` + mod templates from
  `/api/templates`), with an empty "(inherit copy-from's plume)" default;
- attach offset inputs (overrideParentTransform, position, rotation, scale) shown when a template is chosen,
  prefilled from the copy-from subtype's `plume` attach; re-prefilled when copy-from changes;
- Save payload `subtype.plume = template ? {template, overrideParentTransform, position, rotation, scale} : null`.


## 8. Variant-scoped layout v2 + per-variant model scale + integrated plume search (2026-07-22)

### 8.1 Research: per-variant part scale
`rescaleFactor` / part `scale` are PART-level compile-time fields — B9PS **cannot** switch them.
What B9PS DOES support per-subtype: `TRANSFORM { name = <t> positionOffset / rotationOffset /
scaleOffset }` (widely used in this install: 4165 `scaleOffset` occurrences in ConfigCache, e.g.
StarshipLaunchExpansion engine shields). So per-variant scale = emit a `TRANSFORM` block with
`scaleOffset` per model root transform. Limitations to surface in the UI: attach nodes, colliders
behave per B9PS semantics (mesh children scale; node positions do NOT move) — label it "Model scale
(visual)".

### 8.2 Manifest schema (§7.2 subtype) additions
- `"modelScale": "<num-str>" | ""` — empty ⇒ no TRANSFORM scale blocks. Uniform scale only (one number).
- `_clean_variant_subtype` normalizes (numeric string or '').

### 8.3 Extraction additions (`engine_variant_info`)
- top-level `rootTransforms: [ ... ]` — the part model's top-level transform name(s), derived the same
  way the 3D viewer resolves the model (modelcache); `[]` if unknown.
- each shipped `subtypes[]` entry gains `scaleOffsets: { <transformName>: <num> }` (parsed from its
  TRANSFORM blocks; usually empty) so copy-from can prefill.

### 8.4 Generation (`engine_variant_cfg`)
If `modelScale` non-empty and `ctx.rootTransforms` non-empty: per root transform emit inside the
SUBTYPE body:
```
TRANSFORM { name = <root>  scaleOffset = <modelScale> }
```
+SUBTYPE (copy-from) path: prefix with `!TRANSFORM,* {}` ONLY when copy-from itself had TRANSFORM
blocks (from `scaleOffsets`), so we replace rather than stack. Mint path: plain blocks.
Lint: `modelScale` numeric and > 0; if set but `rootTransforms` empty ⇒ refuse ("model root unknown").

### 8.5 Layout v2 (app.js) — variant-scoped everything
- The variant tab strip stays at top. EVERYTHING below it lives in ONE bordered panel headed
  `Variant: <activeTabName>` (`.variant-scope`), so it reads like the real config: tab = subtype,
  panel = that subtype's resolved config. Part-level info (part title, model, non-engine switches)
  stays ABOVE/OUTSIDE the panel.
- The panel shows for the ACTIVE tab: stats table, propellants, model elements, **and a "Plume" row**
  naming the template that subtype resolves to (`subtypes[].plume.template` or basePlume) with source
  badge (mod / custom / inherited). This answers "which plume goes with this variant" at a glance.
  The 3D preview already follows the tab (VARIANT_PREVIEW) — keep that wired.
- Editing any field in the panel affects ONLY the active EE-added variant (shipped subtypes stay
  read-only; their tabs just drive B9PS + preview). Read-only cells get a muted style, not inputs.

### 8.6 Integrated plume search (replaces the bare datalist)
A `.plume-picker` popover (custom in-page UI, no native dialogs): a search input + grouped result list
(Custom / Mod templates), filter-as-you-type on template name AND source mod name; each row shows name,
source badge, and (for customs) base template. Arrow keys + Enter select; Esc closes. Used in the
variant form AND anywhere else a template is picked. Data: `/api/plume/list` + `/api/templates`.

### 8.7 Auto-fork inline editing (drawer)
From the variant panel's Plume row: an `Edit plume ✎` button that NEVER leaves the page:
- if the variant's template is already a CUSTOM template → open the existing §10 drawer on it directly;
- if it's a MOD template (or inherited) → **auto-fork**: create a custom copy named
  `<part>_<variantName>` (dedupe with numeric suffix via existing validate_name), assign it as the
  variant's `plume.template`, then open the drawer on the fork. One click: fork + assign + edit.
- Drawer saves keep updating the live on-engine preview (inlineTree path) — the plume must visibly
  change on the engine as it is edited. The Library page remains for standalone plume work.


## 9. Engine-editor-first: inline plume editor, silent fork, sub-tabs (user decisions 2026-07-22)

Supersedes the §8.7 drawer as the PRIMARY editing surface (the drawer code may be removed or reused as
the inline mount; do not keep two divergent editors). User verdict on §8 delivery: works, layout wrong.

### 9.1 Variant panel gets sub-tabs: Engine / Model / Plume
Inside `.variant-scope`, a small tab row replaces the flat scroll:
- **Engine**: stats table (thrust/min/heat), ISP curve table, propellants.
- **Model**: model elements (transform checkboxes), Model scale (visual).
- **Plume**: the plume section (9.2).
Shipped subtypes: same sub-tabs, read-only content. The old separate "Engines" and "Waterfall" config
sections MOVE INTO this panel (they no longer render as standalone sections below it — the variant
panel with sub-tabs IS the config UI now). Part-level-only info (part title, description, non-engine
switches) stays outside as before.

### 9.2 Inline plume editor (replaces the drawer as primary)
The Plume sub-tab shows: template name + source badge + search picker (§8.6) + the FULL Library-style
editor (PlumeEdit module: effect toggles, add-effect palette, accordion, materials, curves — literal
parity, same markup/CSS as the Library page) expanded IN PLACE in the panel. No overlay/drawer.
Live on-engine preview via the existing inlineTree path while editing. Same editor mount for the
Library page and here — one PlumeEdit, two mounts (this was the original plumeedit.js design goal).

### 9.3 Silent auto-fork with badge
When the user modifies ANY plume edit control while the variant's template is a mod/inherited one:
- fork immediately + quietly via /api/plume/fork (name `<part>_<variant>`, deduped), assign to the
  variant, apply the pending edit to the fork — NO status text, NO interruption.
- the plume row/template field updates to the fork name at once, plus a small `customized` badge
  (`.srcbadge.customized`) so the fork is visible at a glance. Editing a template that is already
  custom never re-forks.
- Read-only shipped subtypes: plume sub-tab content is read-only; no fork-on-edit (controls disabled).

### 9.4 Engine editor is the app
- Landing page = engine editor. The Plume Library becomes a secondary tab (top-level nav: Engines |
  Plume Library | Manager if one exists — collapse Manager INTO the engine editor header if it's
  only compile/apply).
- **Compile / Apply to GameData** button in the engine editor header (same endpoint the Manager used),
  with its result/lint output shown in-page (custom UI, no native dialogs).


## 10. Waterfall for engines WITHOUT it (mint) + attach-transform picker (2026-07-22)

Motivating part: `libra_lv_engine_s7p5_1` (TantaresLV N1 block, 7.5m cluster) — 30 `thrustTransform`s
in the .mu, NO ModuleWaterfallFX, has a non-engine B9PS (b9=1). User goal: add custom plumes to it.

### 10.1 Mint a ModuleWaterfallFX when the part has none
When a variant sets a plume and `ctx.wfModuleID` is empty, `engine_variant_cfg` additionally emits a
part-level module (once per part, not per variant), before the B9PS section:
```
MODULE
{
  name = ModuleWaterfallFX
  moduleID = eeWaterfall
  CONTROLLER { name = atmosphereDepth  linkedTo = atmosphere_density }
  CONTROLLER { name = throttle         linkedTo = throttle }
  CONTROLLER { name = random           linkedTo = random  range = -1,1 }
  TEMPLATE { templateName = <first plume-carrying variant's template> + its attach }
}
```
- Per-variant plumes then target `wf = eeWaterfall` with the usual `_subtype_edit_block`
  (has_override=False — the copied/minted subtypes have no WF override).
- Subtypes WITHOUT a plume (incl. the minted `Stock`) must not show the base plume: emit inside them
  `MODULE { IDENTIFIER { name = ModuleWaterfallFX  moduleID = eeWaterfall }  moduleActive = false }`
  (B9PS's module enable/disable — verify the exact key against B9PS docs/real usage in ConfigCache;
  if real-world usage differs, follow the real-world form). For the existing-B9PS path, also patch
  each SHIPPED subtype with the same moduleActive=false block via `@SUBTYPE[<name>]` edits so stock
  configs stay visually stock.
- Lint additions: minted WF only when ≥1 variant has a plume; `eeWaterfall` must not collide with
  existing moduleIDs; refuse plume variants on parts with no engine module as before.
- Manifest: no schema change (wfModuleID stays derived). Extraction: `engine_variant_info` returns
  `wfModuleID: ""` as today; frontend uses `eeWaterfall` as the implied target when empty.
- Frontend: the variant form's Plume tab must WORK when `info.wfModuleID` is empty (today it's
  disabled with "no Waterfall module" note): allow template pick + inline editor; live preview must
  render the template on the model even though `waterfallModules()` finds none — updatePlumes gains a
  synthetic-module path driven by VARIANT_PREVIEW when the part tree has no ModuleWaterfallFX.
  Default attach transform: the most-common thrust-like transform name in the model (see 10.2).

### 10.2a (see §11 below for plume packs)

### 10.2 Attach-transform picker
Wherever `overrideParentTransform` / "Attach to transform" is edited (variant form, §7.10 attach
fields), replace the bare text input with a text input + datalist (or small picker) listing the
part model's transform names from `/api/model`, annotated with match counts —
e.g. `thrustTransform (×30)`. Keep free-text entry allowed. Data via the existing
computeAllTransforms map (client-side); no new endpoint required.


## 11. Plume packs — share/import custom plumes as a zip (2026-07-22)

Goal: a friend can send you their custom plumes; importing "weaves" them into every template
picker as ordinary custom templates. Stdlib only.

### 11.1 Pack format
Zip containing `plumepack.json`:
```
{ "format": "cascade-plumepack/1",
  "exportedBy": "<free-text, optional>",
  "templates": { "<name>": { "base": "<source template or null>", "tree": {h,k,c} }, ... } }
```
Exactly the manifest's `templates` sub-structure (tree = full EFFECTTEMPLATE). No engineVariants
in v1 (they're part-specific; plumes are portable).

### 11.2 Server endpoints
- `GET /api/plume/export?names=a,b,c` (empty names ⇒ all customs) → application/zip download
  (`Content-Disposition: attachment; filename=cascade-plumes.zip`), built in-memory (io.BytesIO+zipfile).
- `POST /api/plume/import` (body: raw zip bytes) → parse, validate format string, then per template:
  dedupe name via the existing dedupe_name (imported `foo` collides ⇒ `foo_2`), normalize the tree's
  templateName key to the final name, preserve `base`. Returns
  `{imported: [{name, finalName, base, baseMissing:bool}], skipped: [..reasons..]}` where baseMissing
  = base is non-null and not in (mod templates ∪ customs) — template still imports (it is
  self-contained; base is provenance only) but the UI shows a warning badge.
- Malformed zip/json ⇒ 400 with a clear error; never partially write (validate all, then save once).

### 11.3 UI (Library page header + engine editor reachable via Library)
- "Export pack" button: multi-select of custom templates (checkbox list, custom in-page UI;
  default all) → triggers the zip download via a plain <a download> navigation.
- "Import pack" button: <input type=file accept=.zip> (hidden, triggered by the button) → POST →
  in-page summary: N imported (renames listed as `foo → foo_2`), baseMissing warnings. Pickers/caches
  refresh (invalidatePlumeListCache + list reload) so imported plumes appear immediately everywhere.
