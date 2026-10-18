// Model registry + Neuron cost math for Coloring Book Studio.
//
// Neuron costs are taken from the official Cloudflare Workers AI pricing
// docs (https://developers.cloudflare.com/workers-ai/platform/pricing/,
// page "Updated: 2026-10-15"). Free allowance: 10,000 Neurons/day,
// resets 00:00 UTC, shared across ALL Workers AI usage on the account.
//
// Costing assumptions (documented, not hidden):
// - Every generated image is 1024x1024 (see IMAGE_WIDTH/HEIGHT), which is
//   4 tiles of 512x512 and exactly 1 megapixel.
// - flux-1-schnell: tiles*4.80 + steps*9.60, steps = 4.
// - flux-2-klein-4b: input tiles*5.37 + output tiles*26.05. Text-to-image
//   sends NO input image, so input tiles = 0. Cost does not depend on steps.
// - flux-2-klein-9b: first MP 1363.64 + 181.82 per subsequent MP.
//   1024x1024 = 1 MP, so cost = 1363.64 (steps do not change the price).
// - flux-2-dev: (input tiles*18.75 + output tiles*37.50) * steps, steps = 20,
//   input tiles = 0 (no input image).
// - phoenix-1.0: tiles*530 + steps*10, steps = 25.
// - lucid-origin: tiles*636 + steps*12, steps = 25.
// - llama-3.1-8b-instruct (plan calls): 25,608 neurons per M input tokens,
//   75,147 per M output tokens. A plan call is estimated at ~1,600 input
//   + ~1,600 output tokens (~161 neurons), so planning is cheap next to
//   image generation. If Cloudflare changes prices, update the numbers
//   below and /api/config + the README table pick them up automatically.

export const FREE_NEURONS_PER_DAY = 10000;
export const IMAGE_WIDTH = 1024;
export const IMAGE_HEIGHT = 1024;
export const TILES = 4; // ceil(1024/512) * ceil(1024/512)
export const MEGAPIXELS = 1;

export const PLAN_MODEL = "@cf/meta/llama-3.1-8b-instruct";
// Estimated tokens for one /api/plan call (system + user prompt + JSON plan).
export const PLAN_INPUT_TOKENS_EST = 1600;
export const PLAN_OUTPUT_TOKENS_EST = 1600;
export const PLAN_NEURONS_APPROX = Math.round(
  (PLAN_INPUT_TOKENS_EST / 1e6) * 25608 +
    (PLAN_OUTPUT_TOKENS_EST / 1e6) * 75147,
);

export const MODELS = [
  {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 Klein 4B — الافتراضي (متوازن)",
    kind: "multipart",
    defaultSteps: 25,
    supportsNegativePrompt: false,
    supportsSeed: false,
    // 0 input tiles + 4 output tiles * 26.05
    neuronsPerImage: TILES * 26.05,
  },
  {
    id: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 Schnell — الأرخص والأسرع",
    kind: "json",
    defaultSteps: 4,
    supportsNegativePrompt: false,
    supportsSeed: true,
    // 4 tiles * 4.80 + 4 steps * 9.60
    neuronsPerImage: TILES * 4.8 + 4 * 9.6,
  },
  {
    id: "@cf/black-forest-labs/flux-2-klein-9b",
    label: "FLUX.2 Klein 9B — جودة أعلى (باهظ)",
    kind: "multipart",
    defaultSteps: 25,
    supportsNegativePrompt: false,
    supportsSeed: false,
    // First megapixel: 1363.64 (1024x1024 = 1 MP)
    neuronsPerImage: 1363.64,
  },
  {
    id: "@cf/black-forest-labs/flux-2-dev",
    label: "FLUX.2 Dev — جودة عالية (باهظ جداً)",
    kind: "json",
    defaultSteps: 20,
    supportsNegativePrompt: false,
    supportsSeed: false,
    // (0 input tiles * 18.75 + 4 output tiles * 37.50) * 20 steps
    neuronsPerImage: TILES * 37.5 * 20,
  },
  {
    id: "@cf/leonardo/phoenix-1.0",
    label: "Leonardo Phoenix 1.0 — نص داخل الصورة أفضل",
    kind: "json",
    defaultSteps: 25,
    supportsNegativePrompt: true,
    supportsSeed: false,
    // 4 tiles * 530 + 25 steps * 10
    neuronsPerImage: TILES * 530 + 25 * 10,
  },
  {
    id: "@cf/leonardo/lucid-origin",
    label: "Leonardo Lucid Origin — نص داخل الصورة أفضل",
    kind: "json",
    defaultSteps: 25,
    supportsNegativePrompt: true,
    supportsSeed: false,
    // 4 tiles * 636 + 25 steps * 12
    neuronsPerImage: TILES * 636 + 25 * 12,
  },
];

export function getModel(id) {
  return MODELS.find((m) => m.id === id) || MODELS[0];
}

export function freePerDay(model) {
  return Math.floor(FREE_NEURONS_PER_DAY / model.neuronsPerImage);
}

/** Public shape returned by GET /api/config (no internal fields). */
export function publicModels() {
  return MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    neuronsPerImage: Math.round(m.neuronsPerImage * 100) / 100,
    freePerDay: freePerDay(m),
  }));
}

/**
 * Build the input for env.AI.run(model.id, input).
 * Multipart models (FLUX.2 Klein) need a real multipart body: a Request
 * built from a FormData serializes it and sets the boundary Content-Type,
 * exactly as the official Cloudflare docs show.
 */
export function buildImageInput(model, prompt, opts = {}) {
  const { negativePrompt, seed } = opts;
  if (model.kind === "multipart") {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(IMAGE_WIDTH));
    form.append("height", String(IMAGE_HEIGHT));
    form.append("steps", String(model.defaultSteps));
    if (negativePrompt && model.supportsNegativePrompt) {
      form.append("negative_prompt", negativePrompt);
    }
    if (seed != null && model.supportsSeed) form.append("seed", String(seed));
    // Serializing via Request is the documented way to get the body stream
    // and the boundary Content-Type out of a FormData.
    const req = new Request("http://form.local", { method: "POST", body: form });
    return {
      multipart: {
        body: req.body,
        contentType: req.headers.get("content-type"),
      },
    };
  }
  const input = {
    prompt,
    steps: model.defaultSteps,
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
  };
  if (negativePrompt && model.supportsNegativePrompt) {
    input.negative_prompt = negativePrompt;
  }
  if (seed != null && model.supportsSeed) input.seed = seed;
  return input;
}

/** Retry input carrying ONLY the prompt (used when a model rejects optional params). */
export function buildPromptOnlyInput(model, prompt) {
  if (model.kind === "multipart") {
    const form = new FormData();
    form.append("prompt", prompt);
    const req = new Request("http://form.local", { method: "POST", body: form });
    return {
      multipart: {
        body: req.body,
        contentType: req.headers.get("content-type"),
      },
    };
  }
  return { prompt };
}

/** True when the input carries optional params beyond the bare prompt. */
export function hasOptionalParams(model, input) {
  if (model.kind === "multipart") return true; // width/height/steps were added
  return Object.keys(input).some((k) => k !== "prompt");
}
