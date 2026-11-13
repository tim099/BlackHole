/* 黑洞模擬 —— 太空戰鬥模式：一場戰鬥（不碰畫面、不碰網頁元件；瀏覽器與 node 共用）
 *
 * 運動全部交給 js/game.js（也就是 physics.js 的度規）。這裡管的是遊戲規則：
 *
 *   船身    每艘船自己有一份格子（雕刻作品的體素）。沒有血量：被打到哪裡，哪裡的格子就沒了。
 *           模型上劃了幾個「部位」（一個方盒裡的格子）：反應爐、駕駛艙、每一具引擎、雷射發射器、兩門動能砲、兩個飛彈艙。
 *           一個部位剩下的格子低於門檻就算壞了：引擎壞 ⇒ 推力少一份、那一具的噴射也沒了；武器壞 ⇒ 那一門不能用；
 *           反應爐或駕駛艙壞 ⇒ 船毀了。打出來的洞是真的洞：之後的東西會從洞裡穿過去。
 *   武器    雷射 ＝ 一顆光子（最快、彎得最少；打出一條細長的洞）
 *           動能 ＝ 一顆有質量的彈丸（慢、被黑洞彎得多、提前量大；打出一個坑，相對速度越快坑越大）
 *           飛彈 ＝ 自己有引擎、會朝目標轉向（最慢、數量有限；碰到就炸掉一大塊，也可能被打掉或掉進黑洞）
 *   看到的  每艘船只知道對手「光傳到自己這裡的那一刻」的樣子；射擊解從那一刻往後推。
 *   邊界    外圍有一圈往回帶的空間扭曲（game.js 的 wallKick）；沒有「飛出戰場」這種輸法。
 *   結束    玩家：反應爐或駕駛艙壞了、武器全壞、或掉到奇異點（穿過視界不算，還能繼續飛到最後）。
 *
 * 上面每一個數字（加速度、洞多大、門檻、敵機行為、波次）都是遊戲設定，不是物理。
 * 船是剛體：不會被潮汐力扯碎，被打掉的碎塊也不會飄走（少了的格子就是不見了）。
 */
