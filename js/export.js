// Excel集計表・写真台帳PDF・写真ZIP・バックアップの生成
import { buildLedger, materialsOf, photoPath, sortRecords, safeName, todayIso } from "./ledger.js";
import { loadImage } from "./image.js";

const libs = {};
function loadScript(src, globalName) {
  if (libs[src]) return libs[src];
  libs[src] = new Promise((resolve, reject) => {
    if (window[globalName]) return resolve(window[globalName]);
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve(window[globalName]);
    s.onerror = () => {
      delete libs[src];
      reject(new Error(`${src} を読み込めませんでした`));
    };
    document.head.appendChild(s);
  });
  return libs[src];
}
const loadExcelJS = () => loadScript("vendor/exceljs.min.js", "ExcelJS");
const loadJSZip = () => loadScript("vendor/jszip.min.js", "JSZip");
const loadJsPDF = () => loadScript("vendor/jspdf.umd.min.js", "jspdf").then((m) => m.jsPDF);

const toDate = (iso) => (iso ? new Date(`${iso}T00:00:00Z`) : null);
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

// ---------- Excel ----------
const THIN = { style: "thin", color: { argb: "FF808080" } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF5" } };
const INPUT_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF8DC" } };
const KG = "#,##0";
const KG_DASH = '#,##0;-#,##0;"－"';

function colName(n) {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function uniqueSheetName(wb, name) {
  const base = String(name).replace(/[\\/?*[\]:]/g, "_").slice(0, 28) || "Sheet";
  let n = base;
  for (let i = 2; wb.getWorksheet(n); i++) n = `${base.slice(0, 27 - String(i).length)}_${i}`;
  return n;
}

function styleRange(ws, r1, c1, r2, c2, style) {
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) Object.assign(ws.getCell(r, c), style);
}

function addLedgerSheet(wb, site, material, rows) {
  const ws = wb.addWorksheet(uniqueSheetName(wb, `${material}_${site.name}`), {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ state: "frozen", xSplit: 2, ySplit: 4 }],
  });
  const maxLoads = Math.max(15, ...rows.map((r) => r.count));
  const cLoad1 = 3;
  const cLoadN = cLoad1 + maxLoads - 1;
  const c = {
    cntDay: cLoadN + 1, cntCum: cLoadN + 2, inDay: cLoadN + 3, inCum: cLoadN + 4,
    useDay: cLoadN + 5, useCum: cLoadN + 6, remain: cLoadN + 7,
  };
  const last = c.remain;

  ws.mergeCells(1, 1, 1, last);
  Object.assign(ws.getCell(1, 1), {
    value: "材料入荷・使用量一覧表",
    font: { bold: true, size: 14, underline: true },
    alignment: { horizontal: "center" },
  });
  ws.getCell(2, 1).value = `工事件名：${site.name}`;
  ws.getCell(2, cLoad1 + 6).value = `材料名：${material}`;
  ws.getCell(2, c.useDay).value = `出力日：${todayIso().replaceAll("-", "/")}`;
  ws.getRow(2).font = { bold: true };

  // 見出し（2段）
  const head = (r1, c1, r2, c2, text) => {
    if (r1 !== r2 || c1 !== c2) ws.mergeCells(r1, c1, r2, c2);
    ws.getCell(r1, c1).value = text;
  };
  head(3, 1, 4, 1, "月");
  head(3, 2, 4, 2, "日");
  head(3, cLoad1, 3, cLoadN, "搬入量 (kg)");
  for (let i = 0; i < maxLoads; i++) ws.getCell(4, cLoad1 + i).value = `${i + 1}台目`;
  head(3, c.cntDay, 3, c.cntCum, "台数 (台)");
  head(3, c.inDay, 3, c.inCum, "搬入量 (kg)");
  head(3, c.useDay, 3, c.useCum, "使用量 (kg)");
  head(3, c.remain, 4, c.remain, "残量 (kg)");
  for (const [col, t] of [[c.cntDay, "日計"], [c.cntCum, "累計"], [c.inDay, "日計"], [c.inCum, "累計"], [c.useDay, "日計"], [c.useCum, "累計"]]) {
    ws.getCell(4, col).value = t;
  }
  styleRange(ws, 3, 1, 4, last, {
    fill: HEAD_FILL, border: BORDER, font: { bold: true, size: 9 },
    alignment: { horizontal: "center", vertical: "middle", wrapText: true },
  });

  const L = colName;
  rows.forEach((row, i) => {
    const r = 5 + i;
    const [y, m, d] = row.date.split("-").map(Number);
    ws.getCell(r, 1).value = m;
    ws.getCell(r, 2).value = d;
    row.loads.forEach((rec, j) => {
      const cell = ws.getCell(r, cLoad1 + j);
      cell.value = rec.netKg ?? null;
    });
    const loadRange = `${L(cLoad1)}${r}:${L(cLoadN)}${r}`;
    const prev = (col) => (i === 0 ? "" : `${L(col)}${r - 1}+`);
    ws.getCell(r, c.cntDay).value = { formula: `COUNT(${loadRange})`, result: row.count };
    ws.getCell(r, c.cntCum).value = { formula: `${prev(c.cntCum)}${L(c.cntDay)}${r}`, result: row.cumCount };
    ws.getCell(r, c.inDay).value = { formula: `SUM(${loadRange})`, result: row.inKg };
    ws.getCell(r, c.inCum).value = { formula: `${prev(c.inCum)}${L(c.inDay)}${r}`, result: row.cumIn };
    ws.getCell(r, c.useDay).value = row.useKg;
    ws.getCell(r, c.useCum).value = { formula: `${prev(c.useCum)}N(${L(c.useDay)}${r})`, result: row.cumUse };
    ws.getCell(r, c.remain).value = { formula: `${L(c.inCum)}${r}-${L(c.useCum)}${r}`, result: row.remain };
    for (let col = 1; col <= last; col++) {
      const cell = ws.getCell(r, col);
      cell.border = BORDER;
      cell.font = { size: 10 };
      if (col >= cLoad1) cell.numFmt = col === c.inDay ? KG_DASH : KG;
      if (col === c.useDay) cell.fill = INPUT_FILL;
      if (col <= 2) cell.alignment = { horizontal: "center" };
    }
    if (y && new Date(`${row.date}T00:00:00Z`).getUTCDay() === 0) ws.getCell(r, 2).font = { size: 10, color: { argb: "FFC00000" } };
  });

  ws.getColumn(1).width = 4;
  ws.getColumn(2).width = 4;
  for (let col = cLoad1; col <= cLoadN; col++) ws.getColumn(col).width = 8.5;
  for (const col of [c.cntDay, c.cntCum]) ws.getColumn(col).width = 6;
  for (const col of [c.inDay, c.inCum, c.useDay, c.useCum, c.remain]) ws.getColumn(col).width = 10;
  ws.getCell(rows.length + 6, 1).value =
    "※黄色の「使用量 日計」は入力欄です。累計・残量は数式で自動計算されます。";
  ws.getCell(rows.length + 6, 1).font = { size: 9, color: { argb: "FF555555" } };
  return ws;
}

