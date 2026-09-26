'use strict';

/* 端到端冒烟测试：启动真实服务（临时数据目录），验证：
 * 1) 特殊道具名「__proto__」按普通文本值贯穿 增/查/提示/试排预览/重放/删除；
 * 2) 表单试排预览对已删除道具/区位的草稿明确报错，不悄悄改用首项（服务端兜底）。
 */
process.env.DATA_DIR = '/tmp/stage-test-data';
process.env.PORT = '3210';

const fs = require('fs');
fs.rmSync('/tmp/stage-test-data', { recursive: true, force: true });

const spawn = require('child_process');
// 直接在同进程 require，server.js 启动时会监听 3210
require('../server');

const BASE = 'http://localhost:3210';

async function call(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log('  ✓', msg);
  } else {
    failures++;
    console.error('  ✗', msg);
  }
}

(async () => {
  // 等待监听就绪
  await new Promise((r) => setTimeout(r, 300));

  console.log('特殊名称「__proto__」道具：');
  let r = await call('/api/props', 'POST', { name: '__proto__', location: '后台' });
  check(r.status === 200, `POST /api/props __proto__ -> 200（实际 ${r.status} ${r.data.error || ''}）`);
  check(
    r.data.props.some((p) => p.name === '__proto__' && p.location === '后台'),
    '返回的最新道具名单含「__proto__」（未被原型链吞掉）'
  );

  // 同名重复应被拒绝（证明它按普通唯一键处理，而不是特殊保留名）
  r = await call('/api/props', 'POST', { name: '__proto__', location: '后台' });
  check(r.status === 409, `重复添加「__proto__」-> 409（实际 ${r.status}）`);

  console.log('用「__proto__」录入提示 50 并试排预览：');
  // 选一个在示例数据重放终态空闲的普通区位（20 号后桌子停在上场门，舞台中央空闲）
  const draft = {
    number: 50,
    note: '特殊名称',
    transfers: [{ prop: '__proto__', from: '后台', to: '舞台中央' }],
  };
  r = await call('/api/cues/preview', 'POST', draft);
  check(r.status === 200, `试排预览含 __proto__ 的草稿 -> 200（实际 ${r.status} ${r.data.error || ''}）`);
  const hypo = r.data.hypothetical;
  check(hypo != null && Array.isArray(hypo.results), '预览返回假设序列重放结果');
  // 示例数据中舞台中央被屏风占用（10 号互换所致），先确认 __proto__ 作为普通道具
  // 参与了整组容量校验（错误信息必须点名，而不是报「不存在」或原型异常）
  const g50prev = hypo.results.find((x) => x.number === 50);
  check(g50prev.transfers[0].prop === '__proto__', '假设序列中原样保留道具名「__proto__」');
  check(
    g50prev.errors.every((e) => !/不存在/.test(e)),
    '预览不把「__proto__」判为不存在（按普通文本值参与校验）'
  );
  check(
    Object.keys(hypo.finalState).includes('__proto__'),
    'JSON 往返后 finalState 仍含数据键「__proto__」（未被原型链吞掉）'
  );

  // 改用终态空闲的上场门作为目标，提示应整组生效
  const draftOk = {
    number: 50,
    note: '特殊名称',
    transfers: [{ prop: '__proto__', from: '后台', to: '上场门' }],
  };
  r = await call('/api/cues/preview', 'POST', draftOk);
  const g50ok = r.data.hypothetical.results.find((x) => x.number === 50);
  check(g50ok && g50ok.ok, '目标改为空闲的上场门后，假设序列中提示 50 整组生效（__proto__ 按普通道具转移）');
  check(
    Object.prototype.hasOwnProperty.call(r.data.hypothetical.finalState, '__proto__') &&
      r.data.hypothetical.finalState['__proto__'] === '上场门',
    '重放终态以数据键保存「__proto__」-> 上场门'
  );

  r = await call('/api/cues', 'POST', draftOk);
  check(r.status === 200, `保存提示 50 -> 200（实际 ${r.status} ${r.data.error || ''}）`);
  r = await call('/api/state');
  const cue50 = r.data.cues.find((c) => c.number === 50);
  check(cue50 && cue50.transfers[0].prop === '__proto__', 'GET /api/state 中提示 50 的转移道具为「__proto__」');
  const rep50 = r.data.replay.results.find((x) => x.number === 50);
  check(rep50 && rep50.ok, '全量重放中提示 50 生效');
  check(
    Object.prototype.hasOwnProperty.call(r.data.replay.finalState, '__proto__') &&
      r.data.replay.finalState['__proto__'] === '上场门',
    '全量重放终态「__proto__」-> 上场门'
  );

  console.log('删除「__proto__」后，表单草稿引用它必须明确报错（不得静默改首项）：');
  r = await call('/api/props/__proto__', 'DELETE');
  check(r.status === 200, `DELETE /api/props/__proto__ -> 200（实际 ${r.status}）`);
  r = await call('/api/cues/preview', 'POST', draft);
  check(r.status === 400 && /道具「__proto__」不存在/.test(r.data.error),
    `试排预览引用已删道具 -> 400 且明确点名（实际 ${r.status}: ${r.data.error}）`);

  console.log('引用已删除区位的草稿同样明确报错：');
  // 「侧台」示例数据中无道具、无转移引用，可直接删除
  r = await call('/api/locations/侧台', 'DELETE');
  check(r.status === 200, `删除区位「侧台」-> 200（实际 ${r.status} ${r.data.error || ''}）`);
  r = await call('/api/cues/preview', 'POST', {
    number: 60,
    note: '',
    transfers: [{ prop: '桌子', from: '舞台中央', to: '侧台' }],
  });
  check(r.status === 400 && /目标区位「侧台」不存在/.test(r.data.error),
    `试排预览引用已删区位 -> 400 且明确点名（实际 ${r.status}: ${r.data.error}）`);

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
