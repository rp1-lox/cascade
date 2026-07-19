"""Standalone KSP .mu binary model parser -> plain JSON.

The .mu format is Unity-serialized (Squad's proprietary format). This parser is a
clean-room reimplementation based on the documented structure of taniwha's Blender
importer (io_object_mu / mu.py). The format has NO chunk length prefixes: every
record type must be parsed exactly or the stream desynchronizes. Therefore every
entry type is fully consumed even when its data is discarded (colliders, cameras,
lights, animations, particles).

Coordinates are emitted RAW in Unity space (Y-up, left-handed). Positions are
[x,y,z], rotations are quaternions [x,y,z,w], scales [x,y,z]. Triangle winding is
left untouched; the WebGL viewer handles the LHS->RHS conversion and winding.

Usage:
    python muparse.py <file.mu>            # print summary
    python muparse.py <file.mu> --json     # dump full JSON
    from muparse import parse_file          # -> dict
"""
import struct, sys, json, os

# ---- entry types --------------------------------------------------------
ET_CHILD_TRANSFORM_START = 0
ET_CHILD_TRANSFORM_END = 1
ET_ANIMATION = 2
ET_MESH_COLLIDER = 3
ET_SPHERE_COLLIDER = 4
ET_CAPSULE_COLLIDER = 5
ET_BOX_COLLIDER = 6
ET_MESH_FILTER = 7
ET_MESH_RENDERER = 8
ET_SKINNED_MESH_RENDERER = 9
ET_MATERIALS = 10
ET_MATERIAL = 11
ET_TEXTURES = 12
ET_MESH_START = 13
ET_MESH_VERTS = 14
ET_MESH_UV = 15
ET_MESH_UV2 = 16
ET_MESH_NORMALS = 17
ET_MESH_TANGENTS = 18
ET_MESH_TRIANGLES = 19
ET_MESH_BONE_WEIGHTS = 20
ET_MESH_BIND_POSES = 21
ET_MESH_END = 22
ET_LIGHT = 23
ET_TAG_AND_LAYER = 24
ET_MESH_COLLIDER2 = 25
ET_SPHERE_COLLIDER2 = 26
ET_CAPSULE_COLLIDER2 = 27
ET_BOX_COLLIDER2 = 28
ET_WHEEL_COLLIDER = 29
ET_CAMERA = 30
ET_PARTICLES = 31
ET_MESH_VERTEX_COLORS = 32

MODEL_BINARY = 76543
FILE_VERSION = 5

# shader type -> name (old material format, version < 4)
SHADER_NAMES = {
    0: "KSP/Custom", 1: "KSP/Diffuse", 2: "KSP/Specular", 3: "KSP/Bumped",
    4: "KSP/Bumped Specular", 5: "KSP/Emissive/Diffuse",
    6: "KSP/Emissive/Specular", 7: "KSP/Emissive/Bumped Specular",
    8: "KSP/Alpha/Cutoff", 9: "KSP/Alpha/Cutoff Bumped", 10: "KSP/Alpha/Translucent",
    11: "KSP/Alpha/Translucent Specular", 12: "KSP/Alpha/Unlit Transparent",
    13: "KSP/Unlit", 14: "KSP/Particles/Alpha Blended", 15: "KSP/Particles/Additive",
}
# old-format property layout per shader type: list of (kind, name)
# kind: 't' MuMatTex, 'c' color(4f), 'f' float
SHADER_PROPS = {
    0: [],
    1: [('t', '_MainTex')],
    2: [('t', '_MainTex'), ('c', '_SpecColor'), ('f', '_Shininess')],
    3: [('t', '_MainTex'), ('t', '_BumpMap')],
    4: [('t', '_MainTex'), ('t', '_BumpMap'), ('c', '_SpecColor'), ('f', '_Shininess')],
    5: [('t', '_MainTex'), ('t', '_Emissive'), ('c', '_EmissiveColor')],
    6: [('t', '_MainTex'), ('c', '_SpecColor'), ('f', '_Shininess'),
        ('t', '_Emissive'), ('c', '_EmissiveColor')],
    7: [('t', '_MainTex'), ('t', '_BumpMap'), ('c', '_SpecColor'), ('f', '_Shininess'),
        ('t', '_Emissive'), ('c', '_EmissiveColor')],
    8: [('t', '_MainTex'), ('f', '_Cutoff')],
    9: [('t', '_MainTex'), ('t', '_BumpMap'), ('f', '_Cutoff')],
    10: [('t', '_MainTex')],
    11: [('t', '_MainTex'), ('f', '_Gloss'), ('c', '_SpecColor'), ('f', '_Shininess')],
    12: [('t', '_MainTex'), ('c', '_Color')],
    13: [('t', '_MainTex'), ('c', '_Color')],
    14: [('t', '_MainTex'), ('c', '_Color'), ('f', '_InvFade')],
    15: [('t', '_MainTex'), ('c', '_Color'), ('f', '_InvFade')],
}


