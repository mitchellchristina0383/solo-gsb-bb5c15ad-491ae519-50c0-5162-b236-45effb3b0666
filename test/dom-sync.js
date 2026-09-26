'use strict';

/* 前端转移行下拉同步逻辑测试：用最小 DOM 垫片加载真实的 public/app.js，
 * 验证状态刷新时 syncTransferRows 的行为（不依赖浏览器）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else {
    failures++;
    console.error('  ✗', msg);
  }
}

/* ---------------- 最小 DOM 垫片 ---------------- */

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/* 模拟 <select>：值跟随带 selected 的 option；没有则为空串 */
function syncSelectValue(sel) {
  const marked = sel.childNodes.find((o) => o.tagName === 'OPTION' && o.selected);
  sel._value = marked ? marked.value : '';
}

function makeElement(tag) {
  const isSelect = String(tag || '').toLowerCase() === 'select';
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    childNodes: [],
    parentNode: null,
    nextElementSibling: null,
    _innerHTML: '',
    textContent: '',
    _value: '',
    disabled: false,
    className: '',
    dataset: {},
    _listeners: Object.create(null),
    classList: {
      _own() { return new Set((el.className || '').split(/\s+/).filter(Boolean)); },
      add(c) {
        const s = this._own();
        s.add(c);
        el.className = [...s].join(' ');
      },
      remove(c) {
        const s = this._own();
        s.delete(c);
        el.className = [...s].join(' ');
      },
      toggle(c, force) {
        const want = force === undefined ? !this._own().has(c) : !!force;
        want ? this.add(c) : this.remove(c);
        return want;
      },
      contains(c) { return this._own().has(c); },
    },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(html) {
      this._innerHTML = html;
      const roots = parseHTML(html, this);
      this.childNodes = roots;
      relink(this);
      if (isSelect) {
        // 模拟 <select>：值跟随带 selected 的 option；没有则为空串
        const marked = this.childNodes.find((o) => o.tagName === 'OPTION' && o.selected);
        this._value = marked ? marked.value : '';
      }
    },
    get children() { return this.childNodes; },
    get value() { return this._value; },
    set value(v) {
      if (isSelect) {
        // 模拟 <select>.value = x：存在同值 option（含失效占位项）即生效；
        // 对空 select 的直接赋值（测试手工模拟用户选择）同样接受
        if (!this.childNodes.some((o) => o.tagName === 'OPTION') ||
            this.childNodes.some((o) => o.tagName === 'OPTION' && o.value === v)) {
          this._value = v;
        }
      } else {
        this._value = v;
      }
    },
    appendChild(node) {
      node.parentNode = this;
      this.childNodes.push(node);
      relink(this);
      if (isSelect) syncSelectValue(this);
      return node;
    },
    insertBefore(node, ref) {
      node.parentNode = this;
      const i = this.childNodes.indexOf(ref);
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
      relink(this);
      if (isSelect) syncSelectValue(this);
      return node;
    },
    remove() {
      if (!this.parentNode) return;
      const p = this.parentNode;
      const i = p.childNodes.indexOf(this);
      if (i >= 0) p.childNodes.splice(i, 1);
      relink(p);
      this.parentNode = null;
    },
    querySelector(sel) { return querySelectorAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return querySelectorAll(this, sel); },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matchSelector(cur, sel)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    },
    dispatch(type, ev = {}) {
      ev.target ||= this;
      // 模拟事件冒泡：沿 parentNode 链逐级触发监听
      let cur = this;
      while (cur) {
        (cur._listeners[type] || []).forEach((fn) => fn(ev));
        cur = cur.parentNode;
      }
    },
    scrollTo() {},
  };
  return el;
}

function relink(parent) {
  parent.childNodes.forEach((n, i) => {
    n.parentNode = parent;
    n.nextElementSibling = parent.childNodes[i + 1] || null;
    n.nextSibling = parent.childNodes[i + 1] || null;
  });
}

