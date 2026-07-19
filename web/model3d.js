'use strict';
/* KSP Engine Editor — self-contained WebGL2 model viewer (no external libs).
 *
 * window.ModelViewer = { mount(container, partName), listTransforms(), highlight(name) }
 *
 * Loads /api/model?part=X (parsed .mu tree from muparse.py), builds GL buffers for the
 * whole hierarchical object tree, loads mainTex textures via /api/texture (DDS decoded
 * client-side — compressed upload when WEBGL_compressed_texture_s3tc is present, else a
 * pure-JS BC1/BC3 decoder), and renders with orbit controls + simple N.L lighting.
 *
 * KSP models are Unity space: Y-up, left-handed. Per docs/RenderingGroundTruth.md
 * (option b), we do NOT convert any per-object data — node worlds, quaternions,
 * Euler composition, bind poses all stay byte-for-byte Unity-space. The single LH->RH
 * handedness flip is folded once into the view matrix (mirrorZ) plus a single global
 * gl.frontFace(gl.CCW) (GL's default — see the T2 note at the frontFace() call site
 * for why this, not literal gl.CW, is what the doc's own numeric test vector requires);
 * no per-mesh winding flip or per-matrix conjugation exists.                          */
(function () {

/* ------------------------- tiny mat4 / vec math ------------------------- */
const M4 = {
  ident() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; },
  mul(a, b) {
    const o = new Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k*4+r] * b[c*4+k];
      o[c*4+r] = s;
    }
    return o;
  },
  translate(x, y, z) { const m = M4.ident(); m[12]=x; m[13]=y; m[14]=z; return m; },
  scale(x, y, z) { const m = M4.ident(); m[0]=x; m[5]=y; m[10]=z; return m; },
  fromQuat(x, y, z, w) {
    const n = Math.hypot(x, y, z, w) || 1; x/=n; y/=n; z/=n; w/=n;
    const xx=x*x, yy=y*y, zz=z*z, xy=x*y, xz=x*z, yz=y*z, wx=w*x, wy=w*y, wz=w*z;
    return [
      1-2*(yy+zz), 2*(xy+wz),   2*(xz-wy),   0,
      2*(xy-wz),   1-2*(xx+zz), 2*(yz+wx),   0,
      2*(xz+wy),   2*(yz-wx),   1-2*(xx+yy), 0,
      0,0,0,1];
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy/2), nf = 1/(near-far);
    return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];
  },
  // Unity-space (left-handed) look-at: right = up x fwd (Unity's own convention, NOT
  // GL's cross(fwd,up)). See docs/RenderingGroundTruth.md Q2.
  lookAtUnity(eye, ctr, up) {
    const fwd = norm3(sub3(ctr, eye));
    const right = norm3(cross3(up, fwd));
    const y = cross3(fwd, right);
    return [ right[0],y[0],fwd[0],0, right[1],y[1],fwd[1],0, right[2],y[2],fwd[2],0,
      -dot3(right,eye), -dot3(y,eye), -dot3(fwd,eye), 1 ];
  },
  // Negate the Z OUTPUT row (row index 2: elements 2,6,10,14) of an assembled
  // view matrix once. This is the entire LH(Unity)->RH(GL) handedness conversion —
  // folded into the view matrix instead of conjugating every object matrix
  // (docs/RenderingGroundTruth.md option (b)).
  mirrorZ(m) {
    const o = m.slice();
    o[2] = -o[2]; o[6] = -o[6]; o[10] = -o[10]; o[14] = -o[14];
    return o;
  },
  // upper-left 3x3 inverse-transpose for normals (assumes no shear for our TRS uniform-ish scales)
  normalMat(m) {
    // invert 3x3
    const a=m[0],b=m[1],c=m[2], d=m[4],e=m[5],f=m[6], g=m[8],h=m[9],i=m[10];
    const A=e*i-f*h, B=f*g-d*i, C=d*h-e*g;
    let det = a*A + b*B + c*C; if (Math.abs(det) < 1e-12) det = 1; const id = 1/det;
    // inverse-transpose
    return [
      A*id, B*id, C*id,
      (c*h-b*i)*id, (a*i-c*g)*id, (b*g-a*h)*id,
      (b*f-c*e)*id, (c*d-a*f)*id, (a*e-b*d)*id ];
  },
};
const sub3=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross3=(a,b)=>[a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm3=a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return [a[0]/l,a[1]/l,a[2]/l];};

/* ------------------------- DDS / BC decoding ------------------------- */
// DXGI_FORMAT (DX10 extended header) -> our internal format tag + block size.
// Covers the BC1/3/4/5/7 variants actually seen in installed GameData (TU/TURD
// recolor skins, cloud/normal packs); TYPELESS and *_SRGB numeric ids all map to
// the same block layout as their UNORM counterpart for our purposes.
const DXGI_BC_MAP = {
  70:'BC1',71:'BC1',72:'BC1', 73:'BC3',74:'BC3',75:'BC3', 76:'BC3',77:'BC3',78:'BC3',
  79:'BC4',80:'BC4',81:'BC4', 82:'BC5',83:'BC5',84:'BC5', 97:'BC7',98:'BC7',99:'BC7',
};
function parseDDS(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x20534444) return null;         // 'DDS '
  const height = dv.getUint32(12, true), width = dv.getUint32(16, true);
  const fourCC = dv.getUint32(84, true);
  const DXT1 = 0x31545844, DXT3 = 0x33545844, DXT5 = 0x35545844, DX10 = 0x30315844;
  let format, dataOffset = 128;
  if (fourCC === DXT1) format = 'DXT1';
  else if (fourCC === DXT3) format = 'DXT3';
  else if (fourCC === DXT5) format = 'DXT5';
  else if (fourCC === DX10) {
    const dxgi = dv.getUint32(128, true);                        // DDS_HEADER_DXT10.dxgiFormat
    const bc = DXGI_BC_MAP[dxgi];
    // BC1/3 under a DX10 header decode exactly like classic DXT1/DXT5 (BC2~=DXT3
    // folded into BC3 bucket above since we have no separate 4-bit-alpha decoder
    // and BC2 is vanishingly rare in this GameData).
    if (bc === 'BC1') format = 'DXT1';
    else if (bc === 'BC3') format = 'DXT5';
    else if (bc === 'BC4' || bc === 'BC5') format = bc;
    // BC7 (dxgi 97-99) has no block decoder here (genuinely complex, not a "simple"
    // format) — fall through to the neutral-gray UNSUPPORTED path deliberately.
    else return { width, height, format: 'UNSUPPORTED', unsupportedTag: 'DX10:dxgi=' + dxgi };
    dataOffset = 148;                                             // 128 header + 20-byte DXT10 ext
  } else {
    return { width, height, format: 'UNSUPPORTED', unsupportedTag: 'fourCC=' + fourCC.toString(16) };
  }
  const blockBytes = (format === 'DXT1' || format === 'BC4') ? 8 : 16;
  const w4 = Math.max(1, (width + 3) >> 2), h4 = Math.max(1, (height + 3) >> 2);
  const size = w4 * h4 * blockBytes;
  if (dataOffset + size > buf.byteLength) return { width, height, format: 'UNSUPPORTED', unsupportedTag: 'truncated' };
  const data = new Uint8Array(buf, dataOffset, size);
  return { width, height, format, data, blockBytes };
}

// Decode one 8-byte BC4 (ATI1/RGTC1) single-channel block into 16 interpolated values.
function decodeBC4Channel(data, o) {
  const a0 = data[o], a1 = data[o+1];
  const ac = [a0, a1];
  if (a0 > a1) for (let i=2;i<8;i++) ac.push(((8-i)*a0 + (i-1)*a1)/7|0);
  else { for (let i=2;i<6;i++) ac.push(((6-i)*a0 + (i-1)*a1)/5|0); ac.push(0); ac.push(255); }
  const out = new Uint8Array(16);
  let acc = 0, accn = 0, ptr = o+2, idx = 0;
  for (let i=0;i<16;i++){ while(accn<3){ acc |= data[ptr++]<<accn; accn+=8;} out[idx++]=ac[acc&7]; acc>>=3; accn-=3; }
  return out;
}

