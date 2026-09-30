// 納品書管理：撮影 → 端末内で正味を読み取り → 確認・保存 → 現場別集計 / Excel・写真台帳出力
import * as db from "./js/db.js";
import { preparePhoto, rotatePhoto, blobToBase64, cropDataUrl } from "./js/image.js";
import {
  buildLedger, materialsOf, sortRecords, todayIso, usageKey, guessSite,
} from "./js/ledger.js";
import {
  buildWorkbook, buildPhotoPdf, buildPhotoZip, buildBackup, readBackup, fileName,
} from "./js/export.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- 状態 ----------
const state = {
  sites: [],
  records: [],
  usages: [],
  queue: [], // { photoId, status: reading|review|error|manual, slips: [draft], error, message }
  currentSite: "",
  passcode: "",
  autoRead: true,
  useAi: false,
  materialAliases: {},
  siteAliases: {},
};

const FIELDS = [
  "siteId", "date", "material", "slipNo", "netKg", "grossKg", "tareKg", "bags",
  "carrier", "vehicleNo", "origin", "supplier", "projectNameRead", "note",
];
const NUMERIC = new Set(["netKg", "grossKg", "tareKg", "bags"]);
const AI_TO_APP = {
  date: "date", slip_no: "slipNo", product: "material", project_name: "projectNameRead",
  net_kg: "netKg", gross_kg: "grossKg", tare_kg: "tareKg", bags: "bags", carrier: "carrier",
  vehicle_no: "vehicleNo", origin: "origin", supplier: "supplier",
};

// ---------- 小物 ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

