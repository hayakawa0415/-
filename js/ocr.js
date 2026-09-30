// 端末内OCR（Web Worker）の呼び出し口
import { extractNet, extractDate } from "./net-extract.js";

let worker;
let single = false; // 複数スレッドで失敗した端末は1スレッドで動かす
let seq = 0;
const pending = new Map();

function failAll(err) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  const url = new URL("./ocr-worker.js", import.meta.url);
  if (single) url.searchParams.set("threads", "1");
  worker = new Worker(url, { type: "module" });
  worker.onmessage = (e) => {
    const { id, error, stage, threads, ...rest } = e.data;
    const p = pending.get(id);
    pending.delete(id);
    if (!p) return;
    if (!error) return p.resolve(rest);
    const err = new Error(error);
    err.retrySingle = stage === "init" && threads > 1;
    p.reject(err);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || "文字認識を起動できませんでした");
    err.retrySingle = !single;
    worker = null;
    failAll(err);
  };
  return worker;
}

function send(blob, pass) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, blob, pass });
  });
}

// Worker は1本なので、依頼は順番に処理される
export async function recognize(blob, pass) {
  try {
    return await send(blob, pass);
  } catch (err) {
    if (!err.retrySingle || single) throw err;
    // 複数スレッドで起動できなかった → 1スレッドで作り直して1回だけやり直す
    single = true;
    worker?.terminate();
    worker = null;
    return send(blob, pass);
  }
}

// まず「縮小＋ぼかし」で読み、正味か日付が取れない時だけ高解像度でも読んで補う
export async function readSlip(blob, todayIso) {
  const runs = [];
  const run = async (pass) => {
    const { boxes, timing } = await recognize(blob, pass);
    const r = { net: extractNet(boxes), date: extractDate(boxes, todayIso), timing, pass, boxes };
    runs.push(r);
    return r;
  };
  const rank = { high: 3, medium: 2, low: 1 };
  const better = (a, b) => ((rank[b.net.confidence] ?? 0) > (rank[a.net.confidence] ?? 0) ? b : a);
  const netOk = (r) => r.net.confidence === "high" || r.net.confidence === "medium";

  let best = await run("soft");
  if (!(netOk(best) && best.date.date)) best = better(best, await run("sharp"));
  // それでも正味が取れない時は、伝票が小さく写っているとみなして大きいまま読む
  if (best.net.netKg == null) best = better(best, await run("large"));
  const dateRun = runs.find((r) => r.date.date) ?? best;
  const candidates = [...new Set(runs.flatMap((r) => r.net.candidates))];
  return {
    netKg: best.net.netKg, confidence: best.net.confidence, candidates, netBox: best.net.netBox,
    date: dateRun.date.date, dateConfidence: dateRun.date.confidence, dateBox: dateRun.date.dateBox,
    // 読み取れなかった時の原因調査用（画面の「読み取りの詳細」に表示）
    debug: {
      threads: single ? 1 : "auto",
      passes: runs.map((r) => `${r.pass}:${Math.round(r.timing.det + r.timing.rec)}ms`).join(" "),
      texts: best.boxes.map((b) => b.text).slice(0, 80),
    },
  };
}
