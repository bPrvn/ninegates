import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

gsap.registerPlugin(ScrollTrigger);

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isTouch = matchMedia('(hover: none)').matches;
const isMobile = () => innerWidth < 760;

/* =========================================================
   Renderer / scene / camera
   ========================================================= */
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0;

const BG = 0x00110a; // Figma background
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.FogExp2(0x07100b, 0.019);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(isMobile() ? 58 : 40, innerWidth / innerHeight, 0.1, 220);
// Architectural "shift lens": the camera looks dead level (verticals stay vertical, like the
// reference render) while the frame is shifted so the horizon sits low on screen.
const LENS = () => (isMobile() ? 0.3 : 0.46);

/* =========================================================
   Materials
   ========================================================= */
const CREAM = new THREE.Color(1.0, 0.84, 0.6);

// Darkens surfaces near the floor so objects feel planted (cheap ambient occlusion)
function groundAO(mat, reach = 1.8, floorDark = 0.22) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWY;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWY = (modelMatrix * vec4(transformed, 1.0)).y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWY;')
      .replace('#include <opaque_fragment>',
        `outgoingLight *= mix(${floorDark.toFixed(2)}, 1.0, smoothstep(0.0, ${reach.toFixed(2)}, vWY));\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `groundAO-${reach}-${floorDark}`;
  return mat;
}

// Matte, satin stone-metal — like the reference render
const archMat = groundAO(new THREE.MeshStandardMaterial({
  color: 0x323c36, metalness: 0.35, roughness: 0.52, envMapIntensity: 0.32,
}));
const frameMat = groundAO(new THREE.MeshStandardMaterial({
  color: 0x39433d, metalness: 0.45, roughness: 0.44, envMapIntensity: 0.4,
}));
const doorMat = new THREE.MeshStandardMaterial({
  color: 0x232c27, metalness: 0.45, roughness: 0.45, envMapIntensity: 0.35,
});

/* Soft additive glow sprite (light shafts / halos) */
function makeGlow(w, h, color, intensity = 1, power = 2.2) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: color.clone() },
      uIntensity: { value: intensity },
      uPow: { value: power },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uIntensity; uniform float uPow;
      varying vec2 vUv;
      void main(){
        vec2 p = vUv - 0.5;
        float d = length(p * vec2(2.0, 2.0));
        float a = pow(clamp(1.0 - d, 0.0, 1.0), uPow) * uIntensity;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
}

/* =========================================================
   Arch geometry helpers
   ========================================================= */
// An arch-shaped ring (∩ outline) of half-width r, straight-side height hs, thickness t
function archRingShape(r, hs, t) {
  const ri = r - t;
  const s = new THREE.Shape();
  s.moveTo(-r, 0);
  s.lineTo(-r, hs);
  s.absarc(0, hs, r, Math.PI, 0, true);
  s.lineTo(r, 0);
  s.lineTo(ri, 0);
  s.lineTo(ri, hs);
  s.absarc(0, hs, ri, 0, Math.PI, false);
  s.lineTo(-ri, 0);
  s.closePath();
  return s;
}
// A filled arch (doorway silhouette)
function archFillShape(r, hs) {
  const s = new THREE.Shape();
  s.moveTo(-r, 0);
  s.lineTo(-r, hs);
  s.absarc(0, hs, r, Math.PI, 0, true);
  s.lineTo(r, 0);
  s.closePath();
  return s;
}

const geoCache = new Map();
const BEVEL = 0.012; // hairline chamfer → crisp edges that still catch a highlight
function ringGeo(r, hs, t, depth, bevel = BEVEL) {
  bevel = Math.min(bevel, t * 0.3, depth * 0.3);
  const key = [r, hs, t, depth, bevel].map((n) => n.toFixed(3)).join('|');
  if (geoCache.has(key)) return geoCache.get(key);
  // shape is inset by the bevel so the finished size matches r / t
  const g = new THREE.ExtrudeGeometry(archRingShape(r - bevel, hs, t - bevel * 2), {
    depth: Math.max(0.01, depth - bevel * 2), curveSegments: 128,
    bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1,
  });
  g.translate(0, 0, -(depth - bevel * 2) / 2);
  geoCache.set(key, g);
  return g;
}

// Soft contact shadow under each gate so it sits ON the floor
const shadowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  // draw the rect off-canvas and keep only its blurred shadow (works in every browser)
  x.shadowColor = 'rgba(0,0,0,0.95)';
  x.shadowBlur = 40;
  x.shadowOffsetX = 1000;
  x.fillStyle = '#000';
  x.fillRect(56 - 1000, 56, 144, 144);
  return new THREE.CanvasTexture(c);
})();
const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.85 });
function contactShadow(w, d) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), shadowMat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.006;
  m.renderOrder = 1;
  return m;
}

// A partial arch "rib" from the logo: one leg + the arc from 0 up to `theta`.
// dir = 1 → leg on the right (like the logo), dir = -1 → mirrored.
function ribShape(r, hs, t, theta, dir) {
  const ri = r - t;
  const pts = [new THREE.Vector2(ri, 0), new THREE.Vector2(r, 0), new THREE.Vector2(r, hs)];
  const N = 96;
  for (let i = 1; i <= N; i++) {
    const a = (theta * i) / N;
    pts.push(new THREE.Vector2(r * Math.cos(a), hs + r * Math.sin(a)));
  }
  // tapered end, like the angled stroke ends in the mark
  const taper = 0.12;
  for (let i = 0; i <= N; i++) {
    const a = theta - taper - ((theta - taper) * i) / N;
    pts.push(new THREE.Vector2(ri * Math.cos(a), hs + ri * Math.sin(a)));
  }
  pts.push(new THREE.Vector2(ri, hs));
  pts.forEach((p) => (p.x *= dir));
  return new THREE.Shape(pts);
}
function ribGeo(r, hs, t, depth, theta, dir, bevel = BEVEL) {
  bevel = Math.min(bevel, t * 0.3, depth * 0.3);
  const key = ['rib', r, hs, t, depth, theta, dir, bevel].map((n) => (typeof n === 'number' ? n.toFixed(3) : n)).join('|');
  if (geoCache.has(key)) return geoCache.get(key);
  const g = new THREE.ExtrudeGeometry(ribShape(r - bevel, hs, t - bevel * 2, theta, dir), {
    depth: Math.max(0.01, depth - bevel * 2), curveSegments: 8,
    bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1,
  });
  g.translate(0, 0, -(depth - bevel * 2) / 2);
  geoCache.set(key, g);
  return g;
}

// The Ninegates mark in 3D: one full arch in front, two identical arches
// stepping back — each a little higher and shifted sideways, as in the logo.
const RIB_THETA = [0, THREE.MathUtils.degToRad(112), THREE.MathUtils.degToRad(124)];
function makeLogoGate(W, H, { t = W * 0.17, depth = 0.6, gap = 0.9, dir = 1, mat = archMat, ribMat = mat, shadows = true } = {}) {
  const g = new THREE.Group();
  const r = W / 2;
  const hs = H - r;
  const front = new THREE.Mesh(ringGeo(r, hs, t, depth), mat);
  g.add(front);
  if (shadows) for (const sx of [-1, 1]) {
    const s = contactShadow(t * 2.8, depth * 2.4);
    s.position.set(sx * (r - t / 2), 0.006, 0);
    g.add(s);
  }
  for (let i = 1; i <= 2; i++) {
    const shift = dir * i * r * 0.56;
    const rise = i * H * 0.045;
    const m = new THREE.Mesh(ribGeo(r, hs + rise, t, depth, RIB_THETA[i], dir), ribMat);
    m.position.set(shift, 0, -i * gap);
    g.add(m);
    if (shadows) {
      const s = contactShadow(t * 2.8, depth * 2.4);
      s.position.set(shift + dir * (r - t / 2), 0.006, -i * gap);
      g.add(s);
    }
  }
  if (shadows) {
    const base = contactShadow(W * 1.9, (2 * gap + depth) * 1.8);
    base.material = shadowMat.clone();
    base.material.opacity = 0.4;
    base.position.set(dir * r * 0.5, 0.005, -gap);
    g.add(base);
  }
  return g;
}

// Side gate from the reference: three concentric arches nested inside
// each other, each one a step further back
function makeNestedGate(W, H, { layers = 3, t = 0.26, depth = 0.7, gap = 0.42, mat = archMat } = {}) {
  const g = new THREE.Group();
  const step = t + 0.13;
  for (let i = 0; i < layers; i++) {
    const r = W / 2 - i * step;
    const h = H - i * step * 1.15;
    const m = new THREE.Mesh(ringGeo(r, h - r, t, depth), mat);
    m.position.z = -i * gap;
    g.add(m);
    for (const sx of [-1, 1]) {
      const sh = contactShadow(t * 3, depth * 2.2);
      sh.position.set(sx * (r - t / 2), 0.006, -i * gap);
      g.add(sh);
    }
  }
  return g;
}

/* =========================================================
   Floor — glossy stone with soft, streaky reflections
   ========================================================= */
const floorSize = 160;
const BlurReflectorShader = {
  name: 'BlurReflectorShader',
  uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null } },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    varying vec4 vUv;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec2 uv = vUv.xy / vUv.w;
      vec3 acc = vec3(0.0);
      float ws = 0.0;
      // vertical-biased blur => the long soft streaks of a polished floor
      for (int i = -8; i <= 8; i++) {
        for (int j = -1; j <= 1; j++) {
          float fi = float(i);
          float w = exp(-fi * fi / 30.0) * (j == 0 ? 1.0 : 0.55);
          acc += texture2D(tDiffuse, uv + vec2(float(j) * 0.0028, fi * 0.0065)).rgb * w;
          ws += w;
        }
      }
      gl_FragColor = vec4(acc / ws * color, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};
const reflector = new Reflector(new THREE.PlaneGeometry(floorSize, floorSize), {
  textureWidth: innerWidth * 0.5 * renderer.getPixelRatio(),
  textureHeight: innerHeight * 0.5 * renderer.getPixelRatio(),
  color: 0x6d736e,
  clipBias: 0.003,
  shader: BlurReflectorShader,
});
reflector.rotation.x = -Math.PI / 2;
reflector.position.set(0, 0, -30);
scene.add(reflector);

function tileTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, 1024, 1024);
  // soft stone mottling
  for (let i = 0; i < 900; i++) {
    const v = 215 + Math.random() * 40;
    const r = 8 + Math.random() * 40;
    const gx = Math.random() * 1024, gy = Math.random() * 1024;
    const g = x.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, `rgba(${v},${v},${v},0.18)`); g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    x.fillStyle = g; x.fillRect(gx - r, gy - r, r * 2, r * 2);
  }
  // fine grout seams (one large slab per tile)
  x.strokeStyle = 'rgba(70,70,70,0.9)';
  x.lineWidth = 2;
  x.strokeRect(1, 1, 1022, 1022);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(floorSize / 5, floorSize / 5);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(floorSize, floorSize),
  new THREE.MeshStandardMaterial({
    color: 0x0d1511, map: tileTexture(), roughness: 0.6, metalness: 0.1,
    transparent: true, opacity: 0.62, envMapIntensity: 0.12,
  })
);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0.002, -30);
scene.add(floor);

/* =========================================================
   The corridor of gates
   ========================================================= */
const corridor = new THREE.Group();
scene.add(corridor);
corridor.visible = false; // the intro shows only the entry gate; after it, the Figma image takes over

// Side gates — laid out to match the Figma hero: four nested-arch groups per side,
// turned in toward the centre, tops stepping down as they recede
const SIDE_Z = [-14, -21.5, -29, -36.5, -44];
for (const side of [-1, 1]) {
  SIDE_Z.forEach((z) => {
    const c = makeNestedGate(3.8, 5.8);
    c.position.set(side * 7, 0, z);
    c.rotation.y = -side * 1.12;
    corridor.add(c);
  });
}

// The destination gate — the Ninegates mark, square-on, sitting on the horizon
const END_Z = -40;
const endGate = makeLogoGate(3.8, 5.1, { t: 0.45, depth: 0.55, gap: 0.75, mat: frameMat });
endGate.position.set(-1.0, 0, END_Z);
corridor.add(endGate);

// faint haze behind the end gate + a low mist band on the horizon
const endGlow = makeGlow(16, 18, new THREE.Color(0.85, 0.8, 0.66), 0.3, 2.8);
endGlow.position.set(0, 2.8, END_Z - 3);
corridor.add(endGlow);
const endHalo = makeGlow(90, 5, new THREE.Color(0.55, 0.6, 0.52), 0.22, 1.6);
endHalo.position.set(0, 0.3, END_Z - 10);
corridor.add(endHalo);

/* =========================================================
   The entrance gate (intro)
   ========================================================= */
const DOOR_Z = 5;
const DR = 2.6;          // doorway half-width
const DHS = 5.0;         // straight height before the arch begins
const entrance = new THREE.Group();
scene.add(entrance);

// A single, quiet gate in the shape of the mark — standing in the corridor, no wall
{
  const t = 0.42;
  const frame = makeLogoGate((DR + t) * 2, DHS + DR + t, { t, depth: 0.5, gap: 0.7, mat: frameMat });
  frame.position.z = DOOR_Z;
  entrance.add(frame);
}

// Backlight that leaks through the door seams, then floods when open
const backlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, toneMapped: false, fog: false });
const backlight = new THREE.Mesh(new THREE.ShapeGeometry(archFillShape(DR + 0.02, DHS), 64), backlightMat);
backlight.position.z = DOOR_Z - 0.2;
entrance.add(backlight);

const doorGlow = makeGlow(9, 11, CREAM, 0, 2.2);
doorGlow.position.set(0, 3.6, DOOR_Z - 0.6);
entrance.add(doorGlow);

const doorLight = new THREE.PointLight(0xffd7a0, 0, 30, 1.8);
doorLight.position.set(0, 3, DOOR_Z - 1.5);
entrance.add(doorLight);

// Door leaves (two halves of the arch, hinged on the outside)
function makeLeaf(sign) {
  const R = DR - 0.03;
  const gap = 0.022;
  const w = R - gap;
  const yTop = DHS + Math.sqrt(R * R - (R - w) * (R - w));
  const a0 = Math.acos((w - R) / R);
  const s = new THREE.Shape();
  if (sign > 0) {
    s.moveTo(0, 0); s.lineTo(w, 0); s.lineTo(w, yTop);
    s.absarc(R, DHS, R, a0, Math.PI, false);
  } else {
    s.moveTo(0, 0); s.lineTo(-w, 0); s.lineTo(-w, yTop);
    s.absarc(-R, DHS, R, Math.PI - a0, 0, true);
  }
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.14, curveSegments: 96,
    bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 1,
  });
  const pivot = new THREE.Group();
  pivot.position.set(-sign * R, 0, DOOR_Z - 0.07);
  pivot.add(new THREE.Mesh(geo, doorMat));

  entrance.add(pivot);
  return pivot;
}
const leafL = makeLeaf(1);
const leafR = makeLeaf(-1);

/* =========================================================
   Lights
   ========================================================= */
scene.add(new THREE.AmbientLight(0x1a2620, 0.45));
scene.add(new THREE.HemisphereLight(0x3d4d43, 0x030504, 0.55));

// Soft skylight from above: catches the crowns and inner curves of the arches
const sky = new THREE.DirectionalLight(0xdfe4d6, 0.35);
sky.position.set(3, 14, 8);
scene.add(sky);

// Low, warm rim from the far end: outlines the edges facing the end gate
const rim = new THREE.DirectionalLight(0xecdcc0, 1.1);
rim.position.set(0, 5, -80);
scene.add(rim);

// lights the inward-facing arch faces down the corridor
const endLight = new THREE.PointLight(0xffe0b8, 90, 45, 1.6);
endLight.position.set(0, 3.5, -26);
scene.add(endLight);

const topLight = new THREE.SpotLight(0xe8dcc8, 90, 50, 0.6, 0.7, 1.6);
topLight.position.set(0, 16, DOOR_Z + 8);
topLight.target.position.set(0, 2, DOOR_Z);
scene.add(topLight, topLight.target);


/* =========================================================
   Floating dust
   ========================================================= */
const DUST = isMobile() ? 260 : 480;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST * 3);
const dustSeed = new Float32Array(DUST);
for (let i = 0; i < DUST; i++) {
  dustPos[i * 3] = (Math.random() - 0.5) * 22;
  dustPos[i * 3 + 1] = Math.random() * 9;
  dustPos[i * 3 + 2] = 12 - Math.random() * 56;
  dustSeed[i] = Math.random() * 100;
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dustTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,240,215,1)'); g.addColorStop(0.35, 'rgba(255,225,180,0.45)'); g.addColorStop(1, 'rgba(255,220,170,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
  size: 0.045, map: dustTex, transparent: true, opacity: 0.32, depthWrite: false,
  blending: THREE.AdditiveBlending, color: 0xffe6c4,
}));
scene.add(dust);

/* =========================================================
   Post-processing
   ========================================================= */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.6, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* =========================================================
   Hero plate — the Figma render, brought to life
   (fake depth parallax, drifting horizon mist, breathing gate glow, scroll push-in)
   ========================================================= */
const PLATE_W = 1440, PLATE_H = 900;
const plateTex = new THREE.TextureLoader().load('assets/hero-plate.png');
plateTex.colorSpace = THREE.SRGBColorSpace;
plateTex.generateMipmaps = false;
plateTex.minFilter = THREE.LinearFilter;
// hero: the aurora gate render + the gate cut out of it (used to keep the stone still)
const HERO_W = 1600, HERO_H = 763;
const loadTex = (src) => {
  const t = new THREE.TextureLoader().load(src);
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
  return t;
};
const heroTex = loadTex('assets/hero-aurora.png');
const gateTex = loadTex('assets/hero-gate.png');
const plateU = {
  tPlate: { value: plateTex },
  tHero: { value: heroTex },
  tGate: { value: gateTex },
  uHeroImg: { value: new THREE.Vector2(HERO_W, HERO_H) },
  uHeroC: { value: new THREE.Vector2(0.51, 0.5) },
  uHeroZ: { value: 1.04 },
  uHero: { value: 1 },
  uPar: { value: new THREE.Vector2() },   // cursor, -1..1
  uLight: { value: new THREE.Vector2(0.5, 0.5) }, // cursor lantern, screen 0..1
  uPortal: { value: 0 },                   // gate opening, 0 idle .. 1 hovered
  uImg: { value: new THREE.Vector2(PLATE_W, PLATE_H) },
  uRes: { value: new THREE.Vector2() },
  uCursor: { value: new THREE.Vector2(0.5, 0.85) },
  uCenter: { value: new THREE.Vector2(0.5, 0.5) },
  uZoom: { value: 1 },
  uTime: { value: 0 },
  uFade: { value: 0 },
  uFlash: { value: 0 },
  uGate: { value: 0 },
  uDark: { value: 0 },
};
const plateScene = new THREE.Scene();
const plateCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
plateScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: plateU, transparent: true, depthTest: false, depthWrite: false,
  vertexShader: /* glsl */`void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tPlate, tHero, tGate;
    uniform vec2 uImg, uRes, uCursor, uCenter, uHeroImg, uHeroC, uPar;
    uniform float uZoom, uTime, uFade, uFlash, uGate, uDark, uHeroZ, uHero, uPortal;
    uniform vec2 uLight;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }

    // main gate opening, measured from the Figma render (image px)
    const vec2  OC = vec2(687.0, 583.0);
    const float OR = 33.0;
    const float OB = 650.0;

    const vec4 GBOX = vec4(572.0, 170.0, 490.0, 390.0);
    float gateA(vec2 uv){
      vec2 g = (uv * uHeroImg - GBOX.xy) / GBOX.zw;
      if (g.x < 0.0 || g.y < 0.0 || g.x > 1.0 || g.y > 1.0) return 0.0;
      return texture2D(tGate, vec2(g.x, 1.0 - g.y)).a;
    }
    // rising light motes, in screen space (q: 0..1, y down)
    float motes(vec2 q, float t){
      float acc = 0.0;
      for (int l = 0; l < 2; l++){
        float fl = float(l);
        float sc = 16.0 + fl * 12.0;
        vec2 p = vec2(q.x * uRes.x / uRes.y, q.y) * sc;
        p.y += t * (0.22 - fl * 0.08);
        p.x += sin(p.y * 0.7 + fl * 3.0 + t * 0.3) * 0.25;
        vec2 id = floor(p), f = fract(p) - 0.5;
        float h = hash(id + fl * 17.0);
        vec2 o = (vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5) * 0.6;
        float d = length(f - o);
        acc += step(0.88, h) * smoothstep(0.09 - fl * 0.03, 0.0, d) * (0.45 + 0.55 * sin(t * 1.7 + h * 60.0)) * (1.0 - fl * 0.4);
      }
      return acc;
    }
    // signed distance to the arch opening of the main gate (image px)
    float portalD(vec2 P){
      const vec2 C = vec2(703.0, 396.0); const float R = 66.0;
      float d = P.y >= C.y ? abs(P.x - C.x) - R : length(P - C) - R;
      return max(d, P.y - 548.0);
    }

    // the aurora gate, alive: flowing aurora, twinkling stars, drifting mist, rippling water
    vec3 heroColor(vec2 frag){
      float s = max(uRes.x / uHeroImg.x, uRes.y / uHeroImg.y);
      vec2 uv = uHeroC + ((frag - uRes * 0.5) / (uHeroImg * s)) / uHeroZ;
      // cursor: the whole image slides left/right/up/down, no tilt
      uv += uPar * vec2(0.022, 0.018);
      uv = clamp(uv, 0.0005, 0.9995);
      float aspect = uHeroImg.x / uHeroImg.y;
      float t = uTime;
      float still = gateA(uv);                       // never bend the stone itself
      float sky = (1.0 - smoothstep(0.30, 0.46, uv.y)) * (1.0 - still);
      // water: right under the gate it starts at its base; at the sides the glowing streams start higher
      float zone = smoothstep(0.24, 0.35, uv.x) * (1.0 - smoothstep(0.67, 0.78, uv.x));
      float hz = mix(0.62, 0.716, zone);
      float water = smoothstep(hz, hz + 0.03, uv.y) * (1.0 - still);
      float wd = max(uv.y - hz, 0.0);
      // perspective water plane: waves get bigger and faster as they come toward you
      vec2 wp = vec2((uv.x - 0.5) * aspect, 1.0) / (wd + 0.07);
      vec2 fp = wp * vec2(0.55, 0.45) + vec2(t * 0.04, t * 0.55);
      float n1 = fbm(fp), n2 = fbm(fp * 1.7 + vec2(3.1, t * 0.25));

      vec2 duv = uv;
      // aurora: slow curtains folding sideways
      vec2 ap = vec2(uv.x * 2.2 - t * 0.035, uv.y * 4.0 + t * 0.012);
      duv += sky * vec2(fbm(ap) - 0.5, (fbm(ap + 7.3) - 0.5) * 0.6) * 0.022;
      // water: rolling swell toward the viewer + rippling reflections of the gate
      float amp = 0.002 + 0.011 * smoothstep(0.0, 0.28, wd);
      duv += water * vec2((n1 - 0.5) * amp * 1.3, (n2 - 0.5) * amp * 0.8);
      float rip = sin(uv.y * 430.0 - t * 2.4 + n1 * 7.0);
      duv.x += water * rip * 0.0022 * (1.0 - smoothstep(0.02, 0.2, wd));

      vec3 col = texture2D(tHero, vec2(duv.x, 1.0 - duv.y)).rgb;
      vec3 g = pow(col, vec3(1.0 / 2.2));

      // aurora brightness waves travel along the bands
      float green = clamp((g.g - g.r) * 1.6, 0.0, 1.0);
      float wave = fbm(vec2(uv.x * 3.0 - t * 0.09, uv.y * 6.0 + t * 0.03));
      g += vec3(0.05, 0.42, 0.28) * green * sky * (smoothstep(0.35, 0.8, wave) * 0.55 - 0.08);

      // stars
      vec2 cell = floor(uv * vec2(260.0, 124.0));
      float h = hash(cell);
      float star = step(0.985, h) * (0.5 + 0.5 * sin(t * (1.5 + h * 3.0) + h * 40.0));
      vec2 f = fract(uv * vec2(260.0, 124.0)) - 0.5;
      g += vec3(0.85, 1.0, 0.95) * star * exp(-dot(f, f) * 40.0) * 0.5 * (1.0 - smoothstep(0.12, 0.3, uv.y)) * (1.0 - still);

      // water: bright crests that travel with the flow, darker troughs between them
      float crest = smoothstep(0.55, 0.88, fbm(fp * 2.2 + vec2(0.0, t * 0.4)));
      float trough = smoothstep(0.55, 0.25, n2);
      g += vec3(0.22, 0.85, 0.6) * crest * water * (green * 0.9 + 0.08) * 0.55;
      g *= 1.0 - water * trough * 0.18;
      // glints sparkling on the surface
      vec2 gc = floor(fp * vec2(6.0, 4.0));
      float gl = step(0.93, hash(gc)) * pow(max(sin(t * 2.5 + hash(gc + 1.7) * 30.0), 0.0), 8.0);
      g += vec3(0.7, 1.0, 0.88) * gl * water * green * 0.6;

      // low mist drifting across the base of the gate
      float dy = uv.y - 0.705;
      vec2 mp = vec2(uv.x * 5.0 * aspect * 0.5 + t * 0.03, uv.y * 18.0 - t * 0.02);
      float mist = smoothstep(0.42, 0.85, fbm(mp + fbm(mp * 0.6 - t * 0.04)));
      float cd = length((uv - uCursor) * vec2(aspect, 1.0));
      g += vec3(0.32, 0.72, 0.56) * mist * exp(-dy * dy / 0.0016) * 0.22 * (1.0 - 0.6 * exp(-cd * cd / 0.01));

      // a soft breath of light inside the arch
      vec2 o = (uv - vec2(0.437, 0.6)) / vec2(0.05, 0.12);
      g += vec3(0.08, 0.35, 0.24) * exp(-dot(o, o)) * (0.5 + 0.5 * sin(t * 0.9)) * 0.35 * (1.0 - still);

      // the portal: light pours from the arch opening; brighter when hovered
      vec2 P = uv * uHeroImg;
      float pd = portalD(P);
      float pin = 1.0 - smoothstep(-6.0, 2.0, pd);
      float breathe = 0.5 + 0.5 * sin(t * 1.1);
      float pw = 0.12 + 0.08 * breathe + 0.75 * uPortal;
      vec3 gold = vec3(1.0, 0.83, 0.59), mint = vec3(0.45, 1.0, 0.78);
      float rise = smoothstep(396.0, 548.0, P.y);
      g += mix(mint, gold, 0.35 + 0.5 * uPortal) * pin * pw * (0.55 + 0.45 * rise) * (1.0 - still);
      g += mix(mint, gold, 0.5) * exp(-max(pd, 0.0) / (18.0 + 30.0 * uPortal)) * (1.0 - pin) * pw * 0.35 * (1.0 - still);
      // spill on the water below the opening
      float sx = (P.x - 703.0) / (70.0 + 40.0 * uPortal);
      float spill = exp(-sx * sx) * exp(-max(P.y - 552.0, 0.0) / 90.0) * step(552.0, P.y);
      g += mix(mint, gold, 0.5) * spill * pw * 0.35;

      // cursor lantern: lights what it passes over
      vec2 q = frag / uRes;
      vec2 lq = (q - uLight) * vec2(uRes.x / uRes.y, 1.0);
      float lamp = exp(-dot(lq, lq) / 0.035);
      g += g * vec3(0.55, 1.0, 0.85) * lamp * 0.85 + vec3(0.05, 0.16, 0.12) * lamp * 0.35;

      // comet: a slow, bright comet glides down across the top of the sky every 11 s, alternating sides
      {
        float ar = uRes.x / uRes.y;
        float CP = 11.0, dur = 6.2;
        float cyc = floor(t / CP), ph = mod(t, CP);
        float k = clamp(ph / dur, 0.0, 1.0);
        float r1 = hash(vec2(cyc, 1.3)), r2 = hash(vec2(cyc, 7.1));
        float sgn = mod(cyc, 2.0) < 1.0 ? -1.0 : 1.0;                 // -1: from the right, +1: from the left
        vec2 dir = normalize(vec2(sgn, 0.36 + 0.12 * r2));            // always heading down, tail trailing up
        float sx = 0.8 + 0.3 * r1;
        vec2 start = vec2(sgn < 0.0 ? ar * sx : ar * (1.0 - sx), -0.04 + 0.1 * r2);
        vec2 head = start + dir * k * (ar * 0.95);
        vec2 d = vec2(q.x * ar, q.y) - head;
        float along = -dot(d, dir);                                   // > 0 behind the head
        float side = dot(d, vec2(-dir.y, dir.x));
        float b = max(along, 0.0);

        // tail: widest at the head, tapering to a point, with fine bright strands
        float L = 0.42;
        float u = clamp(b / L, 0.0, 1.0);
        float w = 0.004 + 0.03 * pow(1.0 - u, 0.7);
        float fall = pow(1.0 - u, 1.2) * smoothstep(-0.012, 0.03, along);
        float acr = exp(-(side / w) * (side / w) * 1.6);
        float strands = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(side / w * 9.0 + noise(vec2(b * 6.0, 1.3 + r1 * 5.0)) * 2.0), 1.5);
        float glow = fall * exp(-(side / (w * 2.2)) * (side / (w * 2.2))) * 0.28;
        float tail = fall * acr * strands + glow;
        // a few sparks trailing off it
        vec2 sc = vec2(b * 70.0, side * 120.0);
        vec2 sid = floor(sc);
        float sp = step(0.95, hash(sid + cyc)) * smoothstep(0.35, 0.0, length(fract(sc) - 0.5))
                   * fall * exp(-(side / (w * 2.5)) * (side / (w * 2.5))) * (0.5 + 0.5 * sin(t * 6.0 + hash(sid) * 40.0));

        // head: white-hot core, teal coma, wide soft halo
        float hd = dot(d, d);
        float core = exp(-hd / (0.011 * 0.011));
        float coma = exp(-hd / (0.028 * 0.028)) * 0.95;
        float halo = exp(-hd / (0.075 * 0.075)) * 0.3;

        vec3 teal = vec3(0.35, 0.95, 0.78), white = vec3(0.92, 1.0, 0.97);
        vec3 tc = mix(teal, white, exp(-b / 0.09));
        vec3 cc = white * core * 1.8 + (teal * 0.6 + white * 0.4) * coma + teal * halo
                + tc * tail * 1.1 + mix(teal, gold, 0.5) * sp * 0.8;
        float live = smoothstep(0.0, 0.1, k) * (1.0 - smoothstep(0.85, 1.0, k)) * step(ph, dur);
        g += cc * live;
      }

      // motes drifting up out of the water
      float mo = motes(q, t) * smoothstep(0.25, 0.75, q.y);
      g += mix(mint, gold, hash(floor(q * 40.0))) * mo * 0.55;
      return g;   // display space
    }

    void main(){
      // cover-fit camera over the image; at centre 0.5 / zoom 1 it is the Figma frame 1:1
      float s = max(uRes.x / uImg.x, uRes.y / uImg.y);
      vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
      vec2 uv = uCenter + ((frag - uRes * 0.5) / (uImg * s)) / uZoom;
      uv = clamp(uv, 0.0005, 0.9995);
      vec2 tuv = vec2(uv.x, 1.0 - uv.y);
      vec3 col = texture2D(tPlate, tuv).rgb;

      // keep edges crisp when moving in on a gate
      float sh = clamp((uZoom - 1.0) * 0.35, 0.0, 0.5);
      if (sh > 0.001) {
        vec2 px = 1.0 / uImg;
        vec3 n = texture2D(tPlate, tuv + vec2(px.x, 0.0)).rgb + texture2D(tPlate, tuv - vec2(px.x, 0.0)).rgb
               + texture2D(tPlate, tuv + vec2(0.0, px.y)).rgb + texture2D(tPlate, tuv - vec2(0.0, px.y)).rgb;
        col = max(col + sh * (col - n * 0.25), 0.0);
      }

      vec3 g = pow(col, vec3(1.0 / 2.2));   // display space
      vec2 P = uv * uImg;
      float aspect = uImg.x / uImg.y;
      vec3 warm = vec3(1.0, 0.86, 0.64);

      // ---- soft smoke on the floor + wisps at the gate bases
      const float HZ = 0.731;
      float fl = smoothstep(HZ + 0.002, HZ + 0.02, uv.y);
      float dy = max(uv.y - HZ, 0.03);
      vec2 sp = vec2((uv.x - 0.5) * aspect / dy, 1.0 / dy) * vec2(0.16, 0.11);
      vec2 q = vec2(fbm(sp + vec2(uTime * 0.04, 0.0)), fbm(sp + vec2(5.2, 1.3) - uTime * 0.03));
      float smoke = smoothstep(0.4, 0.9, fbm(sp + 2.2 * q + vec2(uTime * 0.02, -uTime * 0.045)));
      float smokeMask = fl * mix(0.45, 1.0, smoothstep(0.22, 0.0, uv.y - HZ));
      vec2 hp = vec2(uv.x * 4.5 + uTime * 0.025, uv.y * 15.0 + uTime * 0.05);
      float wisp = smoothstep(0.45, 0.85, fbm(hp + 1.5 * fbm(hp * 0.5 - uTime * 0.03)));
      float above = exp(-pow((uv.y - (HZ - 0.03)) / 0.045, 2.0)) * wisp;
      float cd = length((uv - uCursor) * vec2(aspect, 1.0));
      float part = 1.0 - 0.6 * exp(-cd * cd / 0.012);
      g += vec3(0.6, 0.64, 0.56) * (smoke * smokeMask * 0.13 + above * 0.08) * part;

      // ---- the main gate lights up (Contact)
      if (uGate > 0.001) {
        float d = P.y >= OC.y ? abs(P.x - OC.x) - OR : length(P - OC) - OR;
        d = max(d, P.y - OB);
        float aa = 0.8 / (s * uZoom);
        float inside = 1.0 - smoothstep(-aa, aa, d);
        float breathe = 0.9 + 0.1 * sin(uTime * 1.2);
        g += warm * inside * (0.55 + 0.25 * smoothstep(OC.y - OR, OB, P.y)) * uGate * breathe;
        g += warm * 0.16 * exp(-pow(length((P - vec2(OC.x, 615.0)) / vec2(80.0, 62.0)), 2.0)) * uGate;
        g += warm * 0.2 * exp(-abs(P.x - OC.x) / 16.0) * exp(-max(P.y - OB, 0.0) / 60.0) * step(OB, P.y) * uGate;
      }

      g *= 1.0 - uDark;
      if (uHero > 0.001) g = mix(g, heroColor(frag), uHero);
      g = mix(g, vec3(0.93, 0.88, 0.80), uFlash);   // coming out of the gate's light
      col = pow(max(g, 0.0), vec3(2.2));
      gl_FragColor = vec4(col, uFade);
      #include <colorspace_fragment>
    }`,
})));
const plateIntro = { v: 0 }; // tweened by the intro

/* =========================================================
   Navigation through the gates of the image — one stop per section
   ========================================================= */
// order = order of <section>s in index.html
const STOPS = [
  { x: 0.5,   y: 0.5,   z: 1.0,  gate: 0,    dark: 0 },    // Home         — the full hall
  { x: 0.18,  y: 0.56,  z: 1.55, gate: 0,    dark: 0.62 }, // Who we are   — the left gates
  { x: 0.82,  y: 0.56,  z: 1.55, gate: 0,    dark: 0.62 }, // What we do   — the right gates
  { x: 0.5,   y: 0.8,   z: 1.45, gate: 0,    dark: 0.62 }, // How we do    — down the floor, between the gates
  { x: 0.5,   y: 0.62,  z: 1.7,  gate: 0.15, dark: 0.5 },  // Projects     — toward the main gate
  { x: 0.47,  y: 0.63,  z: 2.1,  gate: 0.45, dark: 0.45 }, // Why NineGates — the gate glows behind the glass tiles
  { x: 0.49,  y: 0.645, z: 2.05, gate: 0.6,  dark: 0.62 }, // Testimonials (has its own backdrop)
  { x: 0.507, y: 0.62,  z: 2.3,  gate: 0.55, dark: 0.45 }, // FAQ          — the main gate stands behind the glass tiles
  { x: 0.49,  y: 0.645, z: 2.2,  gate: 0.8,  dark: 0.7 },  // Start a project (has its own backdrop)
  { x: 0.485, y: 0.645, z: 2.2,  gate: 1,    dark: 0.25 }, // Contact      — the main gate opens
];
const view = { x: 0.5, y: 0.5, z: 1, gate: 0, dark: 0 };
const sectionsEls = [...document.querySelectorAll('main > section')];
function navTarget() {
  const maxY = document.documentElement.scrollHeight - innerHeight;
  const tops = sectionsEls.map((el) => {
    const box = el.parentElement.classList.contains('pin-spacer') ? el.parentElement : el;
    return Math.min(box.offsetTop, maxY);
  });
  const y = scrollY;
  let i = 0;
  while (i < tops.length - 2 && y >= tops[i + 1]) i++;
  const span = Math.max(1, tops[i + 1] - tops[i]);
  let f = THREE.MathUtils.clamp((y - tops[i]) / span, 0, 1);
  f = f * f * (3 - 2 * f);
  const a = STOPS[Math.min(i, STOPS.length - 1)], b = STOPS[Math.min(i + 1, STOPS.length - 1)];
  const L = (k) => a[k] + (b[k] - a[k]) * f;
  return { x: L('x'), y: L('y'), z: L('z'), gate: L('gate'), dark: L('dark') };
}

/* =========================================================
   Camera rig (tweened by the intro, then driven by scroll)
   ========================================================= */
const rig = { px: 0, py: 3.7, pz: 21, tx: 0, ty: 3.7, tz: DOOR_Z };
const HERO = { px: 0, py: 0.95, pz: 0, tx: 0, ty: 0.95, tz: -60 };
const fx = { seam: 0.0, flood: 0, open: 0, parallax: 0, lens: 0 };
let introDone = false;
let portalHover = false, mouseSeen = false;
let scrollP = 0;
const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
const lookAt = new THREE.Vector3();

/* =========================================================
   Loop
   ========================================================= */
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // mouse smoothing
  mouse.sx += (mouse.x - mouse.sx) * 0.045;
  mouse.sy += (mouse.y - mouse.sy) * 0.045;

  // scroll-driven camera after the intro
  if (introDone) {
    const e = scrollP < 0.5 ? 4 * scrollP ** 3 : 1 - (-2 * scrollP + 2) ** 3 / 2; // easeInOutCubic
    const tz = HERO.pz + (END_Z + 12 - HERO.pz) * e;
    const tx = Math.sin(scrollP * Math.PI * 2) * 0.5;
    const ty = HERO.py + Math.sin(scrollP * Math.PI) * 0.35;
    const k = 1 - Math.pow(0.0015, dt);
    rig.px += (tx - rig.px) * k;
    rig.py += (ty - rig.py) * k;
    rig.pz += (tz - rig.pz) * k;
    rig.tx += (tx * 0.3 - rig.tx) * k;
    rig.ty = rig.py;          // stay level
    rig.tz = rig.pz - 60;
  }

  const par = fx.parallax;
  camera.position.set(rig.px + mouse.sx * 0.45 * par, rig.py - mouse.sy * 0.22 * par, rig.pz);
  lookAt.set(rig.tx + mouse.sx * 0.9 * par, rig.ty - mouse.sy * 0.12 * par, rig.tz);
  camera.lookAt(lookAt);
  camera.updateProjectionMatrix();
  camera.projectionMatrix.elements[9] += fx.lens; // shift lens
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  // entrance gate fx
  leafL.rotation.y = fx.open * 1.7;
  leafR.rotation.y = -fx.open * 1.7;
  const seam = fx.seam + fx.flood * 2.2;
  backlightMat.color.copy(CREAM).multiplyScalar(0.5 + seam * 1.4);
  backlightMat.opacity = Math.max(0, 1 - Math.max(0, fx.flood - 1) * 1.0);
  backlight.visible = backlightMat.opacity > 0.001;
  doorGlow.material.uniforms.uIntensity.value = fx.seam * 0.15 + Math.min(fx.flood, 1.4) * 0.35 * backlightMat.opacity;
  doorLight.intensity = fx.seam * 15 + fx.flood * 70;

  // living corridor
  endGlow.material.uniforms.uIntensity.value = (0.3 + Math.sin(t * 0.7) * 0.03) * (1 + scrollP * 0.8);
  endHalo.material.uniforms.uIntensity.value = 0.2 + Math.sin(t * 0.5) * 0.02 + scrollP * 0.12;
  endLight.intensity = 90 + scrollP * 60;

  // dust drift
  const p = dustGeo.attributes.position.array;
  for (let i = 0; i < DUST; i++) {
    const i3 = i * 3;
    p[i3 + 1] += dt * (0.05 + (dustSeed[i] % 1) * 0.08);
    p[i3] += Math.sin(t * 0.3 + dustSeed[i]) * dt * 0.05;
    if (p[i3 + 1] > 9) p[i3 + 1] = 0;
  }
  dustGeo.attributes.position.needsUpdate = true;

  // ---- camera over the Figma image
  plateU.uTime.value = t;
  if (introDone) {
    const tgt = navTarget();
    const k = 1 - Math.pow(0.004, dt);
    for (const key of ['x', 'y', 'z', 'gate', 'dark']) view[key] += (tgt[key] - view[key]) * k;
  }
  const ps = Math.max(innerWidth / PLATE_W, innerHeight / PLATE_H);
  // keep the view inside the image
  const hx = innerWidth / (PLATE_W * ps) / 2 / view.z, hy = innerHeight / (PLATE_H * ps) / 2 / view.z;
  const vx = THREE.MathUtils.clamp(view.x, hx, 1 - hx), vy = THREE.MathUtils.clamp(view.y, hy, 1 - hy);
  plateU.uCenter.value.set(vx, vy);
  plateU.uZoom.value = view.z;
  plateU.uGate.value = view.gate;
  plateU.uDark.value = view.dark;
  {
    const cx = vx + (((mouse.x + 1) / 2) * innerWidth - innerWidth / 2) / (PLATE_W * ps) / view.z;
    const cy = vy + (((mouse.y + 1) / 2) * innerHeight - innerHeight / 2) / (PLATE_H * ps) / view.z;
    const c = plateU.uCursor.value;
    c.x += (cx - c.x) * 0.06;
    c.y += (cy - c.y) * 0.06;
  }
  plateU.uFade.value = plateIntro.v;

  // ---- hero: slow breathing push-in, cursor parallax, scroll walks toward the gate, then hands over to the hall
  {
    const hp = THREE.MathUtils.clamp(scrollY / innerHeight, 0, 1);
    const mix = 1 - THREE.MathUtils.smoothstep(hp, 0.3, 0.95);
    const z = 1.08 + hp * hp * 0.35;
    const hs = Math.max(innerWidth / HERO_W, innerHeight / HERO_H);
    const hx = innerWidth / (HERO_W * hs) / 2 / z, hy = innerHeight / (HERO_H * hs) / 2 / z;
    const cx = THREE.MathUtils.clamp(0.512, hx + 0.03, 1 - hx - 0.03);
    const cy = THREE.MathUtils.clamp(0.5 + hp * 0.06, hy + 0.025, 1 - hy - 0.025);
    plateU.uPar.value.set(mouse.sx, mouse.sy);
    plateU.uLight.value.set((mouse.sx + 1) / 2, (mouse.sy + 1) / 2);
    // is the cursor inside the arch opening? (same mapping as the shader)
    const mxp = ((mouse.x + 1) / 2) * innerWidth, myp = ((mouse.y + 1) / 2) * innerHeight;
    const ux = (cx + (mxp - innerWidth / 2) / (HERO_W * hs) / z + mouse.sx * 0.022) * HERO_W;
    const uy = (cy + (myp - innerHeight / 2) / (HERO_H * hs) / z + mouse.sy * 0.018) * HERO_H;
    const pd = uy >= 396 ? Math.abs(ux - 703) - 66 : Math.hypot(ux - 703, uy - 396) - 66;
    const over = introDone && hp < 0.25 && mouseSeen && Math.max(pd, uy - 548) < 6;
    if (over !== portalHover) {
      portalHover = over;
      document.body.classList.toggle('portal-hover', over);
    }
    plateU.uPortal.value += ((over ? 1 : 0) - plateU.uPortal.value) * (1 - Math.pow(0.02, dt));
    plateU.uHeroC.value.set(cx, cy);
    plateU.uHeroZ.value = z;
    plateU.uHero.value = mix;
    heroEl.style.setProperty('--mx', mouse.sx.toFixed(4));
    heroEl.style.setProperty('--my', mouse.sy.toFixed(4));
  }

  if (plateU.uFade.value < 1) {
    composer.render();                       // 3D entry gate
    if (plateU.uFade.value > 0) {
      renderer.autoClear = false;
      renderer.render(plateScene, plateCam);
      renderer.autoClear = true;
    }
  } else {
    renderer.render(plateScene, plateCam);   // the home image (3D is idle)
  }
  requestAnimationFrame(tick);
}

/* =========================================================
   UI helpers
   ========================================================= */
// Split hero title into characters, keeping words together
const heroEl = document.querySelector('.hero');
const heroTitle = document.getElementById('heroTitle');
heroTitle.querySelectorAll('.hl').forEach((line) => {
  const dot = line.querySelector('.hero-dot');
  const text = [...line.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  line.innerHTML = text
    .split(' ')
    .map((w) => `<span style="display:inline-block;white-space:nowrap">${[...w].map((c) => `<span class="ch">${c}</span>`).join('')}</span>`)
    .join('<span class="sp"> </span>');
  if (dot) line.lastElementChild.appendChild(dot);
});
const chars = heroTitle.querySelectorAll('.ch, .hero-dot');

gsap.set('.nav', { opacity: 0, y: -20 });
gsap.set(chars, { opacity: 0, yPercent: 40, filter: 'blur(10px)' });
gsap.set('.hero .reveal-up', { opacity: 0, y: 30 });

/* =========================================================
   Intro timeline
   ========================================================= */
const counter = { v: 0 };
const countEl = document.getElementById('count');
const intro = gsap.timeline({ paused: true, defaults: { ease: 'power2.inOut' } });

intro
  .to('.loader-logo', { clipPath: 'inset(0 0% 0 0)', duration: 1.5, ease: 'power3.inOut' }, 0.1)
  .to(counter, { v: 100, duration: 1.6, ease: 'power1.inOut', onUpdate: () => (countEl.textContent = Math.round(counter.v)) }, 0)
  .to('.loader-logo, .loader-count', { opacity: 0, y: -16, duration: 0.7, stagger: 0.06, ease: 'power2.in' }, 1.75)
  .to('.loader', { backgroundColor: 'rgba(0, 17, 10, 0)', duration: 0.8, ease: 'power1.inOut' }, 1.9)
  // scene fades up on the closed gate
  .to(renderer, { toneMappingExposure: 1.05, duration: 2.2, ease: 'power2.out' }, 1.9)
  .to(rig, { pz: 15, py: 3.4, duration: 2.6, ease: 'power2.out' }, 1.9)
  // light starts leaking through the seams
  .to(fx, { seam: 1, duration: 1.0, ease: 'power2.in' }, 2.6)
  // the gate opens
  .to(fx, { open: 1, duration: 2.4, ease: 'power3.inOut' }, 3.3)
  .to(fx, { flood: 1.4, duration: 1.4, ease: 'power2.in' }, 3.3)
  .to(bloom, { strength: 0.6, duration: 1.4, ease: 'power2.in' }, 3.3)
  // step up to the open gate, into its light
  .to(rig, { pz: DOOR_Z + 1.4, py: 3.2, duration: 2.0, ease: 'power2.in' }, 3.7)
  .to(rig, { ty: 3.4, duration: 2.0, ease: 'power2.inOut' }, 3.7)
  // the light becomes the home image
  .set(plateU.uFlash, { value: 1 }, 0)
  .to(plateIntro, { v: 1, duration: 0.6, ease: 'power2.in' }, 5.1)
  .to(plateU.uFlash, { value: 0, duration: 1.6, ease: 'power2.out' }, 5.7)
  // UI arrives
  .to('.nav', { opacity: 1, y: 0, duration: 1.1, ease: 'power3.out' }, 6.2)
  .to(chars, { opacity: 1, yPercent: 0, filter: 'blur(0px)', duration: 1.2, stagger: 0.03, ease: 'power3.out', clearProps: 'filter,willChange' }, 6.2)
  .to('.hero-sub', { opacity: 1, y: 0, duration: 1, ease: 'power3.out' }, 6.8)
  .to('.hero .btn', { opacity: 1, y: 0, duration: 1, ease: 'power3.out' }, 7.0)
  .to('.scroll-hint', { opacity: 1, y: 0, duration: 1, ease: 'power3.out' }, 7.2)
  .set('.loader', { display: 'none' }, 2.6)
  .call(finishIntro, null, 6.6);

function finishIntro() {
  if (introDone) return;
  introDone = true;
  entrance.visible = rig.pz < DOOR_Z; // behind us now
  document.body.classList.remove('is-loading');
  setupScroll();
}

document.getElementById('skip').addEventListener('click', () => intro.timeScale(6));
if (reduceMotion) intro.timeScale(4);

/* =========================================================
   Scroll-driven experience
   ========================================================= */
function setupScroll() {
  setupProjects();   // pinned sections are created top-to-bottom
  setupWhy();
  ScrollTrigger.create({
    trigger: '#content', start: 'top top', end: 'bottom bottom',
    onUpdate: (s) => (scrollP = s.progress),
  });

  // fade the hero copy as you scroll
  gsap.to('.hl, .hero-foot, .scroll-hint', {
    opacity: 0, ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom 35%', scrub: true },
  });

  document.querySelectorAll('.panel').forEach((panel) => {
    const items = panel.querySelectorAll('.reveal, .eyebrow, .display, .lede, .stats > div, .contact .btn');
    gsap.from(items, {
      opacity: 0, y: 50, duration: 1.1, stagger: 0.1, ease: 'power3.out',
      scrollTrigger: { trigger: panel, start: 'top 72%' },
    });
  });

  gsap.set('.gate-card', { opacity: 0 });
  ScrollTrigger.batch('.gate-card', {
    start: 'top 88%',
    onEnter: (els) => gsap.fromTo(els, { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 1, stagger: 0.08, ease: 'power3.out' }),
  });

  // How we do — each step lights up in turn and the dotted path draws to the next
  const steps = gsap.utils.toArray('.step');
  gsap.set(steps, { opacity: 0, y: 40 });
  gsap.set(steps, { '--draw': 0 });
  gsap.timeline({ scrollTrigger: { trigger: '.steps', start: 'top 78%' } })
    .to(steps, { opacity: 1, y: 0, duration: 0.8, stagger: 0.22, ease: 'power3.out' })
    .to(steps, { '--draw': 1, duration: 0.5, stagger: 0.22, ease: 'power2.inOut' }, 0.35);

  // number counters
  document.querySelectorAll('[data-count]').forEach((el) => {
    const o = { v: 0 };
    ScrollTrigger.create({
      trigger: el, start: 'top 85%', once: true,
      onEnter: () => gsap.to(o, { v: +el.dataset.count, duration: 1.8, ease: 'power2.out', onUpdate: () => (el.textContent = Math.round(o.v) + (el.dataset.suffix || '')) }),
    });
  });

  // active nav link
  const links = [...document.querySelectorAll('.nav-links a')];
  document.querySelectorAll('main > section').forEach((sec) => {
    ScrollTrigger.create({
      trigger: sec, start: 'top 50%', end: 'bottom 50%',
      onToggle: (s) => s.isActive && links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + sec.id)),
    });
  });

  ScrollTrigger.refresh();
}

/* =========================================================
   Projects — pinned horizontal scroll (desktop), swipe (mobile), filters
   ========================================================= */
const projTrack = document.querySelector('.proj-track');
const projViewport = document.querySelector('.proj-viewport');
const projBar = document.querySelector('.proj-progress span');
const projEmpty = document.querySelector('.proj-empty');
let projST = null;

// drop an image into assets/projects/ with the placeholder's filename and it appears automatically
document.querySelectorAll('.proj-ph').forEach((ph) => {
  const img = new Image();
  img.onload = () => {
    img.alt = ph.closest('.proj-card').querySelector('h3').textContent;
    img.style.cssText = 'position:absolute;inset:0;';
    ph.replaceWith(img);
  };
  img.src = ph.dataset.src;
});

function setupProjects() {
  const cards = gsap.utils.toArray('.proj-card');
  gsap.from(cards, {
    opacity: 0, x: 80, duration: 1, stagger: 0.08, ease: 'power3.out',
    scrollTrigger: { trigger: '#projects', start: 'top 70%' },
  });

  const mm = gsap.matchMedia();
  mm.add('(min-width: 861px)', () => {
    const dist = () => Math.max(0, projTrack.scrollWidth - projViewport.clientWidth);
    const tween = gsap.to(projTrack, {
      x: () => -dist(), ease: 'none',
      scrollTrigger: {
        trigger: '#projects', start: 'top top',
        end: () => '+=' + Math.max(dist(), 1),
        pin: true, scrub: 0.7, invalidateOnRefresh: true,
        onUpdate: (st) => (projBar.style.transform = `scaleX(${st.progress})`),
      },
    });
    projST = tween.scrollTrigger;
    return () => { projST = null; gsap.set(projTrack, { x: 0 }); };
  });
  mm.add('(max-width: 860px)', () => {
    const onScroll = () => {
      const max = projViewport.scrollWidth - projViewport.clientWidth;
      projBar.style.transform = `scaleX(${max > 0 ? projViewport.scrollLeft / max : 1})`;
    };
    projViewport.addEventListener('scroll', onScroll, { passive: true });
    return () => projViewport.removeEventListener('scroll', onScroll);
  });
}

document.querySelectorAll('.pf-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const f = btn.dataset.filter;
    document.querySelectorAll('.pf-btn').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    const cards = [...projTrack.children];
    const show = (c) => f === 'all' || c.dataset.cats.split(' ').includes(f);
    gsap.to(cards.filter((c) => !c.hidden), {
      opacity: 0, y: 24, duration: 0.25, ease: 'power2.in', overwrite: true,
      onComplete() {
        cards.forEach((c) => (c.hidden = !show(c)));
        const visible = cards.filter(show);
        projEmpty.hidden = visible.length > 0;
        ScrollTrigger.refresh();
        if (projST && scrollY > projST.start) scrollTo({ top: projST.start });
        projViewport.scrollLeft = 0;
        gsap.fromTo(visible, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6, stagger: 0.07, ease: 'power3.out' });
      },
    });
  });
});

/* =========================================================
   Why NineGates — while pinned, tiles rise one by one and stack below each other
   ========================================================= */
function setupWhy() {
  const tiles = gsap.utils.toArray('.why-tile');
  const line = document.querySelector('.why-line i');
  const mark = (i) => tiles.forEach((t, k) => t.classList.toggle('is-current', k === i));
  const mm = gsap.matchMedia();

  mm.add('(min-width: 861px)', () => {
    gsap.set(tiles, { opacity: 0, y: 260 });
    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: '#why', start: 'top top',
        end: () => '+=' + innerHeight * 0.55 * tiles.length,
        pin: true, scrub: 0.8, invalidateOnRefresh: true,
        onUpdate: (st) => mark(st.progress < 0.03 ? -1 : Math.min(tiles.length - 1, Math.floor(st.progress * tiles.length))),
      },
    });
    tiles.forEach((t, i) => tl.to(t, { opacity: 1, y: 0, duration: 1, ease: 'power3.out' }, i));
    tl.to(line, { scaleY: 1, duration: tiles.length, ease: 'none' }, 0);
    return () => { gsap.set(tiles, { clearProps: 'opacity,transform' }); mark(-1); };
  });

  mm.add('(max-width: 860px)', () => {
    tiles.forEach((t) => gsap.from(t, {
      opacity: 0, y: 40, duration: 0.8, ease: 'power3.out',
      scrollTrigger: { trigger: t, start: 'top 88%' },
    }));
  });
}

/* =========================================================
   Client testimonials
   Replace the placeholder quotes below with real ones from each client.
   ========================================================= */
const TESTIMONIALS = [
  {
    img: 'assets/testimonials/crovon-biotech.png', pos: '56% 50%', tpos: '56% 50%', title: 'Crovon Biotech', cat: 'Brand & Identity',
    quote: '“The team at NINEGATES understood our brand vision and translated it into creative designs that reflect our identity. Their attention to detail, clear communication and approach to presenting our products made the collaboration a positive experience. Looking forward to working together on future projects.”',
    name: 'Praveen', company: 'Crovon Biotech',
  },
  {
    img: 'assets/testimonials/mentcura.png', pos: '46% 50%', tpos: '50% 50%', title: 'Mentcura', cat: 'Web Design',
    quote: 'PLACEHOLDER — add Mentcura’s testimonial here.', name: 'Client name', company: 'Mentcura',
  },
  {
    img: 'assets/testimonials/little-moments.png', pos: '68% 30%', tpos: '68% 35%', title: 'Little Moments', cat: 'Photography',
    quote: 'PLACEHOLDER — add the Little Moments testimonial here.', name: 'Client name', company: 'Little Moments',
  },
  {
    img: 'assets/testimonials/exselent-launch-film.png', pos: '47% 30%', tpos: '50% 30%', title: 'RiVUe', cat: 'AI creative film',
    quote: 'PLACEHOLDER — add RiVUe’s testimonial here.', name: 'Client name', company: 'RiVUe',
  },
];
{
  const sec = document.getElementById('testimonials');
  const thumbs = sec.querySelector('.testi-thumbs');
  const bgs = [...sec.querySelectorAll('.testi-bg img')];
  const fImg = sec.querySelector('.tf-img .fit-main');
  const fFill = sec.querySelector('.tf-img .fit-fill');
  const fText = sec.querySelector('.tf-text');
  const q = sec.querySelector('.tf-quote-text');
  const nm = sec.querySelector('.tf-name');
  const co = sec.querySelector('.tf-company');
  let cur = -1, bgFlip = 0, timer = null;

  thumbs.innerHTML = TESTIMONIALS.map((t, i) => `
    <button class="tt" type="button" role="tab" aria-selected="false" data-i="${i}">
      <span class="tt-media"><img class="fit-fill" src="${t.img}" alt="" aria-hidden="true" /><img class="fit-main" src="${t.img}" alt="" loading="lazy" /></span>
      <span><strong>${t.title}</strong><em>${t.cat}</em></span>
    </button>`).join('');
  const tts = [...thumbs.children];

  function show(i, instant = false) {
    i = (i + TESTIMONIALS.length) % TESTIMONIALS.length;
    if (i === cur) return;
    const dir = i > cur ? 1 : -1;
    cur = i;
    const t = TESTIMONIALS[i];
    tts.forEach((el, k) => { el.classList.toggle('is-active', k === i); el.setAttribute('aria-selected', String(k === i)); });
    const tt = tts[i];
    thumbs.scrollTo({ left: tt.offsetLeft - thumbs.clientWidth / 2 + tt.clientWidth / 2, behavior: instant ? 'auto' : 'smooth' });

    // background crossfade
    const next = bgs[bgFlip ^= 1], prev = bgs[bgFlip ^ 1];
    next.src = t.img;
    gsap.to(next, { opacity: 1, scale: 1, duration: instant ? 0 : 1.4, ease: 'power2.out', startAt: { scale: 1.03 } });
    gsap.to(prev, { opacity: 0, duration: instant ? 0 : 1.2, ease: 'power2.out' });

    // image wipes in from the arch side
    fImg.src = t.img;
    fFill.src = t.img;
    fImg.alt = t.title;
    if (!instant) gsap.fromTo(fFill, { opacity: 0 }, { opacity: 1, duration: 0.9, ease: 'power2.out' });
    if (!instant) gsap.fromTo(fImg, { clipPath: dir > 0 ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)', scale: 1.08 },
      { clipPath: 'inset(0 0 0 0%)', scale: 1, duration: 1, ease: 'power3.inOut' });

    // quote slides
    const swap = () => { q.textContent = t.quote; nm.textContent = t.name; co.textContent = t.company; };
    if (instant) { swap(); return; }
    gsap.timeline()
      .to(fText, { opacity: 0, x: -24 * dir, duration: 0.3, ease: 'power2.in' })
      .add(swap)
      .fromTo(fText, { x: 24 * dir }, { opacity: 1, x: 0, duration: 0.55, ease: 'power3.out' });
  }

  const restart = () => { clearInterval(timer); timer = setInterval(() => show(cur + 1), 8000); };
  tts.forEach((el) => el.addEventListener('click', () => { show(+el.dataset.i); restart(); }));
  sec.querySelectorAll('.arrow-prev').forEach((b) => b.addEventListener('click', () => { show(cur - 1); restart(); }));
  sec.querySelectorAll('.arrow-next').forEach((b) => b.addEventListener('click', () => { show(cur + 1); restart(); }));
  sec.addEventListener('pointerenter', () => clearInterval(timer));
  sec.addEventListener('pointerleave', restart);

  show(0, true);
  // only auto-advance while the section is on screen
  ScrollTrigger.create({ trigger: sec, start: 'top 80%', end: 'bottom 20%', onToggle: (st) => (st.isActive ? restart() : clearInterval(timer)) });
}

/* =========================================================
   FAQ — one answer open at a time, smooth height
   ========================================================= */
{
  const items = [...document.querySelectorAll('.faq-item')];
  const toggle = (item, open) => {
    const btn = item.querySelector('.faq-q');
    const ans = item.querySelector('.faq-a');
    item.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
    gsap.to(ans, { height: open ? 'auto' : 0, duration: open ? 0.6 : 0.45, ease: 'power3.inOut', onComplete: () => ScrollTrigger.refresh() });
    if (open) gsap.fromTo(ans.firstElementChild, { opacity: 0, y: -8 }, { opacity: 1, y: 0, duration: 0.5, delay: 0.15, ease: 'power2.out' });
  };
  items.forEach((item) => {
    item.querySelector('.faq-q').addEventListener('click', () => {
      const willOpen = !item.classList.contains('is-open');
      items.forEach((o) => o !== item && o.classList.contains('is-open') && toggle(o, false));
      toggle(item, willOpen);
    });
  });
  // tiles float up in sequence when the section arrives
  gsap.from(items, {
    opacity: 0, y: 36, duration: 0.8, stagger: 0.07, ease: 'power3.out',
    scrollTrigger: { trigger: '.faq-list', start: 'top 80%' },
  });
}

/* =========================================================
   Contact form — glass dialog; routes the filled form to WhatsApp or email
   ========================================================= */
const WA_NUMBER = '918074570609';
const CONTACT_EMAIL = 'ninegates.official@gmail.com';
const cf = document.getElementById('contactForm');
const cfPanel = cf.querySelector('.cf-panel');
const cfForm = cf.querySelector('.cf-form');
const cfDone = cf.querySelector('.cf-done');
const cfError = cf.querySelector('.cf-error');
let cfLastFocus = null;

function openContactForm() {
  cfLastFocus = document.activeElement;
  cf.hidden = false;
  cfForm.hidden = false;
  cfDone.hidden = true;
  document.documentElement.style.overflow = 'hidden';
  gsap.fromTo(cf.querySelector('.cf-overlay'), { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power2.out' });
  gsap.fromTo(cfPanel, { opacity: 0, y: 40, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, ease: 'power3.out' });
  gsap.fromTo(cf.querySelectorAll('.cf-side > *, .cf-field, .cf-actions'), { opacity: 0, y: 14 },
    { opacity: 1, y: 0, duration: 0.5, stagger: 0.03, delay: 0.12, ease: 'power3.out' });
  setTimeout(() => cfForm.querySelector('input')?.focus({ preventScroll: true }), 350);
}
function closeContactForm() {
  if (cf.hidden) return;
  gsap.to(cf.querySelector('.cf-overlay'), { opacity: 0, duration: 0.3 });
  gsap.to(cfPanel, {
    opacity: 0, y: 30, duration: 0.35, ease: 'power2.in',
    onComplete: () => { cf.hidden = true; document.documentElement.style.overflow = ''; cfLastFocus?.focus?.({ preventScroll: true }); },
  });
}
document.querySelectorAll('.js-open-form').forEach((el) => el.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopImmediatePropagation();
  openContactForm();
}));
cf.querySelectorAll('[data-cf-close]').forEach((el) => el.addEventListener('click', closeContactForm));
addEventListener('keydown', (e) => {
  if (cf.hidden) return;
  if (e.key === 'Escape') closeContactForm();
  if (e.key === 'Tab') { // keep focus inside the dialog
    const f = [...cfPanel.querySelectorAll('a, button, input, select, textarea')].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
});

let cfVia = 'whatsapp';
cf.querySelectorAll('.cf-send[data-via]').forEach((b) => b.addEventListener('click', () => (cfVia = b.dataset.via)));
cfForm.querySelectorAll('input, select, textarea').forEach((el) =>
  el.addEventListener('input', () => el.closest('.cf-field').classList.remove('is-invalid')));

cfForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const via = e.submitter?.dataset.via || cfVia;
  // validate
  const bad = [...cfForm.querySelectorAll('[required]')].filter((el) => !el.value.trim() || (el.type === 'email' && !el.checkValidity()));
  cfForm.querySelectorAll('.cf-field').forEach((f) => f.classList.remove('is-invalid'));
  if (bad.length) {
    bad.forEach((el) => el.closest('.cf-field').classList.add('is-invalid'));
    cfError.textContent = bad.some((el) => el.type === 'email' && el.value.trim())
      ? 'Please check your email address.' : 'Please fill in the highlighted fields.';
    cfError.hidden = false;
    bad[0].focus();
    gsap.fromTo(cfPanel, { x: -8 }, { x: 0, duration: 0.5, ease: 'elastic.out(1, 0.35)' });
    return;
  }
  cfError.hidden = true;

  const v = Object.fromEntries(new FormData(cfForm));
  const field = (label, val) => (val && val.trim() ? `${label}: ${val.trim()}` : null);
  const lines = [
    field('Name', v.name),
    field('Email', v.email),
    field('Phone', v.phone),
    field('Company', v.company),
    field('Service', v.service),
    field('Budget', v.budget),
  ].filter(Boolean).concat(['', v.message.trim()]);

  if (via === 'email') {
    const subject = `New project enquiry — ${v.name}${v.company ? ' (' + v.company + ')' : ''}`;
    location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
  } else {
    const text = ['Hi NineGates! I’d like to start a project.', '', ...lines].join('\n');
    window.open(`https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }
  cf.querySelector('.cf-done-via').textContent = via === 'email' ? 'your email app' : 'WhatsApp';
  cfForm.hidden = true;
  cfDone.hidden = false;
  gsap.fromTo(cfDone.children, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power3.out' });
  cfForm.reset();
});

