// 端末内で動く文字認識（PaddleOCR PP-OCRv4 を onnxruntime-web で実行）。通信・費用なし
// 入力: 画像 Blob / 出力: [{ text, score, x0, y0, x1, y1 }]（元画像の座標）
import * as ort from "../vendor/ort/ort.wasm.bundle.min.mjs";

const BASE = new URL("../", import.meta.url).href;
ort.env.wasm.wasmPaths = `${BASE}vendor/ort/`;
// ?threads=1 で起動された場合は1スレッド（複数スレッドが使えない端末向けの予備）
const forceSingle = new URL(self.location.href).searchParams.get("threads") === "1";
ort.env.wasm.numThreads = !forceSingle && self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

// ドット印字は「少し縮小して軽くぼかす」と点がつながって読めるようになる（サンプル伝票で検証済み）
const PASSES = {
  soft: { longSide: 1024, blur: true },
  sharp: { longSide: 1400, blur: false },
  // 伝票が写真の中で小さく写っている時用
  large: { longSide: 2000, blur: true },
};
const DET_THRESH = 0.3;
const BOX_THRESH = 0.5;
const UNCLIP = 1.6;
const REC_H = 48;
const REC_BATCH = 8;
const REC_MIN_SCORE = 0.5;

let enginePromise;
function engine() {
  enginePromise ??= (async () => {
    const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    const [det, rec, keys] = await Promise.all([
      ort.InferenceSession.create(`${BASE}models/det.onnx`, opts),
      ort.InferenceSession.create(`${BASE}models/rec.onnx`, opts),
      fetch(`${BASE}models/rec_keys.txt`).then((r) => r.text()),
    ]);
    // CTC: 0 = 空白, 1..N = 辞書, N+1 = 半角スペース
    const dict = ["", ...keys.split("\n"), " "];
    return { det, rec, dict };
  })();
  enginePromise.catch(() => (enginePromise = null));
  return enginePromise;
}

// RGBA → CHW(BGR) Float32, (x/255 - 0.5) / 0.5
function toTensorData(rgba, w, h, out = new Float32Array(3 * w * h), offset = 0, stride = w) {
  const plane = h * stride;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = offset + y * stride + x;
      out[o] = rgba[i + 2] / 127.5 - 1;
      out[o + plane] = rgba[i + 1] / 127.5 - 1;
      out[o + 2 * plane] = rgba[i] / 127.5 - 1;
    }
  }
  return out;
}

function draw(src, sx, sy, sw, sh, dw, dh) {
  const c = new OffscreenCanvas(dw, dh);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh).data;
}

// 3x3 ガウスぼかし（ctx.filter は Safari で使えない場合があるため自前で行う）
function blur3(px, w, h) {
  const out = new Uint8ClampedArray(px.length);
  const k = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        let ki = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            sum += px[(yy * w + xx) * 4 + ch] * k[ki++];
          }
        }
        out[(y * w + x) * 4 + ch] = sum / 16;
      }
      out[(y * w + x) * 4 + 3] = 255;
    }
  }
  return out;
}

// 読み取り用の作業画像（縮小＋必要ならぼかし）
function workImage(bitmap, { longSide, blur }) {
  const s = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * s);
  const h = Math.round(bitmap.height * s);
  let px = draw(bitmap, 0, 0, bitmap.width, bitmap.height, w, h);
  if (blur) px = blur3(px, w, h);
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
  return { canvas: c, scale: 1 / s };
}

