/* =========================================================================
   THE FIRST-SCREEN SCENE

   An orb with a nebula in metal palms. The surface is a domain-warped
   three-dimensional fractal, evaluated along the sphere normal (not over a
   flat unwrap: an unwrap puts a singular point on the front face, and a
   "flower" blooms in the centre). Fresnel gives the darkening towards the
   edge and the glowing rim of the atmosphere. The hands are lit by the orb
   and REFLECT it: every frame a cube camera shoots the scene with the hands
   and the mark hidden, and that map goes into their environment.

   Taken from a study of somebody else's first screen: the shader, the numbers
   of the motion and the timings are left as they were, they are that scene.
   The palette has been repainted: the blue fog taken down into the green of
   Pons, the metal of the hands into sage, the mark in the centre is ours.

   A module rather than an ordinary script: three.js arrives from a foreign
   CDN through an importmap. If the CDN does not answer, this file will not
   run at all, which is why everything the page stops being a page without
   (the splash, the reveals, the numbers) lives in intro.js and does not
   depend on three.js.
   ========================================================================= */
import {
  AmbientLight, Box3, CubeCamera, DirectionalLight, Group,
  LinearMipmapLinearFilter, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PerspectiveCamera, PlaneGeometry, PointLight, Raycaster, Scene, ShaderMaterial,
  SphereGeometry, SRGBColorSpace, TextureLoader, Vector2, Vector3,
  WebGLCubeRenderTarget, WebGLRenderer,
} from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }     from 'three/addons/loaders/DRACOLoader.js';

const CFG = {
  cameraFov: 32,
  sphereScale: 0.62,
  bloomStrength: 0.19,
  parallaxAmplitude: 0.79,
  levitationAmplitude: 0.08,
  /* The window in the centre of the orb. It was 0.37, that is, the front wall
     stayed 63% opaque, and the mark behind it looked like a blurred pink
     smudge rather than an object inside a sphere. At 0.72 the wall all but
     parts, the centre of the orb goes into darkness, and the mark reads as
     what it is. */
  centerDarken: 0.72,
  centerSize: 0.50,

  /* The light pouring from the orb onto the palms. In the source it is a blue
     #7c9cfe; here it is the light green of Pons, the same tone as the accent
     of the page. */
  glowColor: '#A3B181',

  /* THE LIGHT ON THE HANDS IS FULLY RESTORED.

     I once cut it back: the reflection from 2.25 down to 1.40, the point
     light from 6 down to 3.2, chasing legibility for the captions over the
     frame. The captions became legible and the palms disappeared: they were
     the only lit object in the frame. Dimming an object for the sake of a
     caption underneath it is not a solution, and it was noticed at once.
     Legibility is now held by a backing assembled along the lines of text,
     not by dimming the whole scene. */
  hands: { color: '#C6CFAE', roughness: 0.31, metalness: 0.83, envMapIntensity: 2.25 },
  glowIntensity: 6,

  /* THE MARK IS FLAT, AND THAT IS A DECISION, NOT LAZINESS.

     I did build a three-dimensional one: the silhouette taken off mark.png,
     extruded with a bevel, smoothed by angle, a matcap with a highlight and a
     reflection of the orb laid over it. It worked honestly, but it looked not
     like our mark, rather like a three-dimensional retelling of it: the
     render that was sent over is glass with its own thickness and its own
     highlights, and extruding a flat contour cannot reproduce them. Rolled
     back by Alexander's decision.

     What is left is a plane with the same PNG, placed in the centre. So that
     it does not read as a sticker, it is given a slight motion of its own,
     see sway in the frame loop. */
  /* THE ASPECT IS TAKEN FROM THE FILE: the previous mark was 395 by 512, the
     new one is nearly square, 1024 by 1049. With the old number the plane
     would squeeze it by a quarter across the width. */
  logo: { scale: 0.49, depth: -0.37, aspect: 1024 / 1049 },

  nebula: {
    /* The roles are the same as in the source: void, then the body of the
       cloud, then the bright ridges, then the hot core. The blue has been
       replaced with the green of Pons; the stars are left black, as in the
       original set, because they add nothing there.

       THE TONES WERE PICKED BY LUMINANCE, NOT BY LOOK: in luminance green
       weighs 0.7152 and blue 0.0722, so "the same tone, only green" comes out
       ten times lighter. Each tone is matched to the luminance of its
       original: body 0.087 (was 0.075), ridges 0.325 (0.321), core 0.188
       (0.183). */
    colDeep:   '#080C06',
    colNebula: '#33512D',
    colBright: '#A3B181',
    colHot:    '#6E8F52',
    colStar:   '#000000',
    nebulaScale: 2.4,
    flowSpeed: 0.295,
    starDensity: 0.85,
    twinkleSpeed: 2,
    swirlStrength: 0.35,
    glowStrength: 0.34,
    brightness: 1.73,
    cursorLerp: 0.25,
  },
};