/* =========================================================
   Start a project — the "Get In Touch" knob slides across (click, or drag it)
   ========================================================= */
{
  const btn = document.querySelector('.cta-btn');
  const knob = btn.querySelector('.cta-knob');
  const travel = () => btn.clientWidth - knob.offsetWidth - knob.offsetLeft * 2;
  const reset = () => { btn.style.removeProperty('--x'); btn.style.removeProperty('--fs'); };
  const finish = () => {
    reset();
    btn.classList.add('is-done');           // knob glides to the end, pill fills cream
    // the slide completes, then the contact form opens (WhatsApp/email are inside it)
    setTimeout(openContactForm, 550);
    setTimeout(() => btn.classList.remove('is-done'), 1800);
  };

  let startX = 0, dx = 0, dragging = false, moved = false;
  knob.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false; dx = 0; startX = e.clientX;
    knob.setPointerCapture(e.pointerId);
    btn.classList.add('is-dragging');
    e.preventDefault();
  });
  knob.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = Math.max(0, Math.min(travel(), e.clientX - startX));
    if (dx > 4) moved = true;
    btn.style.setProperty('--x', dx + 'px');
    btn.style.setProperty('--fs', 1);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    btn.classList.remove('is-dragging');
    if (dx > travel() * 0.65) finish(); else reset();   // let go early → springs back
  };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  // never get stuck mid-drag: if the pointer is lost or the window/tab loses focus, finish or spring back
  knob.addEventListener('lostpointercapture', end);
  addEventListener('blur', end);
  document.addEventListener('visibilitychange', () => document.hidden && end());
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();           // we handle the scroll after the slide
    if (moved) { moved = false; return; }
    finish();
  });

  // entrance: copy rises, the button slides in from the right
  gsap.from(['.cta-title', '.cta-copy'], { opacity: 0, y: 30, duration: 1, stagger: 0.1, ease: 'power3.out', scrollTrigger: { trigger: '.cta', start: 'top 70%' } });
  gsap.from(btn, { opacity: 0, x: 60, duration: 1.1, ease: 'power3.out', scrollTrigger: { trigger: '.cta', start: 'top 70%' } });
}

