import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Real WebGL sphere. It is geographic context, not a visualization of retrieval.
export function mountGlobe(host) {
  const message = document.getElementById('globe-message');
  const controlsUI = ['globe-in', 'globe-out', 'globe-reset', 'globe-rotate'].map(id => document.getElementById(id));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    message.textContent = 'Interactive Earth requires WebGL 2. Enable browser graphics acceleration or use a compatible browser. Research search still works.';
    controlsUI.forEach(b => b.disabled = true);
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('aria-label', 'Textured 3D Earth');
  renderer.domElement.setAttribute('role', 'img');
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 100);
  const initialPosition = new THREE.Vector3(0.15, 0.4, 3.8);
  camera.position.copy(initialPosition);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enablePan = false;
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.07;
  orbit.rotateSpeed = 0.55;
  orbit.zoomSpeed = 0.65;
  orbit.minDistance = 2.25;
  orbit.maxDistance = 6.5;
  orbit.minPolarAngle = 0.15;
  orbit.maxPolarAngle = Math.PI - 0.15;
  orbit.autoRotateSpeed = 0.38;
  orbit.touches.ONE = THREE.TOUCH.ROTATE;
  orbit.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
  let auto = !reduced.matches, interacting = false, lastInteraction = -Infinity;
  const rotateButton = document.getElementById('globe-rotate');
  function rotationLabel() {
    rotateButton.textContent = auto ? 'Pause rotation' : 'Resume rotation';
    rotateButton.setAttribute('aria-pressed', String(auto));
  }
  rotationLabel();
  orbit.addEventListener('start', () => { interacting = true; lastInteraction = performance.now(); });
  orbit.addEventListener('end', () => { interacting = false; lastInteraction = performance.now(); });
  orbit.addEventListener('change', () => {
    const zoom = Math.round(initialPosition.length() / camera.position.length() * 100);
    document.getElementById('globe-scale').textContent = zoom + '%';
    // DOM-observable diagnostics for interaction QA; no geographic inference.
    renderer.domElement.dataset.azimuth = orbit.getAzimuthalAngle().toFixed(3);
    renderer.domElement.dataset.distance = camera.position.length().toFixed(3);
  });
  scene.add(new THREE.AmbientLight(0xb9d2b4, 1.6));
  const sunlight = new THREE.DirectionalLight(0xffe8b8, 2.7);
  sunlight.position.set(-3, 3, 5); scene.add(sunlight);
  const rimLight = new THREE.DirectionalLight(0x77b597, 2);
  rimLight.position.set(4, 1, -3); scene.add(rimLight);
  const globe = new THREE.Group();
  globe.rotation.z = 0.07;
  globe.rotation.y = 4.35;
  scene.add(globe);
  const geometry = new THREE.SphereGeometry(1, 96, 64);
  const material = new THREE.MeshPhongMaterial({ color: 0xd6e3c1, shininess: 16, specular: 0x536d4a });
  const earth = new THREE.Mesh(geometry, material);
  globe.add(earth);
  // Thin Fresnel shell; gold-green edge light, not a flat image halo.
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.045, 64, 48), new THREE.ShaderMaterial({
    uniforms: { glowColor: { value: new THREE.Color(0x92aa68) } },
    vertexShader: `varying vec3 n; varying vec3 viewDir;
      void main(){vec4 p=modelViewMatrix*vec4(position,1.0);n=normalize(normalMatrix*normal);viewDir=normalize(-p.xyz);gl_Position=projectionMatrix*p;}`,
    fragmentShader: `uniform vec3 glowColor; varying vec3 n; varying vec3 viewDir;
      void main(){float edge=pow(1.0-abs(dot(normalize(n),normalize(viewDir))),3.0);gl_FragColor=vec4(glowColor,edge*0.38);}`,
    transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
  }));
  globe.add(atmosphere);
  const loader = new THREE.TextureLoader();
  let clouds;
  const texturePath = name => import.meta.env.BASE_URL + 'textures/' + name;
  const load = name => loader.loadAsync(texturePath(name));
  load('earth_atmos_2048.jpg').then(texture => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    material.map = texture; material.needsUpdate = true;
    message.hidden = true;
    renderer.domElement.dataset.textureLoaded = 'true';
  }).catch(() => {
    message.hidden = false;
    message.textContent = 'Earth texture could not load. Check the bundled public/textures folder. Research search remains available.';
  });
  load('earth_normal_2048.jpg').then(texture => { material.normalMap = texture; material.normalScale.set(.45, .45); material.needsUpdate = true; }).catch(() => {});
  load('earth_specular_2048.jpg').then(texture => { material.specularMap = texture; material.needsUpdate = true; }).catch(() => {});
  load('earth_clouds_1024.png').then(texture => {
    texture.colorSpace = THREE.SRGBColorSpace;
    clouds = new THREE.Mesh(new THREE.SphereGeometry(1.009, 64, 48), new THREE.MeshPhongMaterial({ map: texture, transparent: true, opacity: .22, depthWrite: false, color: 0xe1e5cc }));
    globe.add(clouds);
  }).catch(() => {});
  function resize() {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
  function zoomBy(factor) {
    const distance = THREE.MathUtils.clamp(camera.position.length() * factor, orbit.minDistance, orbit.maxDistance);
    camera.position.setLength(distance); lastInteraction = performance.now(); orbit.update();
  }
  document.getElementById('globe-in').onclick = () => zoomBy(.85);
  document.getElementById('globe-out').onclick = () => zoomBy(1.18);
  document.getElementById('globe-reset').onclick = () => { camera.position.copy(initialPosition);orbit.target.set(0,0,0);lastInteraction=performance.now();orbit.update(); };
  rotateButton.onclick = () => { auto = !auto; rotationLabel(); };
  reduced.addEventListener('change', () => { auto = !reduced.matches; rotationLabel(); });
  host.addEventListener('keydown', event => {
    if (event.target !== host) return;
    if (['+', '='].includes(event.key)) zoomBy(.9);
    else if (event.key === '-') zoomBy(1.1);
    else if (event.key.startsWith('Arrow')) {
      const spherical = new THREE.Spherical().setFromVector3(camera.position);
      if (event.key === 'ArrowLeft') spherical.theta -= .12;
      if (event.key === 'ArrowRight') spherical.theta += .12;
      if (event.key === 'ArrowUp') spherical.phi -= .12;
      if (event.key === 'ArrowDown') spherical.phi += .12;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi, orbit.minPolarAngle, orbit.maxPolarAngle);
      camera.position.setFromSpherical(spherical); lastInteraction = performance.now(); orbit.update();
    } else return;
    event.preventDefault();
  });
  let lost = false, lastFrame = performance.now();
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); lost = true; message.hidden = false;
    message.textContent = 'The 3D view was interrupted. Waiting for graphics recovery. Your research answer is unaffected.';
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => { lost = false; message.hidden = material.map !== null; resize(); });
  renderer.setAnimationLoop(now => {
    const delta = Math.min((now - lastFrame) / 1000, .05); lastFrame = now;
    if (lost || document.hidden || document.getElementById('panel-ask').hidden) return;
    orbit.autoRotate = auto && !interacting && now - lastInteraction > 5000;
    orbit.update(delta);
    if (clouds && orbit.autoRotate) clouds.rotation.y += delta * .006;
    renderer.render(scene, camera);
  });
  window.addEventListener('pagehide', () => {
    renderer.setAnimationLoop(null); observer.disconnect(); orbit.dispose();
    globe.traverse(object => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) { for (const v of Object.values(object.material)) if(v?.isTexture) v.dispose(); object.material.dispose(); }
    });
    renderer.dispose();
  }, { once: true });
}
