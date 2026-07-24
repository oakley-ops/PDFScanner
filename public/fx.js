/* fx.js — 3D and physics layer (all local, no CDN).
 *
 *   1. Ambient physics field — a full-viewport particle network with velocity,
 *      wander, cursor repulsion, and distance-based link lines. Lives behind
 *      the whole app, tinted to the theme.
 *   2. Welcome-hero 3D scene — a three.js microchip with orbiting particles,
 *      mouse parallax, theme-aware emissives.
 *   3. Physics celebrations — confetti with gravity, drag, and spin; each
 *      burst also shoves nearby ambient particles (fx:celebrate events).
 *   4. 3D tilt on quiz cards, suspended during drag interactions.
 *
 * Everything is skipped when the user prefers reduced motion.
 */

import * as THREE from '/vendor/three.module.js';

// Effects are on by default (the app owner wants them). Disable any time with
// localStorage.setItem('fx', 'off') and a refresh.
const reducedMotion = localStorage.getItem('fx') === 'off';
if (reducedMotion) console.info('[fx] effects disabled via localStorage.fx — remove the key and refresh to re-enable.');

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const onThemeChange = (fn) => {
  new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fn);
};

/* ── 1. Ambient physics field ───────────────────────────── */

const ambient = { parts: [], kick: null };