// BC4 (ATI1/RGTC1): single-channel (R), used here as grayscale RGB.
function decodeBC4(width, height, data) {
  const out = new Uint8Array(width * height * 4);
  const bw = Math.max(1, (width+3)>>2), bh = Math.max(1, (height+3)>>2);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const ch = decodeBC4Channel(data, (by*bw+bx)*8);
    for (let py=0; py<4; py++) for (let px=0; px<4; px++) {
      const x = bx*4+px, y = by*4+py; if (x>=width || y>=height) continue;
      const v = ch[py*4+px], p = (y*width+x)*4;
      out[p]=v; out[p+1]=v; out[p+2]=v; out[p+3]=255;
    }
  }
  return out;
}

// BC5 (ATI2/RGTC2): two independent BC4 channels (R, G) — typically a tangent-space
// normal map's XY. Reconstruct Z so it renders as a plausible normal-ish RGB rather
// than a flat red/green tint.
function decodeBC5(width, height, data) {
  const out = new Uint8Array(width * height * 4);
  const bw = Math.max(1, (width+3)>>2), bh = Math.max(1, (height+3)>>2);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = (by*bw+bx)*16;
    const rCh = decodeBC4Channel(data, o), gCh = decodeBC4Channel(data, o+8);
    for (let py=0; py<4; py++) for (let px=0; px<4; px++) {
      const x = bx*4+px, y = by*4+py; if (x>=width || y>=height) continue;
      const i = py*4+px, p = (y*width+x)*4;
      out[p]=rCh[i]; out[p+1]=gCh[i]; out[p+2]=255; out[p+3]=255;
    }
  }
  return out;
}

function rgb565(c) { return [ ((c>>11)&31)*255/31|0, ((c>>5)&63)*255/63|0, (c&31)*255/31|0 ]; }

// Decode BC1(DXT1)/BC3(DXT5) to RGBA Uint8Array (fallback when s3tc unavailable).
function decodeDXT(width, height, data, format) {
  const out = new Uint8Array(width * height * 4);
  const bw = Math.max(1, (width+3)>>2), bh = Math.max(1, (height+3)>>2);
  const alphaBlock = format !== 'DXT1';
  const blockBytes = alphaBlock ? 16 : 8;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let o = (by*bw + bx) * blockBytes;
    const alpha = new Uint8Array(16);
    if (format === 'DXT5') {
      const a0 = data[o], a1 = data[o+1];
      const ac = [a0, a1];
      if (a0 > a1) for (let i=2;i<8;i++) ac.push(((8-i)*a0 + (i-1)*a1)/7|0);
      else { for (let i=2;i<6;i++) ac.push(((6-i)*a0 + (i-1)*a1)/5|0); ac.push(0); ac.push(255); }
      // 16 alpha indices, 3 bits each, little-endian bit stream over 6 bytes
      let acc = 0, accn = 0, ptr = o+2, idx = 0;
      for (let i=0;i<16;i++){ while(accn<3){ acc |= data[ptr++]<<accn; accn+=8;} alpha[idx++]=ac[acc&7]; acc>>=3; accn-=3; }
      o += 8;
    } else if (format === 'DXT3') {
      for (let i=0;i<8;i++){ const b=data[o+i]; alpha[i*2]=(b&0x0f)*17; alpha[i*2+1]=((b>>4)&0x0f)*17; }
      o += 8;
    } else { for (let i=0;i<16;i++) alpha[i]=255; }
    const c0 = data[o] | (data[o+1]<<8), c1 = data[o+2] | (data[o+3]<<8);
    const col0 = rgb565(c0), col1 = rgb565(c1), pal = [col0, col1, [0,0,0], [0,0,0]];
    if (format === 'DXT1' && c0 <= c1) {
      pal[2] = [ (col0[0]+col1[0])>>1, (col0[1]+col1[1])>>1, (col0[2]+col1[2])>>1 ];
      pal[3] = [0,0,0]; // index 3 => transparent black in DXT1 1-bit alpha
    } else {
      pal[2] = [ (2*col0[0]+col1[0])/3|0, (2*col0[1]+col1[1])/3|0, (2*col0[2]+col1[2])/3|0 ];
      pal[3] = [ (col0[0]+2*col1[0])/3|0, (col0[1]+2*col1[1])/3|0, (col0[2]+2*col1[2])/3|0 ];
    }
    const lut = data[o+4] | (data[o+5]<<8) | (data[o+6]<<16) | (data[o+7]*0x1000000);
    for (let py=0; py<4; py++) for (let px=0; px<4; px++) {
      const x = bx*4+px, y = by*4+py; if (x>=width || y>=height) continue;
      const ci = (lut >>> (2*(py*4+px))) & 3;
      const p = (y*width + x)*4, col = pal[ci];
      out[p]=col[0]; out[p+1]=col[1]; out[p+2]=col[2];
      out[p+3] = (format==='DXT1' && c0<=c1 && ci===3) ? 0 : alpha[py*4+px];
    }
  }
  return out;
}

/* ------------------------- viewer implementation ------------------------- */
let STATE = null;   // active viewer instance

// Persisted across mount() calls (module-level, survives part switches) so the
// "Lock zoom across parts" toggle can show true relative part scale: the first
// part viewed after enabling the lock seeds this distance, and every later part
// (and further wheel-zooming) reuses/updates the SAME distance instead of each
// part getting its own auto-fit radius.
let LOCK_ZOOM = false;
let LOCKED_RADIUS = null;

// Live-edit override for the currently-selected part's root rescaleFactor (see
// ModelViewer.setRescaleOverride / mount()'s use of it below). null = use whatever
// /api/model reports (the on-disk cfg value). Reset per-part by app.js so switching
// parts doesn't leak one part's override onto the next.
let RESCALE_OVERRIDE = null;

// Single registered pick handler (see ModelViewer.setPickHandler) — called on every
// canvas LMB mousedown BEFORE the camera starts its own orbit drag. If it returns
// truthy (a gizmo drag began), the camera skips orbiting for this pointer sequence;
// the caller is then responsible for its own mousemove/mouseup handling (typically
// via its own window listeners), since with orbiting=false the camera's mousemove
// handler is a no-op anyway.
let PICK_HANDLER = null;

const LINE_VERT_SRC = `#version 300 es
in vec3 aPos; in vec3 aColor;
uniform mat4 uProj, uView;
out vec3 vColor;
void main(){ vColor = aColor; gl_Position = uProj * uView * vec4(aPos, 1.0); }`;
const LINE_FRAG_SRC = `#version 300 es
precision highp float;
in vec3 vColor; out vec4 frag;
void main(){ frag = vec4(vColor, 1.0); }`;

function makeLineProgram(gl) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, LINE_VERT_SRC));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, LINE_FRAG_SRC));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

// Build a 1m-spacing ground grid at the scene's lowest Y, centered under the model
// footprint, extent ~2x the model's largest XZ dimension (min 2m total extent).
// Every 5th line (by integer world coordinate) is drawn brighter. Unity-space
// positions, same convention as mesh vertices — no coordinate conversion needed.
function buildGrid(gl, scene) {
  const dx = scene.bmax[0]-scene.bmin[0], dz = scene.bmax[2]-scene.bmin[2];
  const modelSize = Math.max(dx, dz, 0);
  const half = Math.max(modelSize, 1);         // total extent = 2*half, min 2m
  const cx = (scene.bmin[0]+scene.bmax[0])/2, cz = (scene.bmin[2]+scene.bmax[2])/2;
  const y = scene.bmin[1];
  const n = Math.ceil(half);
  const xLo = Math.floor(cx-n), xHi = Math.ceil(cx+n);
  const zLo = Math.floor(cz-n), zHi = Math.ceil(cz+n);
  const minorC = [0.22, 0.23, 0.26], majorC = [0.40, 0.42, 0.48];
  const verts = [];
  const pushLine = (x0,z0,x1,z1,c) => { verts.push(x0,y,z0, c[0],c[1],c[2], x1,y,z1, c[0],c[1],c[2]); };
  for (let ix = xLo; ix <= xHi; ix++) pushLine(ix, zLo, ix, zHi, (ix % 5 === 0) ? majorC : minorC);
  for (let iz = zLo; iz <= zHi; iz++) pushLine(xLo, iz, xHi, iz, (iz % 5 === 0) ? majorC : minorC);
  const prog = makeLineProgram(gl);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  return {
    prog, buf, count: verts.length / 6,
    loc: {
      aPos: gl.getAttribLocation(prog, 'aPos'), aColor: gl.getAttribLocation(prog, 'aColor'),
      uProj: gl.getUniformLocation(prog, 'uProj'), uView: gl.getUniformLocation(prog, 'uView'),
    },
  };
}

