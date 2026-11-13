/* 黑洞模擬 —— 拋進去的東西：物體（有質量）與光束（一串光子）
 *
 * 每一個東西在發射時就把整條測地線算好（physics.trace），重新取樣成一列貼圖交給著色器；
 * 著色器用「光經過那裡的時刻」去查它的位置，所以畫面上自帶光行時間差。
 *
 * 拋射器設定 spec：
 *   kind    'ball' | 'light'
 *   r0, phi0, incl   發射點：赤道面上半徑 r0、方位角 phi0；incl 是軌道面相對赤道面的傾角
 *   speed   相對當地靜止觀察者的速度（0 ≤ v < 1，只有物體用；光一律是 1）
 *   alpha   方向（當地懸停的人量到的角度）：0 = 正對黑洞，π/2 = 切向（順著吸積盤轉的方向），負的 = 逆著轉
 *   mass    物體的質量，單位是「黑洞現在的質量」（只有物體用）
 *   shape   'cube'（預設：自發光的立方體，照自己的固有時慢慢自轉）| 'ball'（球）| 'ship'（飛船：雕刻作品的格子，js/ship.js）；只有物體用
 *   shipLen 飛船畫出來多長（模擬單位，rs = 1 時就是幾個 rs）；只有 shape = 'ship' 用
 *   pulses  光束一次打幾顆（只有光用）；color 光束顏色
 *
 * 質量會影響什麼：測地線（路徑）不看質量 —— 這是等效原理，也是本檔把物體當「測試粒子」的前提。
 * 質量只影響 (1) 畫出來的大小，(2) 開了「吃了會變重」時黑洞長多少（rs 增加 mass × E/m × rs）。
 * 質量大到跟黑洞可以比的時候，測試粒子近似本身就不成立，這裡沒有處理。
 *
 * 戰鬥模式（js/game.js）另外用到兩種：
 *   addLive   自己會動的東西：不是測地線，軌跡是「到現在為止實際走過的路」，每一格由外面接長。
 *             有人開的船（shape = 'pilot'）另外帶機頭、上方、引擎出力、被打中的閃光四個欄位，一樣照座標時間存、
 *             照光經過的那一刻查；飛彈（shape = 'ball'）只有位置與速度。
 *   addTraced 已經算好的一條軌跡（彈丸、爆炸的火球、破片）：不會自動接長，走完就收。
 *             光束（shape = 'beam'）：tr 是第一顆光子的路，另外帶 beam = { dur, tail }（最後一顆光子的路）。
 *   用格子畫的東西（shape = 'chunk'：破片、飛彈、彈丸）：slot ＝ 格子在貼圖的哪個船位、pivot ＝ 物體的位置對到模型座標的哪一點、
 *             kv ＝ 一格多長、radius ＝ 包住它的球；朝向來自 frameAt(t)（或歷史裡的 FX…GZ 欄位），都沒有就機頭朝飛行方向。
 */