class Reader:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def _take(self, n):
        if self.p + n > len(self.d):
            raise EOFError(f"read past end at {self.p} (+{n}, len {len(self.d)})")
        b = self.d[self.p:self.p + n]
        self.p += n
        return b

    def int(self):
        return struct.unpack_from('<i', self._take(4))[0]

    def uint(self):
        return struct.unpack_from('<I', self._take(4))[0]

    def byte(self):
        return self._take(1)[0]

    def float(self):
        return struct.unpack_from('<f', self._take(4))[0]

    def floats(self, n):
        return list(struct.unpack_from('<%df' % n, self._take(4 * n)))

    def ints(self, n):
        return list(struct.unpack_from('<%di' % n, self._take(4 * n)))

    def vec2(self):
        return self.floats(2)

    def vec3(self):
        return self.floats(3)

    def vec4(self):
        return self.floats(4)

    def string(self):
        # .NET BinaryReader style: 7-bit encoded length prefix, then UTF-8 bytes
        length = 0
        shift = 0
        while True:
            b = self.byte()
            length |= (b & 0x7f) << shift
            if not (b & 0x80):
                break
            shift += 7
        return self._take(length).decode('utf-8', 'replace')


# ---- mesh --------------------------------------------------------------

def read_mesh(r):
    start = r.int()
    if start != ET_MESH_START:
        raise ValueError(f"expected ET_MESH_START, got {start} at {r.p}")
    num_verts = r.int()
    submesh_count = r.int()
    mesh = {'verts': None, 'normals': None, 'uvs': None, 'tris': []}
    while True:
        t = r.int()
        if t == ET_MESH_VERTS:
            mesh['verts'] = r.floats(3 * num_verts)
        elif t == ET_MESH_UV:
            mesh['uvs'] = r.floats(2 * num_verts)
        elif t == ET_MESH_UV2:
            r.floats(2 * num_verts)                       # discard
        elif t == ET_MESH_NORMALS:
            mesh['normals'] = r.floats(3 * num_verts)
        elif t == ET_MESH_TANGENTS:
            r.floats(4 * num_verts)                       # discard
        elif t == ET_MESH_BONE_WEIGHTS:
            # 4 bone indices + 4 weights per vertex (Unity MuBoneWeight). Kept so the
            # WebGL renderer can skin FX meshes (gimbal/shock bones) exactly in-game.
            bi = [0] * (4 * num_verts)
            bw = [0.0] * (4 * num_verts)
            for v in range(num_verts):
                for k in range(4):
                    bi[v * 4 + k] = r.int()
                    bw[v * 4 + k] = r.float()
            mesh['boneIndices'] = bi
            mesh['boneWeights'] = bw
        elif t == ET_MESH_BIND_POSES:
            n = r.int()
            # one 4x4 (column-major, 16 floats) inverse bind matrix per bone
            mesh['bindPoses'] = [r.floats(16) for _ in range(n)]
        elif t == ET_MESH_TRIANGLES:
            num_idx = r.int()                             # count of indices
            mesh['tris'].append(r.ints(num_idx))
        elif t == ET_MESH_VERTEX_COLORS:
            r._take(4 * num_verts)                        # RGBA bytes, discard
        elif t == ET_MESH_END:
            break
        else:
            raise ValueError(f"bad mesh sub-entry {t} at {r.p}")
    return mesh