function drawGrid(gl, st, view, proj) {
  const g = st.grid;
  if (!g || !st.gridOn) return;
  gl.useProgram(g.prog);
  gl.uniformMatrix4fv(g.loc.uProj, false, proj);
  gl.uniformMatrix4fv(g.loc.uView, false, view);
  gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
  const stride = 6*4;
  gl.enableVertexAttribArray(g.loc.aPos); gl.vertexAttribPointer(g.loc.aPos, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(g.loc.aColor); gl.vertexAttribPointer(g.loc.aColor, 3, gl.FLOAT, false, stride, 12);
  gl.drawArrays(gl.LINES, 0, g.count);
}

// Aggregate world-space bbox over currently-visible items only (same hidden-subtree
// filter render() uses), from the per-item bboxes computed once in buildScene().
function computeVisibleBBox(st) {
  const hidden = st.hidden;
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const it of st.scene.items) {
    if (hidden && it.path && it.path.some(n => hidden.has(n))) continue;
    if (!it.bmin) continue;
    any = true;
    for (let k=0;k<3;k++) { if (it.bmin[k]<bmin[k]) bmin[k]=it.bmin[k]; if (it.bmax[k]>bmax[k]) bmax[k]=it.bmax[k]; }
  }
  return any ? { bmin, bmax } : null;
}

const VERT_SRC = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec2 aUV;
uniform mat4 uProj, uView, uModel; uniform mat3 uNormal;
out vec3 vN; out vec2 vUV; out vec3 vW;
void main(){ vN = normalize(uNormal * aNormal); vUV = aUV;   // KSP DDS/mbm rows are bottom-up: use UVs as-is
  vec4 w = uModel * vec4(aPos,1.0); vW = w.xyz;
  gl_Position = uProj * uView * w; }`;
const FRAG_SRC = `#version 300 es
precision highp float;
in vec3 vN; in vec2 vUV; in vec3 vW; out vec4 frag;
uniform sampler2D uTex; uniform int uHasTex; uniform vec3 uTint;
uniform vec3 uEye; uniform vec3 uEmissive; uniform float uGlow; uniform int uAdditive;
uniform vec3 uAlbedo;   // fallback color for texture-less materials: the .mu's own
                         // _Color when present, else neutral gray (never black).
void main(){
  vec3 base = uHasTex==1 ? texture(uTex,vUV).rgb : uAlbedo;
  if (uAdditive == 1) {                       // engine-glow meshes: additive, throttle-driven
    frag = vec4(base * uGlow * 1.6, 1.0);
    return;
  }
  vec3 N = normalize(vN); if(!gl_FrontFacing) N = -N;
  vec3 V = normalize(uEye - vW);
  vec3 Lk = normalize(vec3( 0.45, 0.80, 0.55));   // key
  vec3 Lf = normalize(vec3(-0.60, 0.15,-0.40));   // fill
  vec3 Lr = normalize(vec3( 0.10,-0.55,-0.85));   // rim (from below/behind)
  float dk = max(dot(N,Lk),0.0), df = max(dot(N,Lf),0.0), dr = max(dot(N,Lr),0.0);
  // hemisphere ambient: bluish sky above, warm-dark ground below
  float hemi = N.y*0.5 + 0.5;
  vec3 amb = mix(vec3(0.16,0.14,0.12), vec3(0.30,0.33,0.40), hemi);
  vec3 diff = vec3(1.00,0.98,0.94)*dk*0.95 + vec3(0.55,0.60,0.70)*df*0.35
            + vec3(0.80,0.85,1.00)*dr*0.25;
  // low-intensity Blinn-Phong (matte metal)
  vec3 H = normalize(Lk + V);
  float spec = pow(max(dot(N,H),0.0), 36.0) * 0.25;
  vec3 col = base * (amb + diff) + vec3(spec);
  // ModuleColorChanger heat glow. In-game _EmissiveColor is masked by the part's
  // emissive texture (which we don't decode), so modulate by base albedo to keep
  // the effect a tint rather than a whitewash.
  col += uEmissive * (0.12 + 0.55 * base);
  col *= 1.15;                                 // exposure
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0/2.2));
  col = mix(col, uTint, uTint.r+uTint.g+uTint.b > 0.0 ? 0.45 : 0.0);
  frag = vec4(col,1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function makeProgram(gl) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

// resolve a texture name to a /api/texture path (strip extension, join with model dir).
function texPath(dir, name) {
  name = (name || '').replace(/\\/g, '/');
  if (name.indexOf('/') >= 0) return name.replace(/\.[^.\/]+$/, '');   // already a full path
  const base = name.replace(/\.[^.\/]+$/, '');
  return dir ? dir + '/' + base : base;
}

// resolve a texture name to a servable path, honoring MODEL{} texture= replacements.
function resolveTex(dir, name, replaceMap) {
  const base = (name || '').replace(/\\/g, '/').replace(/\.[^.\/]+$/, '').split('/').pop().toLowerCase();
  if (replaceMap && replaceMap[base]) return replaceMap[base];   // already GameData-relative, no ext
  return texPath(dir, name);
}

async function loadTexture(gl, s3tc, path) {
  const res = await fetch('/api/texture?path=' + encodeURIComponent(path));
  if (!res.ok) return null;
  const ctype = res.headers.get('Content-Type') || '';
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  if (ctype.indexOf('image/png') >= 0) {
    // PNG is top-down; flip to bottom-up so it matches the DDS/mbm (UVs used as-is).
    const bmp = await createImageBitmap(await res.blob());
    // RACE: `await` above yields to the event loop, and other in-flight loadTexture()
    // calls (attachTextures fires many concurrently, one per unique texture path) run
    // their own gl.bindTexture(gl.TEXTURE_2D, otherTex) while we were suspended. The
    // TEXTURE_2D binding point is single global GL state, so by the time we resume it
    // may no longer point at OUR `tex`. Without re-binding here, this texImage2D can
    // write our pixels into a DIFFERENT (possibly already-good, possibly still-blank)
    // texture object, while our own `tex` is left as an empty/incomplete texture that
    // samples as black — exactly the "renders correctly once, then goes black" symptom,
    // since the clobber happens whenever some other texture's load finishes later.
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return tex;
  }
  const buf = await res.arrayBuffer();
  // Same TEXTURE_2D-binding race as the PNG branch above: this await can let other
  // concurrent loadTexture() calls rebind TEXTURE_2D before we get back here.
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const xfmt = res.headers.get('X-Format');
  if (xfmt === 'RGBA' || xfmt === 'RGB') {                        // raw .mbm pixels
    const w = +res.headers.get('X-Width'), h = +res.headers.get('X-Height');
    const src = new Uint8Array(buf);
    const rgba = new Uint8Array(w*h*4);
    if (xfmt === 'RGBA') rgba.set(src.subarray(0, w*h*4));
    else for (let i=0;i<w*h;i++){ rgba[i*4]=src[i*3]; rgba[i*4+1]=src[i*3+1]; rgba[i*4+2]=src[i*3+2]; rgba[i*4+3]=255; }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return tex;
  }
  const dds = parseDDS(buf);
  if (!dds) { gl.deleteTexture(tex); return null; }
  if (dds.format === 'UNSUPPORTED') {
    // BC6H, uncompressed DDPF_RGB, truncated files, or any other exotic layout we
    // don't decode: upload a flat neutral-gray 1x1 texture rather than leaving the
    // draw item un-textured-but-untinted (which, combined with a white/undefined
    // material _Color, is how these end up rendering solid black). Never black.
    console.warn('[model3d] unsupported DDS format (' + dds.unsupportedTag + '), using neutral gray:', path);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([153,153,153,255]));
    return tex;
  }
  if (s3tc && (dds.format === 'DXT1' || dds.format === 'DXT3' || dds.format === 'DXT5')) {
    const fmt = dds.format === 'DXT1' ? s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT
      : dds.format === 'DXT3' ? s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT
      : s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT;
    // DDS is top-down; we don't flip compressed data (UV.y handled in decode path only),
    // so flip V in shader-free way: sample with flipped V by uploading as-is and flipping uv.
    gl.compressedTexImage2D(gl.TEXTURE_2D, 0, fmt, dds.width, dds.height, 0, dds.data);
    return tex;
  }
  // CPU decode path: DXT1/DXT3/DXT5 (no s3tc extension) or BC4/BC5 (never GPU-uploaded
  // here — EXT_texture_compression_rgtc isn't assumed present).
  const rgba = (dds.format === 'BC4') ? decodeBC4(dds.width, dds.height, dds.data)
    : (dds.format === 'BC5') ? decodeBC5(dds.width, dds.height, dds.data)
    : decodeDXT(dds.width, dds.height, dds.data, dds.format);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, dds.width, dds.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  return tex;
}