function addDetailSheet(wb, sites, records, photoPaths) {
  const ws = wb.addWorksheet("明細", { views: [{ state: "frozen", ySplit: 1 }] });
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  ws.columns = [
    { header: "現場", key: "site", width: 28 },
    { header: "年月", key: "ym", width: 9 },
    { header: "日付", key: "date", width: 11, style: { numFmt: "yyyy/mm/dd" } },
    { header: "材料(品種)", key: "material", width: 14 },
    { header: "正味(kg)", key: "netKg", width: 10, style: { numFmt: KG } },
    { header: "全重(kg)", key: "grossKg", width: 10, style: { numFmt: KG } },
    { header: "風袋(kg)", key: "tareKg", width: 10, style: { numFmt: KG } },
    { header: "袋数", key: "bags", width: 6 },
    { header: "運送会社", key: "carrier", width: 18 },
    { header: "車番", key: "vehicleNo", width: 8 },
    { header: "入力方法", key: "source", width: 10 },
    { header: "備考", key: "note", width: 24 },
    { header: "写真ファイル", key: "photo", width: 40 },
    { header: "登録日時", key: "createdAt", width: 17, style: { numFmt: "yyyy/mm/dd hh:mm" } },
  ];
  for (const r of sortRecords(records)) {
    const row = ws.addRow({
      ...r,
      site: siteName.get(r.siteId) ?? "（現場未設定）",
      ym: r.date ? r.date.slice(0, 7) : "",
      date: toDate(r.date),
      source: { ai: "AI読取", ocr: "自動読取" }[r.source] ? `${{ ai: "AI読取", ocr: "自動読取" }[r.source]}${r.edited ? "+手修正" : ""}` : "手入力",
      createdAt: r.createdAt ? new Date(r.createdAt) : null,
      photo: null,
    });
    const path = photoPaths.get(r.photoId);
    if (path) row.getCell("photo").value = { text: path, hyperlink: path };
  }
  ws.getRow(1).eachCell((cell) => Object.assign(cell, { fill: HEAD_FILL, font: { bold: true }, border: BORDER }));
  ws.autoFilter = { from: "A1", to: `${colName(ws.columnCount)}1` };
  return ws;
}

