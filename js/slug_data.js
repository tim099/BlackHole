/* 由 tools/ship_pack.py 產生 —— 不要手改（改雕刻作品，再重新匯出、重新封）。
 * 來源：雕刻作品 claude-afterglow-slug（動能彈），每格 0.1 m，外框 20×9×9 格，非空 332 格。
 * 格式：rle ＝ base64 的一串 (色號 1 byte, 連續幾格 varint)，照 x 最快、再 y、再 z；fnv ＝ 每個非空格 (一維位置 4 byte LE, 色號) 的 FNV-1a 32。
 * engines ＝ 從格子找到的引擎（噴嘴口 x、中心 y z、半徑 r，裁過的座標、單位格；噴射往 −x）。 */
(function (root) {
  'use strict';
  var D = {"name": "動能彈", "work": "claude-afterglow-slug", "listSha256": "f8d7c0a40347f2b260d8246a07a75a497dc25f53274dd3f5e66d9e0ed54e12bc", "metersPerVoxel": 0.1, "dims": [20, 9, 9], "origin": [0, 1, 1], "count": 332, "fnv": 2157138036, "runs": 232, "emissive": [191, 83, 224, 28, 254, 248], "engines": []};
  D.rle = 'AFBJAwCxAUkEAJwBSQJtAvABbQJJAW0C8AFtAgAHSQJtAvABbQJJAW0C8AFtAgAHSQJtAvABbQJJAW0C8AFtAgBrSQJtAvABbQJJAW0C8AFtAgAH+AFJAW0C8AFtAkkBbQLwAW0C7AElAQAF+AFJAW0C8AFtAkkBbQLwAW0C7AElAwAD+AFJAW0C8AFtAkkBbQLwAW0C7AElAQAFSQJtAvABbQJJAW0C8AFtAgAvSQMAEUkEABBJAm0C8AFtAkkBbQLwAW0CAAf4AUkBbQLwAW0CSQFtAvABbQLsASUDAAP4AUkBbQLwAW0CSQFtAvABbQLsASUG+AFJAW0C8AFtAkkBbQLwAW0C7AElAwADSQJtAvABbQJJAW0C8AFtAgAHSQQAEEkDADlJAm0C8AFtAkkBbQLwAW0CAAf4AUkBbQLwAW0CSQFtAvABbQLsASUBAAX4AUkBbQLwAW0CSQFtAvABbQLsASUDAAP4AUkBbQLwAW0CSQFtAvABbQLsASUBAAVJAm0C8AFtAkkBbQLwAW0CAGtJAm0C8AFtAkkBbQLwAW0CAAdJAm0C8AFtAkkBbQLwAW0CAAdJAm0C8AFtAkkBbQLwAW0CAJMBSQQAsAFJAwBh';
  root.BH = root.BH || {};
  root.BH.SlugData = D;
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
})(typeof window !== 'undefined' ? window : globalThis);
