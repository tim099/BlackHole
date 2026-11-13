/* 黑洞模擬 —— 太空戰鬥模式的核心（不碰畫面、不碰網頁元件；瀏覽器與 node 共用）
 *
 * 這裡的東西全部走 physics.js 那一套度規，沒有另外一份「遊戲物理」：
 *   船      有質量的粒子。沒開引擎時走測地線（跟模擬模式的物體同一條）；開引擎 ＝ 加一個固有加速度 a：
 *           4-速度在「跟自己垂直、朝推力方向」的單位向量 e 上轉一個快度 a·dτ：u′ = cosh(a dτ) u + sinh(a dτ) e。
 *           平直空間裡一直往同一個方向推 ⇒ v = tanh(aτ)，永遠到不了光速；懸停要的推力就是 rs / (2r²√(1 − rs/r))。
 *   光彈    一顆光子：從船頭、照「船自己的靜止系裡機頭的方向」射出去（k = u + e），之後走零測地線 —— 會被黑洞彎。
 *   看到的  每艘船只知道對手「光傳到自己這裡的那一刻」的樣子（world.retarded）；射擊解也是從那一刻往後推的。
 *
 * 哪些是遊戲設定（不是物理）：加速度的大小、血量、光彈打到多近算命中、光彈飛多遠就散掉、敵機的行為、波次。
 * 船是剛體、不會被潮汐力扯碎；光彈打中算在座標時間的同一刻（沒有另外算固有距離）。
 */