function addSummarySheet(wb, sites, records, usages, detailRows) {
  const ws = wb.addWorksheet("現場別集計", { views: [{ state: "frozen", ySplit: 3 }] });
  ws.getCell("A1").value = "現場別・材料別 集計";
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.getCell("A2").value = `出力日：${todayIso().replaceAll("-", "/")}　※「明細」シートの数値を集計しています（明細を直すと自動で再計算）`;
  ws.getCell("A2").font = { size: 9, color: { argb: "FF555555" } };
  const header = ["現場", "材料", "年月", "台数", "搬入量(kg)", "使用量(kg)"];
  ws.getRow(3).values = header;
  ws.getRow(3).eachCell((cell) => Object.assign(cell, { fill: HEAD_FILL, font: { bold: true }, border: BORDER }));
  [30, 16, 10, 8, 14, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const n = detailRows + 1;
  const D = (col) => `明細!$${col}$2:$${col}$${Math.max(n, 2)}`;
  let r = 4;
  const addLine = (site, material, ym, bold) => {
    const crit = [`${D("A")},$A${r}`, `${D("D")},$B${r}`];
    if (ym) crit.push(`${D("B")},$C${r}`);
    const recs = records.filter((x) => x.siteId === site.id && x.material === material && (!ym || x.date?.startsWith(ym)));
    const use = usages
      .filter((u) => u.siteId === site.id && u.material === material && (!ym || u.date.startsWith(ym)))
      .reduce((s, u) => s + (Number(u.kg) || 0), 0);
    const row = ws.getRow(r);
    row.values = [site.name, material, ym || "合計"];
    row.getCell(4).value = { formula: `COUNTIFS(${crit.join(",")})`, result: recs.length };
    row.getCell(5).value = {
      formula: `SUMIFS(${D("E")},${crit.join(",")})`,
      result: recs.reduce((s, x) => s + (Number(x.netKg) || 0), 0),
    };
    row.getCell(6).value = use || null;
    row.getCell(4).numFmt = "#,##0";
    row.getCell(5).numFmt = KG;
    row.getCell(6).numFmt = KG;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = BORDER;
      if (bold) {
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
      }
    });
    r++;
  };
  for (const site of sites) {
    for (const material of materialsOf(records, site.id)) {
      const months = [...new Set(records.filter((x) => x.siteId === site.id && x.material === material && x.date).map((x) => x.date.slice(0, 7)))].sort();
      for (const ym of months) addLine(site, material, ym, false);
      addLine(site, material, null, true);
    }
  }
  ws.getCell(r + 1, 1).value = "※使用量は「集計」画面で入力した値です。";
  ws.getCell(r + 1, 1).font = { size: 9, color: { argb: "FF555555" } };
  return ws;
}

export async function buildWorkbook({ sites, records, usages, photos }) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = "納品書管理";
  wb.created = new Date();

  const photoPaths = photoPathMap(sites, records, photos);
  addSummarySheet(wb, sites, records, usages, records.length);
  for (const site of sites) {
    for (const material of materialsOf(records, site.id)) {
      addLedgerSheet(wb, site, material, buildLedger(records, usages, site.id, material));
    }
  }
  addDetailSheet(wb, sites, records, photoPaths);
  wb.views = [{ activeTab: 0 }];
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// photoId -> ZIP内パス（同じ写真に複数伝票が写っている場合も1ファイル）
function photoPathMap(sites, records, photos) {
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const byPhoto = new Map();
  for (const r of records) {
    if (!r.photoId) continue;
    if (!byPhoto.has(r.photoId)) byPhoto.set(r.photoId, []);
    byPhoto.get(r.photoId).push(r);
  }
  const map = new Map();
  const used = new Set();
  const have = photos ? new Set(photos.map((p) => p.id)) : null;
  for (const [photoId, recs] of byPhoto) {
    if (have && !have.has(photoId)) continue;
    let path = `納品書写真/${photoPath(siteById.get(recs[0].siteId), recs)}`;
    for (let i = 2; used.has(path); i++) path = path.replace(/(_\d+)?\.jpg$/, `_${i}.jpg`);
    used.add(path);
    map.set(photoId, path);
  }
  return map;
}

// ---------- 写真ZIP ----------
export async function buildPhotoZip({ sites, records, photos, workbook }) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const paths = photoPathMap(sites, records, photos);
  const photoById = new Map(photos.map((p) => [p.id, p]));
  for (const [id, path] of paths) zip.file(path, photoById.get(id).blob);
  if (workbook) zip.file(`納品書集計_${stamp()}.xlsx`, workbook);
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