(function (root) {
  'use strict';
  var BH = root.BH = root.BH || {};
  var P = BH.Physics;

  var LOOKBACK = 150;       // 光線往回追，超過這麼久以前的物體位置就不查了（只影響卡在視界上的殘影）
  var PULSE_GAP = 0.9;      // 光束裡相鄰兩顆光子的間隔（rs/c）
  var PALETTE = [[1, .85, .35], [.45, .9, 1], [1, .55, .75], [.6, 1, .55], [.85, .7, 1], [1, .62, .3]];
  var LIGHT_COLORS = { green: [.3, 1, .45], red: [1, .28, .22], blue: [.38, .62, 1], white: [1, 1, 1] };

  function Bodies(renderer, trajN, maxRows) {
    this.renderer = renderer;      // 可以是 null（node 測試）
    this.trajN = trajN || 1024;
    this.maxBodies = maxRows || 16;
    this.list = [];
    this.freeRows = [];
    for (var i = 0; i < this.maxBodies; i++) this.freeRows.push(i);
    this.nextGroup = 1;
    this.colorIdx = 0;
    this.tight = false;            // 戰鬥模式：小東西（光束、彈丸、飛彈、破片）沒被黑洞擋到時，只交出「現在看到的那一刻」前後一小段（著色器快很多；代價是它們沒有繞過黑洞的重影）
    this.lookback = LOOKBACK;      // 見上面 LOOKBACK；戰鬥模式的戰場比較大，進場時會放長
    this.shipDims = [1, 1, 1];     // 飛船模型幾格（app 載入模型後設定）：船的位置對到模型正中間、一格 ＝ 船長 ÷ nx
    this.shipEngMask = 255;        // 船自己的引擎（遮罩）：沒指定遮罩的船用這個
    this.shipBound = 1.3;          // 飛船包圍球 ÷ 半船長；載入模型後由 app 設成 BH.Ship 算的值（含噴射）
  }
  Bodies.LIGHT_COLORS = LIGHT_COLORS;

  // 拋射器設定 → 發射位置與方向（座標空間）
  Bodies.aim = function (holes, spec) {
    var c = holes[0].pos, cp = Math.cos(spec.phi0), sp = Math.sin(spec.phi0), ci = Math.cos(spec.incl), si = Math.sin(spec.incl);
    var ea = [cp, 0, sp];                    // 徑向（向外）
    var eb = [ci * sp, si, -ci * cp];        // 切向：incl = 0 時就是吸積盤轉的方向
    // alpha 是當地懸停觀察者量到的角度；畫在圖上的座標方向，徑向分量要乘 √(1 − rs/r)（只給畫圖用）
    var ca = Math.cos(spec.alpha), sa = Math.sin(spec.alpha);
    var k = Math.sqrt(Math.max(0, 1 - holes[0].rs / spec.r0));
    return {
      x: [c[0] + spec.r0 * cp, c[1], c[2] + spec.r0 * sp],
      dir: [-ca * k * ea[0] + sa * eb[0], sa * eb[1], -ca * k * ea[2] + sa * eb[2]],
      ea: ea, eb: eb
    };
  };

  // 算整條軌跡（發射時刻 t0）。發射點在視界內 ⇒ null
  Bodies.plan = function (holes, spec, t0) {
    var a = Bodies.aim(holes, spec);
    var light = spec.kind === 'light';
    var s = P.launchLocal(holes, a.x, [-a.ea[0], -a.ea[1], -a.ea[2]], a.eb, spec.alpha, light ? 1 : spec.speed, spec.kind);
    if (!s) return null;
    s[3] = t0 || 0;
    var tr = P.trace(holes, s, light ? { tSpan: 320, rMax: 70, frac: 0.012, maxSteps: 40000 }
                                     : { tSpan: 600, rMax: 90, frac: 0.012, maxSteps: 60000 });
    tr.e = -s[7];
    return tr;
  };

  /* 光從 (px,py,pz) 走到攝影機大約要多久（座標時間）。
   * 平直空間的距離 ＋ 徑向向外的光在視界附近多花的時間 2rs ln((r_cam − rs)/(r − rs))。
   * 後面那一項對徑向的光是精確的，其他方向是近似；它在 r → rs 時發散，這就是「凍結」。
   * 只看第 0 個洞。攝影機在視界內時只用距離（示意）。 */
  function delay(holes, px, py, pz, cam, camInside) {
    var dist = Math.hypot(px - cam[0], py - cam[1], pz - cam[2]);
    var h = holes[0];
    if (!(h.rs > 0)) return dist;
    var rb = Math.hypot(px - h.pos[0], py - h.pos[1], pz - h.pos[2]);
    var rc = Math.hypot(cam[0] - h.pos[0], cam[1] - h.pos[1], cam[2] - h.pos[2]);
    if (camInside || rc <= h.rs) return dist;
    if (rb <= h.rs * (1 + 1e-9)) return Infinity;
    return dist + Math.max(0, 2 * h.rs * Math.log((rc - h.rs) / (rb - h.rs)));
  }
  Bodies.delay = delay;
  // 點 c 到線段 a → (p.x, p.y, p.z) 的距離
  function segDist(a, p, c) {
    var dx = p.x - a[0], dy = p.y - a[1], dz = p.z - a[2], L2 = dx * dx + dy * dy + dz * dz;
    var w = L2 > 0 ? Math.max(0, Math.min(1, ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy + (c[2] - a[2]) * dz) / L2)) : 0;
    return Math.hypot(a[0] + dx * w - c[0], a[1] + dy * w - c[1], a[2] + dz * w - c[2]);
  }

  function shiftTraj(tr, dt) {
    var o = {};
    for (var k in tr) o[k] = tr[k];
    o.T = tr.T.map(function (t) { return t + dt; });
    if (tr.crossT !== null) o.crossT = tr.crossT + dt;
    return o;
  }

  Bodies.prototype.upload = function (b) {
    var rs = P.resample(b.tr, this.trajN);
    b.t0 = rs.t0; b.t1 = rs.t1;
    if (this.renderer) this.renderer.setTrajRow(b.row, rs.pos, rs.vel);
    if (b.shape === 'beam') {
      var bf = beamFrame(b.tr, b.beam, this.trajN);
      b.lam = bf.lam;
      if (this.renderer) this.renderer.setFrameRow(b.row, bf.fwd, bf.up);
    } else if ((b.shape === 'pilot' || b.shape === 'chunk') && this.renderer) {
      // 一塊格子沒有朝向資料時放 0：著色器看到 0 就讓機頭朝飛行方向（這一列可能留著上一個東西的資料，所以一定要寫）
      var fr = b.frameAt ? frameRows(b, this.trajN) : (b.tr.FX ? resampleFrame(b.tr, this.trajN) : { fwd: new Float32Array(4 * this.trajN), up: new Float32Array(4 * this.trajN) });
      this.renderer.setFrameRow(b.row, fr.fwd, fr.up);
    }
  };
  // 朝向由函式給的東西（破片的翻滾、彈丸的彈頭朝前）：frameAt(t) → { fwd, up, thr（引擎出力，可省） }
  function frameRows(b, N) {
    var t0 = b.tr.T[0], t1 = b.tr.T[b.tr.n - 1], fwd = new Float32Array(4 * N), up = new Float32Array(4 * N);
    for (var i = 0; i < N; i++) {
      var q = b.frameAt(t0 + (t1 - t0) * i / (N - 1));
      fwd[4 * i] = q.fwd[0]; fwd[4 * i + 1] = q.fwd[1]; fwd[4 * i + 2] = q.fwd[2]; fwd[4 * i + 3] = q.thr || 0;
      up[4 * i] = q.up[0]; up[4 * i + 1] = q.up[1]; up[4 * i + 2] = q.up[2];
    }
    return { fwd: fwd, up: up };
  }
  /* 光束（戰鬥模式的雷射）：tr 是第一顆光子的路，beam = { dur, tail }，tail 是最後一顆光子的路（晚 dur 出發）。
   * 回傳軌跡貼圖第三列要放的東西：每個取樣時刻 T，E(T) = (最後一顆在 T 的位置 − 第一顆在 T 的位置) ÷ dur
   * —— 晚 dl 出發的光子在 T 的位置就近似成「第一顆的位置 + dl × E」。平直空間裡 E = 發射的船的速度 − 光的速度，
   * 所以光束的尾端一直接在（還在動的）發射口上，在船自己看來光束筆直朝機頭。
   * 最後一顆還沒出發的時刻，用它出發時的速度往回延長（那一段光束實際上還沒射出來，著色器會擋掉）。
   * w 分量 lam：最後一顆比第一顆晚多久到終點（÷ dur）。終點 ＝ 第一顆停下來的地方（打中東西、或飛完射程）那個垂直於光路的平面。 */
  function beamFrame(tr, beam, N) {
    var tail = beam.tail, dur = beam.dur, t0 = tr.T[0], t1 = tr.T[tr.n - 1], fwd = new Float32Array(4 * N), up = new Float32Array(4 * N), i;
    function tailAt(T) {
      var a = tail.T[0], b = tail.T[tail.n - 1], q, k;
      if (T <= a) { k = (T - a) / tail.UT[0]; return [tail.X[0] + tail.UX[0] * k, tail.Y[0] + tail.UY[0] * k, tail.Z[0] + tail.UZ[0] * k]; }
      q = P.sampleAt(tail, Math.min(T, b));
      k = T > b ? (T - b) / q.ut : 0;
      return [q.x + q.ux * k, q.y + q.uy * k, q.z + q.uz * k];
    }
    var e = P.sampleAt(tr, t1), nl = Math.hypot(e.ux, e.uy, e.uz) || 1, ne = [e.ux / nl, e.uy / nl, e.uz / nl];
    function Fp(T) { var p = tailAt(T); return (p[0] - e.x) * ne[0] + (p[1] - e.y) * ne[1] + (p[2] - e.z) * ne[2]; }
    var lo = t1 - 2 * dur - 1, hi = t1 + 3 * dur + 1, lam = 1;
    if (Fp(lo) < 0 && Fp(hi) > 0) {
      for (i = 0; i < 44; i++) { var mid = 0.5 * (lo + hi); if (Fp(mid) < 0) lo = mid; else hi = mid; }
      lam = (lo - t1) / dur;
    }
    lam = Math.max(0.05, Math.min(3, lam));
    for (i = 0; i < N; i++) {
      var T = t0 + (t1 - t0) * i / (N - 1), h = P.sampleAt(tr, T), p = tailAt(T);
      fwd[4 * i] = (p[0] - h.x) / dur; fwd[4 * i + 1] = (p[1] - h.y) / dur; fwd[4 * i + 2] = (p[2] - h.z) / dur; fwd[4 * i + 3] = lam;
    }
    return { fwd: fwd, up: up, lam: lam };
  }
  Bodies.beamFrame = beamFrame;

  // 有人開的船：機頭（FX FY FZ）＋出力（TH）、上方（GX GY GZ）＋閃光（FL），取樣方式跟 P.resample 一樣
  function resampleFrame(tr, N) {
    var t0 = tr.T[0], t1 = tr.T[tr.n - 1], fwd = new Float32Array(4 * N), up = new Float32Array(4 * N), j = 0;
    for (var i = 0; i < N; i++) {
      var t = t0 + (t1 - t0) * i / (N - 1);
      while (j < tr.n - 2 && tr.T[j + 1] < t) j++;
      var j1 = Math.min(j + 1, tr.n - 1), span = tr.T[j1] - tr.T[j];
      var w = span > 0 ? Math.min(1, Math.max(0, (t - tr.T[j]) / span)) : 0;
      fwd[4 * i] = tr.FX[j] + (tr.FX[j1] - tr.FX[j]) * w; fwd[4 * i + 1] = tr.FY[j] + (tr.FY[j1] - tr.FY[j]) * w;
      fwd[4 * i + 2] = tr.FZ[j] + (tr.FZ[j1] - tr.FZ[j]) * w; fwd[4 * i + 3] = tr.TH[j] + (tr.TH[j1] - tr.TH[j]) * w;
      up[4 * i] = tr.GX[j] + (tr.GX[j1] - tr.GX[j]) * w; up[4 * i + 1] = tr.GY[j] + (tr.GY[j1] - tr.GY[j]) * w;
      up[4 * i + 2] = tr.GZ[j] + (tr.GZ[j1] - tr.GZ[j]) * w; up[4 * i + 3] = tr.FL[j] + (tr.FL[j1] - tr.FL[j]) * w;
    }
    return { fwd: fwd, up: up };
  }
  Bodies.resampleFrame = resampleFrame;

  // 滿了要騰位置：先丟最舊的「不是有人開的船」（光彈、火球、拋射物）；全都是船才丟最舊的那艘
  Bodies.prototype.makeRoom = function () {
    while (this.list.length >= this.maxBodies) {
      var k = 0;
      for (var i = 0; i < this.list.length; i++) if (!this.list[i].live) { k = i; break; }
      this.remove(k);
    }
  };

  /* 有人開的船。tr 是它到現在為止的歷史（跟 P.trace 回傳的同一種欄位，再加 FX FY FZ TH GX GY GZ FL），
   * 這個物件由外面持有、每一格接長（或整段換掉）之後呼叫 upload(b)。o：radius（半個船長）、color（染色）。 */
  Bodies.prototype.addLive = function (tr, o) {
    this.makeRoom();
    var b = {
      group: this.nextGroup++, pulse: 0, kind: 'ball', shape: o.shape || 'pilot', color: o.color || [1, 1, 1], radius: o.radius,
      mass: 0, e: 0, absorbed: true, live: true, tr: tr, row: this.freeRows.shift(), spec: null, seen: null, now: null, tag: o.tag || null,
      slot: o.slot || 0, engMask: o.engMask != null ? o.engMask : this.shipEngMask,      // 飛船：用格子貼圖的第幾個船位、哪幾具引擎還在
      pivot: o.pivot || null, kv: o.kv || 0, frameAt: o.frameAt || null
    };
    this.upload(b);
    this.list.push(b);
    return b;
  };

  /* 一條已經算好的軌跡（光彈、火球）。o：kind（'light'｜'ball'）、color、radius、linger（走完之後再留多久，等它的光到攝影機）。 */
  Bodies.prototype.addTraced = function (tr, o) {
    if (!tr || tr.n < 2) return null;
    this.makeRoom();
    var b = {
      group: this.nextGroup++, pulse: 0, kind: o.kind, shape: o.shape || (o.beam ? 'beam' : (o.kind === 'light' ? 'dot' : 'ball')), color: o.color, radius: o.radius,
      mass: 0, e: 0, absorbed: true, fixed: true, linger: o.linger, tr: tr, row: this.freeRows.shift(), spec: null, seen: null, now: null, tag: o.tag || null,
      beam: o.beam || null, slot: o.slot || 0, engMask: o.engMask != null ? o.engMask : 0, pivot: o.pivot || null, kv: o.kv || 0, frameAt: o.frameAt || null
    };
    this.upload(b);
    this.list.push(b);
    return b;
  };

  // 把一條軌跡在時刻 t 截斷（光彈打中東西）：之後的部分不存在了，畫面上它的光走到那一刻就沒了
  Bodies.prototype.truncate = function (b, t) {
    var tr = b.tr;
    if (!(t > tr.T[0]) || t >= tr.T[tr.n - 1]) return;
    var st = P.sampleAt(tr, t), o = {};
    for (var k in tr) o[k] = tr[k];
    var keys = ['T', 'X', 'Y', 'Z', 'UX', 'UY', 'UZ', 'UT', 'PX', 'PY', 'PZ', 'PT', 'TAU'];
    var last = { T: st.t, X: st.x, Y: st.y, Z: st.z, UX: st.ux, UY: st.uy, UZ: st.uz, UT: st.ut, PX: st.px, PY: st.py, PZ: st.pz, PT: st.pt, TAU: st.tau };
    for (var i = 0; i < keys.length; i++) o[keys[i]] = tr[keys[i]].slice(0, st.index + 1).concat([last[keys[i]]]);
    o.n = o.T.length; o.fate = 'hit';
    b.tr = o;
    this.upload(b);
  };

  Bodies.prototype.removeBody = function (b) { var i = this.list.indexOf(b); if (i >= 0) this.remove(i); };

  Bodies.prototype.remove = function (i) {
    var b = this.list[i];
    this.freeRows.push(b.row);
    this.list.splice(i, 1);
  };

  Bodies.prototype.clear = function () { while (this.list.length) this.remove(0); };

  /* 發射。發射的「那一刻」定在過去，讓它的光現在剛好到攝影機 ⇒ 按下去馬上看得到。
   * 回傳新增了幾個。 */
  Bodies.prototype.spawn = function (holes, spec, tCam, camPos, camInside) {
    var a = Bodies.aim(holes, spec);
    var t0 = tCam - delay(holes, a.x[0], a.x[1], a.x[2], camPos, camInside);
    if (!isFinite(t0)) t0 = tCam;
    // 飛船很長：離攝影機比較遠的那半截，光要在 t0 之前出發才到得了 —— 那時船還不存在，剛發射時會缺一角。
    // 多往前留一個船長的光行時間（顯示卡自我測試量過：沒留的話平直空間裡船長 6 的剪影少 14%）
    if (spec.kind !== 'light' && spec.shape === 'ship') t0 -= 1.3 * (spec.shipLen || 1.2);
    var tr = Bodies.plan(holes, spec, t0);
    if (!tr || tr.n < 2) return 0;
    var light = spec.kind === 'light';
    var n = light ? Math.max(1, Math.min(8, spec.pulses | 0)) : 1;
    var color = light ? (LIGHT_COLORS[spec.color] || LIGHT_COLORS.green) : PALETTE[this.colorIdx++ % PALETTE.length];
    var group = this.nextGroup++;
    var ship = !light && spec.shape === 'ship';
    var cube = !light && !ship && spec.shape !== 'ball';
    // 物體的大小跟著質量走（只是畫出來的大小；路徑跟質量無關）。立方體的 radius 是半邊長；飛船的是半個船長（另外給）。
    var radius = light ? 0.15 : (ship ? 0.5 * (spec.shipLen || 1.2) : Math.max(0.14, Math.min(0.6, 0.26 * Math.pow(spec.mass / 0.01, 1 / 3))) * (cube ? 0.8 : 1));
    if (ship) color = [0.78, 0.78, 0.74];
    for (var k = 0; k < n; k++) {
      this.makeRoom();
      var b = {
        group: group, pulse: k, kind: spec.kind, shape: light ? 'dot' : (ship ? 'ship' : (cube ? 'cube' : 'ball')), color: color, radius: radius,
        mass: light ? 0 : spec.mass, e: tr.e, absorbed: false,
        tr: k === 0 ? tr : shiftTraj(tr, k * PULSE_GAP),
        row: this.freeRows.shift(), spec: JSON.parse(JSON.stringify(spec)),
        seen: null, now: null
      };
      this.upload(b);
      this.list.push(b);
    }
    return n;
  };

  // 攝影機此刻看到的是這個東西在哪個時刻的樣子；光還沒到 ⇒ null
  Bodies.prototype.seenTime = function (b, holes, tCam, cam, camInside) {
    var tr = b.tr, lo = tr.T[0], hi = Math.min(tr.T[tr.n - 1], tCam);
    function F(te) { var p = P.sampleAt(tr, te); return te + delay(holes, p.x, p.y, p.z, cam, camInside) - tCam; }
    if (F(lo) > 0) return null;
    if (F(hi) <= 0) return hi;
    for (var i = 0; i < 44; i++) { var mid = 0.5 * (lo + hi); if (F(mid) <= 0) lo = mid; else hi = mid; }
    return lo;
  };

  // 還在繞的軌道快用完時往後接一段（丟掉太久以前的部分，讓貼圖的解析度留給現在）
  Bodies.prototype.extend = function (b, holes, tCam) {
    var tr = b.tr, n = tr.n, i0 = 0;
    while (i0 < n - 2 && tr.T[i0 + 1] < tCam - (this.lookback + 60)) i0++;
    var s = new Float64Array([tr.X[n - 1], tr.Y[n - 1], tr.Z[n - 1], tr.T[n - 1], tr.PX[n - 1], tr.PY[n - 1], tr.PZ[n - 1], tr.PT[n - 1]]);
    var more = P.trace(holes, s, { tSpan: 600, rMax: 90, frac: 0.012, maxSteps: 60000, tau0: tr.TAU[n - 1] });
    b.tr = join(tr, i0, n, more);
    this.upload(b);
  };

  function join(a, i0, i1, b) {
    var o = { fate: b.fate, rMin: Math.min(a.rMin, b.rMin), e: a.e, crossHole: a.crossHole };
    var keys = ['T', 'X', 'Y', 'Z', 'UX', 'UY', 'UZ', 'UT', 'PX', 'PY', 'PZ', 'PT', 'TAU'];
    for (var k = 0; k < keys.length; k++) o[keys[k]] = a[keys[k]].slice(i0, i1).concat(b[keys[k]].slice(1));
    o.n = o.T.length;
    if (a.crossT !== null && a.crossT <= a.T[i1 - 1]) { o.crossT = a.crossT; o.crossTau = a.crossTau; }
    else { o.crossT = b.crossT; o.crossTau = b.crossTau; o.crossHole = b.crossHole; }
    return o;
  }

  /* 度規在 tNow 換了（黑洞變重、拿掉黑洞）：還在飛的東西從 tNow 的位置與動量重新算後半段。
   * 過去的部分留著（那些光已經在路上了）。 */
  Bodies.prototype.replan = function (holes, tNow) {
    for (var i = 0; i < this.list.length; i++) {
      var b = this.list[i], tr = b.tr;
      if (b.live || b.fixed) continue;
      if (tNow <= tr.T[0] || tNow >= tr.T[tr.n - 1]) continue;
      var st = P.sampleAt(tr, tNow);
      var s = new Float64Array([st.x, st.y, st.z, tNow, st.px, st.py, st.pz, st.pt]);
      P.normalizeMomentum(holes, s, b.kind === 'light' ? 0 : -1);
      var light = b.kind === 'light';
      var more = P.trace(holes, s, light ? { tSpan: 320, rMax: 70, frac: 0.012, maxSteps: 40000, tau0: st.tau }
                                         : { tSpan: 600, rMax: 90, frac: 0.012, maxSteps: 60000, tau0: st.tau });
      // 接點：舊軌跡留到 tNow 之前，新軌跡的第一點就是 tNow
      var keep = { fate: tr.fate, rMin: tr.rMin, e: tr.e, crossHole: tr.crossHole, crossT: tr.crossT, crossTau: tr.crossTau };
      var keys = ['T', 'X', 'Y', 'Z', 'UX', 'UY', 'UZ', 'UT', 'PX', 'PY', 'PZ', 'PT', 'TAU'];
      for (var k = 0; k < keys.length; k++) keep[keys[k]] = tr[keys[k]].slice(0, st.index + 1).concat([more[keys[k]][0]]);
      keep.n = keep.T.length;
      b.tr = join(keep, 0, keep.n, more);
      b.e = -s[7];
      this.upload(b);
    }
  };

  /* 每一格更新：收掉過期的、接長還在繞的、算「看到的位置」。
   * 回傳這一格剛穿過視界的物體（給「吃了會變重」用）。 */
  Bodies.prototype.update = function (holes, tCam, cam, camInside) {
    var absorbed = [];
    for (var i = this.list.length - 1; i >= 0; i--) {
      var b = this.list[i], tr = b.tr;
      if (!b.absorbed && tr.crossT !== null && tCam >= tr.crossT) { b.absorbed = true; if (b.kind === 'ball') absorbed.push(b); }
      if (!b.live && !b.fixed && tr.fate === 'timeout' && tCam > b.t1 - 120) { this.extend(b, holes, tCam); tr = b.tr; }
      var linger = b.linger != null ? b.linger : (tr.fate === 'singularity' ? 90 : 20);
      if (!b.live && tCam > b.t1 + linger) { this.remove(i); continue; }
      var te = this.seenTime(b, holes, tCam, cam, camInside);
      b.seenT = te;
      // 光束：最後一顆光子晚 dur 出發，所以整段都看完的時刻比第一顆晚；tailT ＝ 現在看到的光束尾端在第一顆光子那條路上的哪個時刻
      b.tailT = b.shape === 'beam' ? this.seenTime(b, holes, tCam - b.beam.dur * Math.max(1, b.lam || 1), cam, camInside) : te;
      b.seen = te === null ? null : P.sampleAt(tr, te);
      b.clear = !!b.seen && !camInside && holes[0].rs > 0 && segDist(cam, b.seen, holes[0].pos) > 4 * holes[0].rs;      // 從攝影機直直看過去，離黑洞夠遠（光幾乎沒彎）
      b.now = (tCam >= b.t0 && tCam <= b.t1) ? P.sampleAt(tr, tCam) : null;
    }
    return absorbed;
  };

  /* 交給著色器的清單：每個東西四個 vec4。
   * 一個東西只可能在「攝影機此刻看到它的那個時刻」前後被光線碰到（直接看到的像在 seenT；
   * 繞過黑洞才到的像更早一點），所以只把那一段時間與那一段路徑的包圍球交出去，著色器靠它們跳過不相干的光線。
   * wide = 攝影機在黑洞附近或視界內：seenT 的估計比較粗，時段放寬。 */
  Bodies.prototype.uniforms = function (tCam, wide) {
    var out = [];
    for (var i = 0; i < this.list.length; i++) {
      var b = this.list[i], tr = b.tr;
      if (b.hidden) continue;                      // 外面說這一格不用畫（例如確定在鏡頭外的小東西）
      var mid = (b.seenT == null) ? b.t0 : b.seenT, beam = b.shape === 'beam';
      var lo = Math.max(b.t0, tCam - this.lookback, mid - (wide ? 45 : 22)), hi = Math.min(b.t1, tCam, mid + (wide ? 18 : 10));
      if (this.tight && !wide && b.clear && b.shape !== 'pilot' && b.shape !== 'ship') {
        lo = Math.max(b.t0, tCam - this.lookback, (beam && b.tailT != null ? Math.min(mid, b.tailT) : mid) - 2);
        hi = Math.min(b.t1, tCam, mid + 2);
      }
      if (hi < lo) continue;
      var i0 = P.sampleAt(tr, lo).index, i1 = Math.min(tr.n - 1, P.sampleAt(tr, hi).index + 1);
      var stride = Math.max(1, Math.floor((i1 - i0) / 48));
      var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (var j = i0; ; j += stride) {
        if (j > i1) j = i1;
        mn[0] = Math.min(mn[0], tr.X[j]); mx[0] = Math.max(mx[0], tr.X[j]);
        mn[1] = Math.min(mn[1], tr.Y[j]); mx[1] = Math.max(mx[1], tr.Y[j]);
        mn[2] = Math.min(mn[2], tr.Z[j]); mx[2] = Math.max(mx[2], tr.Z[j]);
        if (j === i1) break;
      }
      // 包圍球要包住整個東西：立方體的外接球是半邊長 × √3；飛船的是半船長 × shipBound（船身外框加上船尾的噴射，由 app 照模型設定）
      var isShip = b.shape === 'ship' || b.shape === 'pilot', sd = this.shipDims;
      var rad = 0.5 * Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) + b.radius * (b.shape === 'cube' ? 1.75 : (isShip ? this.shipBound : 1)) + (stride > 1 ? 0.8 : 0.3) + (beam ? 1.2 * b.beam.dur : 0);
      var kind = beam ? 5 : (b.shape === 'chunk' ? 6 : (b.kind === 'light' ? 1 : (b.shape === 'cube' ? 2 : (b.shape === 'ship' ? 3 : (b.shape === 'pilot' ? 4 : 0)))));
      out.push({
        A: [b.t0 - tCam, (this.trajN - 1) / (b.t1 - b.t0), b.row, b.radius],
        D: [lo - tCam, (beam ? Math.min(tCam, hi + 2.2 * b.beam.dur) : hi) - tCam, beam ? b.beam.dur : (b.slot || 0), b.engMask == null ? this.shipEngMask : b.engMask],
        B: [b.color[0], b.color[1], b.color[2], kind],
        C: [0.5 * (mn[0] + mx[0]), 0.5 * (mn[1] + mx[1]), 0.5 * (mn[2] + mx[2]), rad],
        E: b.shape === 'chunk' ? [b.pivot[0], b.pivot[1], b.pivot[2], b.kv] : (isShip ? [sd[0] / 2, sd[1] / 2, sd[2] / 2, 2 * b.radius / sd[0]] : [0, 0, 0, 1])
      });
    }
    return out;
  };

  BH.Bodies = Bodies;
  if (typeof module !== 'undefined' && module.exports) module.exports = Bodies;
})(typeof window !== 'undefined' ? window : globalThis);