// ---- 検出 ----
async function detect(det, bitmap) {
  const W = bitmap.width;
  const H = bitmap.height;
  const w = Math.max(32, Math.round(W / 32) * 32);
  const h = Math.max(32, Math.round(H / 32) * 32);
  const data = toTensorData(draw(bitmap, 0, 0, W, H, w, h), w, h);
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, h, w]) });
  const prob = out[det.outputNames[0]].data;

  // 2値化 + 2x2 膨張
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (prob[y * w + x] > DET_THRESH) {
        bin[y * w + x] = 1;
        if (x + 1 < w) bin[y * w + x + 1] = 1;
        if (y + 1 < h) bin[(y + 1) * w + x] = 1;
        if (x + 1 < w && y + 1 < h) bin[(y + 1) * w + x + 1] = 1;
      }
    }
  }
  // 連結成分ごとに外接矩形を取る
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const boxes = [];
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (!bin[start] || label[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    label[start] = next;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0, sum = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      n++;
      sum += prob[p];
      if (x > 0 && bin[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && bin[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && bin[p - w] && !label[p - w]) { label[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && bin[p + w] && !label[p + w]) { label[p + w] = next; stack[sp++] = p + w; }
    }
    next++;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < 3 || sum / n < BOX_THRESH) continue;
    const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
    boxes.push({
      x0: Math.max(0, (x0 - d) * (W / w)),
      y0: Math.max(0, (y0 - d) * (H / h)),
      x1: Math.min(W, (x1 + 1 + d) * (W / w)),
      y1: Math.min(H, (y1 + 1 + d) * (H / h)),
    });
  }
  return boxes;
}

// ---- 認識 ----
function ctcDecode(data, t, c, dict, offset) {
  let text = "";
  let last = 0;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < t; i++) {
    let best = 0;
    let bp = -1;
    const row = offset + i * c;
    for (let k = 0; k < c; k++) if (data[row + k] > bp) { bp = data[row + k]; best = k; }
    if (best !== 0 && best !== last) {
      text += dict[best] ?? "";
      sum += bp;
      cnt++;
    }
    last = best;
  }
  return { text, score: cnt ? sum / cnt : 0 };
}

async function recognize(rec, dict, bitmap, boxes) {
  const items = boxes
    .map((b) => ({ ...b, rw: Math.max(8, Math.min(1600, Math.round((REC_H * (b.x1 - b.x0)) / Math.max(1, b.y1 - b.y0)))) }))
    .sort((a, b) => a.rw - b.rw);
  const results = [];
  for (let i = 0; i < items.length; i += REC_BATCH) {
    const batch = items.slice(i, i + REC_BATCH);
    const maxW = Math.ceil(Math.max(...batch.map((b) => b.rw)) / 8) * 8;
    const data = new Float32Array(batch.length * 3 * REC_H * maxW); // 0 = 灰色で右側を埋める
    batch.forEach((b, j) => {
      const px = draw(bitmap, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, b.rw, REC_H);
      toTensorData(px, b.rw, REC_H, data, j * 3 * REC_H * maxW, maxW);
    });
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", data, [batch.length, 3, REC_H, maxW]) });
    const o = out[rec.outputNames[0]];
    const [, t, c] = o.dims;
    batch.forEach((b, j) => {
      const r = ctcDecode(o.data, t, c, dict, j * t * c);
      if (r.text && r.score >= REC_MIN_SCORE) results.push({ text: r.text, score: r.score, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
    });
  }
  return results.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

self.onmessage = async (e) => {
  const { id, blob, pass = "soft" } = e.data;
  let stage = "init";
  try {
    if (typeof OffscreenCanvas === "undefined") {
      throw new Error("この端末のブラウザは自動読み取りに未対応です（iPhoneは iOS 16.4 以降が必要）");
    }
    const t0 = performance.now();
    const { det, rec, dict } = await engine();
    stage = "run";
    const t1 = performance.now();
    const bitmap = await createImageBitmap(blob);
    const { canvas, scale } = workImage(bitmap, PASSES[pass]);
    bitmap.close();
    const boxes = await detect(det, canvas);
    const t2 = performance.now();
    const results = (await recognize(rec, dict, canvas, boxes)).map((b) => ({
      ...b, x0: b.x0 * scale, y0: b.y0 * scale, x1: b.x1 * scale, y1: b.y1 * scale,
    }));
    const t3 = performance.now();
    self.postMessage({ id, boxes: results, timing: { load: t1 - t0, det: t2 - t1, rec: t3 - t2 } });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err), stage, threads: ort.env.wasm.numThreads });
  }
};