let toastTimer;
function toast(msg, ms = 2500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const kg = (n) => (n == null || n === "" ? "-" : Number(n).toLocaleString("ja-JP"));
const fmtDate = (iso) => (iso ? iso.replaceAll("-", "/") : "日付なし");
const norm = (s) => (s == null ? "" : String(s).normalize("NFKC").trim());
const siteName = (id) => state.sites.find((s) => s.id === id)?.name ?? "（現場未設定）";
const activeSites = () => state.sites.filter((s) => !s.archived);

const thumbUrls = new Map();
async function thumbUrl(photoId) {
  if (!photoId) return "";
  if (thumbUrls.has(photoId)) return thumbUrls.get(photoId);
  const p = await db.get("photos", photoId);
  const url = p ? URL.createObjectURL(p.thumb || p.blob) : "";
  thumbUrls.set(photoId, url);
  return url;
}
function dropThumb(photoId) {
  const url = thumbUrls.get(photoId);
  if (url) URL.revokeObjectURL(url);
  thumbUrls.delete(photoId);
}
function thumbImg(photoId, attrs = {}) {
  const img = h("img", { alt: "伝票の写真", loading: "lazy", ...attrs });
  thumbUrl(photoId).then((u) => u && (img.src = u));
  return img;
}

let saveQueueTimer;
function persistQueue() {
  clearTimeout(saveQueueTimer);
  saveQueueTimer = setTimeout(() => db.setMeta("queue", state.queue), 300);
}

// ---------- ダイアログ ----------
const dialog = $("#dialog");
function openDialog(body, actions) {
  dialog.replaceChildren(h("div", { class: "dialog-body" }, body), h("div", { class: "dialog-actions" }, actions));
  if (!dialog.open) dialog.showModal();
}
const closeDialog = () => dialog.close();
dialog.addEventListener("click", (e) => e.target === dialog && closeDialog());

async function showPhoto(photoId) {
  const p = await db.get("photos", photoId);
  if (!p) return toast("写真が見つかりません");
  const url = URL.createObjectURL(p.blob);
  openDialog(h("img", { src: url, alt: "伝票の写真" }), [
    h("button", { class: "btn btn-secondary", type: "button", onclick: closeDialog }, "閉じる"),
  ]);
  dialog.addEventListener("close", () => URL.revokeObjectURL(url), { once: true });
}

// 生成したファイルを保存または共有（共有はメール・LINE・Googleドライブ等へ送れる）
function deliver(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  const download = () => {
    closeDialog(); // モーダル表示中は body 配下が inert になり download 属性が効かないため先に閉じる
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const canShare = navigator.canShare?.({ files: [file] });
  openDialog(
    h("div", {}, h("p", {}, "作成しました："), h("p", {}, h("strong", {}, name)),
      h("p", { class: "hint" }, `${(blob.size / 1024 / 1024).toFixed(1)} MB`)),
    [
      h("button", { class: "btn btn-secondary", type: "button", onclick: closeDialog }, "閉じる"),
      canShare && h("button", {
        class: "btn btn-secondary", type: "button",
        onclick: async () => {
          try {
            await navigator.share({ files: [file], title: name });
            closeDialog();
          } catch (e) {
            if (e.name !== "AbortError") toast("共有できませんでした");
          }
        },
      }, "共有（メール・LINE等）"),
      h("button", { class: "btn btn-primary", type: "button", onclick: download }, "端末に保存"),
    ],
  );
}

// ---------- タブ ----------
function showTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "list") renderList();
  if (name === "ledger") renderLedger();
  if (name === "settings") renderSettings();
  window.scrollTo(0, 0);
}
$$(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- 現場セレクト ----------
function fillSiteSelect(sel, { value, withAll = false, includeArchived = true, withNew = false, allowEmpty = false } = {}) {
  const opts = [];
  if (withAll) opts.push(h("option", { value: "" }, "すべての現場"));
  if (!withAll && (allowEmpty || !value)) opts.push(h("option", { value: "" }, "（現場を選択）"));
  for (const s of state.sites) {
    if (!includeArchived && s.archived && s.id !== value) continue;
    opts.push(h("option", { value: s.id }, s.archived ? `${s.name}（完了）` : s.name));
  }
  if (withNew) opts.push(h("option", { value: "__new" }, "＋ 新しい現場を登録…"));
  sel.replaceChildren(...opts);
  sel.value = value ?? "";
  if (sel.value !== (value ?? "")) sel.value = "";
}

async function addSite(name) {
  name = norm(name);
  if (!name) return null;
  const exists = state.sites.find((s) => s.name === name);
  if (exists) return exists;
  const site = { id: db.newId(), name, archived: false, createdAt: new Date().toISOString() };
  await db.put("sites", site);
  state.sites.push(site);
  refreshSiteSelects();
  showAiStatus("");
  return site;
}

async function promptNewSite() {
  const name = prompt("現場名（工事件名）を入力してください");
  return name ? addSite(name) : null;
}

function refreshSiteSelects() {
  fillSiteSelect($("#currentSite"), { value: state.currentSite, includeArchived: false, withNew: true });
  fillSiteSelect($("#listSite"), { value: $("#listSite").value, withAll: true });
  fillSiteSelect($("#ledgerSite"), { value: $("#ledgerSite").value || state.currentSite });
  fillSiteSelect($("#exportSite"), { value: $("#exportSite").value, withAll: true });
  const mats = new Set(state.records.map((r) => r.material).filter(Boolean));
  $("#materialList").replaceChildren(...[...mats].sort().map((m) => h("option", { value: m })));
}

$("#currentSite").addEventListener("change", async (e) => {
  if (e.target.value === "__new") {
    const site = await promptNewSite();
    e.target.value = site?.id ?? state.currentSite;
    if (!site) return;
  }
  state.currentSite = e.target.value;
  await db.setMeta("currentSite", state.currentSite);
});

// ---------- 撮影・取り込み ----------
async function ingest(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/") && !/\.(jpe?g|png|heic|webp)$/i.test(file.name)) continue;
    try {
      const { photo, thumb } = await preparePhoto(file);
      const photoId = db.newId();
      await db.put("photos", { id: photoId, blob: photo, thumb, createdAt: new Date().toISOString() });
      const item = { photoId, status: "manual", slips: [emptyDraft()], error: "", message: "" };
      state.queue.unshift(item);
      persistQueue();
      renderQueue();
      if (state.autoRead) readItem(item);
    } catch (e) {
      console.error(e);
      toast(`画像を読み込めませんでした（${file.name}）。HEIC形式の場合は「互換性優先」で撮影してください`);
    }
  }
  requestPersist();
}

$("#cameraInput").addEventListener("change", (e) => {
  ingest([...e.target.files]);
  e.target.value = "";
});
$("#fileInput").addEventListener("change", (e) => {
  ingest([...e.target.files]);
  e.target.value = "";
});

function emptyDraft() {
  return { siteId: state.currentSite || "", date: todayIso(), material: lastMaterial(state.currentSite), uncertain: [], ai: null, ocr: null };
}

function lastMaterial(siteId) {
  const recs = state.records.filter((r) => r.siteId === siteId);
  return recs.length ? sortRecords(recs).at(-1).material : "";
}

// よく使う値（新しい順に重み付けして上位を返す）
function frequent(values, n) {
  const score = new Map();
  values.forEach((v, i) => v != null && v !== "" && score.set(v, (score.get(v) ?? 0) + 1 + i / values.length));
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v);
}
function materialChips(siteId) {
  const recs = sortRecords(state.records.filter((r) => r.siteId === siteId));
  return frequent(recs.map((r) => r.material), 4);
}
function netChips(draft) {
  const recs = sortRecords(state.records.filter((r) => r.siteId === draft.siteId && r.material === draft.material));
  const ocr = draft.ocr?.candidates ?? [];
  return [...new Set([...ocr, ...frequent(recs.map((r) => Number(r.netKg)), 4)])].slice(0, 6);
}

