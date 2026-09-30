// オフラインでも画面を開けるようにする（通信できる時は常に最新を取得）
const CACHE = "nouhinsho-v2";
// 大きく変わらないファイル（文字認識データ・ライブラリ）はキャッシュ優先
const CACHE_FIRST = ["/models/", "/vendor/"];
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "manifest.webmanifest",
  "js/db.js", "js/image.js", "js/ledger.js", "js/export.js", "js/ocr.js", "js/ocr-worker.js", "js/net-extract.js",
  "vendor/exceljs.min.js", "vendor/jspdf.umd.min.js", "vendor/jszip.min.js",
  "icons/icon.svg", "icons/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (CACHE_FIRST.some((p) => url.pathname.includes(p))) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })),
    );
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
