// i7 navigation + fetch-water demo: a deterministic 3D scene built from the vendor URDF (V1.5).
// Everything on screen is a pure function of the timeline time t (seconds), so the same module
// drives the rendered film (film.html, frame by frame) and the interactive viewer on the site.
// World frame: Z up, metres, origin at the centre of the lab floor (same convention as the URDF).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// the offline copy of the site (offline/build_offline.py) ships its data files as scripts that fill this global,
// because browsers block fetch() on pages opened straight from disk
const offlineFile = (url) => globalThis.I7_OFFLINE && globalThis.I7_OFFLINE[url];

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

// ---------------------------------------------------------------- URDF (URDF_V1.5_0416_open.urdf)
const ARM = (side) => {
  const s = side === 'Right' ? -1 : 1;
  return [
    [`Shoulder_Pitch_${side}`, 'Shoulder_Base', 'revolute', [-0.0002, s * 0.1195, 0], [0, 1, 0], -3.14, 3.14],
    [`Shoulder_Roll_${side}`, `Shoulder_Pitch_${side}`, 'revolute', [0, s * 0.114, 0], [1, 0, 0],
      side === 'Right' ? -3.8377 : -0.6977, side === 'Right' ? 0.6977 : 3.8377],
    [`Elbow_Yaw_${side}`, `Shoulder_Roll_${side}`, 'revolute', [0, 0, -0.195], [0, 0, 1], -3.14, 3.14],
    [`Elbow_Pitch_${side}`, `Elbow_Yaw_${side}`, 'revolute', [0, 0, -0.155], [0, 1, 0], -2.4248, 2.4248],
    [`Wrist_Yaw_${side}`, `Elbow_Pitch_${side}`, 'revolute', [0, 0, -0.1635], [0, 0, 1], -3.14, 3.14],
    [`Wrist_Roll_${side}`, `Wrist_Yaw_${side}`, 'revolute', [0, 0, -0.1865], [1, 0, 0], -1.0467, 1.0467],
    [`Wrist_Pitch_${side}`, `Wrist_Roll_${side}`, 'revolute', [0, 0, 0], [0, 1, 0], -1.6572, 1.8317],
    [`falan_${side}`, `Wrist_Pitch_${side}`, 'fixed', [0, 0, -0.08875]],
    [`Gripper_${side}`, `falan_${side}`, 'fixed', [0, 0, -0.19665]],
  ];
};
const JOINTS = [
  ['Shoulder_Base', 'base_link', 'prismatic', [0, 0, 1.36535], [0, 0, 1], -1, 0],
  ...ARM('Right'), ...ARM('Left'),
];
const ARM_JOINTS = (side) => ARM(side).filter(j => j[2] === 'revolute').map(j => j[0]);
const BASE_TO_CENTER = 0.26; // base_link origin sits at the front of the chassis; turning centre is behind it

// ---------------------------------------------------------------- small maths helpers
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => { k = clamp(k); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
const ramp = (t, t0, t1) => ease((t - t0) / (t1 - t0));
const lin = (t, t0, t1) => clamp((t - t0) / (t1 - t0));
const win = (t, a, b, f = 0.35) => Math.min(lin(t, a, a + f), 1 - lin(t, b - f, b)); // fade in/out window
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpAngle = (a, b, k) => a + wrap(b - a) * k;
const V2 = (x, y) => ({ x, y });
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ---------------------------------------------------------------- timeline
// Demo flow: map, localise, take the command, find the drawer table with the water bottle by vision, navigate
// to it, square up to it with the depth camera, grasp with the VLA, bring the bottle back and hand it over.
export const CHAPTERS = [
  { id: 'intro', t0: 0, t1: 4, step: null },
  { id: 'map', t0: 4, t1: 12, step: '建图', title: '扫一圈，实验室就成了地图', sub: '手柄遥控低速行驶，激光雷达实时建图（画面已加速）' },
  { id: 'loc', t0: 12, t1: 14.5, step: '定位', title: '知道自己在哪，才能去任何地方', sub: '加载地图启动定位，状态为 Localized 后再下发导航目标' },
  { id: 'cmd', t0: 14.5, t1: 19, step: '接令', title: '“i7，帮我拿杯水”', sub: '唤醒并识别指令，记下当前位置作为返回点' },
  { id: 'find', t0: 19, t1: 24.5, step: '识别', title: '环顾一圈，找到放水的桌子', sub: '头部相机检测抽屉桌和桌上的水瓶，在桌前取一个点作为导航目标' },
  { id: 'nav', t0: 24.5, t1: 31, step: '导航', title: '规划路径，走到抽屉桌前', sub: 'Nav2 规划路径，导航到桌前的目标点（画面已加速）' },
  { id: 'align', t0: 31, t1: 36.5, step: '对正', title: '用深度相机，正对桌子', sub: '深度相机拟合桌子前侧平面，原地转正后前移到抓取距离' },
  { id: 'grasp', t0: 36.5, t1: 45.5, step: '抓取', title: '看着画面，直接给出手臂动作', sub: 'VLA 模型（π0.5）读取头部与腕部相机，输出右臂和夹爪动作' },
  { id: 'ret', t0: 45.5, t1: 53.5, step: '返回', title: '带着水，回到接令的位置', sub: '导航回到记录的返回点，朝向接令的人' },
  { id: 'hand', t0: 53.5, t1: 61.5, step: '递交', title: '感觉到你在拉，才会松手', sub: '伸出手臂等待，关节力矩超过阈值后松开夹爪' },
  { id: 'end', t0: 61.5, t1: 65.5, step: null },
];
export const DURATION = 65.5;
// the grasp, return and hand-over keep their original choreography, D seconds later than in the first cut
const D = 8.5;
const CARD = {
  intro: ['至简动力 i7 · 实验室 Demo', '导航取水', '识别、导航、对正、抓取、递交，一次走完'],
  end: ['i7 导航取水 Demo', '一句话，把水递到你手里。', '视觉找桌 · 深度相机对正 · VLA 抓取'],
};
const SAY = { cmd: 'i7，帮我拿杯水', ok: '好的，马上去拿。', give: '水来了，请拿好。', thanks: '谢谢！' };
// spoken lines (video/make_voice.py, placed by video/voice/voice.json): start time and a 30 fps loudness envelope,
// for lip sync and the robot's light band
const VOICE = {
  cmd: { t0: 15.55, env: '289831136740069986556887545667723897511296531000' },
  ok: { t0: 17.45, env: '017999348974236643331115544311134554323332000' },
  give: { t0: 46.45 + D, env: '0013998777666679951111354443323421112443443000' },
  thanks: { t0: 50.95 + D, env: '111399863114653100' },
};
const voiceLevel = (t, ...keys) => {
  for (const k of keys) {
    const v = VOICE[k], f = (t - v.t0) * 30, i = Math.floor(f);
    if (i >= 0 && i < v.env.length - 1) return lerp(+v.env[i], +v.env[i + 1], f - i) / 9;
  }
  return 0;
};
const TAU_TEXT = ['等待接水…', '检测到拉力，力矩上升', '超过阈值 → 松开夹爪'];
// every string the overlay can show, so pages can preload the web-font subsets before rendering frames
const ALIGN_TEXT = ['已拟合桌子前侧平面', '转正、前移中…', '已正对，可以抓取'];
const PIP_TEXT = { find: '头部相机 · 目标检测', depth: '深度相机 · 深度图', vla: '头部相机 · VLA 输入' };
export const UI_TEXT = [...Object.values(CARD).flat(), ...Object.values(SAY), ...TAU_TEXT, ...ALIGN_TEXT, ...Object.values(PIP_TEXT),
  '夹紧松开返回点定位正常 · Localized腕部关节力矩偏差仿真示意 · 非实机画面抽屉桌 · 有水瓶办公桌水瓶导航目标目标位姿拟合平面深度相机 · 对正偏角距离目标0123456789.°m',
  ...CHAPTERS.flatMap(c => [c.step, c.title, c.sub].filter(Boolean))].join('');

// ---------------------------------------------------------------- lab layout (map frame)
// The real lab (floor plan from the team, 2026-11): 9.0 m x 6.9 m. Two rows of five 1.4 m x 1.0 m office desks
// along the north and south walls (7.0 m each, centred), a 1.0 m x 4.0 m storage area against the west and the
// east wall, the door at the south end of the west wall, and the 45 x 40 x 62 cm drawer table with the water
// bottle near the middle of the room (position read off the plan).
const ROOM = { x0: -4.5, x1: 4.5, y0: -3.45, y1: 3.45, wall: 0.08, wallH: 1.0 };
const DESK = { w: 1.4, d: 1.0, h: 0.75, x0: -3.5, n: 5 };
const DESK_ROWS = [{ y0: ROOM.y1 - DESK.d, y1: ROOM.y1, front: -1 }, { y0: ROOM.y0, y1: ROOM.y0 + DESK.d, front: 1 }];   // front: the side people sit on (y direction)
const STORE = [{ x0: ROOM.x0, x1: ROOM.x0 + 1.0, y0: -2.0, y1: 2.0, wall: -1 }, { x0: ROOM.x1 - 1.0, x1: ROOM.x1, y0: -2.0, y1: 2.0, wall: 1 }];
const DOOR = { y0: -3.35, y1: -2.45 };                    // in the west wall
const TABLE = { x0: 0.475, x1: 0.925, y0: 0.0, y1: 0.4, h: 0.62 };   // drawer table: 45 cm (x) by 40 cm (y), 62 cm high
const TABLE_C = { x: (TABLE.x0 + TABLE.x1) / 2, y: (TABLE.y0 + TABLE.y1) / 2 };
const BOTTLE = { x: TABLE_C.x - 0.04, y: TABLE_C.y, h: 0.215, r: 0.033 };
const PERSON_H = 1.75, PERSON_SCALE = PERSON_H / 1.82;   // the avatar is 1.82 m tall as modelled
const SEATED = { back: 0.4, drop: 0.31 };                // hips behind and below the feet when seated (model units)
// the person works at the second desk from the west in the north row, facing the wall (+y), then swivels to
// face east and stands up; the robot takes the command standing east of them, facing west
const WORK_YAW = Math.PI / 2;
const CHAIR = { x: DESK.x0 + DESK.w * 1.5, y: DESK_ROWS[0].y0 - 0.355 };
const PERSON = { x: CHAIR.x + SEATED.back * PERSON_SCALE, y: CHAIR.y };   // where standing up from the chair lands
const START = { x: PERSON.x + 1.13, y: PERSON.y, yaw: Math.PI };         // chassis centre where the command is given
const AT_TABLE = { x: BOTTLE.x - 0.43 - BASE_TO_CENTER, y: BOTTLE.y + 0.25 };   // chassis centre for the grasp, facing +x
const NAV_END = { x: AT_TABLE.x - 0.4, y: AT_TABLE.y };  // navigation goal in front of the table; the depth camera does the rest
const YAW_SEEN = Math.atan2(TABLE_C.y - START.y, TABLE_C.x - START.x);   // heading when the head camera has the table centred
const SOLIDS = [                                         // seen by the lidar as solid footprints
  ...STORE.map(({ x0, x1, y0, y1 }) => ({ x0, x1, y0, y1 })),
  { ...TABLE },                                          // the drawer table is a closed cabinet
];
const LEGS = [];                                         // desks: the 2D lidar only sees their legs
const legRect = (x0, x1, y0, y1) => { const d = 0.04; for (const [x, y] of [[x0 + d, y0 + d], [x1 - d, y0 + d], [x0 + d, y1 - d], [x1 - d, y1 - d]]) LEGS.push({ x0: x - 0.025, x1: x + 0.025, y0: y - 0.025, y1: y + 0.025 }); };
for (const r of DESK_ROWS) for (let i = 0; i < DESK.n; i++) legRect(DESK.x0 + i * DESK.w, DESK.x0 + (i + 1) * DESK.w, r.y0, r.y1);

const MAP_PATH = [[START.x, START.y], [-0.7, 1.5], [-2.0, 1.2], [-2.8, 0.5], [-2.8, -0.9], [-1.8, -1.5], [1.6, -1.5], [2.8, -0.9], [2.8, 0.5], [2.0, 1.3], [0.9, 1.75], [START.x, START.y]];
const NAV_PATH = [[START.x, START.y], [-0.35, 1.5], [-0.9, 0.8], [-0.78, 0.38], [NAV_END.x, NAV_END.y]];
const BACKUP = 0.25;
const RET_PATH = [[AT_TABLE.x - BACKUP, AT_TABLE.y], [0.2, 1.0], [0.95, 1.6], [0.75, 2.05], [START.x, START.y]];
const curve2 = (pts) => new THREE.CatmullRomCurve3(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)), false, 'centripetal');

