import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { latLonToXYZ, angleBetween, framingDistance } from './geo.js';
import { t } from './i18n.js';

const INITIAL = new THREE.Vector3(0.15, 0.4, 3.8);
const IDLE_BEFORE_ROTATE_MS = 5000;
const clamp = THREE.MathUtils.clamp;
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// A real WebGL Earth. It owns the camera and exposes a small controller so the
// UI can place pins, fly to them, and make room for panels. The canvas is never
// moved or re-created; panels shift the *view* of the globe instead, which is
// what keeps the layout changes smooth.
// Throws if WebGL is unavailable: the caller shows a message and the rest of the app still works.
export function createGlobe(host, { onStatus = () => {}, isActive = () => true } = {}) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true'); // pins and the places list carry the meaning
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 100);
  camera.position.copy(INITIAL);
  const orbit = new OrbitControls(camera, renderer.domElement);
  Object.assign(orbit, {
    enablePan: false, enableDamping: true, dampingFactor: 0.07, rotateSpeed: 0.55, zoomSpeed: 0.65,
    minDistance: 2.25, maxDistance: 6.5, minPolarAngle: 0.15, maxPolarAngle: Math.PI - 0.15, autoRotateSpeed: 0.38
  });
  orbit.touches.ONE = THREE.TOUCH.ROTATE;
  orbit.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;

  scene.add(new THREE.AmbientLight(0xb9d2b4, 1.6));
  const sun = new THREE.DirectionalLight(0xffe8b8, 2.7);
  sun.position.set(-3, 3, 5);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x77b597, 2);
  rim.position.set(4, 1, -3);
  scene.add(rim);

  const globe = new THREE.Group();
  globe.rotation.z = 0.07;
  globe.rotation.y = 4.35;
  scene.add(globe);
  const material = new THREE.MeshPhongMaterial({ color: 0xd6e3c1, shininess: 16, specular: 0x536d4a });
  globe.add(new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), material));
  globe.add(new THREE.Mesh(new THREE.SphereGeometry(1.045, 64, 48), new THREE.ShaderMaterial({
    uniforms: { glowColor: { value: new THREE.Color(0x92aa68) } },
    vertexShader: `varying vec3 n; varying vec3 viewDir;
      void main(){vec4 p=modelViewMatrix*vec4(position,1.0);n=normalize(normalMatrix*normal);viewDir=normalize(-p.xyz);gl_Position=projectionMatrix*p;}`,
    fragmentShader: `uniform vec3 glowColor; varying vec3 n; varying vec3 viewDir;
      void main(){float edge=pow(1.0-abs(dot(normalize(n),normalize(viewDir))),3.0);gl_FragColor=vec4(glowColor,edge*0.38);}`,
    transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
  })));

  // ---- textures (bundled in public/textures; no CDN)
  const loader = new THREE.TextureLoader();
  const texturePath = name => import.meta.env.BASE_URL + 'textures/' + name;
  let clouds;
  loader.loadAsync(texturePath('earth_atmos_2048.jpg')).then(texture => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    material.map = texture;
    material.needsUpdate = true;
    renderer.domElement.dataset.textureLoaded = 'true';
    onStatus(null);
  }).catch(() => onStatus(t('globe.texture_failed')));
  loader.loadAsync(texturePath('earth_normal_2048.jpg')).then(t => {
    material.normalMap = t; material.normalScale.set(0.45, 0.45); material.needsUpdate = true;
  }).catch(() => {});
  loader.loadAsync(texturePath('earth_specular_2048.jpg')).then(t => {
    material.specularMap = t; material.needsUpdate = true;
  }).catch(() => {});
  loader.loadAsync(texturePath('earth_clouds_1024.png')).then(texture => {
    texture.colorSpace = THREE.SRGBColorSpace;
    clouds = new THREE.Mesh(new THREE.SphereGeometry(1.009, 64, 48), new THREE.MeshPhongMaterial({
      map: texture, transparent: true, opacity: 0.22, depthWrite: false, color: 0xe1e5cc }));
    globe.add(clouds);
  }).catch(() => {});

  // ---- sizing and the "inset": shift the globe's centre so open panels never cover it
  let width = 1, height = 1;
  const inset = { x: 0, y: 0 }, insetTarget = { x: 0, y: 0 };
  function applyView() {
    if (Math.abs(inset.x) < 0.4 && Math.abs(inset.y) < 0.4) camera.clearViewOffset();
    else camera.setViewOffset(width, height, -inset.x, -inset.y, width, height);
  }
  function resize() {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    width = rect.width; height = rect.height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    applyView();
  }
  let resizeQueued = false;
  const observer = new ResizeObserver(() => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; resize(); });
  });
  observer.observe(host);
  resize();

  // ---- camera flights (every move is eased; nothing snaps)
  let flight = null;
  function fly(direction, distance, ms = 1100) {
    const toDir = direction.clone().normalize();
    const toDist = clamp(distance, orbit.minDistance, orbit.maxDistance);
    if (reduced.matches || ms <= 0) {
      camera.position.copy(toDir).multiplyScalar(toDist);
      flight = null;
      orbit.update();
      return;
    }
    const fromDir = camera.position.clone().normalize();
    flight = { fromDir, q: new THREE.Quaternion().setFromUnitVectors(fromDir, toDir),
      fromDist: camera.position.length(), toDist, start: performance.now(), ms };
  }
  function stepFlight(now) {
    if (!flight) return;
    // The animation timestamp can precede performance.now() by a hair on the first frame; never go below 0.
    const k = easeInOut(clamp((now - flight.start) / flight.ms, 0, 1));
    const q = new THREE.Quaternion().slerp(flight.q, k);
    camera.position.copy(flight.fromDir).applyQuaternion(q)
      .setLength(flight.fromDist + (flight.toDist - flight.fromDist) * k);
    if (k >= 1) flight = null;
  }

  // ---- pins: only positions live here; the UI draws them as real buttons
  const points = new Map();
  const frameListeners = new Set();
  const tmp = new THREE.Vector3(), camWorld = new THREE.Vector3();
  function worldOf(point, target = new THREE.Vector3()) {
    return globe.localToWorld(target.copy(point.local));
  }
  function project() {
    camera.getWorldPosition(camWorld);
    const dist = camWorld.length(), horizon = 1 / dist;
    const out = [];
    globe.updateMatrixWorld();
    for (const [id, point] of points) {
      worldOf(point, tmp); // unit length: pins sit on the sphere surface
      const facing = clamp((tmp.dot(camWorld) / dist - horizon) / 0.18, 0, 1);
      tmp.project(camera);
      out.push({ id, x: (tmp.x * 0.5 + 0.5) * width, y: (-tmp.y * 0.5 + 0.5) * height, facing });
    }
    return out;
  }

  // ---- interaction state
  let autoPref = !reduced.matches, held = 0, interacting = false, lastInteraction = -Infinity, lost = false;
  let fitDist = 0; // smallest camera distance at which the globe still fits beside open panels
  orbit.addEventListener('start', () => { interacting = true; flight = null; lastInteraction = performance.now(); });
  orbit.addEventListener('end', () => { interacting = false; lastInteraction = performance.now(); });
  reduced.addEventListener('change', () => { autoPref = !reduced.matches; });
  orbit.addEventListener('change', () => { renderer.domElement.dataset.distance = camera.position.length().toFixed(3); });
  const publishInset = () => { renderer.domElement.dataset.inset = inset.x.toFixed(0) + ',' + inset.y.toFixed(0); }; // QA hook

  host.addEventListener('keydown', event => {
    if (event.target !== host) return;
    const spherical = new THREE.Spherical().setFromVector3(camera.position);
    if (['+', '='].includes(event.key)) controller.zoomBy(0.85);
    else if (event.key === '-') controller.zoomBy(1.18);
    else if (event.key.startsWith('Arrow')) {
      if (event.key === 'ArrowLeft') spherical.theta -= 0.2;
      if (event.key === 'ArrowRight') spherical.theta += 0.2;
      if (event.key === 'ArrowUp') spherical.phi -= 0.2;
      if (event.key === 'ArrowDown') spherical.phi += 0.2;
      spherical.phi = clamp(spherical.phi, orbit.minPolarAngle, orbit.maxPolarAngle);
      lastInteraction = performance.now();
      fly(new THREE.Vector3().setFromSpherical(spherical), spherical.radius, 240);
    } else return;
    event.preventDefault();
  });

  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); lost = true;
    onStatus(t('globe.context_lost'));
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => { lost = false; onStatus(null); resize(); });

  let lastFrame = null;
  renderer.setAnimationLoop(now => {
    // Never negative: the first rAF timestamp can be earlier than any clock we read before it, and a
    // negative step makes the inset easing run away from its target (the globe landing off-screen).
    const delta = lastFrame === null ? 0 : clamp((now - lastFrame) / 1000, 0, 0.05);
    lastFrame = now;
    if (lost || document.hidden || !isActive()) return;
    const follow = 1 - Math.exp(-delta * 7); // frame-rate independent easing of the inset
    inset.x += (insetTarget.x - inset.x) * follow;
    inset.y += (insetTarget.y - inset.y) * follow;
    applyView();
    publishInset();
    stepFlight(now);
    orbit.autoRotate = autoPref && held === 0 && !interacting && !flight && now - lastInteraction > IDLE_BEFORE_ROTATE_MS;
    orbit.update(delta);
    if (clouds && orbit.autoRotate) clouds.rotation.y += delta * 0.006;
    renderer.render(scene, camera);
    if (frameListeners.size) {
      const projected = project();
      for (const listener of frameListeners) listener(projected);
    }
  });

  const controller = {
    element: renderer.domElement,
    setPoints(list) {
      points.clear();
      for (const p of list) points.set(p.id, { lat: p.lat, lon: p.lon, local: new THREE.Vector3(...latLonToXYZ(p.lat, p.lon)) });
    },
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    // Make room for panels: positive x moves the globe right, positive y moves it down.
    // `fit` ({width, height} of the free area) also zooms out just enough that the whole
    // globe fits in it; pass null when no panel is open.
    setInsets(x, y, fit = null) {
      insetTarget.x = x; insetTarget.y = y;
      if (!fit || !fit.width || !fit.height) { fitDist = 0; return; }
      const k = (height / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const maxRadiusPx = Math.max(60, Math.min(fit.width, fit.height) / 2.1);
      fitDist = Math.min(orbit.maxDistance, Math.sqrt(1 + (k / maxRadiusPx) ** 2));
      if (camera.position.length() < fitDist - 0.05) fly(camera.position, fitDist, 700);
    },
    // Pause idle rotation while something (a glance card) is open; calls nest.
    hold(on) { held = Math.max(0, held + (on ? 1 : -1)); },
    focus(id, distance = 3.0) {
      const point = points.get(id);
      if (!point) return;
      lastInteraction = performance.now();
      fly(worldOf(point), Math.max(fitDist, Math.min(camera.position.length(), distance)), 1000);
    },
    // Turn the globe to show every id at once, zooming to fit their spread.
    // `tighten` < 1 zooms closer (used to pull apart a cluster of nearby pins).
    frame(ids, { tighten = 1 } = {}) {
      const dirs = ids.map(id => points.get(id)).filter(Boolean).map(p => worldOf(p).normalize());
      if (!dirs.length) return;
      const mean = dirs.reduce((sum, d) => sum.add(d), new THREE.Vector3()).normalize();
      const spread = Math.max(0, ...dirs.map(d => angleBetween(mean.toArray(), d.toArray())));
      lastInteraction = performance.now();
      // Zooming into a cluster is deliberate, so it may go closer than the panel-fit distance.
      fly(mean, tighten < 1 ? framingDistance(spread) * tighten : Math.max(fitDist, framingDistance(spread)), 1300);
    },
    reset() { lastInteraction = performance.now(); fly(INITIAL, Math.max(fitDist, INITIAL.length()), 900); },
    zoomBy(factor) { lastInteraction = performance.now(); fly(camera.position, camera.position.length() * factor, 260); },
    toggleRotation() { autoPref = !autoPref; return autoPref; },
    get rotating() { return autoPref; },
    dispose() {
      renderer.setAnimationLoop(null); observer.disconnect(); orbit.dispose();
      globe.traverse(object => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          for (const v of Object.values(object.material)) if (v?.isTexture) v.dispose();
          object.material.dispose();
        }
      });
      renderer.dispose();
    }
  };
  window.addEventListener('pagehide', () => controller.dispose(), { once: true });
  return controller;
}