// ---------- 写真台帳PDF（A4横に3枚ずつ。今のテープ貼り台帳の置き換え） ----------
const PAGE_W = 1754; // A4横 150dpi
const PAGE_H = 1240;

function drawCaption(ctx, lines, x, y, w) {
  ctx.fillStyle = "#111";
  ctx.font = "bold 22px 'Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif";
  ctx.fillText(lines[0], x, y, w);
  ctx.font = "20px 'Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif";
  lines.slice(1).forEach((l, i) => ctx.fillText(l, x, y + 28 * (i + 1), w));
}

export async function buildPhotoPdf({ sites, records, photos, onProgress }) {
  const jsPDF = await loadJsPDF();
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  let firstPage = true;
  let done = 0;

  for (const site of sites) {
    // 写真単位にまとめ、日付順に並べる
    const groups = new Map();
    for (const r of sortRecords(records.filter((x) => x.siteId === site.id && x.photoId && photoById.has(x.photoId)))) {
      if (!groups.has(r.photoId)) groups.set(r.photoId, []);
      groups.get(r.photoId).push(r);
    }
    const items = [...groups.entries()];
    const pages = Math.ceil(items.length / 3);
    for (let p = 0; p < pages; p++) {
      const canvas = document.createElement("canvas");
      canvas.width = PAGE_W;
      canvas.height = PAGE_H;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, PAGE_W, PAGE_H);
      ctx.fillStyle = "#111";
      ctx.font = "bold 26px 'Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif";
      ctx.fillText(`納品書台帳　${site.name}`, 50, 52, PAGE_W - 300);
      ctx.font = "20px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`${p + 1} / ${pages}`, PAGE_W - 50, 52);
      ctx.textAlign = "left";

      const colW = (PAGE_W - 100) / 3;
      const slice = items.slice(p * 3, p * 3 + 3);
      for (let i = 0; i < slice.length; i++) {
        const [photoId, recs] = slice[i];
        const x = 50 + i * colW;
        const lines = recs.slice(0, 2).map((r) =>
          `${(r.date ?? "日付不明").replaceAll("-", "/")}　${r.material ?? ""}`,
        );
        lines.splice(1, 0, `正味 ${recs.map((r) => (r.netKg != null ? Number(r.netKg).toLocaleString("ja-JP") : "-")).join(" / ")} kg`);
        drawCaption(ctx, lines, x + 10, 100, colW - 20);
        const top = 100 + 28 * lines.length;
        const url = URL.createObjectURL(photoById.get(photoId).blob);
        try {
          const img = await loadImage(url);
          const boxW = colW - 20;
          const boxH = PAGE_H - top - 40;
          const s = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
          const w = img.naturalWidth * s;
          const h = img.naturalHeight * s;
          ctx.drawImage(img, x + 10 + (boxW - w) / 2, top, w, h);
          ctx.strokeStyle = "#bbb";
          ctx.strokeRect(x + 10 + (boxW - w) / 2, top, w, h);
        } finally {
          URL.revokeObjectURL(url);
        }
        onProgress?.(++done);
      }
      if (!firstPage) pdf.addPage("a4", "landscape");
      firstPage = false;
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.82), "JPEG", 0, 0, 297, 210);
    }
  }
  if (firstPage) throw new Error("写真付きの伝票がありません");
  return pdf.output("blob");
}

// ---------- バックアップ / 復元 ----------
export async function buildBackup({ sites, records, usages, photos }) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  zip.file(
    "data.json",
    JSON.stringify({ app: "nouhinsho", version: 1, exportedAt: new Date().toISOString(), sites, records, usages }, null, 1),
  );
  for (const p of photos) {
    zip.file(`photos/${p.id}.jpg`, p.blob);
    if (p.thumb) zip.file(`thumbs/${p.id}.jpg`, p.thumb);
  }
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

export async function readBackup(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const dataFile = zip.file("data.json");
  if (!dataFile) throw new Error("バックアップファイルではありません");
  const data = JSON.parse(await dataFile.async("string"));
  if (data.app !== "nouhinsho") throw new Error("このアプリのバックアップではありません");
  const photos = [];
  for (const f of zip.file(/^photos\/.+\.jpg$/)) {
    const id = f.name.slice(7, -4);
    const blob = new Blob([await f.async("arraybuffer")], { type: "image/jpeg" });
    const t = zip.file(`thumbs/${id}.jpg`);
    const thumb = t ? new Blob([await t.async("arraybuffer")], { type: "image/jpeg" }) : blob;
    photos.push({ id, blob, thumb, createdAt: data.exportedAt });
  }
  return { ...data, photos };
}

export function fileName(kind, siteName) {
  const scope = siteName ? `_${safeName(siteName, 30)}` : "";
  return `${kind}${scope}_${stamp()}`;
}
