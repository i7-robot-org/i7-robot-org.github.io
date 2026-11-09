// The site's two robot-only scenes, built on the same URDF robot as the simulator (i7sim.js):
//   createHero(container)      i7 alone on a studio floor, looping through a few moves: wave, spin in place,
//                              lift down and up, open both arms. Drag sideways to turn the view.
//   createExplorer(container)  the "meet i7" viewer: drag to turn the robot; buttons on the side highlight one
//                              subsystem at a time (structure, size, lift, arms, sensors, compute, I/O, safety)
//                              with callouts, dimension lines and small animations, and show its numbers.
// Facts come from the vendor manual V0.1, the SDK manual and URDF V1.5; see the notes in each mode.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadMeshes, materials, buildRobot, ARM_JOINTS, BASE_TO_CENTER } from './i7sim.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => { k = clamp(k); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
const ramp = (t, t0, t1) => ease((t - t0) / (t1 - t0));
const lin = (t, t0, t1) => clamp((t - t0) / (t1 - t0));
const win = (t, a, b, f = 0.35) => Math.min(lin(t, a, a + f), 1 - lin(t, b - f, b));
const bump = (t, a, b) => Math.pow(Math.sin(Math.PI * lin(t, a, b)), 2);   // 0 -> 1 -> 0 over [a, b]
const mixQ = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
// right-arm joint vector -> the matching left-arm one (joints about x and z change sign, joints about y do not)
const mirror = (q) => [q[0], -q[1], -q[2], q[3], -q[4], -q[5], q[6]];

const FLOOR_OFFSET = 0.042;          // the lowest wheel point sits 4.2 cm below base_link's origin
const SHOULDER_Z = 1.36535;          // lift joint origin in base_link (URDF), lift travel -1 ... 0 m
const REST_R = [0.12, -0.08, 0, -0.28, 0, 0, 0.1];
const GRIP = { rest: 0.006, open: 0.045 };
const ACCENT = 0x0a6cdf;

// ---------------------------------------------------------------- shared stage
function makeStage(container, { fov = 28 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = 'stage3d-canvas';
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9dce4, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2.4, -3.0, 5.2); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -1.7, right: 1.7, top: 1.7, bottom: -1.7, near: 1, far: 14 });
  key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02; key.shadow.radius = 5;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xe4ecff, 0.7); rim.position.set(-3.2, 2.6, 3.4); scene.add(rim);

  // floor: a soft contact shadow and three faint rings, so the robot stands on something without a visible edge
  const floor = new THREE.Mesh(new THREE.CircleGeometry(5, 64), new THREE.ShadowMaterial({ opacity: 0.14 }));
  floor.receiveShadow = true; scene.add(floor);
  [0.75, 1.15, 1.6].forEach((r, i) => {
    const pts = Array.from({ length: 129 }, (_, k) => new THREE.Vector3(Math.cos(k / 128 * Math.PI * 2) * r, Math.sin(k / 128 * Math.PI * 2) * r, 0.001));
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.16 - i * 0.04 })));
  });

  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.05, 40);
  const size = { w: 1, h: 1 };
  const resize = () => {
    const r = container.getBoundingClientRect();
    size.w = Math.max(1, Math.round(r.width)); size.h = Math.max(1, Math.round(r.height));
    renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container); resize();
  return { renderer, scene, camera, size };
}

// render loop that only runs while the container is on screen and the tab is visible.
// onFirst runs after the first frame that drew; a frame that throws is logged once and the loop carries on.
function runLoop(container, step, onFirst) {
  let visible = false, raf = 0, last = 0, t = 0, drawn = false, failed = false;
  const frame = (now) => {
    raf = 0;
    if (!visible || document.hidden) return;
    t += Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
    try {
      step(t);
      if (!drawn) { drawn = true; onFirst?.(); }
    } catch (e) { if (!failed) { failed = true; console.error(e); } }
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  // a busy page can batch several entries into one callback (e.g. off screen, then on screen after a scroll):
  // the newest one is the current state
  new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) start(); }, { rootMargin: '120px' }).observe(container);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible) start(); });
}

async function makeRobot(meshUrl) {
  const meshes = await loadMeshes(meshUrl);
  const M = materials();
  const robot = buildRobot(meshes, M);
  robot.root.position.z = FLOOR_OFFSET;
  const root = new THREE.Group(); root.add(robot.root);
  const setArm = (side, q) => ARM_JOINTS(side).forEach((n, i) => robot.set(n, q[i]));
  // turn about the chassis centre, which sits BASE_TO_CENTER behind base_link's origin
  const place = (yaw) => { root.position.set(Math.cos(yaw) * BASE_TO_CENTER, Math.sin(yaw) * BASE_TO_CENTER, 0); root.rotation.set(0, 0, yaw); };
  const apply = (s) => {
    place(s.yaw); robot.set('Shoulder_Base', s.lift);
    setArm('Right', s.R); setArm('Left', s.L);
    robot.setGrip('Right', s.gR); robot.setGrip('Left', s.gL);
  };
  return { M, robot, root, setArm, place, apply };
}
const restState = (yaw = 0) => ({ yaw, lift: 0, R: REST_R.slice(), L: mirror(REST_R), gR: GRIP.rest, gL: GRIP.rest });
const mixState = (a, b, k) => ({
  yaw: lerp(a.yaw, b.yaw, k), lift: lerp(a.lift, b.lift, k), R: mixQ(a.R, b.R, k), L: mixQ(a.L, b.L, k),
  gR: lerp(a.gR, b.gR, k), gL: lerp(a.gL, b.gL, k),
});

// ---------------------------------------------------------------- hero: a 20 s loop of small moves
// right arm out to the side, elbow up, gripper pointing at the sky; the wave swings the forearm about the elbow
const WAVE_R = [-0.2, -1.35, Math.PI / 2, 1.6, 0, 0, 0];
const SPIN_R = [0.05, -0.34, 0, -0.4, 0, 0, 0.1];            // arms swing out a little while it spins
const OPEN_R = [-0.3, -1.25, 0, -0.5, 0, 0, 0];               // both arms open out to the sides, elbows soft
const DIP_R = [-0.3, -0.12, 0, -0.9, 0, 0, 0.2];               // forearms forward while the lift dips, hands clear of the deck
const HERO_LOOP = 20, HERO_YAW = -0.3;
const HERO_ACTS = [['挥手', 1.2, 6.6], ['原地转圈', 6.8, 11.4], ['升降', 11.6, 13.9], ['张开双臂', 14.0, 18.3]];

