/* 黑洞模擬 —— 太空戰鬥模式的畫面與操作
 *
 * 核心（誰在哪、誰打中誰）在 js/game.js；這裡只做三件事：
 *   1. 把鍵盤滑鼠變成 world.step 的輸入
 *   2. 把 world 裡的船、光彈、爆炸放進 bodies（交給著色器畫 —— 跟模擬模式是同一支著色器、同一套光線追蹤）
 *   3. 畫疊在上面的準星、標記、讀數、雷達
 *
 * 玩家自己的船：攝影機就綁在船上，如果照「光行時間之前的樣子」畫，轉個頭要等光傳到攝影機才看得到（零點幾秒），很難開。
 * 所以交給著色器的是「照現在的速度等速直線、現在的朝向」的一小段路 —— 等於站在船自己的靜止系裡看，船是不動的。
 * 敵機、光彈、爆炸都照實用光行時間之前的樣子畫：你看到的敵機是它幾秒前的位置。
 */
(function () {
  'use strict';
  var BH = window.BH, P = BH.Physics, G = BH.Game, Renderer = BH.Renderer;
  var DEG = Math.PI / 180;
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  var RATE = 2.5;            // 每秒過幾個 rs/c（玩家自己的固有時）
  var TURN = 1.25;           // 鍵盤轉向（弧度／秒）
  var MOUSE = 0.0026;        // 滑鼠轉向（弧度／像素）
  var FOV = 72;
  var DISK_OUT = 6.5;        // 戰鬥模式的吸積盤小一點：船在盤外面飛，盤是地標（也是掩護），不是一片霧
  var SELF_WINDOW = 3;       // 玩家自己那艘船交給著色器多長的一段路（座標時間）
  var TEAM_COLOR = { player: [1, 1, 1], enemy: [1.0, 0.50, 0.42] };
  var BOLT_COLOR = { player: [0.45, 2.6, 1.3], enemy: [2.8, 0.55, 0.35] };

  /* app：{ canvas, renderer, bodies, map, S（顯示設定：scale、maxSteps、exposure、disk、mapOn）, toast(msg), exit() } */
  function GameUI(app) {
    this.app = app;
    this.active = false;
    this.keys = {};
    this.world = null;
    this.paused = false;
    this.view = 'chase';
    this.assist = true;
    this.hud = $('ghud'); this.ctx = this.hud.getContext('2d');
    this.flash = 0; this.panelT = 0; this.aimT = 0; this.planT = 0;
    this.aim = null; this.plan = null; this.target = null;
    this.drag = null; this.mouseFire = false; this.locked = false;
    this.ms = 0;
    var self = this;
    $('goAgain').addEventListener('click', function () { self.start(); });
    $('goResume').addEventListener('click', function () { self.setPaused(false); });
    $('goMenu').addEventListener('click', function () { self.app.exit(); });
    document.addEventListener('pointerlockchange', function () { self.locked = document.pointerLockElement === self.app.canvas; if (!self.locked) self.mouseFire = false; });
  }

  // ── 開始、結束 ──────────────────────────────────────
  GameUI.prototype.start = function () {
    var app = this.app, cfg;
    this.holes = [P.makeHole({ rs: 1 })];
    this.world = new G.World(this.holes, { seed: (Date.now() & 0x3fffffff) || 1 });
    cfg = this.world.cfg;
    app.bodies.clear();
    this.shipBody = {};      // 船 id → 畫面上的物體
    this.boltBody = {};      // 光彈 id → 畫面上的物體
    this.fireballs = [];
    this.selfBody = app.bodies.addLive(this.selfTrail(), { radius: 0.5 * cfg.shipLen, color: TEAM_COLOR.player, tag: 'self' });
    this.active = true; this.paused = false; this.keys = {}; this.flash = 0; this.aim = null; this.plan = null; this.target = null;
    this.mouseFire = false; this.ended = false;
    $('gover').className = '';
    app.toast('太空戰鬥開始 —— 第一波敵機馬上到');
  };
  GameUI.prototype.stop = function () {
    this.active = false; this.world = null; this.keys = {};
    if (document.exitPointerLock && this.locked) document.exitPointerLock();
    this.app.bodies.clear();
    $('gover').className = '';
    this.ctx.clearRect(0, 0, this.hud.width, this.hud.height);
  };
  GameUI.prototype.setPaused = function (on) {
    if (!this.active || this.ended) return;
    this.paused = on;
    if (on) {
      if (document.exitPointerLock && this.locked) document.exitPointerLock();
      this.overlay('暫停', '按「繼續」或 P 回到戰場。', true);
    } else $('gover').className = '';
  };
  GameUI.prototype.overlay = function (title, html, canResume) {
    $('goTitle').textContent = title; $('goText').innerHTML = html;
    $('goResume').style.display = canResume ? '' : 'none';
    $('goAgain').textContent = canResume ? '重新開始' : '再來一場';
    $('gover').className = 'show';
  };

  // ── 輸入 ────────────────────────────────────────────
  GameUI.prototype.keyDown = function (e) {
    if (!this.active) return false;
    var k = e.code;
    if (k === 'KeyP' || k === 'Escape') { if (!this.ended) this.setPaused(!this.paused); return true; }
    if (k === 'KeyV') { this.view = this.view === 'chase' ? 'cockpit' : 'chase'; this.app.toast(this.view === 'chase' ? '視角：船後' : '視角：駕駛艙'); return true; }
    if (k === 'KeyC') { this.assist = !this.assist; this.app.toast(this.assist ? '軌道輔助：開（放開推進鍵會自動修成圓軌道）' : '軌道輔助：關（放開就是自由落下）'); return true; }
    this.keys[k] = true;
    return /^(Key[WASDQERFJ]|Arrow|Space|Shift)/.test(k);
  };
  GameUI.prototype.keyUp = function (e) { this.keys[e.code] = false; };
  GameUI.prototype.pointerDown = function (e) {
    if (!this.active || this.paused || this.ended) return;
    var cv = this.app.canvas;
    if (this.locked) { if (e.button === 0) this.mouseFire = true; return; }
    this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 沒關係 */ }
  };
  GameUI.prototype.pointerMove = function (e) {
    if (!this.active || this.paused || this.ended || !this.world) return;
    if (this.locked) { this.world.rotatePlayer(e.movementX * MOUSE, -e.movementY * MOUSE, 0); return; }
    if (!this.drag) return;
    var dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX; this.drag.y = e.clientY; this.drag.moved += Math.abs(dx) + Math.abs(dy);
    this.world.rotatePlayer(dx * MOUSE, -dy * MOUSE, 0);
  };
  GameUI.prototype.pointerUp = function (e) {
    if (this.locked) { if (e.button === 0) this.mouseFire = false; return; }
    // 沒拖動的一下點擊 ＝ 把滑鼠鎖進畫面（之後移動滑鼠就是轉向、左鍵開火；Esc 放開）
    if (this.drag && this.drag.moved < 4 && this.active && !this.paused && !this.ended && this.app.canvas.requestPointerLock) {
      try { var pr = this.app.canvas.requestPointerLock(); if (pr && pr.catch) pr.catch(function () { /* 鎖不了就用拖曳 */ }); } catch (err) { /* 鎖不了就用拖曳 */ }
    }
    this.drag = null;
  };
  GameUI.prototype.input = function (dt) {
    var k = this.keys, w = this.world;
    var yaw = ((k.ArrowRight ? 1 : 0) - (k.ArrowLeft ? 1 : 0)) * TURN * dt;
    var pitch = ((k.ArrowUp ? 1 : 0) - (k.ArrowDown ? 1 : 0)) * TURN * dt;
    var roll = ((k.KeyE ? 1 : 0) - (k.KeyQ ? 1 : 0)) * TURN * dt;
    if (yaw || pitch || roll) w.rotatePlayer(yaw, pitch, roll);
    return {
      f: (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0), r: (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0), u: (k.KeyR ? 1 : 0) - (k.KeyF ? 1 : 0),
      boost: !!(k.ShiftLeft || k.ShiftRight), assist: this.assist, fire: !!(k.Space || k.KeyJ || this.mouseFire)
    };
  };

  // ── 把 world 放進畫面 ───────────────────────────────
  // 玩家自己那艘：照現在的速度等速直線、現在的朝向（見檔頭）
  GameUI.prototype.selfTrail = function () {
    var w = this.world, sh = w.player, s = sh.s, u = G.velocity4(this.holes, s), h = G.histNew(), W = SELF_WINDOW, v = [u[0] / u[3], u[1] / u[3], u[2] / u[3]];
    var a = [s[3] - W, s[0] - v[0] * W, s[1] - v[1] * W, s[2] - v[2] * W, u[0], u[1], u[2], u[3], s[4], s[5], s[6], s[7], sh.tau - W / u[3], sh.fwd[0], sh.fwd[1], sh.fwd[2], sh.thr, sh.up[0], sh.up[1], sh.up[2], sh.flash];
    var b = a.slice(); b[0] = s[3]; b[1] = s[0]; b[2] = s[1]; b[3] = s[2]; b[12] = sh.tau;
    var HK = ['T', 'X', 'Y', 'Z', 'UX', 'UY', 'UZ', 'UT', 'PX', 'PY', 'PZ', 'PT', 'TAU', 'FX', 'FY', 'FZ', 'TH', 'GX', 'GY', 'GZ', 'FL'];
    for (var i = 0; i < HK.length; i++) h[HK[i]] = [a[i], b[i]];
    h.n = 2;
    return h;
  };
  GameUI.prototype.sync = function (events) {
    var app = this.app, bodies = app.bodies, w = this.world, cfg = w.cfg, i, e, b;
    for (i = 0; i < events.length; i++) {
      e = events[i];
      if (e.type === 'spawn') this.shipBody[e.ship.id] = bodies.addLive(e.ship.hist, { radius: 0.5 * cfg.shipLen, color: TEAM_COLOR.enemy, tag: e.ship });
      else if (e.type === 'bolt') this.boltBody[e.bolt.id] = bodies.addTraced(e.bolt.tr, { kind: 'light', color: BOLT_COLOR[e.bolt.team], radius: 0.05, linger: 60, tag: e.bolt });
      else if (e.type === 'hit') {
        b = this.boltBody[e.bolt.id];
        if (b && bodies.list.indexOf(b) >= 0) bodies.truncate(b, e.t);
        if (e.ship === w.player) this.flash = 1;
      } else if (e.type === 'kill') {
        b = this.shipBody[e.ship.id];
        if (b) { b.tr = e.ship.hist; bodies.upload(b); b.live = false; b.fixed = true; b.linger = 90; }      // 它最後的光還在路上，留到光過去為止
        if (e.why === 'shot') {
          var n = e.ship.hist.n - 1, hs = e.ship.hist;
          var tr = G.coast(this.holes, { x: hs.X[n], y: hs.Y[n], z: hs.Z[n], t: hs.T[n], px: hs.PX[n], py: hs.PY[n], pz: hs.PZ[n], pt: hs.PT[n], tau: 0 }, 5);
          var fb = bodies.addTraced(tr, { kind: 'ball', color: [3, 1.7, 0.6], radius: 0.1, linger: 90, tag: 'fireball' });
          if (fb) this.fireballs.push({ body: fb, t0: tr.T[0], told: false, wave: w.wave });
        } else if (e.why === 'eaten') app.toast('一艘敵機掉進黑洞了');
      } else if (e.type === 'wave') app.toast('第 ' + e.wave + ' 波：' + cfg.waves[e.wave - 1] + ' 艘敵機（總共 ' + cfg.waves.length + ' 波）');
      else if (e.type === 'waveClear') app.toast('第 ' + e.wave + ' 波清空，船體修復 ' + cfg.waveHeal);
      else if (e.type === 'cross') app.toast('通過視界了 —— 身邊沒有任何記號，但已經回不去了');
    }
    // 每一格：自己那艘整段換掉；敵機的歷史 world 已經接長了，重新上傳
    this.selfBody.tr = this.selfTrail();
    bodies.upload(this.selfBody);
    for (i = 0; i < w.ships.length; i++) {
      var sh = w.ships[i];
      if (sh.team !== 'enemy' || !sh.alive) continue;
      b = this.shipBody[sh.id];
      if (b && bodies.list.indexOf(b) >= 0) bodies.upload(b);
    }
  };
  // 火球：照「你看到它的那一刻」離爆炸多久來長大、變暗（所以遠的爆炸晚一點才看到）；光彈的光走完了就收掉
  GameUI.prototype.afterUpdate = function () {
    var bodies = this.app.bodies, i, b;
    for (i = this.fireballs.length - 1; i >= 0; i--) {
      var f = this.fireballs[i];
      b = f.body;
      if (bodies.list.indexOf(b) < 0) { this.fireballs.splice(i, 1); continue; }
      var age = b.seenT == null ? 0 : b.seenT - f.t0, fade = Math.exp(-0.75 * age);
      b.radius = 0.1 + 0.55 * (1 - Math.exp(-1.3 * age));
      b.color = [3 * fade, 1.7 * fade * fade, 0.6 * fade * fade * fade];
      if (b.seenT != null && !f.told) { f.told = true; this.app.toast('擊落確認 —— 爆炸的光現在才傳到你這裡'); }
      if (age > 4.2) { bodies.removeBody(b); this.fireballs.splice(i, 1); }
    }
    for (i = bodies.list.length - 1; i >= 0; i--) {
      b = bodies.list[i];
      if (b.kind === 'light' && b.fixed && b.seenT != null && b.seenT >= b.t1 - 1e-3) bodies.remove(i);
    }
  };

  // ── 一格 ────────────────────────────────────────────
  GameUI.prototype.frame = function (dtWall, now, w, h) {
    var app = this.app, S = app.S, world = this.world, holes = this.holes, cfg = world.cfg, t0 = performance.now();
    if (!this.paused && world.state === 'play') {
      var inp = this.input(dtWall);
      world.step(dtWall * RATE, inp);
      this.sync(world.takeEvents());
    }
    this.flash = Math.max(0, this.flash - dtWall * 2.2);
    var pl = world.player, L = cfg.shipLen, pos = [pl.s[0], pl.s[1], pl.s[2]], camPos;
    if (this.view === 'chase') camPos = [pos[0] - pl.fwd[0] * 1.75 * L + pl.up[0] * 0.44 * L, pos[1] - pl.fwd[1] * 1.75 * L + pl.up[1] * 0.44 * L, pos[2] - pl.fwd[2] * 1.75 * L + pl.up[2] * 0.44 * L];
    else camPos = [pos[0] + pl.fwd[0] * 0.62 * L + pl.up[0] * 0.05 * L, pos[1] + pl.fwd[1] * 0.62 * L + pl.up[1] * 0.05 * L, pos[2] + pl.fwd[2] * 0.62 * L + pl.up[2] * 0.05 * L];
    var cf = G.cameraFrame(holes, camPos, [pl.s[4], pl.s[5], pl.s[6]], pl.fwd, pl.up);
    this.cf = cf;
    app.bodies.update(holes, world.t, cf.pos, cf.insideHorizon);
    this.afterUpdate();
    var dt = world.t % Renderer.DISK_T; if (dt < 0) dt += Renderer.DISK_T;
    app.renderer.resize(w, h);
    app.renderer.draw({
      width: w, height: h, tanFov: Math.tan(FOV * DEG / 2), camPos: cf.pos, P: cf.P, camInside: cf.nearHorizon, energyTest: true,
      holes: holes, far: Math.max(60, cf.r * 1.08 + 6), maxSteps: S.maxSteps, stepScale: 1,
      disk: { on: true, rin: 3, rout: DISK_OUT, brightness: S.disk.brightness, thick: S.disk.thick },
      diskTime: dt, flags: [1, 0, 1, 1], exposure: S.exposure, beaconPeriod: 2.0, ghost: true, plume: true, debug: false,
      bodies: app.bodies.uniforms(world.t, cf.nearHorizon || cf.ratio < 3)
    });
    this.solve(now);
    this.drawHud();
    if (S.mapOn && (this.frameNo = (this.frameNo || 0) + 1) & 1) this.drawMap();
    if (now - this.panelT > 110) { this.panelT = now; this.drawPanel(); }
    if (world.state !== 'play' && !this.ended) this.finish();
    this.ms = this.ms * 0.9 + (performance.now() - t0) * 0.1;
  };

  /* 射擊解（每秒算七次左右）：目標 ＝ 你看到的最近那一艘。
   * 從「你看到它的那一刻」的位置與動量，當成它之後不開引擎往後推；再解光子該朝哪飛（光會彎、它在動、你也在動）。
   * 它在那之後如果改了軌道，這個解就是錯的 —— 那個資訊還沒傳到你這裡，誰都算不出來。 */
  GameUI.prototype.solve = function (now) {
    var world = this.world, holes = this.holes, pl = world.player, i, best = null, bd = Infinity;
    if (now - this.planT > 500 && pl.alive) {
      this.planT = now;
      this.plan = G.coast(holes, { x: pl.s[0], y: pl.s[1], z: pl.s[2], t: pl.s[3], px: pl.s[4], py: pl.s[5], pz: pl.s[6], pt: pl.s[7] }, 160);
    }
    if (now - this.aimT < 140) return;
    this.aimT = now;
    for (i = 0; i < world.ships.length; i++) {
      var sh = world.ships[i], b = this.shipBody[sh.id];
      if (sh.team !== 'enemy' || !b || !b.seen || this.app.bodies.list.indexOf(b) < 0) continue;
      if (b.seenT >= b.t1 - 1e-6 && !sh.alive) continue;                 // 已經看到它爆了
      var d = Math.hypot(b.seen.x - pl.s[0], b.seen.y - pl.s[1], b.seen.z - pl.s[2]);
      if (d < bd) { bd = d; best = { ship: sh, body: b, dist: d }; }
    }
    this.target = best;
    this.aim = null;
    if (!best || !pl.alive) return;
    var pred = G.coast(holes, best.body.seen, (world.t - best.body.seen.t) + world.cfg.boltRange + 2);
    var sol = G.solveAim(holes, pl.s, pred, {});
    if (!sol) return;
    var nf = G.noseFor(holes, pl.s, sol.n);
    if (!nf) return;
    this.aim = { sol: sol, e: nf.e, ok: sol.ok, tof: sol.tHit - pl.s[3] };
  };

  // ── 疊在畫面上的東西 ────────────────────────────────
  GameUI.prototype.drawHud = function () {
    var cv = this.hud, ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    var W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    ctx.clearRect(0, 0, W, H);
    if (!this.world || !this.cf) return;
    var world = this.world, holes = this.holes, cf = this.cf, tanF = Math.tan(FOV * DEG / 2), cx = W / 2, cy = H / 2, hole = holes[0].pos, i;
    function scr(v) { return v[2] > 1e-6 ? [cx + v[0] / v[2] / tanF * cy, cy - v[1] / v[2] / tanF * cy] : null; }
    ctx.lineWidth = 1.5 * dpr; ctx.font = (11 * dpr) + 'px sans-serif'; ctx.textAlign = 'center';
    if (this.flash > 0) { ctx.fillStyle = 'rgba(255,60,40,' + (0.33 * this.flash).toFixed(3) + ')'; ctx.fillRect(0, 0, W, H); }

    // 敵機標記：畫在「它的光直線飛過來」會出現的地方（有算光行差；沒算光被彎，所以貼著黑洞時標成虛線）
    for (i = 0; i < world.ships.length; i++) {
      var sh = world.ships[i], b = this.shipBody[sh.id];
      if (sh.team !== 'enemy' || !b || !b.seen || this.app.bodies.list.indexOf(b) < 0) continue;
      if (!sh.alive && b.seenT >= b.t1 - 1e-6) continue;
      var src = [b.seen.x, b.seen.y, b.seen.z], pj = G.project(holes, cf, src);
      if (!pj) continue;
      var bent = G.segNear(cf.pos, src, hole) < 3.2 * holes[0].rs, p = scr(pj), dist = Math.hypot(src[0] - cf.pos[0], src[1] - cf.pos[1], src[2] - cf.pos[2]);
      var isT = this.target && this.target.ship === sh, col = isT ? 'rgba(255,120,90,0.95)' : 'rgba(255,120,90,0.6)';
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.setLineDash(bent ? [4 * dpr, 4 * dpr] : []);
      if (p && p[0] > 12 && p[0] < W - 12 && p[1] > 12 && p[1] < H - 12) {
        var r = clamp(world.cfg.shipLen * 0.9 / dist / tanF * cy, 9 * dpr, 60 * dpr), g = r * 0.45;
        ctx.beginPath();
        ctx.moveTo(p[0] - r, p[1] - r + g); ctx.lineTo(p[0] - r, p[1] - r); ctx.lineTo(p[0] - r + g, p[1] - r);
        ctx.moveTo(p[0] + r - g, p[1] - r); ctx.lineTo(p[0] + r, p[1] - r); ctx.lineTo(p[0] + r, p[1] - r + g);
        ctx.moveTo(p[0] + r, p[1] + r - g); ctx.lineTo(p[0] + r, p[1] + r); ctx.lineTo(p[0] + r - g, p[1] + r);
        ctx.moveTo(p[0] - r + g, p[1] + r); ctx.lineTo(p[0] - r, p[1] + r); ctx.lineTo(p[0] - r, p[1] + r - g);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText(dist.toFixed(1) + ' rs' + (bent ? '（光被彎）' : ''), p[0], p[1] + r + 13 * dpr);
        var hw = Math.max(r, 14 * dpr);
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(p[0] - hw, p[1] - r - 8 * dpr, 2 * hw, 3 * dpr);
        ctx.fillStyle = col; ctx.fillRect(p[0] - hw, p[1] - r - 8 * dpr, 2 * hw * clamp(sh.hp / sh.hpMax, 0, 1), 3 * dpr);
      } else {
        // 不在畫面裡：在邊上畫一個箭頭
        ctx.setLineDash([]);
        var ax = pj[0], ay = -pj[1], al = Math.hypot(ax, ay) || 1, m = 26 * dpr;
        ax /= al; ay /= al;
        var k = Math.min((cx - m) / Math.max(Math.abs(ax), 1e-6), (cy - m) / Math.max(Math.abs(ay), 1e-6));
        var ex = cx + ax * k, ey = cy + ay * k, s2 = 8 * dpr;
        ctx.beginPath(); ctx.moveTo(ex + ax * s2, ey + ay * s2); ctx.lineTo(ex - ax * s2 - ay * s2 * 0.7, ey - ay * s2 + ax * s2 * 0.7); ctx.lineTo(ex - ax * s2 + ay * s2 * 0.7, ey - ay * s2 - ax * s2 * 0.7); ctx.closePath(); ctx.fill();
        ctx.fillText(dist.toFixed(0), ex - ax * 20 * dpr, ey - ay * 20 * dpr + 4 * dpr);
      }
    }
    ctx.setLineDash([]);

    // 射擊解：把準星移到這個菱形上再開火
    var locked = false;
    if (this.aim && this.aim.ok) {
      var q = scr(G.projectDir(cf, this.aim.e));
      if (q) {
        locked = Math.hypot(q[0] - cx, q[1] - cy) < 9 * dpr;
        var d2 = 9 * dpr;
        ctx.strokeStyle = locked ? 'rgba(120,255,160,1)' : 'rgba(255,225,120,0.95)';
        ctx.beginPath(); ctx.moveTo(q[0], q[1] - d2); ctx.lineTo(q[0] + d2, q[1]); ctx.lineTo(q[0], q[1] + d2); ctx.lineTo(q[0] - d2, q[1]); ctx.closePath(); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText('光要飛 ' + this.aim.tof.toFixed(1), q[0], q[1] - d2 - 5 * dpr);
      }
    }
    // 準星
    var cs = 10 * dpr, gap = 4 * dpr;
    ctx.strokeStyle = locked ? 'rgba(120,255,160,1)' : 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(cx - cs, cy); ctx.lineTo(cx - gap, cy); ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + cs, cy);
    ctx.moveTo(cx, cy - cs); ctx.lineTo(cx, cy - gap); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + cs);
    ctx.stroke();
    this.lockedNow = locked;
  };

  GameUI.prototype.drawPanel = function () {
    var world = this.world, cfg = world.cfg, pl = world.player, holes = this.holes, st = G.steer(holes, pl.s, {}), r = G.radius(holes, pl.s), h = '';
    function bar(label, frac, col, txt) {
      return '<div class="gbar"><span class="k">' + label + '</span><span class="track"><i style="width:' + (clamp(frac, 0, 1) * 100).toFixed(1) + '%;background:' + col + '"></i></span><span class="v">' + txt + '</span></div>';
    }
    h += bar('船體', pl.hp / pl.hpMax, pl.hp > 35 ? '#7fe0a0' : '#ff7a5c', Math.max(0, Math.round(pl.hp)));
    h += bar('能量', world.energy / cfg.energyMax, '#7ab8ff', Math.round(world.energy));
    h += '<div><span class="k">波次</span>' + Math.max(world.wave, 0) + ' ／ ' + cfg.waves.length + '　<span class="k" style="width:auto">分數</span> ' + world.score + '</div>';
    h += '<div><span class="k">離黑洞</span>' + r.toFixed(r < 2 ? 3 : 2) + ' rs</div>';
    h += '<div><span class="k">速度</span>' + (st.inside ? '視界內沒有「靜止的人」可以比' : st.v.toFixed(3) + ' c（這裡的圓軌道 ' + (st.vc > 0 && r > 1.5 ? st.vc.toFixed(3) : '沒有') + '）') + '</div>';
    if (!st.inside) {
      var u = G.velocity4(holes, pl.s);
      h += '<div><span class="k">時間流速</span>你過 1，外面過 ' + u[3].toFixed(2) + '</div>';
    }
    if (this.target) h += '<div><span class="k">目標</span>' + this.target.dist.toFixed(1) + ' rs（你看到的是 ' + (world.t - this.target.body.seen.t).toFixed(1) + ' 之前的它）' +
      (this.aim ? (this.aim.ok ? '' : '<br><span class="warn">沒有射擊解：光到不了（被黑洞擋住，或太遠）</span>') : '') + '</div>';
    else h += '<div><span class="k">目標</span>—</div>';
    var warn = '';
    if (world.crossed) warn = '已經在視界裡面：引擎再大也出不去';
    else if (r < 1.5) warn = '在光子球以內：只有全力朝外推才出得去';
    else if (r < 3) warn = '在最內穩定軌道以內：不推就會掉進去';
    else if (r > cfg.arenaWarn) warn = '離戰場太遠了（超過 ' + cfg.arena + ' rs 算脫離）';
    if (warn) h += '<div class="warn">⚠ ' + warn + '</div>';
    h += '<div class="small">軌道輔助 ' + (this.assist ? '開' : '關') + '（C）　視角 ' + (this.view === 'chase' ? '船後' : '駕駛艙') + '（V）　' + (this.locked ? '滑鼠已鎖定（Esc 放開）' : '點一下畫面鎖定滑鼠') +
      '<br>' + Math.round(1000 / Math.max(this.app.frameMs(), 1)) + ' fps　解析度 ' + Math.round(this.app.S.scale * 100) + '%　主程式 ' + this.ms.toFixed(1) + ' ms　畫面上 ' + this.app.bodies.list.length + ' 個物體</div>';
    $('gpanel').innerHTML = h;
  };

  // 雷達：沿用俯視圖。虛線 ＝ 你不推的話會走的路；綠色虛線 ＝ 射擊解那顆光子會走的路（看得到它彎）
  GameUI.prototype.drawMap = function () {
    var world = this.world, pl = world.player, S = this.app.S;
    this.app.map.draw({
      holes: this.holes, tCam: world.t, disk: { on: true, rin: 3, rout: DISK_OUT }, game: true,
      cam: { pos: [pl.s[0], pl.s[1], pl.s[2]], fwd: pl.fwd, mode: 'fall', plan: this.plan, trail: [], fov: FOV },
      bodies: this.app.bodies.list, preview: this.aim && this.aim.ok ? this.aim.sol.tr : null, aim: null, kind: 'light'
    });
  };

  GameUI.prototype.finish = function () {
    var world = this.world, t = '', acc = world.shots ? Math.round(100 * world.hits / world.shots) : 0;
    this.ended = true;
    if (document.exitPointerLock && this.locked) document.exitPointerLock();
    var stat = '<br>擊落 <b>' + world.kills + '</b> 艘、分數 <b>' + world.score + '</b>、打到第 ' + Math.max(world.wave, 1) + ' 波；開了 ' + world.shots + ' 發、命中 ' + world.hits + ' 發（' + acc + '%）。' +
      '<br>你自己的時間過了 ' + world.tau.toFixed(0) + ' rs/c，外面過了 ' + world.t.toFixed(0) + '。';
    if (world.state === 'won') this.overlay('五波全部清空', '黑洞旁邊只剩你一艘。' + stat, false);
    else if (world.reason === 'singularity') this.overlay('被黑洞吃了', '你通過了視界，一路到奇異點。過了視界之後，不管引擎多大都出不來 —— 那不是推力的問題，是所有的路都朝裡面。' + stat, false);
    else if (world.reason === 'lost') this.overlay('脫離戰場', '你飛得太遠了。' + stat, false);
    else this.overlay('船被擊毀', '敵機的光彈打穿了船體。' + stat, false);
  };

  BH.GameUI = GameUI;
})();
