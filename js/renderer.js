/* 黑洞模擬 —— 渲染器：只負責把一份「畫面描述」交給著色器畫出來，不懂物理。
 *
 * frame = {
 *   width, height, tanFov, camPos[3], P[4][4]（攝影機標架降指標後的共變向量）, camInside,
 *   holes: [{pos, rs, spin}], far, maxSteps, stepScale,
 *   disk: {rin, rout, on, brightness, thick}, diskTime, flags[4], exposure, beaconPeriod, debug,
 *   bodies: [{A[4], B[4], C[4], D[4]}]
 * }
 * 物體的軌跡放在一張浮點貼圖裡（每個物體兩列），由 setTrajRow 更新。
 */
(function (root) {
  'use strict';
  var BH = root.BH = root.BH || {};

  var TRAJ_N = 1024;      // 每條軌跡取樣幾點
  var MAX_ROWS = 16;      // 最多幾條軌跡
  var BODY_VARIANTS = [0, 4, 16];
  var DISK_T = 80;

  function Renderer(canvas) {
    this.canvas = canvas;
    var gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('這個瀏覽器開不了 WebGL2');
    this.gl = gl;
    this.programs = {};
    this.vao = gl.createVertexArray();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TRAJ_N, MAX_ROWS * 2, 0, gl.RGBA, gl.FLOAT, new Float32Array(TRAJ_N * MAX_ROWS * 2 * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 飛船的格子（3D 整數貼圖，每格一個色號）。還沒載入模型時放一格空的，著色器照樣綁得上
    this.shipTex = gl.createTexture();
    this.shipDim = [1, 1, 1];
    this.shipEmit = new Uint32Array(8);
    this.shipEng = new Float32Array(8 * 4); this.shipEngN = 0;
    this.shipPlume = [9.5, 2.4, 0.2]; this.shipBound = 1.2;
    this.uploadShip([1, 1, 1], new Uint8Array(1));
    this.lastCompileMs = 0;
  }
  Renderer.TRAJ_N = TRAJ_N;
  Renderer.MAX_ROWS = MAX_ROWS;
  Renderer.MAX_BODIES = BODY_VARIANTS[BODY_VARIANTS.length - 1];
  Renderer.DISK_T = DISK_T;

  Renderer.prototype.compile = function (type, src) {
    var gl = this.gl, sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('著色器編譯失敗：\n' + log);
    }
    return sh;
  };

  // 依「洞的數量上限、物體數量上限」取一支程式（沒有就現編）
  Renderer.prototype.program = function (maxHoles, maxBodies) {
    var key = maxHoles + '/' + maxBodies;
    if (this.programs[key]) return this.programs[key];
    var gl = this.gl, t0 = performance.now();
    var vs = this.compile(gl.VERTEX_SHADER, BH.Shader.vert);
    var fs = this.compile(gl.FRAGMENT_SHADER, BH.Shader.frag({ maxHoles: maxHoles, maxBodies: maxBodies, trajN: TRAJ_N }));
    var pr = gl.createProgram();
    gl.attachShader(pr, vs); gl.attachShader(pr, fs);
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('著色器連結失敗：\n' + gl.getProgramInfoLog(pr));
    var loc = {}, n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(pr, i);
      var name = info.name.replace(/\[0\]$/, '');
      loc[name] = gl.getUniformLocation(pr, info.name);
    }
    this.lastCompileMs = performance.now() - t0;
    return (this.programs[key] = { pr: pr, loc: loc, maxHoles: maxHoles, maxBodies: maxBodies });
  };

  Renderer.prototype.setTrajRow = function (row, pos, vel) {
    var gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row * 2, TRAJ_N, 1, gl.RGBA, gl.FLOAT, pos);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row * 2 + 1, TRAJ_N, 1, gl.RGBA, gl.FLOAT, vel);
  };

  Renderer.prototype.uploadShip = function (dims, grid) {
    var gl = this.gl;
    gl.bindTexture(gl.TEXTURE_3D, this.shipTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, dims[0], dims[1], dims[2], 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, grid);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.shipDim = dims.slice();
  };
  // m ＝ BH.Ship.decode(...) 的結果
  Renderer.prototype.setShip = function (m) {
    this.uploadShip(m.dims, m.grid); this.shipEmit = m.emit;
    this.shipEng = new Float32Array(8 * 4); this.shipEngN = Math.min(8, m.engines.length);
    for (var i = 0; i < this.shipEngN; i++) this.shipEng.set([m.engines[i].x, m.engines[i].y, m.engines[i].z, m.engines[i].r], i * 4);
    this.shipPlume = [m.plume.len, m.plume.rad, m.plume.gain];
    this.shipBound = m.bound * 1.02;
  };

  Renderer.prototype.resize = function (w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  };

  Renderer.prototype.draw = function (f) {
    var gl = this.gl, i;
    var nb = f.bodies ? Math.min(f.bodies.length, Renderer.MAX_BODIES) : 0;
    var variant = BODY_VARIANTS[BODY_VARIANTS.length - 1];
    for (i = 0; i < BODY_VARIANTS.length; i++) if (BODY_VARIANTS[i] >= nb) { variant = BODY_VARIANTS[i]; break; }
    var maxHoles = Math.max(1, f.holes.length);
    var pg = this.program(maxHoles, variant), L = pg.loc;
    gl.viewport(0, 0, f.width, f.height);
    gl.useProgram(pg.pr);
    gl.bindVertexArray(this.vao);
    function u1(n, v) { if (L[n]) gl.uniform1f(L[n], v); }
    function ui(n, v) { if (L[n]) gl.uniform1i(L[n], v); }
    function u4(n, v) { if (L[n]) gl.uniform4f(L[n], v[0], v[1], v[2], v[3]); }
    if (L.uRes) gl.uniform2f(L.uRes, f.width, f.height);
    u1('uTanFov', f.tanFov);
    if (L.uCamPos) gl.uniform3f(L.uCamPos, f.camPos[0], f.camPos[1], f.camPos[2]);
    u4('uP0', f.P[0]); u4('uP1', f.P[1]); u4('uP2', f.P[2]); u4('uP3', f.P[3]);
    var hv = new Float32Array(maxHoles * 4), sv = new Float32Array(maxHoles * 4);
    for (i = 0; i < f.holes.length; i++) {
      hv[i * 4] = f.holes[i].pos[0]; hv[i * 4 + 1] = f.holes[i].pos[1]; hv[i * 4 + 2] = f.holes[i].pos[2]; hv[i * 4 + 3] = f.holes[i].rs;
      sv[i * 4] = f.holes[i].spin[0]; sv[i * 4 + 1] = f.holes[i].spin[1]; sv[i * 4 + 2] = f.holes[i].spin[2];
    }
    ui('uHoleCount', f.holes.length);
    if (L.uHole) gl.uniform4fv(L.uHole, hv);
    if (L.uHoleSpin) gl.uniform4fv(L.uHoleSpin, sv);
    u1('uFar', f.far);
    ui('uMaxSteps', f.maxSteps);
    u1('uStepScale', f.stepScale);
    u1('uCamInside', f.camInside ? 1 : 0);
    u1('uEnergyTest', f.energyTest ? 1 : 0);
    u4('uDisk', [f.disk.rin, f.disk.rout, f.disk.on ? 1 : 0, f.disk.brightness]);
    u1('uDiskH', f.disk.on ? (f.disk.thick || 0) : 0);
    u1('uDiskTime', f.diskTime);
    u4('uFlags', f.flags);
    u1('uExposure', f.exposure);
    u1('uBeaconPeriod', f.beaconPeriod);
    u1('uGhost', f.ghost === false ? 0 : 1);
    ui('uDebug', f.debug ? 1 : 0);
    if (variant > 0) {
      var A = new Float32Array(variant * 4), B = new Float32Array(variant * 4), C = new Float32Array(variant * 4), D = new Float32Array(variant * 4);
      for (i = 0; i < nb; i++) { A.set(f.bodies[i].A, i * 4); B.set(f.bodies[i].B, i * 4); C.set(f.bodies[i].C, i * 4); D.set(f.bodies[i].D, i * 4); }
      ui('uBodyCount', nb);
      if (L.uBodyA) gl.uniform4fv(L.uBodyA, A);
      if (L.uBodyB) gl.uniform4fv(L.uBodyB, B);
      if (L.uBodyC) gl.uniform4fv(L.uBodyC, C);
      if (L.uBodyD) gl.uniform4fv(L.uBodyD, D);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      ui('uTraj', 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, this.shipTex);
      ui('uShip', 1);
      if (L.uShipDim) gl.uniform3f(L.uShipDim, this.shipDim[0], this.shipDim[1], this.shipDim[2]);
      var e = this.shipEmit;
      if (L.uShipEmit0) gl.uniform4ui(L.uShipEmit0, e[0], e[1], e[2], e[3]);
      if (L.uShipEmit1) gl.uniform4ui(L.uShipEmit1, e[4], e[5], e[6], e[7]);
      if (L.uShipEng) gl.uniform4fv(L.uShipEng, this.shipEng);
      ui('uShipEngN', this.shipEngN);
      u4('uShipPlume', [this.shipPlume[0], this.shipPlume[1], this.shipPlume[2], f.plume === false ? 0 : 1]);
      u1('uShipBound', this.shipBound);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // 畫一張正方形的圖並把像素讀回來（自我測試用）；回傳 Uint8Array（RGBA，由下往上）
  Renderer.prototype.renderToPixels = function (f, size) {
    var gl = this.gl, ow = this.canvas.width, oh = this.canvas.height;
    this.resize(size, size);
    f.width = size; f.height = size;
    this.draw(f);
    var px = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.resize(ow, oh);
    return px;
  };

  BH.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