function heroState(time) {
  const t = time % HERO_LOOP, s = restState(HERO_YAW);
  // idle: the lift breathes a few millimetres
  s.lift = -0.006 * (1 - Math.cos(time * 1.4));
  // wave
  const wave = WAVE_R.slice(); wave[3] += 0.32 * Math.sin((t - 2.4) * Math.PI * 2) * win(t, 2.4, 5.4, 0.4);
  s.R = mixQ(s.R, wave, ramp(t, 1.2, 2.4) * (1 - ramp(t, 5.4, 6.6)));
  // spin a full turn in place
  s.yaw += Math.PI * 2 * ramp(t, 6.8, 11.4);
  const fling = 0.85 * bump(t, 6.8, 11.4);
  s.R = mixQ(s.R, SPIN_R, fling); s.L = mixQ(s.L, mirror(SPIN_R), fling);
  // lift down and back up
  const dip = bump(t, 11.6, 13.9);
  s.lift -= 0.32 * dip;
  s.R = mixQ(s.R, DIP_R, Math.min(1, dip * 1.6)); s.L = mixQ(s.L, mirror(DIP_R), Math.min(1, dip * 1.6));
  // both arms open out
  const off = ramp(t, 14.0, 15.2) * (1 - ramp(t, 16.9, 18.3));
  s.R = mixQ(s.R, OPEN_R, off); s.L = mixQ(s.L, mirror(OPEN_R), off);
  // grippers: open while waving, snap twice at the bottom of the lift, open with the arms
  const g = Math.max(win(t, 2.5, 5.3, 0.3), win(t, 12.1, 12.55, 0.15), win(t, 12.75, 13.2, 0.15), win(t, 15.0, 16.9, 0.3));
  s.gR = lerp(GRIP.rest, GRIP.open, g);
  s.gL = lerp(GRIP.rest, GRIP.open, Math.max(win(t, 12.1, 12.55, 0.15), win(t, 12.75, 13.2, 0.15), win(t, 15.0, 16.9, 0.3)));
  return { s, t };
}

export async function createHero(container, { meshUrl = './assets/i7_mesh.json' } = {}) {
  const st = makeStage(container, { fov: 25 });
  const R = await makeRobot(meshUrl);
  st.scene.add(R.root);
  const cam = st.camera, az = -0.5, dist = 5.5;
  cam.position.set(Math.cos(az) * dist, Math.sin(az) * dist, 1.3);
  const controls = new OrbitControls(cam, st.renderer.domElement);
  controls.target.set(0, 0, 0.86);
  Object.assign(controls, { enableZoom: false, enablePan: false, enableDamping: true, dampingFactor: 0.08, rotateSpeed: 0.6,
    minPolarAngle: 1.05, maxPolarAngle: 1.62 });
  st.renderer.domElement.style.touchAction = 'pan-y';        // vertical swipes still scroll the page on phones
  // narrower frames (phones) step the camera back so the open arms stay in shot
  const fit = () => { const r = container.getBoundingClientRect(); const d = Math.max(dist, 6.4 * r.height / Math.max(1, r.width));
    cam.position.sub(controls.target).setLength(d).add(controls.target); };
  new ResizeObserver(fit).observe(container); fit();
  controls.update();

  const acts = document.createElement('div'); acts.className = 'hero-acts'; acts.setAttribute('aria-hidden', 'true');
  acts.innerHTML = HERO_ACTS.map(([n]) => `<span>${n}</span>`).join('');
  container.appendChild(acts);
  const chips = [...acts.children];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  runLoop(container, (time) => {
    const { s, t } = heroState(still ? 3.4 : time);
    R.apply(s);
    R.robot.led.material.emissiveIntensity = 1.2 + 0.5 * Math.sin(time * 2.2);
    chips.forEach((c, i) => c.classList.toggle('on', t >= HERO_ACTS[i][1] && t < HERO_ACTS[i][2]));
    controls.update();
    st.renderer.render(st.scene, cam);
  }, () => container.classList.add('live'));                // the photo stays up until the robot is drawn
}

// ---------------------------------------------------------------- explorer
const ARM_INFO = [   // right-arm joints in chain order, URDF limits
  ['J1', '肩部俯仰', '±180°', 'sh'], ['J2', '肩部横滚', '−220° ~ +40°', 'sh'], ['J3', '上臂旋转', '±180°', 'el'],
  ['J4', '肘部俯仰', '±139°', 'el'], ['J5', '前臂旋转', '±180°', 'wr'], ['J6', '腕部横滚', '±60°', 'wr'], ['J7', '腕部俯仰', '−95° ~ +105°', 'wr'],
];
const ARM_SWEEP = [0.55, 0.45, 0.9, 0.55, 0.9, 0.5, 0.6];       // demo swing per joint (rad), inside the limits
const ARM_SHOW_R = [-0.45, -0.22, 0, -1.15, 0, 0, 0.2];         // forearm forward, so every joint's motion reads
const LIFT_R = [-0.9, -0.2, 0, -2.2, 0, 0, 0.4];                // elbows out in front of the chassis, forearms straight up: clear of the deck at the bottom
const SAG_R = [-1.45, -0.18, 0, -0.35, 0, 0, 0.1];              // arms held out before the e-stop
const STEP = 1.7;                                                // seconds per joint in the arm tour

const isArm = (l) => /^(Shoulder_(Pitch|Roll)|Elbow|Wrist)/.test(l);
const isHand = (l) => /^(Gripper|falan)/.test(l);
const region = (m) => m.split('@')[1] || '';
const mat = (m) => m.split('@')[0];
const SUBSYS = [
  { name: '移动底盘', sel: (l, m) => l === 'base_link' && region(m) === 'chassis' },
  { name: '升降躯干', sel: (l, m) => (l === 'base_link' && region(m) === 'column') || l === 'head' || (l === 'Shoulder_Base' && ['shell', 'graphite'].includes(m)) },
  { name: '双 7 自由度机械臂', sel: (l) => isArm(l) },
  { name: '平行夹爪', sel: (l) => isHand(l) },
  { name: '相机与雷达', sel: (l, m) => (l === 'Shoulder_Base' && !['shell', 'graphite'].includes(m)) || (l.startsWith('falan') && m === 'camera') || mat(m) === 'lidar' },
];
const SENSOR = (l, m) => (l === 'Shoulder_Base' && ['camera', 'black', 'blue'].includes(m)) || (l.startsWith('falan') && ['camera', 'black'].includes(m)) || mat(m) === 'lidar';