/* Build renderable draw items by walking the object tree with hierarchical transforms. */
function buildScene(gl, models, materials) {
  const items = [];
  const bmin = [ Infinity, Infinity, Infinity], bmax = [-Infinity,-Infinity,-Infinity];

  const transformMats = {};    // lowercased transform name -> Unity-space world matrix

  function walk(obj, parentMat, mats, nameStack, isRoot, owner) {
    // KSP's PartLoader OVERWRITES the model root's local TRS with the MODEL{} cfg
    // values (many mods ship .mu roots with editor leftovers: offsets, 90/180-degree
    // rotations). So the root's own transform is ignored; cfg is in parentMat.
    let world;
    if (isRoot) {
      world = parentMat;
    } else {
      const T = M4.translate(obj.pos[0], obj.pos[1], obj.pos[2]);
      const R = M4.fromQuat(obj.rotQuat[0], obj.rotQuat[1], obj.rotQuat[2], obj.rotQuat[3]);
      const S = M4.scale(obj.scale[0], obj.scale[1], obj.scale[2]);
      world = M4.mul(parentMat, M4.mul(M4.mul(T, R), S));   // Unity-space world matrix
    }
    const stack = nameStack.concat([(obj.name || '').toLowerCase()]);
    const tkey = (obj.name || '').toLowerCase();
    if (tkey && !(tkey in transformMats)) transformMats[tkey] = world;
    // obj.rendererMaterials is null unless the .mu node carried an actual
    // MeshRenderer/SkinnedMeshRenderer component (muparse.py read_object()
    // defaults it to null and only fills it in on ET_MESH_RENDERER /
    // ET_SKINNED_MESH_RENDERER). A MeshFilter can exist WITHOUT a renderer —
    // that's how KSP/Unity encodes MeshCollider-only proxy geometry (the
    // low-poly "Collider"/"Collider1"/"Collider2"... nodes seen throughout
    // these .mu trees). Those meshes are never meant to be drawn: rendering
    // them produces exactly the reported bugs — small ones show up as
    // low-resolution white/gray cones near nozzles (untextured, since they
    // have no material index), and large ones (collision proxies sized to
    // fully enclose a nozzle bell, e.g. bluedog_Saturn_Engine_J2T's
    // "Collider 1") swallow the real textured mesh inside a dark untextured
    // shell that reads as the engine "rendering pure black". Skip anything
    // without a renderer entirely.
    if (obj.mesh && obj.mesh.verts && obj.mesh.tris && obj.rendererMaterials) {
      const m = obj.mesh, verts = m.verts, normals = m.normals, uvs = m.uvs;
      const rmats = obj.rendererMaterials || [];
      const itemsBefore = items.length;
      m.tris.forEach((sub, si) => {
        if (!sub.length) return;
        const matIdx = rmats[si] != null ? rmats[si] : (rmats[0] != null ? rmats[0] : -1);
        const item = makeItem(gl, verts, normals, uvs, sub, world, obj.name, matIdx);
        if (item) {
          item.path = stack;
          item.owner = owner;   // MODEL{} this mesh came from (per-model texture resolution)
          item.node = obj;      // source tree node, for cheap re-posing (setDeployed) without a full GL rebuild
          const matDef = matIdx >= 0 ? mats[matIdx] : null;
          // texture-less fallback albedo: the material's own _Color (KSP shaders' diffuse
          // tint) when muparse captured one, else neutral gray — never black.
          item.color = (matDef && matDef.color) ? [matDef.color[0], matDef.color[1], matDef.color[2]] : [0.6, 0.6, 0.6];
          const shader = (matDef && matDef.shader) || '';
          // Unity legacy transparent/additive shaders = engine glow / FX meshes:
          // drawn additively after opaques, brightness driven by the Glow slider.
          item.additive = /Additive|Particles|Alpha/i.test(shader);
          items.push(item);
        }
      });
      // bounds from world-transformed verts (position only); also kept per-item so the
      // dimensions readout can recompute a visibility-filtered bbox cheaply per frame
      // without re-walking mesh data (see computeVisibleBBox()). Also keep the RAW
      // (untransformed, mesh-local-space) bbox so setDeployed() can cheaply re-derive
      // the world bbox from a new world matrix, instead of leaving it.bmin/bmax stuck
      // at the pose that was current when buildScene() ran (see setDeployed()).
      const lmin = [Infinity, Infinity, Infinity], lmax = [-Infinity, -Infinity, -Infinity];
      const rmin = [Infinity, Infinity, Infinity], rmax = [-Infinity, -Infinity, -Infinity];
      for (let i=0;i<verts.length;i+=3) {
        const vx = verts[i], vy = verts[i+1], vz = verts[i+2];
        const wx = world[0]*vx+world[4]*vy+world[8]*vz+world[12];
        const wy = world[1]*vx+world[5]*vy+world[9]*vz+world[13];
        const wz = world[2]*vx+world[6]*vy+world[10]*vz+world[14];
        if (wx<bmin[0])bmin[0]=wx; if (wy<bmin[1])bmin[1]=wy; if (wz<bmin[2])bmin[2]=wz;
        if (wx>bmax[0])bmax[0]=wx; if (wy>bmax[1])bmax[1]=wy; if (wz>bmax[2])bmax[2]=wz;
        if (wx<lmin[0])lmin[0]=wx; if (wy<lmin[1])lmin[1]=wy; if (wz<lmin[2])lmin[2]=wz;
        if (wx>lmax[0])lmax[0]=wx; if (wy>lmax[1])lmax[1]=wy; if (wz>lmax[2])lmax[2]=wz;
        if (vx<rmin[0])rmin[0]=vx; if (vy<rmin[1])rmin[1]=vy; if (vz<rmin[2])rmin[2]=vz;
        if (vx>rmax[0])rmax[0]=vx; if (vy>rmax[1])rmax[1]=vy; if (vz>rmax[2])rmax[2]=vz;
      }
      for (let i=itemsBefore;i<items.length;i++) {
        items[i].bmin = lmin; items[i].bmax = lmax;
        items[i].lbmin = rmin; items[i].lbmax = rmax;   // mesh-local-space, pose-independent
      }
    }
    for (const c of obj.children) walk(c, world, mats, stack, false, owner);
  }

  const transformNames = [];
  function collectNames(o){ transformNames.push(o.name); o.children.forEach(collectNames); }

  for (const model of models) {
    if (!model.tree) continue;
    collectNames(model.tree);
    // apply MODEL{} cfg (position/rotation/scale * rescaleFactor) as the root local
    // transform — exactly what KSP's PartLoader assigns to the model root object.
    const cfg = model.cfg || {};
    const p = parseVec(cfg.position, [0,0,0]), r = parseVec(cfg.rotation, [0,0,0]), sc = parseVec(cfg.scale, [1,1,1]);
    const rf = (model.rescaleFactor != null && isFinite(+model.rescaleFactor)) ? +model.rescaleFactor : 1.25;
    const root = M4.mul(M4.mul(M4.translate(p[0],p[1],p[2]), eulerMat(r)),
                        M4.scale(sc[0]*rf, sc[1]*rf, sc[2]*rf));
    walk(model.tree, root, model.materials || materials || [], [], true, model);
  }
  items.sort((a, b) => (a.additive?1:0) - (b.additive?1:0));   // opaques first, glow last
  return { items, bmin, bmax, transformNames, transformMats };
}

