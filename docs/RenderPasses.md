# KSP + Waterfall render-pass anatomy (for the EngineEditor WebGL viewer)

Scope: **rendering pipeline only** — pass ordering, render queues, blend/depth state,
color space, HDR, and post-processing. Transform/coordinate/skinning topics are covered
by a sibling document; not repeated here.

All line numbers below are from the local clone at
`C:\Users\goelr\AppData\Local\Temp\claude\...\scratchpad\Waterfall` (Waterfall source,
git clone of https://github.com/post-kerbin-mining-corporation/Waterfall) and the local
KSP install's `GameData/TUFX`.

---

## Q1. Full per-frame pass order

KSP's flight camera runs Unity's **built-in (non-SRP) forward/legacy render pipeline**
with a `PostProcessLayer` (v2 post-processing stack) driven by TUFX. One frame, in order:

1. **Opaque queue** (`Background`…`Geometry`, render queue ≤ 2500): part meshes, terrain,
   skybox-adjacent opaques. Standard opaque depth-write pass. (Not Waterfall's concern —
   noted only so the ordering below is anchored.)
2. **Transparent queue** (`Queue > 2500`, sorted **back-to-front by camera distance**,
   ties broken by ascending queue index — this is standard Unity behavior, not
   Waterfall-specific): this is where **every Waterfall plume material lives**.
   Waterfall assigns explicit integer queue values every `LateUpdate`, and it's these
   integers — not just "Transparent" — that determine draw order among plume layers:
   - `Settings.TransparentQueueBase = 3000` is the base
     (`Source/Waterfall/Settings.cs:26`).
   - Every frame, `ModuleWaterfallFX.SetupRenderersForCamera()` computes, per renderer,
     `qDelta = QueueDepth - clamp(min(camDistBounds, camDistTransform) * queueScalar, 0, QueueDepth)`
     where `queueScalar = QueueDepth / SortedDepth` (`QueueDepth = 750`,
     `SortedDepth = 1000f`) — i.e. **farther-from-camera renderers get a smaller queue
     delta, nearer ones a larger one**, so within the shared 3000-3750 band Unity's
     back-to-front sort and Waterfall's own explicit queue assignment agree
     (`Source/Waterfall/Modules/ModuleWaterfallFX.cs:198-229`).
   - **Alpha-blended shaders are pushed one queue slot later than additive ones** at
     the same camera distance (`qDelta += 1` when `!hasAdditiveShaders ||
     mat.HasProperty(_Intensity)`, `ModuleWaterfallFX.cs:224-225`) — i.e. Waterfall
     deliberately draws **additive layers first, then alpha-blended layers**, per
     module, before the standard distance sort takes over between modules.
   - If a whole module's shaders are all the same blend family, Waterfall computes
     **one shared queue value for every renderer in that module** instead of sorting
     per-mesh (`allShadersAreSameType` fast path, `ModuleWaterfallFX.cs:200,211-213`) —
     meshes inside one plume effect generally do NOT get individually depth-sorted
     against each other; only whole effects are.
   - Distortion-shader materials (`_Strength` property present) are pulled out of this
     dynamic system entirely and pinned to a **constant** queue,
     `Settings.DistortQueue = TransparentQueueBase + 2 = 3002`
     (`Settings.cs:27`, `ModuleWaterfallFX.cs:141-150`) — see step 3.
   - If there are zero alpha-blended plume shaders anywhere in the scene, Waterfall
     skips the whole per-frame distance-sort pass and resets queues to `-1` (shader
     default) (`ModuleWaterfallFX.cs:176-189`) — a pure-additive scene degrades to
     plain "Transparent" queue + Unity's own distance sort.
3. **Distortion / GrabPass pass**, queue **3002** (`Transparent+2`), i.e. drawn
   **after most plume additive/alpha layers but still inside the transparent queue**
   (`Distort Dynamic.shader:204`, Tags `"Queue"="Transparent+2"`). Mechanically this
   shader:
   - Has a `GrabPass { "_BackgroundTexture" }` block, which makes Unity insert an
     **extra full-screen copy of the current color buffer** immediately before this
     shader's own draw call executes, once per unique `GrabPass` shader that has
     objects queued at that point (`Distort Dynamic.shader:206-209`). This is a
     genuine intermediate off-screen blit — order-dependent: only what has already
     been drawn (opaques + earlier/lower-queue transparents) is visible to the grab.
   - Renders in **two passes**, `Cull Front` then `Cull Back` (back face, then front
     face) so the screen-space refraction reads correctly for a camera embedded in or
     outside the distortion volume (`Distort Dynamic.shader:211-232`).
   - The fragment shader offsets `screenUV` by a swirl/noise vector and resamples the
     grabbed background with a 5×5 weighted blur, i.e. **it is not adding light of its
     own** — it warps/blurs whatever was already drawn beneath it
     (`Distort Dynamic.shader:170-197`).
4. **Post-processing (TUFX / PostProcessLayer v2)**: AmbientOcclusion → AutoExposure →
   Bloom → ColorGrading/Tonemapping → Antialiasing, per the active `TUFX_PROFILE`
   (`GameData/TUFX/Profiles/TUFX-Default.cfg`). This runs after the entire scene
   (opaque + transparent + distortion) is drawn, operating on the camera's HDR color
   target. Bloom here is what turns Waterfall's >1.0 emissive output into visible
   blown-out highlights (see Q3).

**Net ordering for one plume**: opaques → [same-module additive plume layers,
distance-sorted vs. other modules] → [alpha-blended plume layers, one queue slot
later] → [distortion/heat-shimmer GrabPass passes, pinned to queue 3002] → bloom/tonemap/AA.

---

## Q2. Color space

Stock KSP runs **Gamma color space**, not Linear. Evidence, since this isn't spelled
out in a single doc:

- Unity's `PlayerSettings.colorSpace` **defaults to Gamma** on every platform unless a
  project explicitly opts into Linear (Unity Manual, "Set a project's color space" —
  linear must be deliberately enabled and was historically DX11/PC-only;
  https://docs.unity3d.com/6000.0/Documentation/Manual/set-project-color-space.html).
  KSP predates widespread Linear adoption (Unity 2019.4 LTS) and ships no evidence of
  opting in.
- All the Waterfall surface shaders read `IN.color` (vertex color) and multiply it
  directly into `o.Emission`/`o.Albedo` with no `GammaToLinearSpace`/sRGB decode calls
  anywhere in `Source/ShaderLab/*.shader` — consistent with a Gamma-space project,
  where Unity does not silently reinterpret texture/vertex-color reads.
- The legacy KSP-authored include this codebase depends on is literally named
  `SquadCore/LightingKSP.cginc`, part of Squad's original (2015-era, Unity 5.x, Gamma
  default) rendering path — never replaced with an SRP/URP/HDRP-era linear lighting
  model.
- `EngineEditor/web/model3d.js:243` (`col = pow(clamp(col,0,1), vec3(1.0/2.2))`) already
  independently assumes the model viewer's own lit part shading should end in a gamma
  encode before the framebuffer — i.e. our own codebase's working assumption for the
  static-mesh path matches "gamma output," and the plume path should be treated the
  same way for consistency.

**Practical implication for shader math:** `_StartTint`/`_EndTint` and texture reads in
the Waterfall shaders are **not** linearized before being multiplied/added — they are
gamma-space (perceptual) RGB values combined directly. Our WebGL viewer's plume
fragment shader should therefore do all of its blending, additive stacking, and Reinhard
tonemapping (see `web/plume.js:196-214`) in the **same raw gamma-encoded space the
textures/tints arrive in** — do not linearize `_StartTint`/texture samples before
combining, and do not apply an extra gamma encode after tonemapping unless the final
canvas/backbuffer itself expects linear input (a plain WebGL2 canvas with no
`colorSpace`/`framebufferAttachment` overrides is effectively "whatever you write is
what you get," i.e. already gamma/sRGB-equivalent for direct display — matching KSP's
own non-linear working space). This is good news: it means the current implementation's
choice to skip any linear<->gamma conversion in `plume.js` is actually *correct*, not an
oversight — see Deviations checklist.

---

## Q3. HDR camera + bloom expectations

- **`_ClipBrightness` 50 vs 1 under HDR** — confirmed, `WaterfallEffect.SetHDR()`:
  ```csharp
  // Source/Waterfall/Effects/WaterfallEffect.cs:448-459
  public void SetHDR(bool isHDR)
  {
    float destMode = Settings.EnableLegacyBlendModes ? 6 : 1;
    foreach (var mat in effectRendererMaterials)
    {
      if (mat.HasProperty(ShaderPropertyID._DestMode))
      {
        mat.SetFloat(ShaderPropertyID._DestMode, isHDR ? 1 : destMode);
        mat.SetFloat(ShaderPropertyID._ClipBrightness, isHDR ? 50 : 1);
      }
    }
  }
  ```
  This only affects the **`(Dynamic)` shader family**, which is the only family that
  exposes `_DestMode`/`_ClipBrightness` as material properties (`Additive Dynamic.shader:16,42-43`,
  `Additive Cones Volumetric.shader:16`). Non-dynamic shaders (`Additive.shader`,
  `Additive Directional.shader`) hardcode their own clamp ceiling directly in the
  `.shader` file instead — `Additive Directional.shader:110` clamps emission to
  `(0, 50)` unconditionally (always HDR-range), while plain `Additive.shader:105` uses
  `saturate()` (0-1) unconditionally, i.e. **it never expects HDR headroom at all** and
  is meant to be pre-tonemapped/LDR-safe on its own.
- **HDR is driven from the live flight camera, not a Waterfall setting**:
  ```csharp
  // Source/Waterfall/Modules/ModuleWaterfallFX.cs:242-246
  var camera = FlightCamera.fetch.cameras[0];
  bool changeHDR = camera.allowHDR != isHDR;
  if (changeHDR) isHDR = !isHDR;
  ```
  Waterfall polls `Camera.allowHDR` every `LateUpdate` and reacts if it changes (e.g.
  from a TUFX profile swap) rather than forcing it — it is a **consumer** of the
  camera's HDR flag, never a producer.
  `EnableLegacyBlendModes` (default `false`, `Settings.cs:33`) swaps the non-HDR
  `_DestMode` between `1` (`One`, i.e. `Blend One One` — pure additive, matches the
  `.shader` file default) and `6` (`OneMinusSrcColor`, a softer highlight-preserving
  additive blend) for the small subset of installs that opt into it.
- **KSP's flight camera runs HDR by default** because every gameplay-relevant TUFX
  profile in `GameData/TUFX/Profiles/TUFX-Default.cfg` sets `hdr = True`
  (`Default-Flight`, `Default-KSC`, `Default-Internal`, `Default-Tracking`,
  `Default-MainMenu`, `Default-Editor` all declare `hdr = True`; only the inert
  `Default-Empty` profile omits it). TUFX is a bundled stock dependency as of modern
  KSP releases, so this is effectively KSP's real default, not just a mod's opinion.
- **Default bloom parameters** — from `Default-Flight` (the profile active during
  normal flight, the scene Waterfall plumes render in) and its siblings:
  ```
  // GameData/TUFX/Profiles/TUFX-Default.cfg — Default-Flight (lines 122-146)
  EFFECT { name = Bloom; Intensity = 2; SoftKnee = 0.65 }   // Threshold unset -> Unity Bloom's own default (1.1 in PPv2 Bloom)
  ```
  MainMenu/Tracking profiles are more aggressive: `Intensity = 3.0, Threshold = 0.95,
  SoftKnee = 0.65, Diffusion = 5-10`. There is also an `AutoExposure` effect active in
  every HDR profile (no override params shown — uses PPv2 AutoExposure defaults),
  meaning the *effective* exposure feeding bloom is auto-adjusted, not a fixed multiplier —
  our viewer's fixed Reinhard tonemap curve is a simplification of this (see Deviations).
  A user-authored profile (`GameData/Blackrack_TUFX.cfg`) shows how far these can be
  pushed in practice: `Bloom { Intensity = 5.6, Threshold = 1.43, SoftKnee = 0.46 }`
  alongside a custom-tonemapper `ColorGrading` block — i.e. the "intended" plume
  brightness is profile-dependent and can vary several-fold; `_ClipBrightness=50` gives
  Waterfall's shaders enough headroom to look correct across that whole range without
  clipping before bloom sees the value.

---

## Q4. Blend / depth / cull state per shader family

All `Tags{"Queue"=...}` values are the *declared* default; Waterfall/KSP override the
actual runtime `material.renderQueue` integer per Q1 (except `Distort Dynamic`, whose
`Transparent+2` tag **is** literally its runtime queue, since it's excluded from the
dynamic distance-sort).

| Shader (`.shader` file) | Declared Queue | Blend | ZWrite | ZTest | Cull | Notes |
|---|---|---|---|---|---|---|
| `Additive.shader` | Transparent | `SrcAlpha One` | Off | LEqual | Off | `o.Emission` clamped via `saturate()` (0-1) — no HDR headroom |
| `Additive Directional.shader` | Transparent | `One One` | Off | LEqual | Off | Emission `clamp(...,0,50)` — always HDR-range regardless of camera |
| `Additive (Dynamic).shader` | Transparent | `[_SrcMode][_DestMode]` (defaults `1`,`6`) | Off | LEqual | Off | Blend ops driven by material floats set from `SetHDR()`; `_ClipBrightness` (default 50, prop) drives the emission clamp |
| `Additive Cones Volumetric.shader` | Transparent | `One One` | Off | LEqual | Off | `_ClipBrightness` exposed as a Properties slider too (default 50) |
| `Alpha Directional.shader` | Transparent | `SrcAlpha OneMinusSrcAlpha, One One` (separate RGB/alpha blend ops) | Off | LEqual | **Back** | Only family/pair that culls back faces |
| `Alpha (Dynamic).shader` | Transparent | `SrcAlpha OneMinusSrcAlpha, One One` | Off | LEqual | **Back** | Same dual-blend-op pattern as Alpha Directional |
| `Distort Dynamic.shader` | **Transparent+2** (pinned, = 3002) | n/a (GrabPass resample, no Blend state declared — writes final color directly) | Off | *(none declared → default Always for this SubShader; no ZTest line present)* | Front then Back (2 passes) | Has `GrabPass`; two-pass front/back |
| `Billboard (Additive).shader` | Transparent | `One One` | Off | *(none — no ZTest line)* | Off | Also `AlphaTest Greater .01`, `Fog{Color(0,0,0,0)}`; legacy (non-surface) shader; output `clamp(col*_StartTint*2.0, 0, 50)` |
| `Billboard (Additive Directional).shader` | Transparent | `One One` | Off | *(none)* | Off | Same family, adds `_Direction`/`_DirectionScale` view-dependent intensity term, `clamp(...,0,50)` |
| `Additive Echo.shader` | Transparent | `One One` | Off | LEqual | Off | — |
| `Additive Volumetric.shader` | Transparent | `one one` | Off | **Always** | **Front** | Differs from Cones Volumetric: `ZTest Always`, `Cull Front` (inside-facing) |
| `ProceduralParticles.shader` | Transparent | `OneMinusDstColor One` (screen-style blend; `SrcAlpha OneMinusSrcAlpha` line is commented out in source) | Off | *(none)* | Off | Only shader using this blend op — note the commented-out alternate blend mode in source, a maintainer's live A/B |
| `WaterfallDynamicDetail.shader` | Transparent | *(not itself declared — see file; shares family conventions)* | Off | LEqual | Off | — |

Universal pattern across **every** Waterfall shader: `ZWrite Off` (plumes never occlude
each other via the depth buffer — draw order alone determines layering) and no shader
reads `ZTest Greater`/writes depth. `Cull` is `Off`/double-sided for every family
**except** the two Alpha (non-Directional-suffix... actually Directional-suffixed)
shaders, which `Cull Back` (single-sided, front-face-only) — notable since a
double-sided plume mesh would show its inside walls through the alpha-blended surface
if culled the wrong way.

---

## Q5. Per-frame behavior the viewer might be missing

1. **Per-camera dynamic queue re-sort every `LateUpdate`** (Q1) — Waterfall recomputes
   `material.renderQueue` from the **live camera's** forward vector and position every
   single frame (`ModuleWaterfallFX.cs:195-229`), not once at load. A static "sort by
   distance once" viewer implementation will not reproduce layer-swap artifacts that
   happen as the camera orbits past a plume (e.g. two additive cones that swap visual
   order as the camera crosses their bisecting plane) — though for **additive-only**
   plumes this is visually a no-op since additive blending is order-independent; it
   only matters once alpha-blended layers are mixed in with additive ones.
2. **Distortion is a real screen-space GrabPass effect, not a color contributor.**
   Section Q1/Q4: `Distort Dynamic.shader` produces no light of its own; it warps a
   *live resample of everything already drawn beneath it* (background terrain, other
   engines, other plume layers at lower queue). A viewer with no scene to warp behind
   the plume has nothing meaningful to distort — a flat "no distortion" fallback is
   the closest faithful behavior (see Deviations: `plume.js` already does exactly this
   correctly, by design, not by omission).
3. **HDR/no-HDR is a live toggle, and it changes shader math, not just tonemap curve.**
   Section Q3: when `camera.allowHDR` flips, Waterfall doesn't just change what post
   sees afterward — it rewrites `_ClipBrightness` and `_DestMode` **on the
   materials themselves** for the `(Dynamic)` family. A viewer that always assumes HDR
   (`_ClipBrightness=50`) is correct for how the game normally runs (TUFX profiles
   default `hdr=True`), but would look different from a genuinely non-HDR KSP session
   (`_ClipBrightness=1`, and legacy blend mode `6` instead of `1` if
   `EnableLegacyBlendModes` is set).
4. **AutoExposure runs before Bloom every frame.** TUFX's `Default-Flight` profile
   chains `AmbientOcclusion → AutoExposure → Bloom → ColorGrading` — the "brightness"
   bloom responds to is auto-adjusted per frame based on scene luminance, not a fixed
   linear scalar. A static Reinhard curve (what `plume.js` uses) cannot reproduce
   scene-adaptive exposure (e.g. plumes reading brighter against a dark night sky than
   against the sunlit VAB interior in-game).
5. **Fog/atmosphere tint is not part of Waterfall's own shaders at all** — none of the
   `.shader` files sample `unity_FogColor`/apply `UNITY_FOG_COORDS`
   (only the legacy `Billboard (Additive).shader` even declares a `Fog{}` block, and it
   sets it to `Color(0,0,0,0)` — explicitly opting the billboard shaders **out** of
   scene fog). This is stock-KSP atmosphere-shader territory, not Waterfall — so the
   viewer is not missing a Waterfall-side effect here, just confirming there is none
   to reproduce for plumes specifically.
6. **Double-sided (`Cull Off`) is the default for every additive family** — meaning
   the far/inside wall of a cone mesh is visible and additively blends with the near
   wall (this is intentional: it's how the "volumetric-looking" thick-core effect of a
   single hollow cone mesh is achieved without a real raymarch, by literally drawing
   both its front and back faces additively on top of each other). Only the two
   `Cull Back` alpha-blended shaders are single-sided.

---

## Deviations in our WebGL viewer (`web/plume.js` + `web/model3d.js`)

Ranked by visual impact, highest first.

### High impact

- **No real distance-based render-queue sort across plume layers/effects.**
  `plume.js` draws effects/materials in a fixed order derived from cfg/model
  iteration order, not per-frame camera-distance queue values (contrast Q1/Q5#1:
  Waterfall recomputes `renderQueue` from live camera position every `LateUpdate`).
  For any template mixing additive and alpha-blended shaders (mode 0/1 vs mode 2) at
  overlapping depths, or multiple independent `EFFECT`s whose meshes interpenetrate,
  the current fixed draw order can produce wrong layering that would flip as the
  camera orbits in-game. Purely-additive-only templates are unaffected (additive
  blending is commutative), which likely masks this in the common case.
- **No distortion/heat-shimmer GrabPass pass at all** — `plume.js` explicitly
  redirects `_Strength`-bearing (`Distort Dynamic.shader`) materials through the
  plain additive-dynamic path with brightness forced to 0 (`plume.js:751-766`,
  comment documents this is deliberate to avoid a "solid white cone" bug). This is
  arguably the *correct* choice given no scene exists behind the plume to warp (Q5#2),
  but it does mean distortion effects are **fully invisible** in the viewer rather
  than rendering their real (subtle) refraction — worth flagging since it's a
  complete pass omission versus an approximation.
- **Fixed Reinhard tonemap instead of AutoExposure + PPv2 Bloom.** `plume.js:196-214`'s
  `toneMap()` is a static luminance-preserving Reinhard curve; the real pipeline runs
  scene-adaptive `AutoExposure` before a `Bloom` pass with profile-specific
  `Intensity`/`Threshold`/`SoftKnee` (Q3/Q5#4). This is a reasonable single-pass
  substitute for a full bloom pipeline, but will systematically differ in how "hot"
  bright plume cores look depending on ambient scene brightness, and produces no glow
  bleed into surrounding pixels (Bloom's actual visual signature) at all — the
  clip-and-compress-per-pixel approach can't replicate that.

### Medium impact

- **`_PlumeDir` is hardcoded per shader mode rather than read from cfg**
  (`plume.js:780-794`, `(0,1,0,0)` for dynamic/mode 0/2, `(0,0,1,0)` for
  directional/mode 1) — this is confirmed correct per the Waterfall source (no VECTOR
  cfg node type exists for it, `WaterfallMaterial.Load()` never reads a
  `_PlumeDir`/`Exhaust Direction` key), so **this is not actually a deviation**, just
  worth a note that it's intentionally matching an engine limitation rather than an
  oversight — listed here so it isn't mistaken for a bug later.
- **Single blend equation for all additive modes** — `plume.js`'s frag shader always
  writes `vec4(toneMap(emission), 1.0)` for additive/directional modes (implying an
  effective `Blend One Zero`-into-tonemapped-buffer approach when composited by the
  caller), whereas the real `Additive (Dynamic).shader` blend op is driven by
  `_SrcMode`/`_DestMode` floats that literally change between `Blend One One` (HDR) and
  `Blend One OneMinusSrcColor` (non-HDR + `EnableLegacyBlendModes`) (Q3). If the
  viewer's compositing/canvas blend state is fixed rather than switchable, non-HDR /
  legacy-blend-mode looks cannot be reproduced — likely acceptable since HDR is KSP's
  effective default (Q3), but worth confirming the canvas-level blend func used when
  compositing plume draws over the model-viewer scene matches `One One` (additive),
  not e.g. premultiplied-alpha-over.
- **`Cull` state**: need to verify plume.js's GL cull setting matches the per-mode
  table in Q4 — additive/dynamic/directional/billboard modes should render **double
  sided** (`Cull Off`) while alpha/mode-2 materials should be **single-sided, back-face
  culled** (`Cull Back`). If the renderer applies one blanket cull mode to all plume
  draws, alpha-blended plume meshes will show their far/inside wall through the near
  wall — a visible double-image artifact the real game never has for that shader
  family. (Not confirmed from the excerpted `createCtx`/draw code above — flag for
  direct verification against the GL state calls surrounding `drawRealMaterial`.)

### Low impact / confirmed non-issues (documented so they aren't "fixed" incorrectly)

- **No linear/gamma conversion in `plume.js`'s color math** — per Q2, this is correct:
  KSP runs Gamma color space and Waterfall's own shaders do no linear conversion
  either, so `plume.js` combining raw texture/tint values with no gamma correction
  step matches the source of truth, not a mismatch to fix.
- **No fog tint applied to plumes** — per Q5#5, Waterfall's own shaders don't sample
  fog either (bar the billboard family explicitly zeroing it out), so this is already
  consistent.