// ---------- 読み取り（端末内の文字認識。設定で有料AIも選べる） ----------
async function readItem(item) {
  item.status = "reading";
  item.error = "";
  updateCard(item);
  try {
    if (state.useAi) {
      try {
        await readItemAi(item);
        return;
      } catch (e) {
        item.message = `AI読み取りに失敗したため端末内で読み取ります（${e.message}）`;
      }
    }
    await readItemLocal(item);
  } catch (e) {
    console.error(e);
    item.status = "manual";
    item.error = `自動読み取りできませんでした（${e.message}）。正味を入力してください`;
  } finally {
    persistQueue();
    updateCard(item);
  }
}

async function readItemLocal(item) {
  const ready = await db.getMeta("ocrReady", false);
  if (!ready) showAiStatus("初回のみ文字認識データ（約30MB）を読み込みます。Wi-Fiでの利用をおすすめします。");
  const photo = await db.get("photos", item.photoId);
  const { readSlip } = await import("./js/ocr.js");
  const r = await readSlip(photo.blob, todayIso());
  if (!ready) {
    await db.setMeta("ocrReady", true);
    showAiStatus("");
  }
  const draft = item.slips[0] ?? (item.slips[0] = emptyDraft());
  const crop = (box) => (box ? cropDataUrl(photo.blob, box).catch(() => null) : null);
  draft.ocr = {
    netKg: r.netKg, confidence: r.confidence, candidates: r.candidates, crop: await crop(r.netBox),
    date: r.date, dateConfidence: r.dateConfidence, dateCrop: await crop(r.dateBox),
  };
  const uncertain = new Set(draft.uncertain ?? []);
  // 読み取り中に手で入れた値は上書きしない
  if (r.netKg != null && (draft.netKg == null || draft.netKg === "")) {
    draft.netKg = r.netKg;
    r.confidence === "high" ? uncertain.delete("netKg") : uncertain.add("netKg");
  }
  if (r.date && !draft.dateTouched) {
    draft.date = r.date;
    r.dateConfidence === "high" ? uncertain.delete("date") : uncertain.add("date");
  } else if (!r.date && !draft.dateTouched) {
    uncertain.add("date"); // 撮影日のまま
  }
  draft.uncertain = [...uncertain];
  const notes = [];
  if (r.netKg == null) notes.push(r.candidates.length ? "正味を特定できませんでした。候補から選ぶか入力してください" : "正味を読み取れませんでした。入力してください");
  if (r.confidence === "low") notes.push("全重−風袋と正味が合いません。写真で確認してください");
  if (!r.date) notes.push("日付を読み取れなかったため撮影日を入れました");
  item.message = notes.join("／");
  item.status = r.netKg == null ? "manual" : r.confidence === "high" && r.dateConfidence === "high" ? "ok" : "review";
}