/* =========================================================
   Marquee — Strategy ⋒ Design ⋒ Content, nudged by scroll speed
   ========================================================= */
const mq = gsap.to('.mq-track', { xPercent: -50, duration: 38, ease: 'none', repeat: -1 });
ScrollTrigger.create({
  trigger: '.marquee', start: 'top bottom', end: 'bottom top',
  onUpdate: (self) => {
    const v = gsap.utils.clamp(-4, 4, self.getVelocity() / 400);
    gsap.to(mq, { timeScale: 1 + Math.abs(v), duration: 0.2, overwrite: true });
    gsap.to(mq, { timeScale: 1, duration: 1.2, delay: 0.2, ease: 'power2.out' });
  },
});


/* =========================================================
   Interactions
   ========================================================= */
addEventListener('pointermove', (e) => {
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = (e.clientY / innerHeight) * 2 - 1;
  mouseSeen = true;
});
// step through the glowing gate: click the arch opening to enter the site
heroEl.addEventListener('click', (e) => {
  if (!portalHover || e.target.closest('a, button')) return;
  const next = document.getElementById('about');
  if (next) window.scrollTo({ top: next.offsetTop, behavior: 'smooth' });
});

// smooth anchor navigation
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    const target = id.length > 1 && document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    if (!introDone) return;
    window.scrollTo({ top: target.offsetTop, behavior: 'smooth' });
    closeMenu();
  });
});

