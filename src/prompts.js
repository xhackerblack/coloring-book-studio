// Server-side prompt engineering for Coloring Book Studio.
// All image prompts are built HERE (never trust a client-supplied prompt),
// so the style stays consistent and the "no text" rule cannot be bypassed.

export const PALETTES = {
  rose: { label: "وردي", bg: "#FDF2F4", panel: "#F9A8D4", accent: "#BE185D", ink: "#3B0A1E" },
  autumn: { label: "خريفي", bg: "#FFF7ED", panel: "#FDBA74", accent: "#9A3412", ink: "#431407" },
  ocean: { label: "محيطي", bg: "#EFF6FF", panel: "#93C5FD", accent: "#1E40AF", ink: "#172554" },
  forest: { label: "غابة", bg: "#F0FDF4", panel: "#86EFAC", accent: "#166534", ink: "#052E16" },
  candy: { label: "حلوى", bg: "#FDF4FF", panel: "#F0ABFC", accent: "#A21CAF", ink: "#3B0764" },
};

export const PAGE_STYLE =
  "black and white coloring book page, clean thick uniform outlines, pure line art, " +
  "no shading, no grayscale, no filled areas, white background, large open shapes easy to color, " +
  "centered composition, rounded border frame";

export const NEGATIVE_PROMPT =
  "shading, gradients, color, coloured areas, blur, blurry lines, wobbly lines, " +
  "text artifacts, watermark, photorealistic, shadows, gray tones, halftone";

function detailPhrase(audience, detail) {
  if (audience === "kids") {
    return "bold simple shapes, very few details, big chunky outlines, toddler-friendly";
  }
  if (detail === "rich") {
    return "richer detail, many small decorative elements, intricate but still clean and colourable";
  }
  if (detail === "simple") {
    return "simple shapes, light detail, calm and airy";
  }
  return "moderate detail, balanced between rich decoration and large open areas";
}

/**
 * Page prompt. If allowText is false, text is banned outright. If true, the
 * exact sign texts are quoted so the model reproduces them (best-effort;
 * spelling in generated art is never guaranteed — the cover title is
 * always drawn by the client instead).
 */
export function buildPagePrompt({ scene, audience = "adults", detail = "standard", allowText = false, signTexts = [] } = {}) {
  let prompt = `${PAGE_STYLE}, ${detailPhrase(audience, detail)}, ${scene}`;
  if (allowText && signTexts.length > 0) {
    const quoted = signTexts
      .slice(0, 4)
      .map((s) => `"${String(s).replace(/"/g, "")}"`)
      .join(", ");
    prompt += `, short signs in the scene reading exactly: ${quoted}`;
  } else {
    prompt += ", no text, no letters, no numbers, no words, no signs with writing";
  }
  return prompt;
}

/** Cover prompt: full colour, NO text at all — the real title is drawn by the client. */
export function buildCoverPrompt({ concept, palette = "rose" } = {}) {
  const p = PALETTES[palette] || PALETTES.rose;
  return (
    `full-color warm and charming children's book cover illustration, ${concept}, ` +
    `cheerful cozy palette with soft ${p.panel} and ${p.accent} tones, ` +
    `rich detailed scene filling the whole frame, no text, no letters, no numbers, ` +
    `no words, no title, no captions, no banners with writing`
  );
}

/** Messages for the planning LLM. The theme may be Arabic: prompts stay in
 *  English (image models work best in English) but the title stays in the
 *  theme's language. */
export function buildPlanMessages({ theme, audience = "adults", count = 10, allowText = false }) {
  const who = audience === "kids" ? "young children (ages 3-8)" : "adults who love relaxing colouring";
  const signsRule = allowText
    ? "Each scene MAY include up to 2 short signs (3 words max each, simple words). Put them in the \"signs\" array."
    : "Every scene MUST have \"signs\": [] — no text anywhere in the art.";
  return [
    {
      role: "system",
      content:
        "You are a coloring-book planner. Reply with JSON ONLY, no markdown, no explanation. " +
        "Shape: {\"title\": string, \"subtitle\": string, \"coverConcept\": string, " +
        "\"scenes\": [{\"title\": string, \"scene\": string, \"signs\": string[]}]}. " +
        "Scene prompts must be in ENGLISH (they feed an image model). The book title " +
        "must be in the SAME language as the user's theme. Scenes must be cozy, " +
        "original, varied, and contain no people with detailed faces, no brands, " +
        "no copyrighted characters. Keep every scene printable as pure line art.",
    },
    {
      role: "user",
      content:
        `Plan a coloring book for ${who}.\n` +
        `Theme (may be Arabic; keep the book title in this language): ${theme}\n` +
        `Exactly ${count} scenes. ${signsRule}\n` +
        `coverConcept: one sentence in English describing the cover scene (no text in it).`,
    },
  ];
}