function mountAmbient() {
  if (reducedMotion) return;
  const canvas = document.createElement('canvas');
  // canvas is a replaced element: inset alone doesn't stretch it — size explicitly
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:0;';
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');

  let W = 0, H = 0;
  const size = () => {
    W = innerWidth; H = innerHeight;
    canvas.width = W * devicePixelRatio;
    canvas.height = H * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  };
  size();
  addEventListener('resize', size);

  const N = Math.min(85, Math.round(innerWidth / 18));
  for (let i = 0; i < N; i++) {
    ambient.parts.push({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
      r: 1.2 + Math.random() * 1.8,
    });
  }

  let dot = '#2a78d6', line = '#2a78d6';
  const retint = () => { dot = cssVar('--accent') || '#2a78d6'; line = dot; };
  retint();
  onThemeChange(retint);

  const mouse = { x: -9999, y: -9999 };
  addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  addEventListener('pointerleave', () => { mouse.x = -9999; mouse.y = -9999; });

  // celebrations shove nearby particles
  ambient.kick = (cx, cy, power) => {
    for (const p of ambient.parts) {
      const dx = p.x - cx, dy = p.y - cy;
      const d = Math.hypot(dx, dy);
      if (d < 260 && d > 0.01) {
        const f = (1 - d / 260) * 7 * power;
        p.vx += (dx / d) * f;
        p.vy += (dy / d) * f;
      }
    }
  };

  const LINK = 130;
  (function loop() {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    ctx.clearRect(0, 0, W, H);

    for (const p of ambient.parts) {
      // cursor repulsion
      const dx = p.x - mouse.x, dy = p.y - mouse.y;
      const d = Math.hypot(dx, dy);
      if (d < 150 && d > 0.01) {
        const f = (1 - d / 150) * 0.9;
        p.vx += (dx / d) * f;
        p.vy += (dy / d) * f;
      }
      // gentle wander + drag + speed clamp
      p.vx += (Math.random() - 0.5) * 0.03;
      p.vy += (Math.random() - 0.5) * 0.03;
      p.vx *= 0.985; p.vy *= 0.985;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 2.6) { p.vx = (p.vx / sp) * 2.6; p.vy = (p.vy / sp) * 2.6; }
      p.x += p.vx; p.y += p.vy;
      if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20;
      if (p.y < -20) p.y = H + 20; if (p.y > H + 20) p.y = -20;
    }

    ctx.lineWidth = 1;
    for (let i = 0; i < ambient.parts.length; i++) {
      const a = ambient.parts[i];
      for (let j = i + 1; j < ambient.parts.length; j++) {
        const b = ambient.parts[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < LINK * LINK) {
          ctx.globalAlpha = (1 - Math.sqrt(d2) / LINK) * 0.16;
          ctx.strokeStyle = line;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = dot;
    for (const p of ambient.parts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  })();
}

/* ── 2. Welcome-hero 3D scene ───────────────────────────── */

function mountHero() {
  const hero = document.querySelector('.hero');
  if (!hero || reducedMotion) return;
  const logo = hero.querySelector('.heroLogo');
  if (!logo) return;

  const mount = document.createElement('div');
  mount.style.cssText = 'width:100%;max-width:460px;height:230px;margin:0 auto 6px;cursor:grab;';
  logo.replaceWith(mount);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 2, 0.1, 60);
  camera.position.set(0, 1.6, 5.2);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.margin = '0 auto';
  mount.appendChild(renderer.domElement);

  const accent = () => new THREE.Color(cssVar('--accent') || '#2a78d6');

  const chip = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.55, roughness: 0.35 });
  chip.add(new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.34, 2.3), bodyMat));

  const dieMat = new THREE.MeshStandardMaterial({
    color: accent(), emissive: accent(), emissiveIntensity: 0.55, metalness: 0.2, roughness: 0.4,
  });
  const die = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.1, 0.95), dieMat);
  die.position.y = 0.22;
  chip.add(die);

  const pinMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.85, roughness: 0.3 });
  const pinGeo = new THREE.BoxGeometry(0.1, 0.08, 0.34);
  for (let i = 0; i < 8; i++) {
    const off = -0.98 + i * 0.28;
    for (const [x, z, rot] of [[off, 1.32, 0], [off, -1.32, 0], [1.32, off, Math.PI / 2], [-1.32, off, Math.PI / 2]]) {
      const pin = new THREE.Mesh(pinGeo, pinMat);
      pin.position.set(x, -0.05, z);
      pin.rotation.y = rot;
      chip.add(pin);
    }
  }
  const traceMat = new THREE.MeshStandardMaterial({ color: accent(), emissive: accent(), emissiveIntensity: 1.1 });
  for (let i = 0; i < 4; i++) {
    const trace = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.6 + Math.random() * 0.5), traceMat);
    trace.position.set(-0.65 - Math.random() * 0.3, 0.18, -0.6 + i * 0.4);
    chip.add(trace);
    const mirror = trace.clone();
    mirror.position.x = -trace.position.x;
    chip.add(mirror);
  }
  scene.add(chip);

  const N = 260;
  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 2.6 + Math.random() * 2.4;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = (Math.random() - 0.5) * 2.4;
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const pMat = new THREE.PointsMaterial({
    color: accent(), size: 0.035, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const particles = new THREE.Points(pGeo, pMat);
  scene.add(particles);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.PointLight(accent(), 14, 20);
  rim.position.set(-3, 2, -2);
  scene.add(rim);

  onThemeChange(() => {
    const c = accent();
    dieMat.color.copy(c); dieMat.emissive.copy(c);
    traceMat.color.copy(c); traceMat.emissive.copy(c);
    pMat.color.copy(c);
    rim.color.copy(c);
  });

  let targetRX = 0.12, targetRY = 0;
  mount.addEventListener('pointermove', (e) => {
    const rect = mount.getBoundingClientRect();
    targetRY = ((e.clientX - rect.left) / rect.width - 0.5) * 0.9;
    targetRX = 0.12 + ((e.clientY - rect.top) / rect.height - 0.5) * 0.5;
  });
  mount.addEventListener('pointerleave', () => { targetRX = 0.12; targetRY = 0; });

  const resize = () => {
    const w = mount.clientWidth || 460;
    const h = mount.clientHeight || 230;
    renderer.setSize(w, h); // updates canvas CSS size too — critical on retina
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(mount);
  resize();

  let visible = true;
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(mount);

  let spin = 0;
  const clock = new THREE.Clock();
  (function loop() {
    if (!mount.isConnected) { renderer.dispose(); return; }
    requestAnimationFrame(loop);
    if (!visible || document.hidden) return;
    const t = clock.getElapsedTime();
    spin += 0.0035;
    chip.rotation.y = spin + targetRY * 0.8;
    chip.rotation.x += (targetRX - chip.rotation.x) * 0.06;
    chip.position.y = Math.sin(t * 0.9) * 0.09;
    particles.rotation.y = -t * 0.05;
    renderer.render(scene, camera);
  })();

  // a small hello burst so the physics layer announces itself
  setTimeout(() => {
    const r = mount.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, 0.9);
  }, 900);
}

/* ── 3. Physics celebrations (confetti) ─────────────────── */

const COLORS = ['#0ca30c', '#2a78d6', '#fab219', '#e87ba4', '#1baf7a', '#eb6834'];
let confettiCanvas = null;
let cctx = null;
let parts = [];
let confettiRunning = false;

function ensureCanvas() {
  if (confettiCanvas) return;
  confettiCanvas = document.createElement('canvas');
  confettiCanvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;';
  document.body.appendChild(confettiCanvas);
  cctx = confettiCanvas.getContext('2d');
  const size = () => {
    confettiCanvas.width = innerWidth * devicePixelRatio;
    confettiCanvas.height = innerHeight * devicePixelRatio;
    cctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  };
  size();
  addEventListener('resize', size);
}

function burst(x, y, power) {
  if (reducedMotion) return;
  ensureCanvas();
  ambient.kick?.(x, y, power);
  const count = Math.round(45 * power);
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
    const speed = (5 + Math.random() * 8) * Math.sqrt(power);
    parts.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.35,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      life: 110 + Math.random() * 50,
      wobble: Math.random() * Math.PI * 2,
    });
  }
  if (!confettiRunning) {
    confettiRunning = true;
    requestAnimationFrame(stepConfetti);
  }
}