// Matrix-only re-walk of the tree (no GL, no mesh building) — mirrors buildScene()'s
// transform composition exactly (same root cfg handling) so it stays in sync. Used by
// setDeployed() to recompute world matrices cheaply after mutating a node's local
// pos/rotQuat/scale, without re-uploading any GL buffers.
function computeTransformMats(models) {
  const transformMats = {};
  const nodeWorld = new Map();
  function walk(obj, parentMat, isRoot) {
    let world;
    if (isRoot) {
      world = parentMat;
    } else {
      const T = M4.translate(obj.pos[0], obj.pos[1], obj.pos[2]);
      const R = M4.fromQuat(obj.rotQuat[0], obj.rotQuat[1], obj.rotQuat[2], obj.rotQuat[3]);
      const S = M4.scale(obj.scale[0], obj.scale[1], obj.scale[2]);
      world = M4.mul(parentMat, M4.mul(M4.mul(T, R), S));
    }
    nodeWorld.set(obj, world);
    const tkey = (obj.name || '').toLowerCase();
    if (tkey && !(tkey in transformMats)) transformMats[tkey] = world;
    for (const c of (obj.children || [])) walk(c, world, false);
  }
  for (const model of models) {
    if (!model.tree) continue;
    const cfg = model.cfg || {};
    const p = parseVec(cfg.position, [0,0,0]), r = parseVec(cfg.rotation, [0,0,0]), sc = parseVec(cfg.scale, [1,1,1]);
    const rf = (model.rescaleFactor != null && isFinite(+model.rescaleFactor)) ? +model.rescaleFactor : 1.25;
    const root = M4.mul(M4.mul(M4.translate(p[0],p[1],p[2]), eulerMat(r)),
                        M4.scale(sc[0]*rf, sc[1]*rf, sc[2]*rf));
    walk(model.tree, root, true);
  }
  return { transformMats, nodeWorld };
}

// Set each animated node's local TRS to a clip's start (retracted) or end (deployed)
// pose. muparse.py captures, per curve: path (target node, relative to the node the
// Animation component sits on, '/'-separated), property ("m_Local{Position,Rotation,
// Scale}.{x,y,z,w}"), and the first/last keyframe VALUES. A curve only ever touches
// one scalar component, so applying it means: resolve the target node, then overwrite
// just that one component of pos/rotQuat/scale — components no curve touches are left
// exactly as muparse.py parsed them (the .mu's built-in rest/frame-0 pose).
//
// animNames, when given, restricts application to clips whose name (case-insensitive)
// is in the set — e.g. the part's ModuleDeployableEngine EngineAnimationName(s) — so an
// unrelated animation on the same node (gimbal sway, heat-glow color cycle, a looping
// FX) never gets its end pose baked in. Accepts a single string (back-compat) or an
// array of strings (a part can carry multiple ModuleDeployableEngine modules, e.g. a
// B9PartSwitch engineSwitch with several distinct extendable-nozzle subtypes — only
// the currently-visible subtype's nozzle is seen, so applying every clip is safe).
// When omitted/null every captured clip is applied; callers that care about precision
// (app.js) always pass the name(s).
function applyDeployPose(models, deployed, animNames) {
  const nameSet = animNames == null ? null :
    new Set((Array.isArray(animNames) ? animNames : [animNames]).map(n => String(n).toLowerCase()));
  function resolvePath(node, path) {
    if (!path) return node;
    let cur = node;
    for (const seg of path.split('/')) {
      if (!seg) continue;
      const next = (cur.children || []).find(c => c.name === seg);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }
  const PROP_RE = /^m_Local(Position|Rotation|Scale)\.(x|y|z|w)$/;
  function applyNode(node) {
    if (node.animations) {
      for (const clip of node.animations) {
        if (nameSet && !nameSet.has(String(clip.name).toLowerCase())) continue;
        for (const curve of clip.curves) {
          const m = PROP_RE.exec(curve.property || '');
          if (!m) continue;
          const target = resolvePath(node, curve.path);
          if (!target) continue;
          const val = deployed ? curve.endValue : curve.startValue;
          if (val == null) continue;
          const idx = { x: 0, y: 1, z: 2, w: 3 }[m[2]];
          if (m[1] === 'Position') target.pos[idx] = val;
          else if (m[1] === 'Rotation') target.rotQuat[idx] = val;
          else if (m[1] === 'Scale') target.scale[idx] = val;
        }
      }
    }
    for (const c of (node.children || [])) applyNode(c);
  }
  for (const model of models) if (model.tree) applyNode(model.tree);
}

function parseVec(s, def) {
  if (!s) return def.slice();
  const a = String(s).split(',').map(Number);
  return a.length >= 3 && a.every(n=>!isNaN(n)) ? a : def.slice();
}
function eulerMat(deg) {
  // Unity Quaternion.Euler semantics: intrinsic Z, then X, then Y  =>  R = Ry*Rx*Rz
  const rx=deg[0]*Math.PI/180, ry=deg[1]*Math.PI/180, rz=deg[2]*Math.PI/180;
  const cx=Math.cos(rx),sx=Math.sin(rx),cy=Math.cos(ry),sy=Math.sin(ry),cz=Math.cos(rz),sz=Math.sin(rz);
  const Rx=[1,0,0,0, 0,cx,sx,0, 0,-sx,cx,0, 0,0,0,1];
  const Ry=[cy,0,-sy,0, 0,1,0,0, sy,0,cy,0, 0,0,0,1];
  const Rz=[cz,sz,0,0, -sz,cz,0,0, 0,0,1,0, 0,0,0,1];
  return M4.mul(M4.mul(Ry,Rx),Rz);
}

function makeItem(gl, verts, normals, uvs, sub, world, name, matIdx) {
  const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  let nbo = null;
  if (normals && normals.length === verts.length) {
    nbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
  }
  let ubo = null;
  if (uvs && uvs.length === (verts.length/3)*2) {
    ubo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ubo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
  }
  // triangle indices uploaded exactly as .mu/muparse.py produced them — no per-mesh
  // winding flip; handedness is handled once, globally, via gl.frontFace(gl.CW).
  const idx = new Uint32Array(sub);
  const ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  return { vbo, nbo, ubo, ibo, count: idx.length, model: world,
           normalMat: M4.normalMat(world), name, matIdx, tex: null };
}

async function attachTextures(gl, s3tc, items, models, materials) {
  // material index -> texture (dedup by mainTex name+dir)
  // Resolve each mesh against the MODEL{} it belongs to (item.owner): its own
  // materials, textures list, directory and texture= replacements. A part may have
  // several MODEL nodes whose .mu carry independent material/texture tables and live
  // in different directories, so resolving everything against models[0] mis-textures
  // (or whites-out) every mesh past the first model.
  const cache = new Map();
  const fallback = models.length ? models[0] : null;
  for (const it of items) {
    if (it.matIdx < 0) continue;
    const owner = it.owner || fallback;
    if (!owner) continue;
    const modelMats = owner.materials || materials || [];
    const mat = modelMats[it.matIdx];
    if (!mat || mat.mainTex == null || mat.mainTex < 0) continue;
    const texList = owner.textures || [];
    const texRec = texList[mat.mainTex];
    if (!texRec) continue;
    const path = resolveTex(owner.dir || '', texRec.name, owner.textureReplace || {});
    if (!cache.has(path)) cache.set(path, loadTexture(gl, s3tc, path).catch((err) => {
      console.warn('[model3d] texture load failed, falling back to material color:', path, err);
      return null;
    }));
    it.tex = await cache.get(path);
    if (!it.tex) console.warn('[model3d] no texture for', it.name, '- using fallback albedo', it.color);
  }
}

// KSP FloatCurve: cubic Hermite between sorted keys {t,v,inT,outT}
function evalCurve(keys, x) {
  if (!keys || !keys.length) return 0;
  if (x <= keys[0].t) return keys[0].v;
  if (x >= keys[keys.length-1].t) return keys[keys.length-1].v;
  let i = 0; while (i < keys.length-1 && keys[i+1].t < x) i++;
  const k0 = keys[i], k1 = keys[i+1]; const dt = k1.t-k0.t || 1e-6; const s = (x-k0.t)/dt;
  const s2 = s*s, s3 = s2*s;
  const h00 = 2*s3-3*s2+1, h10 = s3-2*s2+s, h01 = -2*s3+3*s2, h11 = s3-s2;
  return h00*k0.v + h10*dt*k0.outT + h01*k1.v + h11*dt*k1.inT;
}

function emissiveFor(st, itemName) {
  const c = st.emissiveCfg;
  if (!c || st.glow <= 0) return [0,0,0];
  const n = (itemName || '').toLowerCase();
  if (c.included && c.included.length && !c.included.some(x => n === x || n.indexOf(x) >= 0)) return [0,0,0];
  if (c.excluded && c.excluded.some(x => n === x || n.indexOf(x) >= 0)) return [0,0,0];
  return [evalCurve(c.r, st.glow), evalCurve(c.g, st.glow), evalCurve(c.b, st.glow)];
}

function render(st) {
  const { gl, prog, loc, cam } = st;
  const w = st.canvas.width, h = st.canvas.height;
  gl.viewport(0,0,w,h);
  gl.clearColor(0,0,0,0);                                        // CSS gradient shows through
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);            // double-sided
  // Winding: docs/RenderingGroundTruth.md's prose says gl.frontFace(gl.CW), but its own
  // T2 numeric test vector (worked by hand + verified in scratch/test_vectors.js)
  // shows the front-facing triangle it specifies comes out CCW (positive shoelace
  // area) in this exact lookAtUnity+mirrorZ view-space construction. Unity's "front
  // faces are clockwise" documentation is stated in D3D-style y-down screen space;
  // translated into GL/WebGL's y-up NDC that is CCW — i.e. GL's own DEFAULT front
  // face is already correct here, and calling frontFace(CW) would invert it. We
  // therefore keep the GL default (CCW) rather than following the doc's literal enum,
  // per the doc's own instruction to treat the numeric vectors as authoritative.
  gl.frontFace(gl.CCW);
  // no per-mesh winding flip anywhere: single global setting only (see above).
  gl.useProgram(prog);

  const proj = M4.perspective(50*Math.PI/180, w/h, cam.radius*0.01, cam.radius*20);
  const cx = cam.target[0] + cam.radius*Math.cos(cam.pitch)*Math.sin(cam.yaw);
  const cy = cam.target[1] + cam.radius*Math.sin(cam.pitch);
  const cz = cam.target[2] + cam.radius*Math.cos(cam.pitch)*Math.cos(cam.yaw);
  // Build the view entirely in Unity space, then fold the single handedness mirror
  // into it once (docs/RenderingGroundTruth.md option (b)) — everything upstream
  // (node worlds, bone worlds, bindposes) stays untouched Unity-space data.
  const view = M4.mirrorZ(M4.lookAtUnity([cx,cy,cz], cam.target, [0,1,0]));
  st.lastView = view; st.lastProj = proj; st.lastEye = [cx, cy, cz];   // for the pick-handler hook
  gl.uniformMatrix4fv(loc.uProj, false, proj);
  gl.uniformMatrix4fv(loc.uView, false, view);
  gl.uniform3f(loc.uEye, cx, cy, cz);
  gl.uniform1f(loc.uGlow, st.glow);

  // opaque-pass ground grid (thin lines, own minimal shader; drawn before the mesh
  // loop so it depth-tests normally against opaque geometry).
  drawGrid(gl, st, view, proj);
  gl.useProgram(prog);

  const hidden = st.hidden;
  let blending = false;
  for (const it of st.scene.items) {                             // sorted: opaques then additive
    if (hidden && it.path && it.path.some(n => hidden.has(n))) continue;   // switch-hidden subtree
    if (it.additive) {
      if (st.glow <= 0.004) continue;                            // idle: glow meshes invisible
      if (!blending) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false); blending = true; }
      gl.uniform1i(loc.uAdditive, 1);
      gl.uniform3f(loc.uEmissive, 0, 0, 0);
    } else {
      gl.uniform1i(loc.uAdditive, 0);
      const em = emissiveFor(st, it.name);
      gl.uniform3f(loc.uEmissive, em[0], em[1], em[2]);
    }
    gl.uniformMatrix4fv(loc.uModel, false, it.model);
    gl.uniformMatrix3fv(loc.uNormal, false, it.normalMat);
    gl.bindBuffer(gl.ARRAY_BUFFER, it.vbo);
    gl.enableVertexAttribArray(loc.aPos); gl.vertexAttribPointer(loc.aPos,3,gl.FLOAT,false,0,0);
    if (it.nbo){ gl.bindBuffer(gl.ARRAY_BUFFER,it.nbo); gl.enableVertexAttribArray(loc.aNormal); gl.vertexAttribPointer(loc.aNormal,3,gl.FLOAT,false,0,0);}
    else gl.disableVertexAttribArray(loc.aNormal), gl.vertexAttrib3f(loc.aNormal,0,0,1);
    if (it.ubo){ gl.bindBuffer(gl.ARRAY_BUFFER,it.ubo); gl.enableVertexAttribArray(loc.aUV); gl.vertexAttribPointer(loc.aUV,2,gl.FLOAT,false,0,0);}
    else gl.disableVertexAttribArray(loc.aUV), gl.vertexAttrib2f(loc.aUV,0,0);
    const useTex = it.tex ? 1 : 0;
    gl.uniform1i(loc.uHasTex, useTex);
    if (useTex){ gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, it.tex); gl.uniform1i(loc.uTex,0); }
    else { const c = it.color || [0.6,0.6,0.6]; gl.uniform3f(loc.uAlbedo, c[0], c[1], c[2]); }
    const hl = st.highlightName && it.name === st.highlightName;
    gl.uniform3f(loc.uTint, hl?1.0:0, hl?0.55:0, hl?0.1:0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, it.ibo);
    gl.drawElements(gl.TRIANGLES, it.count, gl.UNSIGNED_INT, 0);
  }
  if (blending) { gl.disable(gl.BLEND); gl.depthMask(true); }

  // registered overlays (e.g. Waterfall plume) draw after everything, same context.
  if (st.overlays && st.overlays.length) {
    const cam = { view, proj, eye: [cx, cy, cz], time: performance.now() / 1000 };
    for (const fn of st.overlays) { try { fn(gl, cam); } catch (e) { console.error(e); } }
    // overlays may change GL state; restore what the main pass expects
    gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
    if (gl.bindVertexArray) gl.bindVertexArray(null);
    requestRender(st);                     // keep animating while overlays are active
  }
}