// callout anchors, in link coordinates
const AT = {
  headCam: ['Shoulder_Base', [0.04, 0, 0.31]], wristR: ['falan_Right', [0.11, 0, -0.05]], wristL: ['falan_Left', [0.11, 0, -0.05]],
  lidarFL: ['base_link', [-0.03, 0.2, 0.32]], lidarRR: ['base_link', [-0.51, -0.2, 0.32]],
  chassis: ['base_link', [-0.12, -0.27, 0.2]], column: ['base_link', [-0.1, -0.13, 0.95]], shoulder: ['Shoulder_Base', [0, -0.12, 0.03]],
  arm: ['Elbow_Pitch_Right', [0, -0.05, 0]], grip: ['Gripper_Right', [0, 0, 0.03]], light: ['base_link', [-0.22, 0.12, 1.51]],
  estop: ['base_link', [-0.38, 0, 1.12]], tablet: ['base_link', [-0.4, 0, 1.31]], cover: ['base_link', [-0.37, 0, 0.98]],
  charge: ['base_link', [-0.6, 0, 0.19]], compute: ['base_link', [-0.27, 0, 0.21]],
};

const MODES = [
  {
    id: 'overview', label: '整机结构', cam: { az: -0.62, el: 0.1, dist: 4.6, look: [0, 0, 0.84] }, spin: true,
    title: '一台会走、会升降、有两只手的机器人',
    lead: 'i7 是轮式双臂移动操作机器人。底盘负责移动，躯干负责升降，两条 7 自由度机械臂带平行夹爪负责操作，头部和手腕相机负责感知。',
    stats: [['2×7', '机械臂自由度'], ['≈182', 'kg · 整机质量'], ['5', '个子系统']],
    rows: [['底盘', '全向移动底盘，四角驱动轮'], ['躯干', '立柱升降，肩部可下移 1 m'], ['手臂', '双 7 自由度机械臂 + 平行夹爪'], ['感知', '头部相机、双腕相机、底盘激光雷达']],
    note: '整机质量为 URDF 各连杆质量合计，未实测。',
    callouts: [['chassis', '移动底盘'], ['column', '升降躯干'], ['arm', '7 自由度机械臂'], ['grip', '平行夹爪'], ['headCam', '头部相机']],
  },
  {
    id: 'size', label: '外形尺寸', cam: { az: -0.75, el: 0.12, dist: 4.4, look: [0, 0, 0.8] },
    title: '比人略高，底盘一张课桌大小',
    lead: '肩部升到顶时整机约 1.76 m 高；底盘约 0.68 × 0.55 m，可通过实验室常规过道和门。',
    stats: [['≈1.76', 'm · 高度（升到顶）'], ['0.68×0.55', 'm · 底盘'], ['≈0.99', 'm · 单臂长度']],
    rows: [['高度', '≈1.76 m，含轮子，肩部升到顶'], ['底盘', '长 ≈0.68 m，宽 ≈0.55 m'], ['单臂', '≈0.99 m，肩关节到夹爪指尖'], ['质量', '≈182 kg']],
    note: '尺寸由 URDF 网格包围盒估算，以实机测量为准。',
    callouts: [],
  },
  {
    id: 'lift', label: '升降', cam: { az: -0.85, el: 0.1, dist: 4.5, look: [0.1, 0, 0.82] },
    title: '肩部整体上下移动 1 米',
    lead: '双臂和头部相机装在同一个肩部模块上，沿立柱上下移动，取放高度从地面覆盖到高处货架。',
    stats: [['1.0', 'm · 升降行程'], ['0.41~1.41', 'm · 肩关节离地']],
    rows: [['行程', '1.0 m（URDF 平移关节 −1 ~ 0 m）'], ['控制', '升降走 NRT 接口，需先切换 motion unit 与模式'], ['用途', '取水时按桌面高度调整肩高，再交给 VLA 抓取']],
    note: '肩关节离地高度按 URDF 与轮子最低点估算。',
    callouts: [],
  },
  {
    id: 'arms', label: '机械臂', cam: { az: -0.3, el: 0.14, dist: 4.0, look: [0.2, -0.1, 0.98] },
    title: '每条手臂 7 个关节',
    lead: '肩 2 个、肘 2 个、腕 3 个。比 6 自由度多一个冗余关节，同一末端位置可用不同手臂姿态到达，便于避障。',
    stats: [['7', '关节 / 臂'], ['126', 'N·m · 肩部力矩上限'], ['≈0.99', 'm · 臂长']],
    rows: [['关节力矩上限', '肩 126 · 肘 85 · 腕 26 N·m'], ['关节范围', '肘俯仰 ±139°，腕横滚 ±60°，腕俯仰 −95° ~ +105°'], ['末端', '平行夹爪，腕部带相机'], ['反馈', '每个关节都有位置、速度和力矩 tau']],
    note: '关节范围与力矩上限取自 URDF V1.5 的 limit / effort 参数。',
    callouts: [],
  },
  {
    id: 'sense', label: '感知', cam: { az: -0.7, el: 0.22, dist: 4.9, look: [0.25, 0, 0.86] },
    title: '三路相机，加底盘激光雷达',
    lead: '头部相机看全局，双腕相机贴近夹爪看细节，均输出 RGB 和深度；底盘激光雷达用于建图和定位。',
    stats: [['3', '路相机 · RGB + 深度'], ['2', '处雷达位（底盘对角）']],
    rows: [['相机', '头部 1 路 + 双腕各 1 路，RGB 与 Z16 深度流'], ['相机接入', 'camera_service Python SDK（Python 3.12，机载运行）'], ['激光雷达', '建图与定位用；手册提到左前方雷达罩'], ['IMU', '独立 IMU 数据接口手册标注“暂不支持”']],
    note: '相机路数与数据格式来自手册；雷达位置按 URDF 模型标出，左前、右后对角各一处。',
    callouts: [['headCam', '头部相机'], ['wristR', '腕部相机'], ['wristL', '腕部相机'], ['lidarFL', '激光雷达（左前）'], ['lidarRR', '雷达位（右后）']],
  },
  {
    id: 'compute', label: '计算', cam: { az: -0.95, el: 0.3, dist: 3.6, look: [0.36, 0.26, 0.62] },
    title: '机载 NVIDIA Thor，所有程序都跑在车上',
    lead: '导航、相机服务、运动控制 SDK，以及 Demo 新增的 ROS 2 节点和 π0.5 推理，都运行在机载 Thor 上。',
    stats: [['2070', 'TFLOPS（FP4）'], ['128', 'GB 内存']],
    rows: [['运行在上面', '厂商 SLAM 与 Nav2（Docker）、相机服务、SDK 控制器'], ['Demo 新增', 'ROS 2 任务节点、VLA（π0.5）推理'], ['连接', '有线 192.168.6.1，也可接入 Wi-Fi'], ['系统', '上位机支持 Ubuntu 22.04 / 24.04']],
    note: '手册只写“机载 Thor”，模组型号待厂商确认；算力、内存等数值按 Jetson AGX Thor（T5000）公开规格。计算单元在机身里的位置为示意。',
    callouts: [],
  },
  {
    id: 'io', label: '操作入口', cam: { az: 2.55, el: 0.12, dist: 4.1, look: [-0.25, 0, 0.8] },
    title: '手柄、头显、网页、终端，四种方式控制',
    lead: '底盘手柄用于日常移动，PICO 头显用于遥操作示教，网页与上位机查看状态和地图，SSH 用于开发调试。接口集中在机身背面。',
    stats: [['4', '种操作入口'], ['0.2', 'm/s · 遥操作默认限速']],
    rows: [['底盘手柄', 'USB 接收器插在充电口上方的 USB-A'], ['PICO 遥操作', '接管双臂与夹爪，可同步录制示教数据'], ['网页 / 上位机', '有线地址 192.168.6.1'], ['磁吸盖板', 'USB-A、网口、HDMI'], ['遥操作限速', '0.2 m/s、0.5 rad/s（配置默认值，不是硬件上限）']],
    note: '接口位置来自手册插图，模型中的标注为示意。',
    callouts: [['tablet', '背部平板（选配）'], ['cover', '磁吸盖板：USB-A · 网口 · HDMI'], ['charge', '充电接口 · 手柄接收器']],
  },
  {
    id: 'safety', label: '安全', cam: { az: 2.72, el: 0.16, dist: 4.8, look: [0.1, 0, 0.8] },
    title: '急停在背后，拍下后手臂会下垂',
    lead: '背部红色按钮为急停。拍下后双臂整臂断电，伸出的手臂会因重力下垂，可能碰到左前方雷达罩；操作时机器人四周需留出 1.5 m。',
    stats: [['1.5', 'm · 四周留空'], ['1', '个急停 · 背部']],
    rows: [['急停', '背部红色按钮，中止主动运动'], ['断电下垂', '双臂整臂断电，部分姿态下会下垂'], ['留空', '机器人四周至少 1.5 m 无人、无障碍'], ['异常', '冒烟、异响、异味：先拍急停，再断电联系厂商']],
    note: '内容来自手册“安全与急停”一节；下垂动画为示意。',
    callouts: [['estop', '急停按钮'], ['lidarFL', '左前雷达罩']],
  },
];

