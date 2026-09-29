// OCR で得た文字の箱（text と座標）から「正味(kg)」と「日付」を推定する。DOM 非依存の純粋関数
// 住友大阪セメントの納品書: 全重 / 風袋 / 正味 が t 表記（例 24.020）で縦に並ぶ
// 重さの表記は「24.020 t」「8,000kg」どちらも「整数部 × 1000 + 下3桁」で kg になる

const MIN_KG = 100;
const MAX_KG = 60000;

// "24.020" "24,020" "24. 020" "8,000kg" などを kg の数値にする（桁区切りの無い数字は扱わない）
export function parseWeight(text) {
  const t = String(text).normalize("NFKC").replace(/\s+/g, "");
  const out = [];
  for (const m of t.matchAll(/(?<![\d.,])(\d{1,2})[.,](\d{3})(?![\d])/g)) {
    const kg = Number(m[1]) * 1000 + Number(m[2]);
    if (kg >= MIN_KG && kg <= MAX_KG) out.push(kg);
  }
  return out;
}

const LABELS = {
  net: /正[味昧咪]/,
  gross: /全[重量]/,
  tare: /[風风]袋/,
};

const cy = (b) => (b.y0 + b.y1) / 2;
const height = (b) => b.y1 - b.y0;

// ラベルと同じ行で右側にある重さを探す
function valueRightOf(label, numbers) {
  const h = height(label);
  let best = null;
  for (const n of numbers) {
    if (n.box === label) continue;
    const sameRow = Math.abs(cy(n.box) - cy(label)) < Math.max(h, height(n.box)) * 0.7;
    if (!sameRow || n.box.x0 < label.x0) continue;
    const dx = n.box.x0 - label.x1;
    if (!best || dx < best.dx) best = { ...n, dx };
  }
  return best;
}

// 戻り値: { netKg, confidence: "high" | "medium" | "low" | null, candidates: [kg...] }
// high = 全重−風袋=正味 で検算できた / medium = 正味だけ読めた / low = 検算が合わない
export function extractNet(boxes) {
  const numbers = [];
  for (const box of boxes) for (const kg of parseWeight(box.text)) numbers.push({ kg, box });
  const candidates = [...new Set(numbers.map((n) => n.kg))];

  const find = (re) => boxes.filter((b) => re.test(String(b.text).normalize("NFKC")));
  const boxOf = {};
  const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
  const pick = (key) => {
    for (const label of find(LABELS[key])) {
      // ラベルと数字が1つの箱にまとまって読まれた場合（例「正味 24.020」）
      const own = parseWeight(label.text);
      if (own.length) {
        boxOf[key] = label;
        return own[0];
      }
      const v = valueRightOf(label, numbers);
      if (v) {
        boxOf[key] = union(label, v.box);
        return v.kg;
      }
    }
    return null;
  };
  const net = pick("net");
  const gross = pick("gross");
  const tare = pick("tare");
  const boxFor = (kg) => boxOf.net ?? numbers.find((n) => n.kg === kg)?.box ?? null;

  // 全重 − 風袋 = 正味 が成り立てば確実
  if (net != null && gross != null && tare != null && gross - tare === net) {
    return { netKg: net, confidence: "high", candidates, netBox: boxFor(net) };
  }
  // 3つとも読めたのに計算が合わない＝どれかを読み違えている
  if (net != null && gross != null && tare != null) {
    return { netKg: net, confidence: "low", candidates: [...new Set([...candidates, gross - tare])], netBox: boxFor(net) };
  }
  // ラベルは取れなかったが、数字の組で成り立つもの
  for (const a of candidates) for (const b of candidates) {
    const c = a - b;
    if (a !== b && candidates.includes(c) && c !== a && c !== b) {
      return { netKg: c, confidence: "high", candidates, netBox: boxFor(c) };
    }
  }
  // 全重と風袋だけ読めた場合は差し引きで求める
  if (net == null && gross != null && tare != null && gross > tare) {
    return { netKg: gross - tare, confidence: "medium", candidates: [...new Set([...candidates, gross - tare])], netBox: boxOf.gross && boxOf.tare ? union(boxOf.gross, boxOf.tare) : null };
  }
  if (net != null) return { netKg: net, confidence: "medium", candidates, netBox: boxFor(net) };
  return { netKg: null, confidence: null, candidates, netBox: null };
}

