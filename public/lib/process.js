// Browser post-processing for Coloring Book Studio (lib/process.js).
// Pure pixel functions operate on plain {data, width, height} images
// (RGBA, like ImageData) so they run identically in the browser and in
// Node tests. Only composeCover touches the DOM canvas API.
//
// Pipeline (re-run from the stored RAW image whenever a slider moves —
// sliders never call the API):
//   raw -> grayscale -> Otsu threshold -> binarize -> thickness
//        -> despeckle -> rounded frame

/** In-place RGBA -> grayscale (luminance). */
export function toGrayscale(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = g; d[i + 1] = g; d[i + 2] = g;
  }
  return img;
}

/** Otsu's threshold on a grayscale image (0-255). */
export function otsuThreshold(img) {
  const d = img.data;
  const hist = new Array(256).fill(0);
  const px = img.width * img.height;
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = px - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }
  return threshold;
}

/** In-place binarize: pixels <= threshold become 0 (black), else 255. */
export function binarize(img, threshold) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] <= threshold ? 0 : 255;
    d[i] = v; d[i + 1] = v; d[i + 2] = v;
  }
  return img;
}

function isBlack(d, x, y, w, h) {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  return d[(y * w + x) * 4] === 0;
}

/**
 * Line thickness on a binary image. amount > 0 dilates (black grows,
 * lines get thicker); amount < 0 erodes (lines get thinner). Each unit
 * is one 3x3 pass. Returns a NEW image.
 */
export function adjustThickness(img, amount) {
  const { width: w, height: h } = img;
  let cur = new Uint8ClampedArray(img.data);
  const passes = Math.min(4, Math.abs(Math.trunc(amount) || 0));
  const dilate = amount > 0;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8ClampedArray(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if (dilate) {
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (isBlack(cur, x + dx, y + dy, w, h)) { near = true; break; }
            }
          }
          if (near) { next[idx] = 0; next[idx + 1] = 0; next[idx + 2] = 0; }
        } else {
          let all = true;
          for (let dy = -1; dy <= 1 && all; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!isBlack(cur, x + dx, y + dy, w, h)) { all = false; break; }
            }
          }
          if (!all) { next[idx] = 255; next[idx + 1] = 255; next[idx + 2] = 255; }
        }
      }
    }
    cur = next;
  }
  return { data: cur, width: w, height: h };
}

/**
 * Despeckle: remove BLACK connected components smaller than minSize
 * (flood fill / BFS, 4-connected). Specks become white. Returns NEW image.
 */
export function despeckle(img, minSize) {
  const { width: w, height: h } = img;
  const d = new Uint8ClampedArray(img.data);
  const seen = new Uint8Array(w * h);
  const min = Math.max(1, Math.trunc(minSize) || 0);
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || d[start * 4] !== 0) continue;
    // BFS one black component.
    const comp = [];
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      const x = cur % w, y = (cur / w) | 0;
      const nb = [cur - 1, cur + 1, cur - w, cur + w];
      for (const n of nb) {
        if (n < 0 || n >= w * h || seen[n]) continue;
        const nx = n % w, ny = (n / w) | 0;
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        if (d[n * 4] !== 0) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (comp.length < min) {
      for (const p of comp) { d[p * 4] = 255; d[p * 4 + 1] = 255; d[p * 4 + 2] = 255; }
    }
  }
  return { data: d, width: w, height: h };
}

/** Rounded-rectangle containment test (for the frame). */
function inRoundedRect(x, y, left, top, right, bottom, r) {
  const cx = Math.max(left + r, Math.min(x, right - r));
  const cy = Math.max(top + r, Math.min(y, bottom - r));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r && x >= left && x <= right && y >= top && y <= bottom;
}

/**
 * Draw a rounded black frame with a margin (default 6% of the smaller side).
 * The frame is a band of `thickness` px: pixels inside the outer rounded
 * rect but outside the inner rounded rect become black. Returns NEW image.
 */
export function drawRoundedFrame(img, marginRatio = 0.06, thicknessRatio = 0.008) {
  const { width: w, height: h } = img;
  const d = new Uint8ClampedArray(img.data);
  const margin = Math.round(Math.min(w, h) * marginRatio);
  const thickness = Math.max(3, Math.round(Math.min(w, h) * thicknessRatio));
  const r = Math.round(Math.min(w, h) * 0.04);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const outer = inRoundedRect(x, y, margin, margin, w - 1 - margin, h - 1 - margin, r);
      const inner = inRoundedRect(x, y, margin + thickness, margin + thickness, w - 1 - margin - thickness, h - 1 - margin - thickness, Math.max(0, r - thickness));
      if (outer && !inner) {
        const idx = (y * w + x) * 4;
        d[idx] = 0; d[idx + 1] = 0; d[idx + 2] = 0;
      }
    }
  }
  return { data: d, width: w, height: h };
}

