'use strict';
/* KSP Waterfall plume renderer — WebGL2, no external libs.
 *
 *   window.PlumeRenderer = {
 *     mount(container), loadEffects(json, ctl), setController(n,v), dispose(),
 *     renderOnce(),
 *     createOverlay(gl)   // draw plume inside an existing GL scene (model viewer)
 *   }
 *
 * Ports the ShaderLab math from Waterfall/Source/ShaderLab for the
 * "Additive (Dynamic)", "Additive Directional", "Alpha (Dynamic)" and
 * "Billboard (Additive)" shaders.
 *
 * REAL MESHES: each EFFECT's MODEL path is fetched from /api/fxmodel (the parsed
 * .mu tree, meshes, skin data and materials) and turned into GL meshes:
 *   - static MuRenderer meshes are drawn with the node-hierarchy world transform;
 *   - skinned MuSkinnedMeshRenderer meshes are GPU-skinned (per-vertex bone
 *     indices/weights, bone world matrices computed from the node hierarchy each
 *     frame, bindPoses applied);
 *   - SCALE/POSITION/ROTATION modifiers whose transformName names a NODE (bone or
 *     mesh node or the model root '<path>(Clone)') fold onto that node's local TRS
 *     before world/bone matrices are computed (in-game semantics, folded in listed
 *     order per (node,property) via combinationType REPLACE/ADD/SUBTRACT/MULTIPLY);
 *   - MATERIAL `transform = X` binds the material's shader/uniforms to the mesh
 *     under node X;
 *   - the Dynamic _Expand* vertex deformation applies to static meshes only.
 * If an FX .mu fails to load/parse, the model falls back to a procedural cylinder
 * (and the path is console.warn'd once).
 *
 * Unity space (Y-up, left-handed) is used for ALL node/offset/bone/attach math, with
 * ZERO per-object handedness conversion (docs/RenderingGroundTruth.md option (b)):
 * node worlds, bone worlds, bindposes (after the required Q1 row->column transpose)
 * and the model viewer's attach matrix (model3d.js's getTransformMatrix) are all
 * plain Unity-space data. The single LH->RH flip is folded once into the view matrix
 * (mirrorZ) plus one global gl.frontFace(gl.CCW) — GL's own default; see the comment
 * at the frontFace() call in drawEffects() for why this, not gl.CW, is what the
 * ground-truth doc's own T2 numeric test vector actually requires.
 */