/* 极简 HTML 解析：只需还原 <td><select><option>/<button> 等嵌套结构与 class/id/value */
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^<>"]*(?:"[^"]*"[^<>"]*)*)*?)\s*(\/?)>/g;
const VOID_TAGS = new Set(['br', 'input', 'img', 'hr', 'meta', 'link']);

function parseAttrs(str) {
  const out = {};
  const re = /([\w-]+)(?:\s*=\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(str))) {
    if (m[1]) out[m[1]] = m[2] !== undefined ? decodeEntities(m[2]) : true;
  }
  return out;
}

function parseHTML(html, rootParent) {
  const stack = [];
  const roots = [];
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    const text = html.slice(last, m.index);
    if (text.trim() && stack.length) {
      stack[stack.length - 1]._directText += decodeEntities(text);
    }
    last = TAG_RE.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2];
    const attrs = m[3] || '';
    const selfClose = m[4] === '/';
    if (closing) {
      stack.pop();
      continue;
    }
    const node = makeElement(tag);
    const a = parseAttrs(attrs);
    if (a.class) node.className = a.class;
    if (a.id) node.id = a.id;
    if ('value' in a) node.value = a.value;
    node.selected = !!a.selected;
    node._directText = '';
    Object.assign(node.dataset, Object.fromEntries(
      Object.entries(a)
        .filter(([k]) => k.startsWith('data-'))
        .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])
    ));
    const parent = stack[stack.length - 1];
    if (parent) parent.appendChild(node);
    else roots.push(node);
    node.parentNode = parent || rootParent;
    if (!selfClose) stack.push(node);
    else node.textContent = node._directText;
  }
  // 收尾：把各节点直接文本写入 textContent（option 标签文本等）
  const finish = (n) => {
    if (n._directText !== undefined) n.textContent = n._directText.trim();
    n.childNodes.forEach(finish);
  };
  roots.forEach(finish);
  return roots;
}