/** Full pipeline: raw RGBA -> print-ready binary image with frame. */
export function processPage(raw, { thresholdOffset = 0, thickness = 1, despeckleSize = 8 } = {}) {
  const gray = toGrayscale({ data: new Uint8ClampedArray(raw.data), width: raw.width, height: raw.height });
  const t = Math.max(0, Math.min(255, otsuThreshold(gray) + thresholdOffset));
  let img = binarize(gray, t);
  img = adjustThickness(img, thickness);
  img = despeckle(img, despeckleSize);
  img = drawRoundedFrame(img);
  return img;
}

/** Small preview thumbnail (box-average downscale). Returns NEW image. */
export function makeThumbnail(img, maxSize = 640) {
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const sw = img.width, sh = img.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x / w) * sw), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) / w) * sw));
      const sy0 = Math.floor((y / h) * sh), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) / h) * sh));
      let sum = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          sum += img.data[(sy * sw + sx) * 4];
          n++;
        }
      }
      const v = Math.round(sum / Math.max(1, n));
      const o = (y * w + x) * 4;
      out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Split a title into three display lines:
 * article (small first word), script (middle words), bold (last word).
 * 2 words -> script + bold. 1 word -> bold only.
 */
export function splitTitle(title) {
  const words = String(title || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { article: "", script: "", bold: "" };
  if (words.length === 1) return { article: "", script: "", bold: words[0] };
  if (words.length === 2) return { article: "", script: words[0], bold: words[1] };
  return { article: words[0], script: words.slice(1, -1).join(" "), bold: words[words.length - 1] };
}

function fitFont(ctx, text, maxWidth, startPx, fontTemplate) {
  let px = startPx;
  while (px > 20) {
    ctx.font = fontTemplate(px);
    if (ctx.measureText(text).width <= maxWidth) return px;
    px -= 4;
  }
  ctx.font = fontTemplate(px);
  return px;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Compose the cover on a canvas (DOM only): generated art inside a rounded
 * window, a coloured label panel from the palette, and the REAL title /
 * subtitle drawn with canvas text so spelling is always correct.
 * canvas: an existing <canvas> (resized to 2550x2550).
 * art: an HTMLImageElement / ImageBitmap / canvas with the generated art.
 */
export function composeCover(canvas, art, { title, subtitle, palette }) {
  const S = 2550;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, S, S);
  // Art inside a rounded window.
  const margin = 110;
  const artBox = { x: margin, y: margin, w: S - margin * 2, h: S - margin * 2 - 620 };
  ctx.save();
  roundRectPath(ctx, artBox.x, artBox.y, artBox.w, artBox.h, 90);
  ctx.clip();
  const scale = Math.max(artBox.w / art.width, artBox.h / art.height);
  const dw = art.width * scale, dh = art.height * scale;
  ctx.drawImage(art, artBox.x + (artBox.w - dw) / 2, artBox.y + (artBox.h - dh) / 2, dw, dh);
  ctx.restore();
  // Label panel.
  const panel = { x: 130, y: S - 720, w: S - 260, h: 590 };
  ctx.fillStyle = palette.panel;
  roundRectPath(ctx, panel.x, panel.y, panel.w, panel.h, 70);
  ctx.fill();
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = 10;
  roundRectPath(ctx, panel.x, panel.y, panel.w, panel.h, 70);
  ctx.stroke();
  const { article, script, bold } = splitTitle(title);
  const cx = S / 2;
  let cy = panel.y + 118;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = palette.ink;
  if (article) {
    ctx.font = `600 64px 'Readex Pro', sans-serif`;
    ctx.fillText(article, cx, cy);
    cy += 96;
  }
  if (script) {
    fitFont(ctx, script, panel.w - 220, 150, (px) => `italic 700 ${px}px 'Segoe Script', 'Comic Sans MS', cursive`);
    ctx.fillText(script, cx, cy);
    cy += 170;
  }
  if (bold) {
    fitFont(ctx, bold, panel.w - 180, 190, (px) => `900 ${px}px 'Lalezar', 'Readex Pro', serif`);
    ctx.fillText(bold, cx, cy);
    cy += 190;
  }
  if (subtitle) {
    ctx.font = `500 56px 'Readex Pro', sans-serif`;
    fitFont(ctx, subtitle, panel.w - 240, 56, (px) => `500 ${px}px 'Readex Pro', sans-serif`);
    ctx.fillText(subtitle, cx, Math.min(cy, panel.y + panel.h - 70));
  }
  return canvas;
}