window.PlumeRenderer = (function () {

  const MAX_BONES = 8;

  // ---------------- tiny mat/vec ----------------
  const M = {
    ident: () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
    mul(a, b) {
      const o = new Array(16);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        o[c*4+r] = a[0*4+r]*b[c*4+0] + a[1*4+r]*b[c*4+1] + a[2*4+r]*b[c*4+2] + a[3*4+r]*b[c*4+3];
      }
      return o;
    },
    translate(x, y, z) { const m = M.ident(); m[12]=x; m[13]=y; m[14]=z; return m; },
    transpose(m){ const o=new Array(16); for(let r=0;r<4;r++) for(let c=0;c<4;c++) o[c*4+r]=m[r*4+c]; return o; },
    scale(x, y, z) { const m = M.ident(); m[0]=x; m[5]=y; m[10]=z; return m; },
    rotX(a) { const c=Math.cos(a), s=Math.sin(a); const m=M.ident(); m[5]=c;m[6]=s;m[9]=-s;m[10]=c; return m; },
    rotY(a) { const c=Math.cos(a), s=Math.sin(a); const m=M.ident(); m[0]=c;m[2]=-s;m[8]=s;m[10]=c; return m; },
    rotZ(a) { const c=Math.cos(a), s=Math.sin(a); const m=M.ident(); m[0]=c;m[1]=s;m[4]=-s;m[5]=c; return m; },
    // Unity Quaternion -> column-major rotation matrix (same as model3d.js fromQuat).
    fromQuat(x, y, z, w) {
      const n = Math.hypot(x, y, z, w) || 1; x/=n; y/=n; z/=n; w/=n;
      const xx=x*x, yy=y*y, zz=z*z, xy=x*y, xz=x*z, yz=y*z, wx=w*x, wy=w*y, wz=w*z;
      return [1-2*(yy+zz), 2*(xy+wz), 2*(xz-wy), 0,
              2*(xy-wz), 1-2*(xx+zz), 2*(yz+wx), 0,
              2*(xz+wy), 2*(yz-wx), 1-2*(xx+yy), 0,
              0,0,0,1];
    },
    // Unity Quaternion.Euler(deg): intrinsic Z, then X, then Y  =>  R = Ry*Rx*Rz.
    euler(deg) {
      return M.mul(M.mul(M.rotYu(deg[1]), M.rotXu(deg[0])), M.rotZu(deg[2]));
    },
    // Unity-space rotation basis matrices (column-major, standard sense).
    rotXu(d){ const a=d*Math.PI/180, c=Math.cos(a), s=Math.sin(a); return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]; },
    rotYu(d){ const a=d*Math.PI/180, c=Math.cos(a), s=Math.sin(a); return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]; },
    rotZu(d){ const a=d*Math.PI/180, c=Math.cos(a), s=Math.sin(a); return [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]; },
    perspective(fovy, asp, n, f) {
      const t = 1 / Math.tan(fovy/2);
      return [t/asp,0,0,0, 0,t,0,0, 0,0,(f+n)/(n-f),-1, 0,0,(2*f*n)/(n-f),0];
    },
    normalMat(m) {
      const a=m[0],b=m[1],c=m[2],d=m[4],e=m[5],f=m[6],g=m[8],h=m[9],i=m[10];
      const A=e*i-f*h, Bb=-(d*i-f*g), C=d*h-e*g;
      let det=a*A+b*Bb+c*C; if (Math.abs(det)<1e-12) det=1; const id=1/det;
      const D=-(b*i-c*h), E=a*i-c*g, F=-(a*h-b*g);
      const G=b*f-c*e, H=-(a*f-c*d), I=a*e-b*d;
      const inv=[A*id,D*id,G*id, Bb*id,E*id,H*id, C*id,F*id,I*id];
      return [inv[0],inv[3],inv[6], inv[1],inv[4],inv[7], inv[2],inv[5],inv[8]];
    },
    // Strip the scale component out of a TRS matrix's rotation basis (columns 0-2),
    // normalizing each basis column to unit length while leaving translation (column
    // 3) and rotation direction untouched. See WaterfallEffect.cs InitializeEffect:
    // the effect's own Transform is SetParent(parent, true) (worldPositionStays=true)
    // while it still has localScale==Vector3.one, i.e. world scale==1 at that instant;
    // Unity's SetParent recomputes localScale to PRESERVE that world scale under the
    // new (possibly non-unit-scaled, e.g. rescaleFactor-scaled) parent — which is
    // exactly a scale-canceling transform. That compensated localScale becomes
    // `baseScales[i]` (WaterfallEffect.cs line 246), and the effect's final scale is
    // `baseScales[i] * TemplateScaleOffset` (line 251/331) — i.e. independent of the
    // parent's (and therefore the part's rescaleFactor's) scale entirely, UNLESS the
    // part config sets `useRelativeScaling = true` on ModuleWaterfallFX (default false,
    // per ModuleWaterfallFX.cs:26 `[KSPField] public bool useRelativeScaling;` — no
    // explicit initializer means C#'s bool default, false), in which case
    // `effectTransform.localScale` is instead hard-reset to `Vector3.one` (line 242)
    // and DOES inherit the parent's full lossyScale. Stock/Nertea configs (verified via
    // /api/part?name=NFLV_AR1E — its ModuleWaterfallFX node has no useRelativeScaling
    // key) rely on the default `false` path, so the attach matrix's scale must be
    // stripped here to match.
    stripScale(m) {
      const o = m.slice();
      for (const c of [0, 4, 8]) {
        const len = Math.hypot(o[c], o[c+1], o[c+2]) || 1;
        o[c] /= len; o[c+1] /= len; o[c+2] /= len;
      }
      return o;
    }
  };
  // Unity-space (left-handed) look-at: right = up x fwd, Unity's own convention
  // (NOT GL's cross(fwd,up)). See docs/RenderingGroundTruth.md Q2.
  function lookAtUnity(eye, tgt, up) {
    const fwd=norm3(sub3(tgt,eye)); const right=norm3(cross3(up,fwd)); const y=cross3(fwd,right);
    return [right[0],y[0],fwd[0],0, right[1],y[1],fwd[1],0, right[2],y[2],fwd[2],0,
            -dot3(right,eye),-dot3(y,eye),-dot3(fwd,eye),1];
  }
  // Negate the Z OUTPUT row of an assembled view matrix once — the entire
  // LH(Unity)->RH(GL) handedness conversion, folded into the view matrix instead of
  // conjugating every object matrix (docs/RenderingGroundTruth.md option (b)).
  function mirrorZ(m){
    const o=m.slice();
    o[2]=-o[2]; o[6]=-o[6]; o[10]=-o[10]; o[14]=-o[14];
    return o;
  }
  const sub3=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const cross3=(a,b)=>[a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  function norm3(a){const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];}

  // ---------------- gizmo drag math (screen<->world helpers) ----------------
  // Transform a homogeneous point/vector [x,y,z,w] by a column-major mat4 (same
  // storage convention as everything else in this file: m[col*4+row]).
  function xformPoint4(m, p){
    return [
      m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12]*p[3],
      m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13]*p[3],
      m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]*p[3],
      m[3]*p[0]+m[7]*p[1]+m[11]*p[2]+m[15]*p[3],
    ];
  }
  // World-space point -> NDC (x,y in [-1,1]), or null if behind the eye (w<=0).
  function worldToScreenNDC(view, proj, worldPos){
    const vp = xformPoint4(view, [worldPos[0],worldPos[1],worldPos[2],1]);
    const clip = xformPoint4(proj, vp);
    if (clip[3] <= 1e-6) return null;
    return [clip[0]/clip[3], clip[1]/clip[3]];
  }
  // NDC -> pseudo-pixel space (linear scale only, no offset — fine for distances).
  function ndcToPx(ndc, canvasW, canvasH){ return [ndc[0]*canvasW/2, ndc[1]*canvasH/2]; }
  function distPointToSegment2D(p, a, b){
    const abx=b[0]-a[0], aby=b[1]-a[1];
    const apx=p[0]-a[0], apy=p[1]-a[1];
    const ab2=abx*abx+aby*aby;
    let t = ab2>1e-9 ? (apx*abx+apy*aby)/ab2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0]-(a[0]+abx*t), p[1]-(a[1]+aby*t));
  }

  // build a Unity-space local TRS matrix from pos, rotation matrix, scale vector
  function trs(pos, rmat, sca){
    let m=M.mul(M.translate(pos[0],pos[1],pos[2]), rmat);
    return M.mul(m, M.scale(sca[0],sca[1],sca[2]));
  }

  // ---------------- shaders ----------------
  const VERT = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aNormal;
  layout(location=2) in vec2 aUV;
  layout(location=3) in vec4 aBoneIdx;
  layout(location=4) in vec4 aBoneWt;
  uniform mat4 uModel, uView, uProj;
  uniform mat3 uNormalMat;
  uniform int  uExpand;         // 1 = dynamic vertex expansion (static meshes only)
  uniform int  uBillboard;      // 1 = camera-facing quad
  uniform int  uSkinned;        // 1 = GPU skin with uBones
  uniform vec4 uPlumeDir;
  uniform vec4 uMainTexST;      // TEXTURE textureScale.xy, textureOffset.zw (Unity _MainTex_ST)
  uniform float uExpandOffset, uExpandLinear, uExpandSquare, uExpandBounded;
  uniform mat4 uBones[${MAX_BONES}];
  out vec2 vUV;
  out vec3 vWorldNormal;
  out vec3 vWorldPos;
  out float vPlumePos;
  void main(){
    vec3 pos = aPos;
    vec3 nrm = aNormal;
    vec3 axis = normalize(uPlumeDir.xyz);
    float arg = -dot(pos, axis);
    if (uExpand==1){
      float value = uExpandOffset + uExpandLinear*arg + uExpandSquare*arg*arg
                  + uExpandBounded*(1.0 - exp(-3.0*arg));
      pos += nrm * value;
      float deriv = uExpandLinear + uExpandSquare*2.0*arg + uExpandBounded*3.0*exp(-3.0*arg);
      nrm = normalize(nrm + deriv*axis);
    }
    vPlumePos = arg;
    // Unity auto-generates the uv_MainTex surface-shader input as
    // v.texcoord * _MainTex_ST.xy + _MainTex_ST.zw (the TEXTURE textureScale/
    // textureOffset from the cfg); this feeds both the fade calc (uv.g) and the
    // scrolled texture sample downstream, so it must be applied here.
    vUV = aUV * uMainTexST.xy + uMainTexST.zw;
    if (uBillboard==1){
      vec3 worldOrigin = (uModel * vec4(0.0,0.0,0.0,1.0)).xyz;
      float sx = length(vec3(uModel[0][0],uModel[0][1],uModel[0][2]));
      float sy = length(vec3(uModel[1][0],uModel[1][1],uModel[1][2]));
      vec4 viewPos = uView * vec4(worldOrigin,1.0);
      viewPos.xy += aPos.xy * vec2(sx,sy);
      vWorldPos = worldOrigin;
      vWorldNormal = vec3(0.0,0.0,1.0);
      gl_Position = uProj * viewPos;
      return;
    }
    if (uSkinned==1){
      mat4 sk = uBones[int(aBoneIdx.x)]*aBoneWt.x + uBones[int(aBoneIdx.y)]*aBoneWt.y
              + uBones[int(aBoneIdx.z)]*aBoneWt.z + uBones[int(aBoneIdx.w)]*aBoneWt.w;
      vec4 wp = sk * vec4(pos,1.0);
      vWorldPos = wp.xyz;
      vWorldNormal = normalize(mat3(sk) * nrm);
      // ROOT CAUSE of "renders invisible everywhere" for bone-rigged FX (e.g.
      // fx-complex-plume-1 / fx-simple-shock-1, used by waterfall-hydrolox-lower-1's
      // outerGlow/shock01-03): vPlumePos above (arg = -dot(pos,axis) in OBJECT/BIND
      // space) assumes the mesh's own pre-skin local coordinate directly encodes
      // "distance along the exhaust" — true for simple static meshes like fx-cylinder
      // (verified working, kerolox-lower-1), but meaningless once SCALEMODIFIER/
      // POSITIONMODIFIER reshape the skeleton: these bone rigs' bind mesh spans
      // local Z in [0, +few] (all one sign), so arg=-dot(pos,(0,0,1)) is negative
      // over virtually the entire mesh. FRAG's fadeIn term
      // (fade *= smoothstep(0.0, max(uFadeIn,1e-5), vPlumePos)) then hard-zeros
      // every fragment whenever uFadeIn is left at its default 0 (true for every
      // modifier in this template — nothing sets _FadeIn/_FadeOut on these effects),
      // making the whole draw fully transparent even though geometry/position/normals
      // and every material uniform are otherwise correct (confirmed by temporarily
      // forcing a solid debug color through the same draw calls — the mesh appears
      // exactly where expected). Bone-deformed local coordinates can't drive a
      // meaningful "progress along the plume" value, so skip that masking for skinned
      // draws by feeding a neutral pass-through: 0.5 clears the fadeIn smoothstep's
      // threshold (needs >= ~0) without tripping the fadeOut falloff further down
      // (needs <= 1-fadeOut), matching "no fade in/out configured" — the correct
      // behavior for every stock template's bone-rigged effect layers, none of which
      // author FadeIn/FadeOut modifiers.
      vPlumePos = 0.5;
      gl_Position = uProj * uView * wp;
      return;
    }
    vec4 wp = uModel * vec4(pos,1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(uNormalMat * nrm);
    gl_Position = uProj * uView * wp;
  }`;

  const FRAG = `#version 300 es
  precision highp float;
  in vec2 vUV; in vec3 vWorldNormal; in vec3 vWorldPos; in float vPlumePos;
  out vec4 frag;
  uniform sampler2D uMainTex;
  uniform vec3 uCamPos;
  uniform float uTimeX;         // Unity _Time.x == time/20
  uniform int  uMode;           // 0 dynamic-additive, 1 directional, 2 alpha-dynamic, 3 billboard
  uniform vec4 uPlumeDir;
  uniform mat3 uNormalMat;
  uniform mat4 uModel;
  uniform vec4 uStartTint, uEndTint;
  uniform float uTintFalloff, uFalloff, uFresnel, uFresnelInvert, uNoise;
  uniform float uBrightness, uClipBrightness, uIntensity, uDirAdjust;
  uniform float uFadeIn, uFadeOut, uFalloffStart, uSymmetry, uSymmetryStrength;
  uniform float uSeed, uSpeedX, uSpeedY, uTileX, uTileY;
  uniform int uToneMap;   // 0 = raw HDR output (fed into a float FBO / bloom pass),
                           // 1 = in-shader Reinhard tonemap (soft-knee rolloff for LDR targets)
  const float PI = 3.1415926535;

  vec3 toneMap(vec3 c){
    // Waterfall assumes an HDR camera (see WaterfallEffect.SetHDR: _ClipBrightness
    // goes to 50 under HDR vs 1 otherwise) and relies on KSP/TUFX bloom + the stock
    // tonemapper to turn the >1 emission into soft, blown-out highlights instead of
    // a hard-edged clip. When we can't run a full HDR+bloom pipeline (the shared
    // model-viewer canvas) we approximate that rolloff per-fragment with Reinhard.
    // Tonemapping c/(1+c) PER CHANNEL (the previous approach) desaturates toward
    // white as soon as every channel individually gets large — which happens right
    // where several thin, near-axis additive cones (a template's innermost "core"
    // layers, e.g. BDB_F1's plume+shock1+redVacEffect) stack on the same pixels and
    // push R, G and B all past ~3-4, even though their ratio is still strongly
    // tinted. Map the scalar luminance instead and rescale the original RGB by the
    // luminance ratio, so only brightness compresses and hue/saturation survive.
    if (uToneMap!=1) return c;
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    if (luma <= 1e-5) return c;
    float mapped = luma/(1.0+luma);
    return c * (mapped/luma);
  }

  void main(){
    if (uMode==3){ // Billboard (Additive)
      vec4 c = texture(uMainTex, vUV);
      vec3 col = clamp(c.rgb * uStartTint.rgb * 2.0, 0.0, 50.0);
      frag = vec4(toneMap(col), 1.0);
      return;
    }
    vec2 scrollUV = vUV + vec2(uSpeedX*uTimeX + uSeed, uSpeedY*uTimeX + uSeed);
    vec4 c = texture(uMainTex, scrollUV * vec2(uTileX, uTileY));

    vec3 worldNormal = normalize(vWorldNormal);
    vec3 viewDir = normalize(uCamPos - vWorldPos);
    // Match the real shader's dirdot = dot(viewDir, normalize(mul(unity_ObjectToWorld,
    // _PlumeDir))) (see Additive.shader / Additive Directional.shader surf()): that's
    // the PLAIN model matrix's upper-left 3x3 (rotation+scale), applied directly — NOT
    // the inverse-transpose normal matrix (uNormalMat), which only agrees with the
    // model matrix for pure-rotation (no scale, or uniform scale) transforms. Effects
    // like fx-sharp-plane's innerGlow (rotationOffset=90 + non-uniform template scale)
    // and the skinned fx-simple-plume-ion PlaneMesh diverge there, which mis-evaluates
    // dirdot against the wrong axis and prevents the intended view-angle fade — showing
    // as a hard bright disk/arc instead of a soft glow. uModel here is the exact world
    // matrix used to build vWorldPos/gl_Position for this draw (set alongside
    // uNormalMat at every call site), so mat3(uModel) is the correct match.
    vec3 plumeDir = normalize(mat3(uModel) * uPlumeDir.xyz);

    float rim, rim2;
    if (uMode==1){ // Additive Directional
      float dcross = abs(dot(plumeDir, viewDir));
      float viewdot2 = dot(worldNormal, viewDir); if (viewdot2<0.0) viewdot2 = -viewdot2;
      rim  = clamp(smoothstep(0.0,1.0,clamp(viewdot2,0.0,1.0)) + pow(clamp(dcross*uDirAdjust,0.0,1.0),2.0), 0.0, 1.0);
      rim2 = smoothstep(1.0,0.0,clamp(viewdot2,0.0,1.0));
    } else { // dynamic (additive or alpha)
      vec3 plumeFlow = normalize(cross(cross(plumeDir, worldNormal), worldNormal));
      vec3 view = normalize(cross(cross(viewDir, plumeFlow), plumeFlow));
      float viewdot = abs(dot(worldNormal, view));
      rim  = smoothstep(0.0,1.0,clamp(viewdot,0.0,1.0));
      rim2 = clamp(1.0 - rim, 0.001, 10.0);
    }

    float g = min(1.0, (1.0 + uFalloffStart) * vUV.y);
    float fade = pow(g, uFalloff);
    float vv = pow(fade * (rim*0.5 + 0.5), uTintFalloff);
    vec4 gradient = mix(uEndTint, uStartTint, min(1.0, vv));

    float cscalar = (uMode==2) ? c.a : dot(c.rgb, vec3(0.3333));
    float col = mix(0.5, cscalar, uNoise);
    float noise = mix(col, 1.0, fade);

    float viewdotG = (uMode==1) ? 1.0 : abs(dot(worldNormal, normalize(cross(cross(viewDir,
                     normalize(cross(cross(plumeDir,worldNormal),worldNormal))),
                     normalize(cross(cross(plumeDir,worldNormal),worldNormal))))));
    fade *= smoothstep(0.0, max(uFadeIn,1e-5), vPlumePos);
    float fOut = uFadeOut + 0.0001;
    fade *= max(0.0, clamp(viewdotG,0.0,1.0) - max(0.0, (fOut + vPlumePos - 1.0)/fOut));
    fade *= 1.0 - uSymmetryStrength + uSymmetryStrength * pow(cos(uSymmetry*PI*vUV.x), 2.0);

    float fexp = (1.0 - noise + 0.5*uNoise);
    float fres  = pow(rim,  clamp(fexp*uFresnel, 0.0, 30.0));
    float fresI = pow(rim2, clamp(fexp*uFresnelInvert, 0.001, 10.0));

    if (uMode==2){ // Alpha (Dynamic) — NOT premultiplied: Waterfall's own shader
      // (Alpha (Dynamic).shader / Alpha Directional.shader, docs/RenderPasses.md Q4)
      // declares "Blend SrcAlpha OneMinusSrcAlpha", i.e. a standard non-premultiplied
      // alpha blend, not additive. Output raw (unmultiplied) color + alpha here and let
      // the caller's gl.blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ...) do the
      // multiply — this used to be baked in here (color*a, a) while drawEffects()
      // still applied a fixed ONE/ONE additive blendFunc for every material regardless
      // of mode, so a dark, low-alpha overlay (e.g. BDB_F1's film-cooling skirt) summed
      // to ~zero delta against the framebuffer (additive of near-black is a no-op) and
      // was effectively invisible however high _Intensity/_Falloff were tuned.
      float a = clamp(fres * fresI * fade * noise * uIntensity, 0.0, 1.0);
      frag = vec4(toneMap(gradient.rgb), a);
      return;
    }
    vec3 emission = clamp(gradient.rgb * fres * fresI * fade * noise * uBrightness,
                          0.0, uClipBrightness);
    frag = vec4(toneMap(emission), 1.0);
  }`;

  const LINE_VERT = `#version 300 es
  layout(location=0) in vec3 aPos;
  uniform mat4 uModel, uView, uProj;
  void main(){ gl_Position = uProj*uView*uModel*vec4(aPos,1.0); }`;
  const LINE_FRAG = `#version 300 es
  precision mediump float; uniform vec3 uColor; out vec4 frag;
  void main(){ frag = vec4(uColor,1.0); }`;

  // ---------------- DDS (BC1/BC3) decode ----------------
  function decodeDDS(buf){
    const dv=new DataView(buf);
    if(dv.getUint32(0,true)!==0x20534444) return null;          // 'DDS '
    const h=(o)=>dv.getUint32(o,true);
    const height=h(12), width=h(16);
    const fourCC=h(84);
    const FCC=(s)=>s.charCodeAt(0)|(s.charCodeAt(1)<<8)|(s.charCodeAt(2)<<16)|(s.charCodeAt(3)<<24);
    let mode; if(fourCC===FCC('DXT1'))mode=1; else if(fourCC===FCC('DXT5'))mode=5;
    else if(fourCC===FCC('DXT3'))mode=3; else return null;
    const out=new Uint8Array(width*height*4);
    let off=128;
    const bw=Math.max(1,width>>2), bh=Math.max(1,height>>2);
    for(let by=0;by<bh;by++) for(let bx=0;bx<bw;bx++){
      let alpha=null;
      if(mode===5){
        const a0=dv.getUint8(off), a1=dv.getUint8(off+1);
        let bits=0n; for(let k=0;k<6;k++) bits|=BigInt(dv.getUint8(off+2+k))<<BigInt(8*k);
        alpha=(i)=>{
          const code=Number((bits>>BigInt(3*i))&7n);
          if(a0>a1) return code===0?a0:code===1?a1:Math.round(((8-code)*a0+(code-1)*a1)/7);
          return code===0?a0:code===1?a1:code===6?0:code===7?255:Math.round(((6-code)*a0+(code-1)*a1)/5);
        };
        off+=8;
      } else if(mode===3){ off+=8; alpha=()=>255; }
      const c0=dv.getUint16(off,true), c1=dv.getUint16(off+2,true);
      const lut=dv.getUint32(off+4,true); off+=8;
      const col=(v)=>[((v>>11)&31)*255/31,((v>>5)&63)*255/63,(v&31)*255/31];
      const a=col(c0), b=col(c1); const p=[a,b,[0,0,0],[0,0,0]];
      if(mode!==1 || c0>c1){
        p[2]=[(2*a[0]+b[0])/3,(2*a[1]+b[1])/3,(2*a[2]+b[2])/3];
        p[3]=[(a[0]+2*b[0])/3,(a[1]+2*b[1])/3,(a[2]+2*b[2])/3];
      } else {
        p[2]=[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2]; p[3]=[0,0,0];
      }
      for(let py=0;py<4;py++) for(let px=0;px<4;px++){
        const x=bx*4+px, y=by*4+py; if(x>=width||y>=height) continue;
        const ci=(lut>>(2*(py*4+px)))&3; const rgb=p[ci];
        const oi=(y*width+x)*4;
        out[oi]=rgb[0]|0; out[oi+1]=rgb[1]|0; out[oi+2]=rgb[2]|0;
        out[oi+3]=mode===5? alpha(py*4+px) : (mode===1&&c0<=c1&&ci===3?0:255);
      }
    }
    return {width,height,rgba:out};
  }

  // ---------------- effect parsing (pure) ----------------
  const kv=(n,k,d)=>{ const e=(n.k||[]).find(([kk])=>kk===k); return e?e[1]:d; };
  const kids=(n,h)=>(n.c||[]).filter(c=>c.h===h);
  const num=(v,d)=>{ const f=parseFloat(v); return isNaN(f)?d:f; };
  const vec=(v,d)=>{ if(v==null) return d.slice(); const a=String(v).split(',').map(parseFloat); return a.map((x,i)=>isNaN(x)?d[i]:x); };

  function shaderMode(name){
    const s=(name||'').toLowerCase();
    // Distortion/volumetric shaders (Distort Dynamic.shader, Additive *Volumetric*.shader,
    // Additive Cones Volumetric.shader) aren't reproducible without a screen-space warp or
    // raymarch pass; we don't drop them (they'd otherwise silently vanish) — instead they
    // fall back to the plain additive-dynamic look (mode 0) using whatever _StartTint/
    // _Brightness/_MainTex the material actually has, same as Waterfall's own constant
    // DistortQueue treatment (Settings.DistortQueue = TransparentQueueBase+2) of not
    // needing camera-depth sorting.
    const isDistort = s.includes('distort') || s.includes('volumetric');
    if(s.includes('billboard')) return {mode:3, expand:false, billboard:true, isDistort};
    if(s.includes('alpha')) return {mode:2, expand:s.includes('dynamic'), billboard:false, isDistort};
    if(s.includes('directional')||s==='waterfall/additive') return {mode:1, expand:false, billboard:false, isDistort};
    if(s && s!=='waterfall/additive (dynamic)') warnShaderFallback(name);
    return {mode:0, expand:true, billboard:false, isDistort};
  }
  function warnShaderFallback(name){
    const key='shader|'+name;
    if(_warned.has(key)) return; _warned.add(key);
    console.warn('[plume] unsupported shader "'+name+'", falling back to the additive-dynamic path');
  }
  function meshKindFor(path){
    const p=(path||'').toLowerCase();
    if(p.includes('billboard')) return 'quad';
    return 'cyl';
  }

  function parseEffect(eff){
    const modelNodes=kids(eff,'MODEL');
    const models=[];
    for(const model of modelNodes){
      const path=kv(model,'path')||'';
      const mpos=vec(kv(model,'positionOffset'),[0,0,0]);
      const mrot=vec(kv(model,'rotationOffset'),[0,0,0]);
      const msca=vec(kv(model,'scaleOffset'),[1,1,1]);
      const meshKind=meshKindFor(path);
      const mats=[];
      for(const mat of kids(model,'MATERIAL')){
        const sm=shaderMode(kv(mat,'shader'));
        const floats={}, colors={}, tex={};
        for(const f of kids(mat,'FLOAT')) floats[kv(f,'floatName')]=num(kv(f,'value'),0);
        for(const c of kids(mat,'COLOR')) colors[kv(c,'colorName')]=vec(kv(c,'colorValue'),[1,1,1,1]);
        for(const t of kids(mat,'TEXTURE')){
          if(kv(t,'textureSlotName')==='_MainTex'){
            tex.main=kv(t,'texturePath');
            tex.scale=vec(kv(t,'textureScale'),[1,1]);
            tex.offset=vec(kv(t,'textureOffset'),[0,0]);
          }
        }
        mats.push({sm, meshKind, tex, transform:kv(mat,'transform'),
                   baseFloats:{...floats}, baseColors:JSON.parse(JSON.stringify(colors))});
      }
      models.push({path, mpos, mrot, msca, meshKind, mats});
    }
    // Names that resolve to the model ROOT node ('<path>(Clone)', the path, parentName).
    const rootAliases=new Set();
    if(kv(eff,'parentName')) rootAliases.add(kv(eff,'parentName'));
    for(const m of models){ if(m.path){ rootAliases.add(m.path); rootAliases.add(m.path+'(Clone)'); } }

    const mods=[];
    const MT={FLOATMODIFIER:'float',COLORMODIFIER:'color',SCALEMODIFIER:'scale',
              POSITIONMODIFIER:'position',ROTATIONMODIFIER:'rotation',UVOFFSETMODIFIER:'uv'};
    for(const c of (eff.c||[])){
      const kind=MT[c.h]; if(!kind) continue;
      mods.push({
        kind, controllerName:kv(c,'controllerName','throttle'),
        transformName:kv(c,'transformName'), combinationType:kv(c,'combinationType','REPLACE'),
        floatName:kv(c,'floatName'), colorName:kv(c,'colorName'),
        useRandomness:(kv(c,'useRandomness','False')||'').toLowerCase()==='true',
        randomnessController:kv(c,'randomnessController','random'),
        randomnessScale:num(kv(c,'randomnessScale'),1),
        curves:{
          f:curveOf(c,'floatCurve'), x:curveOf(c,'xCurve'), y:curveOf(c,'yCurve'),
          z:curveOf(c,'zCurve'), r:curveOf(c,'rCurve'), g:curveOf(c,'gCurve'),
          b:curveOf(c,'bCurve'), a:curveOf(c,'aCurve')
        }
      });
    }
    return {parentName:kv(eff,'parentName'), models, mods, name:kv(eff,'name'),
            rootAliases};
  }
  // Parse CONTROLLER/ENGINEEVENTCONTROLLER nodes off a ModuleWaterfallFX node into
  // { name -> {eventName, eventDuration, curve} } for engine-event-linked controllers
  // (ignition/flameout). Two authoring forms both resolve here (see
  // docs/WaterfallTemplatePatterns.md sec.5 and Source/Waterfall/EffectControllers/
  // EngineEventController.cs): a dedicated ENGINEEVENTCONTROLLER node, or a legacy
  // CONTROLLER node with linkedTo=engineEvent. eventCurve's time axis is SECONDS since
  // the event fired (not normalized 0-1) per EngineEventController.cs's eventTime.
  function parseEventControllers(moduleNode){
    const out={};
    if(!moduleNode || !moduleNode.c) return out;
    for(const c of moduleNode.c){
      const isEvt = c.h==='ENGINEEVENTCONTROLLER' || (c.h==='CONTROLLER' && (kv(c,'linkedTo')||'').toLowerCase()==='engineevent');
      if(!isEvt) continue;
      const name=kv(c,'name'); if(!name) continue;
      out[name]={
        eventName:(kv(c,'eventName')||'').toLowerCase(),
        eventDuration:num(kv(c,'eventDuration'),1),
        curve:curveOf(c,'eventCurve')
      };
    }
    return out;
  }

  function parseEffectList(effectsJson){
    let list=[];
    if(Array.isArray(effectsJson)) list=effectsJson;
    else if(effectsJson && effectsJson.h==='EFFECTTEMPLATE') list=kids(effectsJson,'EFFECT');
    else if(effectsJson && effectsJson.h==='EFFECT') list=[effectsJson];
    else if(effectsJson && Array.isArray(effectsJson.c)) list=effectsJson.c.filter(c=>c.h==='EFFECT');
    return list.map(parseEffect);
  }
  function curveOf(node, name){
    const cn=(node.c||[]).find(c=>c.h===name); if(!cn) return null;
    const keys=[];
    for(const [k,v] of cn.k){ if(k!=='key') continue;
      const p=String(v).trim().split(/\s+/).map(parseFloat);
      keys.push({t:p[0], v:p[1], inT:isNaN(p[2])?0:p[2], outT:isNaN(p[3])?0:p[3]});
    }
    keys.sort((a,b)=>a.t-b.t);
    return keys.length?keys:null;
  }
  function evalCurve(keys, x){
    if(!keys||!keys.length) return 0;
    if(x<=keys[0].t) return keys[0].v;
    if(x>=keys[keys.length-1].t) return keys[keys.length-1].v;
    let i=0; while(i<keys.length-1 && keys[i+1].t<x) i++;
    const k0=keys[i], k1=keys[i+1]; const dt=k1.t-k0.t||1e-6; const s=(x-k0.t)/dt;
    const s2=s*s, s3=s2*s;
    const h00=2*s3-3*s2+1, h10=s3-2*s2+s, h01=-2*s3+3*s2, h11=s3-s2;
    return h00*k0.v + h10*dt*k0.outT + h01*k1.v + h11*dt*k1.inT;
  }
  // Resolve a controller reference: exact-name lookup, else a sensible documented
  // default for controllers plume.js doesn't (yet) evaluate rather than leaving an
  // effect stuck dark at 0 — see MISSING-CONTROLLER DEFAULTS below.
  //   - any name containing "random" (e.g. a part's own CONTROLLER{linkedTo=random,
  //     name=random1} alias, seen on stock-hydrolox-lower-2/SSME) aliases the single
  //     animated `random` value computed each frame in draw() — real per-name seeds/
  //     speeds aren't modeled, but the effect at least jitters instead of sitting static.
  //   - everything else (custom/constant/unrecognized controllers with no evaluator)
  //     defaults to 0, matching a REPLACE modifier's curve evaluated at its x=0 key —
  //     i.e. "off"/invisible at rest for the additive startup-flash layers this is
  //     usually used for (see docs/WaterfallTemplatePatterns.md sec.5), not a stray
  //     mid-curve value that would render as a static dark shape.
  function ctrlVal(controllers, name){
    if(controllers[name]!=null) return controllers[name];
    if(name && /random/i.test(name)) return controllers.random||0;
    return 0;
  }
  function fold(base, val, type){
    switch(type){
      case 'ADD': return base+val;
      case 'SUBTRACT': return base-val;
      case 'MULTIPLY': return base*val;
      default: return val;    // REPLACE
    }
  }

  // fold FLOAT/COLOR/UVOFFSET modifiers onto a material's bases -> draw params.
  // A modifier applies to this material when its transformName matches the material's
  // transform, is empty, or names the model root (whole-effect).
  function computeMaterialParams(eff, model, mat, controllers){
    const floats={...mat.baseFloats};
    const colors=JSON.parse(JSON.stringify(mat.baseColors));
    let uvoff=[0,0];
    for(const m of eff.mods){
      if(m.kind!=='float' && m.kind!=='color' && m.kind!=='uv') continue;
      const tn=m.transformName;
      const applies = !tn || tn===mat.transform || eff.rootAliases.has(tn);
      if(!applies) continue;
      const cv=ctrlVal(controllers,m.controllerName);
      let rnd=1; if(m.useRandomness) rnd=1+((ctrlVal(controllers,m.randomnessController))-0.5)*2*m.randomnessScale*0.2;
      if(m.kind==='float' && m.floatName){
        const val=evalCurve(m.curves.f,cv)*rnd;
        floats[m.floatName]=fold(floats[m.floatName]!=null?floats[m.floatName]:0, val, m.combinationType);
      } else if(m.kind==='color' && m.colorName){
        const base=colors[m.colorName]||[1,1,1,1];
        colors[m.colorName]=[fold(base[0],evalCurve(m.curves.r,cv),m.combinationType),
                             fold(base[1],evalCurve(m.curves.g,cv),m.combinationType),
                             fold(base[2],evalCurve(m.curves.b,cv),m.combinationType),
                             fold(base[3],evalCurve(m.curves.a,cv),m.combinationType)];
      } else if(m.kind==='uv'){
        uvoff=[fold(uvoff[0],evalCurve(m.curves.x,cv),m.combinationType),
               fold(uvoff[1],evalCurve(m.curves.y,cv),m.combinationType)];
      }
    }
    return {floats, colors, uvoff};
  }

  // Resolve SCALE/POSITION/ROTATION modifiers to per-node local-TRS overrides.
  // Returns nodeName -> {pos:[3], rmat:mat4, sca:[3]} folded from the node's bind TRS
  // in listed order per (node,property). rootName receives root-alias targets.
  function computeNodeOverrides(eff, model, glModel, controllers, rootName, rootBaseTRS){
    const byName=glModel ? glModel.byName : {};
    const state={};   // nodeName -> {pos, rmat, sca, rotEuler|null, rotType}
    function ensure(name){
      if(state[name]) return state[name];
      let bind;
      if(name===rootName) bind={pos:rootBaseTRS.pos.slice(), rmat:rootBaseTRS.rmat.slice(), sca:rootBaseTRS.sca.slice()};
      else { const nd=byName[name]; bind = nd ? {pos:nd.pos.slice(), rmat:nd.rmat.slice(), sca:nd.sca.slice()}
                                            : {pos:[0,0,0], rmat:M.ident(), sca:[1,1,1]}; }
      const st={pos:bind.pos, rmat:bind.rmat, sca:bind.sca};
      state[name]=st; return st;
    }
    for(const m of eff.mods){
      if(m.kind!=='scale' && m.kind!=='position' && m.kind!=='rotation') continue;
      let tn=m.transformName;
      if(!tn) continue;
      let name;
      if(eff.rootAliases.has(tn)) name=rootName;
      else if(byName[tn]) name=tn;
      else if(tn===rootName) name=rootName;
      else { name=null; }
      if(!name){ warnMissingNode(model.path, tn); continue; }
      const st=ensure(name);
      const cv=ctrlVal(controllers,m.controllerName);
      let rnd=1; if(m.useRandomness) rnd=1+((ctrlVal(controllers,m.randomnessController))-0.5)*2*m.randomnessScale*0.2;
      if(m.kind==='scale'){
        st.sca=[fold(st.sca[0], m.curves.x?evalCurve(m.curves.x,cv)*rnd:st.sca[0], m.curves.x?m.combinationType:'REPLACE'),
                fold(st.sca[1], m.curves.y?evalCurve(m.curves.y,cv)*rnd:st.sca[1], m.curves.y?m.combinationType:'REPLACE'),
                fold(st.sca[2], m.curves.z?evalCurve(m.curves.z,cv)*rnd:st.sca[2], m.curves.z?m.combinationType:'REPLACE')];
      } else if(m.kind==='position'){
        st.pos=[fold(st.pos[0], m.curves.x?evalCurve(m.curves.x,cv):st.pos[0], m.curves.x?m.combinationType:'REPLACE'),
                fold(st.pos[1], m.curves.y?evalCurve(m.curves.y,cv):st.pos[1], m.curves.y?m.combinationType:'REPLACE'),
                fold(st.pos[2], m.curves.z?evalCurve(m.curves.z,cv):st.pos[2], m.curves.z?m.combinationType:'REPLACE')];
      } else if(m.kind==='rotation'){
        const e=[m.curves.x?evalCurve(m.curves.x,cv):0, m.curves.y?evalCurve(m.curves.y,cv):0, m.curves.z?evalCurve(m.curves.z,cv):0];
        const rm=M.euler(e);
        st.rmat = (m.combinationType==='ADD') ? M.mul(rm, st.rmat) : rm;   // REPLACE or ADD
      }
    }
    return state;
  }

  const _warned=new Set();
  function warnMissingNode(path, name){
    const key=path+'|'+name;
    if(_warned.has(key)) return; _warned.add(key);
    console.warn('[plume] modifier transformName not found as node in '+path+': '+name);
  }
  function warnFallback(path, reason){
    if(_warned.has('fb|'+path)) return; _warned.add('fb|'+path);
    console.warn('[plume] FX model fallback (procedural cylinder) for '+path+': '+reason);
  }

  /* ---------------- per-GL-context renderer ---------------- */
  function createCtx(gl){
    function compileSh(type, src){
      const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))
        throw new Error('shader: '+gl.getShaderInfoLog(s));
      return s;
    }
    function link(vs, fs){
      const p=gl.createProgram();
      gl.attachShader(p,compileSh(gl.VERTEX_SHADER,vs));
      gl.attachShader(p,compileSh(gl.FRAGMENT_SHADER,fs));
      gl.linkProgram(p);
      if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error('link: '+gl.getProgramInfoLog(p));
      return p;
    }
    const prog=link(VERT,FRAG);
    const uniNames=['uModel','uView','uProj','uNormalMat','uExpand','uBillboard','uSkinned','uPlumeDir','uMainTexST',
      'uExpandOffset','uExpandLinear','uExpandSquare','uExpandBounded','uMainTex','uCamPos',
      'uTimeX','uMode','uStartTint','uEndTint','uTintFalloff','uFalloff','uFresnel',
      'uFresnelInvert','uNoise','uBrightness','uClipBrightness','uIntensity','uDirAdjust',
      'uFadeIn','uFadeOut','uFalloffStart','uSymmetry','uSymmetryStrength',
      'uSeed','uSpeedX','uSpeedY','uTileX','uTileY','uToneMap'];
    const uni={}; for(const n of uniNames) uni[n]=gl.getUniformLocation(prog,n);
    const uBones=[]; for(let i=0;i<MAX_BONES;i++) uBones.push(gl.getUniformLocation(prog,'uBones['+i+']'));
    const lineProg=link(LINE_VERT,LINE_FRAG);
    const luni={uModel:gl.getUniformLocation(lineProg,'uModel'),
                uView:gl.getUniformLocation(lineProg,'uView'),
                uProj:gl.getUniformLocation(lineProg,'uProj'),
                uColor:gl.getUniformLocation(lineProg,'uColor')};

    // build a VAO with pos/nrm/uv (+ optional bone idx/wt). arrays are plain JS arrays.
    function buildMesh(pos,nrm,uv,idx,boneIdx,boneWt){
      const vao=gl.createVertexArray(); gl.bindVertexArray(vao);
      const mk=(loc,arr,size)=>{const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(arr),gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,0,0);};
      mk(0,pos,3); mk(1,nrm&&nrm.length?nrm:zeros(pos.length),3); mk(2,uv&&uv.length?uv:zeros((pos.length/3)*2),2);
      if(boneIdx&&boneWt){ mk(3,boneIdx,4); mk(4,boneWt,4); }
      const ib=gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(idx),gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return {vao, count:idx.length};
    }
    function zeros(n){ return new Float32Array(n); }
    function makeCylinder(radial=64, along=48){
      const pos=[], nrm=[], uv=[], idx=[];
      for(let j=0;j<=along;j++){
        const t=j/along; const y=-t;
        for(let i=0;i<=radial;i++){
          const a=i/radial*2*Math.PI;
          const cx=Math.cos(a), cz=Math.sin(a);
          pos.push(0.5*cx, y, 0.5*cz);
          nrm.push(cx, 0, cz);
          uv.push(i/radial, 1-t);
        }
      }
      const stride=radial+1;
      for(let j=0;j<along;j++) for(let i=0;i<radial;i++){
        const a=j*stride+i, b=a+1, cc=a+stride, d=cc+1;
        idx.push(a,cc,b, b,cc,d);
      }
      return buildMesh(pos,nrm,uv,idx);
    }
    function makeQuad(){
      return buildMesh([-0.5,-0.5,0, 0.5,-0.5,0, 0.5,0.5,0, -0.5,0.5,0],
                       [0,0,1, 0,0,1, 0,0,1, 0,0,1],
                       [0,0, 1,0, 1,1, 0,1], [0,1,2, 0,2,3]);
    }
    const meshes={cyl:makeCylinder(), quad:makeQuad()};

    // Build GL resources + node registry from a parsed /api/fxmodel result.
    //   nodes: [{name, pos, rmat, sca, parent, meshes:[{glMesh, matIdx, skinned, bones, bindPoses}]}]
    //   byName: name -> node ; rootIndex: 0 ; rootName kept by caller
    function buildFxModel(parsed){
      const nodes=[], byName={};
      function walk(obj, parentIdx){
        const idx=nodes.length;
        const rmat=M.fromQuat(obj.rotQuat[0],obj.rotQuat[1],obj.rotQuat[2],obj.rotQuat[3]);
        const node={name:obj.name, pos:obj.pos.slice(), rmat, sca:obj.scale.slice(),
                    parent:parentIdx, meshes:[]};
        nodes.push(node);
        if(obj.name && !(obj.name in byName)) byName[obj.name]=node;
        const mesh=obj.mesh;
        if(mesh && mesh.verts && mesh.tris){
          const skinned=!!(obj.skinned && mesh.boneWeights && obj.bones && obj.bones.length);
          const rmats=obj.rendererMaterials||[];
          let bi=null, bw=null;
          if(skinned){ bi=mesh.boneIndices; bw=mesh.boneWeights; }
          mesh.tris.forEach((sub,si)=>{
            if(!sub||!sub.length) return;
            const glMesh=buildMesh(mesh.verts, mesh.normals, mesh.uvs, sub,
                                   bi, bw);
            const matIdx=rmats[si]!=null?rmats[si]:(rmats[0]!=null?rmats[0]:-1);
            // mesh.bindPoses come from the .mu file as Unity's native ROW-major Matrix4x4
            // serialization (translation in the last COLUMN: indices 3,7,11 — verified
            // empirically against fx-complex-plume-1/fx-simple-shock-1: un-transposed, the
            // "translation" value lands at index 7 instead of 12/13/14, and skinning with it
            // blows the mesh out to ~90 Unity units along the wrong (Z) axis. Every other
            // matrix in this file (fromQuat, TRS, node worlds) is column-major (translation
            // at 12/13/14), so bindPoses must be transposed once here to match; transposed,
            // the skinned CylinderMesh collapses to a small, sane extent along -Y exactly
            // like the static fx-cylinder mesh (see report).
            const bindPoses = mesh.bindPoses ? mesh.bindPoses.map(M.transpose) : null;
            node.meshes.push({glMesh, matIdx, skinned,
                              bones:obj.bones||null, bindPoses});
          });
        }
        for(const c of (obj.children||[])) walk(c, idx);
      }
      walk(parsed.tree, -1);
      return {nodes, byName, rootName:parsed.tree.name, materials:parsed.materials||[],
              textures:parsed.textures||[]};
    }

    // world Unity matrices for all nodes, applying per-node TRS overrides.
    // rootName's base is rootBaseTRS (the MODEL offsets); other nodes use bind TRS.
    function computeWorlds(glModel, overrides, rootName, rootBaseTRS){
      const worlds=new Array(glModel.nodes.length);
      glModel.nodes.forEach((nd,i)=>{
        let local;
        const ov=overrides[nd.name] || (nd.name===rootName?overrides[rootName]:null);
        if(nd.name===rootName){
          const st=ov||rootBaseTRS;
          local=trs(st.pos, st.rmat, st.sca);
        } else if(ov){
          local=trs(ov.pos, ov.rmat, ov.sca);
        } else {
          local=trs(nd.pos, nd.rmat, nd.sca);
        }
        worlds[i]= nd.parent<0 ? local : M.mul(worlds[nd.parent], local);
      });
      return worlds;
    }

    const whiteTex=(()=>{ const t=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([200,200,200,255]));
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); return t; })();
    const texCache=new Map();
    let dead=false;
    const onTexLoaded=[];

    function uploadRGBA(w,h,rgba){
      const t=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      return t;
    }
    function loadTexture(path){
      if(!path) return whiteTex;
      if(texCache.has(path)) return texCache.get(path);
      texCache.set(path, whiteTex);
      (async()=>{
        let resp;
        try { resp = await fetch('/api/texture?path='+encodeURIComponent(path)); if(!resp.ok) resp=null; }
        catch(e){ resp=null; }
        if(!resp){ try{ resp=await fetch('/api/wftex?path='+encodeURIComponent(path)); }catch(e){ return; } }
        if(!resp || !resp.ok) return;
        const buf=await resp.arrayBuffer();
        const dec=decodeDDS(buf);
        if(dec && dec.rgba && !dead){
          texCache.set(path, uploadRGBA(dec.width,dec.height,dec.rgba));
          onTexLoaded.forEach(f=>{try{f();}catch(e){}});
        }
      })();
      return texCache.get(path);
    }

    // ---- fxmodel fetch cache (per context) ----
    const fxCache=new Map();   // path -> {status:'loading'|'ok'|'fail', glModel}
    function ensureFxModel(path){
      if(!path) return {status:'fail'};
      if(fxCache.has(path)) return fxCache.get(path);
      const entry={status:'loading', glModel:null};
      fxCache.set(path, entry);
      (async()=>{
        try{
          const resp=await fetch('/api/fxmodel?path='+encodeURIComponent(path));
          const data= resp.ok ? await resp.json() : null;
          if(dead) return;
          if(!data || data.error || !data.tree){ entry.status='fail'; warnFallback(path, (data&&data.error)||'load failed');
            onTexLoaded.forEach(f=>{try{f();}catch(e){}}); return; }
          entry.glModel=buildFxModel(data); entry.status='ok';
        }catch(e){ entry.status='fail'; warnFallback(path, String(e)); }
        onTexLoaded.forEach(f=>{try{f();}catch(e){}});   // wake render loops
      })();
      return entry;
    }

    // set all the FRAG uniforms for a material's current params
    function setMaterialUniforms(mat, floats, colors, uvoff, sm){
      gl.uniform1i(uni.uMode,sm.mode);
      const F=(n,d)=>floats[n]!=null?floats[n]:d;
      gl.uniform1f(uni.uExpandOffset,F('_ExpandOffset',0));
      gl.uniform1f(uni.uExpandLinear,F('_ExpandLinear',0));
      gl.uniform1f(uni.uExpandSquare,F('_ExpandSquare',0));
      gl.uniform1f(uni.uExpandBounded,F('_ExpandBounded',0));
      const C=(n,d)=>colors[n]||d;
      gl.uniform4fv(uni.uStartTint,C('_StartTint',[1,1,1,1]));
      gl.uniform4fv(uni.uEndTint,C('_EndTint',[1,1,1,1]));
      gl.uniform1f(uni.uTintFalloff,F('_TintFalloff',1));
      gl.uniform1f(uni.uFalloff,F('_Falloff',1));
      gl.uniform1f(uni.uFresnel,F('_Fresnel',0));
      gl.uniform1f(uni.uFresnelInvert,F('_FresnelInvert',0));
      gl.uniform1f(uni.uNoise,F('_Noise',0));
      // Distortion (Dynamic) (Distort Dynamic.shader) is a GrabPass screen-space
      // refraction shader: it has no _StartTint/_EndTint/_Brightness properties at
      // all in ShaderLab, and with the default _Highlight=0 its frag() just resamples
      // a warped copy of the background — it contributes ~zero emissive color of its
      // own. We can't reproduce real screen-space refraction here, so isDistort
      // materials are drawn through the plain additive-dynamic path as a stand-in
      // (see shaderMode()) rather than being dropped. But that path's tint/brightness
      // uniforms fall back to the *Additive* shaders' Unity Properties defaults
      // ((1,1,1,1) / 1) whenever a cfg doesn't override them — and Distortion
      // materials never set _StartTint/_EndTint/_Brightness (those keys don't exist
      // for this shader), so every distort effect was rendering as a big, solid,
      // additively-blended WHITE cone (often the widest-radius mesh in a template) —
      // the "outermost envelope renders white" bug. Force its brightness to 0 so the
      // stand-in draw is a no-op, matching the shader's true near-invisible look.
      gl.uniform1f(uni.uBrightness, sm.isDistort ? 0 : F('_Brightness',1));
      gl.uniform1f(uni.uClipBrightness,F('_ClipBrightness',50));
      gl.uniform1f(uni.uIntensity,F('_Intensity',1));
      gl.uniform1f(uni.uDirAdjust,F('_dirAdjust',F('_DirAdjust',0)));
      gl.uniform1f(uni.uFadeIn,F('_FadeIn',0));
      gl.uniform1f(uni.uFadeOut,F('_FadeOut',0));
      gl.uniform1f(uni.uFalloffStart,F('_FalloffStart',0));
      gl.uniform1f(uni.uSymmetry,F('_Symmetry',0));
      gl.uniform1f(uni.uSymmetryStrength,F('_SymmetryStrength',0));
      gl.uniform1f(uni.uSeed,F('_Seed',0)+uvoff[1]);
      gl.uniform1f(uni.uSpeedX,F('_SpeedX',0));
      gl.uniform1f(uni.uSpeedY,F('_SpeedY',1));
      gl.uniform1f(uni.uTileX,F('_TileX',1));
      gl.uniform1f(uni.uTileY,F('_TileY',1));
      // _PlumeDir ("Exhaust Direction") is never exposed as a cfg-overridable property —
      // WaterfallMaterial.Load() (Source/Waterfall/Effects/WaterfallMaterial.cs) only reads
      // TEXTURE/COLOR/FLOAT subnodes, no VECTOR node type exists, so every template always
      // gets the shader's own ShaderLab default. That default differs by shader family:
      // Additive/Alpha (Dynamic), Distortion (Dynamic) and Procedural Particles all default
      // to (0,1,0,0) (object-space Y), but Additive/Alpha Directional (mode 1 — the shader
      // used on the cross/X-arranged plane meshes in fx-simple-plume-1, fx-complex-plume-1,
      // fx-sharp-plane etc.) default to (0,0,1,0) (object-space Z). We previously hardcoded
      // (0,1,0,0) for every mode, so the Directional shader's edge-on dirAdjust fade
      // (dirdot = dot(viewDir, plumeDir)) evaluated against the wrong axis and never faded
      // the plane out at the angles it should — instead it stayed fully bright across most
      // of the camera range, which is exactly the "flat, mismapped, doesn't correspond to
      // anything in-game" plane-sheet artifact reported for those templates.
      if(sm.mode===1) gl.uniform4f(uni.uPlumeDir,0,0,1,0);
      else gl.uniform4f(uni.uPlumeDir,0,1,0,0);
      const ts=mat.tex.scale||[1,1], to=mat.tex.offset||[0,0];
      gl.uniform4f(uni.uMainTexST, ts[0],ts[1], to[0],to[1]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, loadTexture(mat.tex.main));
      gl.uniform1i(uni.uMainTex,0);
    }

    // Per docs/RenderPasses.md Q4: every Waterfall shader family is Cull Off
    // (double-sided) EXCEPT "Alpha (Dynamic)"/"Alpha Directional" (our mode 2), which
    // is Cull Back, single-sided — a double-sided alpha mesh would show its inside
    // wall through the near wall.
    function applyCull(sm){
      if(sm.mode===2){ gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
      else gl.disable(gl.CULL_FACE);
    }

    // draw one real fxmodel material against its target mesh node(s)
    function drawRealMaterial(eff, model, mat, glModel, worlds, attach, params){
      // find target node by material transform; if absent use first mesh node
      let targetNode = mat.transform && glModel.byName[mat.transform];
      if(!targetNode){
        targetNode = glModel.nodes.find(n=>n.meshes.length);
      }
      if(!targetNode) return;
      setMaterialUniforms(mat, params.floats, params.colors, params.uvoff, mat.sm);
      applyCull(mat.sm);
      gl.uniform1i(uni.uBillboard, mat.sm.billboard?1:0);
      for(const sub of targetNode.meshes){
        const skinned=sub.skinned && !mat.sm.billboard;
        if(skinned){
          gl.uniform1i(uni.uSkinned,1);
          gl.uniform1i(uni.uExpand,0);   // expand is for static meshes only
          // bone matrices: attach * (boneWorld * bindPose), plain Unity-space compose
          const bones=sub.bones, bp=sub.bindPoses;
          let base=null;
          for(let i=0;i<bones.length && i<MAX_BONES;i++){
            const bn=glModel.byName[bones[i]];
            const bworld = bn ? worlds[glModel.nodes.indexOf(bn)] : M.ident();
            const bind = bp && bp[i] ? bp[i] : M.ident();
            const bw = M.mul(bworld, bind);
            const mgl = attach ? M.mul(attach, bw) : bw;
            gl.uniformMatrix4fv(uBones[i], false, mgl);
            if(i===0) base=mgl;
          }
          // uNormalMat / uModel from base bone for the fragment plumeDir
          gl.uniformMatrix4fv(uni.uModel,false, base||M.ident());
          gl.uniformMatrix3fv(uni.uNormalMat,false, M.normalMat(base||M.ident()));
        } else {
          gl.uniform1i(uni.uSkinned,0);
          gl.uniform1i(uni.uExpand, mat.sm.expand?1:0);
          const nodeIdx=glModel.nodes.indexOf(targetNode);
          const world=worlds[nodeIdx];
          const mgl= attach ? M.mul(attach, world) : world;
          gl.uniformMatrix4fv(uni.uModel,false,mgl);
          gl.uniformMatrix3fv(uni.uNormalMat,false,M.normalMat(mgl));
        }
        gl.bindVertexArray(sub.glMesh.vao);
        gl.drawElements(gl.TRIANGLES, sub.glMesh.count, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
      }
    }

    // fallback: draw a procedural cylinder/quad for a material (old behavior)
    function drawFallbackMaterial(model, mat, attach, params){
      setMaterialUniforms(mat, params.floats, params.colors, params.uvoff, mat.sm);
      applyCull(mat.sm);
      gl.uniform1i(uni.uBillboard, mat.sm.billboard?1:0);
      gl.uniform1i(uni.uSkinned,0);
      gl.uniform1i(uni.uExpand, mat.sm.expand?1:0);
      const base=trs(model.mpos, M.euler(model.mrot), model.msca);
      const mgl= attach ? M.mul(attach, base) : base;
      gl.uniformMatrix4fv(uni.uModel,false,mgl);
      gl.uniformMatrix3fv(uni.uNormalMat,false,M.normalMat(mgl));
      const mesh=meshes[mat.meshKind]||meshes.cyl;
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }

    // Waterfall render-queue emulation (Source/Waterfall/Settings.cs +
    // Modules/ModuleWaterfallFX.cs GatherRenderers/SetupRenderersForCamera):
    //   TransparentQueueBase = 3000; DistortQueue = TransparentQueueBase+2 = 3002 (constant,
    //   distortion doesn't need sorting); regular additive/alpha renderers get
    //   TransparentQueueBase + qDelta, qDelta computed from camera-space depth (farther = lower
    //   queue = drawn first), with alpha-blended shaders (_Intensity property, our mode 2)
    //   getting +1 over additive ones at the same depth so they composite after them.
    // All our plume materials use pure additive blending (gl.blendFunc(ONE,ONE)) — including
    // mode 2's premultiplied output — so additive commutes and draw order never changes the
    // final pixel color; we still sort back-to-front by the same rule for parity with the
    // source engine and so depth-testing against solid model geometry behaves consistently.
    function queueFor(mat, worldPos, eye, viewDir){
      if(mat.sm.isDistort) return 3002;   // Settings.DistortQueue, constant (no sorting)
      const d = (worldPos[0]-eye[0])*viewDir[0] + (worldPos[1]-eye[1])*viewDir[1] + (worldPos[2]-eye[2])*viewDir[2];
      const qDelta = 750 - Math.max(0, Math.min(750, d*(750/1000)));  // QueueDepth=750, SortedDepth=1000
      return 3000 + qDelta + (mat.sm.mode===2 ? 1 : 0);   // TransparentQueueBase=3000, alpha-blended +1
    }

    // Blend state per docs/RenderPasses.md Q4: additive families (mode 0/1/3) use
    // Blend One One (order-independent, commutes). Alpha (Dynamic)/Alpha Directional
    // (mode 2) declare Blend SrcAlpha OneMinusSrcAlpha in the real shader — a genuine
    // over-blend, NOT additive — so a dark, low-alpha overlay (film-cooling smoke,
    // soot sheaths) actually darkens/occludes what's beneath it instead of vanishing.
    // Destination alpha is always protected (dstFactor=ZERO srcAlpha / ONE dstAlpha)
    // so the canvas's own transparency-over-page compositing isn't stomped by plume
    // draws (see the long comment above drawEffects() for why that matters here).
    function applyBlend(mode){
      if(mode===2) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      else gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    }

    // cam: {view, proj, eye, time, attach, depthTest, toneMap}
    function drawEffects(effects, controllers, cam){
      if(dead) return;
      gl.useProgram(prog);
      // Additive-blend color (src+dst) but leave the destination ALPHA channel alone
      // (srcFactor=ZERO, dstFactor=ONE for alpha). A plain blendFunc(ONE,ONE) blends
      // alpha the same way as color, so every plume fragment — even where its RGB has
      // faded to ~0 at a mesh's silhouette edge — stamps alpha=1 (FRAG always outputs
      // alpha 1 in the additive/directional/billboard modes; mode 2's alpha is for its
      // own premultiplied RGB, not the destination). On this canvas (model3d.js's
      // gl.clearColor(0,0,0,0) leaves the background transparent so the page's CSS
      // gradient shows through) that alpha=1 stamp overwrites the transparency of every
      // background pixel under a plume mesh's screen-space footprint with opaque
      // near-black — solid black voids/rectangles shaped like the plume geometry, even
      // though the additive RGB math itself was correct. Keeping destination alpha
      // untouched (dstFactor=ONE, srcFactor=ZERO) preserves whatever the opaque model
      // pass already established there (1 over the model, 0 over background) so the
      // browser composites the canvas over the page correctly.
      gl.enable(gl.BLEND); applyBlend(0);   // default additive; drawn calls below switch per-material
      if(cam.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false); gl.disable(gl.CULL_FACE);
      // See docs/RenderingGroundTruth.md T2 / model3d.js's matching comment: the doc's
      // prose says gl.frontFace(gl.CW), but its own numeric test vector proves the
      // front-facing triangle it defines is CCW in this lookAtUnity+mirrorZ view
      // space (Unity's "clockwise" is documented in D3D y-down screen space; in
      // GL/WebGL y-up NDC the equivalent winding is CCW, GL's own default). Keeping
      // the GL default here so applyCull()'s Cull Back on Alpha-family materials
      // culls the correct (inside) face.
      gl.frontFace(gl.CCW);
      gl.uniformMatrix4fv(uni.uView,false,cam.view);
      gl.uniformMatrix4fv(uni.uProj,false,cam.proj);
      gl.uniform3fv(uni.uCamPos,cam.eye);
      gl.uniform1f(uni.uTimeX, cam.time/20);
      gl.uniform1i(uni.uToneMap, cam.toneMap?1:0);
      const attach=cam.attach;
      const eye=cam.eye;
      // view direction in world/unity space (approx: camera looks toward orbit target /
      // model origin; good enough for back-to-front ordering, which is cosmetic here
      // since blending is additive and order-independent).
      const vlen=Math.hypot(cam.view[2],cam.view[6],cam.view[10])||1;
      const viewDir=[-cam.view[2]/vlen,-cam.view[6]/vlen,-cam.view[10]/vlen];

      // Build a flat draw-call list first so it can be sorted by emulated renderQueue.
      const calls=[];
      for(const eff of effects){
        for(const model of eff.models){
          const rootBaseTRS={pos:model.mpos, rmat:M.euler(model.mrot), sca:model.msca};
          const fx=ensureFxModel(model.path);
          if(fx.status==='ok'){
            const glModel=fx.glModel;
            const rootName=glModel.rootName;
            const overrides=computeNodeOverrides(eff, model, glModel, controllers, rootName, rootBaseTRS);
            const worlds=computeWorlds(glModel, overrides, rootName, rootBaseTRS);
            const originW = attach ? M.mul(attach, worlds[0]) : worlds[0];
            const wp=[originW[12],originW[13],originW[14]];
            for(const mat of model.mats){
              const params=computeMaterialParams(eff, model, mat, controllers);
              const q=queueFor(mat, wp, eye, viewDir);
              calls.push({q, mode:mat.sm.mode, run:()=>drawRealMaterial(eff, model, mat, glModel, worlds, attach, params)});
            }
          } else if(fx.status==='fail'){
            const base=trs(model.mpos, M.euler(model.mrot), model.msca);
            const originW= attach ? M.mul(attach, base) : base;
            const wp=[originW[12],originW[13],originW[14]];
            for(const mat of model.mats){
              const params=computeMaterialParams(eff, model, mat, controllers);
              const q=queueFor(mat, wp, eye, viewDir);
              calls.push({q, mode:mat.sm.mode, run:()=>drawFallbackMaterial(model, mat, attach, params)});
            }
          }
          // 'loading' -> render what's ready; skip this model this frame
        }
      }
      // Lower queue values draw first (Waterfall convention: farther-from-camera /
      // additive-before-alpha-blended). Stable sort keeps same-queue effects in cfg order.
      calls.sort((a,b)=>a.q-b.q);
      for(const c of calls){ applyBlend(c.mode); c.run(); }
      gl.depthMask(true); gl.disable(gl.BLEND);
    }

    // axis-gizmo line VAO
    const axisVao=gl.createVertexArray(); gl.bindVertexArray(axisVao);
    { const b=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,b);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,0, 1,0,0]),gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0); }
    gl.bindVertexArray(null);

    function drawGizmo(cam, attach, size){
      if(dead) return;
      gl.useProgram(lineProg);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.uniformMatrix4fv(luni.uView,false,cam.view);
      gl.uniformMatrix4fv(luni.uProj,false,cam.proj);
      gl.bindVertexArray(axisVao);
      const s=size||1;
      const axes=[
        [M.mul(attach,M.scale(s,s,s)), [1,0.25,0.25]],
        [M.mul(attach,M.mul(M.rotZ(Math.PI/2),M.scale(s,s,s))), [0.3,1,0.3]],
        [M.mul(attach,M.mul(M.rotY(-Math.PI/2),M.scale(s,s,s))), [0.35,0.55,1]],
      ];
      for(const [m,c] of axes){
        gl.uniformMatrix4fv(luni.uModel,false,m);
        gl.uniform3fv(luni.uColor,c);
        gl.drawArrays(gl.LINES,0,2);
      }
      gl.bindVertexArray(null);
    }

    return {gl, drawEffects, drawGizmo, onTexLoaded,
            dispose(){ dead=true; texCache.clear(); fxCache.clear(); }};
  }

  /* ---------------- overlay factory (render inside an external GL scene) ---------------- */
  function createOverlay(gl){
    const octx=createCtx(gl);
    let effects=[], attach=M.ident();
    const offsets={pos:[0,0,0], rot:[0,0,0], sca:[1,1,1]};
    const controllers={throttle:1, atmosphereDepth:0, random:0};
    // THROTTLE STARTUP FIDELITY: the UI slider is the *target* throttle (rawTargets);
    // controllers.throttle is smoothed toward it every frame via ThrottleController's
    // own MoveTowards(responseRateUp/Down) model (Source/Waterfall/EffectControllers/
    // ThrottleController.cs:60-61) so curve-driven ignition flashes (see
    // docs/WaterfallTemplatePatterns.md sec.5) ramp the same way the in-game controller
    // does rather than snapping instantly. Default rates (100/s) match the Waterfall
    // default and are near-instant for a manual slider drag, which is intentional.
    const rawTargets={throttle:1};
    let throttleCur=1, throttleRateUp=100, throttleRateDown=100, lastTime=null;
    // ENGINE EVENT CONTROLLERS: name -> {eventName, eventDuration, curve} (parsed via
    // PlumeRenderer.parseEventControllers from the part's ModuleWaterfallFX node) plus
    // simulated per-name event clocks driven by fireEvent()/scrubEvent() below, since
    // there's no live ModuleEngines to watch EngineIgnited/flameout transitions here.
    let eventDefs={};
    const eventState={};   // name -> {t: seconds since fire, active:bool}
    function attachMat(){
      // TEMPLATE position/rotation/scale and attach are both plain Unity-space now —
      // no per-object handedness conjugation anywhere in this compose chain.
      const u=trs(offsets.pos, M.euler(offsets.rot), offsets.sca);
      return M.mul(attach, u);
    }
    return {
      loadEffects(json){ effects=parseEffectList(json); },
      // MANUAL PREVIEW SNAP: the Throttle slider is a "show me the plume AT this
      // throttle" editor control, not a simulated in-flight spool-up — so unlike
      // Waterfall's live ThrottleController, a manual change here snaps throttleCur
      // to the target immediately instead of MoveTowards-ing toward it at the
      // engine's (often very slow, e.g. F-1 responseRateUp=0.0025 -> ~400s) real
      // response rate. The rate machinery below is left in place (harmlessly inert
      // once synced) in case a future event-timeline animation wants real spool-up.
      setController(n,v){ if(n==='throttle'){ rawTargets.throttle=v; throttleCur=v; } else controllers[n]=v; },
      setControllers(o){
        for(const k in o){ if(k==='throttle'){ rawTargets.throttle=o[k]; throttleCur=o[k]; } else controllers[k]=o[k]; }
      },
      setThrottleResponseRate(up,down){
        throttleRateUp = (up!=null&&isFinite(up)) ? up : 100;
        throttleRateDown = (down!=null&&isFinite(down)) ? down : 100;
      },
      // defs: { name -> {eventName, eventDuration, curve} }, see parseEventControllers().
      setEventControllers(defs){
        eventDefs = defs || {};
        for(const n in eventDefs){ if(!eventState[n]) eventState[n]={t:0, active:false}; }
      },
      // Starts (or restarts) the simulated clock for every event controller whose
      // eventName matches (case-insensitive 'ignition'|'flameout'), mirroring
      // EngineEventController.CheckStateChange()'s state-transition firing.
      fireEvent(eventName){
        const en=(eventName||'').toLowerCase();
        for(const n in eventDefs){ if(eventDefs[n].eventName===en) eventState[n]={t:0, active:true}; }
      },
      // Manual scrub: set seconds-since-event directly, clock stopped (for the UI slider).
      scrubEvent(eventName, t){
        const en=(eventName||'').toLowerCase();
        for(const n in eventDefs){ if(eventDefs[n].eventName===en) eventState[n]={t:Math.max(0,t), active:false}; }
      },
      // Strip the parent chain's scale (rescaleFactor et al.) out of the attach matrix —
      // see M.stripScale's comment for why: Waterfall's own effect-instancing code
      // cancels the parent's lossyScale by default (useRelativeScaling defaults to
      // false), so only TemplateScaleOffset (offsets.sca, applied in attachMat()) should
      // size the effect. Position/rotation are left untouched — the effect still
      // attaches at the rescaleFactor-correct world position.
      setAttach(m){ attach = m ? M.stripScale(m) : M.ident(); },
      setOffsets(o){
        if(o.pos) offsets.pos=o.pos.slice();
        if(o.rot) offsets.rot=o.rot.slice();
        if(o.sca) offsets.sca=o.sca.slice();
      },
      onTexLoaded(f){ octx.onTexLoaded.push(f); },
      debugState(){ return {controllers:{...controllers}, rawTargets:{...rawTargets},
        eventState:JSON.parse(JSON.stringify(eventState)), nEffects:effects.length,
        attachPos: attach.slice(12,15), offsets: JSON.parse(JSON.stringify(offsets))}; },
      draw(cam){
        const dt = lastTime==null ? 0 : Math.max(0, Math.min(0.25, cam.time-lastTime));
        lastTime = cam.time;
        // Throttle: MoveTowards the raw slider target at responseRateUp/Down units/sec
        // (Waterfall's own smoothing model) so curve-driven startup flashes ramp instead
        // of snapping. With default rates (100/s) a 0->1 slider drag settles in ~10ms,
        // i.e. visually instant for manual scrubbing but exercises the real code path.
        const target = rawTargets.throttle!=null ? rawTargets.throttle : 1;
        if(throttleCur!==target){
          const rate = target>throttleCur ? throttleRateUp : throttleRateDown;
          const diff = target-throttleCur;
          throttleCur += Math.sign(diff)*Math.min(Math.abs(diff), rate*dt);
        }
        controllers.throttle = throttleCur;
        // Engine-event controllers: advance each active clock and evaluate its curve in
        // SECONDS-since-fire (not normalized), matching EngineEventController.cs.
        for(const n in eventDefs){
          const def=eventDefs[n], st=eventState[n]||(eventState[n]={t:0,active:false});
          if(st.active){ st.t=Math.min(def.eventDuration, st.t+dt); if(st.t>=def.eventDuration) st.active=false; }
          controllers[n] = def.curve ? evalCurve(def.curve, st.t) : 0;
        }
        controllers.random=0.5+0.5*Math.sin(cam.time*2.3)*Math.cos(cam.time*1.7);
        // The overlay draws straight into the model viewer's own shared, non-float,
        // non-bloomed canvas — there's no HDR framebuffer to blow highlights out into,
        // so we apply the in-shader Reinhard rolloff (see FRAG toneMap()) instead of a
        // hard clip. See createOverlay() note above and the report for why full bloom
        // isn't wired into this shared-canvas path.
        octx.drawEffects(effects, controllers,
          {view:cam.view, proj:cam.proj, eye:cam.eye, time:cam.time, attach:attachMat(), depthTest:true, toneMap:1});
      },
      drawGizmo(cam, size){ octx.drawGizmo(cam, attachMat(), size||0.8); },

      // Hit-test the gizmo's 3 axis handles (drawn at attachMat(), same as drawGizmo)
      // against a mousedown point in NDC space. Returns {axis:'x'|'y'|'z',
      // originWorld:[3], axisDirWorld:[3] (unit)} for the nearest handle within ~12px,
      // else null. Colors/axis mapping matches drawGizmo: R=X(col0), G=Y(col1), B=Z(col2).
      gizmoPickAxis(ndcX, ndcY, view, proj, canvasW, canvasH, size){
        const m = attachMat();
        const origin = [m[12], m[13], m[14]];
        const s = size || 0.8;
        const cols = [[m[0],m[1],m[2]], [m[4],m[5],m[6]], [m[8],m[9],m[10]]];
        const names = ['x','y','z'];
        const o2 = worldToScreenNDC(view, proj, origin);
        if (!o2) return null;
        const ap = ndcToPx([ndcX,ndcY], canvasW, canvasH), a = ndcToPx(o2, canvasW, canvasH);
        let best = null, bestPx = Infinity;
        for (let i=0;i<3;i++){
          const len = Math.hypot(cols[i][0],cols[i][1],cols[i][2]) || 1;
          const nd = [cols[i][0]/len, cols[i][1]/len, cols[i][2]/len];
          const tip = [origin[0]+nd[0]*s, origin[1]+nd[1]*s, origin[2]+nd[2]*s];
          const t2 = worldToScreenNDC(view, proj, tip);
          if (!t2) continue;
          const b = ndcToPx(t2, canvasW, canvasH);
          const d = distPointToSegment2D(ap, a, b);
          if (d < bestPx) { bestPx = d; best = {axis: names[i], originWorld: origin, axisDirWorld: nd}; }
        }
        return (best && bestPx <= 12) ? best : null;
      },

      // Closest-point-on-line parameter: how far along the world axis line
      // (originWorld + t*axisDirWorld) the mouse ray (through `eye`, direction derived
      // from view/proj + ndc) passes nearest to that axis. `view`/`proj`/`eye` are held
      // fixed for the whole drag (camera doesn't move while a gizmo drag is in
      // progress), so callers just re-evaluate this each mousemove with the current
      // ndc. The delta of this t between drag-start and now is the WORLD-space
      // distance moved along the axis.
      gizmoAxisParam(axisDirWorld, originWorld, view, proj, eye, ndcX, ndcY){
        const right=[view[0],view[4],view[8]], up=[view[1],view[5],view[9]], negFwd=[view[2],view[6],view[10]];
        const fy = proj[5], aspect = fy / proj[0];
        const vx = ndcX*aspect/fy, vy = ndcY/fy, vz = -1;
        const rd = [vx*right[0]+vy*up[0]+vz*negFwd[0], vx*right[1]+vy*up[1]+vz*negFwd[1], vx*right[2]+vy*up[2]+vz*negFwd[2]];
        const rl = Math.hypot(rd[0],rd[1],rd[2]) || 1;
        const d2 = [rd[0]/rl, rd[1]/rl, rd[2]/rl];
        const d1 = axisDirWorld;
        const r = [originWorld[0]-eye[0], originWorld[1]-eye[1], originWorld[2]-eye[2]];
        const b = dot3(d1,d2), c = dot3(d1,r), f = dot3(d2,r);
        const denom = 1 - b*b;
        if (Math.abs(denom) < 1e-6) return 0;   // axis nearly parallel to view ray — degenerate, hold still
        return (b*f - c) / denom;
      },

      // World-space delta vector -> the TEMPLATE position's local (attach-frame) delta.
      // `attach` (post-stripScale, see setAttach) is a pure rotation+translation, so its
      // inverse rotation is just the transpose: local = dot(column_i, worldDelta).
      gizmoWorldToLocalDelta(worldDelta){
        const cx=[attach[0],attach[1],attach[2]], cy=[attach[4],attach[5],attach[6]], cz=[attach[8],attach[9],attach[10]];
        return [dot3(cx,worldDelta), dot3(cy,worldDelta), dot3(cz,worldDelta)];
      },

      dispose(){ octx.dispose(); },
    };
  }

  /* ---------------- HDR + bloom pipeline (standalone Plume Library view only) ----------------
   * Waterfall's own plumes are drawn with unclamped additive Emission (see Additive.shader
   * above: o.Emission = saturate(...) is clamped per-material to _ClipBrightness, which
   * WaterfallEffect.SetHDR() sets to 50 under an HDR camera vs 1 otherwise — i.e. the game
   * intentionally lets plume cores blow way past 1.0 and relies on the HDR camera + KSP/TUFX
   * bloom + tonemapper (see wiki/Concepts.md "HDR" notes) to spread that into the soft,
   * long, glowing tails seen in-game — a plain LDR canvas hard-clips at 1.0 and looks like a
   * flat cutout instead. We reproduce that here for the standalone Plume Library canvas with a
   * real float framebuffer + a small bloom chain; createOverlay() (shared model-viewer canvas)
   * intentionally stays cheap and does NOT get this treatment (see its comment above).
   */
  function createBloomPipeline(gl){
    const hasFloat = !!gl.getExtension('EXT_color_buffer_float');
    if(!hasFloat) return null;
    gl.getExtension('OES_texture_float_linear');

    function compile(type,src){ const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error('bloom shader: '+gl.getShaderInfoLog(s));
      return s; }
    function link(vs,fs){ const p=gl.createProgram(); gl.attachShader(p,compile(gl.VERTEX_SHADER,vs));
      gl.attachShader(p,compile(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(p);
      if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error('bloom link: '+gl.getProgramInfoLog(p));
      return p; }

    const FSQ_VERT = `#version 300 es
      out vec2 vUV;
      void main(){
        vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2);
        vUV = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
      }`;
    const DOWNSAMPLE_FRAG = `#version 300 es
      precision highp float; in vec2 vUV; out vec4 frag; uniform sampler2D uTex; uniform vec2 uTexel;
      void main(){
        // 4-tap box filter, offset by half a source texel (standard downsample box)
        vec3 c = texture(uTex, vUV + uTexel*vec2(-0.5,-0.5)).rgb
               + texture(uTex, vUV + uTexel*vec2( 0.5,-0.5)).rgb
               + texture(uTex, vUV + uTexel*vec2(-0.5, 0.5)).rgb
               + texture(uTex, vUV + uTexel*vec2( 0.5, 0.5)).rgb;
        frag = vec4(c*0.25, 1.0);
      }`;
    const BLUR_FRAG = `#version 300 es
      precision highp float; in vec2 vUV; out vec4 frag; uniform sampler2D uTex;
      uniform vec2 uDir; // texel-space step * direction
      void main(){
        // 9-tap separable gaussian (sigma ~3)
        const float w0=0.227027, w1=0.1945946, w2=0.1216216, w3=0.054054, w4=0.016216;
        vec3 c = texture(uTex, vUV).rgb * w0;
        c += texture(uTex, vUV + uDir*1.0).rgb * w1; c += texture(uTex, vUV - uDir*1.0).rgb * w1;
        c += texture(uTex, vUV + uDir*2.0).rgb * w2; c += texture(uTex, vUV - uDir*2.0).rgb * w2;
        c += texture(uTex, vUV + uDir*3.0).rgb * w3; c += texture(uTex, vUV - uDir*3.0).rgb * w3;
        c += texture(uTex, vUV + uDir*4.0).rgb * w4; c += texture(uTex, vUV - uDir*4.0).rgb * w4;
        frag = vec4(c, 1.0);
      }`;
    const COMPOSITE_FRAG = `#version 300 es
      precision highp float; in vec2 vUV; out vec4 frag;
      uniform sampler2D uScene, uBloom1, uBloom2;
      uniform float uStrength, uExposure;
      void main(){
        vec3 scene = texture(uScene, vUV).rgb;
        vec3 bloom = texture(uBloom1, vUV).rgb * 0.65 + texture(uBloom2, vUV).rgb * 0.35;
        vec3 hdr = scene + bloom * uStrength;
        // Tonemapping 1-exp(-hdr*exposure) PER CHANNEL saturates hue away: once R, G
        // and B are each individually large, exp(-x) -> 0 for all three regardless of
        // their ratio, so distinct-but-bright colors all converge on white. That's
        // exactly what happens at a template's innermost core, where several thin
        // near-axis additive cones overlap on the same pixels and sum to a large HDR
        // value in every channel even though the color is still strongly tinted (e.g.
        // BDB_F1's core stack sums to roughly RGB (8.1, 4.7, 3.1) — clearly orange —
        // but per-channel exp maps that to (0.9999, 0.9986, 0.9868), i.e. white).
        // Tonemap the scalar luminance instead and rescale hdr by the luminance
        // ratio, so brightness compresses but hue/saturation survive, matching how
        // KSP/TUFX bloom reads as colored even where the core itself is overexposed.
        float luma = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
        vec3 mapped = luma <= 1e-5 ? hdr : hdr * ((1.0 - exp(-luma * uExposure)) / luma);
        frag = vec4(mapped, 1.0);
      }`;

    const progDown = link(FSQ_VERT, DOWNSAMPLE_FRAG);
    const progBlur = link(FSQ_VERT, BLUR_FRAG);
    const progComp = link(FSQ_VERT, COMPOSITE_FRAG);
    const uDown = {uTex:gl.getUniformLocation(progDown,'uTex'), uTexel:gl.getUniformLocation(progDown,'uTexel')};
    const uBlur = {uTex:gl.getUniformLocation(progBlur,'uTex'), uDir:gl.getUniformLocation(progBlur,'uDir')};
    const uComp = {uScene:gl.getUniformLocation(progComp,'uScene'), uBloom1:gl.getUniformLocation(progComp,'uBloom1'),
                   uBloom2:gl.getUniformLocation(progComp,'uBloom2'), uStrength:gl.getUniformLocation(progComp,'uStrength'),
                   uExposure:gl.getUniformLocation(progComp,'uExposure')};
    const emptyVao = gl.createVertexArray();

    function makeTarget(w,h){
      const tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,tex);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,w,h,0,gl.RGBA,gl.HALF_FLOAT,null);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      const fbo=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      return {tex,fbo,w,h};
    }
    function freeTarget(t){ if(!t) return; gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }

    let W=0,H=0, scene=null, mip1a=null,mip1b=null, mip2a=null,mip2b=null;
    let strength=0.6, exposure=1.4;

    function resize(w,h){
      w=Math.max(2,w|0); h=Math.max(2,h|0);
      if(w===W && h===H) return;
      W=w; H=h;
      freeTarget(scene); freeTarget(mip1a); freeTarget(mip1b); freeTarget(mip2a); freeTarget(mip2b);
      scene=makeTarget(W,H);
      mip1a=makeTarget(Math.max(2,W>>1),Math.max(2,H>>1));
      mip1b=makeTarget(Math.max(2,W>>1),Math.max(2,H>>1));
      mip2a=makeTarget(Math.max(2,W>>2),Math.max(2,H>>2));
      mip2b=makeTarget(Math.max(2,W>>2),Math.max(2,H>>2));
    }

    function blitPass(prog, uniforms, srcTex, dstFbo, dstW, dstH, setUni){
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
      gl.viewport(0,0,dstW,dstH);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
      setUni();
      gl.bindVertexArray(emptyVao);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.bindVertexArray(null);
    }

    return {
      get ready(){ return true; },
      resize,
      beginScene(){ gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo); gl.viewport(0,0,W,H);
        gl.clearColor(0.04,0.05,0.07,1); gl.clear(gl.COLOR_BUFFER_BIT); },
      setParams(s,e){ strength=s; exposure=e; },
      resolve(){
        // downsample scene -> mip1, blur mip1 (a<->b)
        blitPass(progDown,uDown, scene.tex, mip1a.fbo, mip1a.w, mip1a.h,
          ()=>{ gl.uniform1i(uDown.uTex,0); gl.uniform2f(uDown.uTexel, 1/W, 1/H); });
        blitPass(progBlur,uBlur, mip1a.tex, mip1b.fbo, mip1b.w, mip1b.h,
          ()=>{ gl.uniform1i(uBlur.uTex,0); gl.uniform2f(uBlur.uDir, 1/mip1a.w, 0); });
        blitPass(progBlur,uBlur, mip1b.tex, mip1a.fbo, mip1a.w, mip1a.h,
          ()=>{ gl.uniform1i(uBlur.uTex,0); gl.uniform2f(uBlur.uDir, 0, 1/mip1b.h); });
        // downsample mip1 -> mip2, blur mip2 (a<->b), wider radius = bigger bloom skirt
        blitPass(progDown,uDown, mip1a.tex, mip2a.fbo, mip2a.w, mip2a.h,
          ()=>{ gl.uniform1i(uDown.uTex,0); gl.uniform2f(uDown.uTexel, 1/mip1a.w, 1/mip1a.h); });
        blitPass(progBlur,uBlur, mip2a.tex, mip2b.fbo, mip2b.w, mip2b.h,
          ()=>{ gl.uniform1i(uBlur.uTex,0); gl.uniform2f(uBlur.uDir, 1.5/mip2a.w, 0); });
        blitPass(progBlur,uBlur, mip2b.tex, mip2a.fbo, mip2a.w, mip2a.h,
          ()=>{ gl.uniform1i(uBlur.uTex,0); gl.uniform2f(uBlur.uDir, 0, 1.5/mip2b.h); });
        // composite scene + both bloom mips -> default framebuffer (screen), tonemapped
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0,0,W,H);
        gl.useProgram(progComp);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.tex);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mip1a.tex);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, mip2a.tex);
        gl.uniform1i(uComp.uScene,0); gl.uniform1i(uComp.uBloom1,1); gl.uniform1i(uComp.uBloom2,2);
        gl.uniform1f(uComp.uStrength, strength); gl.uniform1f(uComp.uExposure, exposure);
        gl.bindVertexArray(emptyVao);
        gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
        gl.drawArrays(gl.TRIANGLES,0,3);
        gl.bindVertexArray(null);
      },
      dispose(){
        freeTarget(scene); freeTarget(mip1a); freeTarget(mip1b); freeTarget(mip2a); freeTarget(mip2b);
        gl.deleteProgram(progDown); gl.deleteProgram(progBlur); gl.deleteProgram(progComp);
        gl.deleteVertexArray(emptyVao);
      }
    };
  }

  /* ---------------- standalone viewer (Plume Library) ---------------- */
  let ctx=null, canvas=null, container=null, effects=[],
      controllers={throttle:0.85, atmosphereDepth:1, random:0},
      raf=0, startT=0, disposed=false, bloom=null, bloomParams={strength:0.6, exposure:1.4},
      orbit={az:0.6, el:0.15, dist:6, tgt:[0,0,-2]}, drag=null;

  function loadEffects(effectsJson, controllerValues){
    if(controllerValues) Object.assign(controllers, controllerValues);
    effects=parseEffectList(effectsJson);
    orbit.dist=6; orbit.tgt=[0,0,-2];
    if(ctx) renderFrame();
  }
  function setController(name, value){ controllers[name]=value; }

  function mount(cont){
    container=cont; disposed=false;
    canvas=document.createElement('canvas');
    canvas.style.width='100%'; canvas.style.height='100%'; canvas.style.display='block';
    container.appendChild(canvas);
    const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:false,antialias:true,preserveDrawingBuffer:true});
    if(!gl) throw new Error('WebGL2 unavailable');
    ctx=createCtx(gl);
    ctx.onTexLoaded.push(()=>renderFrame());
    try { bloom=createBloomPipeline(gl); }
    catch(e){ console.warn('[plume] HDR/bloom pipeline unavailable, falling back to in-shader tonemap only:', e); bloom=null; }
    if(!bloom) console.warn('[plume] EXT_color_buffer_float not supported; Plume Library will use the cheap in-shader tonemap (no bloom).');
    setupOrbit();
    startT=performance.now();
    loop();
  }
  function setBloomStrength(v){ bloomParams.strength=v; if(bloom) bloom.setParams(bloomParams.strength, bloomParams.exposure); }
  function setExposure(v){ bloomParams.exposure=v; if(bloom) bloom.setParams(bloomParams.strength, bloomParams.exposure); }

  function setupOrbit(){
    canvas.addEventListener('mousedown',e=>{drag={x:e.clientX,y:e.clientY};});
    window.addEventListener('mouseup',()=>{drag=null;});
    window.addEventListener('mousemove',e=>{
      if(!drag) return;
      orbit.az-=(e.clientX-drag.x)*0.01; orbit.el+=(e.clientY-drag.y)*0.01;
      orbit.el=Math.max(-1.4,Math.min(1.4,orbit.el)); drag={x:e.clientX,y:e.clientY};
    });
    canvas.addEventListener('wheel',e=>{orbit.dist*=(1+Math.sign(e.deltaY)*0.1);
      orbit.dist=Math.max(1,Math.min(40,orbit.dist)); e.preventDefault();},{passive:false});
  }

  function resize(){
    const gl=ctx.gl;
    const w=container.clientWidth||600, h=container.clientHeight||400;
    const dpr=Math.min(2,window.devicePixelRatio||1);
    if(canvas.width!==w*dpr||canvas.height!==h*dpr){
      canvas.width=w*dpr; canvas.height=h*dpr;
    }
    gl.viewport(0,0,canvas.width,canvas.height);
    if(bloom) bloom.resize(canvas.width, canvas.height);
    return w/h;
  }

  function loop(){
    if(disposed) return;
    raf=requestAnimationFrame(loop);
    renderFrame();
  }

  function renderFrame(){
    if(disposed||!ctx) return;
    const gl=ctx.gl;
    const asp=resize();
    const t=(performance.now()-startT)/1000;
    controllers.random=0.5+0.5*Math.sin(t*2.3)*Math.cos(t*1.7);
    const eye=[orbit.tgt[0]+orbit.dist*Math.cos(orbit.el)*Math.sin(orbit.az),
               orbit.tgt[1]+orbit.dist*Math.sin(orbit.el),
               orbit.tgt[2]+orbit.dist*Math.cos(orbit.el)*Math.cos(orbit.az)];
    const view=mirrorZ(lookAtUnity(eye,orbit.tgt,[0,1,0]));
    const proj=M.perspective(0.9,asp,0.05,200);
    if(bloom){
      // Render additive plume emission unclamped into an RGBA16F scene target (toneMap:0
      // — see FRAG toneMap() / SUBTASK 2 note above), then downsample+blur+composite with
      // exposure into the visible LDR canvas. This is the "long, soft, billowy" look:
      // without it the >1 emissive core hard-clips to a flat white cutout at the canvas's
      // native 8-bit range instead of blooming outward like it does in-game.
      bloom.beginScene();
      ctx.drawEffects(effects, controllers, {view, proj, eye, time:t, attach:null, depthTest:false, toneMap:0});
      bloom.resolve();
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.clearColor(0.04,0.05,0.07,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      ctx.drawEffects(effects, controllers, {view, proj, eye, time:t, attach:null, depthTest:false, toneMap:1});
    }
  }

  function dispose(){
    disposed=true; if(raf) cancelAnimationFrame(raf); raf=0;
    if(bloom){ bloom.dispose(); bloom=null; }
    if(ctx){ const ext=ctx.gl.getExtension('WEBGL_lose_context'); if(ext) ext.loseContext(); ctx.dispose(); }
    if(canvas&&canvas.parentNode) canvas.parentNode.removeChild(canvas);
    effects=[]; ctx=null;
  }

  // Unity-space world matrix (with FULL scale baked in, including MODEL{} scale *
  // rescaleFactor — see model3d.js buildScene's identical root-construction comment)
  // of EVERY node in the /api/model?part=X tree, keyed by lowercased transform name
  // to a list of matrices (one per occurrence). Mirrors model3d.js's buildScene()
  // walk exactly, except it keeps ALL matches instead of only the first — Waterfall
  // (WaterfallEffect.cs) instantiates once per matching transform, so multi-nozzle
  // parts (and paired ullage/separation motors etc.) need every occurrence, not just
  // ModelViewer.getTransformMatrix()'s single first-match lookup.
  // Each match is {m: worldMatrix, path: [lowercased ancestor names incl. self]} —
  // the path lets callers drop matches that fall under a B9PartSwitch-hidden subtree
  // (transforms sharing a leaf name, like the three RL10 variants' thrustTransform,
  // are only distinguishable by ancestor hierarchy; see app.js updatePlumes).
  function computeAllTransforms(data) {
    const map = new Map();
    const models = (data && data.models || []).filter(m => m.tree);
    function walk(obj, parentMat, nameStack, isRoot) {
      let world;
      if (isRoot) {
        world = parentMat;
      } else {
        const T = M.translate(obj.pos[0], obj.pos[1], obj.pos[2]);
        const R = M.fromQuat(obj.rotQuat[0], obj.rotQuat[1], obj.rotQuat[2], obj.rotQuat[3]);
        const S = M.scale(obj.scale[0], obj.scale[1], obj.scale[2]);
        world = M.mul(parentMat, M.mul(M.mul(T, R), S));
      }
      const stack = nameStack.concat([(obj.name || '').toLowerCase()]);
      const key = (obj.name || '').toLowerCase();
      if (key) { if (!map.has(key)) map.set(key, []); map.get(key).push({ m: world.slice(), path: stack }); }
      for (const c of (obj.children || [])) walk(c, world, stack, false);
    }
    for (const model of models) {
      const cfg = model.cfg || {};
      const p = vec(cfg.position, [0, 0, 0]), r = vec(cfg.rotation, [0, 0, 0]), sc = vec(cfg.scale, [1, 1, 1]);
      const rf = (model.rescaleFactor != null && isFinite(+model.rescaleFactor)) ? +model.rescaleFactor : 1.25;
      const root = M.mul(M.mul(M.translate(p[0], p[1], p[2]), M.euler(r)),
                          M.scale(sc[0] * rf, sc[1] * rf, sc[2] * rf));
      walk(model.tree, root, [], true);
    }
    return map;
  }

  const api = {mount, loadEffects, setController, dispose,
          setBloomStrength, setExposure,
          renderOnce:()=>{ if(ctx) renderFrame(); },
          createOverlay, computeAllTransforms, parseEventControllers};
  api._test = { M, lookAtUnity, mirrorZ, trs };   // exposed for numeric regression tests only
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