const THOR_CARD = `
  <div class="xp-zoom-h"><b>NVIDIA Jetson Thor</b><span>机载计算单元</span></div>
  <svg class="xp-chip" viewBox="0 0 240 120" aria-hidden="true">
    <rect x="4" y="8" width="232" height="104" rx="10" fill="#1d1f24"/>
    <g fill="#2c3038">${[16, 40, 64, 88].map(y => `<rect x="14" y="${y}" width="26" height="16" rx="2"/><rect x="200" y="${y}" width="26" height="16" rx="2"/>`).join('')}</g>
    <rect x="66" y="22" width="108" height="76" rx="6" fill="#3a3f49"/>
    <rect x="80" y="34" width="80" height="52" rx="4" fill="#0a6cdf" class="die"/>
    <text x="120" y="66" text-anchor="middle" font-size="15" font-weight="800" fill="#fff" font-family="Inter, sans-serif">THOR</text>
    <g stroke="#59606d" stroke-width="2">${Array.from({ length: 9 }, (_, i) => `<line x1="${74 + i * 12}" y1="14" x2="${74 + i * 12}" y2="20"/><line x1="${74 + i * 12}" y1="100" x2="${74 + i * 12}" y2="106"/>`).join('')}</g>
  </svg>
  <dl>
    <dt>AI 算力</dt><dd>2070 TFLOPS（FP4）</dd>
    <dt>GPU</dt><dd>Blackwell · 2560 CUDA 核 · 96 Tensor 核</dd>
    <dt>CPU</dt><dd>14 核 Arm Neoverse-V3AE</dd>
    <dt>内存</dt><dd>128 GB LPDDR5X</dd>
    <dt>功耗</dt><dd>40–130 W</dd>
  </dl>
  <p>参考 Jetson AGX Thor（T5000）公开规格，实机型号待确认</p>`;

const ICONS = {
  overview: '<path d="M9 33h22M12 33l2-6h12l2 6M15 27V14h10v13M14 14l-5 8M26 14l5 8"/><circle cx="20" cy="9" r="3"/>',
  size: '<path d="M6 34V6M3 9l3-3 3 3M3 31l3 3 3-3M14 34h22M17 31l-3 3 3 3M33 31l3 3-3 3"/><rect x="16" y="9" width="16" height="18" rx="2"/>',
  lift: '<rect x="15" y="4" width="10" height="32" rx="3"/><path d="M8 13l-3-3-3 3M5 10v20M8 27l-3 3-3-3M15 18h10"/>',
  arms: '<circle cx="9" cy="31" r="3"/><circle cx="18" cy="15" r="3"/><circle cx="31" cy="12" r="3"/><path d="M10.5 28.5l6-11M21 14.5l7-1.5M33 15l2 6M33 15l-3 6"/>',
  sense: '<rect x="4" y="12" width="32" height="18" rx="4"/><circle cx="14" cy="21" r="4"/><circle cx="26" cy="21" r="4"/><path d="M12 6h16"/>',
  compute: '<rect x="10" y="10" width="20" height="20" rx="3"/><rect x="15" y="15" width="10" height="10" rx="1"/><path d="M15 4v6M20 4v6M25 4v6M15 30v6M20 30v6M25 30v6M4 15h6M4 20h6M4 25h6M30 15h6M30 20h6M30 25h6"/>',
  io: '<path d="M7 17c0-3 2-5 5-5h16c3 0 5 2 5 5v4c0 3-2 5-5 5-2 0-3-2-5-2h-6c-2 0-3 2-5 2-3 0-5-2-5-5z"/><path d="M13 19h4M15 17v4"/><circle cx="26" cy="19" r="1.2" fill="currentColor"/>',
  safety: '<circle cx="20" cy="20" r="14"/><circle cx="20" cy="20" r="7" fill="currentColor" fill-opacity=".18"/><path d="M20 6v4M20 30v4"/>',
};

// fresnel "x-ray" look for the parts that are not in focus
function ghostMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { color: { value: new THREE.Color(0x6f9bd8) }, base: { value: 0.035 }, rim: { value: 0.42 } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 color; uniform float base, rim; varying vec3 vN; varying vec3 vV;
      void main() { float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0); gl_FragColor = vec4(color, base + rim * f); }`,
  });
}

// a translucent pyramid for a camera's field of view, apex at the origin, looking along +x
function frustum(len, hfov, vfov, color = ACCENT) {
  const w = Math.tan(hfov / 2) * len, h = Math.tan(vfov / 2) * len;
  const c = [[len, -w, -h], [len, w, -h], [len, w, h], [len, -w, h]];
  const pos = [];
  for (let i = 0; i < 4; i++) pos.push(0, 0, 0, ...c[i], ...c[(i + 1) % 4]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
  const e = []; c.forEach((p, i) => e.push(0, 0, 0, ...p, ...p, ...c[(i + 1) % 4]));
  const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(e, 3));
  const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
  const grp = new THREE.Group(); grp.add(fill, edges); grp.userData.fade = [fill.material, edges.material];
  return grp;
}

// a rotating radar sweep on a horizontal disc
function sweepDisc(radius) {
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { angle: { value: 0 }, color: { value: new THREE.Color(ACCENT) }, k: { value: 1 } },
    vertexShader: 'varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float angle, k; uniform vec3 color; varying vec2 vP;
      void main() {
        float r = length(vP) / ${radius.toFixed(3)};
        float a = mod(angle - atan(vP.y, vP.x), 6.28318);
        float trail = exp(-a * 2.2) * (1.0 - r);
        float rings = smoothstep(0.03, 0.0, abs(fract(r * 4.0) - 0.5) - 0.47) * 0.25 * (1.0 - r);
        gl_FragColor = vec4(color, (trail * 0.55 + rings) * k);
      }`,
  });
  return new THREE.Mesh(new THREE.CircleGeometry(radius, 96), m);
}

