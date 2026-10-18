// Dependency-free PDF writer for Coloring Book Studio (lib/pdf.js).
// No CDN libraries. Square 8.5in pages (612x612 pt), images at 2550px
// (300 dpi). Cover as JPEG (DCTDecode); coloring pages as 1-bit
// Flate-compressed images; optional blank back pages between pages.
// Compression via CompressionStream("deflate") — available in modern
// browsers and in Node 18+.

/**
 * Pack a binary image {data (0 or 255), width, height} into 1-bit rows,
 * MSB first, 1 = black pixel. Rows are padded to whole bytes.
 */
export function packBits(img) {
  const { width: w, height: h, data } = img;
  const rowBytes = Math.ceil(w / 8);
  const out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4] === 0) {
        out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

async function deflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const enc = new TextEncoder();
const strBytes = (s) => enc.encode(s);
function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Build a PDF.
 * @param {Object} opts
 * @param {Uint8Array} opts.coverJpeg - JPEG bytes for the cover (may be null).
 * @param {Array<{bits: Uint8Array, width: number, height: number}>} opts.pages - 1-bit pages.
 * @param {boolean} opts.blankBacks - insert a blank page after each content page.
 * @param {string} opts.title - used for the /Title metadata.
 * @returns {Promise<{bytes: Uint8Array, pageCount: number}>}
 */
export async function buildPdf({ coverJpeg, pages, blankBacks = false, title = "" }) {
  // Object layout:
  // 1 = Catalog, 2 = Pages, then per content page: Page, Contents, Image.
  // Blank backs reuse a shared empty Contents object.
  const objects = []; // {num, body: Uint8Array} — body WITHOUT "n 0 obj" wrapper
  const pageNums = [];
  let next = 3;
  const emptyContentsNum = next++;
  objects.push({ num: emptyContentsNum, body: strBytes("<< /Length 0 >>\nstream\nendstream") });

  const safeTitle = String(title || "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

  for (const item of [{ kind: "cover", jpeg: coverJpeg }, ...pages.map((p) => ({ kind: "page", ...p }))]) {
    if (item.kind === "cover" && !item.jpeg) continue;
    const pageNum = next++;
    const contentsNum = next++;
    const imageNum = next++;
    pageNums.push(pageNum);

    let imageBody;
    if (item.kind === "cover") {
      imageBody = concat([
        strBytes(
          `<< /Type /XObject /Subtype /Image /Width 2550 /Height 2550 /BitsPerComponent 8 ` +
          `/ColorSpace /DeviceRGB /Filter /DCTDecode /Length ${item.jpeg.length} >>\nstream\n`,
        ),
        item.jpeg,
        strBytes("\nendstream"),
      ]);
    } else {
      const compressed = await deflate(item.bits);
      imageBody = concat([
        strBytes(
          `<< /Type /XObject /Subtype /Image /Width ${item.width} /Height ${item.height} ` +
          `/BitsPerComponent 1 /ColorSpace /DeviceGray /Decode [1 0] /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
        ),
        compressed,
        strBytes("\nendstream"),
      ]);
    }
    objects.push({ num: imageNum, body: imageBody });

    const content = strBytes(`q\n612 0 0 612 0 0 cm\n/Im${imageNum} Do\nQ\n`);
    objects.push({
      num: contentsNum,
      body: concat([
        strBytes(`<< /Length ${content.length} >>\nstream\n`),
        content,
        strBytes("endstream"),
      ]),
    });
    objects.push({
      num: pageNum,
      body: strBytes(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 612] ` +
        `/Resources << /XObject << /Im${imageNum} ${imageNum} 0 R >> >> /Contents ${contentsNum} 0 R >>`,
      ),
    });

    if (blankBacks) {
      const blankNum = next++;
      pageNums.push(blankNum);
      objects.push({
        num: blankNum,
        body: strBytes(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 612] ` +
          `/Resources << >> /Contents ${emptyContentsNum} 0 R >>`,
        ),
      });
    }
  }

  const kids = pageNums.map((n) => `${n} 0 R`).join(" ");
  const pagesObj = {
    num: 2,
    body: strBytes(`<< /Type /Pages /Kids [${kids}] /Count ${pageNums.length} >>`),
  };
  const catalogObj = {
    num: 1,
    body: strBytes("<< /Type /Catalog /Pages 2 0 R >>"),
  };
  const all = [catalogObj, pagesObj, ...objects].sort((a, b) => a.num - b.num);

  const chunks = [strBytes("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n")];
  let offset = chunks[0].length;
  const offsets = new Map();
  for (const obj of all) {
    offsets.set(obj.num, offset);
    const head = strBytes(`${obj.num} 0 obj\n`);
    const tail = strBytes("\nendobj\n");
    chunks.push(head, obj.body, tail);
    offset += head.length + obj.body.length + tail.length;
  }
  const maxNum = Math.max(...all.map((o) => o.num));
  const xrefOffset = offset;
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxNum; i++) {
    const off = offsets.get(i) ?? 0;
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  const info = `<< /Title (${safeTitle}) /Producer (Coloring Book Studio) /Creator (Coloring Book Studio) >>`;
  xref += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R /Info ${info} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(strBytes(xref));
  return { bytes: concat(chunks), pageCount: pageNums.length };
}
