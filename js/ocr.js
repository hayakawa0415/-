// 端末内OCR（Web Worker）の呼び出し口
import { extractNet } from "./net-extract.js";

let worker;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./ocr-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const { id, error, ...rest } = e.data;
    const p = pending.get(id);
    pending.delete(id);
    if (!p) return;
    error ? p.reject(new Error(error)) : p.resolve(rest);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || "文字認識を起動できませんでした"));
    pending.clear();
    worker = null;
  };
  return worker;
}

// Worker は1本なので、依頼は順番に処理される
export function recognize(blob, pass) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, blob, pass });
  });
}

// まず「縮小＋ぼかし」で読み、読めない・計算が合わない時だけ高解像度でも読んで良い方を採る
export async function readNet(blob) {
  const run = async (pass) => {
    const { boxes, timing } = await recognize(blob, pass);
    return { ...extractNet(boxes), boxes, timing, pass };
  };
  const soft = await run("soft");
  // 検算できた、または「正味」欄から読めた場合はそれで確定（2回目は時間がかかるため省く）
  if (soft.confidence === "high" || soft.confidence === "medium") return soft;
  const sharp = await run("sharp");
  if (sharp.confidence === "high") return sharp;
  const rank = { medium: 2, low: 1 };
  const best = (rank[sharp.confidence] ?? 0) > (rank[soft.confidence] ?? 0) ? sharp : soft;
  return { ...best, candidates: [...new Set([...soft.candidates, ...sharp.candidates])] };
}
