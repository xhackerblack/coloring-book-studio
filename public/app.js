// Coloring Book Studio — frontend (public/app.js). Vanilla JS, no frameworks.
// Persistence: project JSON in localStorage, RAW generated images in IndexedDB.
// Sliders re-process from stored RAW images — they never call the API again.

import { processPage, composeCover } from "./lib/process.js";
import { packBits, buildPdf } from "./lib/pdf.js";

const $ = (id) => document.getElementById(id);
const LS_PROJECT = "cbs-project-v1";
const LS_USAGE = "cbs-usage-v1";
const FREE_NEURONS = 10000;

const STATUS_AR = { queued: "في الانتظار", working: "جارٍ التوليد…", done: "تم", error: "خطأ" };
const ERR_AR = {
  quota: "وصلتَ إلى حدّ الحصة المجانية اليوم (١٠٬٠٠٠ خلية عصبية). ستُصفَّر الحصة عند ٠٠:٠٠ UTC. يمكنك استئناف الصفحات المتبقية لاحقاً.",
  upstream: "تعذّرت خدمة التوليد. حاوِل مجدداً بعد قليل.",
  "no-ai-binding": "ربط Workers AI غير مفعّل في هذا النشر. في لوحة Cloudflare افتح الـ Worker ← Settings ← Bindings وتأكد من وجود AI binding بالاسم AI، ثم أعد النشر.",
  network: "تعذّر الاتصال بالخادم. تحقّق من اتصالك ثم حاوِل مجدداً.",
  unauthorized: "كلمة المرور غير صحيحة.",
  noimage: "لم يُعِد النموذج أي صورة. حاوِل مجدداً.",
};

// ---------- state ----------
let config = null;
let state = {
  theme: "", audience: "adults", count: 10, detail: "standard",
  allowText: false, model: "", palette: "rose",
  title: "", subtitle: "", coverConcept: "",
  pages: [], // {id, title, scene, signs, status, promptOverride, seed, regen, error}
  coverSeed: 0,
  projectSeed: Math.floor(Math.random() * 1e9),
};
let stopQueue = false;
let generating = false;

// ---------- tiny helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayKey = () => new Date().toISOString().slice(0, 10);
const fmtNum = (n) => Number(n).toLocaleString("ar-EG");
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- usage meter (localStorage, per UTC day) ----------
function loadUsage() {
  try {
    const u = JSON.parse(localStorage.getItem(LS_USAGE) || "null");
    if (u && u.date === todayKey()) return u.neurons || 0;
  } catch { /* ignore */ }
  return 0;
}
let usageNeurons = loadUsage();
function saveUsage() {
  try { localStorage.setItem(LS_USAGE, JSON.stringify({ date: todayKey(), neurons: usageNeurons })); } catch { /* ignore */ }
}
function addUsage(n) {
  usageNeurons += n;
  saveUsage();
  renderUsage();
}
function renderUsage() {
  $("usage-text").textContent = `${fmtNum(usageNeurons)} من ${fmtNum(FREE_NEURONS)} خلية عصبية`;
  $("usage-fill").style.width = `${Math.min(100, (usageNeurons / FREE_NEURONS) * 100)}%`;
}

// ---------- persistence ----------
function saveProject() {
  try {
    localStorage.setItem(LS_PROJECT, JSON.stringify(state));
  } catch { /* storage full/blocked: project still works in-memory */ }
}
function loadProject() {
  try {
    const raw = localStorage.getItem(LS_PROJECT);
    if (raw) {
      const saved = JSON.parse(raw);
      state = { ...state, ...saved };
      // A reload must never leave a page stuck on "working".
      for (const p of state.pages) if (p.status === "working") p.status = "queued";
    }
  } catch { /* ignore */ }
}

// ---------- IndexedDB (raw images) ----------
let idb = null;
const memRaw = new Map();
function openDb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("cbs-studio", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("raw");
      req.onsuccess = () => { idb = req.result; resolve(); };
      req.onerror = () => resolve();
    } catch { resolve(); }
  });
}
function idbPut(key, blob) {
  if (idb) {
    return new Promise((res) => {
      try {
        const tx = idb.transaction("raw", "readwrite");
        tx.objectStore("raw").put(blob, key);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      } catch { memRaw.set(key, blob); res(); }
    });
  }
  memRaw.set(key, blob);
  return Promise.resolve();
}
function idbGet(key) {
  if (idb) {
    return new Promise((res) => {
      try {
        const tx = idb.transaction("raw", "readonly");
        const req = tx.objectStore("raw").get(key);
        req.onsuccess = () => res(req.result || memRaw.get(key) || null);
        req.onerror = () => res(memRaw.get(key) || null);
      } catch { res(memRaw.get(key) || null); }
    });
  }
  return Promise.resolve(memRaw.get(key) || null);
}
function idbClear() {
  memRaw.clear();
  if (idb) {
    try { idb.transaction("raw", "readwrite").objectStore("raw").clear(); } catch { /* ignore */ }
  }
}