// a thin bar between two points (for dimension lines), in the parent's frame
function bar(a, b, r, material) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 8), material);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

export async function createExplorer(container, { meshUrl = './assets/i7_mesh.json' } = {}) {
  // DOM: buttons on the left, the stage in the middle, the facts on the right
  container.innerHTML = `
    <div class="xp-nav" role="tablist" aria-label="i7 部件">${MODES.map((m, i) => `
      <button type="button" role="tab" data-i="${i}" aria-selected="false">
        <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[m.id]}</svg>
        <span>${m.label}</span></button>`).join('')}
    </div>
    <div class="xp-stage">
      <svg class="xp-lines" aria-hidden="true"></svg>
      <div class="xp-labels" aria-hidden="true"></div>
      <div class="xp-zoom" aria-hidden="true">${THOR_CARD}</div>
      <div class="xp-read" aria-hidden="true"></div>
    </div>
    <div class="xp-panel" role="tabpanel" aria-live="polite"></div>`;
  const nav = [...container.querySelectorAll('.xp-nav button')];
  const stage = container.querySelector('.xp-stage'), panel = container.querySelector('.xp-panel');
  const svg = stage.querySelector('.xp-lines'), labels = stage.querySelector('.xp-labels');
  const zoom = stage.querySelector('.xp-zoom'), read = stage.querySelector('.xp-read');

  const st = makeStage(stage, { fov: 30 });
  const R = await makeRobot(meshUrl);
  st.scene.add(R.root);
  const { robot } = R;
  const cam = st.camera;
  const controls = new OrbitControls(cam, st.renderer.domElement);
  // no wheel zoom: the page has to keep scrolling past the stage; the buttons fly the camera in instead
  Object.assign(controls, { enablePan: false, enableZoom: false, enableDamping: true, dampingFactor: 0.08, rotateSpeed: 0.7,
    minPolarAngle: 0.5, maxPolarAngle: 1.62, autoRotateSpeed: 0.7 });
  st.renderer.domElement.style.touchAction = 'pan-y';
  let userTouched = false;
  controls.addEventListener('start', () => { userTouched = true; fly = null; controls.autoRotate = false; });

  // materials: the robot's own, a glowing copy for parts in focus, and the x-ray ghost for the rest
  const ghost = ghostMaterial();
  const focusMats = {};
  const focusOf = (name, color) => {
    const k = `${name}:${color}`;
    if (!focusMats[k]) {
      const m = R.M.robot[name].clone();
      if (name !== 'led') { m.emissive = new THREE.Color(color); m.emissiveIntensity = 0; }
      focusMats[k] = m;
    }
    return focusMats[k];
  };
  // sel(link, groupName) -> 'focus' | 'ghost' | 'base'
  function highlight(sel, color = ACCENT) {
    for (const p of robot.parts) {
      const states = p.mats.map(m => sel(p.link, m));
      p.mesh.material = p.mats.map((m, i) => states[i] === 'focus' ? focusOf(mat(m), color) : states[i] === 'ghost' ? ghost : R.M.robot[mat(m)]);
      p.mesh.castShadow = states.some(s => s !== 'ghost');
    }
  }
  const pulse = (k) => Object.values(focusMats).forEach(m => { if (m.emissive && m !== focusMats['led']) m.emissiveIntensity = k; });

  // ---------------- per-mode 3D extras
  const extras = {};
  const linkOf = (name) => robot.links[name];
  const worldAt = (key, out = new THREE.Vector3()) => { const [l, p] = AT[key]; return linkOf(l).localToWorld(out.set(...p)); };

  // size: dimension bars on the floor and up the side, in base_link's frame (floor at z = -FLOOR_OFFSET)
  {
    const g = new THREE.Group(), m = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9 });
    const f = -FLOOR_OFFSET + 0.004, top = SHOULDER_Z + 0.35;
    const hx = 0.24, hy = 0.44, ly = -0.4, wx = 0.2;
    g.add(bar([hx, hy, f], [hx, hy, top], 0.005, m), bar([hx - 0.04, hy, f], [hx + 0.04, hy, f], 0.004, m), bar([hx - 0.04, hy, top], [hx + 0.04, hy, top], 0.004, m));
    g.add(bar([-0.598, ly, f], [0.077, ly, f], 0.005, m), bar([-0.598, ly - 0.04, f], [-0.598, ly + 0.04, f], 0.004, m), bar([0.077, ly - 0.04, f], [0.077, ly + 0.04, f], 0.004, m));
    g.add(bar([wx, -0.277, f], [wx, 0.274, f], 0.005, m), bar([wx - 0.04, -0.277, f], [wx + 0.04, -0.277, f], 0.004, m), bar([wx - 0.04, 0.274, f], [wx + 0.04, 0.274, f], 0.004, m));
    const faint = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.25 });
    g.add(bar([0.077, -0.277, f], [0.077, ly - 0.03, f], 0.002, faint), bar([-0.598, -0.277, f], [-0.598, ly - 0.03, f], 0.002, faint));
    g.add(bar([0.077, -0.277, f], [wx + 0.03, -0.277, f], 0.002, faint), bar([0.077, 0.274, f], [wx + 0.03, 0.274, f], 0.002, faint));
    g.add(bar([-0.05, 0.05, top], [hx - 0.03, hy, top], 0.002, faint));
    g.userData.fade = [m, faint]; g.userData.op = [0.9, 0.25];
    g.userData.labels = [[[hx, hy, (f + top) / 2], '≈1.76 m'], [[-0.26, ly, f], '≈0.68 m'], [[wx, 0, f], '≈0.55 m']];
    robot.root.add(g); extras.size = g;
  }
  // lift: a scale bar beside the column with the shoulder marker riding on it
  {
    const g = new THREE.Group(), m = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85 });
    const x = 0.14, y = -0.38, z0 = SHOULDER_Z - 1, z1 = SHOULDER_Z;
    g.add(bar([x, y, z0], [x, y, z1], 0.004, m));
    for (let k = 0; k <= 10; k++) g.add(bar([x - (k % 5 ? 0.015 : 0.03), y, z0 + k * 0.1], [x + (k % 5 ? 0.015 : 0.03), y, z0 + k * 0.1], 0.0025, m));
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.018, 20, 14), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true }));
    marker.position.set(x, y, z1); g.add(marker);
    const link = bar([0, -0.13, 0], [x - 0.0, y + 0.01, 0], 0.0025, new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.4 }));
    const linkG = new THREE.Group(); linkG.add(link); g.add(linkG);
    g.userData = { fade: [m, marker.material, link.material], op: [0.85, 1, 0.4], marker, linkG };
    robot.root.add(g); extras.lift = g;
  }
  // arms: a ring round every right-arm joint, coloured by group (shoulder / elbow / wrist)
  {
    const cols = { sh: 0x0a6cdf, el: 0x7a3ff2, wr: 0xe8730c };
    const rings = ARM_JOINTS('Right').map((n, i) => {
      const r = [0.085, 0.08, 0.075, 0.07, 0.062, 0.055, 0.055][i];
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0045, 10, 64), new THREE.MeshBasicMaterial({ color: cols[ARM_INFO[i][3]], transparent: true, opacity: 0 }));
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), robot.joints[n].axis);
      robot.joints[n].move.parent.add(ring);
      return ring;
    });
    extras.arms = { rings };
  }
  // sense: camera frustums and the lidar sweeps
  {
    const head = frustum(0.8, 1.45, 1.0); head.rotation.y = 0.45;
    head.position.set(0.045, 0, 0.31); linkOf('Shoulder_Base').add(head);
    const wr = ['Right', 'Left'].map(side => {
      const f = frustum(0.32, 1.2, 0.95); f.position.set(0.11, 0, -0.07); f.rotation.y = Math.PI / 2 + 0.25;   // looks past the fingertips
      linkOf(`falan_${side}`).add(f); return f;
    });
    const discs = [AT.lidarFL[1], AT.lidarRR[1]].map(p => { const d = sweepDisc(1.6); d.position.set(p[0], p[1], p[2] - 0.01); robot.root.add(d); return d; });
    extras.sense = { fr: [head, ...wr], discs };
  }
  // compute: an illustrative module in the chassis, and data flowing to it from the sensors
  {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.243, 0.112, 0.057), new THREE.MeshStandardMaterial({ color: 0x23262c, metalness: 0.5, roughness: 0.35, emissive: new THREE.Color(ACCENT), emissiveIntensity: 0.25, transparent: true }));
    const fins = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.09, 0.006), new THREE.MeshStandardMaterial({ color: ACCENT, emissive: new THREE.Color(ACCENT), emissiveIntensity: 1.2, transparent: true }));
    fins.position.z = 0.032;
    const halo = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.16, 0.1), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.12, depthWrite: false }));
    g.add(box, fins, halo); g.position.set(...AT.compute[1]); robot.root.add(g);
    const dots = [], paths = [];
    for (const key of ['headCam', 'wristR', 'wristL', 'lidarFL', 'lidarRR']) {
      paths.push(key);
      for (let k = 0; k < 4; k++) {
        const d = new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 8), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, depthTest: false }));
        d.renderOrder = 5; st.scene.add(d); dots.push({ d, key, k });
      }
    }
    g.userData = { box, fins, halo, dots };
    extras.compute = g;
  }
  // safety: the 1.5 m keep-clear ring on the floor
  {
    const pts = Array.from({ length: 97 }, (_, k) => new THREE.Vector3(Math.cos(k / 96 * Math.PI * 2) * 1.5, Math.sin(k / 96 * Math.PI * 2) * 1.5, 0.003));
    const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xd8262b, dashSize: 0.08, gapSize: 0.05, transparent: true }));
    ring.computeLineDistances(); st.scene.add(ring);
    const fill = new THREE.Mesh(new THREE.RingGeometry(1.48, 1.52, 96), new THREE.MeshBasicMaterial({ color: 0xd8262b, transparent: true, opacity: 0.25, depthWrite: false }));
    fill.position.z = 0.002; st.scene.add(fill);
    extras.safety = { ring, fill };
  }
  const setExtras = (id, k, mt, time) => {
    const z = extras.size; z.visible = id === 'size' && k > 0.01;
    z.userData.fade.forEach((m, i) => { m.opacity = z.userData.op[i] * k; });
    z.scale.set(1, 1, 1);
    const L = extras.lift; L.visible = id === 'lift' && k > 0.01; L.userData.fade.forEach((m, i) => { m.opacity = L.userData.op[i] * k; });
    extras.arms.rings.forEach((r, i) => {
      const act = id === 'arms' ? Math.floor(mt / STEP) % 7 === i : false;
      r.material.opacity = id === 'arms' ? k * (act ? 1 : 0.28) : 0;
      r.visible = r.material.opacity > 0.01;
      r.scale.setScalar(act ? 1 + 0.08 * Math.sin(time * 8) : 1);
    });
    const S = extras.sense, sk = id === 'sense' ? k : 0;
    S.fr.forEach(f => { f.visible = sk > 0.01; f.userData.fade[0].opacity = 0.1 * sk * (0.75 + 0.25 * Math.sin(time * 3)); f.userData.fade[1].opacity = 0.55 * sk; f.scale.setScalar(0.3 + 0.7 * ease(mt / 0.9)); });
    S.discs.forEach((d, i) => { d.visible = sk > 0.01; d.material.uniforms.angle.value = time * 3.2 + i * Math.PI; d.material.uniforms.k.value = sk; });
    const C = extras.compute, ck = id === 'compute' ? k : 0;
    C.visible = ck > 0.01;
    C.userData.halo.material.opacity = 0.12 * ck * (0.7 + 0.3 * Math.sin(time * 4));
    [C.userData.box, C.userData.fins].forEach(o => { o.material.opacity = ck; });
    const end = new THREE.Vector3();
    C.localToWorld(end.set(0, 0, 0));
    C.userData.dots.forEach(({ d, key, k: n }) => {
      d.visible = ck > 0.01;
      if (!d.visible) return;
      const a = worldAt(key), u = (time * 0.45 + n / 4) % 1;
      const mid = a.clone().lerp(end, 0.5); mid.z = Math.max(a.z, end.z) * 0.6 + 0.15;
      d.position.copy(a).multiplyScalar((1 - u) * (1 - u)).addScaledVector(mid, 2 * u * (1 - u)).addScaledVector(end, u * u);
      d.material.opacity = ck * Math.sin(Math.PI * u);
    });
    const F = extras.safety, fk = id === 'safety' ? k : 0;
    F.ring.visible = F.fill.visible = fk > 0.01;
    F.ring.material.opacity = fk; F.fill.material.opacity = 0.25 * fk * (0.6 + 0.4 * Math.sin(time * 3));
  };

  // ---------------- per-mode robot motion (mode time mt)
  const poseOf = (id, mt, time) => {
    const s = restState(0);
    if (id === 'lift') {
      s.R = LIFT_R.slice(); s.L = mirror(LIFT_R);
      s.lift = -0.5 + 0.5 * Math.cos(Math.max(0, mt - 0.8) * Math.PI * 2 / 6);      // full travel, 6 s per cycle
    } else if (id === 'arms') {
      s.R = ARM_SHOW_R.slice(); s.L = mirror(ARM_SHOW_R);
      const j = Math.floor(mt / STEP) % 7, u = (mt % STEP) / STEP;
      s.R[j] += ARM_SWEEP[j] * Math.sin(u * Math.PI * 2) * (j === 1 ? -1 : 1);
      s.gR = lerp(GRIP.rest, GRIP.open, bump(mt % (STEP * 7), STEP * 6, STEP * 7));
    } else if (id === 'sense') {
      s.R = mixQ(REST_R, [-0.5, -0.1, 0, -0.9, 0, 0, 0.3], 1); s.L = mirror(s.R);
    } else if (id === 'safety') {
      // arms held out, the e-stop is hit, the arms fall under gravity (accelerating), then a reset
      const c = mt % 6;
      const up = ramp(c, 0.2, 1.2) * (1 - ramp(c, 5.2, 5.9));
      const fall = clamp((c - 2.4) / 0.55); const drop = fall * fall;                  // free-fall feel
      const held = SAG_R, dropped = [0.25, -0.05, 0, 0, 0, 0, 0];
      s.R = mixQ(REST_R, mixQ(held, dropped, drop), up); s.L = mirror(s.R);
    } else if (id === 'io') {
      s.R = REST_R.slice(); s.L = mirror(REST_R);
    }
    return s;
  };
  const estopFlash = (mt) => { const c = mt % 6; return c > 2.2 && c < 5.2 ? 0.5 + 0.5 * Math.sin((c - 2.2) * 12) : 0; };

  // ---------------- callouts (DOM labels + SVG leaders)
  let marks = [];
  const NS = 'http://www.w3.org/2000/svg';
  function setCallouts(list) {
    labels.innerHTML = ''; svg.innerHTML = '';
    marks = list.map(([key, text, cls = ''], i) => {
      const el = document.createElement('div'); el.className = `xp-label ${cls}`; el.textContent = text;
      el.style.transitionDelay = `${0.25 + i * 0.08}s`; labels.appendChild(el);
      const line = document.createElementNS(NS, 'path'); line.setAttribute('class', `xp-leader ${cls}`); svg.appendChild(line);
      const dot = document.createElementNS(NS, 'circle'); dot.setAttribute('r', '4'); dot.setAttribute('class', `xp-dot ${cls}`); svg.appendChild(dot);
      return { key, el, line, dot, i, cls };
    });
    requestAnimationFrame(() => labels.classList.add('in'));
  }
  const proj = new THREE.Vector3(), centre = new THREE.Vector3();
  const toScreen = (v) => { proj.copy(v).project(cam); return [(proj.x + 1) / 2 * st.size.w, (1 - proj.y) / 2 * st.size.h, proj.z]; };
  function placeCallouts() {
    const [cx] = toScreen(centre.set(0, 0, 0.9));
    const placed = [];
    for (const m of marks) {
      const p = typeof m.key === 'string' ? worldAt(m.key) : m.key();
      const [x, y, z] = toScreen(p);
      if (m.cls === 'dim') {
        m.el.style.transform = `translate(${(x - m.el.offsetWidth / 2).toFixed(1)}px, ${(y - m.el.offsetHeight / 2).toFixed(1)}px)`;
        m.line.style.display = m.dot.style.display = 'none';
        continue;
      }
      const side = x >= cx ? 1 : -1, w = m.el.offsetWidth, h = m.el.offsetHeight;
      let lx = x + side * (46 + 0.18 * Math.abs(x - cx)), ly = y - 22;
      lx = side > 0 ? Math.min(lx, st.size.w - w - 8) : Math.max(lx, w + 8);
      for (const q of placed) if (q.side === side && Math.abs(q.y - ly) < h + 6) ly = q.y + (ly >= q.y ? 1 : -1) * (h + 6);
      ly = clamp(ly, h / 2 + 6, st.size.h - h / 2 - 6);
      placed.push({ side, y: ly });
      m.el.style.transform = `translate(${(side > 0 ? lx : lx - w).toFixed(1)}px, ${(ly - h / 2).toFixed(1)}px)`;
      m.line.setAttribute('d', `M${x.toFixed(1)},${y.toFixed(1)} L${lx.toFixed(1)},${ly.toFixed(1)}`);
      m.dot.setAttribute('cx', x.toFixed(1)); m.dot.setAttribute('cy', y.toFixed(1));
      const vis = z < 1 ? '' : 'none';
      m.el.style.display = vis; m.line.style.display = vis; m.dot.style.display = vis;
    }
  }

  // ---------------- panel
  function fillPanel(m) {
    panel.innerHTML = `
      <p class="xp-k">${m.label}</p>
      <h3>${m.title}</h3>
      <p class="xp-lead">${m.lead}</p>
      <div class="xp-stats">${m.stats.map(([n, l]) => `<div><b${n.length > 6 ? ' class="long"' : ''}>${n}</b><span>${l}</span></div>`).join('')}</div>
      <dl class="xp-rows">${m.rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>
      <p class="xp-note">${m.note}</p>`;
    panel.classList.remove('in'); void panel.offsetWidth; panel.classList.add('in');
  }

  // ---------------- mode switching, camera flights
  let cur = 0, modeT0 = 0, clock = 0, from = restState(0), state = restState(0), fly = null, zoomLines = null;
  const sph = (pos, tgt) => { const d = pos.clone().sub(tgt); const r = d.length(); return { r, az: Math.atan2(d.y, d.x), el: Math.asin(d.z / r) }; };
  function setMode(i, { instant = false } = {}) {
    cur = i; modeT0 = clock; from = { ...state, R: state.R.slice(), L: state.L.slice() };
    const m = MODES[i]; m._s = undefined;
    nav.forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-selected', k === i ? 'true' : 'false'); });
    fillPanel(m);
    labels.classList.remove('in');
    const list = m.callouts.slice();
    if (m.id === 'size') extras.size.userData.labels.forEach(([p, t]) => list.push([() => robot.root.localToWorld(new THREE.Vector3(...p)), t, 'dim']));
    if (m.id === 'lift') list.push([() => extras.lift.userData.marker.getWorldPosition(new THREE.Vector3()), '', 'live']);
    if (m.id === 'arms') list.push([() => { const n = ARM_JOINTS('Right')[Math.floor((clock - modeT0) / STEP) % 7]; return robot.joints[n].move.getWorldPosition(new THREE.Vector3()); }, '', 'live']);
    if (m.id === 'compute') list.push(['compute', '计算单元（位置示意）']);
    setCallouts(list);
    // compute: a magnifier ring round the module, with two lines out to the chip card
    zoomLines = null;
    if (m.id === 'compute') {
      const ring = document.createElementNS(NS, 'circle'); ring.setAttribute('r', '30'); ring.setAttribute('class', 'xp-mag');
      const l1 = document.createElementNS(NS, 'path'), l2 = document.createElementNS(NS, 'path');
      [l1, l2].forEach(l => l.setAttribute('class', 'xp-mag-line'));
      svg.append(ring, l1, l2); zoomLines = { ring, l1, l2 };
    }
    zoom.classList.toggle('in', m.id === 'compute');
    read.classList.toggle('in', false);
    const c = m.cam, tgt = new THREE.Vector3(...c.look);
    const to = { tgt, r: c.dist, az: c.az, el: c.el };
    if (instant) { applyCam(to); fly = null; } else fly = { t0: clock, a: { tgt: controls.target.clone(), ...sph(cam.position, controls.target) }, b: to };
    controls.autoRotate = !!m.spin && !userTouched;
    if (m.id === 'overview') highlight(() => 'base');
    else if (m.id === 'size') highlight(() => 'ghost');
    else if (m.id === 'lift') highlight((l, g) => l === 'Shoulder_Base' || isArm(l) || isHand(l) ? 'focus' : (l === 'base_link' && region(g) === 'column') || l === 'head' ? 'base' : 'ghost');
    else if (m.id === 'arms') highlight((l) => isArm(l) || isHand(l) ? 'focus' : 'ghost');
    else if (m.id === 'sense') highlight((l, g) => SENSOR(l, g) ? 'focus' : 'ghost');
    else if (m.id === 'compute') highlight(() => 'ghost');
    else if (m.id === 'io') highlight((l, g) => l === 'base_link' && ['black@column', 'silver@column'].includes(g) ? 'focus' : 'base');
    else if (m.id === 'safety') highlight((l, g) => g === 'red@column' ? 'focus' : mat(g) === 'lidar' ? 'focus' : 'base', 0xd8262b);
  }
  function applyCam(c) {
    controls.target.copy(c.tgt);
    cam.position.set(c.tgt.x + c.r * Math.cos(c.el) * Math.cos(c.az), c.tgt.y + c.r * Math.cos(c.el) * Math.sin(c.az), c.tgt.z + c.r * Math.sin(c.el));
  }
  nav.forEach((b, i) => b.addEventListener('click', () => { if (i !== cur) setMode(i); }));
  container.querySelector('.xp-nav').addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault(); const n = (cur + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + MODES.length) % MODES.length;
    setMode(n); nav[n].focus();
  });

  setMode(0, { instant: true });
  controls.update();

  runLoop(stage, (time) => {
    clock = time;
    const m = MODES[cur], mt = time - modeT0, k = ease(mt / 0.6);
    // camera
    if (fly) {
      const u = ease((time - fly.t0) / 1.1), a = fly.a, b = fly.b;
      let daz = Math.atan2(Math.sin(b.az - a.az), Math.cos(b.az - a.az));
      applyCam({ tgt: a.tgt.clone().lerp(b.tgt, u), r: lerp(a.r, b.r, u), az: a.az + daz * u, el: lerp(a.el, b.el, u) });
      if (u >= 1) fly = null;
    }
    controls.update();
    // robot
    const target = poseOf(m.id, mt, time);
    state = mixState(from, target, ease(mt / 0.9));
    R.apply(state);
    R.robot.led.material.emissiveIntensity = 1.2 + 0.5 * Math.sin(time * 2.2);
    // highlight pulse and overview's walk through the subsystems
    if (m.id === 'overview') {
      const s = Math.floor(mt / 1.8) % SUBSYS.length;
      if (s !== m._s) { m._s = s; highlight((l, g) => SUBSYS[s].sel(l, g) ? 'focus' : 'base'); marks.forEach((c, i) => c.el.classList.toggle('hot', i === s)); }
      pulse(0.35 * bump(mt % 1.8, 0, 1.8));
    } else if (m.id === 'safety') pulse(0.2 + 0.8 * estopFlash(mt));
    else pulse(0.12 + 0.1 * Math.sin(time * 3));
    setExtras(m.id, k, mt, time);
    // live readouts
    if (m.id === 'lift') {
      const L = extras.lift.userData;
      L.marker.position.z = SHOULDER_Z + state.lift; L.linkG.position.z = SHOULDER_Z + state.lift;
      marks[marks.length - 1].el.textContent = `肩关节离地 ${(SHOULDER_Z + FLOOR_OFFSET + state.lift).toFixed(2)} m`;
    }
    if (m.id === 'arms') {
      const j = Math.floor(mt / STEP) % 7, [id, name, range] = ARM_INFO[j];
      marks[marks.length - 1].el.innerHTML = `<b>${id}</b> ${name} <small>${range}</small>`;
      marks[marks.length - 1].el.dataset.g = ARM_INFO[j][3];
    }
    if (m.id === 'safety') {
      const c = mt % 6;
      read.textContent = c < 2.2 ? '手臂伸出中' : c < 5.2 ? '急停已按下 · 双臂断电下垂' : '复位';
      read.classList.toggle('in', true); read.classList.toggle('warn', c >= 2.2 && c < 5.2);
    }
    st.renderer.render(st.scene, cam);
    placeCallouts();
    if (zoomLines) {
      const [x, y] = toScreen(worldAt('compute'));
      const zx = zoom.offsetLeft, zy = zoom.offsetTop, zh = zoom.offsetHeight, zw = zoom.offsetWidth;
      zoom.style.transformOrigin = `${(x - zx).toFixed(0)}px ${(y - zy).toFixed(0)}px`;
      const near = x < zx ? zx : zx + zw;                 // the card edge facing the module
      zoomLines.ring.setAttribute('cx', x.toFixed(1)); zoomLines.ring.setAttribute('cy', y.toFixed(1));
      zoomLines.l1.setAttribute('d', `M${x.toFixed(1)},${(y - 30).toFixed(1)} L${near},${zy + 14}`);
      zoomLines.l2.setAttribute('d', `M${x.toFixed(1)},${(y + 30).toFixed(1)} L${near},${zy + zh - 14}`);
    }
  }, () => stage.classList.add('drawn'));                   // callouts stay hidden until they have been placed
  container.classList.add('live');
}