# ---- material / textures ----------------------------------------------

def read_mattex(r):
    idx = r.int()
    r.vec2(); r.vec2()                                    # scale, offset (discard)
    return idx


def read_material(r, version):
    # 'color' is the material's _Color (diffuse tint), used by the viewer as the
    # albedo for texture-less materials instead of a flat gray guess (some KSP
    # shaders, e.g. Standard-imported or KSP/Unlit variants, carry no mainTex at
    # all and are meant to render via _Color alone).
    m = {'name': r.string(), 'shader': '', 'mainTex': -1, 'color': None}
    if version < 4:
        stype = r.int()
        m['shader'] = SHADER_NAMES.get(stype, 'KSP/Unknown')
        for kind, name in SHADER_PROPS.get(stype, []):
            if kind == 't':
                idx = read_mattex(r)
                if name == '_MainTex':
                    m['mainTex'] = idx
            elif kind == 'c':
                c = r.vec4()
                if name == '_Color':
                    m['color'] = c
            elif kind == 'f':
                r.float()
    else:
        m['shader'] = r.string()
        nprops = r.int()
        for _ in range(nprops):
            pname = r.string()
            ptype = r.int()
            if ptype == 0:        # color
                c = r.vec4()
                if pname == '_Color':
                    m['color'] = c
            elif ptype == 1:      # vector
                r.vec4()
            elif ptype == 2:      # float
                r.float()
            elif ptype == 3:      # float
                r.float()
            elif ptype == 4:      # texture (MuMatTex)
                idx = read_mattex(r)
                if pname == '_MainTex':
                    m['mainTex'] = idx
            else:
                raise ValueError(f"bad material prop type {ptype} at {r.p}")
    return m


def read_materials(r, version, out):
    n = r.int()
    for _ in range(n):
        out.append(read_material(r, version))


def read_textures(r, out):
    n = r.int()
    for _ in range(n):
        name = r.string()
        r.int()                                           # type (TT_TEXTURE/TT_NORMAL_MAP)
        out.append({'name': name})


# ---- renderers ---------------------------------------------------------

def read_renderer(r, version):
    if version > 0:
        r.byte(); r.byte()                                # castShadows, receiveShadows
    n = r.int()
    return r.ints(n)                                      # material indices


def read_skinned_mesh_renderer(r, version):
    n = r.int()
    mats = r.ints(n)
    r.vec3(); r.vec3()                                    # center, size
    r.int()                                               # quality
    r.byte()                                              # updateWhenOffscreen
    nbones = r.int()
    bones = [r.string() for _ in range(nbones)]           # bone transform names
    mesh = read_mesh(r)                                   # embedded mesh (bind pose)
    return mats, mesh, bones


# ---- collider / camera / light / animation (consumed, discarded) -------

def read_collider(r, et, version):
    v2 = et >= ET_MESH_COLLIDER2
    base = ((et - ET_MESH_COLLIDER2) if v2 else (et - ET_MESH_COLLIDER))
    if v2:
        r.byte()                                          # isTrigger
    if base == 0:        # mesh collider
        r.byte()                                          # convex
        read_mesh(r)
    elif base == 1:      # sphere
        r.float(); r.vec3()
    elif base == 2:      # capsule
        r.float(); r.float(); r.int(); r.vec3()
    elif base == 3:      # box
        r.vec3(); r.vec3()


def read_wheel_collider(r):
    r.float(); r.float(); r.float(); r.vec3()             # mass,radius,suspDist,center
    r.floats(3)                                           # suspension spring
    r.floats(5); r.floats(5)                              # forward / sideways friction


def read_camera(r):
    r.int(); r.vec4(); r.uint(); r.byte()
    r.float(); r.float(); r.float(); r.float()


def read_light(r, version):
    r.int(); r.float(); r.float(); r.vec4(); r.uint()
    if version > 1:
        r.float()                                         # spotAngle