async function callApi(photoBlob) {
  const image = await blobToBase64(photoBlob);
  const sites = activeSites();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch("/api/read-slip", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-passcode": state.passcode },
      body: JSON.stringify({ image, mediaType: "image/jpeg", sites: sites.map((s) => s.name) }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({ error: `サーバーエラー (${res.status})` }));
    if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
    return { data, sites };
  } catch (e) {
    if (e.name === "AbortError") e.message = "時間切れです";
    if (e instanceof TypeError) e.message = "通信できません（圏外？）";
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readItemAi(item) {
  const photo = await db.get("photos", item.photoId);
  const { data, sites } = await callApi(photo.blob);
  if (data.rotation_cw) {
    const rotated = await rotatePhoto(photo.blob, data.rotation_cw);
    await db.put("photos", { ...photo, blob: rotated.photo, thumb: rotated.thumb });
    dropThumb(item.photoId);
  }
  const slips = (data.slips ?? []).map((s) => draftFromAi(s, sites));
  if (slips.length === 0) throw new Error("伝票が見つかりませんでした");
  item.slips = slips;
  item.message = data.image_problem || "";
  item.status = slips.some((s) => s.uncertain.length) ? "review" : "ok";
}

function showAiStatus(msg) {
  const el = $("#aiStatus");
  el.textContent = msg;
  el.hidden = !msg;
}

function draftFromAi(s, sites) {
  const d = { uncertain: [], ai: {}, ocr: null };
  for (const [aiKey, key] of Object.entries(AI_TO_APP)) {
    let v = s[aiKey];
    if (v == null) continue;
    if (!NUMERIC.has(key)) v = norm(v);
    d[key] = v;
  }
  d.consignee = norm(s.consignee);
  d.documentType = norm(s.document_type);
  if (d.material && state.materialAliases[d.material]) d.material = state.materialAliases[d.material];
  d.uncertain = (s.uncertain_fields ?? []).map((f) => AI_TO_APP[f]).filter(Boolean);
  if (s.note) d.note = s.note;

  // 現場の振り分け：過去の手修正 → AIの判定 → 名前の部分一致 → 現在の現場
  const read = norm(s.project_name);
  const learned = state.siteAliases[read];
  const aiSite = sites[s.matched_site_index];
  const site = (learned && state.sites.find((x) => x.id === learned)) || aiSite || guessSite(activeSites(), read);
  d.siteId = site?.id ?? state.currentSite ?? "";
  if (!site && read) d.uncertain.push("siteId");
  d.ai = Object.fromEntries(FIELDS.map((f) => [f, d[f] ?? null]));
  return d;
}

// ---------- 確認待ちカード ----------
const cardEls = new WeakMap();

function renderQueue() {
  const q = $("#queue");
  q.replaceChildren(...state.queue.map((item) => {
    const el = renderCard(item);
    cardEls.set(item, el);
    return el;
  }));
  const n = state.queue.length;
  $("#emptyQueue").hidden = n > 0;
  $("#queueHead").hidden = n === 0;
  $("#queueCount").textContent = n ? `（${n}件）` : "";
  $("#badge").hidden = n === 0;
  $("#badge").textContent = n;
}

// 1枚だけ描き直す（他のカードで入力中の内容・フォーカスを壊さない）
function updateCard(item) {
  const old = cardEls.get(item);
  if (!old || !old.isConnected) return renderQueue();
  const el = renderCard(item);
  cardEls.set(item, el);
  old.replaceWith(el);
}

const STATUS_LABEL = {
  reading: ["reading", "文字を読み取り中…"],
  ok: ["ready", "日付・正味を自動入力しました（正味は全重−風袋で検算済み）"],
  review: ["review", "自動入力しました：黄色の項目を写真で確認してください"],
  manual: ["review", "正味を入力してください"],
  error: ["error", "読み取れませんでした"],
};

function renderCard(item) {
  const [cls, label] = STATUS_LABEL[item.status] ?? STATUS_LABEL.manual;
  const card = h("article", { class: "card" },
    h("div", { class: "card-head" },
      thumbImg(item.photoId, { onclick: () => showPhoto(item.photoId) }),
      h("div", { class: "card-status" },
        h("span", { class: `status ${cls}` }, label),
        item.slips.length > 1 && h("div", {}, `この写真に伝票が${item.slips.length}枚あります`),
        item.error && h("div", { class: "msg err" }, item.error),
        item.message && h("div", { class: "msg warn" }, item.message),
        h("div", { class: "hint" }, "写真をタップすると拡大できます"),
      ),
    ),
  );
  item.slips.forEach((draft, i) => card.append(renderSlipForm(item, draft, i)));
  card.append(h("div", { class: "card-actions" },
    h("button", { class: "btn btn-small btn-secondary", type: "button", title: "左に90°回転", onclick: () => rotateQueued(item, 270) }, "↺"),
    h("button", { class: "btn btn-small btn-secondary", type: "button", title: "右に90°回転", onclick: () => rotateQueued(item, 90) }, "↻"),
    item.status !== "reading" && h("button", { class: "btn btn-small btn-secondary", type: "button", onclick: () => readItem(item) }, "再読取"),
    h("button", { class: "btn btn-small btn-secondary", type: "button", onclick: () => { item.slips.push(emptyDraft()); persistQueue(); updateCard(item); } }, "＋伝票"),
    h("span", { class: "spacer" }),
    h("button", { class: "btn btn-small btn-danger", type: "button", onclick: () => discardItem(item) }, "破棄"),
    h("button", { class: "btn btn-small btn-primary", type: "button", onclick: () => saveItem(item) }, "保存"),
  ));
  return card;
}

function renderSlipForm(item, draft, index) {
  const wrap = h("div", { class: "slip" });
  if (item.slips.length > 1) {
    wrap.append(h("div", { class: "slip-title" }, `伝票 ${index + 1}`,
      " ", h("button", { class: "btn btn-small btn-danger", type: "button", onclick: () => { item.slips.splice(index, 1); persistQueue(); updateCard(item); } }, "この伝票を除く")));
  }
  wrap.append(buildForm(draft, (key, value) => {
    draft[key] = value;
    if (key === "date") draft.dateTouched = true;
    draft.uncertain = (draft.uncertain ?? []).filter((f) => f !== key);
    persistQueue();
  }));
  return wrap;
}

function chipRow(values, format, onPick) {
  return values.map((v) => h("button", { class: "chip", type: "button", onclick: () => onPick(v) }, format(v)));
}

// 伝票フォーム（確認待ち・一覧の編集で共用）
function buildForm(values, onChange) {
  const frag = $("#slipFormTpl").content.cloneNode(true);
  const form = frag.querySelector(".slip-form");
  fillSiteSelect(form.querySelector("[name=siteId]"), { value: values.siteId, withNew: true, allowEmpty: true });
  const set = (key, v) => {
    const el = form.querySelector(`[name=${key}]`);
    el.value = v;
    el.dispatchEvent(new Event("change"));
  };
  const renderChips = () => {
    form.querySelector("[data-chips=material]").replaceChildren(
      ...chipRow(materialChips(values.siteId).filter((m) => m !== values.material), (m) => m, (m) => set("material", m)));
    const nets = netChips(values).filter((n) => Number(n) !== Number(values.netKg));
    form.querySelector("[data-chips=netKg]").replaceChildren(
      ...(nets.length ? [h("span", { class: "chip-label" }, "候補：")] : []),
      ...chipRow(nets, (n) => kg(n), (n) => set("netKg", n)));
  };
  for (const el of form.querySelectorAll("[name]")) {
    const key = el.name;
    if (key !== "siteId") el.value = values[key] ?? "";
    if (values.uncertain?.includes(key)) el.classList.add("uncertain");
    el.addEventListener("change", async () => {
      let v = el.value;
      if (key === "siteId" && v === "__new") {
        const site = await promptNewSite();
        v = site?.id ?? "";
        fillSiteSelect(el, { value: v, withNew: true, allowEmpty: true });
      }
      el.classList.remove("uncertain");
      onChange(key, NUMERIC.has(key) ? (v === "" ? null : Number(v)) : v.trim());
      if (["siteId", "material", "netKg"].includes(key)) renderChips();
    });
  }
  if (values.ocr?.crop) {
    form.querySelector("[data-crop=netKg]").replaceChildren(h("img", { src: values.ocr.crop, alt: "写真の正味欄（拡大）" }));
  }
  if (values.ocr?.dateCrop) {
    form.querySelector("[data-crop=date]").replaceChildren(h("img", { src: values.ocr.dateCrop, alt: "写真の日付欄（拡大）" }));
  }
  renderChips();
  return frag;
}

async function rotateQueued(item, deg) {
  const p = await db.get("photos", item.photoId);
  const r = await rotatePhoto(p.blob, deg);
  await db.put("photos", { ...p, blob: r.photo, thumb: r.thumb });
  dropThumb(item.photoId);
  updateCard(item);
}

async function discardItem(item) {
  if (!confirm("この写真と入力内容を破棄しますか？")) return;
  state.queue = state.queue.filter((x) => x !== item);
  if (!state.records.some((r) => r.photoId === item.photoId)) {
    await db.del("photos", item.photoId);
    dropThumb(item.photoId);
  }
  persistQueue();
  renderQueue();
}

function validate(d) {
  const missing = [];
  if (!d.siteId) missing.push("現場");
  if (!d.date) missing.push("日付");
  if (!d.material) missing.push("材料");
  if (d.netKg == null || d.netKg === "" || Number.isNaN(Number(d.netKg))) missing.push("正味(kg)");
  return missing;
}

function toRecord(draft, photoId) {
  const rec = { id: db.newId(), photoId, createdAt: new Date().toISOString() };
  for (const f of FIELDS) rec[f] = draft[f] ?? null;
  rec.consignee = draft.consignee ?? null;
  rec.documentType = draft.documentType ?? null;
  if (draft.ai) {
    rec.source = "ai";
    rec.edited = FIELDS.some((f) => String(draft.ai[f] ?? "") !== String(rec[f] ?? ""));
  } else if (draft.ocr?.netKg != null || draft.ocr?.date) {
    rec.source = "ocr";
    rec.edited = (draft.ocr.netKg != null && Number(draft.ocr.netKg) !== Number(rec.netKg)) || (!!draft.ocr.date && draft.ocr.date !== rec.date);
  } else {
    rec.source = "manual";
    rec.edited = false;
  }
  return rec;
}

// 手修正を覚えて次回から自動で直す（AI読み取り時の材料名・現場の振り分け）
async function learn(draft) {
  if (!draft.ai) return;
  let changed = false;
  if (draft.ai.material && draft.material && draft.ai.material !== draft.material) {
    state.materialAliases[draft.ai.material] = draft.material;
    changed = true;
  }
  const read = norm(draft.ai.projectNameRead);
  if (read && draft.siteId && state.siteAliases[read] !== draft.siteId && draft.ai.siteId !== draft.siteId) {
    state.siteAliases[read] = draft.siteId;
    changed = true;
  }
  if (changed) {
    await db.setMeta("materialAliases", state.materialAliases);
    await db.setMeta("siteAliases", state.siteAliases);
  }
}

async function saveItem(item, { silent = false } = {}) {
  for (const [i, d] of item.slips.entries()) {
    const missing = validate(d);
    if (missing.length) {
      if (!silent) toast(`${item.slips.length > 1 ? `伝票${i + 1}：` : ""}${missing.join("・")}を入力してください`);
      return false;
    }
  }
  const recs = item.slips.map((d) => toRecord(d, item.photoId));
  for (const [i, rec] of recs.entries()) {
    await db.put("records", rec);
    state.records.push(rec);
    await learn(item.slips[i]);
  }
  state.queue = state.queue.filter((x) => x !== item);
  persistQueue();
  refreshSiteSelects();
  renderQueue();
  if (!silent) toast(`保存しました（${recs.map((r) => `${kg(r.netKg)}kg`).join("・")}）`);
  return true;
}

$("#saveAllBtn").addEventListener("click", async () => {
  const targets = state.queue.filter((x) => x.status !== "reading");
  const unsure = targets.reduce((n, x) => n + x.slips.reduce((m, s) => m + (s.uncertain?.length ?? 0), 0), 0);
  if (unsure && !confirm(`確認が必要な項目（黄色）が${unsure}件あります。写真と見比べましたか？このまま保存しますか？`)) return;
  let ok = 0;
  for (const item of targets) if (await saveItem(item, { silent: true })) ok++;
  const left = state.queue.length;
  toast(`${ok}件保存しました${left ? `。${left}件は未保存です（未入力の項目があるか読み取り中です）` : ""}`, 4000);
});

// ---------- 一覧 ----------
function filteredRecords() {
  const site = $("#listSite").value;
  const month = $("#listMonth").value;
  return state.records.filter((r) => (!site || r.siteId === site) && (!month || r.date?.startsWith(month)));
}

function renderList() {
  const recs = sortRecords(filteredRecords()).reverse();
  const byMat = new Map();
  for (const r of recs) {
    const k = `${siteName(r.siteId)}｜${r.material}`;
    const v = byMat.get(k) ?? { n: 0, kg: 0 };
    v.n++;
    v.kg += Number(r.netKg) || 0;
    byMat.set(k, v);
  }
  $("#listSummary").replaceChildren(
    recs.length
      ? h("div", {}, h("strong", {}, `${recs.length}件`), ...[...byMat].map(([k, v]) => h("div", {}, `${k}：${v.n}台 ${kg(v.kg)} kg`)))
      : h("div", {}, "該当する伝票はありません"),
  );
  const days = new Map();
  for (const r of recs) {
    const k = r.date || "";
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(r);
  }
  $("#list").replaceChildren(...[...days].map(([date, rs]) =>
    h("div", { class: "day" },
      h("div", { class: "day-head" }, h("span", {}, fmtDate(date)), h("span", {}, `${rs.length}台 ${kg(rs.reduce((s, r) => s + (Number(r.netKg) || 0), 0))} kg`)),
      ...rs.map((r) => h("div", { class: "row", onclick: () => editRecord(r) },
        thumbImg(r.photoId),
        h("div", { class: "main" },
          h("div", {}, r.material ?? ""),
          h("small", {}, [siteName(r.siteId), r.carrier, r.vehicleNo && `車番${r.vehicleNo}`].filter(Boolean).join("／"))),
        h("div", { class: "kg" }, `${kg(r.netKg)} kg`),
      )),
    ),
  ));
}
$("#listSite").addEventListener("change", renderList);
$("#listMonth").addEventListener("change", renderList);

function editRecord(rec) {
  const draft = { ...rec };
  const form = buildForm(draft, (k, v) => (draft[k] = v));
  openDialog(
    h("div", {},
      rec.photoId && thumbImg(rec.photoId, { style: "max-height:40vh;object-fit:contain;cursor:zoom-in", onclick: () => showPhoto(rec.photoId) }),
      form,
      h("p", { class: "hint" }, `登録：${new Date(rec.createdAt).toLocaleString("ja-JP")}　${rec.source === "ai" ? "AI読取" : "手入力"}${rec.edited ? "（手修正あり）" : ""}`)),
    [
      h("button", {
        class: "btn btn-danger", type: "button",
        onclick: async () => {
          if (!confirm("この伝票を削除しますか？（写真も削除されます）")) return;
          await db.del("records", rec.id);
          state.records = state.records.filter((r) => r.id !== rec.id);
          if (rec.photoId && !state.records.some((r) => r.photoId === rec.photoId)) {
            await db.del("photos", rec.photoId);
            dropThumb(rec.photoId);
          }
          closeDialog();
          renderList();
          toast("削除しました");
        },
      }, "削除"),
      h("button", { class: "btn btn-secondary", type: "button", onclick: closeDialog }, "キャンセル"),
      h("button", {
        class: "btn btn-primary", type: "button",
        onclick: async () => {
          const missing = validate(draft);
          if (missing.length) return toast(`${missing.join("・")}を入力してください`);
          const updated = { ...draft, updatedAt: new Date().toISOString(), edited: rec.source === "ai" ? true : rec.edited };
          delete updated.uncertain;
          await db.put("records", updated);
          state.records = state.records.map((r) => (r.id === rec.id ? updated : r));
          closeDialog();
          refreshSiteSelects();
          renderList();
          toast("更新しました");
        },
      }, "更新"),
    ],
  );
}

// ---------- 集計（材料入荷・使用量一覧） ----------
function renderLedger() {
  const siteSel = $("#ledgerSite");
  if (!siteSel.value && state.currentSite) siteSel.value = state.currentSite;
  const siteId = siteSel.value;
  const matSel = $("#ledgerMaterial");
  const mats = siteId ? materialsOf(state.records, siteId) : [];
  const prevMat = matSel.value;
  matSel.replaceChildren(...mats.map((m) => h("option", { value: m }, m)));
  if (mats.includes(prevMat)) matSel.value = prevMat;
  const material = matSel.value;
  const table = $("#ledger");
  if (!siteId || !material) {
    table.replaceChildren(h("tbody", {}, h("tr", {}, h("td", {}, "現場を選ぶと、材料ごとの入荷・使用量が表示されます"))));
    return;
  }
  const site = state.sites.find((s) => s.id === siteId);
  const rows = buildLedger(state.records, state.usages, siteId, material, { endDate: site?.archived ? undefined : todayIso() });
  const two = (main, sub) => [h("div", {}, main), h("small", {}, sub)];
  table.replaceChildren(
    h("thead", {}, h("tr", {}, ...["日付", "台数", "搬入量 kg", "使用量 kg", "残量 kg"].map((t) => h("th", {}, t)))),
    h("tbody", {}, ...rows.map((r) => h("tr", { class: r.count ? "" : "zero" },
      h("td", {}, r.date.slice(5).replace("-", "/")),
      h("td", {}, ...two(r.count, `計${r.cumCount}`)),
      h("td", { title: r.loads.map((x) => kg(x.netKg)).join(" / ") },
        ...two(r.inKg ? kg(r.inKg) : "－", `計${kg(r.cumIn)}`)),
      h("td", {},
        h("input", {
          type: "number", inputmode: "decimal", value: r.useKg ?? "", "aria-label": `${r.date} 使用量`,
          onchange: (e) => saveUsage(siteId, material, r.date, e.target.value),
        }),
        h("small", {}, `計${kg(r.cumUse)}`)),
      h("td", { class: "remain" }, kg(r.remain)),
    ))),
  );
}
$("#ledgerSite").addEventListener("change", renderLedger);
$("#ledgerMaterial").addEventListener("change", renderLedger);

async function saveUsage(siteId, material, date, value) {
  const key = usageKey(siteId, material, date);
  state.usages = state.usages.filter((u) => u.key !== key);
  if (value === "") {
    await db.del("usage", key);
  } else {
    const u = { key, siteId, material, date, kg: Number(value) };
    await db.put("usage", u);
    state.usages.push(u);
  }
  renderLedger();
}

// ---------- 出力 ----------
async function exportScope() {
  const siteId = $("#exportSite").value;
  const sites = siteId ? state.sites.filter((s) => s.id === siteId) : state.sites;
  const ids = new Set(sites.map((s) => s.id));
  const records = state.records.filter((r) => ids.has(r.siteId));
  const usages = state.usages.filter((u) => ids.has(u.siteId));
  return { sites, records, usages, label: siteId ? sites[0]?.name : "" };
}

async function loadPhotos(records) {
  const ids = [...new Set(records.map((r) => r.photoId).filter(Boolean))];
  return (await Promise.all(ids.map((id) => db.get("photos", id)))).filter(Boolean);
}

$$("[data-export]").forEach((btn) => btn.addEventListener("click", async () => {
  const status = $("#exportStatus");
  const buttons = $$("[data-export]");
  buttons.forEach((b) => (b.disabled = true));
  try {
    const scope = await exportScope();
    if (!scope.records.length) return toast("出力する伝票がありません");
    status.textContent = "作成中…";
    const kind = btn.dataset.export;
    if (kind === "excel") {
      const blob = await buildWorkbook(scope);
      deliver(blob, `${fileName("納品書集計", scope.label)}.xlsx`);
    } else if (kind === "pdf") {
      const photos = await loadPhotos(scope.records);
      const blob = await buildPhotoPdf({ ...scope, photos, onProgress: (n) => (status.textContent = `作成中… ${n}/${photos.length}枚`) });
      deliver(blob, `${fileName("納品書台帳", scope.label)}.pdf`);
    } else {
      const photos = await loadPhotos(scope.records);
      const workbook = await buildWorkbook({ ...scope, photos });
      const blob = await buildPhotoZip({ ...scope, photos, workbook });
      deliver(blob, `${fileName("納品書写真", scope.label)}.zip`);
    }
    status.textContent = "";
  } catch (e) {
    console.error(e);
    status.textContent = `作成できませんでした：${e.message}`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}));

// ---------- 設定 ----------
function renderSettings() {
  $("#siteList").replaceChildren(...state.sites.map((s) => {
    const n = state.records.filter((r) => r.siteId === s.id).length;
    return h("li", { class: s.archived ? "archived" : "" },
      h("span", {}, s.name, h("small", { class: "hint" }, `　${n}件`)),
      h("button", {
        class: "btn btn-small btn-secondary", type: "button",
        onclick: async () => {
          const name = prompt("現場名を変更", s.name);
          if (!name || !norm(name)) return;
          s.name = norm(name);
          await db.put("sites", s);
          refreshSiteSelects();
          renderSettings();
        },
      }, "名前"),
      h("button", {
        class: "btn btn-small btn-secondary", type: "button",
        onclick: async () => {
          s.archived = !s.archived;
          await db.put("sites", s);
          if (s.archived && state.currentSite === s.id) {
            state.currentSite = "";
            await db.setMeta("currentSite", "");
          }
          refreshSiteSelects();
          renderSettings();
        },
      }, s.archived ? "再開" : "完了"),
      n === 0 && h("button", {
        class: "btn btn-small btn-danger", type: "button",
        onclick: async () => {
          await db.del("sites", s.id);
          state.sites = state.sites.filter((x) => x !== s);
          refreshSiteSelects();
          renderSettings();
        },
      }, "削除"),
    );
  }));
  $("#passcode").value = state.passcode;
  $("#autoRead").checked = state.autoRead;
  $("#useAi").checked = state.useAi;
  $("#aiSettings").hidden = !state.useAi;
  renderStorageInfo();
}

async function renderStorageInfo() {
  const el = $("#storageInfo");
  const parts = [`伝票 ${state.records.length}件`];
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) parts.push(`使用容量 約${(est.usage / 1024 / 1024).toFixed(1)}MB`);
    const persisted = await navigator.storage?.persisted?.();
    parts.push(persisted ? "保存領域：保護済み" : "保存領域：未保護（ホーム画面に追加すると消えにくくなります）");
  } catch { /* 取得できない端末もある */ }
  const last = await db.getMeta("lastBackup");
  parts.push(last ? `最終バックアップ ${new Date(last).toLocaleString("ja-JP")}` : "バックアップ未実施");
  el.textContent = parts.join("／");
}

async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* 非対応 */ }
}