// ---------------------------------------------------------------- materials
function materials() {
  return {
    // robot finish, matched to the product photos: pearl-white covers, grey joint rings, a blue band on each
    // forearm, black linkage grippers, a silver head with a light band, dark chassis skirt (see paint_mesh.py)
    robot: {
      shell: new THREE.MeshPhysicalMaterial({ color: 0xd8dbe0, roughness: 0.3, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.18 }),
      joint: new THREE.MeshPhysicalMaterial({ color: 0xb4b9c0, roughness: 0.38, clearcoat: 0.4 }),
      graphite: new THREE.MeshStandardMaterial({ color: 0x2d2f34, roughness: 0.55, metalness: 0.15 }),
      black: new THREE.MeshPhysicalMaterial({ color: 0x101114, roughness: 0.24, metalness: 0.1, clearcoat: 0.9 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.9 }),
      blue: new THREE.MeshStandardMaterial({ color: 0x1f6fe6, roughness: 0.22, metalness: 0.75 }),
      silver: new THREE.MeshStandardMaterial({ color: 0xb4b8bf, roughness: 0.3, metalness: 0.65 }),
      camera: new THREE.MeshStandardMaterial({ color: 0x6f737b, roughness: 0.35, metalness: 0.6 }),
      led: new THREE.MeshStandardMaterial({ color: 0x4fd2ff, emissive: 0x12b4ff, emissiveIntensity: 1.2, roughness: 0.4 }),
      red: new THREE.MeshStandardMaterial({ color: 0xd8262b, roughness: 0.35 }),
      get lidar() { return this.black; },                 // the lidar domes on the deck corners, a group of their own
    },
    floor: new THREE.MeshStandardMaterial({ color: 0xfafafc, roughness: 0.92 }),
    ground: new THREE.MeshStandardMaterial({ color: 0xe9e9ee, roughness: 1 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xeceef2, roughness: 0.85 }),
    cabinet: new THREE.MeshStandardMaterial({ color: 0xe9eaee, roughness: 0.7 }),
    benchTop: new THREE.MeshStandardMaterial({ color: 0x3a3b40, roughness: 0.55 }),
    wood: new THREE.MeshStandardMaterial({ color: 0xd8cdbb, roughness: 0.6 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x8e9098, roughness: 0.35, metalness: 0.7 }),
    screen: new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.25, metalness: 0.3 }),
    box1: new THREE.MeshStandardMaterial({ color: 0xc9d3e3, roughness: 0.8 }),
    box2: new THREE.MeshStandardMaterial({ color: 0xe5dccd, roughness: 0.8 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xe8f4ff, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.38, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false }),
    water: new THREE.MeshStandardMaterial({ color: 0x9fd1ff, roughness: 0.15, transparent: true, opacity: 0.35, depthWrite: false }),
    cap: new THREE.MeshStandardMaterial({ color: 0x0a6cdf, roughness: 0.35 }),
    label: new THREE.MeshStandardMaterial({ color: 0x0a6cdf, roughness: 0.5 }),
    accent: new THREE.MeshBasicMaterial({ color: 0x0a6cdf }),
    accentSoft: new THREE.MeshBasicMaterial({ color: 0x0a6cdf, transparent: true, opacity: 0.25, depthWrite: false }),
    path: new THREE.MeshBasicMaterial({ color: 0x0a6cdf, transparent: true, opacity: 0.9 }),
  };
}

const box = (w, d, h, mat, x, y, z, cast = true) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
  m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; return m;
};
const cyl = (r, h, mat, x, y, z, seg = 32) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  m.rotation.x = Math.PI / 2; m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m;
};