// ---------- image helpers ----------
async function blobToImageData(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
function imageDataToBlob(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d").putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return new Promise((res) => canvas.toBlob(res, "image/png"));
}
async function processRaw(rawBlob, settings) {
  const raw = await blobToImageData(rawBlob);
  const processed = processPage(raw, settings);
  const blob = await imageDataToBlob(processed);
  return { processed, blob };
}
function settingsFromUI() {
  return {
    thickness: parseInt($("thickness").value, 10) || 0,
    thresholdOffset: parseInt($("threshold").value, 10) || 0,
    despeckleSize: parseInt($("despeckle").value, 10) || 0,
  };
}

// ---------- API ----------
function passwordHeader() {
  const pw = $("password")?.value || "";
  return pw ? { "x-app-password": pw } : {};
}
async function apiJson(path, body, { retry = true } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...passwordHeader() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      const err = new Error(data.code || `HTTP ${res.status}`);
      err.code = data.code || `http${res.status}`;
      err.status = res.status;
      err.detail = typeof data.detail === "string" ? data.detail : "";
      throw err;
    } catch (e) {
      const retriable = e.code === undefined || e.status >= 500;
      if (retry && retriable && attempt < 3) {
        attempt++;
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw e;
    }
  }
}
async function apiImage(body) {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch("/api/image", {
        method: "POST",
        headers: { "content-type": "application/json", ...passwordHeader() },
        body: JSON.stringify(body),
      });
      if (res.ok) return { blob: await res.blob(), seed: res.headers.get("x-seed") };
      const data = await res.json().catch(() => ({}));
      const err = new Error(data.code || `HTTP ${res.status}`);
      err.code = data.code || `http${res.status}`;
      err.status = res.status;
      err.detail = typeof data.detail === "string" ? data.detail : "";
      throw err;
    } catch (e) {
      const retriable = e.code === undefined || e.status >= 500;
      if (retriable && attempt < 3) {
        attempt++;
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw e;
    }
  }
}

// ---------- UI: steps ----------
function showSheets() {
  const hasPlan = state.pages.length > 0;
  $("sheet-2").hidden = !hasPlan;
  $("sheet-3").hidden = !hasPlan;
  $("num-1").closest(".step-ind").classList.toggle("done", hasPlan);
  $("num-2").closest(".step-ind").classList.toggle("done", hasPlan && state.pages.every((p) => p.status === "done"));
}
function setError(el, err) {
  if (!err) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  const base = ERR_AR[err.code] || ERR_AR.network;
  el.textContent = err.detail ? `${base} (التفاصيل: ${err.detail})` : base;
}