// --- Plan parsing (robust: strip fences, extract first {...}, validate, fill) ---

function extractJsonObject(text) {
  let t = String(text || "").trim();
  // Strip one layer of Markdown code fences (```json ... ``` or ``` ... ```).
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

export const FALLBACK_SCENES = [
  { title: "مخبز دافئ", scene: "a cozy bakery interior with bread loaves, a teapot, jars of jam and a round cushion", signs: [] },
  { title: "حفلة شاي في الحديقة", scene: "a garden tea party table with teapot, cups, cakes and flowers", signs: [] },
  { title: "نزهة في الغابة", scene: "a forest picnic clearing with a blanket, baskets, mushrooms and tall trees", signs: [] },
  { title: "مقهى على الشاطئ", scene: "a small seaside cafe terrace with umbrellas, seashells and sailboats far away", signs: [] },
  { title: "كوخ الجبل", scene: "a mountain cabin in winter with snow, pine trees and a warm window glow", signs: [] },
  { title: "مكتبة هادئة", scene: "a quiet library corner with stacked books, a reading lamp and a big window", signs: [] },
  { title: "سوق المزرعة", scene: "a farm market stall with pumpkins, apples, baskets of vegetables and bunting", signs: [] },
  { title: "شاليه الشتاء", scene: "a winter chalet living room with a fireplace, stockings, mugs and a snowy view", signs: [] },
  { title: "متجر الزهور", scene: "a flower shop front with bouquets, watering cans and hanging plants", signs: [] },
  { title: "رحلة القطار", scene: "a scenic train journey through hills with a small station and luggage", signs: [] },
];

export function fallbackPlan(theme, count) {
  const scenes = [];
  for (let i = 0; i < count; i++) {
    const base = FALLBACK_SCENES[i % FALLBACK_SCENES.length];
    scenes.push({ ...base, signs: [] });
  }
  return {
    title: theme && String(theme).trim() ? String(theme).trim() : "كتاب التلوين الدافئ",
    subtitle: "صفحات تلوين جميلة للطباعة",
    coverConcept: "a cozy bakery and garden scene with a teapot, flowers and warm light",
    scenes,
  };
}

/**
 * Parse the LLM's reply into a plan with EXACTLY `count` scenes.
 * Never throws: on any failure, returns a sensible fallback plan.
 */
export function parsePlan(text, count, theme = "") {
  const n = Math.max(1, Math.min(30, Number(count) || 10));
  const parsed = extractJsonObject(text);
  const fallback = fallbackPlan(theme, n);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.scenes)) {
    return fallback;
  }
  const scenes = [];
  for (const s of parsed.scenes) {
    if (scenes.length >= n) break;
    if (!s || typeof s.scene !== "string" || !s.scene.trim()) continue;
    scenes.push({
      title: typeof s.title === "string" && s.title.trim() ? s.title.trim() : `صفحة ${scenes.length + 1}`,
      scene: s.scene.trim(),
      signs: Array.isArray(s.signs) ? s.signs.filter((x) => typeof x === "string").slice(0, 4) : [],
    });
  }
  // Fill any shortfall with fallback scenes so the count is always exact.
  let fi = 0;
  while (scenes.length < n) {
    scenes.push({ ...FALLBACK_SCENES[fi % FALLBACK_SCENES.length], signs: [] });
    fi++;
  }
  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : fallback.title,
    subtitle: typeof parsed.subtitle === "string" ? parsed.subtitle : fallback.subtitle,
    coverConcept:
      typeof parsed.coverConcept === "string" && parsed.coverConcept.trim()
        ? parsed.coverConcept.trim()
        : fallback.coverConcept,
    scenes,
  };
}