// ---------- 日付 ----------
// 住友: 「2026 年 05 月 20 日」（「2026年05」「月20」のように分かれて読まれることが多い）
// UBE : 「年月日 26/08/05」（ドット印字の 0 を 8・9・6 と読み違えることがある）

const DAY_MS = 86400000;
const toIso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// 月・日の十の位は 0〜3 しかないので、0 の読み違い（8・9・6）を 0 に戻す
function fixTens(s, maxTens) {
  if (s.length === 2 && Number(s[0]) > maxTens && "869".includes(s[0])) return `0${s[1]}`;
  return s;
}

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 読み取った日付がありえる範囲か（未来すぎ・古すぎは読み違いとみなす）
function plausible(iso, todayIso) {
  const diff = (Date.parse(todayIso) - Date.parse(iso)) / DAY_MS;
  return diff >= -1 && diff <= 180;
}

function candidateDates(text) {
  const t = String(text).normalize("NFKC").replace(/\s+/g, "");
  const out = [];
  // 2026年05月20 / 2026年055月23（重複読み）にも対応
  const jp = t.match(/(20\d{2})年(\d{1,2})/);
  const day = t.match(/月(\d{1,2})/);
  if (jp && day) out.push([Number(jp[1]), fixTens(jp[2], 1), fixTens(day[1], 3)]);
  // 26/08/05 形式
  for (const m of t.matchAll(/(?<!\d)(\d{2})\/(\d{1,2})\/(\d{1,2})/g)) {
    out.push([2000 + Number(m[1]), fixTens(m[2], 1), fixTens(m[3], 3)]);
  }
  // 2026/05/20, 2026.5.20
  for (const m of t.matchAll(/(20\d{2})[/.-](\d{1,2})[/.-](\d{1,2})/g)) out.push([Number(m[1]), m[2], m[3]]);
  return out.map(([y, m, d]) => [y, Number(m), Number(d)]);
}

// 同じ行の箱を左から順につなげた文字列
function rowText(anchor, boxes) {
  const h = anchor.y1 - anchor.y0;
  const c = (anchor.y0 + anchor.y1) / 2;
  const row = boxes.filter((b) => Math.abs((b.y0 + b.y1) / 2 - c) < h * 0.7).sort((a, b) => a.x0 - b.x0);
  return { text: row.map((b) => b.text).join(""), box: row.reduce((u, b) => ({ x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) }), anchor) };
}

// 戻り値: { date: "YYYY-MM-DD" | null, confidence: "high" | "medium" | null, dateBox }
export function extractDate(boxes, todayIso) {
  const anchors = boxes.filter((b) => /年|月日|\d{2}\/\d/.test(String(b.text).normalize("NFKC")));
  const thisYear = Number(todayIso.slice(0, 4));
  let fallback = null;
  for (const anchor of anchors) {
    const { text, box } = rowText(anchor, boxes);
    for (const [y, m, d] of candidateDates(text)) {
      if (!validDate(y, m, d)) continue;
      const iso = toIso(y, m, d);
      if (plausible(iso, todayIso)) return { date: iso, confidence: "high", dateBox: box };
      // 年だけ読み違えた可能性（例 25/8/26）：今年に直して範囲内なら要確認で採用
      for (const yy of [thisYear, thisYear - 1]) {
        const alt = toIso(yy, m, d);
        if (validDate(yy, m, d) && plausible(alt, todayIso)) fallback ??= { date: alt, confidence: "medium", dateBox: box };
      }
    }
  }
  return fallback ?? { date: null, confidence: null, dateBox: null };
}
