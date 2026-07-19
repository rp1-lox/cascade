# Rendering Ground Truth: Unity → GL Coordinate & Skinning Spec

Status: primary-source research for making `EngineEditor`'s WebGL viewer bit-exact
with KSP/Unity, ending the pattern of empirically-tuned sign hacks (`u2g`,
pre-negated eulers, bindpose transpose).

Primary sources actually read for this doc (not paraphrased from memory):

- `taniwha/io_object_mu` @ GitHub, files fetched verbatim via `gh api`:
  `mu.py` (binary layout), `import_mu/armature.py`, `export_mu/armature.py`,
  `import_mu/mesh.py`, `export_mu/mesh.py`. This is the only community tool that
  round-trips Unity ⇄ Blender `.mu` skinned meshes correctly, so its conversion
  code is ground truth for byte order and axis handling.
- Unity Scripting Reference: `Matrix4x4`, `Mesh.bindposes`, `Quaternion.Euler`
  (fetched live, quoted below).
- Local Waterfall source clone: `WaterfallModel.cs`, `WaterfallEffect.cs`,
  `WaterfallEffectTemplate.cs`, `WaterfallTemplate.cs`.
- This repo's `web/model3d.js` and `web/plume.js` (current implementation,
  read in full for the sections that do coordinate conversion).

---

## Q1 — Exact byte order of `.mu` bindPoses, and whether the transpose fix was right

**`mu.py` line ~520-524** (`MuMesh.read`, `ET_MESH_BIND_POSES` branch):

```python
elif type == MuEnum.ET_MESH_BIND_POSES:
    num_poses = mu.read_int()
    for i in range(num_poses):
        self.bindPoses.append(mu.read_float(16))
```

`mu.read_float(16)` just unpacks 16 little-endian floats in file order with no
reordering — the raw wire bytes. The interpretation of those 16 floats is
established downstream in **`export_mu/armature.py` line 94-99**
(`create_bindPose`, called when *importing* a `.mu`, despite living under
`export_mu` — it builds the Blender bind-pose armature from parsed `.mu` data):

```python
def create_bindPose(mu, muobj, skin):
    bone_names = skin.bones
    for i in range(len(skin.mesh.bindPoses)):
        bp = skin.mesh.bindPoses[i]
        bp = Matrix((bp[0:4], bp[4:8], bp[8:12], bp[12:16]))
        skin.mesh.bindPoses[i] = Matrix_YZ @ bp @ Matrix_YZ
```

`mathutils.Matrix(r0, r1, r2, r3)` takes **rows**. Grouping `bp[0:4]` as row 0
means the four floats read first from disk are `(m00, m01, m02, m03)` — i.e.
**the `.mu` file stores each bindpose matrix row-major on disk** (row 0, then
row 1, …), with translation as the last element of rows 0-2 (flat indices
3, 7, 11). This is *not* Unity's own in-memory `Matrix4x4` layout — Unity's
Scripting Reference states matrices are **column-major in memory**
(`docs.unity3d.com/ScriptReference/Matrix4x4.html`: *"Matrices in Unity are
column major; i.e. the position of a transformation matrix is in the last
column… Data is accessed as: row + (column*4)"*, translation at
`matrix[0,3]`/`[1,3]`/`[2,3]`). The `.mu` exporter (Squad's PartTools, a closed
Unity Editor script) evidently serializes each bindpose via something like
`GetRow(0..3)` in sequence — i.e. it re-orders the in-memory column-major data
into a row-major stream on disk. `io_object_mu` compensates for that exact
serialization choice by grouping the 16 floats as 4 rows.

**Answer:** `.mu` bindPoses are row-major on disk (translation at flat offsets
3/7/11). Any consumer whose own matrix type is column-major (translation at
12/13/14 — which is what `model3d.js`'s `M4` and `plume.js`'s `M` both use,
confirmed by their `translate()` helpers writing `m[12..14]`) **must transpose
each bindpose once after reading it.** So the transpose already present at
`web/plume.js:645` (`mesh.bindPoses.map(M.transpose)`) is **correct and
required**, not a hack to remove — it was arrived at empirically but it
matches the primary source exactly. Do not delete it. (If the 180° flip
persists after adopting the Q2 recommendation below, look elsewhere — see the
"what the transpose does NOT fix" note in the migration plan.)