function resize(st) {
  const c = st.canvas, dpr = Math.min(window.devicePixelRatio||1, 2);
  const w = c.clientWidth*dpr|0, h = c.clientHeight*dpr|0;
  if (c.width!==w || c.height!==h){ c.width=w; c.height=h; }
}

// Pivot-camera pan: translate cam.target (the pivot) within the camera's screen
// plane, scaled by distance so pan feels consistent at any zoom (Blender-like).
// Sign derivation: dragging the mouse right/up should make the point under the
// cursor follow the cursor, i.e. the RENDERED content shifts by +right*dx and
// -camUp*dy (screen y grows downward) in world space. Translating the camera RIG
// (eye+target together, which is what moving cam.target does — eye is always
// target + spherical offset) by a world vector V shifts the rendered content by
// -V (moving the camera right makes the world appear to shift left). So the rig
// must move by the NEGATION of the desired content shift:
//   rigDelta = -(right*dx - camUp*dy) = -right*dx + camUp*dy
function panCamera(st, dx, dy) {
  const cam = st.cam;
  // Same eye-offset convention as render(): eye = target + radius*(cos(pitch)*sin(yaw), sin(pitch), cos(pitch)*cos(yaw)).
  const eyeDir = [Math.cos(cam.pitch)*Math.sin(cam.yaw), Math.sin(cam.pitch), Math.cos(cam.pitch)*Math.cos(cam.yaw)];
  const fwd = [-eyeDir[0], -eyeDir[1], -eyeDir[2]];             // target-facing direction
  const worldUp = [0,1,0];
  const right = norm3(cross3(worldUp, fwd));
  const camUp = norm3(cross3(fwd, right));
  // distance-scaled pan speed: at radius R, ~R units of world-space pan per canvas-width drag
  const scale = cam.radius * 1.2 / Math.max(st.canvas.clientWidth || 1, 1);
  const dxw = -right[0]*dx + camUp[0]*dy, dyw = -right[1]*dx + camUp[1]*dy, dzw = -right[2]*dx + camUp[2]*dy;
  cam.target[0] += dxw*scale; cam.target[1] += dyw*scale; cam.target[2] += dzw*scale;
}