$("#siteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const site = await addSite($("#siteName").value);
  $("#siteName").value = "";
  if (site && !state.currentSite) {
    state.currentSite = site.id;
    await db.setMeta("currentSite", site.id);
    refreshSiteSelects();
  }
  renderSettings();
});
$("#passcode").addEventListener("change", async (e) => {
  state.passcode = e.target.value.trim();
  await db.setMeta("passcode", state.passcode);
  toast("保存しました");
});
$("#autoRead").addEventListener("change", async (e) => {
  state.autoRead = e.target.checked;
  await db.setMeta("autoRead", state.autoRead);
});
$("#useAi").addEventListener("change", async (e) => {
  state.useAi = e.target.checked;
  $("#aiSettings").hidden = !state.useAi;
  await db.setMeta("useAi", state.useAi);
});

$("#backupBtn").addEventListener("click", async () => {
  try {
    toast("バックアップを作成中…");
    const photos = await db.getAll("photos");
    const blob = await buildBackup({ sites: state.sites, records: state.records, usages: state.usages, photos });
    await db.setMeta("lastBackup", new Date().toISOString());
    deliver(blob, `${fileName("納品書バックアップ")}.zip`);
    renderStorageInfo();
  } catch (e) {
    toast(`作成できませんでした：${e.message}`);
  }
});