def read_animation(r):
    # Captures clip data (not just discarding) so the viewer can pose deployable
    # parts (extending nozzles etc) at their animation end-state. Per curve we only
    # keep the target path (relative to the GameObject the Animation component is
    # on), the animated property, and the first/last keyframe VALUES (start/end
    # pose) - tangents and intermediate keys aren't needed to reproduce a static
    # pose. Stream alignment is unchanged: every byte is still read in the same
    # order, we just also stash a couple of the floats we already read.
    clips = []
    nclips = r.int()
    for _ in range(nclips):
        clip_name = r.string()                            # clip name
        r.vec3(); r.vec3()                                # lbCenter, lbSize
        r.int()                                           # wrapMode
        ncurves = r.int()
        curves = []
        for _ in range(ncurves):
            path = r.string(); prop = r.string()          # path, property
            r.int()                                       # type
            r.int(); r.int()                              # pre/post wrap
            nkeys = r.int()
            start_val = end_val = None
            for i in range(nkeys):
                t = r.float(); v = r.float(); r.float(); r.float(); r.int()
                if i == 0:
                    start_val = v
                end_val = v
            if nkeys > 0:
                curves.append({'path': path, 'property': prop,
                                'startValue': start_val, 'endValue': end_val})
        if curves:
            clips.append({'name': clip_name, 'curves': curves})
    r.string()                                            # current clip
    r.byte()                                              # autoPlay
    return clips


def read_particles(r):
    # MuParticles (legacy Unity ParticleEmitter/Animator/Renderer snapshot). Fixed
    # layout — consumed exactly (see taniwha io_object_mu mu.py MuParticles.read) so
    # the stream stays aligned. Data is discarded; FX plumes are mesh-based.
    r.byte()                                              # emit
    r.int()                                               # shape
    r.vec3()                                              # shape3d
    r.floats(2)                                           # shape2d
    r.float()                                             # shape1d
    r.floats(4)                                           # color
    r.byte()                                              # useWorldSpace
    r.floats(2)                                           # size (min,max)
    r.floats(2)                                           # energy (min,max)
    r.ints(2)                                             # emission (min,max)
    r.vec3(); r.vec3(); r.vec3()                          # world/local/rnd velocity
    r.float()                                             # emitterVelocityScale
    r.float()                                             # angularVelocity
    r.float()                                             # rndAngularVelocity
    r.byte()                                              # rndRotation
    r.byte()                                              # doesAnimateColor
    r.floats(20)                                          # colorAnimation (5 x RGBA)
    r.vec3(); r.vec3()                                    # world/local rotationAxis
    r.float()                                             # sizeGrow
    r.vec3(); r.vec3()                                    # rndForce, force
    r.float()                                             # damping
    r.byte(); r.byte()                                    # cast/receive shadows
    r.float()                                             # lengthScale
    r.float()                                             # velocityScale
    r.float()                                             # maxParticleSize
    r.int()                                               # particleRenderMode
    r.ints(3)                                             # uvAnimation
    r.int()                                               # count


# ---- object tree -------------------------------------------------------