// static meshes that share a material are merged into one draw call each (software rendering is draw-call bound)
function mergeStatic(g) {
  const buckets = new Map();
  for (const m of [...g.children]) {
    if (!m.isMesh || Array.isArray(m.material) || m.material.transparent || m.userData.keep) continue;
    const key = `${m.material.uuid}:${m.castShadow}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const geos = list.map(m => { m.updateMatrix(); const c = m.geometry.clone().applyMatrix4(m.matrix); for (const k of Object.keys(c.attributes)) if (!['position', 'normal', 'uv'].includes(k)) c.deleteAttribute(k); return c; });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mm = new THREE.Mesh(merged, list[0].material); mm.castShadow = list[0].castShadow; mm.receiveShadow = true;
    list.forEach(m => g.remove(m)); g.add(mm);
  }
  return g;
}

function buildLab(M) {
  const g = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), M.ground);
  ground.position.z = -0.045; ground.receiveShadow = true; ground.userData.keep = true; g.add(ground);
  const W = ROOM.x1 - ROOM.x0, RD = ROOM.y1 - ROOM.y0;
  const grid = document.createElement('canvas'); grid.width = grid.height = 256;
  const gc = grid.getContext('2d'); gc.fillStyle = '#f2f3f6'; gc.fillRect(0, 0, 256, 256);
  gc.strokeStyle = '#dcdee5'; gc.lineWidth = 3; gc.strokeRect(0, 0, 256, 256);
  const gt = new THREE.CanvasTexture(grid); gt.wrapS = gt.wrapT = THREE.RepeatWrapping; gt.repeat.set(W / 0.5, RD / 0.5);
  gt.colorSpace = THREE.SRGBColorSpace; gt.anisotropy = 8;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, RD), new THREE.MeshStandardMaterial({ map: gt, roughness: 0.92 }));
  floor.receiveShadow = true; floor.userData.keep = true; g.add(floor);
  g.add(box(W + 0.16, RD + 0.16, 0.04, M.floor, 0, 0, -0.0205, false));
  // walls: full height (cut at 1 m) on the north and west, low on the camera sides
  const t = ROOM.wall, h = ROOM.wallH;
  g.add(box(W + 0.16, t, h, M.wall, 0, ROOM.y1 + t / 2, h / 2));
  const wy0 = ROOM.y0 - t, wy1 = ROOM.y1 + t;                      // west wall, with the door opening near the south end
  g.add(box(t, DOOR.y0 - wy0, h, M.wall, ROOM.x0 - t / 2, (wy0 + DOOR.y0) / 2, h / 2));
  g.add(box(t, wy1 - DOOR.y1, h, M.wall, ROOM.x0 - t / 2, (DOOR.y1 + wy1) / 2, h / 2));
  g.add(box(t, RD + 0.16, h * 0.35, M.wall, ROOM.x1 + t / 2, 0, h * 0.175));
  g.add(box(W + 0.16, t, h * 0.35, M.wall, 0, ROOM.y0 - t / 2, h * 0.175));

  const deskTop = new THREE.MeshStandardMaterial({ color: 0xe7dcc8, roughness: 0.55 });
  const frame = new THREE.MeshStandardMaterial({ color: 0xc4c7ce, roughness: 0.4, metalness: 0.5 });
  const paper = new THREE.MeshStandardMaterial({ color: 0xf7f7f5, roughness: 0.9 });
  const doorMat = new THREE.MeshStandardMaterial({ color: 0xc8b496, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a3c42, roughness: 0.6 });

  // door: frame, closed leaf and handle, in the opening of the west wall
  const dc = (DOOR.y0 + DOOR.y1) / 2, dw = DOOR.y1 - DOOR.y0;
  g.add(box(t + 0.04, 0.06, h, frame, ROOM.x0 - t / 2, DOOR.y0 + 0.03, h / 2));
  g.add(box(t + 0.04, 0.06, h, frame, ROOM.x0 - t / 2, DOOR.y1 - 0.03, h / 2));
  g.add(box(0.045, dw - 0.12, h - 0.01, doorMat, ROOM.x0 - t / 2, dc, (h - 0.01) / 2));
  g.add(box(0.05, 0.12, 0.025, M.metal, ROOM.x0 + 0.01, DOOR.y1 - 0.14, 0.9));
  g.add(box(0.6, dw, 0.006, dark, ROOM.x0 + 0.32, dc, 0.003, false));   // door mat

  // two rows of five office desks: top, slim legs, back panel, monitors, keyboard and a few desk things
  const r = rng(5);
  DESK_ROWS.forEach((row, ri) => {
    const fy = row.front === -1 ? row.y0 : row.y1, inw = -row.front;   // front edge, and the direction into the desk
    const yIn = (d) => fy + inw * d;                                    // y at depth d behind the front edge
    for (let i = 0; i < DESK.n; i++) {
      const x0 = DESK.x0 + i * DESK.w, cx = x0 + DESK.w / 2;
      g.add(box(DESK.w - 0.006, DESK.d, 0.03, deskTop, cx, (row.y0 + row.y1) / 2, DESK.h - 0.015));
      for (const lx of [x0 + 0.05, x0 + DESK.w - 0.05]) for (const d of [0.06, DESK.d - 0.06]) g.add(box(0.04, 0.04, DESK.h - 0.03, frame, lx, yIn(d), (DESK.h - 0.03) / 2));
      g.add(box(DESK.w - 0.14, 0.015, 0.36, frame, cx, yIn(DESK.d - 0.07), 0.52));
      const own = ri === 0 && i === 1;                                  // the person's desk
      const mx = own ? CHAIR.x : cx + (r() - 0.5) * 0.3, two = !own && r() < 0.35;
      for (const ox of two ? [-0.3, 0.3] : [0]) {
        g.add(box(0.56, 0.025, 0.33, M.screen, mx + ox, yIn(0.62), DESK.h + 0.25));
        g.add(box(0.04, 0.04, 0.1, M.metal, mx + ox, yIn(0.65), DESK.h + 0.05));
        g.add(box(0.22, 0.16, 0.012, M.metal, mx + ox, yIn(0.65), DESK.h + 0.006));
      }
      g.add(box(0.44, 0.14, 0.018, M.screen, mx, yIn(0.15), DESK.h + 0.009));      // keyboard
      g.add(box(0.06, 0.1, 0.03, M.screen, mx + 0.33, yIn(0.18), DESK.h + 0.015));  // mouse
      if (r() < 0.6) g.add(box(0.24, 0.32, 0.03 + r() * 0.04, paper, x0 + 0.2 + r() * 0.1, yIn(0.35), DESK.h + 0.03));
      if (r() < 0.5) g.add(cyl(0.04, 0.1, i % 2 ? M.box1 : M.cap, x0 + DESK.w - 0.2, yIn(0.25 + r() * 0.2), DESK.h + 0.05, 20));
      if (r() < 0.4) g.add(box(0.3, 0.24, 0.2, i % 2 ? M.box2 : M.box1, x0 + DESK.w - 0.25, yIn(0.75), DESK.h + 0.1));
    }
  });

  // storage areas against the west and east walls: shelving racks with boxes, crates and a case on the floor in front
  for (const st of STORE) {
    const len = st.y1 - st.y0, wallX = st.wall < 0 ? st.x0 : st.x1, inX = -st.wall;
    g.add(box(st.x1 - st.x0, len, 0.004, M.ground, (st.x0 + st.x1) / 2, (st.y0 + st.y1) / 2, 0.002, false));
    const rx = wallX + inX * 0.27;                                      // rack centre line, 0.5 m deep against the wall
    for (const yc of [st.y0 + len / 4, st.y0 + 3 * len / 4]) {
      const rl = len / 2 - 0.06;
      for (const dx of [-0.23, 0.23]) for (const dy of [-rl / 2 + 0.02, rl / 2 - 0.02]) g.add(box(0.03, 0.03, 1.6, dark, rx + dx, yc + dy, 0.8));
      for (const z of [0.1, 0.58, 1.06, 1.54]) g.add(box(0.5, rl, 0.025, frame, rx, yc, z));
      for (const z of [0.1, 0.58, 1.06]) {
        let y = yc - rl / 2 + 0.05;
        while (y < yc + rl / 2 - 0.3) {
          const bw = 0.25 + r() * 0.3, bh = 0.18 + r() * 0.24;
          if (r() < 0.8) g.add(box(0.38, bw, bh, r() < 0.5 ? M.box2 : M.box1, rx + (r() - 0.5) * 0.06, y + bw / 2, z + 0.0125 + bh / 2));
          y += bw + 0.04 + r() * 0.1;
        }
      }
    }
    const fx = wallX + inX * 0.76;                                      // floor zone in front of the racks
    let y = st.y0 + 0.15;
    while (y < st.y1 - 0.4) {
      const bw = 0.35 + r() * 0.3, n = 1 + Math.floor(r() * 3);
      if (r() < 0.75) for (let k = 0; k < n; k++) g.add(box(0.38, bw, 0.3, k % 2 ? M.box1 : M.box2, fx + (r() - 0.5) * 0.06, y + bw / 2, 0.15 + k * 0.3));
      else g.add(box(0.4, bw + 0.2, 0.42, dark, fx, y + bw / 2 + 0.1, 0.21));   // equipment case
      y += bw + 0.2 + r() * 0.35;
    }
  }

  // the drawer table: wooden top, white body with three drawers facing west (towards the room), small handles
  const dt = TABLE, tw = dt.x1 - dt.x0, tdp = dt.y1 - dt.y0;
  const body = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.5 });
  const top = box(tw + 0.01, tdp + 0.01, 0.025, M.wood, TABLE_C.x, TABLE_C.y, dt.h - 0.0125); top.userData.keep = true; g.add(top);
  const carcass = box(tw, tdp, dt.h - 0.075, body, TABLE_C.x, TABLE_C.y, 0.05 + (dt.h - 0.075) / 2); carcass.userData.keep = true; g.add(carcass);
  const plinth = box(tw - 0.03, tdp - 0.03, 0.05, dark, TABLE_C.x, TABLE_C.y, 0.025); plinth.userData.keep = true; g.add(plinth);
  const fh = (dt.h - 0.1) / 3;
  for (let k = 0; k < 3; k++) {
    const z = 0.06 + fh * (k + 0.5);
    const front = box(0.012, tdp - 0.03, fh - 0.012, body, dt.x0 - 0.006, TABLE_C.y, z); front.userData.keep = true; g.add(front);
    const pull = box(0.02, 0.12, 0.014, M.metal, dt.x0 - 0.018, TABLE_C.y, z + fh * 0.22); pull.userData.keep = true; g.add(pull);
  }
  return mergeStatic(g);
}

// office chair at the person's desk; `top` (seat and backrest) swivels with the person
function buildChair(M) {
  const root = new THREE.Group(), top = new THREE.Group();
  const fabric = new THREE.MeshStandardMaterial({ color: 0x2c2e34, roughness: 0.85 });
  const plastic = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.45 });
  root.position.set(CHAIR.x, CHAIR.y, 0);
  for (let i = 0; i < 5; i++) {
    const a = i * Math.PI * 2 / 5 + 0.3, leg = box(0.3, 0.045, 0.035, plastic, Math.cos(a) * 0.15, Math.sin(a) * 0.15, 0.075);
    leg.rotation.z = a; root.add(leg);
    root.add(cyl(0.025, 0.04, plastic, Math.cos(a) * 0.29, Math.sin(a) * 0.29, 0.03, 12));
  }
  root.add(cyl(0.045, 0.1, plastic, 0, 0, 0.1, 20));
  root.add(cyl(0.022, 0.26, M.metal, 0, 0, 0.27, 16));
  top.add(box(0.48, 0.48, 0.07, fabric, 0.04, 0, 0.435));                      // seat, x = the way the sitter faces
  top.add(box(0.06, 0.06, 0.34, plastic, -0.27, 0, 0.55));                     // backrest stem
  const back = box(0.06, 0.44, 0.46, fabric, -0.27, 0, 0.88); back.rotation.y = -0.12; top.add(back);
  root.add(top);
  return { root, top };
}

function buildBottle(M) {
  const g = new THREE.Group();
  const prof = [[0, 0], [0.029, 0], [0.033, 0.006], [0.033, 0.15], [0.03, 0.17], [0.016, 0.195], [0.014, 0.2]].map(([r, z]) => new THREE.Vector2(r, z));
  const shell = new THREE.Mesh(new THREE.LatheGeometry(prof, 40), M.glass);
  shell.rotation.x = Math.PI / 2; g.add(shell);
  const water = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.15, 32), M.water);
  water.rotation.x = Math.PI / 2; water.position.z = 0.08; g.add(water);
  const label = new THREE.Mesh(new THREE.CylinderGeometry(0.0335, 0.0335, 0.05, 40, 1, true), M.label);
  label.rotation.x = Math.PI / 2; label.position.z = 0.1; g.add(label);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0155, 0.0155, 0.02, 24), M.cap);
  cap.rotation.x = Math.PI / 2; cap.position.z = 0.207; cap.castShadow = true; g.add(cap);
  const shadow = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.19, 16), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  shadow.rotation.x = Math.PI / 2; shadow.position.z = 0.1; shadow.castShadow = true; g.add(shadow);
  return g; // origin at the bottle's base centre
}

// ---------------------------------------------------------------- person: a rigged, textured human
// assets/person.glb is Microsoft Rocketbox avatar Male_Adult_10 (MIT licence), converted from FBX with its
// tracksuit repainted as the team's beige work jacket and the face and fringe redone from a team member's
// portrait. It is posed procedurally: every bone gets an absolute
// rotation from its rest pose (children inherit it), arms and legs are solved with two-bone IK, so any frame
// can be computed on its own.
const MODEL_TO_WORLD = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));    // glTF Y-up facing +Z -> Z-up facing +X
const FINGERS = [['Finger1', 'Finger11', 'Finger12'], ['Finger2', 'Finger21', 'Finger22'], ['Finger3', 'Finger31', 'Finger32'], ['Finger4', 'Finger41', 'Finger42']];
const THUMB = ['Finger0', 'Finger01', 'Finger02'];
async function buildPerson(url, height = PERSON_H) {
  const pre = offlineFile(url);                    // base64 GLB in the offline copy
  const gltf = pre ? await new GLTFLoader().parseAsync(Uint8Array.from(atob(pre), c => c.charCodeAt(0)).buffer, '') : await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const bones = {}, rest = new Map();
  model.traverse(o => {
    if (o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
    if (o.isBone) bones[o.name.replace(/^Bip01_/, '')] = o;
  });
  for (const b of Object.values(bones)) {
    rest.set(b, { qw: b.getWorldQuaternion(new THREE.Quaternion()), qp: b.parent.getWorldQuaternion(new THREE.Quaternion()), p: b.getWorldPosition(new THREE.Vector3()) });
  }
  const root = new THREE.Group(), orient = new THREE.Group();
  orient.quaternion.copy(MODEL_TO_WORLD); orient.scale.setScalar(height / 1.82);
  orient.add(model); root.add(orient);
  return { root, orient, model, bones, rest };
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _m4 = new THREE.Matrix4();
// R maps short bone names to model-space rotations from rest; a bone without one inherits its parent's
function applyPose(P, R) {
  const Rw = new Map(), I = new THREE.Quaternion();
  P.model.traverse(o => {
    if (!o.isBone) return;
    const r0 = Rw.get(o.parent) || I, r = R[o.name.replace(/^Bip01_/, '')] || r0, rs = P.rest.get(o);
    Rw.set(o, r);
    _qa.copy(r0).multiply(rs.qp).invert(); _qb.copy(r).multiply(rs.qw);
    o.quaternion.copy(_qa.multiply(_qb));
  });
}
const frameQ = (x, n) => { const z = new THREE.Vector3().crossVectors(x, n).normalize(); const y = new THREE.Vector3().crossVectors(z, x); return new THREE.Quaternion().setFromRotationMatrix(_m4.makeBasis(x, y, z)); };
// arm to a wrist point with a given hand frame (all in model space): x = finger direction, y = palm normal.
// S is where the shoulder is now (the rest position unless the torso leans)
function solveArm(P, side, wrist, handX, handY, curl, R, pole, S = P.rest.get(P.bones[`${side}_UpperArm`]).p) {
  const up = P.bones[`${side}_UpperArm`], fa = P.bones[`${side}_Forearm`], hd = P.bones[`${side}_Hand`];
  const S0 = P.rest.get(up).p, E0 = P.rest.get(fa).p, W0 = P.rest.get(hd).p;
  const a = S0.distanceTo(E0), b = E0.distanceTo(W0);
  const u0 = E0.clone().sub(S0).normalize(), f0 = W0.clone().sub(E0).normalize(), n0 = new THREE.Vector3().crossVectors(u0, f0).normalize();
  const d = wrist.clone().sub(S), len = clamp(d.length(), 0.05, a + b - 1e-4); d.normalize();
  const x = (a * a - b * b + len * len) / (2 * len), h = Math.sqrt(Math.max(0, a * a - x * x));
  const p = pole.clone().addScaledVector(d, -pole.dot(d)).normalize();
  const E = S.clone().addScaledVector(d, x).addScaledVector(p, h), W = S.clone().addScaledVector(d, len);
  const u1 = E.clone().sub(S).normalize(), f1 = W.clone().sub(E).normalize();
  const n1 = new THREE.Vector3().crossVectors(u1, f1); if (n1.lengthSq() < 1e-8) n1.copy(n0); n1.normalize();
  R[`${side}_UpperArm`] = frameQ(u1, n1).multiply(frameQ(u0, n0).invert());
  R[`${side}_Forearm`] = frameQ(f1, n1).multiply(frameQ(f0, n0).invert());
  const hx = handX.clone().normalize(), hz = new THREE.Vector3().crossVectors(hx, handY).normalize(), hy = new THREE.Vector3().crossVectors(hz, hx);
  const rh = new THREE.Quaternion().setFromRotationMatrix(_m4.makeBasis(hx, hy, hz)).multiply(P.rest.get(hd).qw.clone().invert());
  R[`${side}_Hand`] = rh;
  // fingers curl toward the palm about the hand's own z axis (the same for both hands: z = x cross y)
  const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(P.rest.get(hd).qw);
  FINGERS.forEach(ch => ch.forEach((n, j) => { R[`${side}_${n}`] = rh.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, curl * (j + 1) * (j ? 1.1 : 0.9))); }));
  THUMB.forEach((n, j) => { R[`${side}_${n}`] = rh.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, curl * 0.35 * (j + 1))); });
}
// leg to an ankle point (model space), knee bending forward in the leg's sagittal plane, foot kept flat
function solveLeg(P, side, ankle, R) {
  const H = P.rest.get(P.bones[`${side}_Thigh`]).p, K0 = P.rest.get(P.bones[`${side}_Calf`]).p, A0 = P.rest.get(P.bones[`${side}_Foot`]).p;
  const a = H.distanceTo(K0), b = K0.distanceTo(A0);
  const d = ankle.clone().sub(H), len = clamp(d.length(), 0.05, a + b - 1e-4); d.normalize();
  const x = (a * a - b * b + len * len) / (2 * len), h = Math.sqrt(Math.max(0, a * a - x * x));
  const fwd = new THREE.Vector3(0, 0, 1), p = fwd.addScaledVector(d, -fwd.dot(d)).normalize();
  const K = H.clone().addScaledVector(d, x).addScaledVector(p, h), A = H.clone().addScaledVector(d, len), X = new THREE.Vector3(1, 0, 0);
  R[`${side}_Thigh`] = frameQ(K.clone().sub(H).normalize(), X).multiply(frameQ(K0.clone().sub(H).normalize(), X).invert());
  R[`${side}_Calf`] = frameQ(A.clone().sub(K).normalize(), X).multiply(frameQ(A0.clone().sub(K0).normalize(), X).invert());
  R[`${side}_Foot`] = new THREE.Quaternion();
}

// ---------------------------------------------------------------- robot from URDF + meshes
function decode(b64, Type) {
  const bin = atob(b64); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Type(u8.buffer);
}
function buildRobot(meshes, M) {
  const links = { base_link: new THREE.Group() };
  const joints = {}, grippers = {}, parts = [];   // parts: every mesh with its link and per-group material names
  const addMesh = (name, group) => {
    const d = meshes[name]; if (!d) return;
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(decode(d.p, Float32Array), 3));
    geo.setIndex(new THREE.BufferAttribute(decode(d.i, d.i32 ? Uint32Array : Uint16Array), 1));
    const groups = d.g || [[0, geo.index.count, 'shell']];
    groups.forEach(([start, count], k) => geo.addGroup(start, count, k));
    geo = toCreasedNormals(geo, Math.PI / 5);                    // non-indexed from here, groups keep their ranges
    const m = new THREE.Mesh(geo, groups.map(g => M.robot[g[2].split('@')[0]])); m.castShadow = true; m.receiveShadow = true; group.add(m);
    parts.push({ link: name, mesh: m, mats: groups.map(g => g[2]) });
    if (name.startsWith('Gripper')) {
      // the linkage fingers are every part but the housing: they slide apart along y (jaw direction), the
      // links fading to zero motion at their pivots on the housing, which reads as the parallel linkage swinging open
      const [start, count] = groups.find(g => g[2] === 'black');
      const pos = geo.attributes.position, base = pos.array.slice(), coef = new Float32Array(pos.count);
      for (let v = start; v < start + count; v++) {
        const t3 = (v - (v % 3)) * 3, cy = base[t3 + 1] + base[t3 + 4] + base[t3 + 7];
        coef[v] = (cy < 0 ? -1 : 1) * clamp((0.112 - base[v * 3 + 2]) / 0.062);
      }
      m.frustumCulled = false;
      grippers[name] = { pos, base, coef, start, count, open: -1 };
    }
  };
  addMesh('base_link', links.base_link);
  // head box: mesh simplification crumples it, so paint_mesh.py drops it and it is rebuilt from its outline here:
  // grey band, brushed silver body, and the light band round the top edge (photos: docs/manual/index.html)
  const headBox = (len, wid, z0, z1, mat) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(len, wid, z1 - z0, 3, 0.014), mat);
    m.position.set(-0.2215, -0.002, (z0 + z1) / 2); m.castShadow = true; links.base_link.add(m);
    parts.push({ link: 'head', mesh: m, mats: [mat === M.robot.led ? 'led' : mat === M.robot.joint ? 'joint' : 'silver'] });
    return m;
  };
  headBox(0.283, 0.252, 1.432, 1.456, M.robot.joint);
  headBox(0.281, 0.254, 1.455, 1.52, M.robot.silver);
  const led = headBox(0.284, 0.257, 1.495, 1.515, M.robot.led);
  for (const [name, parent, type, xyz, axis, lo, hi] of JOINTS) {
    const frame = new THREE.Group(); frame.position.set(...xyz);
    const move = new THREE.Group(); frame.add(move);
    links[parent].add(frame);
    const link = new THREE.Group(); move.add(link); links[name] = link;
    addMesh(name, link);
    joints[name] = { type, move, axis: axis ? new THREE.Vector3(...axis) : null, lo, hi, q: 0 };
  }
  const set = (name, q) => {
    const j = joints[name]; j.q = q;
    if (j.type === 'prismatic') j.move.position.copy(j.axis).multiplyScalar(q);
    else if (j.type === 'revolute') j.move.quaternion.setFromAxisAngle(j.axis, q);
  };
  // gripper opening: each finger moves `open` metres away from the centre line (0 = fingertips touching)
  const setGrip = (side, open) => {
    const g = grippers[`Gripper_${side}`]; if (!g || Math.abs(g.open - open) < 1e-5) return;
    g.open = open;
    const a = g.pos.array;
    for (let v = g.start; v < g.start + g.count; v++) a[v * 3 + 1] = g.base[v * 3 + 1] + g.coef[v] * open;
    g.pos.needsUpdate = true;
  };
  return { root: links.base_link, links, joints, parts, set, setGrip, led };
}

// ---------------------------------------------------------------- damped least-squares IK (numeric Jacobian)
function solveIK({ root, chain, ee, target, quat = null, seed, iters = 160, wRot = 0.35 }) {
  const q = seed.slice();
  const apply = () => { chain.forEach((c, i) => c.set(q[i])); root.updateMatrixWorld(true); };
  const p = new THREE.Vector3(), r = new THREE.Quaternion(), tmpQ = new THREE.Quaternion();
  const err = () => {
    ee.getWorldPosition(p);
    const e = [target.x - p.x, target.y - p.y, target.z - p.z];
    if (quat) {
      ee.getWorldQuaternion(r);
      tmpQ.copy(quat).multiply(r.clone().invert());
      if (tmpQ.w < 0) { tmpQ.x *= -1; tmpQ.y *= -1; tmpQ.z *= -1; tmpQ.w *= -1; }
      const s = Math.sqrt(Math.max(1e-12, 1 - tmpQ.w * tmpQ.w)), ang = 2 * Math.acos(clamp(tmpQ.w, -1, 1));
      e.push(tmpQ.x / s * ang * wRot, tmpQ.y / s * ang * wRot, tmpQ.z / s * ang * wRot);
    }
    return e;
  };
  for (let it = 0; it < iters; it++) {
    apply(); const e0 = err();
    if (Math.hypot(...e0) < 2e-4) break;
    const n = q.length, m = e0.length, J = [];
    for (let i = 0; i < n; i++) {
      const h = 1e-4; q[i] += h; apply(); const e1 = err(); q[i] -= h;
      J.push(e0.map((v, k) => (v - e1[k]) / h));                  // column i (d f / d q_i)
    }
    const lam = 0.04, A = [];                                     // A = J J^T + lam^2 I  (m x m)
    for (let a = 0; a < m; a++) { A.push([]); for (let b = 0; b < m; b++) { let s = a === b ? lam * lam : 0; for (let i = 0; i < n; i++) s += J[i][a] * J[i][b]; A[a].push(s); } }
    const y = gauss(A, e0.slice());
    for (let i = 0; i < n; i++) {
      let d = 0; for (let k = 0; k < m; k++) d += J[i][k] * y[k];
      q[i] = clamp(q[i] + clamp(d, -0.2, 0.2), chain[i].lo, chain[i].hi);
    }
  }
  apply();
  return q;
}
function gauss(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) { const f = A[r][c] / A[c][c]; for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = s / A[r][r]; }
  return x;
}

// ---------------------------------------------------------------- occupancy map (what the lidar would reveal)
function buildMapReveal() {
  const res = 0.05, ox = ROOM.x0 - 0.1, oy = ROOM.y0 - 0.1;
  const cols = Math.round((ROOM.x1 - ROOM.x0 + 0.2) / res), rows = Math.round((ROOM.y1 - ROOM.y0 + 0.2) / res);
  const occ = new Uint8Array(cols * rows);
  const fill = (r) => {
    for (let j = Math.floor((r.y0 - oy) / res); j <= Math.floor((r.y1 - oy) / res); j++)
      for (let i = Math.floor((r.x0 - ox) / res); i <= Math.floor((r.x1 - ox) / res); i++)
        if (i >= 0 && j >= 0 && i < cols && j < rows) occ[j * cols + i] = 1;
  };
  const w = 0.06;
  fill({ x0: ROOM.x0 - w, x1: ROOM.x0, y0: ROOM.y0 - w, y1: ROOM.y1 + w });
  fill({ x0: ROOM.x1, x1: ROOM.x1 + w, y0: ROOM.y0 - w, y1: ROOM.y1 + w });
  fill({ x0: ROOM.x0 - w, x1: ROOM.x1 + w, y0: ROOM.y0 - w, y1: ROOM.y0 });
  fill({ x0: ROOM.x0 - w, x1: ROOM.x1 + w, y0: ROOM.y1, y1: ROOM.y1 + w });
  SOLIDS.forEach(fill); LEGS.forEach(fill);
  const seen = new Float32Array(cols * rows).fill(2);             // reveal progress in [0,1]; 2 = never
  const curve = curve2(MAP_PATH), N = 160, range = 6;
  const cast = (x, y, a) => {
    const dx = Math.cos(a) * res * 0.7, dy = Math.sin(a) * res * 0.7;
    let px = x, py = y;
    for (let s = 0; s < range / (res * 0.7); s++) {
      const i = Math.floor((px - ox) / res), j = Math.floor((py - oy) / res);
      if (i < 0 || j < 0 || i >= cols || j >= rows) return [px, py, -1];
      if (occ[j * cols + i]) return [px, py, j * cols + i];
      px += dx; py += dy;
    }
    return [px, py, -1];
  };
  for (let k = 0; k <= N; k++) {
    const u = k / N, pt = curve.getPointAt(u);
    for (let a = 0; a < 360; a += 0.5) {
      const ang = a * Math.PI / 180;
      const dx = Math.cos(ang) * res * 0.7, dy = Math.sin(ang) * res * 0.7;
      let px = pt.x, py = pt.y;
      for (let s = 0; s < range / (res * 0.7); s++) {
        const i = Math.floor((px - ox) / res), j = Math.floor((py - oy) / res);
        if (i < 0 || j < 0 || i >= cols || j >= rows) break;
        const c = j * cols + i; if (seen[c] > u) seen[c] = u;
        if (occ[c]) break;
        px += dx; py += dy;
      }
    }
  }
  // close the gaps between far-apart rays: a free cell counts as seen once a neighbour is
  const filled = seen.slice();
  for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
    const c = j * cols + i; if (occ[c]) continue;
    for (const d of [-1, 1, -cols, cols, -cols - 1, -cols + 1, cols - 1, cols + 1]) if (!occ[c + d] && seen[c + d] < filled[c]) filled[c] = seen[c + d];
  }
  return { res, ox, oy, cols, rows, occ, seen: filled, cast };
}

// ---------------------------------------------------------------- the simulation
// the robot meshes are fetched once per page and shared by every scene on it (hero, explorer, simulator)
const meshCache = new Map();
export function loadMeshes(url) {
  const pre = offlineFile(url);
  if (!meshCache.has(url)) meshCache.set(url, pre ? Promise.resolve(pre) : fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }));
  return meshCache.get(url);
}
export { materials, buildRobot, ARM_JOINTS, BASE_TO_CENTER, solveIK };

export async function createSim(container, opts = {}) {
  const mode = opts.mode || 'film';                 // 'film' | 'interactive'
  const meshes = await loadMeshes(opts.meshUrl);
  const M = materials();

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: mode === 'film' });
  renderer.setPixelRatio(opts.pixelRatio || Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'i7sim-canvas';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const bg = new THREE.Color(opts.background || 0xf5f5f7);
  scene.background = bg;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9dce4, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(-3.5, -5.5, 9); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -6.5, right: 6.5, top: 5.5, bottom: -5.5, near: 1, far: 25 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; sun.shadow.radius = 3;
  scene.add(sun);

  const lab = buildLab(M); scene.add(lab);
  const studioFloor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.14 }));
  studioFloor.receiveShadow = true; studioFloor.visible = false; scene.add(studioFloor);

  // robot
  const robot = buildRobot(meshes, M);
  const robotRoot = new THREE.Group(); robotRoot.add(robot.root); scene.add(robotRoot);
  const chain = (side) => ARM_JOINTS(side).map(n => ({ set: (q) => robot.set(n, q), lo: robot.joints[n].lo, hi: robot.joints[n].hi }));
  const setArm = (side, q) => ARM_JOINTS(side).forEach((n, i) => robot.set(n, q[i]));
  const gripR = robot.links.Gripper_Right;
  const lift = robot.links.Shoulder_Base;                 // the head camera rides on the lift mast
  const headCamLocal = new THREE.Vector3(0.07, 0, 0.3);

  // bottle, the person and the chair they sit on
  const bottle = buildBottle(M); scene.add(bottle);
  const chair = buildChair(M); scene.add(chair.root);
  const person = await buildPerson(opts.personUrl || './assets/person.glb'); scene.add(person.root);
  const pHand = person.bones.R_Hand, pHead = person.bones.Head;
  const X1 = new THREE.Vector3(1, 0, 0), qx = (a) => new THREE.Quaternion().setFromAxisAngle(X1, a);
  const handFrame = (x, y) => { const X = x.clone().normalize(), Z = new THREE.Vector3().crossVectors(X, y).normalize(); return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, new THREE.Vector3().crossVectors(Z, X), Z)); };
  const pelvis = person.rest.get(person.bones.Pelvis).p;
  // a rest-pose point of the upper body once the torso leans forward by `lean` about the hips (model space)
  const leaned = (p, lean) => p.clone().sub(pelvis).applyAxisAngle(X1, lean).add(pelvis);
  const shoulder = (side, lean) => leaned(person.rest.get(person.bones[`${side}_UpperArm`]).p, lean);
  // relaxed arm in model space (Y up, +Z forward, +X the person's left): wrist below the shoulder, palm to the thigh
  const relaxed = (side, S) => {
    const s = side === 'R' ? -1 : 1;
    return { W: S.clone().add(new THREE.Vector3(s * 0.06, -0.525, 0.07)), Q: handFrame(new THREE.Vector3(s * 0.05, -1, 0.14), new THREE.Vector3(-s, 0, 0)), curl: 0.28 };
  };
  // seated: hands resting on the thighs, palms down
  const lap = (side) => { const s = side === 'R' ? -1 : 1; return { W: new THREE.Vector3(s * 0.15, 0.98, 0.16), Q: handFrame(new THREE.Vector3(-s * 0.1, -0.25, 1), new THREE.Vector3(0, -1, 0)), curl: 0.35 }; };
  const worldArm = (W, X, Y, curl) => ({ W: W.clone(), X: X.clone().normalize(), Y: Y.clone().normalize(), curl });
  const m2w = new THREE.Quaternion();
  const toModel = (a) => {
    person.model.getWorldQuaternion(m2w).invert();
    return { W: person.model.worldToLocal(a.W.clone()), Q: handFrame(a.X.clone().applyQuaternion(m2w), a.Y.clone().applyQuaternion(m2w)), curl: a.curl };
  };
  const mixArm = (a, b, k) => ({ W: a.W.clone().lerp(b.W, k), Q: a.Q.clone().slerp(b.Q, k), curl: lerp(a.curl, b.curl, k) });
  // the person works at the desk facing the screen, swivels round towards the robot, stands up and gives the command
  const SIT = { turn0: 13.7, turn1: 14.5, up0: 14.45, up1: 15.4 };
  const fw = V2(Math.cos(WORK_YAW), Math.sin(WORK_YAW)), rt = V2(Math.sin(WORK_YAW), -Math.cos(WORK_YAW));   // seated forward and right
  const keys = (side, t) => {                                      // hands on the keyboard, in the world, while facing the screen
    const s = side === 'R' ? 1 : -1, tap = 0.006 * Math.max(0, Math.sin(t * (side === 'R' ? 17 : 13) + s));
    const at = (f, r, z) => new THREE.Vector3(CHAIR.x + fw.x * f + rt.x * r, CHAIR.y + fw.y * f + rt.y * r, z);
    const dir = (f, r, z) => new THREE.Vector3(fw.x * f + rt.x * r, fw.y * f + rt.y * r, z);
    return worldArm(at(0.425, s * 0.12, DESK.h + 0.04 + tap), dir(1, -s * 0.12, -0.2), new THREE.Vector3(0, 0, -1), 0.45);
  };
  const reachW = SEATED.back * PERSON_SCALE;                        // feet are this far in front of the swivel axis
  let armTarget = () => null;                                      // set once the hand-over poses are known
  function posePerson(t) {
    const yaw = WORK_YAW + wrap(0 - WORK_YAW) * ramp(t, SIT.turn0, SIT.turn1);   // turns from the desk to face east, where the robot is
    const u = lin(t, SIT.up0, SIT.up1);                              // standing up: 0 seated, 1 upright
    const back = SEATED.back * (1 - ease(u / 0.7)), drop = SEATED.drop * (1 - ease((u - 0.2) / 0.8));
    const lean = t < SIT.up0 ? lerp(0.12, 0.04, ramp(t, SIT.turn0 - 0.4, SIT.turn0 + 0.2)) : lerp(0.04, 0, u) + 0.6 * Math.sin(Math.PI * clamp(u / 0.85)) ** 2;
    chair.top.rotation.z = yaw;
    chair.root.visible = person.root.visible = t >= 4;              // kept out of the opening robot close-up, where the chair would crowd the frame edge
    person.root.position.set(CHAIR.x + Math.cos(yaw) * reachW, CHAIR.y + Math.sin(yaw) * reachW, 0);
    person.root.rotation.set(0, 0, yaw);
    person.model.position.set(0, -drop, -back);
    person.root.updateMatrixWorld(true);
    const R = {};
    R.Pelvis = qx(lean);
    for (const side of ['L', 'R']) solveLeg(person, side, person.rest.get(person.bones[`${side}_Foot`]).p.clone().add(new THREE.Vector3(0, drop, back)), R);
    const look = t < 46 + D ? lerp(0.14, 0.02, ramp(t, SIT.turn0 - 0.2, SIT.turn0 + 0.4)) : lerp(0.02, 0.32, ramp(t - D, 46.0, 47.2)) * (1 - ramp(t - D, 51.6, 53.0) * 0.6);
    R.Neck = qx(lean * 0.6 + look * 0.4); R.Head = qx(lean * 0.3 + look);
    R.MJaw = R.Head.clone().multiply(qx(0.16 * voiceLevel(t, 'cmd', 'thanks')));
    const arm = (side) => {
      const S = shoulder(side, lean);
      if (t >= SIT.up1) return { S, a: relaxed(side, S) };
      const toLap = ramp(t, SIT.turn0 - 0.4, SIT.turn0 + 0.15), toSide = ramp(t, SIT.up0 + 0.1, SIT.up1);
      let a = toLap < 1 ? mixArm(toModel(keys(side, t)), lap(side), toLap) : lap(side);
      if (toSide > 0) a = mixArm(a, relaxed(side, S), toSide);
      return { S, a };
    };
    const L = arm('L');
    solveArm(person, 'L', L.a.W, new THREE.Vector3(1, 0, 0).applyQuaternion(L.a.Q), new THREE.Vector3(0, 1, 0).applyQuaternion(L.a.Q), L.a.curl, R, new THREE.Vector3(0.35, 0, -1), L.S);
    const Rt = arm('R');
    let right = Rt.a;
    const target = armTarget(t);
    if (target) right = target.k >= 1 ? target.to : mixArm(right, target.to, target.k);
    solveArm(person, 'R', right.W, new THREE.Vector3(1, 0, 0).applyQuaternion(right.Q), new THREE.Vector3(0, 1, 0).applyQuaternion(right.Q), right.curl, R, new THREE.Vector3(-0.35, 0, -1), Rt.S);
    applyPose(person, R);
  }

  // map overlay
  const MAP = buildMapReveal();
  const mapCanvas = document.createElement('canvas'); mapCanvas.width = MAP.cols; mapCanvas.height = MAP.rows;
  const mapCtx = mapCanvas.getContext('2d');
  const mapTex = new THREE.CanvasTexture(mapCanvas);
  mapTex.magFilter = THREE.NearestFilter; mapTex.minFilter = THREE.LinearFilter; mapTex.colorSpace = THREE.SRGBColorSpace;
  const mapPlane = new THREE.Mesh(new THREE.PlaneGeometry(MAP.cols * MAP.res, MAP.rows * MAP.res), new THREE.MeshBasicMaterial({ map: mapTex, transparent: true, depthWrite: false }));
  mapPlane.position.set(MAP.ox + MAP.cols * MAP.res / 2, MAP.oy + MAP.rows * MAP.res / 2, 0.004);
  mapPlane.renderOrder = 1; scene.add(mapPlane);
  const mapImg = mapCtx.createImageData(MAP.cols, MAP.rows);
  let lastMapU = -1, lastMapAlpha = -1;
  const drawMap = (u, alpha) => {
    if (Math.abs(u - lastMapU) < 1e-4 && Math.abs(alpha - lastMapAlpha) < 1e-3) return;
    lastMapU = u; lastMapAlpha = alpha;
    const d = mapImg.data;
    for (let j = 0; j < MAP.rows; j++) for (let i = 0; i < MAP.cols; i++) {
      const c = j * MAP.cols + i, o = ((MAP.rows - 1 - j) * MAP.cols + i) * 4;
      if (MAP.seen[c] <= u) {
        if (MAP.occ[c]) { d[o] = 29; d[o + 1] = 29; d[o + 2] = 31; d[o + 3] = 235 * alpha; }
        else { d[o] = 10; d[o + 1] = 108; d[o + 2] = 223; d[o + 3] = 46 * alpha; }
      } else d[o + 3] = 0;
    }
    mapCtx.putImageData(mapImg, 0, 0); mapTex.needsUpdate = true;
  };

  // lidar rays
  const NR = 180;
  const rayGeo = new THREE.BufferGeometry(); rayGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NR * 6), 3));
  const rays = new THREE.LineSegments(rayGeo, new THREE.LineBasicMaterial({ color: 0x0a6cdf, transparent: true, opacity: 0.28, depthWrite: false }));
  rays.renderOrder = 2; scene.add(rays);

  // navigation path ribbons, return pin, localisation pulse
  const ribbon = (pts) => {
    const c = curve2(pts); const n = 120, w = 0.035;
    const pos = [], idx = [];
    for (let k = 0; k <= n; k++) {
      const u = k / n, p = c.getPointAt(u), tng = c.getTangentAt(u);
      pos.push(p.x - tng.y * w, p.y + tng.x * w, 0.012, p.x + tng.y * w, p.y - tng.x * w, 0.012);
      if (k < n) idx.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, M.path.clone()); m.renderOrder = 3; scene.add(m); return { mesh: m, count: idx.length };
  };
  const navRibbon = ribbon(NAV_PATH), retRibbon = ribbon(RET_PATH);
  const pin = new THREE.Group();
  const pinHead = new THREE.Mesh(new THREE.SphereGeometry(0.06, 24, 16), M.accent); pinHead.position.z = 0.42; pin.add(pinHead);
  const pinStem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.38, 8), M.accent); pinStem.rotation.x = Math.PI / 2; pinStem.position.z = 0.2; pin.add(pinStem);
  const pinRing = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 48), M.accentSoft); pinRing.position.z = 0.013; pin.add(pinRing);
  pin.position.set(START.x, START.y, 0); scene.add(pin);
  const pulse = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 64), new THREE.MeshBasicMaterial({ color: 0x0a6cdf, transparent: true, opacity: 0.5, depthWrite: false }));
  pulse.position.set(START.x, START.y, 0.014); scene.add(pulse);

  // vision and depth-camera markers: the detection box round the drawer table, the navigation goal in front of it,
  // the table's front plane as the depth camera fits it, and the footprint the robot squares up into
  const markMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const bar = (g, mat, w, d, h, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat); m.position.set(x, y, z); m.renderOrder = 4; g.add(m); };
  const detMat = markMat(0x0a6cdf, 0.9), detBox = new THREE.Group();
  {
    const w = TABLE.x1 - TABLE.x0 + 0.08, d = TABLE.y1 - TABLE.y0 + 0.08, h = TABLE.h + 0.3, th = 0.014;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) bar(detBox, detMat, th, th, h, sx * w / 2, sy * d / 2, h / 2);
    for (const z of [0.008, h]) { for (const sy of [-1, 1]) bar(detBox, detMat, w + th, th, th, 0, sy * d / 2, z); for (const sx of [-1, 1]) bar(detBox, detMat, th, d + th, th, sx * w / 2, 0, z); }
    detBox.position.set(TABLE_C.x, TABLE_C.y, 0); scene.add(detBox);
  }
  const goalMat = markMat(0x0a6cdf, 0.9), goal = new THREE.Group();
  {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.21, 48), goalMat); ring.position.z = 0.014; goal.add(ring);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.06, 32), goalMat); dot.position.z = 0.014; goal.add(dot);
    const tri = new THREE.Shape([new THREE.Vector2(0.42, 0), new THREE.Vector2(0.27, 0.07), new THREE.Vector2(0.27, -0.07)]);
    const arrow = new THREE.Mesh(new THREE.ShapeGeometry(tri), goalMat); arrow.position.z = 0.014; goal.add(arrow);
    goal.position.set(NAV_END.x, NAV_END.y, 0); scene.add(goal);
  }
  const planeMat = markMat(0xff9f0a, 0.32), planeEdge = markMat(0xff9f0a, 0.95), plane = new THREE.Group();
  {
    const d = TABLE.y1 - TABLE.y0, z0 = 0.05, z1 = TABLE.h - 0.02, th = 0.012;
    const q = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0, d), planeMat); q.rotation.y = -Math.PI / 2; q.material.side = THREE.DoubleSide; q.renderOrder = 4; plane.add(q);
    for (const z of [z0 - (z0 + z1) / 2, z1 - (z0 + z1) / 2]) bar(plane, planeEdge, th, d, th, 0, 0, z);
    for (const sy of [-1, 1]) bar(plane, planeEdge, th, th, z1 - z0, 0, sy * d / 2, 0);
    bar(plane, planeEdge, 0.3, 0.012, 0.012, -0.15, 0, 0);          // the plane normal, pointing back at the robot
    plane.position.set(TABLE.x0 - 0.025, TABLE_C.y, (z0 + z1) / 2); scene.add(plane);
  }
  const footMat = markMat(0x0a6cdf, 0.9), foot = new THREE.Group();
  {
    const L = 0.72, Wd = 0.6, th = 0.022;
    for (const sy of [-1, 1]) bar(foot, footMat, L + th, th, 0.004, 0, sy * Wd / 2, 0.014);
    for (const sx of [-1, 1]) bar(foot, footMat, th, Wd + th, 0.004, sx * L / 2, 0, 0.014);
    bar(foot, footMat, 0.24, th, 0.004, L / 2 + 0.12, 0, 0.014);     // heading tick
    foot.position.set(AT_TABLE.x, AT_TABLE.y, 0); scene.add(foot);
  }
  const markers = [detBox, goal, plane, foot];
  const fadeMarker = (g, mat, k, pop = false) => { g.visible = k > 0.01; mat.forEach(([m, o]) => { m.opacity = o * k; }); if (pop) g.scale.setScalar(lerp(1.15, 1, ease(k))); };

  // depth image for the picture-in-picture: distance from the camera through a turbo colour map
  const depthMat = new THREE.ShaderMaterial({
    uniforms: { near: { value: 0.6 }, far: { value: 2.6 } },
    vertexShader: 'varying float vD; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: `uniform float near, far; varying float vD;
      vec3 turbo(float x){ x = clamp(x, 0.0, 1.0); vec4 v4 = vec4(1.0, x, x * x, x * x * x); vec2 v2 = v4.zw * v4.z;
        return vec3(dot(v4, vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234)) + dot(v2, vec2(-152.94239396, 59.28637943)),
                    dot(v4, vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333)) + dot(v2, vec2(4.27729857, 2.82956604)),
                    dot(v4, vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771)) + dot(v2, vec2(-89.90310912, 27.34824973))); }
      void main(){ float k = clamp((vD - near) / (far - near), 0.0, 1.0); gl_FragColor = vec4(turbo(1.0 - pow(k, 0.8)) * 0.92, 1.0); }`,
  });
  const depthBg = new THREE.Color(0x07080c);

  // ---------------------------------------------------------------- precomputed motions
  const mapCurve = curve2(MAP_PATH), navCurve = curve2(NAV_PATH), retCurve = curve2(RET_PATH);
  const REST_R = [0.12, -0.08, 0, -0.28, 0, 0, 0.1], REST_L = [0.12, 0.08, 0, -0.28, 0, 0, 0.1];
  const LIFT_LOW = -0.1 - (0.75 - TABLE.h);                   // the arm poses were set for a 0.75 m table; the lift makes up the difference
  const dz = LIFT_LOW + 0.1;
  // gripper frame: z points from fingertip back to the flange; jaws close along y
  const toolQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)));
  robotRoot.position.set(0, 0, 0); robotRoot.rotation.set(0, 0, 0);
  setArm('Left', REST_L);
  const ik = (tip, seed, lift) => {
    robot.set('Shoulder_Base', lift);
    return solveIK({ root: robotRoot, chain: chain('Right'), ee: gripR, target: new THREE.Vector3(...tip), quat: toolQuat, seed });
  };
  const bx = 0.43, by = -0.25, bz = TABLE.h + 0.105;          // bottle centre in base_link frame at the table
  const GRASP_DEPTH = 0.036;                                   // bottle axis behind the fingertips, centred on the finger pads
  const seed0 = [-0.55, -0.15, 0.1, -1.5, 0, 0, -0.2];
  const K = {};
  K.raised = ik([0.24, -0.3, 1.06 + dz], seed0, LIFT_LOW);
  K.pre = ik([0.31, by, bz], K.raised, LIFT_LOW);
  K.approach = []; for (let k = 0; k <= 8; k++) K.approach.push(ik([lerp(0.31, bx + GRASP_DEPTH, k / 8), by, bz], k ? K.approach[k - 1] : K.pre, LIFT_LOW));
  K.grasp = K.approach[8];
  K.lift = []; for (let k = 0; k <= 6; k++) K.lift.push(ik([bx + GRASP_DEPTH, by, lerp(bz, bz + 0.1, k / 6)], k ? K.lift[k - 1] : K.grasp, LIFT_LOW));
  K.carryLow = ik([0.3, -0.24, 1.0 + dz], K.lift[6], LIFT_LOW);
  K.carry = ik([0.3, -0.24, 1.0], K.carryLow, 0);
  K.hand = ik([0.56, -0.05, 1.02], K.carry, 0);
  robot.set('Shoulder_Base', 0);
  const bottleBase = new THREE.Vector3(BOTTLE.x, BOTTLE.y, TABLE.h);

  // robot base pose over time
  const yawOf = (c, u) => { const tg = c.getTangentAt(clamp(u, 0, 1)); return Math.atan2(tg.y, tg.x); };
  const YAW_NAV = yawOf(navCurve, 1);                   // heading on arrival at the navigation goal, before squaring up
  const ALIGN = { turn0: 32.2, turn1: 33.5, move0: 33.7, move1: 35.3 };
  function basePose(t) {
    if (t < 4.3) return { ...START };
    if (t < 11.6) {                                     // mapping loop
      const u = ease(lin(t, 4.3, 11.6)), p = mapCurve.getPointAt(u);
      let yaw = yawOf(mapCurve, u);
      yaw = lerpAngle(START.yaw, yaw, clamp(u / 0.05));
      yaw = lerpAngle(yaw, START.yaw, clamp((u - 0.93) / 0.07));
      return { x: p.x, y: p.y, yaw };
    }
    if (t < 19.2) return { ...START };
    // look round for the drawer table: the head camera sweeps the room until the table is centred
    if (t < 24.6) return { x: START.x, y: START.y, yaw: lerpAngle(START.yaw, YAW_SEEN, ramp(t, 19.3, 22.4)) };
    const yaw0 = yawOf(navCurve, 0);
    if (t < 25.7) return { x: START.x, y: START.y, yaw: lerpAngle(YAW_SEEN, yaw0, ramp(t, 24.6, 25.7)) };
    if (t < 30.7) { const u = ease(lin(t, 25.7, 30.7)), p = navCurve.getPointAt(u); return { x: p.x, y: p.y, yaw: yawOf(navCurve, u) }; }
    // square up with the depth camera: turn on the spot to face the table's front plane, then drive in to grasp range
    if (t < ALIGN.move0) return { x: NAV_END.x, y: NAV_END.y, yaw: lerpAngle(YAW_NAV, 0, ramp(t, ALIGN.turn0, ALIGN.turn1)) };
    if (t < 36.2 + D) return { x: lerp(NAV_END.x, AT_TABLE.x, ramp(t, ALIGN.move0, ALIGN.move1)), y: AT_TABLE.y, yaw: 0 };
    const s = t - D;                                    // grasp onwards: the first cut's timing
    if (s < 37.2) return { x: AT_TABLE.x - BACKUP * ramp(s, 36.2, 37.2), y: AT_TABLE.y, yaw: 0 };
    const yawR = yawOf(retCurve, 0);
    if (s < 38.6) return { x: AT_TABLE.x - BACKUP, y: AT_TABLE.y, yaw: lerpAngle(0, yawR, ramp(s, 37.2, 38.6)) };
    if (s < 44.2) { const u = ease(lin(s, 38.6, 44.2)), p = retCurve.getPointAt(u); return { x: p.x, y: p.y, yaw: yawOf(retCurve, u) }; }
    return { x: START.x, y: START.y, yaw: lerpAngle(yawOf(retCurve, 1), START.yaw, ramp(s, 44.2, 44.9)) };
  }
  // the arm, lift and gripper keep the first cut's timing, D seconds later (before the grasp they sit at rest)
  const liftAt = (t) => { const s = t - D; return s < 37.5 ? LIFT_LOW * ramp(s, 28.0, 29.0) : LIFT_LOW * (1 - ramp(s, 37.5, 40.0)); };
  const qLerp = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
  const qPath = (arr, k) => { const f = clamp(k) * (arr.length - 1), i = Math.min(arr.length - 2, Math.floor(f)); return qLerp(arr[i], arr[i + 1], f - i); };
  function armR(t) {
    t -= D;
    if (t < 28.4) return REST_R;
    if (t < 30.0) return qLerp(REST_R, K.raised, ramp(t, 28.4, 30.0));
    if (t < 31.3) return qLerp(K.raised, K.pre, ramp(t, 30.0, 31.3));
    if (t < 31.4) return K.pre;
    if (t < 32.6) return qPath(K.approach, ramp(t, 31.4, 32.6));
    if (t < 33.2) return K.grasp;
    if (t < 34.0) return qPath(K.lift, ramp(t, 33.2, 34.0));
    if (t < 35.8) return qLerp(K.lift[6], K.carryLow, ramp(t, 34.0, 35.8));
    if (t < 37.5) return K.carryLow;
    if (t < 40.0) return qLerp(K.carryLow, K.carry, ramp(t, 37.5, 40.0));
    if (t < 45.2) return K.carry;
    if (t < 47.0) return qLerp(K.carry, K.hand, ramp(t, 45.2, 47.0));
    if (t < 50.4) return K.hand;
    return qLerp(K.hand, REST_R, ramp(t, 50.4, 52.6));
  }
  const T_GRIP = 32.85 + D, T_RELEASE = 49.45 + D;
  // finger opening (m from the centre line): opens on the way to the bottle, closes on it, lets go at the hand-over
  const GRIP = { rest: 0.006, open: 0.056, hold: 0.033 };
  const gripAt = (t) => {
    t -= D;
    if (t < 30.2) return GRIP.rest;
    if (t < 32.55) return lerp(GRIP.rest, GRIP.open, ramp(t, 30.2, 31.0));
    if (t < 49.3) return lerp(GRIP.open, GRIP.hold, ramp(t, 32.55, 32.9));
    if (t < 51.0) return lerp(GRIP.hold, GRIP.open, ramp(t, 49.3, 49.6));
    return lerp(GRIP.open, GRIP.rest, ramp(t, 51.0, 52.2));
  };

  function poseRobot(t) {
    const b = basePose(t);
    robotRoot.position.set(b.x + Math.cos(b.yaw) * BASE_TO_CENTER, b.y + Math.sin(b.yaw) * BASE_TO_CENTER, 0);
    robotRoot.rotation.set(0, 0, b.yaw);
    robot.set('Shoulder_Base', liftAt(t));
    setArm('Right', armR(t)); setArm('Left', REST_L);
    robot.setGrip('Right', gripAt(t)); robot.setGrip('Left', GRIP.rest);
    robot.led.material.emissiveIntensity = 1.1 + 2.4 * voiceLevel(t, 'ok', 'give');
    return b;
  }

  // person's right hand: rest -> round the lower half of the bottle (below the gripper pads), pull -> hold it close
  poseRobot(47.5 + D); posePerson(47.5 + D); scene.updateMatrixWorld(true);
  const bottleAtHand = gripR.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0, 1).applyQuaternion(gripR.getWorldQuaternion(new THREE.Quaternion())).multiplyScalar(GRASP_DEPTH));
  const gX = new THREE.Vector3(1, 0.12, -0.05).normalize(), gY = new THREE.Vector3(0, 1, 0);   // fingers forward, palm facing the bottle (thumb up)
  const gripPt = bottleAtHand.clone().add(new THREE.Vector3(0, 0, -0.065));
  const REACH = worldArm(gripPt.clone().addScaledVector(gX, -0.07).addScaledVector(gY, -0.045), gX, gY, 0.95);
  const HOLD = worldArm(new THREE.Vector3(PERSON.x + 0.27, PERSON.y - 0.08, 0.98), new THREE.Vector3(1, 0.45, 0), new THREE.Vector3(-0.45, 1, 0), 0.95);
  armTarget = (t) => {
    t -= D;
    if (t < 46.2) return null;
    if (t < 49.8) {
      const pull = REACH.W.clone().add(new THREE.Vector3(-0.018 * ramp(t, 48.2, 49.3), 0, 0));   // the pull the robot feels
      const a = toModel({ ...REACH, W: pull }); a.curl = lerp(0.3, 0.95, ramp(t, 47.6, 48.3));
      return { k: ramp(t, 46.2, 48.0), to: a };
    }
    const a = toModel(REACH), b = toModel(HOLD);
    return { k: 1, to: mixArm(a, b, ramp(t, 49.8, 51.4)) };
  };

  // bottle attachment offsets, computed once from the deterministic poses
  const mBottleTable = new THREE.Matrix4().makeTranslation(bottleBase.x, bottleBase.y, bottleBase.z);
  poseRobot(T_GRIP); posePerson(T_GRIP); scene.updateMatrixWorld(true);
  const offGrip = gripR.matrixWorld.clone().invert().multiply(mBottleTable);
  poseRobot(T_RELEASE); posePerson(T_RELEASE); scene.updateMatrixWorld(true);
  const mAtRelease = gripR.matrixWorld.clone().multiply(offGrip);
  const offHand = pHand.matrixWorld.clone().invert().multiply(mAtRelease);

  // ---------------------------------------------------------------- cameras
  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.05, 80);
  const pipCam = new THREE.PerspectiveCamera(50, 4 / 3, 0.05, 30);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  function shot(t, b) {
    const C = (p0, p1, q0, q1, t0, t1, fov = 38) => { const k = ramp(t, t0, t1); return { pos: p0.clone().lerp(p1, k), tgt: q0.clone().lerp(q1, k), fov }; };
    const P = PERSON, A = AT_TABLE, B = BOTTLE, s = t - D;
    if (t < 4) {                                         // hero: slow orbit at the robot's front-left, robot on the right third
      const k = ease(t / 4), a = lerp(-2.3, -2.05, k), r = lerp(3.05, 2.75, k), cx = START.x - 0.15, cy = START.y;
      const pos = V(cx + Math.cos(a) * r, cy + Math.sin(a) * r, lerp(1.35, 1.25, k));
      const d = V(cx - pos.x, cy - pos.y, 0).normalize();
      return { pos, tgt: V(cx, cy, 0.9).addScaledVector(V(-d.y, d.x, 0), 0.6), fov: 40 };
    }
    if (t < 12) return C(V(0.3, -8.0, 10.6), V(-0.2, -7.4, 10.0), V(0, -0.3, 0), V(-0.1, -0.2, 0), 4, 12, 40);
    if (t < 14.5) return C(V(-0.2, -7.4, 10.0), V(0.2, -3.6, 6.2), V(-0.1, -0.2, 0), V(-0.3, 1.5, 0), 12, 14.5, 40);
    if (t < 19) return C(V(P.x + 0.5, P.y - 4.6, 1.75), V(P.x + 0.48, P.y - 4.2, 1.7), V(P.x + 0.5, P.y, 1.12), V(P.x + 0.48, P.y, 1.12), 14.5, 19, 34);
    if (t < 24.5) return C(V(-2.4, -1.7, 3.2), V(-2.2, -1.45, 3.0), V(0.35, 1.15, 0.55), V(0.38, 1.15, 0.55), 19, 24.5, 40);   // from the south-west: the robot turning, the table it finds
    if (t < 31) {                                        // follow from the south-west as it heads for the table
      const k = ramp(t, 24.5, 25.5), m = V(lerp(b.x, TABLE_C.x, 0.4), lerp(b.y, TABLE_C.y, 0.4), 0.45);
      return { pos: V(m.x - 1.7, m.y - 3.3, lerp(2.8, 2.5, k)), tgt: m, fov: 40 };
    }
    if (t < 36.5) return C(V(-2.15, -2.15, 2.5), V(-1.95, -1.95, 2.35), V(0.2, 0.4, 0.45), V(0.22, 0.4, 0.45), 31, 36.5, 38);    // from the south-west: robot, the table's front plane and the target footprint
    if (s >= 30.0 && s < 33.8) {                         // close-up from above the robot's right: the jaws open, close round the bottle, lift
      return C(V(B.x - 0.35, B.y - 0.8, TABLE.h + 0.75), V(B.x - 0.4, B.y - 0.7, TABLE.h + 0.7), V(B.x - 0.1, B.y + 0.02, TABLE.h + 0.13), V(B.x - 0.07, B.y + 0.02, TABLE.h + 0.15), 30.0 + D, 33.8 + D, 30);
    }
    if (s < 37) return C(V(A.x - 0.07, A.y - 3.75, TABLE.h + 1.2), V(A.x + 0.06, A.y - 3.2, TABLE.h + 1.0), V(A.x + 0.13, A.y - 0.1, TABLE.h + 0.2), V(A.x + 0.18, A.y - 0.1, TABLE.h + 0.17), 28 + D, 37 + D, 32);
    if (s < 45) return { pos: V(b.x + 2.4, b.y + 0.9, 2.5), tgt: V(b.x - 0.6, b.y + 0.15, 0.7), fov: 42 };   // chase cam from the east, sees the bottle side
    if (s >= 48.4 && s < 50.3) {                         // close-up on the hand-over: the pull, then the jaws let go
      const h = bottleAtHand;
      return C(V(h.x + 0.35, h.y + 0.8, h.z + 0.55), V(h.x + 0.3, h.y + 0.72, h.z + 0.5), V(h.x, h.y, h.z - 0.03), V(h.x, h.y, h.z - 0.03), 48.4 + D, 50.3 + D, 30);
    }
    if (s < 53) return C(V(P.x + 0.55, P.y - 4.3, 1.66), V(P.x + 0.5, P.y - 4.0, 1.62), V(P.x + 0.55, P.y, 1.12), V(P.x + 0.52, P.y, 1.14), 45 + D, 53 + D, 34);
    return C(V(P.x + 1.2, P.y - 4.3, 2.6), V(0.4, -7.4, 8.6), V(P.x + 1.4, P.y + 0.1, 0.7), V(0, 0, 0), 53 + D, 57 + D, 38);
  }

  // ---------------------------------------------------------------- overlay (DOM)
  const ui = document.createElement('div'); ui.className = 'i7sim-ui'; container.appendChild(ui);
  ui.innerHTML = `
    <div class="i7-veil"></div>
    <div class="i7-steps">${CHAPTERS.filter(c => c.step).map(c => `<span data-id="${c.id}">${c.step}</span>`).join('')}</div>
    <div class="i7-caption"><div class="i7-title"></div><div class="i7-sub"></div></div>
    <div class="i7-card"><div class="i7-card-k"></div><div class="i7-card-t"></div><div class="i7-card-s"></div></div>
    <div class="i7-bubble i7-say-person"></div><div class="i7-bubble i7-say-robot"></div>
    <div class="i7-tag i7-tag-pin">返回点</div><div class="i7-tag i7-tag-table">抽屉桌 · 有水瓶</div>
    <div class="i7-tag i7-tag-goal">导航目标</div><div class="i7-tag i7-tag-pose">目标位姿</div>
    <div class="i7-tag i7-tag-loc">定位正常 · Localized</div><div class="i7-tag i7-tag-grip"></div>
    <div class="i7-pip"><canvas></canvas><span></span></div>
    <div class="i7-align"><div class="i7-tau-h">深度相机 · 对正</div>
      <div class="i7-al-row"><b>偏角</b><i class="i7-al-yaw"></i><em>目标 0.0°</em></div>
      <div class="i7-al-row"><b>距离</b><i class="i7-al-dist"></i><em>目标 0.17 m</em></div>
      <div class="i7-tau-f i7-al-f"></div></div>
    <div class="i7-tau"><div class="i7-tau-h">腕部关节力矩偏差</div><canvas width="520" height="220"></canvas><div class="i7-tau-f"></div></div>
    <div class="i7-badge">仿真示意 · 非实机画面</div>`;
  const $ = (s) => ui.querySelector(s);
  const el = {
    steps: [...ui.querySelectorAll('.i7-steps span')], stepsBox: $('.i7-steps'), caption: $('.i7-caption'),
    title: $('.i7-title'), sub: $('.i7-sub'),
    veil: $('.i7-veil'), card: $('.i7-card'), cardK: $('.i7-card-k'), cardT: $('.i7-card-t'), cardS: $('.i7-card-s'),
    sayP: $('.i7-say-person'), sayR: $('.i7-say-robot'), pin: $('.i7-tag-pin'), table: $('.i7-tag-table'),
    loc: $('.i7-tag-loc'), grip: $('.i7-tag-grip'), pip: $('.i7-pip'), tau: $('.i7-tau'), tauC: $('.i7-tau canvas'), tauF: $('.i7-tau .i7-tau-f'),
    goal: $('.i7-tag-goal'), pose: $('.i7-tag-pose'), pipC: $('.i7-pip canvas'), pipL: $('.i7-pip span'),
    align: $('.i7-align'), alYaw: $('.i7-al-yaw'), alDist: $('.i7-al-dist'), alF: $('.i7-al-f'),
  };
  const pipCtx = el.pipC.getContext('2d');
  // what the detector reports in the head camera: the ten office desks, the drawer table and the bottle on it
  const boxCorners = (x0, x1, y0, y1, z0, z1) => [x0, x1].flatMap(x => [y0, y1].flatMap(y => [z0, z1].map(z => new THREE.Vector3(x, y, z))));
  const DETS = [
    ...DESK_ROWS.flatMap(row => Array.from({ length: DESK.n }, (_, i) => ({ label: '办公桌', conf: 0.88 + 0.02 * ((i * 3 + (row.front > 0 ? 1 : 0)) % 5),
      pts: boxCorners(DESK.x0 + i * DESK.w + 0.02, DESK.x0 + (i + 1) * DESK.w - 0.02, row.y0, row.y1, 0, DESK.h + 0.35), color: 'rgba(255,255,255,0.85)', ink: '#1d1d1f' }))),
    { label: '抽屉桌', conf: 0.94, pts: boxCorners(TABLE.x0, TABLE.x1, TABLE.y0, TABLE.y1, 0, TABLE.h), color: '#0a6cdf', ink: '#fff', key: true },
    { label: '水瓶', conf: 0.97, pts: boxCorners(BOTTLE.x - 0.04, BOTTLE.x + 0.04, BOTTLE.y - 0.04, BOTTLE.y + 0.04, TABLE.h, TABLE.h + 0.22), color: '#ff9f0a', ink: '#1d1d1f', key: true },
  ];
  const facePts = [[0.05, TABLE.y0], [0.05, TABLE.y1], [TABLE.h - 0.02, TABLE.y1], [TABLE.h - 0.02, TABLE.y0]].map(([z, y]) => new THREE.Vector3(TABLE.x0, y, z));
  // project points into the head camera; null if any is behind it
  const pipProject = (pts, pw, ph) => {
    const out = [];
    for (const p of pts) {
      const v = p.clone().applyMatrix4(pipCam.matrixWorldInverse);
      if (v.z > -0.05) return null;
      v.applyMatrix4(pipCam.projectionMatrix);
      out.push([(v.x + 1) / 2 * pw, (1 - v.y) / 2 * ph]);
    }
    return out;
  };
  function drawPip(mode, t, pw, ph, k) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (el.pipC.width !== Math.round(pw * dpr) || el.pipC.height !== Math.round(ph * dpr)) { el.pipC.width = Math.round(pw * dpr); el.pipC.height = Math.round(ph * dpr); }
    const ctx = pipCtx, u = pw / 100;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, pw, ph);
    ctx.font = `600 ${(2.9 * u).toFixed(1)}px "Noto Sans SC", sans-serif`; ctx.textBaseline = 'middle';
    const chip = (text, x, y, bg, ink) => {
      const tw = ctx.measureText(text).width + 2 * u, th = 4.4 * u;
      x = clamp(x, 0, pw - tw); y = clamp(y - th, 0, ph - th);
      ctx.fillStyle = bg; ctx.fillRect(x, y, tw, th); ctx.fillStyle = ink; ctx.fillText(text, x + u, y + th / 2 + 0.2 * u);
    };
    if (mode === 'find') {
      const lock = ramp(t, 22.1, 22.6);
      for (const d of DETS) {
        const q = pipProject(d.pts, pw, ph); if (!q) continue;
        const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
        let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const area = (x1 - x0) * (y1 - y0);
        const cx0 = clamp(x0, 0, pw), cx1 = clamp(x1, 0, pw), cy0 = clamp(y0, 0, ph), cy1 = clamp(y1, 0, ph);
        if ((cx1 - cx0) * (cy1 - cy0) < 0.45 * area || cx1 - cx0 < 3 * u) continue;     // mostly out of frame
        ctx.strokeStyle = d.color; ctx.lineWidth = (d.key ? 0.7 + 0.5 * lock : 0.5) * u;
        ctx.strokeRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
        if (d.label === '水瓶') chip(`${d.label} ${d.conf.toFixed(2)}`, cx1 + 0.6 * u, cy0 + 4.4 * u, d.color, d.ink);   // beside the box, clear of the table's label
        else chip(`${d.label} ${d.conf.toFixed(2)}`, cx0, cy0, d.color, d.ink);
      }
    } else if (mode === 'depth') {
      const q = pipProject(facePts, pw, ph);
      const kk = ramp(t, 31.6, 32.1);
      if (q && kk > 0) {
        ctx.globalAlpha = kk;
        ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
        ctx.fillStyle = 'rgba(255,159,10,0.28)'; ctx.fill(); ctx.strokeStyle = '#ff9f0a'; ctx.lineWidth = 0.7 * u; ctx.stroke();
        const ys = q.map(p => p[1]), xs = q.map(p => p[0]);
        chip('拟合平面', Math.min(...xs), Math.min(...ys), '#ff9f0a', '#1d1d1f');
        ctx.globalAlpha = 1;
      }
      // the camera's centre line, so the plane visibly squares up to it
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 0.3 * u; ctx.setLineDash([1.5 * u, 1.2 * u]);
      ctx.beginPath(); ctx.moveTo(pw / 2, 0); ctx.lineTo(pw / 2, ph); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  const show = (e, o) => { e.style.opacity = o.toFixed(3); e.style.visibility = o > 0.001 ? 'visible' : 'hidden'; };
  const proj = new THREE.Vector3();
  const place = (e, world, dx = 0, dy = 0) => {
    proj.copy(world).project(camera);
    // keep labels below the step chips at the top of the frame
    e.style.left = `${((proj.x + 1) / 2 * 100).toFixed(2)}%`; e.style.top = `${Math.max(15, (1 - proj.y) / 2 * 100).toFixed(2)}%`;
    e.style.transform = `translate(calc(-50% + ${dx}px), calc(-100% + ${dy}px))`;
  };
  const tauCtx = el.tauC.getContext('2d');
  const tauNoise = (() => { const r = rng(11); return Array.from({ length: 400 }, () => (r() - 0.5)); })();
  const tauVal = (s) => 0.14 * tauNoise[Math.floor(clamp(s / 8, 0, 0.999) * 399)] + 0.22 + 1.9 * ease(lin(s, 48.0, 49.7)) * (s < 49.8 ? 1 : 1 - lin(s, 49.8, 50.4));
  function drawTau(t) {
    const W = el.tauC.width, H = el.tauC.height, ctx = tauCtx, x0 = 46.6, x1 = 52.6;
    ctx.clearRect(0, 0, W, H);
    const X = (s) => 10 + (s - x0) / (x1 - x0) * (W - 20), Y = (v) => H - 18 - v / 2.4 * (H - 36);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2;
    for (let v = 0; v <= 2; v += 0.5) { ctx.beginPath(); ctx.moveTo(10, Y(v)); ctx.lineTo(W - 10, Y(v)); ctx.stroke(); }
    ctx.setLineDash([10, 8]); ctx.strokeStyle = 'rgba(255,159,10,0.95)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(10, Y(1.2)); ctx.lineTo(W - 10, Y(1.2)); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = '#4da3ff'; ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.beginPath();
    for (let s = x0; s <= Math.min(t, x1); s += 0.02) { const px = X(s), py = Y(tauVal(s)); s === x0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
    ctx.stroke();
    if (t >= x0) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(X(Math.min(t, x1)), Y(tauVal(Math.min(t, x1))), 7, 0, 7); ctx.fill(); }
  }

  // ---------------------------------------------------------------- frame
  const tmpV = new THREE.Vector3(), headW = new THREE.Vector3(), gripW = new THREE.Vector3();
  const size = { w: 1, h: 1 };
  function resize() {
    const r = container.getBoundingClientRect(); size.w = Math.max(1, r.width); size.h = Math.max(1, r.height);
    renderer.setSize(size.w, size.h, false);
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    camera.aspect = size.w / size.h; camera.updateProjectionMatrix();
    container.style.setProperty('--u', `${size.w / 100}px`);
  }
  resize();

  // interactive: the guided camera runs until the visitor drags the scene, then the camera is theirs
  // (setFree(false) hands it back to the guided shots)
  let controls = null, free = false;
  function setFree(v) {
    free = !!v;
    if (!controls) return;
    controls.enableZoom = free;                                   // until then the wheel scrolls the page
    renderer.domElement.style.touchAction = free ? 'none' : 'pan-y';
    container.classList.toggle('free', free);
  }
  if (mode === 'interactive') {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 1.2; controls.maxDistance = 16;
    controls.addEventListener('change', () => { if (!free) setFree(true); });   // fires only on user input while guided
    setFree(false);
  }

  // cam ({ pos: [x, y, z], tgt: [x, y, z], fov }) overrides the guided shot, for checking a frame from another angle
  function render(t, { clean = false, cam = null } = {}) {
    t = clamp(t, 0, DURATION);
    const b = poseRobot(t);
    posePerson(t);
    // bottle
    scene.updateMatrixWorld(true);
    if (t < T_GRIP) { bottle.matrixAutoUpdate = true; bottle.position.copy(bottleBase); bottle.rotation.set(0, 0, 0); }
    else {
      bottle.matrixAutoUpdate = false;
      const m = t < T_RELEASE ? gripR.matrixWorld.clone().multiply(offGrip) : pHand.matrixWorld.clone().multiply(offHand);
      bottle.matrix.copy(m); bottle.matrixWorldNeedsUpdate = true;
    }
    // map + lidar
    const mapU = t < 4.3 ? 0 : ease(lin(t, 4.3, 11.6)) + (t >= 11.6 ? 1 : 0);
    const mapAlpha = t < 12 ? 1 : lerp(1, 0.55, ramp(t, 12, 14));
    drawMap(t < 4.3 ? -1 : Math.min(1, mapU), mapAlpha);
    const lid = win(t, 4.2, 11.8, 0.3);
    rays.visible = lid > 0.01; rays.material.opacity = 0.3 * lid;
    if (rays.visible) {
      const pos = rayGeo.attributes.position.array, lx = b.x + Math.cos(b.yaw) * 0.3, ly = b.y + Math.sin(b.yaw) * 0.3;
      for (let k = 0; k < NR; k++) {
        const a = b.yaw + (k / NR) * Math.PI * 2, [hx, hy] = MAP.cast(lx, ly, a);
        pos.set([lx, ly, 0.3, hx, hy, 0.02], k * 6);
      }
      rayGeo.attributes.position.needsUpdate = true;
    }
    // path ribbons, pin, pulse
    navRibbon.mesh.visible = t >= 24.5 && t < 31.6;
    navRibbon.mesh.geometry.setDrawRange(0, Math.floor(navRibbon.count * ramp(t, 24.5, 25.9) / 6) * 6);
    navRibbon.mesh.material.opacity = 0.85 * (1 - ramp(t, 30.4, 31.4));
    retRibbon.mesh.visible = t >= 37.0 + D && t < 46 + D;
    retRibbon.mesh.geometry.setDrawRange(0, Math.floor(retRibbon.count * ramp(t, 37.0 + D, 38.4 + D) / 6) * 6);
    retRibbon.mesh.material.opacity = 0.85 * (1 - ramp(t, 44.5 + D, 45.6 + D));
    // detection box, navigation goal, fitted plane, target footprint
    fadeMarker(detBox, [[detMat, 0.9]], win(t, 22.2, 31.2, 0.35), true);
    fadeMarker(goal, [[goalMat, 0.9]], win(t, 23.2, 31.0, 0.35), true);
    fadeMarker(plane, [[planeMat, 0.32], [planeEdge, 0.95]], win(t, 31.6, 36.3, 0.35));
    fadeMarker(foot, [[footMat, 0.9]], win(t, 31.9, 36.0, 0.35));
    const pinK = t < 17.2 ? 0 : t < 45 + D ? 1 : 1 - ramp(t, 45 + D, 46 + D);
    pin.visible = pinK > 0.01; pin.scale.setScalar(Math.max(0.001, pinK * (t < 17.8 ? 0.6 + 0.4 * ease(lin(t, 17.2, 17.8)) : 1)));
    const pk = lin(t, 12.2, 13.8); pulse.visible = t > 12.2 && t < 13.8;
    pulse.scale.setScalar(0.25 + pk * 0.9); pulse.material.opacity = 0.55 * (1 - pk);

    // camera
    if (!(controls && free)) {
      const s = cam ? { pos: V(...cam.pos), tgt: V(...cam.tgt), fov: cam.fov || 38 } : shot(t, b); camera.position.copy(s.pos); camera.lookAt(s.tgt);
      if (camera.fov !== s.fov) { camera.fov = s.fov; camera.updateProjectionMatrix(); }
      if (controls) controls.target.copy(s.tgt);
    } else controls.update();
    scene.updateMatrixWorld(true);

    // main render
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.w, size.h);
    renderer.render(scene, camera);

    // picture-in-picture from the head camera: object detection while looking round, the depth image while
    // squaring up, then the colour image the VLA sees
    const pipMode = t < 28 ? 'find' : t < 36.6 ? 'depth' : 'vla';
    const pipK = clean ? 0 : Math.max(win(t, 19.5, 24.4, 0.3), win(t, 31.2, 44.7, 0.3));
    if (pipK > 0.01) {
      headW.copy(headCamLocal).applyMatrix4(lift.matrixWorld);
      pipCam.position.copy(headW);
      if (pipMode === 'find') tmpV.set(3.0, 0, 0).applyMatrix4(robot.root.matrixWorld).setZ(0.45);
      else if (pipMode === 'depth') tmpV.set(0.62, -0.22, 0).applyMatrix4(robot.root.matrixWorld).setZ(0.4);
      else tmpV.set(0.5, -0.2, 0).applyMatrix4(robot.root.matrixWorld).setZ(TABLE.h + 0.08);
      pipCam.lookAt(tmpV);
      const pw = Math.round(size.w * 0.27), ph = Math.round(pw * 3 / 4), px = Math.round(size.w - pw - size.w * 0.035), py = Math.round(size.h - ph - size.w * 0.035);
      pipCam.aspect = pw / ph; pipCam.updateProjectionMatrix(); pipCam.updateMatrixWorld();
      renderer.setScissorTest(true);
      renderer.setScissor(px, py, pw, ph); renderer.setViewport(px, py, pw, ph);
      if (pipMode === 'depth') {
        const hide = [person.root, rays, navRibbon.mesh, retRibbon.mesh, pin, pulse, mapPlane, ...markers], was = hide.map(o => o.visible);
        hide.forEach(o => { o.visible = false; });
        scene.overrideMaterial = depthMat; scene.background = depthBg;
        renderer.render(scene, pipCam);
        scene.overrideMaterial = null; scene.background = bg;
        hide.forEach((o, i) => { o.visible = was[i]; });
      } else renderer.render(scene, pipCam);
      renderer.setScissorTest(false);
      Object.assign(el.pip.style, { left: `${px}px`, top: `${size.h - py - ph}px`, width: `${pw}px`, height: `${ph}px` });
      if (el.pipL.textContent !== PIP_TEXT[pipMode]) el.pipL.textContent = PIP_TEXT[pipMode];
      if (!clean) drawPip(pipMode, t, pw, ph, pipK);
    }
    show(el.pip, pipK);

    // ---------------- overlay
    ui.style.display = clean ? 'none' : '';
    if (clean) return;
    const ch = CHAPTERS.find(c => t >= c.t0 && t < c.t1) || CHAPTERS[CHAPTERS.length - 1];
    el.steps.forEach(s => s.classList.toggle('on', s.dataset.id === ch.id));
    show(el.stepsBox, win(t, 4.2, 53 + D, 0.5));
    if (ch.title) {
      if (el.title.textContent !== ch.title) { el.title.textContent = ch.title; el.sub.textContent = ch.sub; }
      const k = win(t, ch.t0 + 0.15, ch.t1 - 0.1, 0.45);
      show(el.caption, k); el.caption.style.transform = `translateY(${((1 - k) * 12).toFixed(1)}px)`;
    } else show(el.caption, 0);
    // intro / end title card
    let cardK = 0;
    if (t < 4) { cardK = win(t, 0.3, 3.9, 0.6); [el.cardK.textContent, el.cardT.textContent, el.cardS.textContent] = CARD.intro; }
    else if (t >= 53 + D) { cardK = lin(t, 53.3 + D, 54.1 + D); [el.cardK.textContent, el.cardT.textContent, el.cardS.textContent] = CARD.end; }
    const intro = t < 4;
    el.card.classList.toggle('left', intro); el.veil.classList.toggle('left', intro);
    show(el.card, cardK); show(el.veil, cardK);
    el.card.style.transform = `translate(${intro ? '0' : '-50%'}, calc(-50% + ${((1 - cardK) * 14).toFixed(1)}px))`;
    // speech
    pHead.getWorldPosition(tmpV);
    const sp = t < 30 ? win(t, 15.45, 17.75, 0.3) : t < 53 + D ? win(t, 50.8 + D, 53.0 + D, 0.3) : 0;
    el.sayP.textContent = t < 30 ? SAY.cmd : SAY.thanks;
    place(el.sayP, tmpV.clone().add(V(0, 0, 0.3)), 0, 0); show(el.sayP, sp);
    headW.set(0, 0, 0.44).applyMatrix4(lift.matrixWorld);
    const sr = t < 30 ? win(t, 17.35, 19.25, 0.3) : win(t, 46.4 + D, 49.3 + D, 0.3);
    el.sayR.textContent = t < 30 ? SAY.ok : SAY.give;
    place(el.sayR, headW, 0, 0); show(el.sayR, sr);
    // 3D-pinned tags
    place(el.pin, V(START.x, START.y, 0.55), 0, 0); show(el.pin, t < 30 ? win(t, 17.5, 19.6, 0.4) : win(t, 42.5 + D, 45.2 + D, 0.4));
    place(el.table, V(TABLE_C.x, TABLE_C.y, TABLE.h + 0.36), 0, 0); show(el.table, win(t, 22.4, 30.8, 0.4));
    place(el.goal, V(NAV_END.x, NAV_END.y, 0.25), 0, 0); show(el.goal, win(t, 23.3, 26.6, 0.4));
    place(el.pose, V(AT_TABLE.x, AT_TABLE.y + 0.32, 0.02), 0, 0); show(el.pose, win(t, 32.0, 33.9, 0.3));
    // depth-camera alignment readout: heading error to the plane normal, gap from the chassis front to the plane
    const alK = win(t, 31.4, 36.4, 0.35); show(el.align, alK);
    if (alK > 0.01) {
      const meas = t >= 31.6, yawDeg = Math.abs(wrap(b.yaw)) * 180 / Math.PI, gap = TABLE.x0 - (b.x + Math.cos(b.yaw) * (BASE_TO_CENTER + 0.077));
      el.alYaw.textContent = meas ? `${yawDeg.toFixed(1)}°` : '—'; el.alDist.textContent = meas ? `${gap.toFixed(2)} m` : '—';
      const st = t < ALIGN.turn0 ? 0 : t < ALIGN.move1 + 0.1 ? 1 : 2;
      el.alF.textContent = ALIGN_TEXT[st]; el.alF.classList.toggle('ok', st === 2);
    }
    place(el.loc, V(START.x, START.y, 1.75), 0, 0); show(el.loc, win(t, 12.4, 14.5, 0.35));
    gripR.getWorldPosition(gripW);
    const s = t - D;                                   // grasp and hand-over overlays keep the first cut's timing
    el.grip.textContent = s < 45 ? '夹紧' : '松开';
    el.grip.classList.toggle('warn', s >= 45);
    place(el.grip, gripW.clone().add(V(0, 0, 0.12)), 0, 0); show(el.grip, s < 45 ? win(s, 32.8, 35.2, 0.25) : win(s, 49.35, 50.9, 0.25));
    // force chart
    const tauK = win(s, 46.6, 52.6, 0.4); show(el.tau, tauK);
    if (tauK > 0.01) { drawTau(s); el.tauF.textContent = TAU_TEXT[s < 48.0 ? 0 : s < 49.3 ? 1 : 2]; el.tauF.classList.toggle('hit', s >= 49.3); }
  }

  // product shot: the robot alone on white, arms at rest, seen from azimuth az (radians, robot faces +x),
  // aimed at height `look` from `dist` metres away
  function renderStudio(az = -0.65, { look = 0.84, dist = 4.6, fov = 25 } = {}) {
    const hidden = [lab, chair.root, person.root, bottle, mapPlane, rays, navRibbon.mesh, retRibbon.mesh, pin, pulse, ...markers];
    hidden.forEach(o => { o.visible = false; });
    studioFloor.visible = true; scene.background = new THREE.Color(0xffffff); ui.style.display = 'none';
    robotRoot.position.set(BASE_TO_CENTER, 0, 0); robotRoot.rotation.set(0, 0, 0);
    robot.set('Shoulder_Base', 0); setArm('Right', REST_R); setArm('Left', REST_L);
    camera.position.set(Math.cos(az) * dist, Math.sin(az) * dist, look + 0.46 * dist / 4.6); camera.lookAt(0, 0, look);
    camera.fov = fov; camera.updateProjectionMatrix();
    scene.updateMatrixWorld(true);
    renderer.setScissorTest(false); renderer.setViewport(0, 0, size.w, size.h);
    renderer.render(scene, camera);
    hidden.forEach(o => { o.visible = true; });
    studioFloor.visible = false; scene.background = bg;   // the overlay stays hidden until the next render(t)
  }

  return {
    render, renderStudio, resize, duration: DURATION, chapters: CHAPTERS, renderer, camera,
    setFree,
    get free() { return free; },
    dispose() { renderer.dispose(); container.innerHTML = ''; },
  };
}

// Overlay styles shared by the film page and the site viewer. Sizes scale with the viewport width (--u = 1% of it).
export const OVERLAY_CSS = `
.i7sim{position:relative;overflow:hidden;--u:10px;font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;}
.i7sim-canvas{display:block;width:100%;height:100%;}
.i7sim-ui{position:absolute;inset:0;pointer-events:none;color:#1d1d1f;}
.i7sim-ui>*{position:absolute;visibility:hidden;opacity:0;}
.i7-steps{left:50%;top:calc(var(--u)*2.6);transform:translateX(-50%);display:flex;gap:calc(var(--u)*0.35);padding:calc(var(--u)*0.32);border-radius:999px;background:rgba(255,255,255,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 1px 0 rgba(0,0,0,.04),0 8px 30px rgba(0,0,0,.06);}
.i7-steps span{font-size:calc(var(--u)*0.92);font-weight:500;color:#6e6e73;padding:calc(var(--u)*0.32) calc(var(--u)*0.95);border-radius:999px;letter-spacing:.02em;}
.i7-steps span.on{background:#1d1d1f;color:#fff;}
.i7-caption{left:calc(var(--u)*4);bottom:calc(var(--u)*3.6);max-width:calc(var(--u)*46);text-shadow:0 0 calc(var(--u)*1) rgba(245,245,247,.95),0 0 calc(var(--u)*.3) rgba(245,245,247,.9);}
.i7-title{font-size:calc(var(--u)*2.7);font-weight:700;letter-spacing:-.01em;line-height:1.18;color:#1d1d1f;}
.i7-sub{font-size:calc(var(--u)*1.12);color:#424245;margin-top:calc(var(--u)*0.6);line-height:1.5;}
.i7-veil{inset:0;background:rgba(245,245,247,.86);}
.i7-veil.left{background:linear-gradient(90deg,rgba(245,245,247,.96) 0%,rgba(245,245,247,.8) 34%,rgba(245,245,247,0) 58%);}
.i7-card{left:50%;top:46%;text-align:center;width:calc(var(--u)*80);}
.i7-card.left{left:calc(var(--u)*7);top:50%;text-align:left;width:calc(var(--u)*42);}
.i7-card-k{font-size:calc(var(--u)*1.15);font-weight:600;color:#0a6cdf;letter-spacing:.08em;}
.i7-card-t{font-size:calc(var(--u)*5.4);font-weight:800;letter-spacing:-.02em;line-height:1.1;margin:calc(var(--u)*0.7) 0;color:#1d1d1f;}
.i7-card-s{font-size:calc(var(--u)*1.35);color:#424245;}
.i7-bubble{padding:calc(var(--u)*0.7) calc(var(--u)*1.15);border-radius:calc(var(--u)*1.2);font-size:calc(var(--u)*1.35);font-weight:600;background:#fff;color:#1d1d1f;box-shadow:0 10px 30px rgba(0,0,0,.12);white-space:nowrap;margin-top:calc(var(--u)*-0.8);}
.i7-say-robot{background:#0a6cdf;color:#fff;}
.i7-tag{padding:calc(var(--u)*0.32) calc(var(--u)*0.75);border-radius:999px;font-size:calc(var(--u)*0.95);font-weight:600;background:#1d1d1f;color:#fff;white-space:nowrap;margin-top:calc(var(--u)*-0.5);}
.i7-tag-pin,.i7-tag-loc{background:#0a6cdf;}
.i7-tag-grip.warn{background:#ff9f0a;color:#1d1d1f;}
.i7-pip{border:calc(var(--u)*0.18) solid #fff;border-radius:calc(var(--u)*0.4);box-shadow:0 12px 40px rgba(0,0,0,.18);box-sizing:border-box;}
.i7-pip canvas{position:absolute;inset:0;width:100%;height:100%;}
.i7-pip span{position:absolute;left:calc(var(--u)*0.6);top:calc(var(--u)*0.6);font-size:calc(var(--u)*0.9);font-weight:600;color:#fff;background:rgba(0,0,0,.55);padding:calc(var(--u)*0.22) calc(var(--u)*0.6);border-radius:999px;}
.i7-tau{left:calc(var(--u)*4);top:calc(var(--u)*6.5);width:calc(var(--u)*22);padding:calc(var(--u)*1.1);border-radius:calc(var(--u)*1.2);background:rgba(29,29,31,.88);color:#f5f5f7;box-sizing:border-box;}
.i7-tau-h{font-size:calc(var(--u)*0.95);font-weight:600;color:#a1a1a6;margin-bottom:calc(var(--u)*0.5);}
.i7-tau canvas{width:100%;height:auto;display:block;}
.i7-tau-f{font-size:calc(var(--u)*1.15);font-weight:700;margin-top:calc(var(--u)*0.5);}
.i7-tau-f.hit{color:#ff9f0a;}
.i7-tag-goal{background:#0a6cdf;}
.i7-tag-table{background:#0a6cdf;}
.i7-align{left:calc(var(--u)*4);top:calc(var(--u)*6.5);width:calc(var(--u)*22);padding:calc(var(--u)*1.1);border-radius:calc(var(--u)*1.2);background:rgba(29,29,31,.88);color:#f5f5f7;box-sizing:border-box;}
.i7-al-row{display:flex;align-items:baseline;gap:calc(var(--u)*0.8);margin-top:calc(var(--u)*0.35);}
.i7-al-row b{font-size:calc(var(--u)*1.0);font-weight:500;color:#a1a1a6;width:calc(var(--u)*2.6);}
.i7-al-row i{font-style:normal;font-size:calc(var(--u)*2.1);font-weight:700;font-variant-numeric:tabular-nums;width:calc(var(--u)*8.6);}
.i7-al-row em{font-style:normal;font-size:calc(var(--u)*0.9);color:#86868b;}
.i7-al-f{margin-top:calc(var(--u)*0.7);}
.i7-al-f.ok{color:#30d158;}
.i7-badge{right:calc(var(--u)*1.6);bottom:calc(var(--u)*1.4);font-size:calc(var(--u)*0.82);color:#86868b;visibility:visible;opacity:1;}
`;
