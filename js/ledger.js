// 集計ロジック（画面・Excel 共通）。DOM に依存しない純粋関数だけを置く

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function usageKey(siteId, material, date) {
  return `${siteId}|${material}|${date}`;
}

const bySlip = (a, b) =>
  a.date.localeCompare(b.date) ||
  String(a.slipNo ?? "").localeCompare(String(b.slipNo ?? ""), "ja", { numeric: true }) ||
  String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));

export function sortRecords(records) {
  return records.slice().sort(bySlip);
}

// 現場ごとの材料一覧（登録順ではなく名前順）
export function materialsOf(records, siteId) {
  const set = new Set(records.filter((r) => r.siteId === siteId && r.material).map((r) => r.material));
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

// 材料入荷・使用量一覧表の行を作る
// endDate を渡すとその日まで空行を伸ばす（画面で今日までの使用量を入力するため）
export function buildLedger(records, usages, siteId, material, { endDate } = {}) {
  const loads = sortRecords(records.filter((r) => r.siteId === siteId && r.material === material && r.date));
  const uses = usages.filter((u) => u.siteId === siteId && u.material === material && u.date);
  const dates = [...loads.map((r) => r.date), ...uses.map((u) => u.date)].sort();
  if (dates.length === 0) return [];

  const start = dates[0];
  let end = dates[dates.length - 1];
  if (endDate && endDate > end) end = endDate;

  const loadsByDate = new Map();
  for (const r of loads) {
    if (!loadsByDate.has(r.date)) loadsByDate.set(r.date, []);
    loadsByDate.get(r.date).push(r);
  }
  const useByDate = new Map(uses.map((u) => [u.date, u.kg]));

  const rows = [];
  let cumCount = 0;
  let cumIn = 0;
  let cumUse = 0;
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const dayLoads = loadsByDate.get(date) ?? [];
    const inKg = dayLoads.reduce((s, r) => s + (Number(r.netKg) || 0), 0);
    const useKg = useByDate.has(date) ? Number(useByDate.get(date)) || 0 : null;
    cumCount += dayLoads.length;
    cumIn += inKg;
    cumUse += useKg ?? 0;
    rows.push({
      date,
      loads: dayLoads,
      count: dayLoads.length,
      cumCount,
      inKg,
      cumIn,
      useKg,
      cumUse,
      remain: cumIn - cumUse,
    });
  }
  return rows;
}

// ファイル名に使えない文字を置き換える
export function safeName(s, max = 60) {
  return String(s ?? "")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || "未設定";
}

// 写真1枚ごとのファイルパス（ZIP と Excel の明細で共通）
export function photoPath(site, recs) {
  const first = sortRecords(recs)[0];
  const date = first?.date || "日付不明";
  const nos = recs.map((r) => r.slipNo).filter(Boolean).join("-") || "番号なし";
  const kg = recs.map((r) => (r.netKg != null ? `${r.netKg}kg` : "")).filter(Boolean).join("-");
  const base = safeName([date, `No${nos}`, first?.material, kg].filter(Boolean).join("_"), 100);
  return `${safeName(site?.name ?? "現場未設定")}/${date.slice(0, 7)}/${base}_${first?.photoId?.slice(0, 4) ?? ""}.jpg`;
}

// 伝票番号＋日付＋現場が同じものを重複候補とみなす
export function findDuplicate(records, rec) {
  if (!rec.slipNo) return null;
  const norm = (s) => String(s).replace(/^0+/, "").replace(/\s/g, "").toUpperCase();
  return records.find(
    (r) => r.id !== rec.id && r.siteId === rec.siteId && r.date === rec.date && norm(r.slipNo) === norm(rec.slipNo),
  ) ?? null;
}

// AI が返した工事名を登録現場に当てる（AI の matched_site_index が無い時の補助）
export function guessSite(sites, text) {
  if (!text) return null;
  const norm = (s) => String(s).replace(/[\s（）()　・]/g, "").replace(/仮称/g, "").replace(/PJT|ＰＪＴ/gi, "プロジェクト");
  const t = norm(text);
  let best = null;
  let bestLen = 0;
  for (const s of sites) {
    const n = norm(s.name);
    // 先頭 8 文字程度が一致すれば同じ現場とみなす
    const len = Math.min(n.length, t.length, 8);
    if (len >= 4 && (t.includes(n.slice(0, len)) || n.includes(t.slice(0, len))) && len > bestLen) {
      best = s;
      bestLen = len;
    }
  }
  return best;
}