function setupControls(st) {
  const c = st.canvas;
  let orbiting=false, lx=0, ly=0;
  let panning=false, plx=0, ply=0;
  let midDownTime=0, midDownX=0, midDownY=0, midMoved=false;

  c.addEventListener('mousedown', e=>{
    if (e.button === 0) {
      if (PICK_HANDLER && st.lastView) {
        const rect = c.getBoundingClientRect();
        const ndcX = ((e.clientX-rect.left)/rect.width)*2-1;
        const ndcY = -(((e.clientY-rect.top)/rect.height)*2-1);
        let consumed = false;
        try {
          consumed = PICK_HANDLER(e, { ndcX, ndcY, view: st.lastView, proj: st.lastProj, eye: st.lastEye,
                                        canvasW: c.width, canvasH: c.height });
        } catch (err) { console.error('[model3d] pick handler failed:', err); }
        if (consumed) return;   // gizmo drag began — camera yields, no orbiting this sequence
      }
      orbiting = true; lx = e.clientX; ly = e.clientY;
    } else if (e.button === 1) {
      e.preventDefault();                         // suppress browser autoscroll icon
      panning = true; plx = e.clientX; ply = e.clientY; midMoved = false;
      const now = performance.now();
      if (now - midDownTime < 350 && !midMoved && Math.hypot(e.clientX-midDownX, e.clientY-midDownY) < 6) {
        // second mousedown of a double-click: reset pivot + framing (Blender "frame all")
        resetCameraFraming(st);
        midDownTime = 0;                           // consume, don't chain into a triple
      } else {
        midDownTime = now; midDownX = e.clientX; midDownY = e.clientY;
      }
    }
  });
  window.addEventListener('mouseup', e=>{
    if (e.button === 0) orbiting = false;
    else if (e.button === 1) panning = false;
  });
  window.addEventListener('mousemove', e=>{
    if (orbiting) {
      st.cam.yaw -= (e.clientX-lx)*0.01; st.cam.pitch += (e.clientY-ly)*0.01;
      st.cam.pitch = Math.max(-1.5, Math.min(1.5, st.cam.pitch));
      lx=e.clientX; ly=e.clientY; requestRender(st);
    }
    if (panning) {
      const dx = e.clientX-plx, dy = e.clientY-ply;
      if (Math.hypot(dx,dy) > 2) midMoved = true;   // real drag disqualifies a double-click
      panCamera(st, dx, dy);
      plx=e.clientX; ply=e.clientY; requestRender(st);
    }
  });
  // Plain MMB drag AND Shift+MMB drag both pan (orbit already owns LMB, so there's
  // no ambiguity to resolve by requiring Shift — see task doc for rationale).
  c.addEventListener('contextmenu', e=>{ if (panning) e.preventDefault(); });
  c.addEventListener('wheel', e=>{ e.preventDefault();
    st.cam.radius *= Math.exp(e.deltaY*0.001);
    if (LOCK_ZOOM) LOCKED_RADIUS = st.cam.radius;    // orbit/zoom still works; keeps the lock in sync
    requestRender(st); }, {passive:false});
}

// Blender-style "frame all": recenter the pivot on the model bbox center and
// restore default framing distance (auto-fit, or the locked radius if lock-zoom
// is on). Leaves yaw/pitch alone (only re-centers/re-frames, doesn't spin).
function resetCameraFraming(st) {
  const cam = st.cam;
  cam.target[0] = st.autoFitCenter[0]; cam.target[1] = st.autoFitCenter[1]; cam.target[2] = st.autoFitCenter[2];
  cam.radius = LOCK_ZOOM ? (LOCKED_RADIUS != null ? LOCKED_RADIUS : st.autoFitRadius) : st.autoFitRadius;
  if (LOCK_ZOOM) LOCKED_RADIUS = cam.radius;
  requestRender(st);
}

let rafPending = false;
function requestRender(st) {
  if (rafPending) return; rafPending = true;
  requestAnimationFrame(()=>{ rafPending=false; if(STATE===st){ resize(st); render(st); } });
}