(function (root) {
  'use strict';
  var node = typeof module !== 'undefined' && !!module.exports;
  var BH = root.BH = root.BH || {};
  var P = node ? require('./physics.js') : BH.Physics;

  var CFG = {
    shipLen: 0.5,        // 船長（rs）
    hitRadius: 0.27,     // 光彈離船心多近算打中（rs）
    accel: 0.03,         // 主引擎的固有加速度（c²/rs）；4.5 rs 以內光靠它已經懸停不住
    boost: 2.2,          // 加力：加速度乘幾倍
    boostCost: 10,       // 加力每單位固有時吃多少能量
    energyMax: 100, energyRegen: 7, boltCost: 9,
    fireGap: 0.55,       // 兩發之間至少隔多久（固有時）
    boltRange: 26,       // 光彈飛多久就散掉（座標時間）
    hullMax: 100, boltDmg: 34, enemyHp: 100, enemyDmg: 12, waveHeal: 25,
    enemyAccel: 0.022, enemyTurn: 0.55, enemyFireGap: 4.5, enemyRange: 13, enemySpread: 0.010,
    histKeep: 110,       // 每艘船留多久的歷史（座標時間）：要比「戰場上最遠的光行時間」長
    arenaWarn: 38, arena: 55,
    waves: [1, 2, 2, 3, 3],
    waveGap: 3           // 清完一波之後隔多久（固有時）來下一波
  };

  // ── 小工具 ──────────────────────────────────────────
  function len(v) { return Math.hypot(v[0], v[1], v[2]); }
  function norm(v) { var l = len(v); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  // 繞單位軸 k 轉 ang（右手）
  function rotate(v, k, ang) {
    var c = Math.cos(ang), s = Math.sin(ang), kv = cross(k, v), kd = dot3(k, v) * (1 - c);
    return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
  }
  function rng(seed) {       // mulberry32：同一個種子同一場
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  var _d = new Float64Array(8);
  function velocity4(holes, s) { P.rhs(holes, s, _d); return [_d[0], _d[1], _d[2], _d[3]]; }
  // 座標方向 d（3 維）→ 跟 4-速度 u 垂直的單位空間向量（u 那個觀察者的靜止系裡，d 指的方向）
  function orthU(g, u, d) {
    var v = [d[0], d[1], d[2], 0], c = P.dot(g, v, u);
    var o = [v[0] + c * u[0], v[1] + c * u[1], v[2] + c * u[2], v[3] + c * u[3]];
    var n = Math.sqrt(Math.abs(P.dot(g, o, o)));
    if (!(n > 1e-12)) return null;
    return [o[0] / n, o[1] / n, o[2] / n, o[3] / n];
  }
  function radius(holes, s) { var c = holes[0].pos; return Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]); }

  // ── 推進 ────────────────────────────────────────────
  // 朝座標方向 dir 給一個快度 dv（＝ 固有加速度 × 固有時）。動量四個分量一起轉，所以 g(u,u) = −1 不會跑掉
  function kick(holes, s, dir, dv) {
    var g = P.metricCov(holes, s), u = velocity4(holes, s), e = orthU(g, u, dir);
    if (!e) return;
    var pl = P.lower(g, e), ch = Math.cosh(dv), sh = Math.sinh(dv);
    s[4] = ch * s[4] + sh * pl[0]; s[5] = ch * s[5] + sh * pl[1]; s[6] = ch * s[6] + sh * pl[2]; s[7] = ch * s[7] + sh * pl[3];
  }
  // 一小步：半個推力、一步測地線、半個推力
  function substep(holes, s, h, dir, a) {
    if (a > 0) kick(holes, s, dir, 0.5 * a * h);
    P.rk4(holes, s, h);
    if (a > 0) kick(holes, s, dir, 0.5 * a * h);
  }
  // 走 dTau 的固有時。回傳實際走了多少（到奇異點附近會提早停）
  function advanceTau(holes, s, dTau, dir, a) {
    var rem = dTau, guard = 0;
    while (rem > 1e-12 && guard++ < 20000) {
      P.rhs(holes, s, _d);
      var h = Math.min(rem, 0.02, P.stepSize(holes, s, _d, 0.01));
      substep(holes, s, h, dir, a);
      rem -= h;
      var near = P.nearest(holes, s);
      if (near.k >= 0 && near.ratio < 0.02) break;
    }
    return dTau - rem;
  }
  // 走到座標時間 tTarget。回傳過了多少固有時
  function advanceTo(holes, s, tTarget, dir, a) {
    var tau = 0, guard = 0;
    while (guard++ < 20000) {
      P.rhs(holes, s, _d);
      var left = (tTarget - s[3]) / Math.max(_d[3], 1e-9);
      if (!(left > 1e-9)) break;
      var h = Math.min(left, 0.02, P.stepSize(holes, s, _d, 0.01));
      substep(holes, s, h, dir, a);
      tau += h;
      var near = P.nearest(holes, s);
      if (near.k >= 0 && near.ratio < 0.02) break;
    }
    return tau;
  }

  /* 當地懸停的人量到的速度，以及「要修成圓軌道該往哪推」。
   *   o.rTarget  想待在哪個半徑（沒給 ＝ 現在的半徑）
   *   o.prefer   沒有切向速度時往哪一邊繞（座標方向）
   * 回傳 dir（推力的座標方向）、mag（還差多少速度，單位 c）、v（現在的速度）、vr（徑向，往外為正）、vt（切向）、vc（當地圓軌道速度）。
   * 視界內沒有懸停的人 ⇒ inside = true、dir 朝外（沒有用，只是不讓呼叫的人拿到空的）。 */
  function steer(holes, s, o) {
    o = o || {};
    var h = holes[0], x = [s[0] - h.pos[0], s[1] - h.pos[1], s[2] - h.pos[2]], r = len(x), rhat = r > 1e-9 ? norm(x) : [1, 0, 0];
    var g = P.metricCov(holes, s), u0 = P.staticU(g), u = velocity4(holes, s), i;
    if (!u0) return { dir: rhat, mag: 1, v: null, vr: 0, vt: 0, vc: NaN, inside: true };
    var gam = -P.dot(g, u, u0), w = [], er = orthU(g, u0, rhat);
    for (i = 0; i < 4; i++) w.push(u[i] / gam - u0[i]);
    var wr = P.dot(g, w, er), wt = [], tp = null, q, n;
    for (i = 0; i < 4; i++) wt.push(w[i] - wr * er[i]);
    var vt = Math.sqrt(Math.max(0, P.dot(g, wt, wt)));
    function tangent(d) {
      var e = orthU(g, u0, d); if (!e) return null;
      var c = P.dot(g, e, er), t = [e[0] - c * er[0], e[1] - c * er[1], e[2] - c * er[2], e[3] - c * er[3]];
      var m = Math.sqrt(Math.max(0, P.dot(g, t, t)));
      return m > 0.05 ? [t[0] / m, t[1] / m, t[2] / m, t[3] / m] : null;
    }
    if (vt > 1e-3) tp = [wt[0] / vt, wt[1] / vt, wt[2] / vt, wt[3] / vt];
    if (!tp && o.prefer) tp = tangent(o.prefer);
    if (!tp) tp = tangent(cross([0, 1, 0], rhat)) || tangent([1, 0, 0]) || tangent([0, 0, 1]);
    var rT = o.rTarget != null ? o.rTarget : r;
    var vc = P.vCirc(Math.max(r, 1.6 * h.rs), h.rs);
    if (!(vc > 0)) vc = 0;                                  // 沒有黑洞 ⇒ 沒有圓軌道，目標就是停下來
    var vrWant = clamp((rT - r) * 0.03, -0.15, 0.15), D = [];
    for (i = 0; i < 4; i++) D.push(vc * tp[i] + vrWant * er[i] - w[i]);
    var mag = Math.sqrt(Math.max(0, P.dot(g, D, D)));
    return { dir: norm([D[0], D[1], D[2]]), mag: mag, v: Math.sqrt(Math.max(0, P.dot(g, w, w))), vr: wr, vt: vt, vc: vc, inside: false, rate: 1 / u[3] };
  }

  // ── 光彈 ────────────────────────────────────────────
  // 從船（狀態 s）照機頭方向 fwd 射出一顆光子：船自己的靜止系裡朝機頭 ⇒ k = u + e。offset ＝ 從船心往前多遠出膛
  function emit(holes, s, fwd, offset) {
    var g = P.metricCov(holes, s), u = velocity4(holes, s), e = orthU(g, u, fwd);
    if (!e) return null;
    var k = [u[0] + e[0], u[1] + e[1], u[2] + e[2], u[3] + e[3]], p = P.lower(g, k);
    var st = new Float64Array([s[0] + fwd[0] * (offset || 0), s[1] + fwd[1] * (offset || 0), s[2] + fwd[2] * (offset || 0), s[3], p[0], p[1], p[2], p[3]]);
    if (offset) P.normalizeMomentum(holes, st, 0);          // 換了位置，度規不一樣了：把 p_t 接回零測地線
    return st;
  }
  /* 想讓光子（在當地懸停的人看來）朝方向 n 飛，機頭要指哪裡？
   * 船在動 ⇒ 有光行差：機頭指的方向跟光實際飛的方向不一樣。回傳 { nose（座標方向）, e（船的靜止系裡的單位向量，4 維）}。
   * 視界內沒有懸停的人 ⇒ null。 */
  function noseFor(holes, s, n) {
    var ps = P.launch(holes, [s[0], s[1], s[2]], n, 1, 'light');
    if (!ps) return null;
    var k = P.raise(P.metricInv(holes, s), [ps[4], ps[5], ps[6], ps[7]]);
    var g = P.metricCov(holes, s), u = velocity4(holes, s), om = -P.dot(g, k, u), e = [], i;
    for (i = 0; i < 4; i++) e.push(k[i] / om - u[i]);
    var c = e[3] / u[3];
    return { nose: norm([e[0] - c * u[0], e[1] - c * u[1], e[2] - c * u[2]]), e: e };
  }
  // 把一個狀態（位置、時刻、動量）當成測地線往後推 span 這麼久（預測「它不再開引擎的話會到哪」）
  function coast(holes, st, span) {
    var s = new Float64Array([st.x, st.y, st.z, st.t, st.px, st.py, st.pz, st.pt]);
    return P.trace(holes, s, { tSpan: span, rMax: 200, frac: 0.012, maxSteps: 40000, tau0: st.tau || 0 });
  }
  /* 射擊解：從 s（射手的狀態）發一顆光子，要打中沿著 target（一條軌跡）走的東西，光子該朝哪個方向飛。
   * 先用直線估（光走直線、目標等速）當起點；再真的把光子沿零測地線追出去，看「同一個時刻光子離目標最近時差了多少」，
   * 對瞄準方向的兩個角度做高斯–牛頓法（差分求斜率），把那個差距壓到零。黑洞旁邊光彎得很兇，
   * 「差多少就把瞄準點挪多少」那種修法不收斂（試過：差 5.4 rs 修四次還差 3.7）。
   * 回傳 { n（當地懸停的人看到的光的方向）, miss（最近距離）, tHit, tr（那顆光子的軌跡）, ok, iters }；視界內 ⇒ null。
   * o.flat = true ⇒ 只做直線估（反向對照用：有黑洞時它會打不中）。 */
  function solveAim(holes, s, target, o) {
    o = o || {};
    var x0 = [s[0], s[1], s[2]], t0 = s[3], range = o.range || CFG.boltRange, hitR = o.hitRadius || CFG.hitRadius;
    function tgt(t) { var q = P.sampleAt(target, t); return [q.x, q.y, q.z]; }
    var aim = tgt(t0), k, i;
    for (k = 0; k < 4; k++) aim = tgt(t0 + len([aim[0] - x0[0], aim[1] - x0[1], aim[2] - x0[2]]));
    var n0 = norm([aim[0] - x0[0], aim[1] - x0[1], aim[2] - x0[2]]);
    var ea = norm(cross(n0, Math.abs(n0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), eb = cross(n0, ea);
    function shoot(th) {
      var n = norm([n0[0] + th[0] * ea[0] + th[1] * eb[0], n0[1] + th[0] * ea[1] + th[1] * eb[1], n0[2] + th[0] * ea[2] + th[1] * eb[2]]);
      var ps = P.launch(holes, x0, n, 1, 'light');
      if (!ps) return null;
      ps[3] = t0;
      var tr = P.trace(holes, ps, { tSpan: range, rMax: 200, frac: 0.012, maxSteps: 8000 });
      // 同一個時刻光子與目標的距離，找最小的那一段，再在那一段裡用相對直線運動解最近點
      var dMin = Infinity, iMin = 0;
      for (i = 0; i < tr.n; i++) {
        var q = tgt(tr.T[i]), d = Math.hypot(tr.X[i] - q[0], tr.Y[i] - q[1], tr.Z[i] - q[2]);
        if (d < dMin) { dMin = d; iMin = i; }
      }
      var res = { d: dMin, t: tr.T[iMin] };
      for (i = Math.max(0, iMin - 1); i < Math.min(tr.n - 1, iMin + 1); i++) {
        var c = closest([tr.X[i], tr.Y[i], tr.Z[i]], [tr.X[i + 1], tr.Y[i + 1], tr.Z[i + 1]], tgt(tr.T[i]), tgt(tr.T[i + 1]));
        if (c.d < res.d) res = { d: c.d, t: tr.T[i] + c.w * (tr.T[i + 1] - tr.T[i]) };
      }
      var ph = P.sampleAt(tr, res.t), tq = tgt(res.t);
      return { n: n, miss: res.d, m: [ph.x - tq[0], ph.y - tq[1], ph.z - tq[2]], tHit: res.t, tr: tr };
    }
    var th = [0, 0], cur = shoot(th), iters = 1;
    if (!cur) return null;
    for (k = 0; !o.flat && k < (o.iters || 6) && cur.miss > 0.02 * hitR; k++) {
      var h = 2e-3, f1 = shoot([th[0] + h, th[1]]), f2 = shoot([th[0], th[1] + h]);
      if (!f1 || !f2) break;
      var J1 = [(f1.m[0] - cur.m[0]) / h, (f1.m[1] - cur.m[1]) / h, (f1.m[2] - cur.m[2]) / h];
      var J2 = [(f2.m[0] - cur.m[0]) / h, (f2.m[1] - cur.m[1]) / h, (f2.m[2] - cur.m[2]) / h];
      var a11 = dot3(J1, J1), a12 = dot3(J1, J2), a22 = dot3(J2, J2), b1 = -dot3(J1, cur.m), b2 = -dot3(J2, cur.m);
      var det = a11 * a22 - a12 * a12;
      if (!(Math.abs(det) > 1e-12)) break;
      var dl = [(b1 * a22 - b2 * a12) / det, (a11 * b2 - a12 * b1) / det], dn = Math.hypot(dl[0], dl[1]);
      if (dn > 0.35) { dl[0] *= 0.35 / dn; dl[1] *= 0.35 / dn; }      // 一次最多挪 20° 左右
      var next = null, sc = 1;
      for (i = 0; i < 4; i++, sc *= 0.5) {                           // 沒變好就縮小步子再試
        var c2 = shoot([th[0] + dl[0] * sc, th[1] + dl[1] * sc]);
        if (c2 && c2.miss < cur.miss) { next = c2; th = [th[0] + dl[0] * sc, th[1] + dl[1] * sc]; break; }
      }
      iters++;
      if (!next) break;
      cur = next;
    }
    return { n: cur.n, miss: cur.miss, tHit: cur.tHit, tr: cur.tr, ok: cur.miss <= hitR, iters: iters };
  }
  // 兩個點各自等速直線（a0→a1、b0→b1，同一段時間）：最近的距離 d 與發生在這一段的哪裡 w ∈ [0, 1]
  function closest(a0, a1, b0, b1) {
    var d0 = [a0[0] - b0[0], a0[1] - b0[1], a0[2] - b0[2]];
    var dv = [a1[0] - a0[0] - (b1[0] - b0[0]), a1[1] - a0[1] - (b1[1] - b0[1]), a1[2] - a0[2] - (b1[2] - b0[2])];
    var vv = dot3(dv, dv), w = vv > 1e-18 ? clamp(-dot3(d0, dv) / vv, 0, 1) : 0;
    return { d: Math.hypot(d0[0] + dv[0] * w, d0[1] + dv[1] * w, d0[2] + dv[2] * w), w: w };
  }
  // 線段 a→b 離原點最近多遠（視線有沒有被黑洞擋住）
  function segNear(a, b, c) {
    var ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    var w = clamp(dot3(ac, ab) / Math.max(dot3(ab, ab), 1e-18), 0, 1);
    return Math.hypot(a[0] + ab[0] * w - c[0], a[1] + ab[1] * w - c[1], a[2] + ab[2] * w - c[2]);
  }

  // ── 攝影機 ──────────────────────────────────────────
  /* 跟著船走的攝影機：位置 pos、空間動量跟船一樣（p 是船的共變動量 [px, py, pz]），朝 fwd、上方 up。
   * 回傳的東西跟 BH.Camera.frame() 同一種，另外多給還沒降指標的標架 fr 與度規 g（投影標記用）。 */
  function cameraFrame(holes, pos, p, fwd, up) {
    var s = new Float64Array([pos[0], pos[1], pos[2], 0, p[0], p[1], p[2], 0]);
    P.normalizeMomentum(holes, s, -1);
    var g = P.metricCov(holes, s), u = velocity4(holes, s), fr = P.frame(g, u, fwd, up);
    var near = P.nearest(holes, s), us = P.staticU(g), v = null;
    if (us) { var gam = -P.dot(g, u, us); v = Math.sqrt(Math.max(0, 1 - 1 / (gam * gam))); }
    var c = holes[0].pos;
    return {
      pos: pos.slice(), fwd: fwd.slice(), g: g, fr: fr, u: u,
      P: [P.lower(g, fr.e0), P.lower(g, fr.e1), P.lower(g, fr.e2), P.lower(g, fr.e3)],
      r: Math.hypot(pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]), ratio: near.k < 0 ? Infinity : near.ratio,
      insideHorizon: near.k >= 0 && near.ratio < 1, nearHorizon: near.k >= 0 && near.ratio < 1.012, v: v, rate: 1 / u[3]
    };
  }
  /* 從世界上某一點 src 直線飛到攝影機的光，會出現在畫面的哪裡。
   * 回傳 [x, y, z]：畫面座標 x／z、y／z（乘上 1/tan(視角/2) 就是 −1～1），z ≤ 0 ＝ 在背後。
   * 有算光行差（攝影機在動），沒有算光被黑洞彎 —— 視線貼近黑洞時標記會跟畫面上的像對不上，呼叫的人要自己判斷。
   * 視界內 ⇒ null。 */
  function project(holes, cf, src) {
    var n = norm([cf.pos[0] - src[0], cf.pos[1] - src[1], cf.pos[2] - src[2]]);
    var ps = P.launch(holes, cf.pos, n, 1, 'light');
    if (!ps) return null;
    var k = [ps[4], ps[5], ps[6], ps[7]];
    function comp(e) { return k[0] * e[0] + k[1] * e[1] + k[2] * e[2] + k[3] * e[3]; }
    var om = -comp(cf.fr.e0);
    return [-comp(cf.fr.e1) / om, -comp(cf.fr.e2) / om, -comp(cf.fr.e3) / om];
  }
  // 船的靜止系裡的方向 e（4 維，noseFor 給的）在攝影機標架裡的三個分量：把準星移到那裡，射出去的光就朝 e
  function projectDir(cf, e) { return [P.dot(cf.g, e, cf.fr.e1), P.dot(cf.g, e, cf.fr.e2), P.dot(cf.g, e, cf.fr.e3)]; }

  // ── 歷史（每艘船走過的路；欄位跟 P.trace 的回傳一樣，再加朝向）────
  var HK = ['T', 'X', 'Y', 'Z', 'UX', 'UY', 'UZ', 'UT', 'PX', 'PY', 'PZ', 'PT', 'TAU', 'FX', 'FY', 'FZ', 'TH', 'GX', 'GY', 'GZ', 'FL'];
  function histNew() {
    var h = { n: 0, fate: 'live', crossT: null, crossTau: null, crossHole: -1, rMin: Infinity, e: 1 };
    for (var i = 0; i < HK.length; i++) h[HK[i]] = [];
    return h;
  }
  function histPush(holes, h, sh) {
    var s = sh.s, u = velocity4(holes, s);
    var v = [s[3], s[0], s[1], s[2], u[0], u[1], u[2], u[3], s[4], s[5], s[6], s[7], sh.tau, sh.fwd[0], sh.fwd[1], sh.fwd[2], sh.thr, sh.up[0], sh.up[1], sh.up[2], sh.flash];
    var at = (h.n >= 2 && s[3] - h.T[h.n - 2] < 0.05) ? h.n - 1 : h.n;      // 太密就蓋掉最後一格，不一直長
    for (var i = 0; i < HK.length; i++) h[HK[i]][at] = v[i];
    h.n = at + 1;
  }
  function histTrim(h, tMin) {
    if (h.n < 16 || h.T[8] >= tMin) return;
    var i0 = 0;
    while (i0 < h.n - 2 && h.T[i0 + 1] < tMin) i0++;
    for (var i = 0; i < HK.length; i++) h[HK[i]] = h[HK[i]].slice(i0);
    h.n = h.T.length;
  }
  // 朝向：機頭朝飛行方向、上方 ＝ 軌道面法線（跟 js/ship.js 的 frame 同一個定義）
  function frameFromVel(pos, vel, hole) {
    var rel = [pos[0] - hole[0], pos[1] - hole[1], pos[2] - hole[2]];
    var fwd = len(vel) > 1e-6 ? norm(vel) : norm([-rel[0], -rel[1], -rel[2]]);
    var up = cross(rel, vel);
    if (len(up) < 1e-9) up = [0, 1, 0];
    up = norm(up);
    var d = dot3(up, fwd);
    up = [up[0] - d * fwd[0], up[1] - d * fwd[1], up[2] - d * fwd[2]];
    if (len(up) < 1e-3) { up = Math.abs(fwd[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; d = dot3(up, fwd); up = [up[0] - d * fwd[0], up[1] - d * fwd[1], up[2] - d * fwd[2]]; }
    return { fwd: fwd, up: norm(up) };
  }
  function histFromTrace(tr, hole) {
    var h = histNew(), i;
    for (i = 0; i < 13; i++) h[HK[i]] = tr[HK[i]].slice();
    h.n = tr.n;
    for (i = 0; i < tr.n; i++) {
      var f = frameFromVel([tr.X[i], tr.Y[i], tr.Z[i]], [tr.UX[i], tr.UY[i], tr.UZ[i]], hole);
      h.FX.push(f.fwd[0]); h.FY.push(f.fwd[1]); h.FZ.push(f.fwd[2]); h.TH.push(0);
      h.GX.push(f.up[0]); h.GY.push(f.up[1]); h.GZ.push(f.up[2]); h.FL.push(0);
    }
    return h;
  }
  /* 赤道面附近的一條圓軌道：半徑 r、方位角 phi、傾角 incl、方向 sense（+1 順著吸積盤、−1 逆著）。
   * 從 tBirth 開始算到 tNow，回傳現在的狀態與這一段走過的路（給「光行時間之前」的樣子用）。 */
  function orbit(holes, r, phi, incl, sense, tBirth, tNow) {
    var c = holes[0].pos, cp = Math.cos(phi), sp = Math.sin(phi), ci = Math.cos(incl), si = Math.sin(incl);
    var ea = [cp, 0, sp], eb = [ci * sp, si, -ci * cp];
    var s = P.launchLocal(holes, [c[0] + r * cp, c[1], c[2] + r * sp], [-ea[0], -ea[1], -ea[2]], eb, sense * Math.PI / 2, P.vCirc(r, holes[0].rs), 'ball');
    if (!s) return null;
    s[3] = tBirth;
    var tr = P.trace(holes, s, { tSpan: Math.max(tNow - tBirth, 0.5), rMax: 400, frac: 0.012, maxSteps: 80000 });
    var n = tr.n - 1;
    return { s: new Float64Array([tr.X[n], tr.Y[n], tr.Z[n], tr.T[n], tr.PX[n], tr.PY[n], tr.PZ[n], tr.PT[n]]), tau: tr.TAU[n], tr: tr };
  }

  // ── 一場戰鬥 ────────────────────────────────────────
  /* o.seed    亂數種子
   * o.cfg     蓋掉 CFG 裡的值
   * o.empty   true ⇒ 不放玩家、不出敵機（自我測試自己擺） */
  function World(holes, o) {
    o = o || {};
    this.holes = holes;
    this.cfg = {};
    var k;
    for (k in CFG) this.cfg[k] = CFG[k];
    if (o.cfg) for (k in o.cfg) this.cfg[k] = o.cfg[k];
    this.rand = rng(o.seed || 20261113);
    this.t = 0; this.tau = 0;
    this.ships = []; this.bolts = []; this.events = [];
    this.wave = 0; this.score = 0; this.kills = 0; this.shots = 0; this.hits = 0;
    this.state = 'play'; this.reason = ''; this.crossed = false;
    this.waveAt = null; this.energy = this.cfg.energyMax; this.cool = 0; this.nextId = 1;
    this.player = null;
    if (!o.empty) {
      var ob = orbit(holes, 9, 0.6, 0.38, 1, -4, 0);      // 軌道面斜一點：從吸積盤上方掠過，不是泡在氣體裡
      this.player = this.addShip('player', ob.s, null, null, { hp: this.cfg.hullMax, tau: 0, hist: ob.tr });
      this.waveAt = 1.5;
    }
  }

  World.prototype.addShip = function (team, s, fwd, up, o) {
    o = o || {};
    var hole = this.holes[0].pos, u = velocity4(this.holes, s);
    var f = frameFromVel([s[0], s[1], s[2]], [u[0], u[1], u[2]], hole);
    var sh = {
      id: this.nextId++, team: team, s: Float64Array.from(s), tau: o.tau || 0, fwd: fwd ? norm(fwd) : f.fwd, up: up ? norm(up) : f.up,
      hp: o.hp != null ? o.hp : this.cfg.enemyHp, hpMax: o.hp != null ? o.hp : this.cfg.enemyHp, alive: true, thr: 0, flash: 0,
      cool: o.cool != null ? o.cool : 1.5, prev: [s[0], s[1], s[2]], tDeath: null,
      ai: { rHome: o.rHome != null ? o.rHome : radius(this.holes, s), burn: false, jinkAt: null, jinkDir: null, spread: [0, 0, 0] },
      hist: o.hist ? histFromTrace(o.hist, hole) : histNew()
    };
    if (fwd || up) reorth(sh);
    histPush(this.holes, sh.hist, sh);
    this.ships.push(sh);
    return sh;
  };
  function reorth(sh) {
    sh.fwd = norm(sh.fwd);
    var d = dot3(sh.up, sh.fwd);
    sh.up = norm([sh.up[0] - d * sh.fwd[0], sh.up[1] - d * sh.fwd[1], sh.up[2] - d * sh.fwd[2]]);
  }

  // 玩家轉向（弧度）：yaw 正 ＝ 機頭往右、pitch 正 ＝ 機頭往上、roll 正 ＝ 往右滾
  World.prototype.rotatePlayer = function (yaw, pitch, roll) {
    var p = this.player;
    if (!p || !p.alive) return;
    if (yaw) p.fwd = rotate(p.fwd, p.up, -yaw);
    if (pitch) { var right = cross(p.fwd, p.up); p.fwd = rotate(p.fwd, right, pitch); p.up = rotate(p.up, right, pitch); }
    if (roll) p.up = rotate(p.up, p.fwd, roll);
    reorth(p);
  };

  // 觀察者在 obs、此刻 tNow，看到的是 hist 這艘船哪一刻的樣子（光走直線估）；光還沒到 ⇒ null
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

  World.prototype.fire = function (sh) {
    var cfg = this.cfg, st = emit(this.holes, sh.s, sh.fwd, 0.55 * cfg.shipLen);
    if (!st) return null;
    var tr = P.trace(this.holes, st, { tSpan: cfg.boltRange, rMax: 200, frac: 0.012, maxSteps: 8000 });
    if (tr.n < 2) return null;
    var b = { id: this.nextId++, owner: sh, team: sh.team, tr: tr, dmg: sh.team === 'player' ? cfg.boltDmg : cfg.enemyDmg, dead: false, tHit: null };
    this.bolts.push(b);
    this.events.push({ type: 'bolt', bolt: b });
    return b;
  };

  World.prototype.spawnWave = function () {
    var cfg = this.cfg, n = cfg.waves[this.wave - 1], pl = this.player, c = this.holes[0].pos;
    var phiP = pl ? Math.atan2(pl.s[2] - c[2], pl.s[0] - c[0]) : 0;
    for (var i = 0; i < n; i++) {
      var r = 5.5 + 5.0 * this.rand();
      var phi = phiP + Math.PI * (0.55 + 0.9 * this.rand());          // 出在玩家的另一側（不會一出來就貼臉）
      var incl = (this.rand() - 0.5) * 0.9;
      var sense = ((i + this.wave) & 1) ? -1 : 1;                      // 一半逆著繞：每半圈迎面對上一次
      var ob = orbit(this.holes, r, phi, incl, sense, this.t - 70, this.t);
      if (!ob) continue;
      var e = this.addShip('enemy', ob.s, null, null, { tau: ob.tau, hist: ob.tr, rHome: r, cool: 2 + 3 * this.rand() });
      e.ai.jinkAt = this.wave >= 3 ? this.t + 8 + 10 * this.rand() : null;
      this.events.push({ type: 'spawn', ship: e });
    }
  };

  // 一艘敵機這一格要做什麼：回傳 { dir, a }（推力），順便轉機頭、決定開不開火
  World.prototype.think = function (e, dTauE) {
    var cfg = this.cfg, holes = this.holes, pl = this.player, c = holes[0].pos, rs = holes[0].rs;
    var pos = [e.s[0], e.s[1], e.s[2]], r = radius(holes, e.s);
    var st = steer(holes, e.s, { rTarget: r < 4.2 * rs ? Math.max(e.ai.rHome, 6 * rs) : e.ai.rHome });
    var dir = st.dir, a = 0;
    if (e.ai.burn) { if (st.mag < 0.012) e.ai.burn = false; } else if (st.mag > 0.04 || r < 4.2 * rs) e.ai.burn = true;
    if (e.ai.burn) a = cfg.enemyAccel * Math.min(1, st.mag / 0.05);
    // 第三波起偶爾閃一下（朝隨機方向推一小段），不然永遠是一條好猜的軌道
    if (e.ai.jinkAt !== null) {
      if (this.t >= e.ai.jinkAt && !e.ai.jinkDir) { e.ai.jinkDir = norm([this.rand() - 0.5, this.rand() - 0.5, this.rand() - 0.5]); e.ai.jinkEnd = this.t + 2.5; }
      if (e.ai.jinkDir) {
        if (this.t < e.ai.jinkEnd) { dir = e.ai.jinkDir; a = cfg.enemyAccel; }
        else { e.ai.jinkDir = null; e.ai.jinkAt = this.t + 9 + 9 * this.rand(); }
      }
    }
    // 瞄準：它看到的是光行時間之前的玩家，照那時候的速度往後推（光走直線、玩家等速）
    var want = null, fire = false;
    var seen = pl && pl.alive ? this.retarded(pl.hist, pos, this.t) : null;
    if (seen && !st.inside) {
      var sp = [seen.x, seen.y, seen.z], dist = len([sp[0] - pos[0], sp[1] - pos[1], sp[2] - pos[2]]);
      if (dist < cfg.enemyRange && segNear(pos, sp, c) > 2.7 * rs) {
        var v = [seen.ux / seen.ut, seen.uy / seen.ut, seen.uz / seen.ut], lag = this.t - seen.t, aim = sp, k;
        for (k = 0; k < 3; k++) { var tof = len([aim[0] - pos[0], aim[1] - pos[1], aim[2] - pos[2]]); aim = [sp[0] + v[0] * (lag + tof), sp[1] + v[1] * (lag + tof), sp[2] + v[2] * (lag + tof)]; }
        var n = norm([aim[0] - pos[0] + e.ai.spread[0], aim[1] - pos[1] + e.ai.spread[1], aim[2] - pos[2] + e.ai.spread[2]]);
        var nf = noseFor(holes, e.s, n);
        if (nf) { want = nf.nose; fire = true; }
      }
    }
    if (!want) { var u = velocity4(holes, e.s); want = norm([u[0], u[1], u[2]]); }
    var ang = Math.acos(clamp(dot3(e.fwd, want), -1, 1)), maxTurn = cfg.enemyTurn * dTauE;
    if (ang > 1e-4) {
      var ax = cross(e.fwd, want);
      if (len(ax) < 1e-6) ax = e.up;
      ax = norm(ax);
      e.fwd = rotate(e.fwd, ax, Math.min(ang, maxTurn)); e.up = rotate(e.up, ax, Math.min(ang, maxTurn));
      reorth(e);
    }
    e.cool -= dTauE;
    if (fire && e.cool <= 0 && ang - maxTurn < 0.02) {
      this.fire(e);
      e.cool = cfg.enemyFireGap * (0.8 + 0.4 * this.rand());
      var sprd = cfg.enemySpread * 12;                                 // 下一發的散布（瞄準點偏多少 rs）
      e.ai.spread = [(this.rand() - 0.5) * sprd, (this.rand() - 0.5) * sprd, (this.rand() - 0.5) * sprd];
    }
    e.thr = a > 0 ? clamp(dot3(dir, e.fwd), 0, 1) * a / cfg.enemyAccel : 0;
    return { dir: dir, a: a };
  };

  /* 往前走 dTau（玩家的固有時）。inp：
   *   f, r, u   推力（船的座標：前、右、上），各 −1～1
   *   boost     加力
   *   assist    沒有手動推力時，自動把速度修成當地的圓軌道
   *   fire      開火 */
  World.prototype.step = function (dTau, inp) {
    if (this.state !== 'play' || !(dTau > 0)) return;
    inp = inp || {};
    var cfg = this.cfg, holes = this.holes, pl = this.player, tPrev = this.t, i, j, sh;
    for (i = 0; i < this.ships.length; i++) { sh = this.ships[i]; sh.prev = [sh.s[0], sh.s[1], sh.s[2]]; sh.flash = Math.max(0, sh.flash - 1.3 * dTau); }

    // 1. 玩家
    if (pl && pl.alive) {
      var dir = pl.fwd, a = 0, m = Math.hypot(inp.f || 0, inp.r || 0, inp.u || 0), boosting = false;
      pl.thr = 0;
      if (m > 0.01) {
        var right = cross(pl.fwd, pl.up), f = inp.f || 0, rr = inp.r || 0, uu = inp.u || 0;
        dir = norm([pl.fwd[0] * f + right[0] * rr + pl.up[0] * uu, pl.fwd[1] * f + right[1] * rr + pl.up[1] * uu, pl.fwd[2] * f + right[2] * rr + pl.up[2] * uu]);
        boosting = !!inp.boost && this.energy > 1;
        a = cfg.accel * Math.min(1, m) * (boosting ? cfg.boost : 1);
        pl.thr = clamp(f, 0, 1) * (boosting ? 1.4 : 1);
      } else if (inp.assist) {
        var st = steer(holes, pl.s, {});
        if (!st.inside && st.mag > 0.004) { dir = st.dir; a = cfg.accel * Math.min(1, st.mag / 0.04); pl.thr = clamp(dot3(dir, pl.fwd), 0, 1) * a / cfg.accel; }
      }
      var done = advanceTau(holes, pl.s, dTau, dir, a);
      pl.tau += done;
      this.t = pl.s[3]; this.tau += dTau;
      this.energy = clamp(this.energy + (boosting ? -cfg.boostCost : cfg.energyRegen) * dTau, 0, cfg.energyMax);
      this.cool -= dTau;
      if (inp.fire && this.cool <= 0 && this.energy >= cfg.boltCost) {
        if (this.fire(pl)) { this.cool = cfg.fireGap; this.energy -= cfg.boltCost; this.shots++; }
      }
    } else { this.t += dTau; this.tau += dTau; }

    // 2. 敵機：走到同一個座標時間（各自的鐘走多少由它們自己的位置與速度決定）
    for (i = 0; i < this.ships.length; i++) {
      sh = this.ships[i];
      if (sh.team !== 'enemy' || !sh.alive) continue;
      var ut = velocity4(holes, sh.s)[3], cmd = this.think(sh, (this.t - tPrev) / Math.max(ut, 1e-6));
      sh.tau += advanceTo(holes, sh.s, this.t, cmd.dir, cmd.a);
    }

    // 3. 光彈：這一格的時間裡，每一顆光彈跟每一艘敵對的船各走一小段直線，最近距離夠近就算打中
    for (i = this.bolts.length - 1; i >= 0; i--) {
      var b = this.bolts[i], tr = b.tr, ta = Math.max(tPrev, tr.T[0]), tb = Math.min(this.t, tr.T[tr.n - 1]);
      if (tb > ta) {
        var a0 = P.sampleAt(tr, ta), a1 = P.sampleAt(tr, tb), wa = (ta - tPrev) / (this.t - tPrev), wb = (tb - tPrev) / (this.t - tPrev);
        for (j = 0; j < this.ships.length; j++) {
          sh = this.ships[j];
          if (!sh.alive || sh.team === b.team) continue;
          var p0 = [sh.prev[0] + (sh.s[0] - sh.prev[0]) * wa, sh.prev[1] + (sh.s[1] - sh.prev[1]) * wa, sh.prev[2] + (sh.s[2] - sh.prev[2]) * wa];
          var p1 = [sh.prev[0] + (sh.s[0] - sh.prev[0]) * wb, sh.prev[1] + (sh.s[1] - sh.prev[1]) * wb, sh.prev[2] + (sh.s[2] - sh.prev[2]) * wb];
          var cl = closest([a0.x, a0.y, a0.z], [a1.x, a1.y, a1.z], p0, p1);
          if (cl.d <= cfg.hitRadius) {
            b.dead = true; b.tHit = ta + cl.w * (tb - ta);
            this.damage(sh, b);
            break;
          }
        }
      }
      if (b.dead || this.t >= tr.T[tr.n - 1]) this.bolts.splice(i, 1);
    }

    // 4. 掉進去、飛出戰場
    for (i = 0; i < this.ships.length; i++) {
      sh = this.ships[i];
      if (!sh.alive) continue;
      var near = P.nearest(holes, sh.s), r = radius(holes, sh.s);
      if (sh === pl) {
        if (near.k >= 0 && near.ratio < 1 && !this.crossed) { this.crossed = true; this.events.push({ type: 'cross' }); }
        if (near.k >= 0 && near.ratio < 0.03) this.kill(sh, 'singularity');
        else if (r > cfg.arena) this.kill(sh, 'lost');
      } else if (near.k >= 0 && near.ratio < 1.0) this.kill(sh, 'eaten');
    }

    // 5. 波次
    if (this.state === 'play' && this.waveAt !== null) {
      var alive = 0;
      for (i = 0; i < this.ships.length; i++) if (this.ships[i].team === 'enemy' && this.ships[i].alive) alive++;
      if (alive === 0) {
        if (this.waveAt < 0) {                                         // 剛清完
          this.waveAt = this.tau + cfg.waveGap;
          if (this.wave >= cfg.waves.length) { this.state = 'won'; this.reason = 'cleared'; this.events.push({ type: 'won' }); }
          else { if (pl) pl.hp = Math.min(pl.hpMax, pl.hp + cfg.waveHeal); this.events.push({ type: 'waveClear', wave: this.wave }); }
        } else if (this.state === 'play' && this.tau >= this.waveAt) {
          this.wave++; this.waveAt = -1;
          this.spawnWave();
          this.events.push({ type: 'wave', wave: this.wave });
        }
      }
    }

    // 6. 歷史
    for (i = this.ships.length - 1; i >= 0; i--) {
      sh = this.ships[i];
      if (sh.alive) { histPush(holes, sh.hist, sh); histTrim(sh.hist, this.t - cfg.histKeep); }
      else if (this.t > sh.tDeath + cfg.histKeep) this.ships.splice(i, 1);     // 它最後的光也早就過去了
    }
  };

  World.prototype.damage = function (sh, b) {
    sh.hp -= b.dmg; sh.flash = 1;
    if (b.team === 'player') this.hits++;
    this.events.push({ type: 'hit', ship: sh, bolt: b, t: b.tHit });
    if (sh.hp <= 0) this.kill(sh, 'shot', b);
  };
  World.prototype.kill = function (sh, why, b) {
    if (!sh.alive) return;
    sh.alive = false; sh.hp = Math.min(sh.hp, 0); sh.tDeath = this.t; sh.thr = 0;
    histPush(this.holes, sh.hist, sh);
    if (sh.team === 'enemy') {
      if (why === 'shot') { this.kills++; this.score += 100 * Math.max(1, this.wave); }
      this.events.push({ type: 'kill', ship: sh, why: why });
    } else {
      this.state = 'dead'; this.reason = why;
      this.events.push({ type: 'dead', why: why });
    }
  };
  World.prototype.takeEvents = function () { var e = this.events; this.events = []; return e; };

  var G = {
    CFG: CFG, World: World,
    kick: kick, advanceTau: advanceTau, advanceTo: advanceTo, steer: steer, emit: emit, noseFor: noseFor, coast: coast, solveAim: solveAim,
    closest: closest, segNear: segNear, cameraFrame: cameraFrame, project: project, projectDir: projectDir,
    orbit: orbit, frameFromVel: frameFromVel, histNew: histNew, histPush: histPush, histFromTrace: histFromTrace,
    velocity4: velocity4, orthU: orthU, rotate: rotate, norm: norm, cross: cross, dot3: dot3, radius: radius
  };
  BH.Game = G;
  if (node) module.exports = G;
})(typeof window !== 'undefined' ? window : globalThis);