// ---------- UI: plan ----------
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    config = await res.json();
  } catch {
    config = { models: [], palettes: {}, passwordRequired: false, planNeuronsApprox: 0 };
  }
  const modelSel = $("model");
  modelSel.innerHTML = "";
  for (const m of config.models || []) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.label} — نحو ${fmtNum(m.freePerDay)} صورة/يوم`;
    modelSel.appendChild(opt);
  }
  if (!state.model && config.models?.length) state.model = config.models[0].id;
  modelSel.value = state.model || "";
  const paletteSel = $("palette");
  paletteSel.innerHTML = "";
  for (const [key, label] of Object.entries(config.palettes || { rose: "وردي" })) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = label;
    paletteSel.appendChild(opt);
  }
  paletteSel.value = state.palette;
  $("password-wrap").hidden = !config.passwordRequired;
  renderUsage();
  updateModelHint();
}
function updateModelHint() {
  const m = (config.models || []).find((x) => x.id === $("model").value);
  $("model-hint").textContent = m
    ? `تكلفة تقريبية: ${fmtNum(m.neuronsPerImage)} خلية عصبية للصورة — نحو ${fmtNum(m.freePerDay)} صورة مجانية في اليوم.`
    : "";
}
function readIdeaForm() {
  state.theme = $("theme").value.trim();
  state.audience = document.querySelector('input[name="audience"]:checked')?.value || "adults";
  state.count = Math.max(1, Math.min(30, parseInt($("count").value, 10) || 10));
  state.detail = $("detail").value;
  state.allowText = $("allowText").checked;
  state.model = $("model").value;
}
async function createPlan() {
  setError($("plan-error"), null);
  readIdeaForm();
  if (!state.theme) { $("plan-error").hidden = false; $("plan-error").textContent = "اكتب موضوع الكتاب أولاً."; return; }
  const btn = $("plan-btn");
  btn.disabled = true;
  btn.textContent = "جارٍ إنشاء الخطة…";
  try {
    const plan = await apiJson("/api/plan", {
      theme: state.theme, audience: state.audience, count: state.count, allowText: state.allowText,
    });
    state.title = plan.title || state.theme;
    state.subtitle = plan.subtitle || "";
    state.coverConcept = plan.coverConcept || "";
    state.pages = (plan.scenes || []).map((s, i) => ({
      id: `p${i + 1}`,
      title: s.title || `صفحة ${i + 1}`,
      scene: s.scene,
      signs: s.signs || [],
      status: "queued",
      promptOverride: "",
      seed: (state.projectSeed + i * 7919) % 1000000000,
      regen: 0,
      error: "",
    }));
    addUsage(config.planNeuronsApprox || 0);
    saveProject();
    $("book-title").value = state.title;
    $("book-subtitle").value = state.subtitle;
    renderPages();
    showSheets();
    $("sheet-2").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    setError($("plan-error"), e);
  } finally {
    btn.disabled = false;
    btn.textContent = "إنشاء الخطة ✦";
  }
}

// ---------- UI: pages ----------
function renderPages() {
  const wrap = $("pages");
  wrap.innerHTML = "";
  for (const page of state.pages) {
    const card = document.createElement("article");
    card.className = "page-card";
    card.dataset.pageId = page.id;
    card.innerHTML = `
      <div class="page-head"><strong>${escapeHtml(page.title)}</strong>
      <span class="chip ${page.status}">${STATUS_AR[page.status] || page.status}</span></div>
      <img alt="معاينة الصفحة" ${page.status === "done" ? "" : "hidden"}>
      <p class="hint" ${page.status === "done" ? "hidden" : ""}>${page.status === "error" ? escapeHtml(page.error || "") : "بانتظار التوليد"}</p>
      <label>نص المشهد</label>
      <textarea class="scene-text">${escapeHtml(page.scene)}</textarea>
      <details><summary>تخصيص الموجّه (اختياري)</summary>
      <textarea class="prompt-override" placeholder="اكتب موجّهاً مخصصاً ليحل محل نص المشهد…">${escapeHtml(page.promptOverride || "")}</textarea></details>
      <div class="card-btns">
        <button class="regen-btn">إعادة توليد</button>
        <button class="view-btn" disabled>عرض كامل</button>
      </div>`;
    card.querySelector(".scene-text").addEventListener("change", (e) => { page.scene = e.target.value; saveProject(); });
    card.querySelector(".prompt-override").addEventListener("change", (e) => { page.promptOverride = e.target.value; saveProject(); });
    card.querySelector(".regen-btn").addEventListener("click", () => regeneratePage(page.id));
    const imgEl = card.querySelector("img");
    imgEl.addEventListener("click", () => {
      if (imgEl.src) { $("viewer-img").src = imgEl.src; $("viewer").showModal(); }
    });
    card.querySelector(".view-btn").addEventListener("click", () => {
      if (imgEl.src) { $("viewer-img").src = imgEl.src; $("viewer").showModal(); }
    });
    wrap.appendChild(card);
    // Restore preview from stored raw image (re-processed with current sliders).
    refreshPagePreview(page.id);
  }
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cardFor(pageId) {
  return document.querySelector(`.page-card[data-page-id="${pageId}"]`);
}
function setPageStatus(page, status, error = "") {
  page.status = status;
  page.error = error;
  const card = cardFor(page.id);
  if (card) {
    const chip = card.querySelector(".chip");
    chip.className = `chip ${status}`;
    chip.textContent = STATUS_AR[status] || status;
    const hint = card.querySelector(".hint");
    if (hint) { hint.hidden = status === "done"; hint.textContent = status === "error" ? error : "بانتظار التوليد"; }
    card.querySelector(".view-btn").disabled = status !== "done";
  }
  saveProject();
  showSheets();
}
async function refreshPagePreview(pageId) {
  const page = state.pages.find((p) => p.id === pageId);
  if (!page || page.status !== "done") return;
  const raw = await idbGet(`page:${pageId}`);
  if (!raw) return;
  const { blob } = await processRaw(raw, settingsFromUI());
  const card = cardFor(pageId);
  if (!card) return;
  const imgEl = card.querySelector("img");
  if (imgEl.src) URL.revokeObjectURL(imgEl.src);
  imgEl.src = URL.createObjectURL(blob);
  imgEl.hidden = false;
}
const refreshAllPreviews = debounce(() => {
  for (const p of state.pages) refreshPagePreview(p.id);
  recomposeCover();
}, 250);

// ---------- generation ----------
function modelForCurrent() {
  return (config.models || []).find((m) => m.id === state.model) || config.models?.[0];
}
async function generatePage(page) {
  setPageStatus(page, "working");
  setError($("gen-error"), null);
  try {
    const { blob } = await apiImage({
      kind: "page",
      model: state.model,
      scene: page.promptOverride?.trim() ? page.promptOverride.trim() : page.scene,
      audience: state.audience,
      detail: state.detail,
      palette: state.palette,
      seed: page.seed,
      allowText: state.allowText,
      signTexts: page.signs,
    });
    await idbPut(`page:${page.id}`, blob);
    await refreshPagePreview(page.id);
    const m = modelForCurrent();
    if (m) addUsage(m.neuronsPerImage);
    setPageStatus(page, "done");
  } catch (e) {
    if (e.code === "quota") {
      setPageStatus(page, "queued");
      stopQueue = true;
      $("quota-box").hidden = false;
      $("quota-text").textContent = ERR_AR.quota;
      throw e; // handled by the queue: stops everything
    }
    setPageStatus(page, "error", ERR_AR[e.code] || ERR_AR.network);
  }
}
async function runQueue(filter) {
  if (generating) return;
  generating = true;
  stopQueue = false;
  $("quota-box").hidden = true;
  const targets = state.pages.filter(filter);
  let idx = 0;
  const worker = async () => {
    while (idx < targets.length && !stopQueue) {
      const page = targets[idx++];
      try { await generatePage(page); } catch (e) {
        if (e.code === "quota") break;
      }
    }
  };
  await Promise.all([worker(), worker()]); // concurrency 2
  generating = false;
}
async function regeneratePage(pageId) {
  const page = state.pages.find((p) => p.id === pageId);
  if (!page) return;
  page.regen += 1;
  page.seed = (page.seed + 104729 + page.regen) % 1000000000;
  saveProject();
  await generatePage(page);
}

// ---------- cover ----------
async function generateCover() {
  setError($("gen-error"), null);
  const btn = $("generate-cover");
  btn.disabled = true;
  btn.textContent = "جارٍ توليد الغلاف…";
  try {
    const seed = state.coverSeed || Math.floor(Math.random() * 1e9);
    state.coverSeed = seed;
    const { blob } = await apiImage({
      kind: "cover",
      model: state.model,
      concept: state.coverConcept,
      palette: state.palette,
      seed,
      allowText: false,
      signTexts: [],
    });
    await idbPut("cover", blob);
    await recomposeCover();
    saveProject();
    const m = modelForCurrent();
    if (m) addUsage(m.neuronsPerImage);
  } catch (e) {
    setError($("gen-error"), e);
  } finally {
    btn.disabled = false;
    btn.textContent = "توليد الغلاف";
  }
}
async function recomposeCover() {
  const raw = await idbGet("cover");
  const imgEl = $("cover-img");
  if (!raw) { imgEl.hidden = true; $("cover-empty").hidden = false; return; }
  const artBmp = await createImageBitmap(raw);
  const canvas = document.createElement("canvas");
  composeCover(canvas, artBmp, {
    title: state.title,
    subtitle: state.subtitle,
    palette: paletteByKey(state.palette),
  });
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (imgEl.src) URL.revokeObjectURL(imgEl.src);
  imgEl.src = URL.createObjectURL(blob);
  imgEl.hidden = false;
  $("cover-empty").hidden = true;
  // Keep the composed canvas for export.
  recomposeCover.canvas = canvas;
}
function paletteByKey(key) {
  // Palettes are mirrored from the server config labels; colours live here
  // so the cover can be composed offline. Must match src/prompts.js.
  const map = {
    rose: { bg: "#FDF2F4", panel: "#F9A8D4", accent: "#BE185D", ink: "#3B0A1E" },
    autumn: { bg: "#FFF7ED", panel: "#FDBA74", accent: "#9A3412", ink: "#431407" },
    ocean: { bg: "#EFF6FF", panel: "#93C5FD", accent: "#1E40AF", ink: "#172554" },
    forest: { bg: "#F0FDF4", panel: "#86EFAC", accent: "#166534", ink: "#052E16" },
    candy: { bg: "#FDF4FF", panel: "#F0ABFC", accent: "#A21CAF", ink: "#3B0764" },
  };
  return map[key] || map.rose;
}

// ---------- export ----------
function sanitizeFileName(title) {
  const clean = String(title || "coloring-book").trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return (clean || "coloring-book") + ".pdf";
}
async function exportPdf() {
  const btn = $("export-btn");
  const status = $("export-status");
  const donePages = state.pages.filter((p) => p.status === "done");
  if (donePages.length === 0) { status.textContent = "ولِّد صفحة واحدة على الأقل قبل التصدير."; return; }
  btn.disabled = true;
  status.textContent = "جارٍ بناء ملف PDF…";
  try {
    let coverJpeg = null;
    if (recomposeCover.canvas) {
      const blob = await new Promise((res) => recomposeCover.canvas.toBlob(res, "image/jpeg", 0.92));
      coverJpeg = new Uint8Array(await blob.arrayBuffer());
    }
    const pages = [];
    for (const page of donePages) {
      const raw = await idbGet(`page:${page.id}`);
      if (!raw) continue;
      const { processed } = await processRaw(raw, settingsFromUI());
      pages.push({ bits: packBits(processed), width: processed.width, height: processed.height });
    }
    const { bytes, pageCount } = await buildPdf({
      coverJpeg,
      pages,
      blankBacks: $("blank-backs").checked,
      title: state.title,
    });
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = sanitizeFileName(state.title);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    status.textContent = `تم تصدير ${fmtNum(pageCount)} صفحة. اطبع على ورق A4 أو Letter.`;
  } catch (e) {
    console.error(e);
    status.textContent = "فشل بناء ملف PDF. حاوِل مجدداً.";
  } finally {
    btn.disabled = false;
  }
}

// ---------- wiring ----------
function bind() {
  $("plan-btn").addEventListener("click", createPlan);
  $("model").addEventListener("change", () => { state.model = $("model").value; updateModelHint(); saveProject(); });
  $("palette").addEventListener("change", () => { state.palette = $("palette").value; saveProject(); recomposeCover(); });
  $("book-title").addEventListener("change", () => { state.title = $("book-title").value; saveProject(); recomposeCover(); });
  $("book-subtitle").addEventListener("change", () => { state.subtitle = $("book-subtitle").value; saveProject(); recomposeCover(); });
  $("generate-all").addEventListener("click", () => runQueue((p) => p.status !== "done"));
  $("resume-btn").addEventListener("click", () => runQueue((p) => p.status === "queued"));
  $("generate-cover").addEventListener("click", generateCover);
  $("export-btn").addEventListener("click", exportPdf);
  $("viewer-close").addEventListener("click", () => $("viewer").close());
  $("viewer").addEventListener("click", (e) => { if (e.target === $("viewer")) $("viewer").close(); });
  $("new-project").addEventListener("click", () => {
    if (!confirm("ابدأ مشروعاً جديداً؟ سيتم حذف المشروع الحالي والصور المخزنة.")) return;
    localStorage.removeItem(LS_PROJECT);
    idbClear();
    location.reload();
  });
  for (const id of ["thickness", "threshold", "despeckle"]) {
    $(id).addEventListener("input", () => {
      $(`${id}-val`).textContent = fmtNum(parseInt($(id).value, 10));
      refreshAllPreviews();
    });
  }
}

async function init() {
  bind();
  await openDb();
  loadProject();
  // Restore form state from the saved project.
  $("theme").value = state.theme || "";
  $("count").value = state.count || 10;
  $("detail").value = state.detail || "standard";
  $("allowText").checked = !!state.allowText;
  const aud = document.querySelector(`input[name="audience"][value="${state.audience}"]`);
  if (aud) aud.checked = true;
  $("book-title").value = state.title || "";
  $("book-subtitle").value = state.subtitle || "";
  await loadConfig();
  if (state.pages.length) {
    renderPages();
    recomposeCover();
  }
  showSheets();
}

init();
