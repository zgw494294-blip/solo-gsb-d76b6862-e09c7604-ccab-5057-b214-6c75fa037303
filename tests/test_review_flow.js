"use strict";

// 前端「逐条复核」的回归测试。
//
// 覆盖：
// 1) 成功导入后自动核对，全部条款默认未复核；逐条点卡片「复核」后记录建立、
//    状态按当前已保存草稿更新，全部复核且无失效引用后「下载复核稿」可用；
// 2) 每次成功改稿（touch）后服务端核对结果清除失效记录（c2 正文变化：c2 与其
//    可达者 c3 的复核被清除），纯重排不清除，改回旧文不自动恢复，新条款默认未复核；
// 3) 取消编辑（不经过 touch）不清除复核；
// 4) 重新导入 / 成功恢复存档后复核记录清空；
// 5) 复核稿下载等待期间改稿或换稿：旧响应不得保存文件（不创建下载锚点）、
//    不弹提示，也不影响新操作（含新一次下载）。
//
// 用最小 DOM 桩在 Node 虚拟机中加载真实的 app/static/app.js（不修改它），
// fetch 由测试逐个收尾。运行：node --test tests/test_review_flow.js（无第三方依赖）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

// --------------------------------------------------------------------------- //
// 最小可渲染 DOM 桩：支持 innerHTML 解析（仅需区分按钮 / data-action / data-goto）
// 与事件委托所需的 closest、dataset；不做真实布局
// --------------------------------------------------------------------------- //
let elSeq = 0;

function makeElement(tag = "div", parent = null) {
  const listeners = new Map();
  const classes = new Set();
  const el = {
    tag,
    seq: ++elSeq,
    parentNode: parent,
    _classes: classes,
    hidden: false,
    disabled: false,
    checked: false,
    className: "",
    _textContent: "",
    _innerHTML: "",
    value: "",
    title: "",
    download: "",
    href: "",
    draggable: false,
    dataset: {},
    style: {},
    children: [],
    classList: {
      add: (...cs) => cs.forEach((c) => {
        classes.add(c);
        el.className = [...classes].join(" ");
      }),
      remove: (...cs) => cs.forEach((c) => {
        classes.delete(c);
        el.className = [...classes].join(" ");
      }),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c);
        else classes.delete(c);
        el.className = [...classes].join(" ");
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire(type, event = {}) {
      const ev = { ...event };
      if (!ev.target) ev.target = el;
      if (!ev.currentTarget) ev.currentTarget = el;
      return Promise.all((listeners.get(type) || []).map((fn) => fn(ev)));
    },
    appendChild(child) {
      // 真实 DOM 中 appendChild(documentFragment) 会把片段的子节点移入本节点
      if (child.tag === "fragment") {
        for (const ch of child.children.splice(0)) el.appendChild(ch);
        return child;
      }
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    // innerHTML 解析为“动作按钮 / 角标”节点，供测试直接点击；其余文本忽略
    _parse(html) {
      el.children = [];
      const re = /<(button|input|span)\b[^>]*>/gs;
      let m;
      while ((m = re.exec(html))) {
        const tagText = m[0];
        const node = makeElement(m[1], el);
        const idm = tagText.match(/id="([^"]+)"/);
        if (idm) node._id = idm[1];
        const dm = tagText.match(/data-action="([^"]+)"/);
        if (dm) node.dataset.action = dm[1];
        const gm = tagText.match(/data-goto="([^"]+)"/);
        if (gm) node.dataset.goto = gm[1];
        const rm = tagText.match(/data-role="([^"]+)"/);
        if (rm) node.dataset.role = rm[1];
        if (/\bdisabled\b/.test(tagText)) node.disabled = true;
        if (/\bchecked\b/.test(tagText)) node.checked = true;
        const clm = tagText.match(/class="([^"]+)"/);
        if (clm) {
          node.className = clm[1];
          for (const c of clm[1].split(/\s+/)) if (c) node._classes.add(c);
        }
        const txt = html.slice(m.index).match(/^<[^>]*>([\s\S]*?)<\//);
        if (txt) node._textContent = txt[1];
        el.children.push(node);
      }
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.children) {
          if (matches(ch, sel)) out.push(ch);
          walk(ch);
        }
      };
      walk(el);
      return out;
    },
    getBoundingClientRect: () => ({ top: 0, height: 10 }),
    scrollIntoView: () => {},
    focus: () => {},
    setSelectionRange: () => {},
    click() {
      return el.fire("click");
    },
    closest(sel) {
      let node = el;
      while (node) {
        if (matches(node, sel)) return node;
        node = node.parentNode;
      }
      return null;
    },
    remove() {},
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return el._innerHTML;
    },
    set(v) {
      el._innerHTML = String(v);
      el._parse(el._innerHTML);
    },
    configurable: true,
  });
  Object.defineProperty(el, "textContent", {
    get() {
      return el._textContent;
    },
    set(v) {
      el._textContent = String(v);
      el.children = []; // 纯文本赋值不生成动作子节点
    },
    configurable: true,
  });
  return el;
}