$("#restoreInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = await readBackup(file);
    if (!confirm(`伝票${data.records.length}件・写真${data.photos.length}枚を読み込みます。同じデータは上書きされ、それ以外は残ります。よろしいですか？`)) return;
    for (const s of data.sites) await db.put("sites", s);
    for (const r of data.records) await db.put("records", r);
    for (const u of data.usages ?? []) await db.put("usage", u);
    for (const p of data.photos) await db.put("photos", p);
    await loadAll();
    toast("復元しました");
    renderSettings();
  } catch (err) {
    toast(`復元できませんでした：${err.message}`, 4000);
  }
});

// ---------- 起動 ----------
async function loadAll() {
  [state.sites, state.records, state.usages] = await Promise.all([db.getAll("sites"), db.getAll("records"), db.getAll("usage")]);
  state.sites.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  refreshSiteSelects();
}

async function init() {
  state.currentSite = await db.getMeta("currentSite", "");
  state.passcode = await db.getMeta("passcode", "");
  state.autoRead = await db.getMeta("autoRead", true);
  state.useAi = await db.getMeta("useAi", false);
  state.materialAliases = await db.getMeta("materialAliases", {});
  state.siteAliases = await db.getMeta("siteAliases", {});
  state.queue = await db.getMeta("queue", []);
  await loadAll();
  // 読み取り途中でアプリが閉じられたものは再読取
  for (const item of state.queue) if (item.status === "reading") readItem(item);
  renderQueue();
  if (state.sites.length === 0) {
    showAiStatus("最初に「設定」で現場を登録してください（上の「現場」欄からも登録できます）。");
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init().catch((e) => {
  console.error(e);
  toast(`起動に失敗しました：${e.message}`, 6000);
});
