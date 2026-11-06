/* Courtroom 3D preview. Three.js is vendored locally under its MIT license. */
(() => {
  'use strict';
  const SCALE = 0.015;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  let modulePromise;
  window.Courtroom3D = {
    async create(host) {
      modulePromise ||= import('./three.module.min.js');
      const THREE = await modulePromise;
      return new Viewer(THREE, host);
    }
  };

  class Viewer {
    constructor(T, host) {
      this.T = T;
      this.host = host;
      this.scene = new T.Scene();
      this.scene.background = new T.Color('#132820');
      this.scene.fog = new T.Fog('#132820', 45, 100);
      this.camera = new T.PerspectiveCamera(43, 1, 0.1, 140);
      this.renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = T.PCFSoftShadowMap;
      this.renderer.outputColorSpace = T.SRGBColorSpace;
      this.renderer.toneMapping = T.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.25;
      this.renderer.domElement.setAttribute('aria-label', '3D 篮球场，拖动旋转视角，滚轮缩放');
      this.renderer.domElement.setAttribute('role', 'img');
      this.renderer.domElement.tabIndex = 0;
      this.host.replaceChildren(this.renderer.domElement);
      const hemi = new T.HemisphereLight('#edf6ed', '#63715e', 2.7);
      this.scene.add(hemi);
      const sun = new T.DirectionalLight('#fff5dd', 3.8);
      sun.position.set(-8, 22, 12);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 25, bottom: -25, far: 65 });
      sun.shadow.bias = -0.001;
      this.scene.add(sun);
      const floor = new T.Mesh(new T.PlaneGeometry(180, 180), new T.MeshStandardMaterial({ color: '#1a352a', roughness: 0.95 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.2;
      floor.receiveShadow = true;
      this.scene.add(floor);
      const grid = new T.GridHelper(120, 60, '#244336', '#203d31');
      grid.position.y = -0.19;
      this.scene.add(grid);
      this.staticGroup = new T.Group();
      this.playerGroup = new T.Group();
      this.routeGroup = new T.Group();
      this.scene.add(this.staticGroup, this.playerGroup, this.routeGroup);
      this.ball = new T.Mesh(new T.SphereGeometry(0.14, 24, 16), new T.MeshStandardMaterial({ color: '#e29a35', roughness: 0.6 }));
      this.ball.castShadow = true;
      const seams = new T.MeshBasicMaterial({ color: '#69451d' });
      for (let i = 0; i < 3; i++) {
        const ring = new T.Mesh(new T.TorusGeometry(0.1408, 0.004, 4, 40), seams);
        if (i === 1) ring.rotation.y = Math.PI / 2;
        if (i === 2) ring.rotation.x = Math.PI / 2;
        this.ball.add(ring);
      }
      this.scene.add(this.ball);
      this.players = new Map();
      this.yaw = 0.35;
      this.polar = 0.72;
      this.radius = 25;
      this.target = new T.Vector3(0, 0.4, 0);
      this.showRoutes = true;
      this.pointer = null;
      this.bindCamera();
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(host);
      this.resize();
    }

    clear(group) {
      const geometries = new Set(), materials = new Set(), textures = new Set();
      group.traverse(node => {
        if (node.geometry) geometries.add(node.geometry);
        const list = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
        for (const m of list) { materials.add(m); if (m.map) textures.add(m.map); }
      });
      group.clear();
      geometries.forEach(g => g.dispose());
      materials.forEach(m => m.dispose());
      textures.forEach(t => t.dispose());
    }

    world(point, y = 0) {
      return new this.T.Vector3((point.x - 500) * SCALE, y, (point.y - this.height / 2) * SCALE);
    }

    mesh(geometry, color, x, y, z, parent, roughness = 0.7) {
      const m = new this.T.Mesh(geometry, new this.T.MeshStandardMaterial({ color, roughness }));
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    }

    makeCourt(mode) {
      const T = this.T;
      this.clear(this.staticGroup);
      this.height = mode === 'full' ? 1880 : 940;
      const length = this.height * SCALE;
      this.mesh(new T.BoxGeometry(15.4, 0.18, length + 0.4), '#8b6d40', 0, -0.1, 0, this.staticGroup);
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = Math.round(this.height * 1.2);
      const ctx = canvas.getContext('2d');
      ctx.scale(1.2, 1.2);
      ctx.fillStyle = '#e2bf83';
      ctx.fillRect(0, 0, 1000, this.height);
      for (let y = 0; y < this.height; y += 55) {
        ctx.fillStyle = y % 110 === 0 ? '#e5c58e' : '#ddba7d';
        ctx.fillRect(0, y, 1000, 54);
        ctx.strokeStyle = '#caa66c';
        ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1000, y); ctx.stroke();
        for (let x = (y % 110 === 0 ? 0 : 150); x < 1000; x += 300) {
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 55); ctx.stroke();
        }
      }
      ctx.fillStyle = '#c59e62';
      ctx.globalAlpha = 0.25;
      ctx.fillRect(330, 36, 340, 365);
      if (mode === 'full') ctx.fillRect(330, this.height - 401, 340, 365);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#fff2d2';
      ctx.lineWidth = 4;
      ctx.strokeRect(36, 36, 928, this.height - 72);
      const end = () => {
        for (const path of [
          'M80 36V280A450 450 0 0 0 920 280V36',
          'M330 36V401H670V36', 'M330 401A170 170 0 0 0 670 401',
          'M410 113A90 90 0 0 0 590 113', 'M460 88H540'
        ]) ctx.stroke(new Path2D(path));
        ctx.setLineDash([9, 9]);
        ctx.stroke(new Path2D('M330 401A170 170 0 0 1 670 401'));
        ctx.setLineDash([]);
      };
      end();
      if (mode === 'full') {
        ctx.save(); ctx.translate(1000, this.height); ctx.rotate(Math.PI); end(); ctx.restore();
        ctx.beginPath(); ctx.moveTo(36, 940); ctx.lineTo(964, 940); ctx.stroke();
        ctx.beginPath(); ctx.arc(500, 940, 170, 0, Math.PI * 2); ctx.stroke();
      } else ctx.stroke(new Path2D('M330 904A170 170 0 0 1 670 904'));
      ctx.fillStyle = '#987642';
      ctx.font = '600 19px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('C O U R T R O O M', 500, this.height - 100);
      const texture = new T.CanvasTexture(canvas);
      texture.colorSpace = T.SRGBColorSpace;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      const plane = new T.Mesh(new T.PlaneGeometry(15, length), new T.MeshStandardMaterial({ map: texture, roughness: 0.8 }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = 0.005;
      plane.receiveShadow = true;
      this.staticGroup.add(plane);
      this.makeHoop(113, false);
      if (mode === 'full') this.makeHoop(1767, true);
    }

    makeHoop(y, reverse) {
      const T = this.T, group = new T.Group();
      const z = (y - this.height / 2) * SCALE;
      group.position.set(0, 0, z);
      if (reverse) group.rotation.y = Math.PI;
      this.staticGroup.add(group);
      this.mesh(new T.CylinderGeometry(0.07, 0.11, 3.75, 12), '#506c60', 0, 1.75, -1.0, group);
      this.mesh(new T.BoxGeometry(0.12, 0.12, 0.8), '#506c60', 0, 3.35, -0.65, group);
      const board = this.mesh(new T.BoxGeometry(1.8, 1.05, 0.05), '#e5eee5', 0, 3.5, -0.4, group);
      board.material.transparent = true; board.material.opacity = 0.48; board.material.depthWrite = false;
      const outline = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(1.8, 1.05, 0.06)), new T.LineBasicMaterial({ color: '#e9f1e7' }));
      outline.position.copy(board.position); group.add(outline);
      const square = new T.LineSegments(new T.EdgesGeometry(new T.PlaneGeometry(0.6, 0.45)), new T.LineBasicMaterial({ color: '#fff9e8' }));
      square.position.set(0, 3.35, -0.36); group.add(square);
      const rim = this.mesh(new T.TorusGeometry(0.24, 0.023, 8, 40), '#df7243', 0, 3.05, 0, group);
      rim.rotation.x = -Math.PI / 2;
      const netPoints = [];
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2, b = a + 0.22;
        netPoints.push(new T.Vector3(Math.cos(a) * 0.23, 3.04, Math.sin(a) * 0.23), new T.Vector3(Math.cos(b) * 0.15, 2.62, Math.sin(b) * 0.15));
      }
      const net = new T.LineSegments(new T.BufferGeometry().setFromPoints(netPoints), new T.LineBasicMaterial({ color: '#efe9d8', transparent: true, opacity: 0.65 }));
      group.add(net);
    }

    makePlayer(p) {
      const T = this.T, g = new T.Group();
      const color = p.team === 'attack' ? '#2b7f69' : '#d47560';
      const body = new T.Group(); g.add(body);
      const skin = ['#d6a17b', '#b77d55', '#8a5b40'][Number(p.number) % 3 || 0];
      this.mesh(new T.CylinderGeometry(0.2, 0.25, 0.62, 12), color, 0, 1.12, 0, body);
      this.mesh(new T.SphereGeometry(0.16, 16, 12), skin, 0, 1.65, 0, body);
      this.mesh(new T.CylinderGeometry(0.23, 0.24, 0.24, 12), '#263f36', 0, 0.72, 0, body);
      const limbs = [];
      for (const side of [-1, 1]) {
        const leg = new T.Group(); leg.position.set(side * 0.12, 0.7, 0); body.add(leg);
        this.mesh(new T.CylinderGeometry(0.075, 0.06, 0.56, 8), skin, 0, -0.28, 0, leg);
        this.mesh(new T.BoxGeometry(0.16, 0.1, 0.3), '#f1eee1', 0, -0.59, 0.07, leg);
        const arm = new T.Group(); arm.position.set(side * 0.27, 1.35, 0); body.add(arm);
        this.mesh(new T.CylinderGeometry(0.065, 0.05, 0.5, 8), skin, 0, -0.24, 0, arm);
        arm.rotation.z = side * 0.12;
        limbs.push({ leg, arm, side });
      }
      const shadow = new T.Mesh(new T.CircleGeometry(0.4, 28), new T.MeshBasicMaterial({ color: p.team === 'attack' ? '#2b7058' : '#ac604d', transparent: true, opacity: 0.25, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.018; g.add(shadow);
      const c = document.createElement('canvas'); c.width = 128; c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(64, 64, 50, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = '#f2f2d9'; ctx.lineWidth = 4; ctx.stroke();
      ctx.fillStyle = '#fff8e6'; ctx.font = 'bold 56px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.number, 64, 66);
      const texture = new T.CanvasTexture(c); texture.colorSpace = T.SRGBColorSpace;
      const label = new T.Sprite(new T.SpriteMaterial({ map: texture, depthTest: true }));
      label.position.y = 2.2; label.scale.set(0.9, 0.9, 1); g.add(label);
      this.playerGroup.add(g);
      this.players.set(p.id, { group: g, body, limbs });
    }

    line(points, color = '#b3d794', dashed = false, width = 0.022) {
      const T = this.T;
      if (points.length < 2) return;
      if (dashed) {
        const line = new T.Line(new T.BufferGeometry().setFromPoints(points), new T.LineDashedMaterial({ color, dashSize: 0.2, gapSize: 0.13 }));
        line.computeLineDistances(); this.routeGroup.add(line); return;
      }
      const curve = new T.CatmullRomCurve3(points);
      const tube = new T.Mesh(new T.TubeGeometry(curve, Math.max(2, points.length * 2), width, 5, false), new T.MeshBasicMaterial({ color }));
      this.routeGroup.add(tube);
    }

    makeRoutes(s) {
      const T = this.T;
      this.clear(this.routeGroup);
      for (const a of s.actions) {
        const p = s.players.find(p => p.id === a.playerId);
        if (!p || (!this.state.tactic.showDefense && p.team === 'defense')) continue;
        const points = [];
        for (let i = 0; i <= 24; i++) {
          const t = i / 24, q = { x: p.x + (a.to.x - p.x) * t, y: p.y + (a.to.y - p.y) * t };
          let y = 0.045;
          if (a.type === 'pass') y = 1.2 + Math.sin(Math.PI * t) * 0.25;
          if (a.type === 'shoot') y = 1.35 + (3.05 - 1.35) * t + Math.sin(Math.PI * t) * 2.6;
          if (a.type === 'dribble') q.x += Math.sin(t * Math.PI * 18) * 4;
          points.push(this.world(q, y));
        }
        this.line(points, p.team === 'attack' ? '#aad28a' : '#dc927b', a.type === 'pass' || a.type === 'shoot');
        const end = points.at(-1), direction = end.clone().sub(points.at(-2)).normalize();
        if (a.type === 'screen') {
          const side = new T.Vector3(-direction.z, 0, direction.x).multiplyScalar(0.4);
          this.line([end.clone().sub(side), end.clone().add(side)], '#b5d995', false, 0.045);
        } else {
          const cone = new T.Mesh(new T.ConeGeometry(0.12, 0.33, 10), new T.MeshBasicMaterial({ color: '#b5d995' }));
          cone.position.copy(end);
          cone.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), direction);
          this.routeGroup.add(cone);
        }
      }
      for (const st of s.strokes) this.line(st.points.map(p => this.world(p, 0.05)), '#adc889', false, 0.026);
      this.routeGroup.visible = this.showRoutes;
    }

    update(state) {
      this.state = state;
      const mode = state.tactic.court;
      if (this.mode !== mode) {
        this.mode = mode;
        this.makeCourt(mode);
        this.preset('angle', false);
        this.key = null;
      }
      const key = JSON.stringify([state.step.id, state.step.players, state.step.actions, state.step.strokes, state.tactic.showDefense]);
      if (key !== this.key) {
        this.key = key;
        this.clear(this.playerGroup);
        this.players.clear();
        for (const p of state.step.players) if (state.tactic.showDefense || p.team === 'attack') this.makePlayer(p);
        this.makeRoutes(state.step);
      }
      const t = clamp(state.progress || 0, 0, 1);
      for (const p of state.frame.players) {
        const model = this.players.get(p.id);
        if (!model) continue;
        model.group.position.copy(this.world(p));
        const action = state.step.actions.find(a => a.playerId === p.id && ['run', 'screen', 'dribble'].includes(a.type));
        const source = state.step.players.find(v => v.id === p.id);
        const moving = action && t > 0 && t < 1;
        if (action && source) model.body.rotation.y = Math.atan2(action.to.x - source.x, action.to.y - source.y);
        const swing = moving ? Math.sin(t * Math.PI * 12) * 0.4 : 0;
        model.limbs.forEach(({ leg, arm, side }) => { leg.rotation.x = swing * side; arm.rotation.x = -swing * side; });
        model.body.position.y = moving ? Math.abs(Math.sin(t * Math.PI * 12)) * 0.035 : 0;
      }
      this.positionBall(t);
      this.render();
    }

    positionBall(t) {
      const point = window.CourtEngine.sample3D(this.state.step, t).ball;
      this.ball.visible = !!point;
      if (point) this.ball.position.copy(this.world(point, point.height));
      this.ball.rotation.set(t * Math.PI * 10, 0, t * Math.PI * 4);
    }

    preset(name, render = true) {
      const full = this.mode === 'full';
      const table = {
        angle: [0.35, 0.72, full ? 39 : 25],
        top: [0, 0.08, full ? 43 : 26],
        baseline: [Math.PI, 1.03, full ? 38 : 25],
        side: [Math.PI / 2, 0.83, full ? 40 : 27]
      };
      [this.yaw, this.polar, this.radius] = table[name] || table.angle;
      if (render) this.render();
    }

    bindCamera() {
      const c = this.renderer.domElement;
      c.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        c.focus(); c.setPointerCapture(e.pointerId);
        this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: this.yaw, polar: this.polar };
      });
      c.addEventListener('pointermove', e => {
        if (!this.pointer || this.pointer.id !== e.pointerId) return;
        this.yaw = this.pointer.yaw - (e.clientX - this.pointer.x) * 0.008;
        this.polar = clamp(this.pointer.polar + (e.clientY - this.pointer.y) * 0.006, 0.06, 1.36);
        this.render();
      });
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) c.addEventListener(event, () => this.pointer = null);
      c.addEventListener('wheel', e => {
        e.preventDefault();
        this.radius = clamp(this.radius * Math.exp(e.deltaY * 0.001), 11, 60);
        this.render();
      }, { passive: false });
      c.addEventListener('keydown', e => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '=', '0'].includes(e.key)) {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'ArrowLeft') this.yaw -= 0.15;
          if (e.key === 'ArrowRight') this.yaw += 0.15;
          if (e.key === 'ArrowUp') this.polar = clamp(this.polar - 0.1, 0.06, 1.36);
          if (e.key === 'ArrowDown') this.polar = clamp(this.polar + 0.1, 0.06, 1.36);
          if (['+', '='].includes(e.key)) this.radius = Math.max(11, this.radius - 2);
          if (e.key === '-') this.radius = Math.min(60, this.radius + 2);
          if (e.key === '0') this.preset('angle', false);
          this.render();
        }
      });
      c.addEventListener('webglcontextlost', e => {
        e.preventDefault();
        this.host.dispatchEvent(new CustomEvent('previewerror', { detail: '3D 渲染暂时中断，请切回 2D 后重新打开 3D 预览。' }));
      });
      c.addEventListener('webglcontextrestored', () => this.render());
    }

    resize() {
      const { width, height } = this.host.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.render();
    }

    render() {
      const sin = Math.sin(this.polar);
      this.camera.position.set(this.target.x + this.radius * sin * Math.sin(this.yaw), this.target.y + this.radius * Math.cos(this.polar), this.target.z + this.radius * sin * Math.cos(this.yaw));
      this.camera.lookAt(this.target);
      this.renderer.render(this.scene, this.camera);
    }

    setRoutes(value) { this.showRoutes = value; this.routeGroup.visible = value; this.render(); }
    capture() { this.render(); return new Promise(resolve => this.renderer.domElement.toBlob(resolve, 'image/png')); }
  }
})();