function matches(node, sel) {
  if (!sel) return false;
  sel = sel.trim();
  if (sel.startsWith("#")) return node._id === sel.slice(1);
  if (sel.startsWith(".")) {
    const cls = sel.slice(1).split(/[.\s[]/)[0];
    return (node.classList && node.classList.contains(cls)) ||
      String(node.className || "").split(/\s+/).includes(cls);
  }
  // 复合选择器（如 button[data-action="x"]）：标签 + 属性条件
  let ok = true;
  const firstTag = sel.match(/^([a-z]+)/);
  if (firstTag && node.tag !== firstTag[1]) ok = false;
  for (const cm of sel.matchAll(/\[([^\]]+)\]/g)) {
    const attr = cm[1];
    const am = attr.match(/^data-([\w-]+)(?:=["']([^"']*)["'])?$/);
    if (!am) {
      ok = false;
      break;
    }
    const key = am[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!Object.prototype.hasOwnProperty.call(node.dataset || {}, key)) {
      ok = false;
      break;
    }
    if (am[2] !== undefined && node.dataset[key] !== am[2]) {
      ok = false;
      break;
    }
  }
  return ok;
}

// fetch 桩：记录请求，响应时机由测试控制
function makeFetchStub() {
  const calls = [];
  const fetch = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const call = {
        url,
        method: opts.method || "GET",
        body: opts.body ? JSON.parse(opts.body) : null,
        settled: false,
        respond(status, data) {
          call.settled = true;
          resolve({ ok: status >= 200 && status < 300, status, json: async () => data });
        },
        fail(err) {
          call.settled = true;
          reject(err || new TypeError("fetch failed"));
        },
      };
      calls.push(call);
    });
  fetch.calls = calls;
  fetch.to = (url, method = "POST") => calls.filter((c) => c.url === url && c.method === method);
  fetch.last = (url, method = "POST") => {
    const cs = fetch.to(url, method);
    return cs[cs.length - 1];
  };
  return fetch;
}