def read_object(r, version, textures, materials, is_root=False):
    obj = {
        'name': r.string(),
        'pos': r.vec3(),
        'rotQuat': r.vec4(),      # x,y,z,w
        'scale': r.vec3(),
        'children': [],
    }
    obj['mesh'] = None
    obj['rendererMaterials'] = None
    while True:
        if is_root and r.p >= len(r.d):
            break                                         # root object ends at EOF
        et = r.int()
        if et == ET_CHILD_TRANSFORM_START:
            obj['children'].append(read_object(r, version, textures, materials))
        elif et == ET_CHILD_TRANSFORM_END:
            break
        elif et == ET_ANIMATION:
            clips = read_animation(r)
            if clips:
                obj.setdefault('animations', []).extend(clips)
        elif et in (ET_MESH_COLLIDER, ET_SPHERE_COLLIDER, ET_CAPSULE_COLLIDER,
                    ET_BOX_COLLIDER, ET_MESH_COLLIDER2, ET_SPHERE_COLLIDER2,
                    ET_CAPSULE_COLLIDER2, ET_BOX_COLLIDER2):
            read_collider(r, et, version)
        elif et == ET_WHEEL_COLLIDER:
            read_wheel_collider(r)
        elif et == ET_MESH_FILTER:
            obj['mesh'] = read_mesh(r)
        elif et == ET_MESH_RENDERER:
            obj['rendererMaterials'] = read_renderer(r, version)
        elif et == ET_SKINNED_MESH_RENDERER:
            mats, smesh, bones = read_skinned_mesh_renderer(r, version)
            obj['rendererMaterials'] = mats
            # Skinned meshes (gimballing nozzles, Waterfall shock/plume bones) carry
            # their geometry embedded in the renderer, not in a MeshFilter. Keep the
            # bone name list so the renderer can compute per-bone matrices from the
            # node hierarchy and skin the mesh exactly as in-game.
            obj['bones'] = bones
            if obj['mesh'] is None and smesh and smesh.get('verts'):
                obj['mesh'] = smesh
                obj['skinned'] = True
        elif et == ET_MATERIALS:
            read_materials(r, version, materials)
        elif et == ET_MATERIAL:
            materials.append(read_material(r, version))
        elif et == ET_TEXTURES:
            read_textures(r, textures)
        elif et == ET_TAG_AND_LAYER:
            r.string(); r.int()
        elif et == ET_LIGHT:
            read_light(r, version)
        elif et == ET_CAMERA:
            read_camera(r)
        elif et == ET_PARTICLES:
            read_particles(r)
        else:
            raise ValueError(f"unknown entry type {et} at offset {r.p}")
    # Unity does not draw a MeshFilter that has no MeshRenderer — such nodes are
    # collider/reference geometry (low-poly white cones, black hulls). Drop their
    # mesh so the viewer never renders them. (Skinned meshes always set
    # rendererMaterials via ET_SKINNED_MESH_RENDERER, so they are unaffected.)
    if obj['mesh'] is not None and obj['rendererMaterials'] is None:
        obj['mesh'] = None
    return obj


def parse_bytes(data):
    r = Reader(data)
    magic = r.int()
    if magic != MODEL_BINARY:
        raise ValueError(f"bad magic {magic} (expected {MODEL_BINARY})")
    version = r.int()
    if version < 0 or version > FILE_VERSION:
        raise ValueError(f"unsupported version {version}")
    name = r.string()
    textures = []
    materials = []
    tree = read_object(r, version, textures, materials, is_root=True)
    return {
        'name': name, 'version': version,
        'tree': tree, 'materials': materials, 'textures': textures,
    }


def parse_file(path):
    with open(path, 'rb') as f:
        return parse_bytes(f.read())


# ---- CLI / summary -----------------------------------------------------

def _summary(res):
    objs = [0]
    verts = [0]
    submeshes = [0]
    names = []

    def walk(o):
        objs[0] += 1
        names.append(o['name'])
        if o.get('mesh') and o['mesh'].get('verts'):
            verts[0] += len(o['mesh']['verts']) // 3
            submeshes[0] += len(o['mesh']['tris'])
        for c in o['children']:
            walk(c)
    walk(res['tree'])
    return objs[0], verts[0], submeshes[0], names


def main():
    if len(sys.argv) < 2:
        print("usage: muparse.py <file.mu> [--json]")
        return 2
    path = sys.argv[1]
    res = parse_file(path)
    if '--json' in sys.argv:
        print(json.dumps(res))
        return 0
    n_obj, n_vert, n_sub, names = _summary(res)
    print(f"file:      {os.path.basename(path)}")
    print(f"model:     {res['name']}  (format version {res['version']})")
    print(f"objects:   {n_obj}")
    print(f"vertices:  {n_vert}  across {n_sub} submeshes")
    print(f"materials: {len(res['materials'])}  -> "
          + ", ".join(m['name'] for m in res['materials'][:8]))
    print(f"textures:  {len(res['textures'])}  -> "
          + ", ".join(t['name'] for t in res['textures']))
    print("transforms:")
    for nm in names[:40]:
        print("   " + nm)
    if len(names) > 40:
        print(f"   ... (+{len(names) - 40} more)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