const ModelViewer = {
  async mount(container, partName) {
    container.textContent = '';
    const canvas = document.createElement('canvas');
    canvas.className = 'model3d-canvas';
    const status = document.createElement('div'); status.className='model3d-status';
    status.textContent = 'Loading model…';
    container.appendChild(canvas); container.appendChild(status);

    let gl;
    try { gl = canvas.getContext('webgl2'); } catch(e) {}
    if (!gl) { status.textContent = 'WebGL2 not available'; return; }

    let data;
    try {
      const r = await fetch('/api/model?part=' + encodeURIComponent(partName));
      data = await r.json();
    } catch(e) {
      console.error('[model3d] /api/model fetch/parse failed:', e && e.message, e && e.stack);
      status.textContent = 'model unavailable'; return;
    }
    const models = (data.models || []).filter(m => m.tree);
    // Live-edit override for the part's root rescaleFactor (UI "Part" section), applied
    // to every MODEL{} entry — matches KSP, where rescaleFactor is a single PART{}-level
    // key that scales the local transform of all of a part's MODEL nodes uniformly.
    if (RESCALE_OVERRIDE != null && isFinite(RESCALE_OVERRIDE)) {
      for (const m of models) m.rescaleFactor = RESCALE_OVERRIDE;
    }
    if (!models.length) {
      console.error('[model3d] /api/model returned no usable models for', partName, ':', data);
      status.textContent = (data.models && data.models[0] && data.models[0].error)
        ? 'model unavailable (' + data.models[0].error + ')' : 'model unavailable';
      return;
    }

    let st;
    try {
      const prog = makeProgram(gl);
      const s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
      const scene = buildScene(gl, models, models[0].materials);
      const ctr = [ (scene.bmin[0]+scene.bmax[0])/2, (scene.bmin[1]+scene.bmax[1])/2, (scene.bmin[2]+scene.bmax[2])/2 ];
      const diag = Math.hypot(scene.bmax[0]-scene.bmin[0], scene.bmax[1]-scene.bmin[1], scene.bmax[2]-scene.bmin[2]) || 4;
      const autoFitRadius = diag*1.1;
      // "Lock zoom across parts": use the persisted fixed distance instead of this
      // part's own auto-fit radius, so switching parts reveals true relative scale.
      // The first part viewed after the lock is enabled seeds LOCKED_RADIUS.
      if (LOCK_ZOOM && LOCKED_RADIUS == null) LOCKED_RADIUS = autoFitRadius;
      const initialRadius = LOCK_ZOOM ? LOCKED_RADIUS : autoFitRadius;
      st = {
        gl, prog, canvas, scene, highlightName: null, hidden: null,
        rawModels: models, deployed: false,   // parsed .mu trees (mutated in-place by setDeployed) + current pose flag
        glow: 0, emissiveCfg: null, overlays: [], gridOn: true,
        grid: buildGrid(gl, scene),
        autoFitCenter: ctr.slice(), autoFitRadius,   // for double-MMB "frame all" reset
        loc: {
          aPos: gl.getAttribLocation(prog,'aPos'), aNormal: gl.getAttribLocation(prog,'aNormal'),
          aUV: gl.getAttribLocation(prog,'aUV'),
          uProj: gl.getUniformLocation(prog,'uProj'), uView: gl.getUniformLocation(prog,'uView'),
          uModel: gl.getUniformLocation(prog,'uModel'), uNormal: gl.getUniformLocation(prog,'uNormal'),
          uTex: gl.getUniformLocation(prog,'uTex'), uHasTex: gl.getUniformLocation(prog,'uHasTex'),
          uTint: gl.getUniformLocation(prog,'uTint'), uEye: gl.getUniformLocation(prog,'uEye'),
          uEmissive: gl.getUniformLocation(prog,'uEmissive'), uGlow: gl.getUniformLocation(prog,'uGlow'),
          uAdditive: gl.getUniformLocation(prog,'uAdditive'), uAlbedo: gl.getUniformLocation(prog,'uAlbedo'),
        },
        cam: { target: ctr, radius: initialRadius, yaw: 0.7, pitch: 0.4 },
      };
      STATE = st;
      setupControls(st);
      resize(st); render(st);
      status.textContent = scene.items.length + ' meshes · ' + scene.transformNames.length + ' transforms · drag to rotate, wheel to zoom';
      // textures load async, re-render as they arrive
      attachTextures(gl, s3tc, scene.items, models, models[0].materials).then(()=>{ if(STATE===st) requestRender(st); });
      window.addEventListener('resize', ()=>{ if(STATE===st) requestRender(st); });
    } catch(e) {
      status.textContent = 'model render failed: ' + e.message;
      console.error('[model3d] mount build/render failed:', e && e.message, e && e.stack);
    }
  },

  listTransforms() {
    return STATE ? STATE.scene.transformNames.slice() : [];
  },

  highlight(name) {
    if (STATE) { STATE.highlightName = name || null; requestRender(STATE); }
  },

  // visibleMap: { transformName: bool } — a transform (and its whole subtree) is
  // hidden when its entry is false. Names not present default to visible. Matching
  // is case-insensitive and applies to any ancestor along a mesh's hierarchy path.
  setTransformVisibility(visibleMap) {
    if (!STATE) return;
    if (!visibleMap) { STATE.hidden = null; requestRender(STATE); return; }
    const hidden = new Set();
    for (const k in visibleMap) if (!visibleMap[k]) hidden.add(k.toLowerCase());
    STATE.hidden = hidden.size ? hidden : null;
    requestRender(STATE);
  },

  // Heat/throttle glow 0..1: drives additive glow-mesh brightness + emissive curves.
  setGlow(v) {
    if (STATE) { STATE.glow = Math.max(0, Math.min(1, +v || 0)); requestRender(STATE); }
  },

  // cfg: {r,g,b: [{t,v,inT,outT}...], included:[names], excluded:[names]} or null.
  // From the part's ModuleColorChanger (_EmissiveColor); names lowercased.
  setEmissiveConfig(cfg) {
    if (STATE) { STATE.emissiveCfg = cfg || null; requestRender(STATE); }
  },

  // Pose deployable-nozzle (or other .mu-animated) parts at a clip's end (deployed=
  // true, the default firing state) or start (deployed=false, stowed) pose. animNames
  // restricts to specific clip(s) by name (recommended — pass the module's
  // animationName(s), e.g. ModuleDeployableEngine's EngineAnimationName); accepts a
  // single string or an array (a part can have multiple ModuleDeployableEngine
  // modules, e.g. a B9PartSwitch engineSwitch with several extendable-nozzle
  // subtypes); omit to apply every captured clip. No-op if the model has no captured
  // animations (nothing to pose). Cheap: only recomputes world matrices for existing
  // items/transforms, no GL buffer rebuild — safe to call on every checkbox toggle.
  setDeployed(deployed, animNames) {
    if (!STATE || !STATE.rawModels) return;
    const st = STATE;
    applyDeployPose(st.rawModels, !!deployed, animNames || null);
    const { transformMats, nodeWorld } = computeTransformMats(st.rawModels);
    st.scene.transformMats = transformMats;
    for (const it of st.scene.items) {
      if (it.node && nodeWorld.has(it.node)) {
        it.model = nodeWorld.get(it.node);
        it.normalMat = M4.normalMat(it.model);
        // Re-derive the world-space bbox from the pose-independent local bbox
        // (item.lbmin/lbmax, captured once in buildScene()) transformed through the
        // freshly-recomputed world matrix. Without this, getDimensions()/auto-fit/grid
        // keep using the bbox captured at whatever pose was current when buildScene()
        // ran, so a deployed extension never shows up in the dimensions readout even
        // though the mesh itself has moved (it.model, updated just above, does drive
        // the actual draw — see render()'s gl.uniformMatrix4fv(loc.uModel, ...)).
        if (it.lbmin && it.lbmax) {
          const m = it.model;
          const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
          for (let c = 0; c < 8; c++) {
            const vx = (c & 1) ? it.lbmax[0] : it.lbmin[0];
            const vy = (c & 2) ? it.lbmax[1] : it.lbmin[1];
            const vz = (c & 4) ? it.lbmax[2] : it.lbmin[2];
            const wx = m[0]*vx+m[4]*vy+m[8]*vz+m[12];
            const wy = m[1]*vx+m[5]*vy+m[9]*vz+m[13];
            const wz = m[2]*vx+m[6]*vy+m[10]*vz+m[14];
            if (wx<bmin[0])bmin[0]=wx; if (wy<bmin[1])bmin[1]=wy; if (wz<bmin[2])bmin[2]=wz;
            if (wx>bmax[0])bmax[0]=wx; if (wy>bmax[1])bmax[1]=wy; if (wz>bmax[2])bmax[2]=wz;
          }
          it.bmin = bmin; it.bmax = bmax;
        }
      }
    }
    st.deployed = !!deployed;
    requestRender(st);
  },

  // ---- plume/overlay integration ----
  // Unity-space (untouched, no handedness conversion) world matrix of a named
  // transform, or null. Consumers must apply the same view-only mirror this file
  // uses (see M4.mirrorZ) rather than mirroring the matrix itself.
  getTransformMatrix(name) {
    if (!STATE) return null;
    const m = STATE.scene.transformMats[(name || '').toLowerCase()];
    return m ? m.slice() : null;
  },

  // fn(gl, {view, proj, eye, time}) drawn after the main pass each frame.
  addOverlay(fn) {
    if (!STATE || typeof fn !== 'function') return;
    STATE.overlays.push(fn); requestRender(STATE);
  },
  removeOverlay(fn) {
    if (!STATE) return;
    const i = STATE.overlays.indexOf(fn);
    if (i >= 0) STATE.overlays.splice(i, 1);
    requestRender(STATE);
  },

  getGL() { return STATE ? STATE.gl : null; },

  // World-space bounding box of currently-visible meshes only, as a physical-size
  // readout: height = Y extent, diameter = max(X extent, Z extent). null if nothing
  // is visible/mounted yet.
  getDimensions() {
    if (!STATE) return null;
    const b = computeVisibleBBox(STATE);
    if (!b) return null;
    return {
      height: b.bmax[1] - b.bmin[1],
      diameter: Math.max(b.bmax[0] - b.bmin[0], b.bmax[2] - b.bmin[2]),
    };
  },

  setGridVisible(v) {
    if (STATE) { STATE.gridOn = !!v; requestRender(STATE); }
  },

  // "Lock zoom across parts": when enabled, camera distance stops auto-fitting to
  // each part and instead uses/updates a single persisted distance (module-level,
  // survives mount() across part switches) so relative part scale is visible.
  setLockZoom(v) {
    LOCK_ZOOM = !!v;
    if (LOCK_ZOOM && LOCKED_RADIUS == null && STATE) LOCKED_RADIUS = STATE.cam.radius;
  },

  // Live-preview a part-root rescaleFactor edit before it's saved as a patch. `v`
  // (a finite number) or null/NaN to clear back to the on-disk value. Takes effect
  // on the NEXT mount() — caller (app.js) must force a remount to see it applied,
  // same as any other model-affecting edit.
  setRescaleOverride(v) {
    RESCALE_OVERRIDE = (v != null && isFinite(v)) ? +v : null;
  },

  redraw() { if (STATE) { resize(STATE); render(STATE); } },

  // Register a single pick handler: fn(mousedownEvent, {ndcX,ndcY,view,proj,eye,
  // canvasW,canvasH}) called before LMB starts an orbit drag; return truthy to have
  // the camera skip its own drag for this pointer sequence (e.g. a gizmo handle was
  // grabbed). Pass null/undefined to unregister. Persists across mount() calls.
  setPickHandler(fn) { PICK_HANDLER = (typeof fn === 'function') ? fn : null; },

  // The current B9PartSwitch/disable-transform/shroud hidden-node-name set (lowercased),
  // as last computed by app.js updateModelVisibility() -> setTransformVisibility(), or
  // null if nothing is hidden. Exposed so other consumers (plume attach-point filtering
  // in app.js updatePlumes) can reuse this single source of truth instead of
  // re-deriving B9PS visibility themselves.
  getHiddenSet() {
    return STATE ? STATE.hidden : null;
  },

  // Names of draw nodes currently visible (hidden subtrees excluded). For testing.
  debugVisibleNodes() {
    if (!STATE) return [];
    const h = STATE.hidden, out = [];
    for (const it of STATE.scene.items) {
      if (h && it.path && it.path.some(n => h.has(n))) continue;
      out.push(it.name);
    }
    return out;
  },
};

ModelViewer._test = { M4, eulerMat };   // exposed for numeric regression tests only
window.ModelViewer = ModelViewer;
if (typeof module !== 'undefined' && module.exports) module.exports = ModelViewer;
})();