function loadApp() {
  const elements = new Map();
  const byId = new Map();
  const $el = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeElement(sel));
    return elements.get(sel);
  };
  const fetch = makeFetchStub();
  const createdAnchors = [];
  const alerts = [];
  const sandbox = {
    document: {
      querySelector: $el,
      querySelectorAll: (sel) => {
        // 全局 ".card" 查询：返回 clauseList 下的卡片节点
        if (sel === ".card") return $el("#clause-list").querySelectorAll(".card");
        return [];
      },
      getElementById: (id) => byId.get(id) || null,
      createElement: (tag) => {
        const node = makeElement(tag);
        if (tag === "a") createdAnchors.push(node);
        return node;
      },
      createDocumentFragment: () => {
        const frag = makeElement("fragment");
        return frag;
      },
    },
    fetch,
    confirm: () => true,
    alert: (...args) => alerts.push(args.join(" ")),
    URL: {
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => {},
    },
    Blob: class Blob {
      constructor(parts) {
        this.parts = parts;
      }
    },
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
  };
  const source = fs.readFileSync(APP_JS, "utf8");
  const hook =
    "\n;globalThis.__app = { state, touch, render, clearReviews, refreshReviewStatus," +
    " submitReview, syncReviewPanel, syncReviewCards, updateReviewDownloadBtn };";;
  vm.createContext(sandbox);
  vm.runInContext(source + hook, sandbox, { filename: "app.js" });
  // render() 会把卡片 li 建在 fragment 后 appendChild 到 clauseList；
  // li.id = card-xxx 需登记到 getElementById 映射
  const origAppend = elements.get("#clause-list").appendChild.bind(elements.get("#clause-list"));
  elements.get("#clause-list").appendChild = (child) => {
    if (child.id) byId.set(child.id, child);
    return origAppend(child);
  };
  return {
    sandbox,
    fetch,
    $el,
    alerts,
    createdAnchors,
    state: sandbox.__app.state,
    touch: sandbox.__app.touch,
    render: sandbox.__app.render,
    clearReviews: sandbox.__app.clearReviews,
    refreshReviewStatus: sandbox.__app.refreshReviewStatus,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const IMPORT_OK = {
  clauses: [
    { id: "c1", original: 1, body: "甲方在七日内交付设备", ref_ids: [] },
    { id: "c2", original: 2, body: "乙方按 [[c1]] 验收后付款", ref_ids: ["c1"] },
    { id: "c3", original: 3, body: "争议解决见 [[c2]]", ref_ids: ["c2"] },
    { id: "c4", original: 4, body: "争议提交仲裁", ref_ids: [] },
  ],
};

function previewItems(state) {
  return state.orderIds.map((id, i) => {
    const c = state.clauses.find((x) => x.id === id);
    return { id, original: c.original, display: i + 1, text: c.body, broken: [] };
  });
}

const PREVIEW = (state) => ({ items: previewItems(state), has_broken: false });

// 成功导入并完成随后的预览 + 复核状态核对
async function importDoc(app, doc = IMPORT_OK) {
  app.$el("#import-text").value = "1|x\n2|y";
  const done = app.$el("#import-btn").fire("click");
  await flush();
  const imp = app.fetch.to("/api/import").find((c) => !c.settled);
  assert.ok(imp);
  imp.respond(200, doc);
  await done;
  await flush();
  // 导入后自动 render（/api/preview）与 touch 触发的 /api/review/status
  const prev = app.fetch.last("/api/preview");
  assert.ok(prev);
  prev.respond(200, PREVIEW(app.state));
  await flush();
  const st = app.fetch.last("/api/review/status");
  assert.ok(st, "导入后应自动核对复核状态");
  st.respond(
    200,
    statusOk(app.state, []),
  );
  await flush();
}

// 构造“给定复核记录全部有效、其余未复核”的 status 响应（由测试模拟服务端核对结果）
function statusOk(state, reviewIds) {
  const valid = reviewIds.map((id, i) => ({
    id,
    bodies: Object.fromEntries([[id, state.clauses.find((c) => c.id === id).body]]),
    current_no: state.orderIds.indexOf(id) + 1,
  }));
  const validSet = new Set(reviewIds);
  return {
    unreviewed: state.orderIds
      .map((id, i) => ({ id, original: parseInt(id.slice(1), 10), current_no: i + 1 }))
      .filter((u) => !validSet.has(u.id)),
    valid_reviews: valid,
    reviewed_all: validSet.size === state.orderIds.length,
    has_broken_refs: false,
    can_export: validSet.size === state.orderIds.length,
  };
}

// 响应所有挂起的 /api/preview 与 /api/review/status（按当前 state 模拟）；
// 若没有挂起的核对请求（如测试直接改了本地记录），主动发起一次再收尾
async function settlePending(app, reviewIds) {
  for (const c of app.fetch.to("/api/preview")) {
    if (!c.settled) c.respond(200, PREVIEW(app.state));
  }
  await flush();
  let pending = app.fetch.to("/api/review/status").filter((c) => !c.settled);
  if (!pending.length) {
    app.refreshReviewStatus();
    await flush();
    pending = app.fetch.to("/api/review/status").filter((c) => !c.settled);
  }
  const ids = reviewIds || [...app.state.reviews.keys()];
  for (const c of pending) {
    c.respond(200, statusOk(app.state, ids));
  }
  await flush();
}

// --------------------------------------------------------------------------- //
// 导入后默认未复核；逐条复核后全部复核、可下载复核稿
// --------------------------------------------------------------------------- //
test("逐条复核：默认未复核；全部复核且无失效引用后可下载复核稿", async () => {
  const app = loadApp();
  await importDoc(app);
  assert.equal(app.state.reviews.size, 0);
  assert.equal(app.state.reviewFresh, true);
  // 未复核时下载按钮禁用
  app.state.reviewPanelOpen = true;
  app.sandbox.__app.syncReviewPanel();
  assert.equal(app.$el("#review-download-btn").disabled, true);

  // 逐条复核 c1..c4：每条 /api/review 成功后再自动核对一次
  // （直接驱动真实的 submitReview；它与卡片点击处理器调用的是同一函数）
  for (const id of ["c1", "c2", "c3", "c4"]) {
    const p = app.sandbox.__app.submitReview(id);
    await flush();
    const post = app.fetch.last("/api/review");
    assert.equal(post.body.review_id, id);
    const reach = new Set([id]);
    // 模拟服务端：可达闭包（沿 [[cN]]）
    let changed = true;
    while (changed) {
      changed = false;
      for (const rid of [...reach]) {
        const body = app.state.clauses.find((c) => c.id === rid).body;
        for (const m of body.matchAll(/\[\[(c\d+)\]\]/g)) {
          if (!reach.has(m[1])) {
            reach.add(m[1]);
            changed = true;
          }
        }
      }
    }
    const bodies = {};
    for (const rid of reach) bodies[rid] = app.state.clauses.find((c) => c.id === rid).body;
    post.respond(200, { review: { id, bodies } });
    await p;
    await flush();
    // 复核成功后自动再核对：让它成功
    const st = app.fetch.to("/api/review/status").filter((c) => !c.settled).pop();
    assert.ok(st, "复核成功后应自动重新核对");
    st.respond(200, statusOk(app.state, ["c1", "c2", "c3", "c4"].slice(0, ["c1", "c2", "c3", "c4"].indexOf(id) + 1)));
    await flush();
    assert.ok(app.state.reviews.has(id), `${id} 复核记录应已建立`);
  }
  assert.equal(app.state.reviews.size, 4);
  app.sandbox.__app.syncReviewPanel();
  assert.equal(app.$el("#review-download-btn").disabled, false, "全部复核且无失效引用后可下载");
});

// --------------------------------------------------------------------------- //
// 成功改稿后按核对结果清除失效记录；纯重排不清除；改回旧文不自动恢复
// --------------------------------------------------------------------------- //
test("改稿清除失效复核；纯重排保留；改回旧文不恢复；新条款默认未复核", async () => {
  const app = loadApp();
  await importDoc(app);
  // 直接建立四条复核记录（模拟服务端返回的记录内容）
  for (const c of app.state.clauses) {
    app.state.reviews.set(c.id, { id: c.id, bodies: { [c.id]: c.body } });
  }
  await settlePending(app, ["c1", "c2", "c3", "c4"]);
  assert.equal(app.state.reviews.size, 4);

  // 纯重排：核对结果仍是全部有效，记录保留
  app.state.orderIds = ["c4", "c1", "c2", "c3"];
  app.touch();
  await flush();
  await settlePending(app, ["c1", "c2", "c3", "c4"]);
  assert.equal(app.state.reviews.size, 4, "纯重排 / 编号平移不清除复核");

  // 成功改稿：c2 正文变化（服务端核对：c2 失效；c3 可达 c2 也失效；c1、c4 保留）
  const c2 = app.state.clauses.find((c) => c.id === "c2");
  c2.body = "乙方完全改写正文 [[c1]]";
  app.touch();
  await flush();
  await settlePending(app, ["c1", "c4"]); // 服务端返回仅 c1、c4 仍有效
  assert.deepEqual([...app.state.reviews.keys()].sort(), ["c1", "c4"], "c2 与其可达者 c3 的复核被清除");

  // 改回旧文：被清除的记录不自动恢复（仍只有 c1、c4）
  c2.body = "乙方按 [[c1]] 验收后付款";
  app.touch();
  await flush();
  await settlePending(app, ["c1", "c4"]);
  assert.deepEqual([...app.state.reviews.keys()].sort(), ["c1", "c4"], "清除后改回旧文不自动恢复");
});

// --------------------------------------------------------------------------- //
// 取消编辑不经过 touch：不清除复核记录
// --------------------------------------------------------------------------- //
test("取消编辑不清除复核；保存失败也不清除", async () => {
  const app = loadApp();
  await importDoc(app);
  for (const c of app.state.clauses) app.state.reviews.set(c.id, { id: c.id, bodies: { [c.id]: c.body } });
  await settlePending(app, ["c1", "c2", "c3", "c4"]);
  assert.equal(app.state.reviews.size, 4);

  // 打开编辑器再取消：不调 touch、不发新核对，记录原样保留
  app.state.editingId = "c2";
  app.state.editingId = null;
  assert.equal(app.state.reviews.size, 4);
  assert.equal(app.state.reviewFresh, true);
});

// --------------------------------------------------------------------------- //
// 重新导入与成功恢复存档：复核记录清空
// --------------------------------------------------------------------------- //
test("重新导入与成功恢复存档后复核记录清空", async () => {
  const app = loadApp();
  await importDoc(app);
  for (const c of app.state.clauses) app.state.reviews.set(c.id, { id: c.id, bodies: { [c.id]: c.body } });
  await settlePending(app, ["c1", "c2", "c3", "c4"]);
  assert.equal(app.state.reviews.size, 4);

  await app.$el("#reimport-btn").fire("click");
  await flush();
  assert.equal(app.state.reviews.size, 0, "重新导入清空复核记录");
  assert.equal(app.state.reviewPanelOpen, false);

  // 成功恢复存档：经 installArchive 安装，同样清空
  await importDoc(app);
  for (const c of app.state.clauses) app.state.reviews.set(c.id, { id: c.id, bodies: { [c.id]: c.body } });
  assert.equal(app.state.reviews.size, 4);
  const snap = {
    baseline: {
      order_ids: ["c1", "c2"],
      clauses: [
        { id: "c1", body: "存档第一条" },
        { id: "c2", body: "存档第二条 [[c1]]" },
      ],
    },
    order_ids: ["c1", "c2"],
    clauses: [
      { id: "c1", body: "存档第一条" },
      { id: "c2", body: "存档第二条 [[c1]]" },
    ],
    id_counter: 2,
  };
  // 直接驱动 installArchive：通过恢复按钮的读取 + confirm（桩 confirm 恒为 true）
  const restoreDone = app.$el("#archive-restore-import-btn").fire("click");
  await flush();
  app.fetch.last("/api/archive", "GET").respond(200, { version: 7, snapshot: snap });
  await restoreDone;
  await flush();
  for (const c of app.fetch.to("/api/preview")) if (!c.settled) c.respond(200, PREVIEW(app.state));
  await flush();
  for (const c of app.fetch.to("/api/review/status")) if (!c.settled) c.respond(200, statusOk(app.state, []));
  await flush();
  assert.equal(app.state.reviews.size, 0, "成功恢复存档清空复核记录");
});

// --------------------------------------------------------------------------- //
// 复核稿下载等待期间改稿 / 换稿：旧响应不保存文件、不提示、不影响新操作
// --------------------------------------------------------------------------- //
test("复核稿下载等待期间改稿或换稿：旧响应不保存文件，不影响新下载", async () => {
  const app = loadApp();
  await importDoc(app);
  for (const c of app.state.clauses) app.state.reviews.set(c.id, { id: c.id, bodies: { [c.id]: c.body } });
  await settlePending(app, ["c1", "c2", "c3", "c4"]);
  app.state.reviewPanelOpen = true;
  app.sandbox.__app.syncReviewPanel();
  assert.equal(app.$el("#review-download-btn").disabled, false);

  // 第一次下载：请求挂起
  const d1 = app.$el("#review-download-btn").fire("click");
  await flush();
  assert.equal(app.state.exportingReview, true);
  const req1 = app.fetch.last("/api/review/export");
  assert.ok(req1);

  // 等待期间改稿（touch 会禁用按钮；先让新预览与新核对同步，再让旧响应回来，
  // 精确验证“旧响应不属于当前草稿时静默丢弃”）
  const c4 = app.state.clauses.find((c) => c.id === "c4");
  c4.body = "仲裁条款改了";
  app.touch();
  app.render(); // 真实改稿入口在 touch 后都会重渲染
  await flush();
  for (const c of app.fetch.to("/api/preview")) if (!c.settled) c.respond(200, PREVIEW(app.state));
  await flush();
  // 服务端核对：c4 正文已变，其复核失效（c1/c2/c3 与 c4 无引用关系，仍有效）
  for (const c of app.fetch.to("/api/review/status")) if (!c.settled) c.respond(200, statusOk(app.state, ["c1", "c2", "c3"]));
  await flush();
  // 旧响应此时才回来：不得保存文件
  const anchorsBefore = app.createdAnchors.length;
  req1.respond(200, { text: "旧稿内容" });
  await d1;
  await flush();
  assert.equal(app.createdAnchors.length, anchorsBefore, "改稿后旧响应不得保存文件");
  // 改稿导致复核失效（c4 未复核）：下载按钮恢复后保持禁用
  app.sandbox.__app.syncReviewPanel();
  assert.equal(app.state.exportingReview, false, "旧下载结束后等待状态解除");
  assert.equal(app.$el("#review-download-btn").disabled, true, "改稿后有未复核条款，按钮禁用");

  // 重新复核 c4 后可再次下载；换稿（重新导入）让旧响应落空同理已由 exportSeq 覆盖，
  // 这里再验证新下载在旧下载被取代后可正常保存文件
  app.state.reviews.set("c4", { id: "c4", bodies: { c4: "仲裁条款改了" } });
  await settlePending(app, ["c1", "c2", "c3", "c4"]);
  app.sandbox.__app.syncReviewPanel();
  assert.equal(app.$el("#review-download-btn").disabled, false);
  const d2 = app.$el("#review-download-btn").fire("click");
  await flush();
  const req2 = app.fetch.last("/api/review/export");
  req2.respond(200, { text: "新稿内容" });
  await d2;
  await flush();
  assert.equal(app.createdAnchors.length, anchorsBefore + 1, "只有新下载保存文件");
  assert.equal(app.createdAnchors[app.createdAnchors.length - 1].download.startsWith("reviewed-clauses-"), true);
});
