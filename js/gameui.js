/* 黑洞模擬 —— 太空戰鬥模式的畫面與操作
 *
 * 規則（誰在哪、誰打中誰、哪個部位壞了）在 js/world.js，運動在 js/game.js；這裡只做三件事：
 *   1. 把鍵盤滑鼠變成 world.step 的輸入
 *   2. 把 world 裡的船、光彈、彈丸、飛彈、爆炸放進 bodies（交給著色器畫 —— 跟模擬模式是同一支著色器、同一套光線追蹤）
 *   3. 畫疊在上面的準星、標記、讀數、雷達
 *
 * 玩家自己的船：攝影機就綁在船上，如果照「光行時間之前的樣子」畫，轉個頭要等光傳到攝影機才看得到（零點幾秒），很難開。
 * 所以交給著色器的是「照現在的速度等速直線、現在的朝向」的一小段路 —— 等於站在船自己的靜止系裡看，船是不動的。
 * 敵機、光彈、飛彈、爆炸都照實用光行時間之前的樣子畫：你看到的敵機是它幾秒前的位置。
 * 船身的洞也一樣：規則那一邊當場就挖掉了，畫面上要等「被打中那一刻的光」傳到你這裡才挖（自己的船當場挖）。
 */
(function () {
  'use strict';
  var BH = window.BH, P = BH.Physics, G = BH.Game, World = BH.World, Renderer = BH.Renderer;
  var DEG = Math.PI / 180;
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  var RATE = 2.5;            // 每秒過幾個 rs/c（玩家自己的固有時）
  var TURN = 1.25;           // 鍵盤轉向（弧度／秒）
  var MOUSE = 0.0026;        // 滑鼠轉向（弧度／像素）
  var FOV = 72;
  var DISK_OUT = 6.5;        // 戰鬥模式的吸積盤小一點：船在盤外面飛，盤是地標（也是掩護），不是一片霧
  var SELF_WINDOW = 3;       // 玩家自己那艘船交給著色器多長的一段路（座標時間）
  var WEAPONS = ['laser', 'kinetic', 'missile'];
  var WNAME = { laser: '雷射', kinetic: '動能砲', missile: '飛彈' };
  var TEAM_COLOR = { player: [1, 1, 1], enemy: [1.0, 0.50, 0.42] };
  var SHOT_COLOR = {
    laser: { player: [0.45, 2.6, 1.3], enemy: [2.8, 0.55, 0.35] },
    kinetic: { player: [2.3, 2.1, 1.5], enemy: [2.5, 1.3, 0.7] },
    missile: { player: [1.3, 2.1, 2.7], enemy: [2.9, 1.0, 0.55] }
  };
  var WHY = { core: '反應爐或駕駛艙壞了', hull: '船身只剩不到一半', disarmed: '武器全壞了', singularity: '掉到奇異點' };
  var HK = ['T', 'X', 'Y', 'Z', 'UX', 'UY', 'UZ', 'UT', 'PX', 'PY', 'PZ', 'PT', 'TAU', 'FX', 'FY', 'FZ', 'TH', 'GX', 'GY', 'GZ', 'FL'];

  /* app：{ canvas, renderer, bodies, map, S（顯示設定：scale、maxSteps、exposure、disk、mapOn）, toast(msg), exit(), frameMs() } */
  function GameUI(app) {
    this.app = app;
    this.active = false;
    this.keys = {};
    this.world = null;
    this.paused = false;
    this.view = 'chase';
    this.assist = true; this.autoFire = false; this.autoFly = false; this.weapon = 'laser';
    this.hud = $('ghud'); this.ctx = this.hud.getContext('2d');
    this.flash = 0; this.panelT = 0; this.fcT = 0; this.planT = 0; this.fallT = 0; this.fallRem = 1; this.aimHold = 0;
    this.plan = null;
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
    var app = this.app, i;
    this.holes = [P.makeHole({ rs: 1 })];
    this.world = new World(this.holes, { seed: (Date.now() & 0x3fffffff) || 1 });
    app.bodies.clear();
    this.views = {};         // 船 id → { ship, slot（格子貼圖的第幾個船位）, vis（畫面上那一份格子）, queue（光還沒到的損傷）, body }
    this.mviews = {};        // 飛彈 id → 畫面上的物體
    this.shotBody = {};      // 光彈／彈丸 id → 畫面上的物體
    this.fireballs = [];
    this.slotFree = [];
    for (i = 1; i < Renderer.SHIP_SLOTS; i++) this.slotFree.push(i);
    this.self = this.addShipView(this.world.player, true);
    if (this.mapRange0 == null) this.mapRange0 = app.map.range;
    this.active = true; this.paused = false; this.keys = {}; this.flash = 0; this.plan = null;
    this.mouseFire = false; this.ended = false; this.aimHold = 0;
    $('gover').className = '';
    app.toast('太空戰鬥開始 —— 第一波敵機馬上到');
  };
  GameUI.prototype.stop = function () {
    this.active = false; this.world = null; this.keys = {};
    if (document.exitPointerLock && this.locked) document.exitPointerLock();
    this.app.bodies.clear();
    if (this.mapRange0 != null) { this.app.map.range = this.mapRange0; this.mapRange0 = null; }
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
    var k = e.code, t = this.app.toast;
    if (k === 'KeyP' || k === 'Escape') { if (!this.ended) this.setPaused(!this.paused); return true; }
    if (e.repeat) return /^(Key[WASDQERFJ]|Arrow|Space|Shift)/.test(k);
    if (k === 'KeyH') { var hb = $('ghelp'); hb.style.display = hb.style.display === 'none' ? '' : 'none'; return true; }
    if (k === 'KeyV') { this.view = this.view === 'chase' ? 'cockpit' : 'chase'; t(this.view === 'chase' ? '視角：船後' : '視角：駕駛艙'); return true; }
    if (k === 'KeyC') { this.assist = !this.assist; t(this.assist ? '軌道輔助：開（放開推進鍵會自動修成圓軌道）' : '軌道輔助：關（放開就是自由落下）'); return true; }
    if (k === 'KeyT') { this.autoFire = !this.autoFire; t(this.autoFire ? '自動開火：開（哪一種武器對準了就射）' : '自動開火：關（空白鍵射選定的那一種）'); return true; }
    if (k === 'KeyG') { this.autoFly = !this.autoFly; t(this.autoFly ? '自動飛行：開（自己維持軌道、把機頭轉到射擊解上；你一動就還給你）' : '自動飛行：關'); return true; }
    if (k === 'Digit1' || k === 'Digit2' || k === 'Digit3') { this.weapon = WEAPONS[+k.charAt(5) - 1]; t('武器：' + WNAME[this.weapon]); return true; }
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
    if (this.locked) { this.world.rotatePlayer(e.movementX * MOUSE, -e.movementY * MOUSE, 0); this.aimHold = performance.now() + 900; return; }
    if (!this.drag) return;
    var dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX; this.drag.y = e.clientY; this.drag.moved += Math.abs(dx) + Math.abs(dy);
    this.world.rotatePlayer(dx * MOUSE, -dy * MOUSE, 0);
    this.aimHold = performance.now() + 900;
  };
  GameUI.prototype.pointerUp = function (e) {
    if (this.locked) { if (e.button === 0) this.mouseFire = false; return; }
    // 沒拖動的一下點擊 ＝ 把滑鼠鎖進畫面（之後移動滑鼠就是轉向、左鍵開火；Esc 放開）
    if (this.drag && this.drag.moved < 4 && this.active && !this.paused && !this.ended && this.app.canvas.requestPointerLock) {
      try { var pr = this.app.canvas.requestPointerLock(); if (pr && pr.catch) pr.catch(function () { /* 鎖不了就用拖曳 */ }); } catch (err) { /* 鎖不了就用拖曳 */ }
    }
    this.drag = null;
  };
  // A D 與左右鍵 ＝ 機頭左右；R F 與上下鍵 ＝ 機頭上下；Q E ＝ 滾轉；W S ＝ 往前／往後推
  GameUI.prototype.input = function (dt, now) {
    var k = this.keys, w = this.world;
    var yaw = ((k.ArrowRight || k.KeyD ? 1 : 0) - (k.ArrowLeft || k.KeyA ? 1 : 0)) * TURN * dt;
    var pitch = ((k.ArrowUp || k.KeyR ? 1 : 0) - (k.ArrowDown || k.KeyF ? 1 : 0)) * TURN * dt;
    var roll = ((k.KeyE ? 1 : 0) - (k.KeyQ ? 1 : 0)) * TURN * dt;
    if (yaw || pitch || roll) { w.rotatePlayer(yaw, pitch, roll); this.aimHold = now + 900; }
    return {
      f: (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0), boost: !!(k.ShiftLeft || k.ShiftRight), assist: this.assist,
      autoFly: this.autoFly, manualAim: now < this.aimHold, fire: !!(k.Space || k.KeyJ || this.mouseFire), weapon: this.weapon, autoFire: this.autoFire
    };
  };

  // ── 把 world 放進畫面 ───────────────────────────────
  // 玩家自己那艘：照現在的速度等速直線、現在的朝向（見檔頭）
  GameUI.prototype.selfTrail = function () {
    var w = this.world, sh = w.player, s = sh.s, u = G.velocity4(this.holes, s), h = G.histNew(), W = SELF_WINDOW, v = [u[0] / u[3], u[1] / u[3], u[2] / u[3]];
    var a = [s[3] - W, s[0] - v[0] * W, s[1] - v[1] * W, s[2] - v[2] * W, u[0], u[1], u[2], u[3], s[4], s[5], s[6], s[7], sh.tau - W / u[3], sh.fwd[0], sh.fwd[1], sh.fwd[2], sh.thr, sh.up[0], sh.up[1], sh.up[2], sh.flash];
    var b = a.slice(); b[0] = s[3]; b[1] = s[0]; b[2] = s[1]; b[3] = s[2]; b[12] = sh.tau;
    for (var i = 0; i < HK.length; i++) h[HK[i]] = [a[i], b[i]];
    h.n = 2;
    return h;
  };
  // 一艘船出場：給它一個船位、把一整份格子傳上去
  GameUI.prototype.addShipView = function (sh, isSelf) {
    var app = this.app, w = this.world, slot = this.slotFree.length ? this.slotFree.shift() : 0;
    var v = { ship: sh, slot: slot, vis: null, queue: [], body: null };
    if (slot) { v.vis = w.model.grid.slice(); app.renderer.setShipSlot(slot, v.vis); }
    v.body = app.bodies.addLive(isSelf ? this.selfTrail() : sh.hist, { radius: 0.5 * w.cfg.shipLen, color: TEAM_COLOR[sh.team], tag: sh, slot: slot });
    v.body.engMask = sh.engMask;
    this.views[sh.id] = v;
    return v;
  };
  // 把一批被打掉的格子從「畫面上那一份」拿掉，只重傳包住它們的那一小塊
  GameUI.prototype.applyCells = function (v, cells) {
    if (!v.vis || !cells.length) return;
    var d = this.world.model.dims, nx = d[0], ny = d[1], x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, z0 = 1e9, z1 = -1, i, x, y, z;
    for (i = 0; i < cells.length; i++) {
      var idx = cells[i];
      v.vis[idx] = 0;
      x = idx % nx; y = Math.floor(idx / nx) % ny; z = Math.floor(idx / (nx * ny));
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    var w = x1 - x0 + 1, h = y1 - y0 + 1, dz = z1 - z0 + 1, buf = new Uint8Array(w * h * dz), k = 0;
    for (z = z0; z <= z1; z++) for (y = y0; y <= y1; y++) { var o = x0 + nx * (y + ny * z); buf.set(v.vis.subarray(o, o + w), k); k += w; }
    this.app.renderer.patchShipSlot(v.slot, x0, y0, z0, w, h, dz, buf);
  };
  GameUI.prototype.sync = function (events) {
    var app = this.app, bodies = app.bodies, w = this.world, cfg = w.cfg, pl = w.player, i, e, b, v;
    for (i = 0; i < events.length; i++) {
      e = events[i];
      if (e.type === 'spawn') this.addShipView(e.ship, false);
      else if (e.type === 'shot') {
        var sh = e.shot;
        this.shotBody[sh.id] = sh.kind === 'laser'
          ? bodies.addTraced(sh.tr, { kind: 'light', color: SHOT_COLOR.laser[sh.team], radius: 0.036, linger: 60, tag: sh })
          : bodies.addTraced(sh.tr, { kind: 'ball', color: SHOT_COLOR.kinetic[sh.team], radius: 0.028, linger: 60, tag: sh });
      } else if (e.type === 'missile') {
        this.mviews[e.missile.id] = bodies.addLive(e.missile.hist, { shape: 'ball', radius: 0.042, color: SHOT_COLOR.missile[e.missile.team], tag: e.missile });
      } else if (e.type === 'missileEnd') {
        b = this.mviews[e.missile.id];
        if (b && bodies.list.indexOf(b) >= 0) { b.tr = e.missile.hist; bodies.upload(b); b.live = false; b.fixed = true; b.linger = 90; }
        if (e.why === 'hit' || e.why === 'intercept') this.boom(e.missile.hist, e.why === 'hit' ? 0.3 : 0.14, null);
        if (e.missile.team === 'player' && e.why !== 'hit') app.toast(e.why === 'eaten' ? '飛彈掉進黑洞了' : (e.why === 'intercept' ? '飛彈被打掉了' : '飛彈燃料用完、沒追上'));
      } else if (e.type === 'hit') {
        v = this.views[e.ship.id];
        if (e.src && this.shotBody[e.src.id]) { b = this.shotBody[e.src.id]; if (bodies.list.indexOf(b) >= 0) bodies.truncate(b, e.t); }
        if (v) { if (e.ship === pl) this.applyCells(v, e.cells); else v.queue.push({ t: e.t, cells: e.cells }); }
        if (e.ship === pl) this.flash = 1;
      } else if (e.type === 'part') {
        v = this.views[e.ship.id];
        if (e.ship === pl) { if (v) v.body.engMask = pl.engMask; app.toast('⚠ ' + e.part.name + '壞了'); }
        else if (v) v.queue.push({ t: e.t, part: e.part, mask: e.ship.engMask });
      } else if (e.type === 'kill') {
        v = this.views[e.ship.id];
        if (v && v.body) { b = v.body; b.tr = e.ship.hist; bodies.upload(b); b.live = false; b.fixed = true; b.linger = 90; }      // 它最後的光還在路上，留到光過去為止
        if (e.why !== 'singularity') this.boom(e.ship.hist, 0.65, e.why);
        else app.toast('一艘敵機掉進黑洞了');
      } else if (e.type === 'repair') {
        v = this.views[e.ship.id];
        if (v && v.slot) { v.vis = w.model.grid.slice(); app.renderer.setShipSlot(v.slot, v.vis); v.queue = []; v.body.engMask = e.ship.engMask; }
      } else if (e.type === 'wave') app.toast('第 ' + e.wave + ' 波：' + cfg.waves[e.wave - 1].length + ' 艘敵機（總共 ' + cfg.waves.length + ' 波）');
      else if (e.type === 'waveClear') app.toast('第 ' + e.wave + ' 波清空 —— 船修回原樣、飛彈補滿');
      else if (e.type === 'cross') app.toast('通過視界了 —— 身邊沒有任何記號。還能飛、還能開火，只是所有的路都朝裡面');
    }
    // 每一格：自己那艘整段換掉；敵機與飛彈的歷史 world 已經接長了，重新上傳
    this.self.body.tr = this.selfTrail();
    this.self.body.engMask = pl.engMask;
    bodies.upload(this.self.body);
    for (var id in this.views) {
      v = this.views[id];
      if (v !== this.self && v.ship.alive && bodies.list.indexOf(v.body) >= 0) bodies.upload(v.body);
    }
    for (i = 0; i < w.missiles.length; i++) {
      b = this.mviews[w.missiles[i].id];
      if (b && w.missiles[i].alive && bodies.list.indexOf(b) >= 0) bodies.upload(b);
    }
  };
  // 爆炸：一顆會長大、變暗的火球，從 hist 的最後一點照測地線繼續飄
  GameUI.prototype.boom = function (hs, size, why) {
    var n = hs.n - 1;
    var tr = G.coast(this.holes, { x: hs.X[n], y: hs.Y[n], z: hs.Z[n], t: hs.T[n], px: hs.PX[n], py: hs.PY[n], pz: hs.PZ[n], pt: hs.PT[n], tau: 0 }, 5);
    var fb = this.app.bodies.addTraced(tr, { kind: 'ball', color: [3, 1.7, 0.6], radius: 0.06, linger: 90, tag: 'fireball' });
    if (fb) this.fireballs.push({ body: fb, t0: tr.T[0], told: false, size: size, why: why });
  };
  /* 每一格在「看到的時刻」算出來之後：
   *   船身的洞、壞掉的引擎：等被打中那一刻的光傳到這裡才挖、才熄
   *   火球：照「你看到它的那一刻」離爆炸多久來長大、變暗
   *   已經看完的東西（光彈飛完、船爆完）收掉，船位還回去 */
  GameUI.prototype.afterUpdate = function () {
    var app = this.app, bodies = app.bodies, w = this.world, i, b, v, id;
    for (id in this.views) {
      v = this.views[id];
      var gone = bodies.list.indexOf(v.body) < 0, tSeen = v === this.self ? w.t : (gone || v.body.seenT == null ? -Infinity : v.body.seenT);
      while (v.queue.length && v.queue[0].t <= tSeen) {
        var q = v.queue.shift();
        if (q.cells) this.applyCells(v, q.cells);
        if (q.part) { v.body.engMask = q.mask; app.toast('敵機的' + q.part.name + '壞了'); }
      }
      if (v !== this.self && !v.ship.alive) {
        if (!gone && v.body.seenT != null && v.body.seenT >= v.body.t1 - 1e-3) { bodies.removeBody(v.body); gone = true; }
        if (gone) { if (v.slot) this.slotFree.push(v.slot); delete this.views[id]; }
      }
    }
    for (i = this.fireballs.length - 1; i >= 0; i--) {
      var f = this.fireballs[i];
      b = f.body;
      if (bodies.list.indexOf(b) < 0) { this.fireballs.splice(i, 1); continue; }
      var age = b.seenT == null ? 0 : b.seenT - f.t0, fade = Math.exp(-0.75 * age);
      b.radius = 0.06 + f.size * (1 - Math.exp(-1.3 * age));
      b.color = [3 * fade, 1.7 * fade * fade, 0.6 * fade * fade * fade];
      if (b.seenT != null && !f.told && f.why) { f.told = true; app.toast('擊毀確認（' + (WHY[f.why] || f.why) + '）—— 爆炸的光現在才傳到你這裡'); }
      if (age > 4.2) { bodies.removeBody(b); this.fireballs.splice(i, 1); }
    }
    for (i = bodies.list.length - 1; i >= 0; i--) {
      b = bodies.list[i];
      if (b.fixed && b.tag !== 'fireball' && b.shape !== 'pilot' && b.seenT != null && b.seenT >= b.t1 - 1e-3) bodies.remove(i);
    }
    this.cull();
  };
  /* 小東西（光彈、彈丸、飛彈）一多，著色器每一步都要對每一個檢查一次，會慢。
   * 確定不在鏡頭裡的就先不交給著色器：光還沒到的、在背後的、偏出視野外一截的。
   * 靠近黑洞的不篩（那裡的光是彎的，直線估的方向不準，而且會有繞過來的像）；攝影機自己靠近黑洞時也不篩。 */
  GameUI.prototype.cull = function () {
    var bodies = this.app.bodies, cf = this.cf, holes = this.holes, c = holes[0].pos, rs = holes[0].rs, i, b;
    var cv = this.app.canvas, asp = cv.clientWidth / Math.max(cv.clientHeight, 1), tanF = Math.tan(FOV * DEG / 2);
    var lim = Math.atan(tanF * Math.hypot(1, asp)) + 0.22, free = !cf || cf.r < 4.5 * rs;
    for (i = 0; i < bodies.list.length; i++) {
      b = bodies.list[i];
      b.hidden = false;
      if (free || b.shape === 'pilot' || b.tag === 'fireball') continue;
      if (!b.seen) { b.hidden = true; continue; }
      if (Math.hypot(b.seen.x - c[0], b.seen.y - c[1], b.seen.z - c[2]) < 5 * rs) continue;
      var pj = G.project(holes, cf, [b.seen.x, b.seen.y, b.seen.z]);
      if (pj && (pj[2] <= 0 || Math.atan2(Math.hypot(pj[0], pj[1]), pj[2]) > lim)) b.hidden = true;
    }
  };

  // ── 一格 ────────────────────────────────────────────
  GameUI.prototype.frame = function (dtWall, now, w, h) {
    var app = this.app, S = app.S, world = this.world, holes = this.holes, cfg = world.cfg, t0 = performance.now(), pl = world.player;
    var play = !this.paused && world.state === 'play', rate = RATE;
    // 進了視界之後自動放慢：剩下的路照自己的鐘不到 1 rs/c，照平常的速度一眨眼就沒了
    if (world.crossed && play) {
      if (now - this.fallT > 120) {
        this.fallT = now;
        var tr = P.trace(holes, Float64Array.from(pl.s), { tSpan: 30, rEnd: 0.03, frac: 0.01, maxSteps: 20000 });
        this.fallRem = tr.fate === 'singularity' ? tr.TAU[tr.n - 1] : 1;
      }
      rate = Math.min(RATE, Math.max(0.12, this.fallRem / 3));
    }
    if (play) {
      if (now - this.fcT > 140) { this.fcT = now; world.updatePlayerFC(); }
      world.step(dtWall * rate, this.input(dtWall, now));
      this.sync(world.takeEvents());
    }
    this.flash = Math.max(0, this.flash - dtWall * 2.2);
    var L = cfg.shipLen, pos = [pl.s[0], pl.s[1], pl.s[2]], camPos;
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
    if (now - this.planT > 500 && pl.alive) { this.planT = now; this.plan = G.predict(holes, pl.s, 150, world.wall, 1.5); }
    this.drawHud();
    if (S.mapOn && (this.frameNo = (this.frameNo || 0) + 1) & 1) this.drawMap();
    if (now - this.panelT > 110) { this.panelT = now; this.drawPanel(rate); }
    if (world.state !== 'play' && !this.ended) this.finish();
    this.ms = this.ms * 0.9 + (performance.now() - t0) * 0.1;
  };

  // ── 疊在畫面上的東西 ────────────────────────────────
  GameUI.prototype.drawHud = function () {
    var cv = this.hud, ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    var W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    ctx.clearRect(0, 0, W, H);
    if (!this.world || !this.cf) return;
    var world = this.world, cfg = world.cfg, holes = this.holes, cf = this.cf, pl = world.player, bodies = this.app.bodies, tanF = Math.tan(FOV * DEG / 2), cx = W / 2, cy = H / 2, hole = holes[0].pos, i, id;
    var fc = pl.fc && pl.fc.target.alive ? pl.fc : null;
    function scr(v) { return v[2] > 1e-6 ? [cx + v[0] / v[2] / tanF * cy, cy - v[1] / v[2] / tanF * cy] : null; }
    ctx.lineWidth = 1.5 * dpr; ctx.font = (11 * dpr) + 'px sans-serif'; ctx.textAlign = 'center';
    if (this.flash > 0) { ctx.fillStyle = 'rgba(255,60,40,' + (0.33 * this.flash).toFixed(3) + ')'; ctx.fillRect(0, 0, W, H); }

    // 敵機標記：畫在「它的光直線飛過來」會出現的地方（有算光行差；沒算光被彎，所以貼著黑洞時標成虛線）
    for (id in this.views) {
      var v = this.views[id], sh = v.ship, b = v.body;
      if (sh.team !== 'enemy' || !b.seen || bodies.list.indexOf(b) < 0) continue;
      if (!sh.alive && b.seenT >= b.t1 - 1e-3) continue;
      var src = [b.seen.x, b.seen.y, b.seen.z], pj = G.project(holes, cf, src);
      if (!pj) continue;
      var bent = G.segNear(cf.pos, src, hole) < 3.2 * holes[0].rs, p = scr(pj), dist = Math.hypot(src[0] - cf.pos[0], src[1] - cf.pos[1], src[2] - cf.pos[2]);
      var isT = fc && fc.target === sh, col = isT ? 'rgba(255,120,90,0.95)' : 'rgba(255,120,90,0.6)';
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.setLineDash(bent ? [4 * dpr, 4 * dpr] : []);
      if (p && p[0] > 12 && p[0] < W - 12 && p[1] > 12 && p[1] < H - 12) {
        var r = clamp(cfg.shipLen * 0.9 / dist / tanF * cy, 9 * dpr, 60 * dpr), g = r * 0.45;
        ctx.beginPath();
        ctx.moveTo(p[0] - r, p[1] - r + g); ctx.lineTo(p[0] - r, p[1] - r); ctx.lineTo(p[0] - r + g, p[1] - r);
        ctx.moveTo(p[0] + r - g, p[1] - r); ctx.lineTo(p[0] + r, p[1] - r); ctx.lineTo(p[0] + r, p[1] - r + g);
        ctx.moveTo(p[0] + r, p[1] + r - g); ctx.lineTo(p[0] + r, p[1] + r); ctx.lineTo(p[0] + r - g, p[1] + r);
        ctx.moveTo(p[0] - r + g, p[1] + r); ctx.lineTo(p[0] - r, p[1] + r); ctx.lineTo(p[0] - r, p[1] + r - g);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText(dist.toFixed(1) + ' rs' + (bent ? '（光被彎）' : '') + (isT && fc.missile && fc.missile.ok ? '　飛彈可發' : ''), p[0], p[1] + r + 13 * dpr);
        // 核心還撐得住多少：反應爐與駕駛艙離「壞掉」的門檻還有多遠，取小的那個
        var core = 1, stt = world.status(sh), j;
        for (j = 0; j < stt.length; j++) if (stt[j].kind === 'core') core = Math.min(core, (stt[j].left - stt[j].dead) / (1 - stt[j].dead));
        var hw = Math.max(r, 14 * dpr);
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(p[0] - hw, p[1] - r - 8 * dpr, 2 * hw, 3 * dpr);
        ctx.fillStyle = col; ctx.fillRect(p[0] - hw, p[1] - r - 8 * dpr, 2 * hw * clamp(core, 0, 1), 3 * dpr);
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
    // 朝你來的飛彈：小三角
    var incoming = 0;
    for (i = 0; i < world.missiles.length; i++) {
      var ms = world.missiles[i], mb = this.mviews[ms.id];
      if (!ms.alive || ms.team === 'player' || !mb || !mb.seen) continue;
      incoming++;
      var mp = G.project(holes, cf, [mb.seen.x, mb.seen.y, mb.seen.z]), ps = mp ? scr(mp) : null;
      if (!ps || ps[0] < 8 || ps[0] > W - 8 || ps[1] < 8 || ps[1] > H - 8) continue;
      var t3 = 6 * dpr;
      ctx.strokeStyle = 'rgba(255,170,60,0.95)';
      ctx.beginPath(); ctx.moveTo(ps[0], ps[1] - t3); ctx.lineTo(ps[0] + t3, ps[1] + t3); ctx.lineTo(ps[0] - t3, ps[1] + t3); ctx.closePath(); ctx.stroke();
    }
    if (incoming) { ctx.fillStyle = 'rgba(255,170,60,0.95)'; ctx.font = (13 * dpr) + 'px sans-serif'; ctx.fillText('⚠ 飛彈來襲 × ' + incoming, cx, 62 * dpr); ctx.font = (11 * dpr) + 'px sans-serif'; }

    // 射擊解：把準星移到這上面再開火。菱形 ＝ 雷射，方框 ＝ 動能砲（彈丸慢，要抓的提前量不一樣）
    var locked = false, self = this;
    function reticle(kind, shape, color) {
      var sol = fc && fc[kind];
      if (!sol || !sol.ok || !sol.e) return;
      var q = scr(G.projectDir(cf, sol.e));
      if (!q) return;
      var on = Math.acos(clamp(G.dot3(pl.fwd, sol.nose), -1, 1)) < cfg[kind].tol, sel = self.weapon === kind, d2 = (sel ? 9 : 6) * dpr;
      if (on && (sel || self.autoFire)) locked = true;
      ctx.strokeStyle = on ? 'rgba(120,255,160,1)' : color;
      ctx.globalAlpha = sel || self.autoFire ? 1 : 0.55;
      ctx.beginPath();
      if (shape === 'diamond') { ctx.moveTo(q[0], q[1] - d2); ctx.lineTo(q[0] + d2, q[1]); ctx.lineTo(q[0], q[1] + d2); ctx.lineTo(q[0] - d2, q[1]); ctx.closePath(); }
      else ctx.rect(q[0] - d2 * 0.8, q[1] - d2 * 0.8, d2 * 1.6, d2 * 1.6);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(WNAME[kind] + '　飛 ' + (sol.tHit - pl.s[3]).toFixed(1), q[0], q[1] - d2 - 5 * dpr);
      ctx.globalAlpha = 1;
    }
    reticle('laser', 'diamond', 'rgba(255,225,120,0.95)');
    reticle('kinetic', 'square', 'rgba(255,170,90,0.95)');
    // 準星
    var cs = 10 * dpr, gap = 4 * dpr;
    ctx.strokeStyle = locked ? 'rgba(120,255,160,1)' : 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(cx - cs, cy); ctx.lineTo(cx - gap, cy); ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + cs, cy);
    ctx.moveTo(cx, cy - cs); ctx.lineTo(cx, cy - gap); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + cs);
    ctx.stroke();
  };

  GameUI.prototype.drawPanel = function (rate) {
    var world = this.world, cfg = world.cfg, pl = world.player, holes = this.holes, st = G.steer(holes, pl.s, {}), r = G.radius(holes, pl.s), h = '', i, self = this;
    var parts = world.status(pl), fc = pl.fc && pl.fc.target.alive ? pl.fc : null;
    function bar(label, frac, col, txt) {
      return '<div class="gbar"><span class="k">' + label + '</span><span class="track"><i style="width:' + (clamp(frac, 0, 1) * 100).toFixed(1) + '%;background:' + col + '"></i></span><span class="v">' + txt + '</span></div>';
    }
    function part(key) { for (var j = 0; j < parts.length; j++) if (parts[j].key === key) return parts[j]; return null; }
    function margin(p) { return (p.left - p.dead) / (1 - p.dead); }
    ['reactor', 'cockpit'].forEach(function (key) { var p = part(key), m = margin(p); h += bar(p.name, m, m > 0.4 ? '#7fe0a0' : '#ff7a5c', p.ok ? Math.round(p.left * 100) + '%' : '壞了'); });
    h += bar('能量', world.energy / cfg.energyMax, '#7ab8ff', Math.round(world.energy));
    var eng = '', nOk = 0, nAll = 0;
    for (i = 0; i < parts.length; i++) if (parts[i].kind === 'engine') { nAll++; if (parts[i].ok) nOk++; eng += '<span style="color:' + (parts[i].ok ? '#7ab8ff' : '#ff7a5c') + '">' + (parts[i].ok ? '●' : '✕') + '</span>'; }
    h += '<div><span class="k">引擎</span>' + eng + '　推力 ' + Math.round(100 * nOk / Math.max(nAll, 1)) + '%</div>';
    WEAPONS.forEach(function (kind, n) {
      var list = parts.filter(function (p) { return p.kind === kind; }), okN = list.filter(function (p) { return p.ok; }).length, txt;
      if (!okN) txt = '<span class="warn">壞了</span>';
      else {
        txt = (list.length > 1 ? okN + '／' + list.length + ' 　' : '') + (kind === 'missile' ? '剩 ' + pl.stock + ' 枚　' : '');
        txt += pl.cool[kind] > 0 ? '冷卻 ' + pl.cool[kind].toFixed(1) : (kind !== 'missile' && fc && fc[kind] && fc[kind].ok ? '有解' : (kind === 'missile' && fc && fc.missile && fc.missile.ok ? '可發' : '待命'));
      }
      h += '<div' + (self.weapon === kind ? ' class="wsel"' : '') + '><span class="k">' + (n + 1) + ' ' + WNAME[kind] + '</span>' + txt + '</div>';
    });
    h += '<div><span class="k">波次</span>' + Math.max(world.wave, 0) + ' ／ ' + cfg.waves.length + '　<span class="k" style="width:auto">分數</span> ' + world.score + '</div>';
    h += '<div><span class="k">離黑洞</span>' + r.toFixed(r < 2 ? 3 : 2) + ' rs</div>';
    h += '<div><span class="k">速度</span>' + (st.inside ? '視界內沒有「靜止的人」可以比' : st.v.toFixed(3) + ' c（這裡的圓軌道 ' + (st.vc > 0 && r > 1.5 ? st.vc.toFixed(3) : '沒有') + '）') + '</div>';
    if (!st.inside) { var u = G.velocity4(holes, pl.s); h += '<div><span class="k">時間流速</span>你過 1，外面過 ' + u[3].toFixed(2) + '</div>'; }
    if (fc) {
      h += '<div><span class="k">目標</span>' + fc.dist.toFixed(1) + ' rs（你看到的是 ' + fc.lag.toFixed(1) + ' 之前的它）';
      var sol = fc[this.weapon];
      if (this.weapon !== 'missile' && !(sol && sol.ok)) h += '<br><span class="warn">' + WNAME[this.weapon] + '沒有射擊解（被黑洞擋住、太遠、或那一門壞了）</span>';
      h += '</div>';
    } else h += '<div><span class="k">目標</span>—</div>';
    var warn = '';
    if (world.crossed) warn = '已經在視界裡面：引擎再大也出不去。照你自己的鐘，離奇異點還有 ' + this.fallRem.toFixed(3) + ' rs/c' + (rate < RATE ? '（時間已自動放慢）' : '');
    else if (r < 1.5) warn = '在光子球以內：只有全力朝外推才出得去';
    else if (r < 3) warn = '在最內穩定軌道以內：不推就會掉進去';
    else if (world.wall && r > world.wall.R) warn = '外圍的空間扭曲正在把你往回帶（越遠越強）';
    if (warn) h += '<div class="warn">⚠ ' + warn + '</div>';
    function onoff(b) { return b ? '<b style="color:#7fe0a0">開</b>' : '關'; }
    h += '<div class="small">自動開火 ' + onoff(this.autoFire) + '（T）　自動飛行 ' + onoff(this.autoFly) + '（G）　軌道輔助 ' + onoff(this.assist) + '（C）' +
      '<br>視角 ' + (this.view === 'chase' ? '船後' : '駕駛艙') + '（V）　' + (this.locked ? '滑鼠已鎖定（Esc 放開）' : '點一下畫面鎖定滑鼠') +
      '<br>' + Math.round(1000 / Math.max(this.app.frameMs(), 1)) + ' fps　解析度 ' + Math.round(this.app.S.scale * 100) + '%　主程式 ' + this.ms.toFixed(1) + ' ms　畫面上 ' + this.app.bodies.list.length + ' 個物體</div>';
    $('gpanel').innerHTML = h;
  };

  // 雷達：沿用俯視圖。白虛線 ＝ 你不推的話會走的路；綠虛線 ＝ 選定的武器照射擊解射出去會走的路（看得到它彎）
  GameUI.prototype.drawMap = function () {
    var world = this.world, pl = world.player, r = G.radius(this.holes, pl.s), fc = pl.fc, sol = fc && this.weapon !== 'missile' ? fc[this.weapon] : null, map = this.app.map;
    map.range = clamp(1.35 * r, 16, 120);
    map.draw({
      holes: this.holes, tCam: world.t, disk: { on: true, rin: 3, rout: DISK_OUT }, game: true, wallR: world.wall ? world.wall.R : 0,
      cam: { pos: [pl.s[0], pl.s[1], pl.s[2]], fwd: pl.fwd, mode: 'fall', plan: this.plan, trail: [], fov: FOV },
      bodies: this.app.bodies.list, preview: sol && sol.ok ? sol.tr : null, aim: null, kind: this.weapon === 'laser' ? 'light' : 'ball'
    });
  };

  GameUI.prototype.finish = function () {
    var world = this.world, s = world.stats;
    this.ended = true;
    if (document.exitPointerLock && this.locked) document.exitPointerLock();
    function line(kind) { return WNAME[kind] + ' ' + s[kind].hits + '／' + s[kind].shots; }
    var stat = '<br>擊毀 <b>' + world.kills + '</b> 艘、分數 <b>' + world.score + '</b>、打到第 ' + Math.max(world.wave, 1) + ' 波。' +
      '<br>命中／發射：' + line('laser') + '、' + line('kinetic') + '、' + line('missile') + '。' +
      '<br>你自己的時間過了 ' + world.tau.toFixed(0) + ' rs/c，外面過了 ' + world.t.toFixed(0) + '。';
    if (world.state === 'won') this.overlay('五波全部清空', '黑洞旁邊只剩你一艘。' + stat, false);
    else if (world.reason === 'singularity') this.overlay('到奇異點了', '你穿過視界、一路飛到最後。過了視界之後，不管引擎多大都出不來 —— 那不是推力的問題，是所有的路都朝裡面。' + stat, false);
    else if (world.reason === 'disarmed') this.overlay('武器全毀', '雷射發射器、動能砲、飛彈艙都被打壞了，這艘船已經沒有辦法還手。' + stat, false);
    else if (world.reason === 'hull') this.overlay('船身解體', '船身的格子被打掉超過一半。' + stat, false);
    else this.overlay('船被擊毀', '反應爐或駕駛艙被打壞了。' + stat, false);
  };

  BH.GameUI = GameUI;
})();