function matchSelector(el, sel) {
  let rest = sel;
  const tagMatch = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[0].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  const ids2 = [];
  const classes = [];
  const tok = /([#.])([\w-]+)/g;
  let m;
  while ((m = tok.exec(rest))) (m[1] === '#' ? ids2 : classes).push(m[2]);
  if (ids2.some((i) => el.id !== i)) return false;
  const own = el.className.split(/\s+/);
  return classes.every((c) => own.includes(c));
}

function walk(el, out) {
  for (const ch of el.childNodes) {
    out.push(ch);
    walk(ch, out);
  }
  return out;
}

function querySelectorAll(root, sel) {
  return walk(root, []).filter((e) => matchSelector(e, sel));
}

/* ---------------- 构建页面骨架并加载 app.js ---------------- */

const ids = Object.create(null);
// 关键容器在真实页面中的父子关系（事件冒泡依赖）
const SHIM_PARENTS = {
  'transfer-rows': 'cue-form',
  'absence-rows': 'absence-form',
  'sim-rows': 'sim-form',
};
function byId(id) {
  if (!ids[id]) {
    const el = makeElement('div');
    el.id = id;
    ids[id] = el;
    if (SHIM_PARENTS[id]) el.parentNode = byId(SHIM_PARENTS[id]);
  }
  return ids[id];
}

const documentShim = {
  querySelector: (sel) => (sel.startsWith('#') ? byId(sel.slice(1)) : null),
  createElement: (tag) => makeElement(tag),
};

const ctx = {
  document: documentShim,
  console,
  fetch: () => new Promise(() => {}), // 永不 resolve：避免初始 /api/state 覆盖测试状态
  setTimeout,
  clearTimeout,
};
vm.createContext(ctx);

const appCode = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
vm.runInContext(appCode, ctx);

const run = (code) => vm.runInContext(code, ctx);

/* ---------------- 测试辅助 ---------------- */

function optionValues(sel) {
  return sel.children.map((o) => o.value);
}

function baseState(extra) {
  return {
    locations: [
      { name: '后台', unlimited: true },
      { name: '舞台中央', unlimited: false },
      { name: '上场门', unlimited: false },
    ],
    props: [
      { name: '桌子', location: '舞台中央' },
      { name: '屏风', location: '后台' },
    ],
    cues: [],
    replay: { results: [], finalLocations: {} },
    staff: [],
    assignments: [],
    rotation: { status: 'empty', summary: {}, effectiveCueNumbers: [] },
    passages: [],
    routing: { status: 'empty', summary: { total: 0 }, groups: [] },
    ...extra,
  };
}
const setState = (s) => run(
  'state = JSON.parse(' + JSON.stringify(JSON.stringify(baseState(s))) + ')'
);
const renderAll = () => run('render()');

/* ---------------- 场景 ---------------- */

console.log('场景 1：表单打开时已有一行（选中桌子），新增道具 __proto__ 后立即可选');
setState();
run('resetCueForm()');
const tbody = ids['transfer-rows'];
let rows = tbody.querySelectorAll('tr.t-row');
check(rows.length === 1, '初始只有一条空转移行');
rows[0].querySelector('.t-prop').value = '桌子';
rows[0].querySelector('.t-from').value = '后台';
rows[0].querySelector('.t-to').value = '上场门';

setState({
  props: [
    { name: '桌子', location: '舞台中央' },
    { name: '屏风', location: '后台' },
    { name: '__proto__', location: '后台' },
  ],
});
renderAll();
rows = tbody.querySelectorAll('tr.t-row');
check(rows.length === 1, '状态刷新后行数不变（行顺序、行数保留）');
const propSel0 = rows[0].querySelector('.t-prop');
check(propSel0.value === '桌子', '道具下拉仍保留原选择「桌子」（未跳首项）');
check(optionValues(propSel0).includes('__proto__'), '道具下拉立即出现新道具「__proto__」');
check(optionValues(propSel0).includes('桌子'), '道具下拉仍含旧道具「桌子」');
check(rows[0].querySelector('.t-to').value === '上场门', '目标区位下拉保留原选择「上场门」');
check(!propSel0.classList.contains('t-invalid'), '原选择有效，无失效标记');
check(run('editingCue') === null, '新增模式的编辑状态保留');

console.log('场景 2：两行顺序与各自选择都保留（新增区位「侧台」），新增项可用于试排');
run('addTransferRow()');
rows = tbody.querySelectorAll('tr.t-row');
check(rows.length === 2, '添加到两条转移行');
rows[1].querySelector('.t-prop').value = '屏风';
rows[1].querySelector('.t-from').value = '上场门';
rows[1].querySelector('.t-to').value = '后台';
setState({
  locations: [
    { name: '后台', unlimited: true },
    { name: '舞台中央', unlimited: false },
    { name: '上场门', unlimited: false },
    { name: '侧台', unlimited: false },
  ],
  props: [
    { name: '桌子', location: '舞台中央' },
    { name: '屏风', location: '后台' },
    { name: '__proto__', location: '后台' },
  ],
});
renderAll();
rows = tbody.querySelectorAll('tr.t-row');
check(rows.length === 2, '刷新后仍是两行（行顺序保留）');
check(rows[0].querySelector('.t-prop').value === '桌子', '第 1 行道具仍是「桌子」');
check(rows[1].querySelector('.t-prop').value === '屏风', '第 2 行道具仍是「屏风」');
check(
  rows[0].querySelector('.t-to').value === '上场门' && rows[1].querySelector('.t-to').value === '后台',
  '两行的目标区位各自保留，未串行'
);
check(optionValues(rows[0].querySelector('.t-from')).includes('侧台'), '来源下拉立即出现新区位「侧台」，可立即用于试排');

console.log('场景 3：原选择的道具被删除 → 明确标出失效值，不悄悄改用首项');
// 第 1 行改用新道具「__proto__」，随后它被删除：行内必须保留并标出失效值
rows[0].querySelector('.t-prop').value = '__proto__';
rows[0].querySelector('.t-prop').dispatch('change');
setState({
  locations: [
    { name: '后台', unlimited: true },
    { name: '舞台中央', unlimited: false },
    { name: '上场门', unlimited: false },
    { name: '侧台', unlimited: false },
  ],
  props: [
    { name: '桌子', location: '舞台中央' },
    { name: '屏风', location: '后台' }, // __proto__ 被删除
  ],
});
renderAll();
rows = tbody.querySelectorAll('tr.t-row');
const stalePropSel = rows[0].querySelector('.t-prop');
check(stalePropSel.value === '__proto__', '失效行的值仍是「__proto__」（未被替换成首项「桌子」）');
check(stalePropSel.classList.contains('t-invalid'), '失效的道具下拉带失效样式标记');
check(/已失效：道具已删除/.test(stalePropSel.innerHTML), '失效下拉含「已失效：道具已删除」标注选项');
const warn0 = rows[0].nextElementSibling;
check(
  warn0 && warn0.classList.contains('t-stale-row') &&
    /道具「__proto__」已删除/.test(warn0.querySelector('.t-stale-warn').textContent),
  '行内提示行明确标出失效道具「__proto__」'
);

console.log('场景 4：失效来源/目标区位同样标出；试排与保存被前端拦截');
setState({
  locations: [
    { name: '后台', unlimited: true },
    { name: '舞台中央', unlimited: false },
    // 上场门、侧台被删除
  ],
  props: [
    { name: '桌子', location: '舞台中央' },
    { name: '屏风', location: '后台' },
  ],
});
renderAll();
rows = tbody.querySelectorAll('tr.t-row');
check(rows[0].querySelector('.t-from').value === '后台', '第 1 行来源「后台」保留且有效');
check(rows[0].querySelector('.t-to').value === '上场门', '第 1 行目标仍是失效值「上场门」');
check(rows[0].querySelector('.t-to').classList.contains('t-invalid'), '失效的目标区位下拉带标记');
check(rows[1].querySelector('.t-from').value === '上场门', '第 2 行来源仍是失效值「上场门」');
check(rows[1].querySelector('.t-from').classList.contains('t-invalid'), '第 2 行失效来源下拉带标记');
check(
  rows[1].querySelector('.t-to').value === '后台' && !rows[1].querySelector('.t-to').classList.contains('t-invalid'),
  '第 2 行有效目标「后台」未被误伤'
);
const err = run('transferRowsError()');
check(typeof err === 'string' && /已删除/.test(err), 'transferRowsError 对失效行返回明确错误（试排/保存不会静默提交）');

console.log('场景 5：用户重新选择后失效标记与提示行清除，可正常收集表单');
// 区位仍只有「后台」「舞台中央」（上场门/侧台未恢复），道具仍无「__proto__」：
// 用户只能在现有选项中重选；每次 change 都按当前最新数据同步下拉
setState({
  locations: [
    { name: '后台', unlimited: true },
    { name: '舞台中央', unlimited: false },
  ],
  props: [
    { name: '桌子', location: '舞台中央' },
    { name: '屏风', location: '后台' },
  ],
});
renderAll();
rows = tbody.querySelectorAll('tr.t-row');
// 此时第 1 行同时有失效道具（__proto__）与失效目标（上场门），第 2 行失效来源
let stillErr = run('transferRowsError()');
check(stillErr && /道具「__proto__」已删除/.test(stillErr), '修复前先拦截并点名失效道具');

const toSel0 = rows[0].querySelector('.t-to');
toSel0.value = '舞台中央';
toSel0.dispatch('change');
rows = tbody.querySelectorAll('tr.t-row');
check(!rows[0].querySelector('.t-to').classList.contains('t-invalid'), '重选后第 1 行目标失效样式清除');
stillErr = run('transferRowsError()');
check(stillErr && /道具「__proto__」已删除/.test(stillErr), '第 1 行道具仍失效，继续拦截并点名');
const pSel0 = rows[0].querySelector('.t-prop');
pSel0.value = '桌子';
pSel0.dispatch('change');
rows = tbody.querySelectorAll('tr.t-row');
const warnGone = !rows[0].nextElementSibling || !rows[0].nextElementSibling.classList.contains('t-stale-row');
check(warnGone, '第 1 行全部有效后失效提示行消失');
stillErr = run('transferRowsError()');
check(stillErr && /来源区位「上场门」已删除/.test(stillErr), '第 2 行未修复前仍被拦截，并点名来源区位');
const fromSel1 = rows[1].querySelector('.t-from');
fromSel1.value = '舞台中央';
fromSel1.dispatch('change');
stillErr = run('transferRowsError()');
check(stillErr === null, `全部重选后无错误（实际：${stillErr}）`);
const collected = run('collectCueForm()');
check(collected.transfers.length === 2, '收集到两条转移（提示行不混入）');
check(
  collected.transfers[0].prop === '桌子' &&
    collected.transfers[0].from === '后台' &&
    collected.transfers[0].to === '舞台中央',
  `第 1 条收集正确：${JSON.stringify(collected.transfers[0])}`
);
check(
  collected.transfers[1].prop === '屏风' &&
    collected.transfers[1].from === '舞台中央' &&
    collected.transfers[1].to === '后台',
  `第 2 条收集正确：${JSON.stringify(collected.transfers[1])}`
);

console.log('场景 6：编辑态下提示号/备注保留，无关数据刷新不清空表单');
setState({
  props: [
    { name: '桌子', location: '舞台中央' },
    { name: '屏风', location: '后台' },
  ],
});
run(`
  editingCue = 20;
  document.querySelector('#cue-number').value = 20;
  document.querySelector('#cue-note').value = '二场换景';
`);
const tb = ids['transfer-rows'];
tb.innerHTML = '';
run("addTransferRow({prop:'屏风', from:'后台', to:'上场门'})");
setState({
  props: [
    { name: '桌子', location: '舞台中央' },
    { name: '屏风', location: '后台' },
  ],
});
renderAll();
check(run('editingCue') === 20, '编辑态（editingCue=20）保留');
check(ids['cue-number'].value === 20 && ids['cue-note'].value === '二场换景', '提示号 20 与备注「二场换景」保留');
const erows = tb.querySelectorAll('tr.t-row');
check(erows.length === 1, '编辑表单的转移行仍为 1 行');
check(
  erows[0].querySelector('.t-prop').value === '屏风' &&
    erows[0].querySelector('.t-from').value === '后台' &&
    erows[0].querySelector('.t-to').value === '上场门',
  '编辑行三个下拉原选择保留'
);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
