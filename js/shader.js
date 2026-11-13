/* 黑洞模擬 —— 著色器（每個像素往回追一條光線）
 *
 * 做法：攝影機的每個像素對應一個「光是從哪個方向進來的」；把那道光沿著零測地線往過去追，
 *       直到它 (1) 飛到遠處 ⇒ 查天空，(2) 貼到視界 ⇒ 黑，(3) 中途穿過吸積盤或撞到物體 ⇒ 疊上顏色。
 * 運動方程式與 js/physics.js 的 rhs 是同一組（Kerr–Schild 座標、哈密頓量形式），兩邊要一起改。
 * 光線自己帶著座標時間 t 往回走，所以物體是用「光出發那一刻」的位置畫的 —— 光行時間差本來就在裡面，
 * 遠處看物體「凍結在視界」不是另外做的效果。
 *
 * 編譯期常數（由 renderer 填）：MAX_HOLES、MAX_BODIES、TRAJ_N。
 */
(function (root) {
  'use strict';

  var VERT = [
    '#version 300 es',
    'void main(){',
    '  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  function frag(o) {
    return '#version 300 es\n' +
      'precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp usampler3D;\n' +
      '#define MAX_HOLES ' + o.maxHoles + '\n' +
      '#define MAX_BODIES ' + o.maxBodies + '\n' +
      '#define TRAJ_N ' + o.trajN + '\n' + BODY;
  }

  var BODY = `
#define MAX_STEPS 700
#define EPS_H 0.004          // 離視界多近就算「貼上去了」（× rs）
#define DISK_T 80.0          // 盤面花紋的循環週期（rs/c）
#define CUBE_SPIN 0.30       // 立方體自轉的快慢（弧度 ÷ 它自己的固有時），靠近視界時你會看到它越轉越慢
#define DISK_TEMP 3900.0     // 盤面最亮處的色溫（K），只影響顏色

uniform vec2 uRes;
uniform float uTanFov;       // tan(垂直視角 / 2)
uniform vec3 uCamPos;
uniform vec4 uP0, uP1, uP2, uP3;   // 攝影機標架降指標後的四個共變向量（xyz, t）：e0＝4-速度、e1 右、e2 上、e3 前
uniform int uHoleCount;
uniform vec4 uHole[MAX_HOLES];     // xyz 位置，w = rs
uniform vec4 uHoleSpin[MAX_HOLES]; // 預留：自旋軸 × a（現在沒用到）
uniform float uFar;
uniform int uMaxSteps;
uniform float uStepScale;
uniform float uCamInside;    // 攝影機是不是已經在視界裡面（或貼著視界）
uniform float uEnergyTest;   // 1 ⇒ 可以用「守恆能量的正負」直接判斷視界內的光線（只對單一、靜態、不自旋的洞成立）
uniform vec4 uDisk;          // 內半徑, 外半徑, 開關, 亮度
uniform float uDiskH;        // 盤的半厚度 ÷ 半徑（0 ＝ 沒有厚度的薄盤）
uniform float uDiskTime;     // 攝影機的座標時間 mod DISK_T
uniform vec4 uFlags;         // x 都卜勒與紅移著色, y 天球格線, z 星空, w 信標閃爍
uniform float uExposure;
uniform float uBeaconPeriod;
uniform float uGhost;         // 1 ⇒ 物體繞過黑洞另一側才到的像（重影）也畫；0 ⇒ 只畫直接看到的那一個
uniform int uDebug;          // 1 ⇒ 只輸出光線的結局（白：到天空，黑：被抓住，紅：步數用完）
uniform sampler2D uStars;    // 星表：天球投到立方體六個面、每面 G × G 格、每格最多 K 顆（xyz 方向, w = 色溫 ÷ 250 ＋ (星等 + 2) ÷ 10）
uniform vec3 uStarGrid;      // G, K, 有沒有星表（0／1）
const vec3 GAL_N = vec3(0.250722, 0.902598, 0.351010);   // 北銀極在模擬座標裡的方向（js/stars.js 的 GAL_N）
const vec3 GAL_C = vec3(0.963518, -0.267644, 0.);        // 銀河中心的方向（js/stars.js 的 GAL_C）
#if MAX_BODIES > 0
uniform int uBodyCount;
uniform vec4 uBodyA[MAX_BODIES];   // 軌跡起點時間 − 攝影機時間, 每單位時間幾格, 第幾列, 半徑
uniform vec4 uBodyB[MAX_BODIES];   // 顏色 rgb, 種類（0 球，1 光子標記，2 立方體，3 飛船，4 有人開的飛船，5 光束，6 一塊格子：破片、飛彈、彈丸）
uniform vec4 uBodyC[MAX_BODIES];   // 包圍球：中心 xyz, 半徑
uniform vec4 uBodyD[MAX_BODIES];   // 可能被看到的時段（相對攝影機時間）：最早, 最晚；飛船另外用：第幾個船位（光束：持續多久）, 哪幾具引擎還在（每具一個 bit）
uniform vec4 uBodyE[MAX_BODIES];   // 用格子畫的東西：物體的位置對到模型座標的哪一點（xyz，格）, 一格多長（w）
uniform sampler2D uTraj;           // 每個物體四列：(x, y, z, τ)、(dx/dλ, dt/dλ)，橫軸是座標時間；
                                   // 種類 4 多用兩列：(機頭 xyz, 引擎出力)、(上方 xyz, 被打中的閃光)
#define SLOT_Z 6
uniform usampler3D uShip;          // 飛船的格子：每格一個 RGB332 色號（0 ＝ 空），x 機頭、y 左舷、z 上（js/ship.js）；
                                   // 整張貼圖切成好幾個船位（沿 z 疊 SLOT_Z 份、再沿 y 疊），每艘戰鬥中的船自己一份（js/renderer.js）
uniform vec3 uShipDim;             // 飛船外框幾格（nx, ny, nz）；半徑 R ＝ 半個船長
uniform uvec4 uShipEmit0, uShipEmit1;  // 哪些色號會自己發光（256 個 bit）
#define MAX_ENG 8
uniform vec4 uShipEng[MAX_ENG];    // 每具引擎：噴嘴口的 x（噴射往 −x）, 中心 y, z, 半徑（模型座標，格）
uniform int uShipEngN;
uniform vec4 uShipPlume;           // 噴射長度 ÷ 引擎半徑, 外框半寬 ÷ 引擎半徑, 亮度, 開關（js/ship.js 的 PLUME）
uniform float uShipBound;          // 包住船身與噴射的球半徑 ÷ 半個船長（粗篩用）
#endif
out vec4 outColor;

// ── 雜訊 ──────────────────────────────────────────────
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * vnoise3(p); p *= 2.03; a *= .5; } return s; }
// 體積盤用的三層版本（每條光線要取很多次樣，省一層）；乘 1.07 讓數值範圍跟四層的差不多
float fbm3c(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 3; i++) { s += a * vnoise3(p); p *= 2.03; a *= .5; } return s * 1.07; }
// x 方向有週期的二維雜訊（繞盤一圈要接得起來）
float pnoise(vec2 p, float perX){
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  float x0 = mod(i.x, perX), x1 = mod(i.x + 1., perX);
  return mix(mix(hash12(vec2(x0, i.y)), hash12(vec2(x1, i.y)), f.x), mix(hash12(vec2(x0, i.y + 1.)), hash12(vec2(x1, i.y + 1.)), f.x), f.y);
}
float diskFbm(vec2 p, float perX){ float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * pnoise(p, perX); p *= 2.; perX *= 2.; a *= .5; } return s; }

// 黑體顏色的近似（只取色相，亮度另外算）
vec3 bbColor(float T){
  float t = T / 100.;
  float r = t <= 66. ? 1. : clamp(1.292936 * pow(t - 60., -0.1332047), 0., 1.);
  float g = t <= 66. ? clamp(0.3900816 * log(t) - 0.6318414, 0., 1.) : clamp(1.1298909 * pow(t - 60., -0.0755148), 0., 1.);
  float b = t >= 66. ? 1. : (t <= 19. ? 0. : clamp(0.5432068 * log(t - 10.) - 1.1962541, 0., 1.));
  return vec3(r, g, b);
}

// 頻率變成 g 倍（g < 1 紅移、g > 1 藍移）時顏色與亮度怎麼變：示意用，不是光譜計算
vec3 shiftColor(vec3 c, float g){
  float lg = log2(max(g, 1e-3));
  vec3 tint = lg < 0. ? mix(vec3(1.), vec3(1., .40, .20), clamp(-lg * .9, 0., 1.))
                      : mix(vec3(1.), vec3(.55, .78, 1.4), clamp(lg * .9, 0., 1.));
  float lum = dot(c, vec3(.3, .6, .1));
  return mix(c, vec3(lum), clamp(abs(lg) * .5, 0., .7)) * tint * clamp(g * g * g, 0., 8.);
}

// ── 運動方程式（與 physics.js 的 rhs 同一組）────────────
void rhs(vec3 x, vec4 p, out vec3 dx, out vec3 dp, out float dt){
  dx = p.xyz; dt = -p.w; dp = vec3(0.);
  for (int k = 0; k < MAX_HOLES; k++) {
    if (k >= uHoleCount) break;
    vec3 e = x - uHole[k].xyz;
    float r = max(length(e), 1e-6);
    vec3 n = e / r;
    float f = uHole[k].w / r;
    float np = dot(n, p.xyz);
    float L = np - p.w;
    float fL = f * L;
    dx -= fL * n;
    dt += fL;
    dp += (fL / r) * (-.5 * L * n + p.xyz - n * np);
  }
}

// 這一步在空間裡走多長：離洞越近越小，視界附近再縮
float stepLen(vec3 x){
  float ds = 12.;
  for (int k = 0; k < MAX_HOLES; k++) {
    if (k >= uHoleCount) break;
    float rs = uHole[k].w;
    if (rs <= 0.) continue;
    float r = length(x - uHole[k].xyz);
    ds = min(ds, min(.2 * r, .05 * rs + .6 * abs(r - rs)));
  }
  // 有厚度的盤：靠近盤面時步子縮小，進到氣體裡面時一步大約一個半厚度
  if (uDisk.z > .5 && uDiskH > 0.) {
    float rho = length(x.xz);
    float H = uDiskH * clamp(rho, uDisk.x, uDisk.y);
    float dR = max(max(uDisk.x - rho, rho - uDisk.y), 0.);      // 離盤所在的那一圈（內外半徑之間）多遠
    float dY = max(abs(x.y) - 2.6 * H, 0.);                     // 離盤的上下表面多遠
    ds = min(ds, max(.9 * H + .04, .7 * length(vec2(dR, dY))));
  }
  return ds * uStepScale;
}

// ── 天空 ──────────────────────────────────────────────
vec3 skyColor(vec3 d, float g, float pix){
  vec3 col = vec3(0.);
  if (uFlags.z > .5) {
    vec3 a = abs(d); vec2 uv; float face;
    if (a.x >= a.y && a.x >= a.z) { uv = d.yz / a.x; face = d.x > 0. ? 0. : 1.; }
    else if (a.y >= a.z) { uv = d.xz / a.y; face = d.y > 0. ? 2. : 3.; }
    else { uv = d.xy / a.z; face = d.z > 0. ? 4. : 5.; }
    // 星表上的星（真的位置、亮度、顏色；js/stars.js）：只讀這個方向所在的那一格
    if (uStarGrid.z > .5) {
      int G = int(uStarGrid.x + .5), K = int(uStarGrid.y + .5);
      ivec2 cell = clamp(ivec2(floor((uv * .5 + .5) * uStarGrid.x)), ivec2(0), ivec2(G - 1));
      int bx = int(face) * G + cell.x, by = cell.y * K;
      float r0 = clamp(1.25 * pix, .0030, .0065);                       // 光暈至少一個多像素寬；上限跟分格時留的邊界一致
      for (int k = 0; k < 32; k++) {
        if (k >= K) break;
        vec4 s = texelFetch(uStars, ivec2(bx, by + k), 0);
        if (s.w <= 0.) break;
        float mag = fract(s.w) * 10. - 2.;
        float dd = length(d - s.xyz) / (r0 * (1. + .5 * max(0., 3. - mag)));   // 越亮光暈越大（js/stars.js 的 haloRadius 是同一個式子）
        if (dd > 1.8) continue;                                              // 分格時也是照 1.8 倍半徑留邊界
        // 亮度壓過：真的星等差 5 等是 100 倍，這裡只差 10 倍，不然螢幕上暗星全看不見
        col += bbColor(floor(s.w) * 250.) * (1.5 * pow(10., -.2 * mag)) * exp(-dd * dd * 2.2);
      }
    }
    // 比星表更暗的星：沒有資料，用亂數補一層很暗的。這一層不是真的星。
    // 做法：把方向放大 N 倍、切成小方塊，每個方塊裡放一顆位置隨機的星，只留落在半徑 N 附近一層薄球殼裡的 ——
    // 這樣在球面上是均勻的（不會看到格子），每個像素看到的也是同一批；再照銀緯篩掉一些，往銀河面集中。
    {
      const float N = 56.;
      vec3 p = d * N, base = floor(p - .5);
      float rad = clamp(1.1 * pix, .0019, .0026);
      for (int i = 0; i < 8; i++) {
        vec3 id = base + vec3(float(i & 1), float((i >> 1) & 1), float((i >> 2) & 1));
        vec3 q = id + hash33(id);
        float rq = length(q);
        if (abs(rq - N) > .35) continue;
        vec3 sd = q / rq;
        float bg = dot(sd, GAL_N);
        if (hash13(id + 7.7) > mix(.22, 1., exp(-bg * bg * 7.))) continue;
        float dd = length(d - sd) / rad;
        if (dd > 2.2) continue;
        float h = hash13(id + 3.1);
        col += bbColor(mix(3500., 11000., hash13(id + 9.4))) * (.03 + .15 * h * h) * exp(-dd * dd * 2.2);
      }
    }
    // 銀河：沿著銀河面的一條亮帶，朝銀河中心那一側比較亮、比較寬
    float b = dot(d, GAL_N);
    float gc = smoothstep(.2, 1., dot(d, GAL_C));
    float band = exp(-b * b * mix(20., 9., gc)) * (1. + 1.3 * gc);
    float cl = fbm3(d * 5. + 3.);
    float dust = smoothstep(.30, .62, fbm3(d * 9. + 11.));
    col += band * (.05 + .30 * cl * cl) * mix(.35, 1., dust) * vec3(.80, .86, 1.);
  }
  if (uFlags.y > .5) {
    float th = acos(clamp(d.y, -1., 1.)), ph = atan(d.z, d.x);
    float D = radians(15.);
    float a1 = abs(fract(th / D + .5) - .5) * D;
    float a2 = abs(fract(ph / D + .5) - .5) * D * sin(th);
    float w = max(.0026, 1.2 * pix);
    float line = 1. - smoothstep(w * .6, w * 1.5, min(a1, a2));
    float quad = floor(ph / 1.5707963 + 2.);
    vec3 hue = .55 + .45 * cos(6.2831853 * (quad / 4. + vec3(0., .33, .67) + (d.y > 0. ? 0. : .125)));
    if (d.y < 0.) hue = mix(hue, vec3(1., .62, .30), .45);
    col += hue * (.38 * line + .003);
  }
  if (uFlags.x > .5) col = shiftColor(col, g);
  return col;
}

// ── 吸積盤（赤道面 y = 0 上、繞 +y 軸順著克卜勒速度轉）────
// uDiskH = 0 ⇒ 沒有厚度的薄盤：光線穿過平面時算一次。
// uDiskH > 0 ⇒ 有厚度的氣體盤，半厚度 H = uDiskH × ρ（越外面越厚）；光線在裡面一小段一小段
//              累積發光與遮擋（體積雲的做法），所以看得到邊緣的絮狀、前後的遮擋。

// 標準薄盤的溫度分布，峰值歸一
float diskTemp(float rho){ float xr = rho / uDisk.x; return pow(xr, -.75) * pow(max(1. - sqrt(1. / xr), 0.), .25) / .488; }

// 盤上 q 這一點的氣體發出、被攝影機收到的顏色。氣體的 4-速度 u = ut (Ω z, 0, −Ω x, 1)，
// g = 觀察到的頻率 / 發出的頻率 = 1 / (p · u)：朝你轉過來的那一側變藍變亮，另一側變紅變暗。
vec3 diskEmission(vec3 q, vec4 p, float rho, float Tn, float pat){
  float I = pow(Tn, 3.0) * (.30 + 1.6 * pat * pat);
  if (uFlags.x > .5) {
    float rs = uHole[0].w;
    float Om = sqrt(.5 * rs / (rho * rho * rho));
    float ut = 1. / sqrt(max(1. - 1.5 * rs / rho, 1e-4));
    float g = 1. / max(ut * (p.w + Om * (p.x * q.z - p.z * q.x)), 1e-4);
    return pow(bbColor(clamp(DISK_TEMP * Tn * g, 1000., 40000.)), vec3(1.6)) * I * pow(g, 4.);
  }
  return pow(bbColor(clamp(DISK_TEMP * Tn, 1000., 40000.)), vec3(1.6)) * I;
}

// 薄盤：回傳 rgb（已乘上不透明度）與不透明度
vec4 diskShade(vec3 hit, vec4 p, float tRay){
  float rho = length(hit.xz);
  float rin = uDisk.x, rout = uDisk.y;
  if (rho < rin || rho > rout) return vec4(0.);
  float Om = sqrt(.5 * uHole[0].w / (rho * rho * rho));
  float ph = atan(hit.z, hit.x);
  float tAbs = uDiskTime + tRay;
  float pat = 0.;
  for (int k = 0; k < 2; k++) {
    float tk = mod(tAbs + float(k) * DISK_T * .5, DISK_T);
    float wk = 1. - abs(2. * tk / DISK_T - 1.);
    float a = (ph + Om * (tk - .5 * DISK_T)) / 6.2831853;
    pat += wk * diskFbm(vec2(a * 16., rho * 1.7 + float(k) * 7.3), 16.);
  }
  vec3 c = diskEmission(hit, p, rho, diskTemp(rho), pat);
  float edge = smoothstep(rin, rin * 1.06, rho) * (1. - smoothstep(rout * .72, rout, rho));
  float alpha = edge * clamp(.50 + .7 * pat, 0., .97);
  return vec4(c * uDisk.w * alpha, alpha);
}

// 體積盤：q 這一點每單位長度擋掉多少光（0 ＝ 這裡沒有氣體），emis 是這裡的氣體顏色
float diskCloud(vec3 q, vec4 p, float tRay, out vec3 emis){
  emis = vec3(0.);
  float rho = length(q.xz);
  float rin = uDisk.x, rout = uDisk.y;
  if (rho < rin || rho > rout) return 0.;
  float H = uDiskH * rho;
  float yn = q.y / H;
  if (abs(yn) > 2.6) return 0.;
  float vert = exp(-.5 * yn * yn);
  float Om = sqrt(.5 * uHole[0].w / (rho * rho * rho));
  float tAbs = uDiskTime + tRay;
  float n = 0.;
  for (int k = 0; k < 2; k++) {
    float tk = mod(tAbs + float(k) * DISK_T * .5, DISK_T);
    float wk = 1. - abs(2. * tk / DISK_T - 1.);
    if (wk < .02) continue;
    float a = Om * (tk - .5 * DISK_T);
    float ca = cos(a), sa = sin(a);
    vec2 xr = vec2(ca * q.x - sa * q.z, sa * q.x + ca * q.z);   // 轉回「跟著氣體一起轉」的座標：內圈轉得快，花紋自然被扯成螺旋
    n += wk * fbm3c(vec3(xr.x * 1.05, yn * 1.1 + float(k) * 5.1, xr.y * 1.05) + 17.);
  }
  float edge = smoothstep(rin, rin * 1.10, rho) * (1. - smoothstep(rout * .70, rout, rho));
  float thr = .33 + .16 * abs(yn);                 // 越往上下越稀、越一塊一塊
  float d = edge * vert * smoothstep(thr, thr + .20, n);
  if (d <= 0.) return 0.;
  // 密的地方比較熱比較亮、稀的絮狀比較暗比較紅：靠這個明暗才看得出一團一團的立體感
  float core = smoothstep(thr + .04, thr + .38, n) * vert;
  emis = diskEmission(q, p, rho, diskTemp(rho) * (.74 + .42 * core), n) * (.50 + 1.0 * core);
  return d * 1.9 / H;
}

#if MAX_BODIES > 0
mat3 cubeRot(float a){
  vec3 n = normalize(vec3(.38, .86, .34)); float c = cos(a), s = sin(a), k = 1. - c;
  return mat3(c + n.x * n.x * k, n.x * n.y * k - n.z * s, n.x * n.z * k + n.y * s,
              n.y * n.x * k + n.z * s, c + n.y * n.y * k, n.y * n.z * k - n.x * s,
              n.z * n.x * k - n.y * s, n.z * n.y * k + n.x * s, c + n.z * n.z * k);
}
vec4 trajAt(int row, float s){
  int i = int(min(floor(s), float(TRAJ_N - 2)));
  float w = s - float(i);
  return mix(texelFetch(uTraj, ivec2(i, row), 0), texelFetch(uTraj, ivec2(i + 1, row), 0), w);
}
vec3 rgb332(uint i){ return vec3(float((i >> 5u) & 7u) / 7., float((i >> 2u) & 7u) / 7., float(i & 3u) / 3.); }
bool shipEmit(uint i){
  uint w = i >> 5u, m = 1u << (i & 31u);
  uint v = w < 4u ? uShipEmit0[w] : uShipEmit1[w - 4u];
  return (v & m) != 0u;
}
/* 飛船的朝向（跟 js/ship.js 的 frame 同一套）：機頭朝座標速度，還沒動起來時朝黑洞；上 ＝ 軌道面法線，
 * 直直掉（沒有軌道面）時取世界 +y。fwd × side = up。 */
void shipFrame(vec3 pos, vec3 vel, out vec3 fwd, out vec3 side, out vec3 up){
  vec3 rel = pos - uHole[0].xyz;
  fwd = length(vel) > 1e-4 ? normalize(vel) : normalize(-rel);
  up = cross(rel, vel);
  if (length(up) < 1e-6 * (length(rel) * length(vel) + 1e-12)) up = vec3(0., 1., 0.);
  up = normalize(up);
  up -= dot(up, fwd) * fwd;
  if (length(up) < 1e-3) up = abs(fwd.y) < .9 ? vec3(0., 1., 0.) : vec3(1., 0., 0.);
  up = normalize(up - dot(up, fwd) * fwd);
  side = cross(up, fwd);
}
/* 引擎噴射（特效，不是模擬）：從每個噴嘴口往 −x 噴出去的一團發光氣體 —— 不擋光，只沿著光線把光加上去。
 * 亮的芯 ＋ 外面一圈藍色的暈，越往後越淡、越粗；芯上有一節一節的亮紋。閃爍照船自己的固有時 tau 走，
 * 所以靠近視界時噴射也跟著慢下來。o、dv：這一小段光線在模型座標（格）裡的起點與位移，只算 s ∈ [s0, s1]。
 * 回傳加上去的顏色；sNear ＝ 這一小段最先碰到噴射外框的位置（沒碰到 ⇒ 2）。 */
vec3 shipPlume(vec3 o, vec3 dv, float s0, float s1, float tau, float jit, int mask, out float sNear){
  vec3 acc = vec3(0.); sNear = 2.;
  float vl = length(dv);
  vec3 dvs = vec3(abs(dv.x) < 1e-9 ? 1e-9 : dv.x, abs(dv.y) < 1e-9 ? 1e-9 : dv.y, abs(dv.z) < 1e-9 ? 1e-9 : dv.z);
  for (int e = 0; e < MAX_ENG; e++) {
    if (e >= uShipEngN) break;
    if (((mask >> e) & 1) == 0) continue;               // 這一具引擎壞了：沒有噴射
    vec4 E = uShipEng[e];
    float Lp = uShipPlume.x * E.w, Rm = uShipPlume.y * E.w;
    vec3 tA = (vec3(E.x - Lp, E.y - Rm, E.z - Rm) - o) / dvs, tB = (vec3(E.x, E.y + Rm, E.z + Rm) - o) / dvs;
    vec3 tmn = min(tA, tB), tmx = max(tA, tB);
    float a = max(max(max(tmn.x, tmn.y), tmn.z), s0), b = min(min(min(tmx.x, tmx.y), tmx.z), s1);
    if (a >= b) continue;
    sNear = min(sNear, a);
    float fe = float(e);
    float flick = .86 + .14 * sin(tau * 29. + fe * 2.1) * sin(tau * 17.3 + fe);
    float dsv = (b - a) * vl * .125;                  // 一個取樣點代表幾格長
    for (int k = 0; k < 8; k++) {
      vec3 q = o + dv * (a + (b - a) * (float(k) + jit) * .125);
      float u = E.x - q.x;                              // 噴嘴口後面多遠（格）
      if (u < 0.) continue;
      float rp = E.w * (1. + .6 * u / Lp);              // 越往後越粗
      float rr = length(q.yz - E.yz) / rp;
      float fall = exp(-2.6 * u / Lp);
      float core = exp(-5. * rr * rr) * (.78 + .22 * cos(6.2832 * u / (1.8 * E.w))) * (1. + 1.4 * exp(-u / (.9 * E.w)));   // 噴嘴口最熱
      float halo = exp(-1.6 * rr * rr);
      acc += (vec3(.80, .95, 1.) * (1.7 * core) + vec3(.20, .46, 1.) * (.75 * halo)) * (fall * flick * dsv);
    }
  }
  return acc * uShipPlume.z;
}
#endif

void main(){
  vec2 uv = (gl_FragCoord.xy * 2. - uRes) / uRes.y;
  float pix = 2. * uTanFov / uRes.y;
  vec3 dl = normalize(vec3(uv * uTanFov, 1.));
  // 從方向 dl 進來的光，動量是 k = e0 − dl；往回追等於用 p = −g k 往前積分
  vec4 p = -uP0 + dl.x * uP1 + dl.y * uP2 + dl.z * uP3;
  vec3 x = uCamPos; float t = 0.;
  vec3 col = vec3(0.); float trans = 1.;
  bool outside = uCamInside < .5;
  int fate = 0;                // 0 步數用完，1 到天空，2 被抓住，3 被東西擋住
  vec3 k1x, k2x, k3x, k4x, k1p, k2p, k3p, k4p; float k1t, k2t, k3t, k4t;

  /* 這道光最後會不會到天空，單一、靜態、不自旋的洞可以直接用守恆量判斷，不必靠數值積分：
   *   能量 E = p.w、角動量 L = (x − 洞) × p 都守恆，撞擊參數 b = |L| / E，臨界值 b_c = (3√3/2) rs。
   *   攝影機在光子球外面（r ≥ 1.5 rs）：b < b_c 而且往回追是朝黑洞走的 ⇒ 來自視界 ⇒ 黑。
   *   攝影機在光子球裡面（含視界內）：只有「E > 0、b < b_c、往回追是往外走的」才是從天空來的，其他都黑。
   *     （E ≤ 0 的光不是從我們這個宇宙掉進來的；b ≥ b_c 的會在光子球以內折返、貼回視界。）
   * blackRay 的光照樣往回追（路上可能先碰到吸積盤或物體），只是追完不准當成天空。
   * 為什麼需要它：往回追的光貼近視界時動量會發散，單精度的 RK4 跨過那一點會算出垃圾，
   *   有些光線就這樣「漏」到天空去（實測：貼著視界外面往下掉時，影子裡會出現一道道白色斑紋）。
   * ⚠ 多洞、會動的洞、自旋都不能這樣判（守恆量不一樣了）；那時 uEnergyTest = 0，只剩數值積分，
   *   貼近視界的畫面會有上面說的漏光，要另外處理。 */
  bool blackRay = false, skip = false, camOuter = true;
  int stepLim = uMaxSteps;
  if (uEnergyTest > .5 && uHole[0].w > 0.) {
    vec3 rel = x - uHole[0].xyz;
    float rs = uHole[0].w, rc = length(rel), bc = 2.598076 * rs;
    vec3 Lv = cross(rel, p.xyz);
    bool small = dot(Lv, Lv) < bc * bc * p.w * p.w;
    rhs(x, p, k1x, k1p, k1t);
    bool outward = dot(rel, k1x) > 0.;
    camOuter = rc >= 1.5 * rs;
    if (camOuter) blackRay = small && !outward;
    else {
      blackRay = !(p.w > 0. && small && outward);
      // 光子球以內沒有吸積盤；沒有物體的話，黑的光線不用追了。有物體就追一小段（看前面有沒有東西），不必追到底
      skip = blackRay;
#if MAX_BODIES > 0
      if (uBodyCount > 0) { skip = false; if (blackRay) stepLim = min(uMaxSteps, 80); }
#endif
    }
  }
  if (skip) fate = 2;
  float sweep = 0.;            // 這道光繞著黑洞轉過的角度（判斷物體的像是直接看到的還是繞過去的）

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= stepLim || skip) break;
    rhs(x, p, k1x, k1p, k1t);
    float ds = stepLen(x);
    float h = ds / max(length(k1x), 1e-6);
    rhs(x + .5 * h * k1x, vec4(p.xyz + .5 * h * k1p, p.w), k2x, k2p, k2t);
    rhs(x + .5 * h * k2x, vec4(p.xyz + .5 * h * k2p, p.w), k3x, k3p, k3t);
    rhs(x + h * k3x, vec4(p.xyz + h * k3p, p.w), k4x, k4p, k4t);
    vec3 x1 = x + h / 6. * (k1x + 2. * k2x + 2. * k3x + k4x);
    vec4 p1 = vec4(p.xyz + h / 6. * (k1p + 2. * k2p + 2. * k3p + k4p), p.w);   // 靜態度規 ⇒ p_t 不變
    float t1 = t + h / 6. * (k1t + 2. * k2t + 2. * k3t + k4t);
    vec3 seg = x1 - x;
    float seg2 = max(dot(seg, seg), 1e-12);

    // 注定到不了天空的光線，路徑的樣子是知道的：攝影機在光子球外 ⇒ 一路往裡走；在光子球內 ⇒ 不會超過 1.5 rs。
    // 一旦違反，就是貼近視界那一步算出了垃圾（見上面的說明）⇒ 到此為止，別讓它亂飛去沾到吸積盤的光。
    if (blackRay) {
      float r0h = length(x - uHole[0].xyz), r1h = length(x1 - uHole[0].xyz);
      if ((camOuter && r1h > r0h + 1e-4) || (!camOuter && r1h > 1.5 * uHole[0].w)) { fate = 2; break; }
    }

    // 這一小段上有沒有撞到物體。物體會動，所以要用「光經過那裡的那一刻」它在哪：
    // 這一小段時間內把物體當成等速直線，相對位置 d(s) = d0 + w s 是 s 的一次式，最近的 s 直接解。
    float sBody = 2.; vec3 bCol = vec3(0.);
    vec3 glowCol = vec3(0.); float glowS = 2.;          // 這一小段上飛船噴射加上去的光、最先碰到噴射的位置
#if MAX_BODIES > 0
    {
      vec3 xm = .5 * (x + x1); float halfLen = .5 * sqrt(seg2);
      float dtS = t1 - t;                                  // 這一小段的時間跨度（負的：往過去走）
      vec3 ra = x - uHole[0].xyz, rb = x1 - uHole[0].xyz;
      float dSweep = atan(length(cross(ra, rb)), dot(ra, rb));
      for (int b = 0; b < MAX_BODIES; b++) {
        if (b >= uBodyCount) break;
        vec4 D = uBodyD[b];
        if (t < D.x || t1 > D.y) continue;                 // 這個物體只可能在某一段時間被看到，這一小段不在裡面
        vec4 C = uBodyC[b];
        vec3 dc = C.xyz - x, pc = dc - seg * clamp(dot(dc, seg) / seg2, 0., 1.);      // 包圍球的球心離這一小段光線多遠
        if (dot(pc, pc) > C.w * C.w) continue;
        vec4 A = uBodyA[b];
        int row = int(A.z + .5) * 4;
        float q0 = clamp((t - A.x) * A.y, 0., float(TRAJ_N - 1));
        float tq = A.x + q0 / A.y;                         // 實際查到的時刻（被夾住時跟 t 不一樣）
        vec4 pb = trajAt(row, q0), ub = trajAt(row + 1, q0);
        float iut = 1. / max(ub.w, 1e-6);
        vec3 vb = ub.xyz * iut;                            // 物體的座標速度 dx/dt
        vec3 d0 = x - (pb.xyz + vb * (t - tq));
        vec3 w = seg - vb * dtS;
        float R = A.w;
        vec4 Bc = uBodyB[b];                               // rgb 顏色；a：種類（見 uBodyB）
        bool cube = Bc.a > 1.5 && Bc.a < 2.5, chunk = Bc.a > 5.5, beam = Bc.a > 4.5 && !chunk;
        bool ship = (Bc.a > 2.5 && Bc.a < 4.5) || chunk, piloted = (Bc.a > 3.5 && Bc.a < 4.5) || chunk;
        if (beam) {
          /* 光束：不是一個點，是「第一顆光子」到「最後一顆光子」之間的一段。晚 dl 出發的那顆光子，此刻在 第一顆的位置 + dl × E
           * （E 在軌跡貼圖的第三列，由 js/bodies.js 的 beamFrame 算好；發射的船在動，所以 E 不是單純的「往後」）。
           * 這一小段光線上的點相對第一顆光子是 d0 + w s，所以要找的是兩條線段最近的地方：s ∈ [0, 1]、dl ∈ [0, 持續多久]。
           * 找到之後再看那顆光子那時候存不存在：還沒出發、或已經到底（打中東西、飛完射程）的就不亮。
           * 最近的地方落在這一小段的外面 ⇒ 留給隔壁那一小段算（不然交界上會加兩次）。光束不擋光，只把光加上去。 */
          vec4 er = trajAt(row + 2, q0);
          float dur = max(D.z, 1e-4), lam = max(er.w, .05);
          vec3 eb = er.xyz * dur;
          float ba = max(dot(w, w), 1e-12), be = max(dot(eb, eb), 1e-12), bb = dot(w, eb), bc = dot(w, d0), bf = dot(eb, d0);
          float den = ba * be - bb * bb;
          float s1 = den > 1e-6 * ba * be ? clamp((bb * bf - bc * be) / den, 0., 1.) : 0.;
          float u = clamp((bb * s1 + bf) / be, 0., 1.);
          float T1 = A.x + float(TRAJ_N - 1) / A.y;
          float ts = t + dtS * clamp(-(bc - bb * u) / ba, 0., 1.);
          float uLo = max(0., (ts - T1) / (lam * dur)), uHi = min(1., (ts - A.x) / dur);
          if (uHi < uLo) continue;
          u = clamp(u, uLo, uHi);
          float sb = -(bc - bb * u) / ba;
          if (sb < 0. || sb >= 1.) continue;
          ts = t + dtS * sb;
          if (ts - u * dur < A.x - .03 || ts - lam * u * dur > T1 + .03) continue;
          vec3 qb = d0 + w * sb - eb * u;
          float d2b = dot(qb, qb);
          float Rc = max(R, .9 * pix * length(x + seg * sb - uCamPos));      // 遠的時候至少畫一個像素寬，亮度照比例降
          if (d2b < 14. * Rc * Rc) {
            float core = exp(-d2b / (Rc * Rc)), halo = exp(-d2b / (5. * Rc * Rc));
            glowCol += (Bc.rgb * (1.5 * core + .30 * halo) + vec3(1.3) * core * core) * pow(R / Rc, .7);
            glowS = min(glowS, sb);
          }
          continue;
        }
        float s = clamp(-dot(d0, w) / max(dot(w, w), 1e-12), 0., 1.);
        vec3 qd = d0 + w * s;
        float d2 = dot(qd, qd);
        if (d2 >= (cube ? 3. : (ship && !chunk ? uShipBound * uShipBound : 1.)) * R * R) continue;   // 立方體、飛船（含噴射）先用外接球粗篩；一塊格子的半徑本來就是包住它的球
        if (uGhost < .5 && sweep + dSweep * s > 3.1616) continue;   // 繞過半圈以上才到的 ＝ 重影
        float sHit = s, face = 1., edge = 0.;
        uint shipIdx = 0u; vec3 shipN = vec3(0.), shipPos = vec3(0.);
        float shipThr = 1., shipFlash = 0.;                // 引擎出力、被打中的閃光（只有種類 4 會變）
        if (ship) {
          /* 飛船：把這一小段光線換進飛船的格子座標（一格 ＝ 2R ÷ nx），沿線走格子（DDA），第一個非空格就是撞到的地方。
           * 走法跟 js/ship.js 的 raycast 一模一樣（顯示卡自我測試拿兩邊的剪影對拍）。
           * 船身沒撞到也還不能走：船尾的噴射在外框外面，要先把它的光加上去。 */
          shipPos = pb.xyz + vb * (t - tq);
          vec3 fw, sd, upv;
          shipFrame(shipPos, vb, fw, sd, upv);
          if (piloted) {
            // 有人開的船：機頭不一定朝飛行方向，朝向是開船的人給的（跟位置一樣，查的是光經過那一刻的朝向）
            vec4 fr = trajAt(row + 2, q0), ur = trajAt(row + 3, q0);
            if (dot(fr.xyz, fr.xyz) > 1e-8) {
              fw = normalize(fr.xyz);
              vec3 u0 = ur.xyz - dot(ur.xyz, fw) * fw;
              if (dot(u0, u0) > 1e-8) upv = normalize(u0); else upv = normalize(upv - dot(upv, fw) * fw);
              sd = cross(upv, fw);
            }
            shipThr = clamp(fr.w, 0., 1.5); shipFlash = clamp(ur.w, 0., 1.);
          }
          vec4 Em = uBodyE[b];
          float kv = Em.w;
          vec3 o = vec3(dot(d0, fw), dot(d0, sd), dot(d0, upv)) / kv + Em.xyz;
          vec3 dv = vec3(dot(w, fw), dot(w, sd), dot(w, upv)) / kv;
          vec3 dvs = vec3(abs(dv.x) < 1e-9 ? 1e-9 : dv.x, abs(dv.y) < 1e-9 ? 1e-9 : dv.y, abs(dv.z) < 1e-9 ? 1e-9 : dv.z);
          vec3 tA = -o / dvs, tB = (uShipDim - o) / dvs;
          vec3 tmn = min(tA, tB), tmx = max(tA, tB);
          float sN = max(max(tmn.x, tmn.y), tmn.z), sF = min(min(min(tmx.x, tmx.y), tmx.z), 1.);
          if (chunk) {
            // 一塊格子只佔船位裡的一小角：只走包住它的那顆球裡面的那一段，不必把整個船位走完
            vec3 oc = o - Em.xyz; float Rv = R / kv;
            float qa = max(dot(dv, dv), 1e-12), qh2 = dot(oc, dv), disc = qh2 * qh2 - qa * (dot(oc, oc) - Rv * Rv);
            if (disc <= 0.) { sN = 2.; sF = -1.; }
            else { float sq = sqrt(disc); sN = max(sN, (-qh2 - sq) / qa); sF = min(sF, (-qh2 + sq) / qa); }
          }
          int ax = 0; float sv = 2.;
          int slot = int(D.z + .5);
          ivec3 dim0 = ivec3(uShipDim + .5);
          ivec3 slotOff = ivec3(0, (slot / SLOT_Z) * dim0.y, (slot - (slot / SLOT_Z) * SLOT_Z) * dim0.z);   // 這艘船的格子在貼圖裡從哪裡開始
          ivec3 stp = ivec3(dvs.x > 0. ? 1 : -1, dvs.y > 0. ? 1 : -1, dvs.z > 0. ? 1 : -1);
          if (!(sN > sF || sF < 0. || max(sN, 0.) >= sBody)) {
            ax = sN > 0. ? (tmn.x >= tmn.y && tmn.x >= tmn.z ? 0 : (tmn.y >= tmn.z ? 1 : 2)) : 0;
            sv = max(sN, 0.);
            ivec3 dimI = ivec3(uShipDim + .5);
            ivec3 cc = clamp(ivec3(floor(o + dv * sv)), ivec3(0), dimI - 1);
            vec3 tMx = (vec3(cc) + vec3(greaterThan(dvs, vec3(0.))) - o) / dvs;
            vec3 tDl = abs(1. / dvs);
            for (int it = 0; it < 400; it++) {
              shipIdx = texelFetch(uShip, cc + slotOff, 0).r;
              if (shipIdx != 0u) break;
              if (tMx.x < tMx.y) { if (tMx.x < tMx.z) { sv = tMx.x; cc.x += stp.x; tMx.x += tDl.x; ax = 0; } else { sv = tMx.z; cc.z += stp.z; tMx.z += tDl.z; ax = 2; } }
              else { if (tMx.y < tMx.z) { sv = tMx.y; cc.y += stp.y; tMx.y += tDl.y; ax = 1; } else { sv = tMx.z; cc.z += stp.z; tMx.z += tDl.z; ax = 2; } }
              if (sv > sF || any(lessThan(cc, ivec3(0))) || any(greaterThanEqual(cc, dimI))) break;
            }
          }
          // 引擎噴射：算到撞到船身（或已經找到的更近的東西）為止；不擋光，所以不動 sBody
          if (uShipPlume.w > .5 && uShipEngN > 0 && shipThr > .02) {
            float sNear;
            vec3 gl = shipPlume(o, dv, 0., min(shipIdx != 0u ? sv : 1., min(sBody, 1.)), pb.w + (t - tq) * iut,
                                hash12(gl_FragCoord.xy + vec2(float(i) * 3.7, float(b) * 11.3)), int(D.w + .5), sNear);
            if (sNear < 1.5) {
              if (uFlags.x > .5) {
                vec4 ps = mix(p, p1, sNear);
                gl = shiftColor(gl, 1. / max(dot(ps.xyz, ub.xyz) + ps.w * ub.w, 1e-4));   // 跟船一起紅移、藍移
              }
              if (piloted) gl *= shipThr * Bc.rgb;       // 出力多少噴多少；敵我用顏色分
              glowCol += gl; glowS = min(glowS, sNear);
            }
          }
          if (shipIdx == 0u) continue;
          sHit = sv;
          shipN = -(ax == 0 ? float(stp.x) * fw : (ax == 1 ? float(stp.y) * sd : float(stp.z) * upv));   // 撞到的那一面朝外的法線（世界座標）
        }
        if (cube) {
          // 立方體：邊長 2R，照它自己的固有時慢慢自轉。把相對位置轉進立方體的座標，跟六個面求交。
          mat3 M = cubeRot((pb.w + (t - tq) * iut) * CUBE_SPIN + A.z * 1.7);
          vec3 o = M * d0, dv = M * w;
          vec3 dvs = vec3(abs(dv.x) < 1e-9 ? 1e-9 : dv.x, abs(dv.y) < 1e-9 ? 1e-9 : dv.y, abs(dv.z) < 1e-9 ? 1e-9 : dv.z);
          vec3 tA = (-R - o) / dvs, tB = (R - o) / dvs;
          vec3 tmn = min(tA, tB), tmx = max(tA, tB);
          float sN = max(max(tmn.x, tmn.y), tmn.z), sF = min(min(tmx.x, tmx.y), tmx.z);
          if (sN > sF || sF < 0. || sN > 1.) continue;
          sHit = max(sN, 0.);
          vec3 hp = abs(o + dv * sHit) / R;                // 打到的點；打在哪個面，那個軸就 ≈ 1
          float m1 = max(max(hp.x, hp.y), hp.z);
          float m2 = hp.x + hp.y + hp.z - m1 - min(min(hp.x, hp.y), hp.z);
          edge = smoothstep(.84, .97, m2);                 // 靠近稜線
          face = hp.x >= m1 - 1e-4 ? 1. : (hp.y >= m1 - 1e-4 ? .78 : .58);   // 三組面亮度不同，才看得出是立方體
        }
        if (sHit >= sBody) continue;
        float th = t + dtS * sHit;
        float qh = (th - A.x) * A.y;
        if (qh < 0. || qh > float(TRAJ_N - 1)) continue;   // 那一刻它還沒出發，或已經到底了
        vec3 c;
        bool blink = true;
        if (Bc.a > .5 && Bc.a < 1.5) {
          float mu = sqrt(max(0., 1. - d2 / (R * R)));
          c = Bc.rgb * (.5 + 1.6 * mu * mu);               // 光子只是標記，不做紅移
        } else {
          if (ship) {
            // 飛船不會自己發光（引擎、燈、舷窗除外）：照亮它的是吸積盤 ⇒ 朝黑洞那一面亮；另外留一點環境光，背光面才看得出形狀
            vec3 alb = rgb332(shipIdx);
            if (piloted) alb *= Bc.rgb;
            if (shipEmit(shipIdx)) c = alb * 2.2;
            else {
              vec3 Ld = normalize(uHole[0].xyz - shipPos);
              c = alb * (.24 + .95 * max(dot(shipN, Ld), 0.) + .10 * max(dot(shipN, -Ld), 0.));
            }
            blink = shipIdx == 224u || shipIdx == 28u || shipIdx == 254u;   // 只有航行燈照船上的鐘閃
            if (piloted) c = mix(c, vec3(2.6, 2.1, 1.3), shipFlash);
          }
          else if (cube) c = Bc.rgb * face * (.80 + .45 * edge) + vec3(.35) * edge;
          else c = Bc.rgb * (.30 + .70 * sqrt(max(0., 1. - d2 / (R * R))));
          if (uFlags.w > .5 && blink) {
            float bp = fract((pb.w + (th - tq) * iut) / uBeaconPeriod);   // 照物體自己的固有時閃
            c *= .45 + 1.5 * smoothstep(0., .06, bp) * (1. - smoothstep(.22, .40, bp));
          }
          if (uFlags.x > .5) {
            vec4 ps = mix(p, p1, sHit);
            c = shiftColor(c, 1. / max(dot(ps.xyz, ub.xyz) + ps.w * ub.w, 1e-4));
          }
        }
        sBody = sHit; bCol = c;
      }
      sweep += dSweep;
    }
#endif

    // 吸積盤：只算到物體前面為止（物體不透明）
    float sEnd = min(1., sBody);
    // 噴射在擋住它的東西前面才加（不透明度不動）；同一小段裡跟吸積盤誰前誰後不分 —— 貼近盤面時一小段很短，差不出來
    if (glowS < sEnd) col += trans * glowCol;
    if (uDisk.z > .5) {
      if (uDiskH <= 0.) {
        if (x.y * x1.y < 0.) {
          float s = x.y / (x.y - x1.y);
          if (s < sEnd) {
            vec4 dCol = diskShade(x + seg * s, mix(p, p1, s), mix(t, t1, s));
            col += trans * dCol.rgb; trans *= 1. - dCol.a;
          }
        }
      } else {
        float r0 = length(x.xz), r1 = length(x1.xz);
        float hmax = 2.6 * uDiskH * max(r0, r1);
        bool miss = (min(r0, r1) > uDisk.y) || (max(r0, r1) < uDisk.x * .9) || (x.y * x1.y > 0. && min(abs(x.y), abs(x1.y)) > hmax);
        if (!miss) {
          float len = sqrt(seg2) * sEnd;
          float Hl = max(uDiskH * .5 * (r0 + r1), 1e-3);
          int nS = int(clamp(ceil(len / (.65 * Hl)), 1., 4.));
          float dlen = len / float(nS);
          float jit = hash12(gl_FragCoord.xy + float(i) * 7.13);
          for (int j = 0; j < 4; j++) {
            if (j >= nS) break;
            float s = (float(j) + jit) / float(nS) * sEnd;
            vec3 em;
            float kap = diskCloud(x + seg * s, mix(p, p1, s), mix(t, t1, s), em);
            if (kap > 0.) {
              float a = 1. - exp(-kap * dlen);
              col += trans * a * em * uDisk.w; trans *= 1. - a;
            }
          }
        }
      }
    }
    if (sBody < 1.5) { col += trans * bCol; trans = 0.; }
    if (trans < .01) { fate = 3; break; }

    // 貼到視界：從外面往回追的光不可能真的進到視界裡（沒有東西出得來），貼上去就是黑
    bool cap = false; float minRatio = 1e9;
    for (int k = 0; k < MAX_HOLES; k++) {
      if (k >= uHoleCount) break;
      float rs = uHole[k].w;
      if (rs <= 0.) continue;
      float rr = length(x1 - uHole[k].xyz) / rs;
      minRatio = min(minRatio, rr);
      if (rr < 1. + EPS_H && outside) cap = true;
    }
    if (cap) { fate = 2; break; }
    if (!outside && minRatio > 1. + 2. * EPS_H) outside = true;   // 攝影機在視界內：光線往回追會先走出視界
    if (!(dot(p1.xyz, p1.xyz) < 1e9)) { fate = 2; break; }         // 動量爆掉 ＝ 卡在視界上

    x = x1; p = p1; t = t1;
    if (dot(x, x) > uFar * uFar && dot(x, seg) > 0.) { fate = 1; break; }
  }

  if (blackRay && fate != 3) fate = 2;      // 守恆量說它到不了天空：數值上就算「逃走」了也不算
  if (uDebug == 1) {
    outColor = vec4(fate == 1 ? vec3(1.) : (fate == 0 ? vec3(1., 0., 0.) : vec3(0.)), 1.);
    return;
  }
  if (fate == 1) {
    vec3 dx, dp; float dt;
    rhs(x, p, dx, dp, dt);
    // 天空上的光源相對遠處靜止 ⇒ g = 1 / p_t
    col += trans * skyColor(normalize(dx), 1. / max(p.w, 1e-4), pix);
  }
  // 壓亮度時保住色相：照最亮的那個色頻壓，很亮的地方才慢慢往白靠
  float peak = max(max(col.r, col.g), max(col.b, 1e-6)) * uExposure;
  col = col * uExposure * ((1. - exp(-peak)) / peak);
  col = mix(col, vec3(1.), .55 * smoothstep(2.5, 9., peak));
  col = pow(col, vec3(1. / 2.2));
  col += (hash12(gl_FragCoord.xy) - .5) / 255.;
  outColor = vec4(col, 1.);
}
`;

  root.BH = root.BH || {};
  root.BH.Shader = { vert: VERT, frag: frag };
})(typeof window !== 'undefined' ? window : globalThis);