const HANDS_URL = '/hands.glb';
const MARK_URL  = '/mark.png';
const HANDS_SCALE = 1.72;
const HANDS_FLY_DISTANCE = 4;
const HANDS_FLY_MS = 1700;
const HANDS_CUE = window.APEX_HANDS_CUE ?? 2500;
const CAMERA_Z = 3;             // the distance on a wide screen, as in the source
const PARALLAX_LERP = 0.06;
const LEVITATION_SPEED = 0.6;   // rad/s
const SPIN_SPEED = 0.15;        // rad/s
const FRONT_DIR = new Vector3(0, 0, 1);

/* A colour from a string into a vector, WITH A CONVERSION INTO LINEAR SPACE.

   The source has no conversion, it simply divides by 255. This is not
   nitpicking: the shader writes into the composer buffer, the buffer is
   linear, and OutputPass at the end converts it into sRGB. Writing "as is" is
   treated as linear and comes out on screen noticeably lighter than intended.
   Blue nearly gets away with it, since its weight in luminance is 0.0722 and
   a lightened blue is still blue. Green weighs 0.7152, and the same mistake
   turns a forest tone into pale mint: the orb came out a whitish sphere
   behind which the mark and half the text disappeared. Four rounds of tone
   picking in a row did not help, because the tones were not the problem. */
const hexToVec3 = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return new Vector3(
    s2l(((n >> 16) & 255) / 255),
    s2l(((n >> 8) & 255) / 255),
    s2l((n & 255) / 255),
  );
};

