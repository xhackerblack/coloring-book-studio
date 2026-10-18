// Unit tests for Coloring Book Studio (node:test, no network).
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import worker, { isQuotaError, sniffMime, base64ToBytes, timingSafeEqual } from "../src/worker.js";
import { MODELS, getModel, freePerDay, buildImageInput, buildPromptOnlyInput, PLAN_NEURONS_APPROX } from "../src/models.js";
import { buildPagePrompt, buildCoverPrompt, parsePlan, fallbackPlan } from "../src/prompts.js";
import { otsuThreshold, binarize, adjustThickness, despeckle, drawRoundedFrame, splitTitle } from "../public/lib/process.js";
import { packBits, buildPdf } from "../public/lib/pdf.js";

const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const JPEG_B64 = Buffer.from(JPEG_BYTES).toString("base64");

function mockEnv(aiRun, extra = {}) {
  return { AI: { run: aiRun }, ASSETS: { fetch: async () => new Response("asset", { status: 200 }) }, ...extra };
}
async function postJson(env, path, body, headers = {}) {
  const req = new Request(`https://x.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return worker.fetch(req, env, {});
}

// ---------- plan parsing ----------
test("parsePlan strips code fences and returns exactly `count` scenes", () => {
  const raw = '```json\n{"title":"كتابي","subtitle":"s","coverConcept":"c","scenes":[{"title":"A","scene":"a bakery","signs":[]},{"title":"B","scene":"a garden","signs":[]}]}\n```';
  const plan = parsePlan(raw, 5, "مخبز");
  assert.equal(plan.title, "كتابي");
  assert.equal(plan.scenes.length, 5);
  assert.equal(plan.scenes[0].scene, "a bakery");
});
test("parsePlan falls back to sensible scenes on garbage input", () => {
  const plan = parsePlan("not json at all", 3, "موضوعي");
  assert.equal(plan.scenes.length, 3);
  assert.equal(plan.title, "موضوعي");
  assert.ok(plan.scenes.every((s) => typeof s.scene === "string" && s.scene.length > 0));
});
test("parsePlan truncates to count and drops scenes without a scene", () => {
  const plan = parsePlan(JSON.stringify({ title: "T", scenes: [{ title: "x" }, { title: "y", scene: "s1" }, { title: "z", scene: "s2" }] }), 2, "");
  assert.equal(plan.scenes.length, 2);
  assert.equal(plan.scenes[0].scene, "s1");
});

// ---------- prompt building ----------
test("page prompt bans text when allowText is false, quotes signs when true", () => {
  const noText = buildPagePrompt({ scene: "a bakery", allowText: false });
  assert.match(noText, /no text, no letters/);
  const withText = buildPagePrompt({ scene: "a bakery", allowText: true, signTexts: ["Fresh Bread"] });
  assert.match(withText, /"Fresh Bread"/);
});
test("cover prompt never contains text instructions for words", () => {
  const p = buildCoverPrompt({ concept: "a bakery", palette: "ocean" });
  assert.match(p, /no text/);
  assert.match(p, /no title/);
});

// ---------- neuron math (official docs, 2026-10-15) ----------
test("neuron cost and free images/day per model", () => {
  const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));
  const schnell = byId["@cf/black-forest-labs/flux-1-schnell"];
  assert.ok(Math.abs(schnell.neuronsPerImage - 57.6) < 1e-9);
  assert.equal(freePerDay(schnell), 173);
  assert.ok(Math.abs(byId["@cf/black-forest-labs/flux-2-klein-4b"].neuronsPerImage - 104.2) < 1e-9);
  assert.equal(freePerDay(byId["@cf/black-forest-labs/flux-2-klein-4b"]), 95);
  assert.equal(freePerDay(byId["@cf/black-forest-labs/flux-2-klein-9b"]), 7);
  assert.equal(freePerDay(byId["@cf/black-forest-labs/flux-2-dev"]), 3);
  assert.equal(freePerDay(byId["@cf/leonardo/phoenix-1.0"]), 4);
  assert.equal(freePerDay(byId["@cf/leonardo/lucid-origin"]), 3);
  assert.ok(PLAN_NEURONS_APPROX > 40 && PLAN_NEURONS_APPROX < 100);
});
test("multipart input carries a multipart content-type; prompt-only input drops optionals", () => {
  const klein = getModel("@cf/black-forest-labs/flux-2-klein-4b");
  const input = buildImageInput(klein, "hello", {});
  assert.match(input.multipart.contentType, /multipart\/form-data/);
  const only = buildPromptOnlyInput(klein, "hello");
  assert.match(only.multipart.contentType, /multipart\/form-data/);
  const schnell = getModel("@cf/black-forest-labs/flux-1-schnell");
  assert.deepEqual(Object.keys(buildPromptOnlyInput(schnell, "hello")), ["prompt"]);
});

// ---------- worker: config ----------
test("GET /api/config lists models with free/day and passwordRequired=false without a secret", async () => {
  const res = await worker.fetch(new Request("https://x.test/api/config"), mockEnv(async () => ({})), {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.models.length, MODELS.length);
  assert.equal(data.passwordRequired, false);
  assert.equal(data.freeNeuronsPerDay, 10000);
  assert.ok(data.models.every((m) => Number.isInteger(m.freePerDay) && m.freePerDay > 0));
});

// ---------- worker: plan ----------
test("POST /api/plan returns a parsed plan; garbage LLM output still yields count scenes", async () => {
  const env = mockEnv(async () => ({ response: "garbage, no json" }));
  const res = await postJson(env, "/api/plan", { theme: "مخبز", audience: "adults", count: 4, allowText: false });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.scenes.length, 4);
});

// ---------- worker: image + mime sniffing ----------
test("POST /api/image returns raw bytes with sniffed PNG content-type and x-seed", async () => {
  const env = mockEnv(async () => ({ image: PNG_1X1_B64 }));
  const res = await postJson(env, "/api/image", { kind: "page", model: "@cf/black-forest-labs/flux-1-schnell", scene: "a bakery", seed: 42 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-seed"), "42");
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(bytes[0], 0x89);
});
test("POST /api/image sniffs JPEG magic bytes", async () => {
  const env = mockEnv(async () => ({ image: JPEG_B64 }));
  const res = await postJson(env, "/api/image", { kind: "cover", concept: "a bakery" });
  assert.equal(res.headers.get("content-type"), "image/jpeg");
});
test("sniffMime falls back to octet-stream for unknown bytes", () => {
  assert.equal(sniffMime(new Uint8Array([1, 2, 3])), "application/octet-stream");
});
test("base64 round-trip", () => {
  const bytes = base64ToBytes(PNG_1X1_B64);
  assert.equal(bytes[1], 0x50); // 'P' of PNG signature
});

// ---------- worker: error mapping ----------
test("quota errors map to 429 {code: quota}", async () => {
  const quotaErr = new Error("exceeded daily free allocation of neurons");
  quotaErr.code = 4006;
  const env = mockEnv(async () => { throw quotaErr; });
  const res = await postJson(env, "/api/image", { kind: "page", scene: "x" });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "quota");
});
test("quota detection also matches message text without a code", () => {
  assert.equal(isQuotaError(new Error("Daily free allocation exceeded")), true);
  assert.equal(isQuotaError(new Error("boom")), false);
  assert.equal(isQuotaError({ code: 4006, message: "x" }), true);
});
test("other upstream failures map to 502 with a detail message", async () => {
  const env = mockEnv(async () => { throw new Error("model exploded"); });
  const res = await postJson(env, "/api/image", { kind: "page", scene: "x" });
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.code, "upstream");
  assert.match(data.detail, /model exploded/);
});
test("plan falls back to the next model when the first is deprecated", async () => {
  const calls = [];
  const env = mockEnv(async (modelId) => {
    calls.push(modelId);
    if (calls.length === 1) throw new Error("5028: @cf/meta/x was deprecated on 2026-05-30");
    return { response: JSON.stringify({ scenes: [{ title: "A", description: "B", prompt: "C", coverIdea: "D" }] }) };
  });
  const res = await postJson(env, "/api/plan", { theme: "x", count: 1 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.scenes.length, 1);
  assert.equal(calls.length, 2);
});
test("missing AI binding returns code no-ai-binding on plan and image", async () => {
  const env = { ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } };
  const planRes = await postJson(env, "/api/plan", { theme: "x", count: 2 });
  assert.equal(planRes.status, 502);
  assert.equal((await planRes.json()).code, "no-ai-binding");
  const imgRes = await postJson(env, "/api/image", { kind: "page", scene: "x" });
  assert.equal(imgRes.status, 502);
  assert.equal((await imgRes.json()).code, "no-ai-binding");
});
test("a returned {error} value is surfaced as upstream with detail", async () => {
  const env = mockEnv(async () => ({ error: "model not found" }));
  const res = await postJson(env, "/api/plan", { theme: "x", count: 2 });
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.code, "upstream");
  assert.match(data.detail, /model not found/);
});
test("retry-once with prompt-only input when a model rejects optional params", async () => {
  let calls = 0;
  const env = mockEnv(async (model, input) => {
    calls++;
    if (calls === 1) {
      assert.ok("steps" in input, "first call carries optional params");
      throw new Error("unknown parameter: steps");
    }
    assert.deepEqual(Object.keys(input), ["prompt"]);
    return { image: PNG_1X1_B64 };
  });
  const res = await postJson(env, "/api/image", { kind: "page", model: "@cf/black-forest-labs/flux-1-schnell", scene: "x" });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

// ---------- worker: password ----------
test("password gate: 401 without/wrong password, passes with the right one", async () => {
  const env = mockEnv(async () => ({ image: PNG_1X1_B64 }), { APP_PASSWORD: "s3cret" });
  const noPw = await postJson(env, "/api/image", { kind: "page", scene: "x" });
  assert.equal(noPw.status, 401);
  const wrong = await postJson(env, "/api/image", { kind: "page", scene: "x" }, { "x-app-password": "nope" });
  assert.equal(wrong.status, 401);
  const right = await postJson(env, "/api/image", { kind: "page", scene: "x" }, { "x-app-password": "s3cret" });
  assert.equal(right.status, 200);
});
test("timingSafeEqual is exact", () => {
  const enc = new TextEncoder();
  assert.equal(timingSafeEqual(enc.encode("abc"), enc.encode("abc")), true);
  assert.equal(timingSafeEqual(enc.encode("abc"), enc.encode("abd")), false);
  assert.equal(timingSafeEqual(enc.encode("abc"), enc.encode("abcd")), false);
});
test("unknown routes fall through to ASSETS", async () => {
  const res = await worker.fetch(new Request("https://x.test/"), mockEnv(async () => ({})), {});
  assert.equal(res.status, 200);
});

// ---------- process.js ----------
function makeImg(w, h, fill = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = fill; data[i * 4 + 1] = fill; data[i * 4 + 2] = fill; data[i * 4 + 3] = 255; }
  return { data, width: w, height: h };
}
test("otsu + binarize split a bimodal image", () => {
  const img = makeImg(4, 2, 255);
  for (let i = 0; i < 4; i++) { img.data[i * 4] = 10; img.data[i * 4 + 1] = 10; img.data[i * 4 + 2] = 10; }
  const t = otsuThreshold(img);
  assert.ok(t >= 10 && t < 255);
  binarize(img, t);
  assert.equal(img.data[0], 0);
  assert.equal(img.data[4 * 4], 255);
});
test("dilate grows black, erode shrinks it", () => {
  const img = makeImg(5, 5, 255);
  const c = (2 * 5 + 2) * 4;
  img.data[c] = 0; img.data[c + 1] = 0; img.data[c + 2] = 0;
  const grown = adjustThickness(img, 1);
  let black = 0;
  for (let i = 0; i < grown.data.length; i += 4) if (grown.data[i] === 0) black++;
  assert.equal(black, 9);
  const shrunk = adjustThickness(grown, -1);
  black = 0;
  for (let i = 0; i < shrunk.data.length; i += 4) if (shrunk.data[i] === 0) black++;
  assert.equal(black, 1);
});
test("despeckle removes tiny black components only", () => {
  const img = makeImg(6, 6, 255);
  const set = (x, y) => { const i = (y * 6 + x) * 4; img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; };
  set(0, 0); // 1px speck
  set(3, 3); set(4, 3); set(3, 4); set(4, 4); // 2x2 block
  const out = despeckle(img, 2);
  assert.equal(out.data[0], 255);
  assert.equal(out.data[(3 * 6 + 3) * 4], 0);
});
test("rounded frame draws a black border band and leaves the centre white", () => {
  const img = makeImg(100, 100, 255);
  const out = drawRoundedFrame(img, 0.06, 0.008);
  assert.equal(out.data[0], 255); // outside the frame margin stays white
  assert.equal(out.data[(6 * 100 + 50) * 4], 0); // top band is black
  assert.equal(out.data[(50 * 100 + 50) * 4], 255); // centre stays white
});
test("splitTitle splits article / script / bold", () => {
  assert.deepEqual(splitTitle("مغامرات المخبز الدافئ"), { article: "مغامرات", script: "المخبز", bold: "الدافئ" });
  assert.deepEqual(splitTitle("كتاب واحد"), { article: "", script: "كتاب", bold: "واحد" });
  assert.deepEqual(splitTitle("واحد"), { article: "", script: "", bold: "واحد" });
});

// ---------- pdf.js ----------
test("packBits packs 1 = black, MSB first, rows padded", () => {
  const img = makeImg(9, 1, 255);
  img.data[0] = 0; // x=0 black
  img.data[8 * 4] = 0; // x=8 black
  const bits = packBits(img);
  assert.equal(bits.length, 2);
  assert.equal(bits[0], 0x80);
  assert.equal(bits[1], 0x80);
});
test("buildPdf produces a valid-looking PDF with the right page count", async () => {
  const bits = new Uint8Array([0xff]);
  const jpeg = JPEG_BYTES;
  const { bytes, pageCount } = await buildPdf({
    coverJpeg: jpeg,
    pages: [{ bits, width: 8, height: 1 }],
    blankBacks: true,
    title: "Test (book)",
  });
  assert.equal(pageCount, 4); // cover + page + 2 blank backs
  const head = new TextDecoder().decode(bytes.slice(0, 8));
  assert.equal(head, "%PDF-1.7");
  const tail = new TextDecoder().decode(bytes.slice(-6));
  assert.equal(tail, "%%EOF\n");
  const text = new TextDecoder("latin1").decode(bytes);
  assert.match(text, /\/Type \/Page[^s]/);
  assert.match(text, /\/Count 4/);
  assert.match(text, /\/Title \(Test \\\(book\\\)\)/);
});
