'use strict';

/**
 * 换景通道临时封闭影响评估（纯函数，**不写库、不改任何通道或提示**）。
 *
 * 舞台监督想评估「若某条现有通道临时封闭（如检修、被景片占用），哪些
 * 生效提示的换景线路会受影响」。本模块的做法：
 *  1. 现状：用现有全部通道对全部**重放生效**提示逐组联合寻路
 *     （computeRouting：简单路径枚举 + MRV 回溯，含端点不连通 / 通道争用
 *     诊断与路径规模上限保护）；
 *  2. 假设：**仅在内存中**从通道列表移除指定通道，对同样的生效提示重新
 *     逐组联合寻路——完全复用 routing.js 的求解与诊断语义，端点不连通、
 *     通道争用与求解规模上限的判定口径与常规通道规划一致；
 *  3. 按提示号配对前后结果并分类：
 *     - ok：原本可行，封闭后仍可行（线路可能已改走绕行路径，完整列出）；
 *     - new_blocked：**原本可行、封闭后不可行**（端点不连通或通道争用）
 *       ——只有这类计为「新增阻断」；
 *     - unknown：原本可行，但封闭后简单路径枚举超上限（未计算）——不能
 *       断定封闭后是否可行，单独标明、**不计入**新增阻断；
 *     - already_blocked：原本就无解（端点不连通 / 通道争用）或原本就因
 *       规模上限未计算——单独标明，并非本次封闭造成，不计入新增阻断。
 *
 * 单调性说明：移除通道只会减少可选路径，原本无解的提示封闭后必然仍无解，
 * 因此不存在「原本无解、封闭后反而可行」的分类。
 *
 * 失败（未生效）的提示不参与评估（整组不执行，谈不上占用通道），仅回显条数。
 *
 * @module closure
 */

const { computeRouting, edgeKey } = require('./routing');

/** 通道端点规范化（与落库口径一致：字典序小的区位在前） */
function normalizePassage(a, b) {
  return a < b ? [a, b] : [b, a];
}

/**
 * 临时封闭影响评估主入口。
 *
 * @param {Array<{name:string}>} locations 全部区位（含无通道的孤立区位）
 * @param {Array<{loc_a:string, loc_b:string}>} passages 现有无向通道
 * @param {Array<{number:number, note:string, transfers:Array}>} cues 已按提示号升序
 * @param {Array<{number:number, ok:boolean}>} results 全量重放结果（replay().results）
 * @param {{a:string, b:string}} closed 要临时封闭的现有通道（端点无序；调用方保证其存在）
 * @returns {Object} 评估结果：
 *   - status：'empty'（无生效提示）/ 'ok'；
 *   - closed：规范化后的封闭通道 {a, b}；
 *   - groups[]：逐提示对照 {number, note, category, before, after}，category 取值
 *     'ok' / 'new_blocked' / 'unknown' / 'already_blocked'；before / after 结构同
 *     computeRouting 的组（after 为 ok 时含完整线路 routes）；
 *   - summary：{total, ok, newBlocked, unknown, alreadyBlocked}；
 *   - effectiveCueCount / skippedCueCount（失败提示数）。
 */
function computeClosureImpact(locations, passages, cues, results, closed) {
  const [a, b] = normalizePassage(String(closed.a), String(closed.b));
  const closedKey = edgeKey(a, b);

  // 1) 现状逐组线路（现有全部通道）
  const baseline = computeRouting(locations, passages, cues, results);

  // 2) 仅在内存中移除该通道，对全部生效提示重新做整组联合寻路
  const remaining = passages.filter((p) => edgeKey(p.loc_a, p.loc_b) !== closedKey);
  const hypothetical = computeRouting(locations, remaining, cues, results);

  // 3) 按提示号配对分类（两侧都只对生效提示逐组求解，提示号集合必然一致）
  const afterByNumber = new Map(hypothetical.groups.map((g) => [g.number, g]));
  const groups = baseline.groups.map((before) => {
    const after = afterByNumber.get(before.number) || null;
    let category;
    if (before.status === 'ok') {
      if (after && after.status === 'ok') category = 'ok';
      else if (after && after.status === 'limited') category = 'unknown';
      else category = 'new_blocked';
    } else {
      category = 'already_blocked';
    }
    return { number: before.number, note: before.note, category, before, after };
  });

  const summary = { total: groups.length, ok: 0, newBlocked: 0, unknown: 0, alreadyBlocked: 0 };
  for (const g of groups) {
    if (g.category === 'ok') summary.ok += 1;
    else if (g.category === 'new_blocked') summary.newBlocked += 1;
    else if (g.category === 'unknown') summary.unknown += 1;
    else summary.alreadyBlocked += 1;
  }

  return {
    status: groups.length === 0 ? 'empty' : 'ok',
    closed: { a, b },
    groups,
    effectiveCueCount: baseline.effectiveCueCount,
    skippedCueCount: baseline.skippedCueCount,
    summary,
  };
}

module.exports = { computeClosureImpact };
