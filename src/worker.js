// Cloudflare Worker for Coloring Book Studio.
// Routes: GET /api/config, POST /api/plan, POST /api/image.
// Everything else falls through to the static assets binding.

import {
  MODELS,
  PLAN_MODEL,
  PLAN_NEURONS_APPROX,
  FREE_NEURONS_PER_DAY,
  getModel,
  publicModels,
  buildImageInput,
  buildPromptOnlyInput,
  hasOptionalParams,
} from "./models.js";
import {
  PALETTES,
  NEGATIVE_PROMPT,
  buildPagePrompt,
  buildCoverPrompt,
  buildPlanMessages,
  parsePlan,
} from "./prompts.js";

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

const textEncoder = new TextEncoder();

/** Constant-time comparison (lengths may leak; contents do not). */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Workers AI daily-quota errors: code 4006 or messages about the free allocation / neurons. */
export function isQuotaError(err) {
  if (!err) return false;
  const code = err.code ?? err.status;
  if (code === 4006 || code === "4006") return true;
  const msg = String(err.message || err.error || err || "").toLowerCase();
  return (
    msg.includes("daily free allocation") ||
    msg.includes("free allocation") ||
    msg.includes("neurons") ||
    msg.includes("quota") ||
    msg.includes("exceed")
  );
}

/** Sniff the true image type from magic bytes (never trust a claimed type). */
export function sniffMime(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extractImageBytes(result) {
  if (!result) return null;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof Uint8Array) return result;
  if (typeof result.image === "string") return base64ToBytes(result.image);
  if (result.image instanceof Uint8Array) return result.image;
  if (result.image instanceof ArrayBuffer) return new Uint8Array(result.image);
  return null;
}

/** If APP_PASSWORD is set, /api/plan + /api/image require x-app-password. */
async function checkPassword(request, env) {
  const secret = env.APP_PASSWORD;
  if (!secret) return true;
  const given = request.headers.get("x-app-password") || "";
  return timingSafeEqual(textEncoder.encode(given), textEncoder.encode(secret));
}

async function handleConfig(env) {
  return json({
    models: publicModels(),
    palettes: Object.fromEntries(
      Object.entries(PALETTES).map(([key, p]) => [key, p.label]),
    ),
    passwordRequired: Boolean(env.APP_PASSWORD),
    freeNeuronsPerDay: FREE_NEURONS_PER_DAY,
    planNeuronsApprox: PLAN_NEURONS_APPROX,
    maxPages: 30,
  });
}

async function handlePlan(request, env) {
  if (!(await checkPassword(request, env))) {
    return json({ code: "unauthorized", message: "Missing or wrong app password." }, 401);
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const theme = typeof body.theme === "string" ? body.theme : "";
  const audience = body.audience === "kids" ? "kids" : "adults";
  const count = Math.max(1, Math.min(30, parseInt(body.count, 10) || 10));
  const allowText = Boolean(body.allowText);
  try {
    const result = await env.AI.run(PLAN_MODEL, {
      messages: buildPlanMessages({ theme, audience, count, allowText }),
      max_tokens: 3000,
    });
    const text = typeof result?.response === "string" ? result.response : "";
    return json(parsePlan(text, count, theme));
  } catch (err) {
    if (isQuotaError(err)) {
      return json({ code: "quota", message: "Daily free quota reached. Try again after 00:00 UTC." }, 429);
    }
    return json({ code: "upstream", message: "Planning service failed." }, 502);
  }
}

async function handleImage(request, env) {
  if (!(await checkPassword(request, env))) {
    return json({ code: "unauthorized", message: "Missing or wrong app password." }, 401);
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const kind = body.kind === "cover" ? "cover" : "page";
  const model = getModel(body.model);
  const audience = body.audience === "kids" ? "kids" : "adults";
  const detail = ["simple", "standard", "rich"].includes(body.detail) ? body.detail : "standard";
  const palette = typeof body.palette === "string" && PALETTES[body.palette] ? body.palette : "rose";
  const seed =
    Number.isInteger(body.seed) && body.seed >= 0 ? body.seed : Math.floor(Math.random() * 1e9);
  const allowText = Boolean(body.allowText);
  const signTexts = Array.isArray(body.signTexts)
    ? body.signTexts.filter((s) => typeof s === "string").slice(0, 4)
    : [];

  const prompt =
    kind === "cover"
      ? buildCoverPrompt({ concept: String(body.concept || "a cozy bakery and garden scene"), palette })
      : buildPagePrompt({
          scene: String(body.scene || "a cozy bakery interior"),
          audience,
          detail,
          allowText,
          signTexts,
        });
  // Negative prompt only for the Leonardo models (per spec).
  const negativePrompt = model.supportsNegativePrompt ? NEGATIVE_PROMPT : undefined;

  const attempt = async (input) => env.AI.run(model.id, input);
  let result;
  try {
    const input = buildImageInput(model, prompt, { negativePrompt, seed });
    try {
      result = await attempt(input);
    } catch (firstErr) {
      // If a model rejects optional params, retry once with only the prompt.
      if (hasOptionalParams(model, input)) {
        result = await attempt(buildPromptOnlyInput(model, prompt));
      } else {
        throw firstErr;
      }
    }
  } catch (err) {
    if (isQuotaError(err)) {
      return json({ code: "quota", message: "Daily free quota reached. Try again after 00:00 UTC." }, 429);
    }
    return json({ code: "upstream", message: "Image generation failed." }, 502);
  }

  const bytes = extractImageBytes(result);
  if (!bytes || bytes.length === 0) {
    return json({ code: "upstream", message: "Model returned no image." }, 502);
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": sniffMime(bytes),
      "x-seed": String(seed),
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config" && request.method === "GET") {
      return handleConfig(env);
    }
    if (url.pathname === "/api/plan" && request.method === "POST") {
      return handlePlan(request, env);
    }
    if (url.pathname === "/api/image" && request.method === "POST") {
      return handleImage(request, env);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