Note what `io_object_mu` does *not* do to the bindpose: it never negates or
swaps individual matrix elements ad hoc. It reads the 16 floats as-is (as a
Unity-space matrix, still row-major-vs-column-major aside), then applies one
uniform conjugation (`Matrix_YZ @ bp @ Matrix_YZ`, see Q2) to move the whole
matrix from Unity's axis convention into Blender's. That conjugation is the
only axis-handling operation applied to a bindpose. This matters for Q2.

---

## Q2 — The complete, hack-free recipe for LH Unity content in a RH GL context

Unity: **left-handed**, Y-up. Quaternions `(x,y,z,w)`, column-major
`Matrix4x4`, translation in the last column. WebGL/OpenGL: **right-handed**
by convention (though GL itself is agnostic — "right-handed" is a convention
of the depth range / winding rules typically paired with it), Y-up.

### Option (a): mirror one axis on every object (current approach)

This is what both `model3d.js` (`unityToGL`, lines 442-447) and `plume.js`
(`u2g`, lines 91-99) do: conjugate every world matrix by `D = diag(1,1,-1,1)`,
i.e. `M' = D·M·D`. Because `D·D = I`, this is a homomorphism —
`u2g(A·B) = u2g(A)·u2g(B)` — which is why it composes correctly through node
hierarchies and bone chains (this is also exactly the property
`io_object_mu`'s `Matrix_YZ` conjugation in `export_armature.py:99` relies on:
`Matrix_YZ` is a Y↔Z swap, also self-inverse, also a pure reflection).
Reflection has determinant −1, so every triangle's winding must be flipped
wherever this conjugation is applied to a *rendered* mesh (both files do this:
`model3d.js:463-465`, `plume.js`'s `flipWind` in `buildFxModel`).

Problems with (a) as an architecture, independent of whether any single
instance of it is currently buggy:
- It must be threaded through **every single matrix that ever reaches the
  GPU** — node worlds, bone worlds, bindposes, normal matrices — and forgetting
  it (or double-applying it) on any one path is a silent, hard-to-spot 180°/
  mirror bug. This is exactly the failure mode described in the mission
  (skinned FX still flipped despite a targeted bindpose fix): the bug is as
  likely to be a *missing or duplicated* `u2g`/`unityToGL` call on one code
  path (e.g. base-bone normal matrix, or an attach matrix) as it is to be the
  bindpose layout itself.
- Winding-flip must be re-derived and kept in sync with every place
  triangles are uploaded (mesh build **and** any runtime remesh/expand code).
- It changes the literal numbers of every position/quaternion/bindpose in the
  system, so nothing can be compared 1:1 against a Unity/KSP debug dump —
  defeating the "make it one-to-one with the game" goal operationally, since
  you can never diff your in-memory transform against an in-game
  `transform.localToWorldMatrix` dump without re-deriving the conjugation by
  hand each time.

### Option (b): keep Unity data untouched; put the single flip in view/projection

Do **zero** per-object conversion. Store positions, quaternions, Euler angles,
bindposes, and all node/bone math exactly as Unity/`​.mu` express them (after
only the Q1 row-major→column-major bindpose transpose, which is not a
handedness fix — it's a storage-layout fix that has nothing to do with LH/RH).
Build the *entire* Unity-side scene graph in Unity's own left-handed
coordinates. Then, once, when computing camera view/projection:

1. **Mirror the camera's world position and basis** the same way you would
   mirror any other object *if* you needed the camera in GL space — but since
   nothing else is being converted, instead fold the mirror into the
   view matrix directly: build `V = mirrorZ · lookAtUnity(eye, target, up)`
   where `mirrorZ = diag(1,1,-1,1)` and `lookAtUnity` is a standard look-at
   built from Unity-space eye/target/up (Unity-space forward/right/up basis,
   left-handed cross products). Concretely:
   `V = diag(1,1,-1,1) · [ right | up | fwd | -eye·{right,up,fwd} ; 0 0 0 1 ]`
   using Unity's own (LH) `right = up×fwd`, `fwd = normalize(target-eye)` — do
   **not** use GL's `cross(fwd,up)` convention, use Unity's, then mirror the
   whole assembled matrix's Z row once at the end.
2. **Flip the polygon winding test globally**, once, via
   `gl.frontFace(gl.CW)` (or equivalently negate one row of the projection
   matrix) instead of re-indexing every index buffer. A single reflection in
   the view matrix inverts the sign of the Jacobian for every triangle in the
   scene uniformly, so a single global winding flip is correct and cannot be
   forgotten per-mesh.
3. Everything upstream of the camera — node hierarchy walk, bone matrices,
   bindpose application, quaternion→matrix, Euler→matrix — is executed
   verbatim in Unity's left-handed convention with Unity's own formulas. No
   `D·M·D` anywhere. `gl_Position = P · V · M_unity · vertex_unity` and the
   result lands in the correct screen pixel because `V` alone carries the
   handedness flip.

**Recommendation: adopt (b).** It matches the instinct in the mission brief
("don't transform the actual information") and, more importantly, it collapses
an entire class of bugs (a forgotten/duplicated `u2g` on some matrix in a
bone chain) down to *one* place that can be tested once (`V` matrix) and never
touched again. It also means every intermediate Unity-space matrix in the
renderer (`nodeWorld`, `boneWorld·bindPose`, `attach`) is byte-for-byte
comparable to a value you could print from KSP with `Transform.localToWorldMatrix`
or Waterfall's own debug logging — which is what "one-to-one with the game"
actually requires operationally.

Handedness proof sketch: mirroring the camera's Z axis is equivalent to
mirroring the entire scene's Z axis (both are global similarity transforms on
the whole pipeline, and gl_Position only depends on `P·V·M·v`, which is linear
in each of those factors) — so `V_mirrored · M_unity` produces the same final
clip-space triangle as `V_unfmirrored · unityToGL(M)` would under option (a),
without ever materializing the mirrored `M`. Winding parity is preserved by
the same argument: a single global mirror still flips the Jacobian sign of
every triangle equally, so one `gl.frontFace(gl.CW)` call is the aggregate of
every per-mesh winding flip in option (a).

---

## Q3 — Unity `Quaternion.Euler`/`localEulerAngles` composition order

Unity Scripting Reference, `Quaternion.Euler` (fetched live):
*"Rotates z degrees around the z axis, x degrees around the x axis, and y
degrees around the y axis (in that order)."* This is stated as an **extrinsic**
ZXY sequence (rotating about the fixed world axes in the order Z, then X, then
Y). Extrinsic ZXY is mathematically identical to **intrinsic** rotation
composition `R = Ry(y) · Rx(x) · Rz(z)` applied to a column vector — i.e.
apply `Rz` first, then `Rx`, then `Ry`, matrix-multiplied left-to-right as
`Ry·Rx·Rz` (this equivalence — extrinsic A,B,C ≡ intrinsic C,B,A applied as
matrix product in reverse — is standard Euler-angle theory and is what both
`web/model3d.js:432` and `web/plume.js:64-67` already implement:
`R = Ry * Rx * Rz`). **This part of the current code is already correct** and
should be kept as-is under either option (a) or (b).

Worked example, `localEulerAngles = (-90, 0, 0)`:

```
Rz(0) = I
Rx(-90): c=0, s=-1  →  Rx = [[1,0,0],[0,0,-1],[0,1,0]]   (Unity's row convention: m[5]=c,m[6]=s,m[9]=-s,m[10]=c per model3d.js's rotX helper, s=sin(-90°)=-1)
Ry(0) = I
R = Ry · Rx · Rz = Rx(-90)
```

Applied to the Unity-space +Z basis vector `(0,0,1)`:
`Rx(-90)·(0,0,1) = (0, s, c)... ` using the exact matrix in `model3d.js`
(`Rx=[1,0,0,0, 0,cx,sx,0, 0,-sx,cx,0, ...]`, column-major so column 2 = new Z
basis = `(0, sx, cx) = (0, -1, 0)`): a part whose nozzle points along local +Z
and gets `localEulerAngles=(-90,0,0)` ends up pointing along **world −Y**
(straight down) — i.e. the classic "point the thrust transform down" rotation
used throughout KSP `MODEL{}`/Waterfall `rotationOffset` configs. Use this
triple, `(-90,0,0) → +Z maps to −Y`, as a regression fixture.

---

## Q4 — Skinning equation end-to-end for a Waterfall FX mesh

From `mu.py`'s `MuSkinnedMeshRenderer.read` (line 615-631): a skinned renderer
node stores `bones: [string]` (names, resolved by path against the same node
tree the mesh lives in) and a `MuMesh` carrying `boneWeights` (`MuBoneWeight`:
4 `(index,weight)` pairs per vertex, line 461-469) and `bindPoses` (one 4×4
per bone, in bone-array order, row-major on disk — see Q1).

Unity's documented semantics (`Mesh.bindposes`, fetched live): *"Each matrix
in bindposes is the inverse of the transformation matrix of the bone,
calculated when the bone is in its base state (its bind pose)"* — i.e.
`bindPose_i = boneWorldToLocal_i` evaluated at authoring time (this is a fixed
asset-time constant, baked into the `.mu`; it does **not** change at runtime).
The per-vertex world position (standard linear-blend skinning, the only model
consistent with a 4-bone-index/4-weight vertex format and a matrix-only
bindpose array — Unity does not document the formula on that page, but this is
the universally implemented LBS formula for exactly this data shape) is:

```
v_world = Σ_{k=0..3} weight_k · boneCurrentWorld_{bones[idx_k]} · bindPose_{idx_k} · v_local
n_world = Σ_{k=0..3} weight_k · (boneCurrentWorld_{bones[idx_k]} · bindPose_{idx_k})^-T · n_local
```

where `boneCurrentWorld_i` is bone `i`'s **live** local-to-world matrix, walked
fresh every frame from the current node-hierarchy TRS (`localPosition` ·
`localRotation` · `localScale`, exactly Unity's own `Transform` composition),
not the bind-time value. The `SkinnedMeshRenderer`'s own transform contributes
nothing extra to this equation beyond being one more node in that same
hierarchy walk — Unity resolves bone paths against the `Transform` hierarchy
the renderer sits in, and the renderer's own `localToWorldMatrix` is not
multiplied in a second time (verified by exclusion: `mu.py`'s
`MuSkinnedMeshRenderer` carries no separate "anchor" transform field beyond
the enclosing `MuObject.transform`, and `bones` are plain path-resolvable
names — there is nothing else in the binary for an anchor to be).

`web/plume.js:820-827` already implements exactly this chain
(`M.mul(bworld, bind)` per bone, blended in the vertex shader via
`aBoneIdx`/`aBoneWt`) — the only change needed under option (b) is deleting
the `u2g(...)` wrapper around it (line 824) and the `attach` pre-multiply
becomes a plain Unity-space parent matrix instead of a GL-space one; nothing
about the bone-blend math itself changes.

---

## Q5 — Waterfall TEMPLATE/EFFECT MODEL offset application

`Source/Waterfall/Effects/WaterfallModel.cs`:
- `ApplyOffsets` (line 231-257) sets, on the instantiated model root
  `Transform`: `modelTransform.localPosition = modelPositionOffset;
  modelTransform.localScale = modelScaleOffset;` and, if the rotation offset
  is non-zero, `modelTransform.localEulerAngles = modelRotationOffset;`
  (else `Quaternion.identity`). Standard Unity `Transform` local TRS fields,
  applied directly — no custom math.
- `Initialize` (line 136-215) instantiates the model prefab via
  `Object.Instantiate(prefab, parent.position, parent.rotation)` then
  immediately `modelTransform.SetParent(parent, true)` (worldPositionStays
  = true — Unity recomputes local TRS to preserve current world pose when
  reparenting) before calling `ApplyOffsets(modelPositionOffset,
  modelRotationOffset, modelScaleOffset)` from the `MODEL{}` config's
  `positionOffset`/`rotationOffset`/`scaleOffset` fields (`Load`, line 70-96).

`Source/Waterfall/Effects/WaterfallEffect.cs`:
- The effect's own transform is created and parented at line 212-257:
  `var parents = parentModule.part.FindModelTransforms(parentName);` (the
  `EFFECT`'s `parentName` field is looked up against the *part's compiled
  model* transform names — i.e. against the same tree the base `.mu`
  produced, post `MODEL{}` application); `effectTransform.SetParent(parent,
  true)`; then (line 249-250) `effectTransform.localPosition =
  TemplatePositionOffset; effectTransform.localEulerAngles =
  TemplateRotationOffset;` where `TemplatePositionOffset`/
  `TemplateRotationOffset` come from the *effect template's* `position`/
  `rotation` fields (`WaterfallEffectTemplate.cs` line 13-14, loaded via
  `ConfigNode.LoadObjectFromConfig`), i.e. the `EFFECTTEMPLATE`'s own
  position/rotation node, not a `MODEL{}` node.
- `TemplateScaleOffset` is likewise applied at line ~250-ish alongside
  (`ApplyOffsets`/`SetOffsets`, mirrored at lines 321-339 for runtime
  updates) as `effectTransforms[i].localScale`-equivalent (via
  `baseScales`, scaled by `TemplateScaleOffset`).

So there are two independent offset layers, both expressed as ordinary Unity
local TRS, both composed the ordinary Unity way (`world = parentWorld ·
T(localPosition) · R(localEulerAngles) · S(localScale)`, same order as
`Transform` always uses): (1) the `MODEL{}` node's `positionOffset`/
`rotationOffset`/`scaleOffset`, applied to the *model root* the FX mesh was
loaded from, and (2) the `EFFECTTEMPLATE`'s `position`/`rotation`/`scale`
node, applied to the *effect's own* transform, parented under the part
transform named by `parentName`. Neither layer does anything but call the
plain Unity `Transform` setters — confirming there is no bespoke coordinate
math anywhere in Waterfall's own instancing path; all handedness/axis
questions are fully answered by Unity's own `Transform`/`Matrix4x4`/
`Quaternion` conventions documented above, with zero Waterfall-specific
wrinkles.

---

## Migration plan for `model3d.js` / `plume.js`

Rebuild on **option (b)**: Unity-space data untouched everywhere except the
Q1 bindpose row→column transpose (which is a storage-format fix, not a
handedness fix, and must be kept); a single mirror folded into the view
matrix; a single global winding flip.

### Delete

1. `web/model3d.js:442-447` — `unityToGL(m)` (the `diag(1,1,-1,1)` conjugation
   applied per mesh-item's world matrix in `makeItem`).
2. `web/model3d.js:463-465` — the per-item index-buffer winding flip in
   `makeItem` (`idx[i]=sub[i]; idx[i+1]=sub[i+2]; idx[i+2]=sub[i+1];`).
3. `web/model3d.js:396-401` — the ad-hoc `wz = -(...)` Z-negation used only
   for the scene bounding box; once nothing else is mirrored, bounds should
   be computed in plain Unity-space world coordinates.
4. `web/plume.js:91-99` — `u2g(m)` and every call site (`plume.js:824,836`,
   plus any other `u2g(...)` call in the file not shown above — grep the
   file for `u2g(` before starting).
5. `web/plume.js`'s `flipWind` helper inside `buildFxModel`
   (`plume.js:616-617` and its call at line 633) — triangle index order
   should be uploaded exactly as `.mu`/`muparse.py` produced it.
6. Any other per-object "pre-negated euler" values baked into config parsing
   (search both files and `muparse.py`/`server.py` for `-r[0]`, `-rot`,
   `*-1` near rotation fields) — these were compensating for option (a) and
   must be removed once (b) is in place, or they will double-flip.

### Keep unchanged

- `web/plume.js:645` — `mesh.bindPoses.map(M.transpose)` (Q1: required, not
  handedness-related).
- `web/model3d.js:431-438` and `web/plume.js:64-67` — the `Ry·Rx·Rz` Euler
  composition (Q3: already matches Unity's documented ZXY order).
- The skinning blend itself (`web/plume.js:812-827`), minus the `u2g(...)`
  wrapper (Q4).
- `WaterfallModel`/`WaterfallEffect` TRS semantics are irrelevant to the JS
  renderer directly — they only inform how `muparse.py`/`server.py` should
  already be composing `MODEL{}` and `EFFECTTEMPLATE` offsets, which appears
  to already follow plain local-TRS composition; re-verify against Q5 when
  touching that code, but no evidence surfaced here that it's wrong.

### Add

1. A single Unity-space `lookAtUnity(eye, target, up)` builder using Unity's
   own (left-handed) `right = cross(up, fwd)` convention (do **not** reuse
   GL's `cross(fwd, up)` — check the sign against the Q2 test vectors below).
2. Wrap the final view matrix once: `V = mirrorZ(lookAtUnity(...))` where
   `mirrorZ` negates row 2 (the Z output row) of the assembled 4×4 — a single
   9-line function replacing every deleted `u2g`/`unityToGL` call.
3. `gl.frontFace(gl.CW);` set once at context/program init (both
   `model3d.js` and `plume.js` each own a `gl` context — set it in both).
4. Re-audit the bindpose flip bug specifically: since the transpose (Q1) is
   confirmed correct, the residual 180° flip on `fx-complex-plume-1` most
   likely comes from an *inconsistency between how many times the handedness
   conjugation was applied* on the base-bone vs. static-mesh path (a classic
   double-mirror bug), which option (b) makes structurally impossible because
   there is no longer a conjugation to apply inconsistently. If it still
   reproduces after this migration, the remaining suspects are (a) bone name
   resolution picking the wrong node (path collision) or (b) `muparse.py`
   itself performing a partial/incorrect axis conversion before the JSON ever
   reaches `plume.js` — check `muparse.py`'s vector/quaternion readers against
   `mu.py`'s `read_vector`/`read_quaternion` (Q1's neighboring code, lines
   1071-1088) for parity; `muparse.py` was not audited in this pass.

### Numeric test vectors (Unity-space input → expected GL screen-space result)

Use these as unit tests against the *new* `V`/`mirrorZ`/`frontFace(CW)`
pipeline (option (b)); an implementation that reproduces these three is
presumptively correct.

**T1 — straight-ahead point, default camera.**
Camera (Unity space): `eye=(0,0,-10)`, `target=(0,0,0)`, `up=(0,1,0)`
(looking down +Z, Unity's forward). Point `p=(0,0,0)` (Unity space).
Expected: after `V=mirrorZ(lookAtUnity(eye,target,up))` and a standard
symmetric perspective `P`, `p` projects to clip-space `(0,0,·,·)` → NDC
`(0,0)` → screen-space **center of viewport**. (Sanity check that the camera
math alone, with no scene content, doesn't introduce an offset.)

**T2 — handedness/winding check.**
A single unit-Z-facing triangle in Unity space with vertices
`(-1,-1,0), (1,-1,0), (0,1,0)` wound `0,1,2`, i.e. Unity considers this
front-facing when viewed from `-Z` looking toward `+Z` (Unity's front-face
winding is clockwise as seen from the "outside"/camera per Unity's default
`Cull Back` with clockwise winding). Camera at `eye=(0,0,-5)` looking at
`target=(0,0,0)`. Expected: with `gl.frontFace(gl.CW)` and `gl.cullFace(gl.BACK)`
set globally, this triangle renders visible (not culled) using its Unity-space
vertex order **unmodified** — i.e. no per-triangle index reordering is
performed anywhere in the pipeline, only the one global `frontFace(CW)` call.
If it's culled, the `mirrorZ`/`frontFace` pairing has a sign error.

**T3 — Euler rotation regression (from Q3).**
Node with `localPosition=(0,0,0)`, `localEulerAngles=(-90,0,0)`,
`localScale=(1,1,1)`, parent = identity. A child point at local `(0,0,1)`
(Unity space, i.e. the node's local +Z axis). Expected world position after
applying `R=Ry(0)·Rx(-90)·Rz(0)`: **`(0,-1,0)`** (world −Y) — matches the
worked example in Q3 and is the exact rotation KSP/Waterfall configs use to
aim a nozzle/plume "down". Render this point through the T1 camera (looking
down +Z from `(0,0,-10)`) after applying `mirrorZ` to the *view* only (the
point itself must be supplied to the pipeline as literal Unity-space
`(0,-1,0)`, untransformed) and confirm it lands below screen center — this
exercises the full node-transform → mirror-only-in-view chain end to end.
