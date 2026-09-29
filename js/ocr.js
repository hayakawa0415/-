// 端末内OCR（Web Worker）の呼び出し口
import { extractNet, extractDate } from "./net-extract.js";

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

// まず「縮小＋ぼかし」で読み、正味か日付が取れない時だけ高解像度でも読んで補う
export async function readSlip(blob, todayIso) {
  const run = async (pass) => {
    const { boxes, timing } = await recognize(blob, pass);
    return { net: extractNet(boxes), date: extractDate(boxes, todayIso), timing, pass };
  };
  const soft = await run("soft");
  const netOk = (r) => r.net.confidence === "high" || r.net.confidence === "medium";
  if (netOk(soft) && soft.date.date) return merge(soft, soft);
  const sharp = await run("sharp");
  const rank = { high: 3, medium: 2, low: 1 };
  const net = (rank[sharp.net.confidence] ?? 0) > (rank[soft.net.confidence] ?? 0) ? sharp : soft;
  const date = soft.date.date ? soft : sharp;
  return merge(net, date, [...new Set([...soft.net.candidates, ...sharp.net.candidates])]);
}

function merge(netRun, dateRun, candidates = netRun.net.candidates) {
  return {
    netKg: netRun.net.netKg, confidence: netRun.net.confidence, candidates, netBox: netRun.net.netBox,
    date: dateRun.date.date, dateConfidence: dateRun.date.confidence, dateBox: dateRun.date.dateBox,
  };
}