// mobile menu
const burger = document.getElementById('burger');
const navLinks = document.getElementById('navLinks');
function closeMenu() { navLinks.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); }
burger.addEventListener('click', () => {
  const open = !navLinks.classList.contains('open');
  navLinks.classList.toggle('open', open);
  burger.setAttribute('aria-expanded', String(open));
});

if (!isTouch) {
  // custom cursor
  const cursor = document.getElementById('cursor');
  const cx = gsap.quickTo(cursor, 'x', { duration: 0.35, ease: 'power3.out' });
  const cy = gsap.quickTo(cursor, 'y', { duration: 0.35, ease: 'power3.out' });
  addEventListener('pointermove', (e) => { cx(e.clientX); cy(e.clientY); });
  document.querySelectorAll('a, button, .gate-card, .proj-card, .tt').forEach((el) => {
    el.addEventListener('pointerenter', () => cursor.classList.add('is-hover'));
    el.addEventListener('pointerleave', () => cursor.classList.remove('is-hover'));
  });

  // headline letters lift as the cursor passes over them
  const lift = [...heroTitle.querySelectorAll('.ch')].map((ch) => ({ ch, to: gsap.quickTo(ch, 'y', { duration: 0.7, ease: 'power3.out' }) }));
  addEventListener('pointermove', (e) => {
    if (!introDone || scrollY > innerHeight * 0.6) return;
    const R = Math.max(90, innerWidth * 0.07);
    for (const { ch, to } of lift) {
      const r = ch.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      to(-Math.exp(-(dx * dx + dy * dy) / (R * R)) * r.height * 0.09);
    }
  });

  // magnetic buttons
  document.querySelectorAll('.magnetic').forEach((el) => {
    const xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'elastic.out(1, 0.4)' });
    const yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'elastic.out(1, 0.4)' });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * 0.25);
      yTo((e.clientY - (r.top + r.height / 2)) * 0.35);
    });
    el.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
  });

  // project card tilt
  document.querySelectorAll('.tilt').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      gsap.to(el, { rotateY: x * 10, rotateX: -y * 10, transformPerspective: 900, duration: 0.6, ease: 'power2.out' });
    });
    el.addEventListener('pointerleave', () => gsap.to(el, { rotateX: 0, rotateY: 0, duration: 0.9, ease: 'power3.out' }));
  });
}

