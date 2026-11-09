// Convert i7 URDF STL meshes into one compact JSON (welded + simplified) for the web viewer.
// npm install meshoptimizer@0.21 && node convert_meshes.mjs ../../../vendor/robot_model/urdf_v1.5_0416/meshes i7_mesh.json
import fs from 'fs';
import path from 'path';
import { MeshoptSimplifier } from 'meshoptimizer';

const MESH_DIR = process.argv[2];
const OUT = process.argv[3];
await MeshoptSimplifier.ready;

function readSTL(file) {
  const d = fs.readFileSync(file);
  const n = d.readUInt32LE(80);
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) pos[i * 9 + k] = d.readFloatLE(o + k * 4);
  }
  return pos;
}

function weld(pos, eps = 1e-5) {
  const map = new Map();
  const verts = [];
  const idx = new Uint32Array(pos.length / 3);
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const key = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    let v = map.get(key);
    if (v === undefined) { v = verts.length / 3; verts.push(x, y, z); map.set(key, v); }
    idx[i] = v;
  }
  return { verts: new Float32Array(verts), idx };
}

const targets = { base_link: 60000 };
const out = {};
let totalTris = 0;
for (const f of fs.readdirSync(MESH_DIR).filter(f => f.endsWith('.STL')).sort()) {
  const name = path.basename(f, '.STL');
  const { verts, idx } = weld(readSTL(path.join(MESH_DIR, f)));
  const tris = idx.length / 3;
  const want = targets[name] ?? Math.min(tris, name.startsWith('Gripper') || name.startsWith('falan') ? 9000 : 5000);
  let indices = idx;
  if (want < tris) {
    const [res] = MeshoptSimplifier.simplify(idx, verts, 3, want * 3, 1e-3, ['LockBorder']);
    indices = res;
  }
  // compact vertex buffer
  const remap = new Map(); const nv = []; const ni = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    let r = remap.get(indices[i]);
    if (r === undefined) { r = nv.length / 3; remap.set(indices[i], r); nv.push(verts[indices[i] * 3], verts[indices[i] * 3 + 1], verts[indices[i] * 3 + 2]); }
    ni[i] = r;
  }
  const P = new Float32Array(nv);
  const I = nv.length / 3 < 65536 ? new Uint16Array(ni) : ni;
  out[name] = { p: Buffer.from(P.buffer).toString('base64'), i: Buffer.from(I.buffer).toString('base64'), i32: I instanceof Uint32Array };
  totalTris += ni.length / 3;
  console.log(name, tris, '->', ni.length / 3);
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('total tris', totalTris, 'bytes', fs.statSync(OUT).size);