(function (root) {
  'use strict';
  var node = typeof module !== 'undefined' && !!module.exports;
  var BH = root.BH = root.BH || {};
  var P = node ? require('./physics.js') : BH.Physics;
  var G = node ? require('./game.js') : BH.Game;
  var ShipLib = node ? require('./ship.js') : BH.Ship;
  var norm = G.norm, cross = G.cross, dot3 = G.dot3, sub = G.sub, len = G.len, clamp = G.clamp;

  var WEAPONS = ['laser', 'kinetic', 'missile'];
  var CFG = {
    shipLen: 0.5,        // 船長（rs）
    accel: 0.03,         // 引擎全好時的固有加速度（c²/rs）；4.5 rs 以內光靠它已經懸停不住
    boost: 2.2, boostCost: 10, energyMax: 100, energyRegen: 7,
    laser: { gap: 0.55, cost: 9, range: 22, radius: 3, depth: 50, tol: 0.012 },
    kinetic: { gap: 1.6, cost: 6, speed: 0.45, range: 55, solveRange: 40, base: 5, gain: 7, max: 14, tol: 0.02 },
    missile: { gap: 5, stock: 6, reload: 25, speed: 0.15, accel: 0.2, burn: 8, life: 55, blast: 14, cone: 0.9, fuse: 0.04, guard: 0.03, minRange: 2, maxRange: 32 },
    aimTol: 0.1,         // 射擊解：預測的最近距離小於這個才算有解（rs）
    enemyAccel: 0.022, enemyTurn: 0.55, enemyRange: 14, enemySpread: 0.012, enemyFC: 0.6,
    enemyGap: { laser: 4.5, kinetic: 7, missile: 16 },
    autoTurn: 1.4,       // 自動飛行轉機頭的速度（弧度 ÷ 固有時）
    histKeep: 190,       // 每個東西留多久的歷史（座標時間）：要比戰場上最遠的光行時間長
    wallR: 70, wallK: 0.004,
    waves: [['L'], ['L', 'LK'], ['LK', 'LM'], ['L', 'LK', 'LM'], ['LK', 'LM', 'LKM']],     // 每一波每艘敵機帶什麼：L 雷射、K 動能、M 飛彈
    waveGap: 3, hullDead: 0.6,
    playerTough: 0.3,    // 玩家的船比較耐打：每個部位「壞掉」的門檻乘上這個數（反應爐要剩不到 15% 才算壞，敵機是 50%）
    chase: 0.78          // 對手在黑洞另一側、或離得太遠時，換到「對手的軌道半徑 × 這個數」的軌道上：角速度不一樣，才繞得到同一側
  };
  function cfgCopy(over) {
    var c = {}, k, j;
    function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
    for (k in CFG) { if (isObj(CFG[k])) { c[k] = {}; for (j in CFG[k]) c[k][j] = CFG[k][j]; } else c[k] = CFG[k]; }
    if (over) for (k in over) { if (isObj(c[k]) && isObj(over[k])) { for (j in over[k]) c[k][j] = over[k][j]; } else c[k] = over[k]; }
    return c;
  }

  // ── 船的格子與部位 ──────────────────────────────────
  /* 部位：以 205 × 118 × 39 的「餘暉號」為準（x 機頭、y 左舷、z 上）；別的模型照外框比例縮放。
   * box ＝ [x0, x1, y0, y1, z0, z1]（含兩端），dead ＝ 剩下的比例低於這個就算壞了，muzzle ＝ 東西從哪裡射出去（模型座標）。
   * 反應爐在船身正中間、整個包在裡面，平常看不到；格子另外塗成會發光的顏色，被打開之後才露出來。 */
  var PART_DEFS = [
    { key: 'reactor', name: '反應爐', kind: 'core', box: [96, 110, 53, 65, 12, 24], dead: 0.5, paint: 248 },      // 就在船的正中心：射擊解瞄的就是這裡
    { key: 'cockpit', name: '駕駛艙', kind: 'core', box: [132, 156, 51, 67, 19, 29], dead: 0.5 },
    { key: 'laser', name: '雷射發射器', kind: 'laser', box: [178, 204, 40, 78, 0, 38], dead: 0.4, muzzle: [208, 59, 10.5] },
    { key: 'gunR', name: '動能砲（右）', kind: 'kinetic', box: [100, 122, 24, 41, 0, 38], dead: 0.4, muzzle: [125, 33, 8] },
    { key: 'gunL', name: '動能砲（左）', kind: 'kinetic', box: [100, 122, 77, 94, 0, 38], dead: 0.4, muzzle: [125, 85, 8] },
    { key: 'podR', name: '飛彈艙（右）', kind: 'missile', box: [58, 86, 8, 24, 0, 38], dead: 0.4, muzzle: [90, 15, 9] },
    { key: 'podL', name: '飛彈艙（左）', kind: 'missile', box: [58, 86, 94, 110, 0, 38], dead: 0.4, muzzle: [90, 103, 9] }
  ];
  var MODEL = null;
  // m ＝ BH.Ship.decode(...) 的結果。回傳戰鬥用的模型：{ dims, grid（反應爐塗過色）, count, parts, partOf, engines }
  function setModel(m) {
    var nx = m.dims[0], ny = m.dims[1], nz = m.dims[2], sx = nx / 205, sy = ny / 118, sz = nz / 39;
    var parts = [], partOf = new Uint8Array(nx * ny * nz), grid = m.grid.slice();
    function add(def, box, muzzle) {
      var id = parts.length + 1, total = 0, b = [Math.max(0, box[0]), Math.min(nx - 1, box[1]), Math.max(0, box[2]), Math.min(ny - 1, box[3]), Math.max(0, box[4]), Math.min(nz - 1, box[5])];
      for (var z = b[4]; z <= b[5]; z++) for (var y = b[2]; y <= b[3]; y++) for (var x = b[0]; x <= b[1]; x++) {
        var idx = x + nx * (y + ny * z);
        if (grid[idx] && !partOf[idx]) { partOf[idx] = id; total++; if (def.paint) grid[idx] = def.paint; }
      }
      parts.push({ id: id, key: def.key, name: def.name, kind: def.kind, dead: def.dead, total: total, box: b, muzzle: muzzle || null, engine: def.engine != null ? def.engine : -1 });
    }
    PART_DEFS.forEach(function (d) {
      var b = d.box;
      add(d, [Math.round(b[0] * sx), Math.round(b[1] * sx), Math.round(b[2] * sy), Math.round(b[3] * sy), Math.round(b[4] * sz), Math.round(b[5] * sz)],
        d.muzzle ? [d.muzzle[0] * sx, d.muzzle[1] * sy, d.muzzle[2] * sz] : null);
    });
    (m.engines || []).forEach(function (e, k) {
      var r = Math.ceil(e.r + 1.5);
      add({ key: 'eng' + k, name: '引擎 ' + (k + 1), kind: 'engine', dead: 0.5, engine: k },
        [Math.floor(e.x) - 1, Math.floor(e.x) + 12, Math.floor(e.y - r), Math.ceil(e.y + r), Math.floor(e.z - r), Math.ceil(e.z + r)]);
    });
    MODEL = { dims: [nx, ny, nz], grid: grid, count: m.count, parts: parts, partOf: partOf, engines: (m.engines || []).slice(), src: m };
    return MODEL;
  }

  function Vox(m) {
    this.m = m; this.grid = m.grid.slice(); this.count = m.count; this.left = []; this.ok = [];
    for (var i = 0; i < m.parts.length; i++) { this.left.push(m.parts[i].total); this.ok.push(true); }
    this.rc = { dims: m.dims, grid: this.grid };          // 給 BH.Ship.raycast 用
  }
  Vox.prototype.integrity = function (i) { var t = this.m.parts[i].total; return t > 0 ? this.left[i] / t : 1; };
  // 把球（中心 c、半徑 R，單位：格）裡的格子拿掉；拿掉的格子編號接在 out 後面
  function carveSphere(v, c, R, out) {
    var m = v.m, nx = m.dims[0], ny = m.dims[1], nz = m.dims[2], g = v.grid, R2 = R * R;
    var x0 = Math.max(0, Math.floor(c[0] - R)), x1 = Math.min(nx - 1, Math.ceil(c[0] + R));
    var y0 = Math.max(0, Math.floor(c[1] - R)), y1 = Math.min(ny - 1, Math.ceil(c[1] + R));
    var z0 = Math.max(0, Math.floor(c[2] - R)), z1 = Math.min(nz - 1, Math.ceil(c[2] + R));
    for (var z = z0; z <= z1; z++) for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      var dx = x + 0.5 - c[0], dy = y + 0.5 - c[1], dz = z + 0.5 - c[2];
      if (dx * dx + dy * dy + dz * dz > R2) continue;
      var idx = x + nx * (y + ny * z);
      if (!g[idx]) continue;
      g[idx] = 0; v.count--;
      var pid = m.partOf[idx];
      if (pid) v.left[pid - 1]--;
      out.push(idx);
    }
  }
  // 沿著 dir 從 pos 往裡鑽一條半徑 r、深 depth 的洞
  function carveTunnel(v, pos, dir, r, depth, out) {
    for (var k = 0; k <= depth; k += 0.8) carveSphere(v, [pos[0] + dir[0] * k, pos[1] + dir[1] * k, pos[2] + dir[2] * k], r, out);
  }
  function turnToward(sh, want, maxAng) {
    var ang = Math.acos(clamp(dot3(sh.fwd, want), -1, 1));
    if (ang > 1e-4) {
      var ax = cross(sh.fwd, want);
      if (len(ax) < 1e-6) ax = sh.up;
      ax = norm(ax);
      var a = Math.min(ang, maxAng);
      sh.fwd = G.rotate(sh.fwd, ax, a); sh.up = G.rotate(sh.up, ax, a);
      reorth(sh);
      ang -= a;
    }
    return ang;
  }
  function reorth(sh) {
    sh.fwd = norm(sh.fwd);
    var d = dot3(sh.up, sh.fwd);
    sh.up = norm([sh.up[0] - d * sh.fwd[0], sh.up[1] - d * sh.fwd[1], sh.up[2] - d * sh.fwd[2]]);
  }
  function lerp3(a, b, w) { return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]; }

  // ── 一場戰鬥 ────────────────────────────────────────
  /* o.seed    亂數種子
   * o.cfg     蓋掉 CFG 裡的值（一層：{ laser: { gap: 1 } } 只改那一格）
   * o.model   飛船模型（沒給 ＝ 上一次 setModel 的那個）
   * o.empty   true ⇒ 不放玩家、不出敵機（自我測試自己擺） */
  function World(holes, o) {
    o = o || {};
    this.holes = holes;
    this.cfg = cfgCopy(o.cfg);
    this.model = o.model || MODEL;
    if (!this.model) throw new Error('戰鬥模式要先給飛船模型（BH.World.setModel）');
    this.kv = this.cfg.shipLen / this.model.dims[0];           // 一格多長（rs）
    this.wall = this.cfg.wallR > 0 ? { R: this.cfg.wallR, k: this.cfg.wallK } : null;
    this.rand = G.rng(o.seed || 20261113);
    this.t = 0; this.tau = 0;
    this.ships = []; this.shots = []; this.missiles = []; this.events = [];
    this.wave = 0; this.score = 0; this.kills = 0;
    this.stats = { laser: { shots: 0, hits: 0 }, kinetic: { shots: 0, hits: 0 }, missile: { shots: 0, hits: 0 }, enemy: { shots: 0, hits: 0 } };      // 前三個是玩家各種武器的，最後一個是敵機全部加起來
    this.state = 'play'; this.reason = ''; this.crossed = false;
    this.waveAt = null; this.energy = this.cfg.energyMax; this.reloadAt = 0; this.nextId = 1;
    this.player = null;
    if (!o.empty) {
      var ob = G.orbit(holes, 9, 0.6, 0.38, 1, -4, 0);        // 軌道面斜一點：從吸積盤上方掠過，不是泡在氣體裡
      this.player = this.addShip('player', ob.s, null, null, { tau: 0, hist: ob.tr, loadout: 'LKM' });
      this.waveAt = 1.5;
    }
  }

  World.prototype.addShip = function (team, s, fwd, up, o) {
    o = o || {};
    var hole = this.holes[0].pos, u = G.velocity4(this.holes, s), lo = o.loadout || 'L', c0 = o.cool != null ? o.cool : 1.5;
    var f = G.frameFromVel([s[0], s[1], s[2]], [u[0], u[1], u[2]], hole);
    var sh = {
      id: this.nextId++, team: team, s: Float64Array.from(s), tau: o.tau || 0, fwd: fwd ? norm(fwd) : f.fwd, up: up ? norm(up) : f.up,
      alive: true, thr: 0, flash: 0, prev: [s[0], s[1], s[2]], tDeath: null,
      vox: new Vox(this.model), engMask: (1 << this.model.engines.length) - 1, thrust: 1, tough: team === 'player' ? this.cfg.playerTough : 1,
      loadout: { laser: lo.indexOf('L') >= 0, kinetic: lo.indexOf('K') >= 0, missile: lo.indexOf('M') >= 0 },
      cool: { laser: c0, kinetic: c0 + 1, missile: c0 + 3 }, stock: this.cfg.missile.stock, barrel: { laser: 0, kinetic: 0, missile: 0 },
      ai: { rHome: o.rHome != null ? o.rHome : G.radius(this.holes, s), burn: false, jinkAt: null, jinkDir: null, jit: [0, 0, 0] },
      fc: null, fcT: -1e9,
      hist: o.hist ? G.histFromTrace(o.hist, hole) : G.histNew()
    };
    if (fwd || up) reorth(sh);
    G.histPush(this.holes, sh.hist, sh);
    this.ships.push(sh);
    return sh;
  };

  // 模型座標 ↔ 世界座標（船是剛體：座標裡的格子大小固定是 kv）
  World.prototype.toModel = function (sh, d) {
    var m = this.model.dims, side = cross(sh.up, sh.fwd), kv = this.kv;
    return [dot3(d, sh.fwd) / kv + m[0] / 2, dot3(d, side) / kv + m[1] / 2, dot3(d, sh.up) / kv + m[2] / 2];
  };
  World.prototype.toModelDir = function (sh, d) {
    var side = cross(sh.up, sh.fwd), kv = this.kv;
    return [dot3(d, sh.fwd) / kv, dot3(d, side) / kv, dot3(d, sh.up) / kv];
  };
  World.prototype.fromModel = function (sh, q) {
    var m = this.model.dims, side = cross(sh.up, sh.fwd), kv = this.kv, a = (q[0] - m[0] / 2) * kv, b = (q[1] - m[1] / 2) * kv, c = (q[2] - m[2] / 2) * kv;
    return [sh.s[0] + sh.fwd[0] * a + side[0] * b + sh.up[0] * c, sh.s[1] + sh.fwd[1] * a + side[1] * b + sh.up[1] * c, sh.s[2] + sh.fwd[2] * a + side[2] * b + sh.up[2] * c];
  };

  // 這艘船這一種武器還能用的部位
  World.prototype.usable = function (sh, kind) {
    var out = [], parts = this.model.parts;
    if (!sh.loadout[kind]) return out;
    for (var i = 0; i < parts.length; i++) if (parts[i].kind === kind && sh.vox.ok[i]) out.push(parts[i]);
    return out;
  };
  // 給介面看的：每個部位剩多少、壞了沒
  World.prototype.status = function (sh) {
    var parts = this.model.parts, out = [];
    for (var i = 0; i < parts.length; i++) out.push({ key: parts[i].key, name: parts[i].name, kind: parts[i].kind, ok: sh.vox.ok[i], left: sh.vox.integrity(i), dead: parts[i].dead * sh.tough });
    return out;
  };

  // 玩家轉向（弧度）：yaw 正 ＝ 機頭往右、pitch 正 ＝ 機頭往上、roll 正 ＝ 往右滾
  World.prototype.rotatePlayer = function (yaw, pitch, roll) {
    var p = this.player;
    if (!p || !p.alive) return;
    if (yaw) p.fwd = G.rotate(p.fwd, p.up, -yaw);
    if (pitch) { var right = cross(p.fwd, p.up); p.fwd = G.rotate(p.fwd, right, pitch); p.up = G.rotate(p.up, right, pitch); }
    if (roll) p.up = G.rotate(p.up, p.fwd, roll);
    reorth(p);
  };

  // 觀察者在 obs、此刻 tNow，看到的是 hist 這個東西哪一刻的樣子（光走直線估）；光還沒到 ⇒ null
  World.prototype.retarded = function (hist, obs, tNow) {
    if (!hist.n) return null;
    var te = Math.min(tNow, hist.T[hist.n - 1]), q;
    for (var i = 0; i < 40; i++) {
      q = P.sampleAt(hist, te);
      var t2 = Math.min(hist.T[hist.n - 1], tNow - Math.hypot(q.x - obs[0], q.y - obs[1], q.z - obs[2]));
      if (Math.abs(t2 - te) < 1e-10) { te = t2; break; }
      te = t2;
    }
    if (te < hist.T[0]) return null;
    return P.sampleAt(hist, te);
  };

  /* 射控：sh 對 target 的射擊解。從「sh 看到 target 的那一刻」的位置與動量，當成它之後不開引擎往後推，
   * 再解雷射與動能各自該把機頭指到哪（光會彎、彈丸彎得更多、兩邊都在動）。
   * 它在那之後如果改了軌道，這個解就是錯的 —— 那個資訊還沒傳過來，誰都算不出來。 */
  World.prototype.fireControl = function (sh, target, iters) {
    var cfg = this.cfg, holes = this.holes, pos = [sh.s[0], sh.s[1], sh.s[2]];
    var seen = this.retarded(target.hist, pos, this.t);
    if (!seen) return null;
    var sp = [seen.x, seen.y, seen.z], dist = len(sub(sp, pos)), lag = this.t - seen.t;
    var fc = { target: target, seen: seen, seenPos: sp, dist: dist, lag: lag, t: this.t, visible: G.segNear(pos, sp, holes[0].pos) > 2.7 * holes[0].rs, laser: null, kinetic: null, missile: null };
    var needL = this.usable(sh, 'laser').length > 0 && dist < cfg.laser.range, needK = this.usable(sh, 'kinetic').length > 0 && dist < 0.6 * cfg.kinetic.solveRange;
    if (needL || needK) {
      var pred = G.coast(holes, seen, lag + cfg.kinetic.solveRange + 2);
      if (needL) fc.laser = G.solveShot(holes, sh.s, pred, { speed: 1, range: cfg.laser.range, tol: cfg.aimTol, iters: iters });
      if (needK) fc.kinetic = G.solveShot(holes, sh.s, pred, { speed: cfg.kinetic.speed, range: cfg.kinetic.solveRange, tol: cfg.aimTol, iters: iters });
    }
    if (this.usable(sh, 'missile').length > 0 && sh.stock > 0) {
      // 飛彈追不上正在快速遠離的目標（它的引擎就那麼多）：距離在範圍內、看得到、而且沒有在快速拉遠，才值得發
      var u = G.velocity4(holes, sh.s), rate = ((seen.ux / seen.ut - u[0] / u[3]) * (sp[0] - pos[0]) + (seen.uy / seen.ut - u[1] / u[3]) * (sp[1] - pos[1]) + (seen.uz / seen.ut - u[2] / u[3]) * (sp[2] - pos[2])) / Math.max(dist, 1e-9);
      fc.missile = { ok: dist >= cfg.missile.minRange && dist <= cfg.missile.maxRange && fc.visible && (rate < 0.12 || dist < 5), rate: rate };
    }
    return fc;
  };
  // 玩家的目標：看到的最近那一艘還活著的敵機
  World.prototype.pickTarget = function () {
    var pl = this.player, best = null, bd = Infinity;
    if (!pl) return null;
    for (var i = 0; i < this.ships.length; i++) {
      var sh = this.ships[i];
      if (sh.team === pl.team || !sh.alive) continue;
      var q = this.retarded(sh.hist, pl.s, this.t);
      if (!q) continue;
      var d = Math.hypot(q.x - pl.s[0], q.y - pl.s[1], q.z - pl.s[2]);
      if (d < bd) { bd = d; best = sh; }
    }
    return best;
  };
  // 介面每秒叫幾次：重算玩家的射控
  World.prototype.updatePlayerFC = function () {
    var pl = this.player, tg = pl && pl.alive ? this.pickTarget() : null;
    if (pl) pl.fc = tg ? this.fireControl(pl, tg) : null;
    return pl ? pl.fc : null;
  };

  // 開火。回傳射出去的東西（沒射成 ⇒ null：部位壞了、還在冷卻、沒能量、沒彈、沒目標）
  World.prototype.fire = function (sh, kind) {
    var cfg = this.cfg, w = cfg[kind], holes = this.holes, parts = this.usable(sh, kind), isP = sh === this.player;
    if (!parts.length || sh.cool[kind] > 0) return null;
    if (kind === 'missile' && sh.stock <= 0) return null;
    if (isP && w.cost && this.energy < w.cost) return null;
    var tg = null;
    if (kind === 'missile') { tg = isP ? (sh.fc ? sh.fc.target : null) : this.player; if (!tg || !tg.alive) return null; }
    var part = parts[(sh.barrel[kind]++) % parts.length];
    var st = G.launch(holes, sh.s, sh.fwd, kind === 'laser' ? 1 : w.speed, this.fromModel(sh, part.muzzle));
    if (!st) return null;
    var out;
    if (kind === 'missile') {
      out = { id: this.nextId++, kind: kind, team: sh.team, owner: sh, target: tg, s: st, tau: 0, fuel: w.burn, tEnd: this.t + w.life, alive: true, tDeath: null,
        thr: 1, flash: 0, fwd: sh.fwd.slice(), up: sh.up.slice(), prev: [st[0], st[1], st[2]], hist: G.histNew() };
      G.histPush(holes, out.hist, out);
      this.missiles.push(out); sh.stock--;
      this.events.push({ type: 'missile', missile: out });
    } else {
      var tr = P.trace(holes, st, { tSpan: w.range, rMax: 400, frac: 0.012, maxSteps: kind === 'laser' ? 8000 : 30000 });
      if (tr.n < 2) return null;
      out = { id: this.nextId++, kind: kind, team: sh.team, owner: sh, tr: tr, dead: false, tHit: null };
      this.shots.push(out);
      this.events.push({ type: 'shot', shot: out });
    }
    sh.cool[kind] = isP ? w.gap : cfg.enemyGap[kind] * (0.8 + 0.4 * this.rand());
    if (isP) { if (w.cost) this.energy -= w.cost; this.stats[kind].shots++; } else this.stats.enemy.shots++;
    return out;
  };

  /* 這一格的時間裡，一個東西從 A0 走到 A1、船從 p0 走到 p1：有沒有碰到船身的格子。
   * 先用外接球粗篩；再把相對運動換進船的模型座標，沿線走格子，第一個非空格就是碰到的地方。
   * 回傳 { s（這一段的哪裡）, pos（模型座標）, dir（模型座標裡的單位方向）}；沒碰到（包括從洞裡穿過去）⇒ null。 */
  World.prototype.rayHit = function (sh, A0, A1, p0, p1) {
    if (G.closest(A0, A1, p0, p1).d > 0.62 * this.cfg.shipLen) return null;
    var o = this.toModel(sh, sub(A0, p0)), dv = this.toModelDir(sh, sub(sub(A1, A0), sub(p1, p0)));
    var h = ShipLib.raycast(sh.vox.rc, o, dv, 1);
    if (!h) return null;
    var L = len(dv) || 1;
    return { s: h.s, pos: [o[0] + dv[0] * h.s, o[1] + dv[1] * h.s, o[2] + dv[2] * h.s], dir: [dv[0] / L, dv[1] / L, dv[2] / L] };
  };

  // 打中：照武器種類把格子拿掉，再看哪些部位因此壞了
  World.prototype.strike = function (sh, kind, hit, size, t, by) {
    var cfg = this.cfg, out = [];
    if (kind === 'laser') carveTunnel(sh.vox, hit.pos, hit.dir, cfg.laser.radius, cfg.laser.depth, out);
    else if (kind === 'kinetic') carveSphere(sh.vox, [hit.pos[0] + hit.dir[0] * 0.5 * size, hit.pos[1] + hit.dir[1] * 0.5 * size, hit.pos[2] + hit.dir[2] * 0.5 * size], size, out);
    else carveSphere(sh.vox, hit.pos, cfg.missile.blast, out);
    sh.flash = 1;
    if (by && by.team === 'player') this.stats[kind].hits++; else if (by && by.team === 'enemy') this.stats.enemy.hits++;
    this.events.push({ type: 'hit', ship: sh, kind: kind, t: t, cells: Int32Array.from(out), by: by ? by.team : null, src: by || null, size: size });
    this.assess(sh, t, by);
  };
  World.prototype.assess = function (sh, t, by) {
    var parts = this.model.parts, v = sh.vox, i, p, eng = 0, engAll = 0, core = false, arms = 0;
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      if (v.ok[i] && v.integrity(i) < p.dead * sh.tough) {
        v.ok[i] = false;
        if (p.kind === 'engine') sh.engMask &= ~(1 << p.engine);
        this.events.push({ type: 'part', ship: sh, part: p, t: t });
      }
      if (p.kind === 'engine') { engAll++; if (v.ok[i]) eng++; }
      else if (p.kind === 'core') { if (!v.ok[i]) core = true; }
      else if (v.ok[i] && sh.loadout[p.kind]) arms++;
    }
    sh.thrust = engAll ? eng / engAll : 1;
    if (!sh.alive) return;
    if (core) this.kill(sh, 'core', by);
    else if (v.count / this.model.count < this.cfg.hullDead * sh.tough) this.kill(sh, 'hull', by);
    else if (arms === 0) this.kill(sh, 'disarmed', by);
  };
  // 修回原樣（清完一波的時候）
  World.prototype.repair = function (sh) {
    sh.vox = new Vox(this.model); sh.engMask = (1 << this.model.engines.length) - 1; sh.thrust = 1; sh.stock = this.cfg.missile.stock;
    this.events.push({ type: 'repair', ship: sh });
  };

  World.prototype.spawnWave = function () {
    var cfg = this.cfg, list = cfg.waves[this.wave - 1], pl = this.player, c = this.holes[0].pos;
    var phiP = pl ? Math.atan2(pl.s[2] - c[2], pl.s[0] - c[0]) : 0;
    for (var i = 0; i < list.length; i++) {
      var r = 5.5 + 5.0 * this.rand();
      var phi = phiP + Math.PI * (0.55 + 0.9 * this.rand());          // 出在玩家的另一側（不會一出來就貼臉）
      var incl = (this.rand() - 0.5) * 0.9;
      var sense = ((i + this.wave) & 1) ? -1 : 1;                      // 一半逆著繞：每半圈迎面對上一次
      var ob = G.orbit(this.holes, r, phi, incl, sense, this.t - 70, this.t);
      if (!ob) continue;
      var e = this.addShip('enemy', ob.s, null, null, { tau: ob.tau, hist: ob.tr, rHome: r, cool: 2 + 3 * this.rand(), loadout: list[i] });
      e.ai.jinkAt = this.wave >= 3 ? this.t + 10 + 14 * this.rand() : null;
      e.fcT = this.t - cfg.enemyFC * this.rand();                      // 錯開各艘重算射控的時間
      this.events.push({ type: 'spawn', ship: e });
    }
  };

  // 一艘敵機這一格要做什麼：回傳 { dir, a }（推力），順便轉機頭、決定開不開火
  World.prototype.think = function (e, dTauE) {
    var cfg = this.cfg, holes = this.holes, pl = this.player, rs = holes[0].rs, k;
    var r = G.radius(holes, e.s), rWant = e.ai.rHome;
    // 玩家在黑洞另一側（或太遠）⇒ 換到不一樣高的軌道去繞；看得到、夠近 ⇒ 回自己原本的軌道
    if (e.fc && this.wave >= 2 && (!e.fc.visible || e.fc.dist > 0.8 * cfg.enemyRange)) rWant = clamp(cfg.chase * len(sub(e.fc.seenPos, holes[0].pos)), 5 * rs, 11 * rs);
    var st = G.steer(holes, e.s, { rTarget: r < 4.2 * rs ? Math.max(rWant, 6 * rs) : rWant });
    var dir = st.dir, a = 0;
    if (e.ai.burn) { if (st.mag < 0.012) e.ai.burn = false; } else if (st.mag > 0.04 || r < 4.2 * rs) e.ai.burn = true;
    if (e.ai.burn) a = cfg.enemyAccel * Math.min(1, st.mag / 0.05);
    // 第三波起偶爾閃一下（朝隨機方向推一小段），不然永遠是一條好猜的軌道
    if (e.ai.jinkAt !== null) {
      if (this.t >= e.ai.jinkAt && !e.ai.jinkDir) { e.ai.jinkDir = norm([this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5]); e.ai.jinkEnd = this.t + 1.8; }
      if (e.ai.jinkDir) {
        if (this.t < e.ai.jinkEnd) { dir = e.ai.jinkDir; a = cfg.enemyAccel; }
        else { e.ai.jinkDir = null; e.ai.jinkAt = this.t + 14 + 12 * this.rand(); }
      }
    }
    a *= e.thrust;
    for (k = 0; k < WEAPONS.length; k++) e.cool[WEAPONS[k]] -= dTauE;
    // 射控隔一小段時間重算一次；每次帶一點瞄準誤差
    if (pl && pl.alive && !st.inside) {
      if (this.t - e.fcT > cfg.enemyFC) {
        e.fcT = this.t;
        e.fc = this.fireControl(e, pl, 3);
        e.ai.jit = [(this.rand() - 0.5) * 2 * cfg.enemySpread, (this.rand() - 0.5) * 2 * cfg.enemySpread, (this.rand() - 0.5) * 2 * cfg.enemySpread];
      }
    } else e.fc = null;
    var fc = e.fc, want = null, pick = null;
    if (fc && fc.dist < cfg.enemyRange) {
      if (fc.kinetic && fc.kinetic.ok && e.cool.kinetic <= 0.5 && fc.dist < 0.75 * cfg.enemyRange) pick = 'kinetic';
      else if (fc.laser && fc.laser.ok) pick = 'laser';
      else if (fc.kinetic && fc.kinetic.ok) pick = 'kinetic';
      if (pick) want = norm([fc[pick].nose[0] + e.ai.jit[0], fc[pick].nose[1] + e.ai.jit[1], fc[pick].nose[2] + e.ai.jit[2]]);
    }
    if (!want) { var u = G.velocity4(holes, e.s); want = norm([u[0], u[1], u[2]]); }
    if (len(want) < 0.5) want = e.fwd;                                 // 沒在動（沒有「飛行方向」）⇒ 機頭維持原樣
    var ang = turnToward(e, want, cfg.enemyTurn * dTauE);
    if (pick && ang < 0.02 && e.cool[pick] <= 0) this.fire(e, pick);
    if (fc && fc.missile && fc.missile.ok && e.cool.missile <= 0) this.fire(e, 'missile');
    e.thr = a > 0 ? clamp(dot3(dir, e.fwd), 0, 1) * a / cfg.enemyAccel : 0;
    return { dir: dir, a: a };
  };

  /* 飛彈這一格往哪推。它看到的目標也是光行時間之前的樣子。
   * 每隔一小段時間做一次預測（planMissile）：自己不再推的話會走的路、目標不再推的話會走的路（都是測地線，會被黑洞彎），
   * 找出兩條路在同一個時刻最接近的地方，差多少（m）、還有多久（tgo）。這一格就朝那個差距推：等加速度補 m 要 2m/tgo²。
   * 差距已經很小就不推（省燃料，留著最後修）。沒燃料或看不到目標就滑行。 */
  World.prototype.guide = function (ms) {
    var w = this.cfg.missile, u = G.velocity4(this.holes, ms.s), coastDir = norm([u[0], u[1], u[2]]), tg = ms.target;
    if (ms.fuel <= 0 || !tg || !tg.alive) return { dir: coastDir, a: 0 };
    if (!ms.plan || this.t - ms.plan.t > (ms.plan.tStar - ms.plan.t < 3 ? 0.08 : 0.3)) ms.plan = this.planMissile(ms);
    var pl = ms.plan;
    if (!pl) return { dir: coastDir, a: 0 };
    // 2m/tgo² 是座標裡要的加速度；飛彈自己很快的時候，同樣的固有加速度在座標裡只剩 1/γ² ⇒ 乘回去
    var tgo = Math.max(pl.tStar - this.t, 0.25), k = 2 * u[3] * u[3] / (tgo * tgo);
    var cmd = [pl.m[0] * k + pl.push[0], pl.m[1] * k + pl.push[1], pl.m[2] * k + pl.push[2]], cm = len(cmd);
    if (cm < 0.08 * w.accel) return { dir: coastDir, a: 0 };
    return { dir: [cmd[0] / cm, cmd[1] / cm, cmd[2] / cm], a: Math.min(w.accel, cm) };
  };
  World.prototype.planMissile = function (ms) {
    var w = this.cfg.missile, holes = this.holes, c = holes[0].pos, rs = holes[0].rs, tg = ms.target, pos = [ms.s[0], ms.s[1], ms.s[2]], i;
    var seen = this.retarded(tg.hist, pos, this.t);
    if (!seen) return null;
    var span = Math.max(1, Math.min(45, ms.tEnd - this.t + 1));
    var tgTr = G.coast(holes, seen, (this.t - seen.t) + span + 1);
    var my = P.trace(holes, Float64Array.from(ms.s), { tSpan: span, rMax: 400, frac: 0.012, maxSteps: 20000 });
    function tgt(t) { var q = P.sampleAt(tgTr, t); return [q.x, q.y, q.z]; }
    // 要追的是「接下來第一次靠近」那一次，不是整段裡最近的那一次（繞一圈之後的事到時候再說）
    var dMin = Infinity, iMin = 0, rMin = Infinity, jMin = 0, dPrev = Infinity, falling = false;
    for (i = 0; i < my.n; i++) {
      var q = tgt(my.T[i]), d = Math.hypot(my.X[i] - q[0], my.Y[i] - q[1], my.Z[i] - q[2]);
      if (d < dPrev) { falling = true; dMin = d; iMin = i; }
      else if (falling) break;                                  // 開始變遠了：上一點就是第一次最接近
      else if (i === 0) { dMin = d; iMin = 0; }
      dPrev = d;
    }
    var tStar = my.T[iMin], best = dMin;
    for (i = Math.max(0, iMin - 1); i < Math.min(my.n - 1, iMin + 1); i++) {
      var cl = G.closest([my.X[i], my.Y[i], my.Z[i]], [my.X[i + 1], my.Y[i + 1], my.Z[i + 1]], tgt(my.T[i]), tgt(my.T[i + 1]));
      if (cl.d < best) { best = cl.d; tStar = my.T[i] + cl.w * (my.T[i + 1] - my.T[i]); }
    }
    var a = P.sampleAt(my, tStar), b = tgt(tStar), m = [b[0] - a.x, b[1] - a.y, b[2] - a.z], push = [0, 0, 0];
    // 自己照這樣飛，到最接近之前會不會擦過黑洞（或掉進去）：會的話往外推
    for (i = 0; i <= iMin; i++) { var rr = Math.hypot(my.X[i] - c[0], my.Y[i] - c[1], my.Z[i] - c[2]); if (rr < rMin) { rMin = rr; jMin = i; } }
    if (rMin < 2.6 * rs) {
      var away = norm([my.X[jMin] - c[0], my.Y[jMin] - c[1], my.Z[jMin] - c[2]]), kk = 2 * w.accel * (2.6 * rs - rMin) / (2.6 * rs);
      push = [away[0] * kk, away[1] * kk, away[2] * kk];
    }
    // 最接近的時刻就是現在（正在遠離）⇒ 直接朝目標推
    if (tStar - this.t < 0.3 && best > 0.3) { var mh = norm(m); push = [push[0] + mh[0] * w.accel, push[1] + mh[1] * w.accel, push[2] + mh[2] * w.accel]; }
    return { t: this.t, tStar: tStar, m: m, miss: best, push: push };
  };
  World.prototype.endMissile = function (ms, why) {
    if (!ms.alive) return;
    ms.alive = false; ms.tDeath = this.t; ms.thr = 0;
    G.histPush(this.holes, ms.hist, ms);
    this.events.push({ type: 'missileEnd', missile: ms, why: why });
  };

  /* 往前走 dTau（玩家的固有時）。inp：
   *   f, r, u    推力（船的座標：前、右、上），各 −1～1
   *   boost      加力
   *   assist     沒有手動推力時，自動把速度修成當地的圓軌道
   *   autoFly    自動飛行：自己維持軌道、靠近目標所在的半徑、把機頭轉到射擊解上（有手動推力時推力照手動的）
   *   manualAim  這一格玩家自己在轉機頭 ⇒ 自動飛行不搶
   *   fire, weapon  手動開火與用哪一種（'laser'｜'kinetic'｜'missile'）
   *   autoFire   自動開火：哪一種武器對準了、能射，就射 */
  World.prototype.step = function (dTau, inp) {
    if (this.state !== 'play' || !(dTau > 0)) return;
    inp = inp || {};
    var cfg = this.cfg, holes = this.holes, pl = this.player, hole = holes[0].pos, rs = holes[0].rs, tPrev = this.t, i, j, k, sh;
    for (i = 0; i < this.ships.length; i++) { sh = this.ships[i]; sh.prev = [sh.s[0], sh.s[1], sh.s[2]]; sh.flash = Math.max(0, sh.flash - 1.3 * dTau); }

    // 1. 玩家
    if (pl && pl.alive) {
      var dir = pl.fwd, a = 0, m = Math.hypot(inp.f || 0, inp.r || 0, inp.u || 0), boosting = false, pos = [pl.s[0], pl.s[1], pl.s[2]];
      var fc = pl.fc && this.t - pl.fc.t < 3 && pl.fc.target.alive ? pl.fc : null, stA;
      pl.thr = 0;
      if (m > 0.01) {
        var right = cross(pl.fwd, pl.up), f = inp.f || 0, rr = inp.r || 0, uu = inp.u || 0;
        dir = norm([pl.fwd[0] * f + right[0] * rr + pl.up[0] * uu, pl.fwd[1] * f + right[1] * rr + pl.up[1] * uu, pl.fwd[2] * f + right[2] * rr + pl.up[2] * uu]);
        boosting = !!inp.boost && this.energy > 1;
        a = cfg.accel * Math.min(1, m) * (boosting ? cfg.boost : 1);
        pl.thr = clamp(f, 0, 1) * (boosting ? 1.4 : 1);
      } else if (inp.autoFly) {
        // 目標在黑洞另一側或離得遠 ⇒ 換到低一點的軌道（繞得比較快）追過去；越近軌道越接近它的，4 rs 以內就待在同樣高的軌道
        var rT = clamp(len(sub(pos, hole)), 5 * rs, 14 * rs), rNow = len(sub(pos, hole));
        if (fc) { var rE = len(sub(fc.seenPos, hole)), far = fc.visible ? clamp((fc.dist - 4) / 6, 0, 1) : 1; rT = clamp((1 - (1 - cfg.chase) * far) * rE, 4.8 * rs, 12 * rs); }
        stA = G.steer(holes, pl.s, { rTarget: rNow < 4.2 * rs ? Math.max(rT, 6 * rs) : rT });
        if (stA.inside) { dir = stA.dir; a = cfg.accel; }
        else if (stA.mag > 0.004) { dir = stA.dir; a = cfg.accel * Math.min(1, stA.mag / 0.04); }
        pl.thr = a > 0 ? clamp(dot3(dir, pl.fwd), 0, 1) * a / cfg.accel : 0;
      } else if (inp.assist) {
        stA = G.steer(holes, pl.s, {});
        if (!stA.inside && stA.mag > 0.004) { dir = stA.dir; a = cfg.accel * Math.min(1, stA.mag / 0.04); pl.thr = clamp(dot3(dir, pl.fwd), 0, 1) * a / cfg.accel; }
      }
      a *= pl.thrust;
      if (pl.thrust <= 0) pl.thr = 0;
      if (inp.autoFly && !inp.manualAim && fc) {
        // 機頭轉向「接下來能射的那一種」的射擊解；都沒解就先對著看到的目標
        var pick = null;
        if (fc.kinetic && fc.kinetic.ok && pl.cool.kinetic <= 0.4 && this.energy >= cfg.kinetic.cost) pick = 'kinetic';
        else if (fc.laser && fc.laser.ok) pick = 'laser';
        else if (fc.kinetic && fc.kinetic.ok) pick = 'kinetic';
        turnToward(pl, pick ? fc[pick].nose : norm(sub(fc.seenPos, pos)), cfg.autoTurn * dTau);
      }
      var done = G.advanceTau(holes, pl.s, dTau, dir, a, this.wall);
      pl.tau += done;
      this.t = pl.s[3]; this.tau += dTau;
      var ri = pl.vox.integrity(0), rd = this.model.parts[0].dead * pl.tough;        // 反應爐受損 ⇒ 能量回得慢
      this.energy = clamp(this.energy + (boosting ? -cfg.boostCost : cfg.energyRegen * clamp((ri - rd) / (1 - rd), 0.2, 1)) * dTau, 0, cfg.energyMax);
      for (k = 0; k < WEAPONS.length; k++) pl.cool[WEAPONS[k]] -= dTau;
      if (pl.stock < cfg.missile.stock) { if (this.tau >= this.reloadAt) { pl.stock++; this.reloadAt = this.tau + cfg.missile.reload; } } else this.reloadAt = this.tau + cfg.missile.reload;
      if (inp.fire && inp.weapon) this.fire(pl, inp.weapon);
      if (inp.autoFire && fc) {
        for (k = 0; k < 2; k++) {
          var sol = fc[WEAPONS[k]];
          if (sol && sol.ok && Math.acos(clamp(dot3(pl.fwd, sol.nose), -1, 1)) < cfg[WEAPONS[k]].tol) this.fire(pl, WEAPONS[k]);
        }
        if (fc.missile && fc.missile.ok && Math.acos(clamp(dot3(pl.fwd, norm(sub(fc.seenPos, pos))), -1, 1)) < cfg.missile.cone) this.fire(pl, 'missile');
      }
    } else { this.t += dTau; this.tau += dTau; }
    var dtc = this.t - tPrev;

    // 2. 敵機：走到同一個座標時間（各自的鐘走多少由它們自己的位置與速度決定）
    for (i = 0; i < this.ships.length; i++) {
      sh = this.ships[i];
      if (sh.team !== 'enemy' || !sh.alive) continue;
      var ut = G.velocity4(holes, sh.s)[3], cmd = this.think(sh, dtc / Math.max(ut, 1e-6));
      sh.tau += G.advanceTo(holes, sh.s, this.t, cmd.dir, cmd.a, this.wall);
    }

    // 3. 飛彈：自己推、自己轉；碰到船身的格子就炸，擦身而過（很近）也炸
    for (i = this.missiles.length - 1; i >= 0; i--) {
      var ms = this.missiles[i];
      if (!ms.alive) { if (this.t > ms.tDeath + cfg.histKeep) this.missiles.splice(i, 1); continue; }
      ms.prev = [ms.s[0], ms.s[1], ms.s[2]];
      var g2 = this.guide(ms), dtm = G.advanceTo(holes, ms.s, this.t, g2.dir, g2.a, this.wall);
      ms.tau += dtm; ms.thr = g2.a > 0 ? 1 : 0; ms.fwd = g2.dir;
      if (g2.a > 0) ms.fuel -= dtm * g2.a / cfg.missile.accel;      // 燃料照出力算：全力推 burn 這麼久就用完
      var mp = [ms.s[0], ms.s[1], ms.s[2]];
      for (j = 0; j < this.ships.length && ms.alive; j++) {
        sh = this.ships[j];
        if (!sh.alive || sh.team === ms.team) continue;
        var sp1 = [sh.s[0], sh.s[1], sh.s[2]], hm = this.rayHit(sh, ms.prev, mp, sh.prev, sp1);
        if (!hm) {
          var cl = G.closest(ms.prev, mp, sh.prev, sp1);
          if (cl.d < cfg.missile.fuse && cl.w > 0.001 && cl.w < 0.999) {
            var rel = sub(lerp3(ms.prev, mp, cl.w), lerp3(sh.prev, sp1, cl.w));
            hm = { s: cl.w, pos: this.toModel(sh, rel), dir: norm(this.toModelDir(sh, sub(sub(mp, ms.prev), sub(sp1, sh.prev)))) };
          }
        }
        if (hm) { this.strike(sh, 'missile', hm, cfg.missile.blast, tPrev + hm.s * dtc, ms); this.endMissile(ms, 'hit'); }
      }
      if (!ms.alive) continue;
      var nm = P.nearest(holes, ms.s);
      if (nm.k >= 0 && nm.ratio < 1) this.endMissile(ms, 'eaten');
      else if (this.t > ms.tEnd) this.endMissile(ms, 'spent');
      else { G.histPush(holes, ms.hist, ms); G.histTrim(ms.hist, this.t - cfg.histKeep); }
    }

    // 4. 光彈與動能彈：這一格的時間裡各走一小段直線，看有沒有碰到對方的飛彈或船身
    for (i = this.shots.length - 1; i >= 0; i--) {
      var b = this.shots[i], tr = b.tr, ta = Math.max(tPrev, tr.T[0]), tb = Math.min(this.t, tr.T[tr.n - 1]);
      if (tb > ta && dtc > 0) {
        var a0 = P.sampleAt(tr, ta), a1 = P.sampleAt(tr, tb), wa = (ta - tPrev) / dtc, wb = (tb - tPrev) / dtc, A0 = [a0.x, a0.y, a0.z], A1 = [a1.x, a1.y, a1.z];
        for (j = 0; j < this.missiles.length && !b.dead; j++) {
          var mt = this.missiles[j];
          if (!mt.alive || mt.team === b.team) continue;
          var mq = [mt.s[0], mt.s[1], mt.s[2]], cm = G.closest(A0, A1, lerp3(mt.prev, mq, wa), lerp3(mt.prev, mq, wb));
          if (cm.d <= cfg.missile.guard) { b.dead = true; b.tHit = ta + cm.w * (tb - ta); this.endMissile(mt, 'intercept'); }
        }
        for (j = 0; j < this.ships.length && !b.dead; j++) {
          sh = this.ships[j];
          if (!sh.alive || sh.team === b.team) continue;
          var q1 = [sh.s[0], sh.s[1], sh.s[2]], hit = this.rayHit(sh, A0, A1, lerp3(sh.prev, q1, wa), lerp3(sh.prev, q1, wb));
          if (!hit) continue;
          b.dead = true; b.tHit = ta + hit.s * (tb - ta);
          var size = 0;
          if (b.kind === 'kinetic') {
            // 坑的大小看相對速度：γ 是「船看到這顆彈丸」的勞侖茲因子
            var smp = P.sampleAt(tr, b.tHit), gam = -P.dot(P.metricCov(holes, sh.s), [smp.ux, smp.uy, smp.uz, smp.ut], G.velocity4(holes, sh.s));
            size = clamp(cfg.kinetic.base + cfg.kinetic.gain * Math.cbrt(Math.max(0, gam - 1)), cfg.kinetic.base, cfg.kinetic.max);
          }
          this.strike(sh, b.kind, hit, size, b.tHit, b);
        }
      }
      if (b.dead || this.t >= tr.T[tr.n - 1]) this.shots.splice(i, 1);
    }

    // 5. 掉進去：穿過視界不算結束（玩家只記一筆），到奇異點才算
    for (i = 0; i < this.ships.length; i++) {
      sh = this.ships[i];
      if (!sh.alive) continue;
      var near = P.nearest(holes, sh.s);
      if (sh === pl && near.k >= 0 && near.ratio < 1 && !this.crossed) { this.crossed = true; this.events.push({ type: 'cross' }); }
      if (near.k >= 0 && near.ratio < 0.03) this.kill(sh, 'singularity', null);
    }

    // 6. 波次
    if (this.state === 'play' && this.waveAt !== null) {
      var alive = 0;
      for (i = 0; i < this.ships.length; i++) if (this.ships[i].team === 'enemy' && this.ships[i].alive) alive++;
      if (alive === 0) {
        if (this.waveAt < 0) {                                         // 剛清完
          this.waveAt = this.tau + cfg.waveGap;
          if (this.wave >= cfg.waves.length) { this.state = 'won'; this.reason = 'cleared'; this.events.push({ type: 'won' }); }
          else { if (pl && pl.alive) this.repair(pl); this.events.push({ type: 'waveClear', wave: this.wave }); }
        } else if (this.state === 'play' && this.tau >= this.waveAt) {
          this.wave++; this.waveAt = -1;
          this.spawnWave();
          this.events.push({ type: 'wave', wave: this.wave });
        }
      }
    }

    // 7. 歷史
    for (i = this.ships.length - 1; i >= 0; i--) {
      sh = this.ships[i];
      if (sh.alive) { G.histPush(holes, sh.hist, sh); G.histTrim(sh.hist, this.t - cfg.histKeep); }
      else if (this.t > sh.tDeath + cfg.histKeep) this.ships.splice(i, 1);     // 它最後的光也早就過去了
    }
  };

  // why：'core'（反應爐或駕駛艙壞了）｜'hull'（船身剩不到一半）｜'disarmed'（武器全壞）｜'singularity'
  World.prototype.kill = function (sh, why, by) {
    if (!sh.alive) return;
    sh.alive = false; sh.tDeath = this.t; sh.thr = 0;
    G.histPush(this.holes, sh.hist, sh);
    if (sh.team === 'enemy') {
      if (why !== 'singularity' && by && by.team === 'player') { this.kills++; this.score += 100 * Math.max(1, this.wave); }
      this.events.push({ type: 'kill', ship: sh, why: why });
    } else {
      this.state = 'dead'; this.reason = why;
      this.events.push({ type: 'dead', why: why });
    }
  };
  World.prototype.takeEvents = function () { var e = this.events; this.events = []; return e; };

  World.CFG = CFG; World.WEAPONS = WEAPONS; World.setModel = setModel; World.Vox = Vox; World.carveSphere = carveSphere; World.carveTunnel = carveTunnel;
  World.model = function () { return MODEL; };
  BH.World = World;
  if (node) module.exports = World;
})(typeof window !== 'undefined' ? window : globalThis);