const vertexShader = /* glsl */`
  varying vec3 vObjNormal;   // object space: the nebula is sampled along it
  varying vec3 vViewNormal;  // view space: for the fresnel
  varying vec3 vViewPos;

  void main() {
    vObjNormal = normalize(normal);
    vViewNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */`
  precision highp float;

  uniform float iTime, iAlpha, iPointer;
  uniform vec3  uMouseDir;
  uniform vec3  uDeep, uNebula, uBright, uHot, uStar;
  uniform float uScale, uFlow, uStarDensity, uTwinkle, uSwirl, uGlow, uBrightness;
  uniform float uCenterDark;
  uniform float uCenterSize;

  varying vec3 vObjNormal;
  varying vec3 vViewNormal;
  varying vec3 vViewPos;

  // --- three-dimensional value noise ---
  float hash13(vec3 p){
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec3 p){
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), u.x),
          mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), u.x), u.y),
      mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), u.x),
          mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), u.x), u.y),
      u.z);
  }

  // a rotation on every octave: otherwise the noise lattice gives bands along the axes
  const mat3 M3 = mat3( 0.00,  0.80,  0.60,
                       -0.80,  0.36, -0.48,
                       -0.60, -0.48,  0.64 );

  float fbm(vec3 p){
    float v = 0., a = 0.5;
    for (int i = 0; i < 5; i++){ v += a * vnoise(p); p = M3 * p * 2.0 + 7.0; a *= 0.5; }
    return v;
  }
  float fbmw(vec3 p){
    float v = 0., a = 0.5;
    for (int i = 0; i < 3; i++){ v += a * vnoise(p); p = M3 * p * 2.0 + 7.0; a *= 0.5; }
    return v;
  }

  // rotate v around the unit axis k by the angle a (Rodrigues)
  vec3 rotAxis(vec3 v, vec3 k, float a){
    float c = cos(a), s = sin(a);
    return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
  }

  float starLayer(vec3 x, float thr, float tw){
    vec3 i = floor(x), f = fract(x) - 0.5;
    float h = hash13(i);
    if (h < thr) return 0.0;
    float b = (h - thr) / (1.0 - thr);
    vec3 off = 0.7 * (vec3(hash13(i + 7.3), hash13(i + 13.1), hash13(i + 23.7)) - 0.5);
    float d = length(f - off);
    float tw2 = 0.5 + 0.5 * sin(iTime * tw + h * 42.0);
    return smoothstep(0.09, 0.0, d) * b * tw2;
  }

  void main() {
    vec3 dir = normalize(vObjNormal);
    float t = iTime * uFlow;

    // the cursor swirls the field around the axis of the pointed-at spot
    float md = distance(dir, uMouseDir);
    float stir = uSwirl * iPointer / (1.0 + md * md * 6.0);
    vec3 sdir = rotAxis(dir, normalize(uMouseDir), stir);

    // a cloud field with domain warping
    vec3 p = sdir * uScale + vec3(0.0, t, 0.0);
    vec3 w1 = vec3(fbmw(p + 11.0), fbmw(p + 27.0), fbmw(p + 41.0));
    vec3 w2 = vec3(
      fbmw(p * 1.5 + 4.0 * w1 + vec3(t, 0.0, 0.0)),
      fbmw(p * 1.5 + 4.0 * w1 + vec3(0.0, 0.0, -t)),
      fbmw(p * 1.5 + 4.0 * w1 + vec3(0.0, t, 0.0))
    );
    float n    = fbm(p + 3.0 * w2);
    float fine = fbmw(p * 3.0 + 6.0 * w2);

    float dens = pow(smoothstep(0.25, 0.95, n), 1.3);

    // the ramp: void -> the body of the cloud -> bright ridges -> hot core
    vec3 col = uDeep;
    col = mix(col, uNebula, smoothstep(0.20, 0.60, n));
    col = mix(col, uBright, smoothstep(0.55, 0.95, n) * (0.5 + 0.5 * fine));
    col = mix(col, uHot,    smoothstep(0.75, 1.00, n) * smoothstep(0.40, 1.0, fine) * 0.8);
    col *= 0.3 + 1.15 * dens;

    float st = starLayer(sdir * 8.0  + 20.0, 0.86, uTwinkle)
             + starLayer(sdir * 16.0 + 50.0, 0.90, uTwinkle * 1.3) * 0.8
             + starLayer(sdir * 32.0 + 80.0, 0.93, uTwinkle * 0.7) * 0.6;
    col += uStar * st * uStarDensity;

    vec3 hero = normalize(vec3(0.45, 0.55, 0.7));
    float hd = distance(dir, hero);
    float twH = 0.7 + 0.3 * sin(iTime * 1.5);
    col += uStar * exp(-hd * hd * 500.0) * 1.6 * twH * uStarDensity;

    float cg = exp(-md * md * 7.0) * uGlow * (0.25 + 0.85 * iPointer);
    col += mix(uBright, uHot, 0.5) * cg;

    // volume: darkening towards the silhouette plus the glowing rim of the atmosphere
    vec3 V = normalize(-vViewPos);
    vec3 N = normalize(vViewNormal);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float rim = pow(1.0 - ndv, 3.0);
    col *= mix(0.5, 1.0, ndv);
    col += mix(uBright, uHot, 0.5) * rim * 0.6;

    // a dark see-through window at the very centre of the visible disc, with the mark behind it
    float inner = mix(0.97, 0.4, clamp(uCenterSize, 0.0, 1.0));
    float centre = smoothstep(inner, min(inner + 0.12, 0.999), ndv);
    float hole = centre * uCenterDark;
    col *= 1.0 - hole;

    col *= uBrightness;
    gl_FragColor = vec4(col, iAlpha * (1.0 - hole));
  }