function stepConfetti() {
  cctx.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 30);
  for (const p of parts) {
    p.vy += 0.22;                 // gravity
    p.vx *= 0.988; p.vy *= 0.988; // drag
    p.wobble += 0.12;
    p.x += p.vx + Math.sin(p.wobble) * 0.6;
    p.y += p.vy;
    p.rot += p.vr;
    p.life--;
    cctx.save();
    cctx.translate(p.x, p.y);
    cctx.rotate(p.rot);
    cctx.globalAlpha = Math.min(1, p.life / 40);
    cctx.fillStyle = p.color;
    cctx.fillRect(-p.w / 2, -p.h / 2, p.w, Math.abs(Math.sin(p.wobble)) * p.h + 1);
    cctx.restore();
  }
  if (parts.length > 0) {
    requestAnimationFrame(stepConfetti);
  } else {
    confettiRunning = false;
    cctx.clearRect(0, 0, innerWidth, innerHeight);
  }
}

addEventListener('fx:celebrate', (e) => {
  const { el, power = 1 } = e.detail || {};
  let x = innerWidth / 2, y = innerHeight / 2;
  if (el && el.isConnected) {
    const r = el.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = Math.max(60, Math.min(innerHeight - 40, r.top + 40));
  }
  burst(x, y, power);
});

/* ── 4. 3D tilt on quiz cards ───────────────────────────── */

if (!reducedMotion) {
  const MAX_DEG = 2.2;
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.qcard');
    document.querySelectorAll('.qcard.tilted').forEach((c) => {
      if (c !== card) { c.style.transform = ''; c.classList.remove('tilted'); }
    });
    if (!card || card.classList.contains('resolved')) return;
    if (card.querySelector('.dragging')) return; // never fight a drag
    const r = card.getBoundingClientRect();
    const rx = ((e.clientY - r.top) / r.height - 0.5) * -MAX_DEG;
    const ry = ((e.clientX - r.left) / r.width - 0.5) * MAX_DEG;
    card.style.transform = `perspective(1100px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    card.classList.add('tilted');
  }, { passive: true });
  document.addEventListener('pointerleave', () => {
    document.querySelectorAll('.qcard.tilted').forEach((c) => { c.style.transform = ''; c.classList.remove('tilted'); });
  });
}

mountAmbient();
mountHero();
