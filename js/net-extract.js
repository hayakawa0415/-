// OCR で得た文字の箱（text と座標）から「正味(kg)」を推定する。DOM 非依存の純粋関数
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