`;

const container = document.getElementById('scene');
if (container) start(container);

function start(container) {

const renderer = new WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);       // transparent: the background comes from the page
container.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(CFG.cameraFov, window.innerWidth / window.innerHeight, 0.1, 80);

/* THE CAMERA SETBACK IS COMPUTED FROM THE WIDTH, NOT SET AS A NUMBER.

   A perspective camera has its angle set vertically, so on a narrow screen
   the horizontal angle collapses, and at the same distance the orb takes up
   almost the whole width. On a 390×844 phone it flooded the screen entirely
   and the text lay over glowing green: that is visible on a screenshot, not
   derived from theory.

   We count from the fraction of the width the orb occupies. At a mockup
   1440×900 the angular radius of the sphere is 11.9° against a half
   horizontal angle of 24.7°, a ratio of 0.484, and at that proportion the
   formula yields exactly three units by itself, that is, a wide screen stays
   identical to the source down to the digit. In portrait the same 0.484
   cannot be kept: the camera drives back to almost eight and the orb becomes
   a distant dot. So the fraction grows smoothly up to 0.85. */
const camDist = () => {
  const aspect = window.innerWidth / window.innerHeight;
  const vHalf = (CFG.cameraFov / 2) * Math.PI / 180;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const t = Math.min(1, Math.max(0, (aspect - 0.7) / 0.5));
  const ratio = 0.85 + (0.484 - 0.85) * t;
  const want = Math.sin(Math.min(ratio * hHalf, Math.PI / 2 - 1e-3));
  return Math.min(8, Math.max(CAMERA_Z, CFG.sphereScale / want));
};
let camZ = camDist();
camera.position.set(0, 0, camZ);
camera.lookAt(0, 0, 0);

/* ---------- the orb ---------- */
const geometry = new SphereGeometry(1, 192, 192);
const material = new ShaderMaterial({
  vertexShader, fragmentShader, transparent: true,
  uniforms: {
    iTime: { value: 0 },
    iAlpha: { value: 0 },
    uMouseDir: { value: FRONT_DIR.clone() },
    iPointer: { value: 0 },
    uDeep:   { value: hexToVec3(CFG.nebula.colDeep) },
    uNebula: { value: hexToVec3(CFG.nebula.colNebula) },
    uBright: { value: hexToVec3(CFG.nebula.colBright) },
    uHot:    { value: hexToVec3(CFG.nebula.colHot) },
    uStar:   { value: hexToVec3(CFG.nebula.colStar) },
    uScale:  { value: CFG.nebula.nebulaScale },
    uFlow:   { value: CFG.nebula.flowSpeed },
    uStarDensity: { value: CFG.nebula.starDensity },
    uTwinkle:{ value: CFG.nebula.twinkleSpeed },
    uSwirl:  { value: CFG.nebula.swirlStrength },
    uGlow:   { value: CFG.nebula.glowStrength },
    uBrightness:  { value: CFG.nebula.brightness },
    uCenterDark:  { value: CFG.centerDarken },
    uCenterSize:  { value: CFG.centerSize },
  },
});
const sphere = new Mesh(geometry, material);
sphere.scale.setScalar(CFG.sphereScale);
scene.add(sphere);

/* ---------- the reflection: a cube camera shoots the orb into an environment map ---------- */
const cubeRT = new WebGLCubeRenderTarget(256, {
  generateMipmaps: true, minFilter: LinearMipmapLinearFilter,
});
const cubeCamera = new CubeCamera(0.1, 100, cubeRT);
scene.environment = cubeRT.texture;

/* ---------- light (needed only by the hands; the orb glows by itself) ---------- */
scene.add(new AmbientLight(0x1A2417, 0.6));
const glow = new PointLight(CFG.glowColor, CFG.glowIntensity, 12, 2);
glow.position.set(0, 0, 0);
scene.add(glow);
const fill = new DirectionalLight(0x7E8F6A, 0.45);
fill.position.set(0.6, 0.8, 2);
scene.add(fill);

/* ---------- the hands ---------- */
const handsMaterial = new MeshStandardMaterial({
  color: CFG.hands.color,
  roughness: CFG.hands.roughness,
  metalness: CFG.hands.metalness,
  envMap: cubeRT.texture,
  envMapIntensity: CFG.hands.envMapIntensity,
});
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(draco);

let hands = null;
let handParts = [];
gltfLoader.load(HANDS_URL, (gltf) => {
  hands = gltf.scene;
  hands.traverse((o) => { if (o.isMesh) o.material = handsMaterial; });
  hands.scale.setScalar(HANDS_SCALE);
  hands.position.set(0, 0, 0);
  scene.add(hands);

  /* We split it into two palms so that the upper one flies in from above and
     the lower one from below. The threshold is the mean world centre along Y:
     it does not depend on how the author of the model named the nodes. */
  const parts = hands.children.length >= 2 ? [...hands.children] : [];
  if (parts.length < 2) hands.traverse((o) => { if (o.isMesh) parts.push(o); });
  const centreY = parts.map((p) => new Box3().setFromObject(p).getCenter(new Vector3()).y);
  const mid = centreY.reduce((a, b) => a + b, 0) / (centreY.length || 1);
  handParts = parts.map((p, i) => ({ obj: p, restY: p.position.y, dir: centreY[i] >= mid ? 1 : -1 }));
}, undefined, (e) => console.warn('the hands model did not load:', e));

/* ---------- the mark in the centre of the orb ---------- */
let logo = null;
new TextureLoader().load(MARK_URL, (tex) => {
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  /* A basic material, not a lit one. Two reasons. The first: the light is
     already painted into the mark, and lighting it with the scene means
     arguing with those highlights. The second matters more: the point light
     of the orb stands 0.37 units from the mark with quadratic falloff, and
     any lit material burns out there into a white hole; I saw that on a
     render when I tried making the mark three-dimensional. A basic material
     needs no light at all.
     depthWrite is off, otherwise the plane punches a hole in the transparent orb. */
  const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
  const plane = new Mesh(new PlaneGeometry(CFG.logo.aspect, 1), mat);
  logo = new Group();
  logo.add(plane);
  logo.scale.setScalar(CFG.logo.scale);
  scene.add(logo);
});

/* ---------- the glow ---------- */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new Vector2(window.innerWidth, window.innerHeight), CFG.bloomStrength, 0.5, 0.2);
composer.addPass(bloom);
composer.addPass(new OutputPass());
composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
composer.setSize(window.innerWidth, window.innerHeight);

/* ---------- the cursor ---------- */
const raycaster = new Raycaster();
const ndc = new Vector2(0, 0);
const lastNdc = new Vector2(0, 0);
const mouseDir = FRONT_DIR.clone();
const mouseTargetDir = FRONT_DIR.clone();
const parallax = new Vector2(0, 0);
const parallaxTarget = new Vector2(0, 0);
let pointer = 0;
let pointerTarget = 0;

window.addEventListener('pointermove', (e) => {
  const nx = (e.clientX / window.innerWidth) * 2 - 1;
  const ny = -((e.clientY / window.innerHeight) * 2 - 1);
  /* The stirring energy is taken from the speed of the cursor across the
     screen rather than from a hit on the orb: otherwise the motion would be
     found only over the sphere itself. */
  pointerTarget = Math.min(1, pointerTarget + Math.hypot(nx - lastNdc.x, ny - lastNdc.y) * 4);
  lastNdc.set(nx, ny);
  ndc.set(nx, ny);
  parallaxTarget.set(nx, ny);

  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(sphere, false)[0];
  if (!hit) return;
  mouseTargetDir.copy(sphere.worldToLocal(hit.point.clone()).normalize());
}, { passive: true });

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
  camZ = camDist();          // turning a phone changes the framing
});

/* THE SCENE STOPS DRAWING ONCE THE SCREEN HAS GONE BY.

   There used to be one page and it was always in view; now the whole rest of
   the site lies below the first screen, and keeping a shader on 192×192
   segments with bloom running for something nobody can see means warming up
   the phone of a person reading the ledger. */
let visible = true;
const section = container.closest('.hero3d') || container;
if ('IntersectionObserver' in window) {
  new IntersectionObserver(
    (es) => { visible = es[0].isIntersecting; },
    { rootMargin: '120px' },
  ).observe(section);
}

/* The countdown is shared with the splash: the hands have to fly in exactly
   when the curtains leave, not when this module has finished loading. */
const appearStart = window.APEX_START ?? performance.now();

function renderFrame(now) {
  mouseDir.lerp(mouseTargetDir, CFG.nebula.cursorLerp).normalize();
  pointerTarget *= 0.94;
  pointer += (pointerTarget - pointer) * 0.1;

  const u = material.uniforms;
  u.iTime.value = now / 1000;
  u.uMouseDir.value.copy(mouseDir);
  u.iPointer.value = pointer;
  u.iAlpha.value = Math.min(Math.max((now - appearStart - 400) / 1000, 0), 1);

  // the orb rocks in the palms
  sphere.position.y = Math.sin((now / 1000) * LEVITATION_SPEED) * CFG.levitationAmplitude;

  /* The camera circles the orb following the cursor, which is why the hands
     move around it. The orb itself turns to face the camera so that the
     nebula does not "slide", and on top of that it gets a slow rotation. */
  parallax.lerp(parallaxTarget, PARALLAX_LERP);
  camera.position.set(parallax.x * CFG.parallaxAmplitude, parallax.y * CFG.parallaxAmplitude, camZ);
  camera.lookAt(0, 0, 0);
  sphere.lookAt(camera.position);
  sphere.rotateY(((now / 1000) * SPIN_SPEED) % (Math.PI * 2));

  /* THE MARK IS FIXED IN PLACE, NOT TURNED TOWARDS THE CAMERA.

     There used to be logo.lookAt(camera.position): the plane turned to the
     camera every frame, and with a movement of the mouse the mark travelled
     across the sphere separately from it. That read as a sticker being blown
     about by a draught.

     Now the plane stands still and only follows the rocking of the orb. The
     camera shifts by fractions of a unit, so the mark changes its angle
     slightly along with the whole scene, that is, it behaves like an object
     inside the sphere rather than like a picture on top of it. */
  /* THE MARK IS SLIGHTLY ALIVE, BUT IT DOES NOT TRAVEL.

     At first logo.lookAt(camera.position) stood here: the plane turned to the
     camera every frame, and with a movement of the mouse the mark crept
     across the sphere separately from it, reading as a sticker in a draught.

     Now it is fixed and only sways slightly on its own: two slow tilts with
     different periods (0.31 and 0.24 rad/s) plus the general rise along with
     the orb. The periods are deliberately NOT multiples of each other:
     multiples converge into one beat, and the sway becomes a noticeable
     pendulum instead of breathing. The amplitudes are on the order of a
     degree and a half: you can see the object is alive, and you cannot see
     that it moves. */
  if (logo) {
    const t = now / 1000;
    logo.position.set(
      Math.sin(t * 0.23) * 0.012,
      sphere.position.y + Math.sin(t * 0.41) * 0.010,
      CFG.logo.depth,
    );
    logo.rotation.set(
      Math.sin(t * 0.24) * 0.022,
      Math.sin(t * 0.31) * 0.028,
      Math.sin(t * 0.19) * 0.014,
    );
  }

  /* The flight of the hands is a critically damped spring, solved
     analytically: off(t) = A·(1 + ω·t)·e^(−ω·t). It does not need to keep a
     velocity between frames, and it does not depend on the frame rate. Unlike
     a decaying curve, the velocity at zero is zero too: the hands set off
     softly rather than starting with a jerk. */
  if (handParts.length) {
    const tt = (now - appearStart - HANDS_CUE) / 1000;
    const omega = 5.8 / (HANDS_FLY_MS / 1000);
    const off = tt <= 0
      ? HANDS_FLY_DISTANCE
      : (1 + omega * tt) * Math.exp(-omega * tt) * HANDS_FLY_DISTANCE;
    for (const h of handParts) h.obj.position.y = h.restY + h.dir * off;
  }

  /* The reflection map: we shoot the scene with the hands and the mark
     hidden, otherwise the hands would reflect themselves. */
  if (hands) hands.visible = false;
  if (logo) logo.visible = false;
  cubeCamera.update(renderer, scene);
  if (hands) hands.visible = true;
  if (logo) logo.visible = true;

  composer.render();
}

(function tick() {
  requestAnimationFrame(tick);
  if (visible) renderFrame(performance.now());
})();

}