// hero "Start a Project": measure how far the arrow disc travels to reach the right end
function measureSlide() {
  document.querySelectorAll('.btn-glass').forEach((b) => {
    const disc = b.querySelector('.btn-arrow');
    if (disc) b.style.setProperty('--slide', b.clientWidth - disc.offsetWidth - disc.offsetLeft * 2 + 'px');
  });
}
addEventListener('resize', measureSlide);
(document.fonts?.ready ?? Promise.resolve()).then(measureSlide);

/* =========================================================
   Hero layout — pin the HTML text to the Figma frame positions
   ========================================================= */
function layoutHero() {
  heroEl.style.height = innerHeight + 'px';
  const pr = renderer.getPixelRatio();
  plateU.uRes.value.set(innerWidth * pr, innerHeight * pr);
}

/* =========================================================
   Resize
   ========================================================= */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.fov = isMobile() ? 58 : 40;
  if (introDone) fx.lens = LENS();
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  bloom.setSize(innerWidth, innerHeight);
  const pr = renderer.getPixelRatio();
  reflector.getRenderTarget().setSize(innerWidth * 0.5 * pr, innerHeight * 0.5 * pr);
  layoutHero();
});

/* =========================================================
   Go
   ========================================================= */
history.scrollRestoration = 'manual';
scrollTo(0, 0);
// Safari/Chrome can restore the old position after load or from the back/forward cache
addEventListener('load', () => { if (!introDone) scrollTo(0, 0); });
addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
layoutHero();
tick();
// dev shortcut: index.html?skip#section — skip the intro and jump to a section
const DEV_SKIP = new URLSearchParams(location.search).has('skip');
(document.fonts?.ready ?? Promise.resolve()).then(() => {
  layoutHero();
  intro.play();
  if (DEV_SKIP) {
    intro.progress(1);
    const target = location.hash && document.querySelector(location.hash);
    // one-shot: clean the address so a normal reload plays the intro again
    history.replaceState(null, '', location.pathname);
    if (target) setTimeout(() => {
      ScrollTrigger.refresh();
      const box = target.parentElement.classList.contains('pin-spacer') ? target.parentElement : target;
      scrollTo(0, box.getBoundingClientRect().top + scrollY);
    }, 900);
  }
});
