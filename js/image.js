// 画像の縮小・回転・変換
const PHOTO_MAX = 2000; // 保存・AI読み取り用の長辺(px)
const THUMB_MAX = 320;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像を読み込めませんでした"));
    img.src = src;
  });
}

async function withImage(blob, fn) {
  const url = URL.createObjectURL(blob);
  try {
    return await fn(await loadImage(url));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を変換できませんでした"))), "image/jpeg", quality),
  );
}

// 縮小しつつ、rotation(時計回り 0/90/180/270)を適用して JPEG にする
// ブラウザは <img> の描画時に EXIF の向きを反映するため、ここで向きが確定する
export function renderJpeg(blob, { max = PHOTO_MAX, rotation = 0, quality = 0.85 } = {}) {
  return withImage(blob, (img) => {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const swap = rotation === 90 || rotation === 270;
    const canvas = document.createElement("canvas");
    canvas.width = swap ? h : w;
    canvas.height = swap ? w : h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return canvasToBlob(canvas, quality);
  });
}

export async function preparePhoto(file) {
  const photo = await renderJpeg(file);
  const thumb = await renderJpeg(photo, { max: THUMB_MAX, quality: 0.7 });
  return { photo, thumb };
}

export async function rotatePhoto(photoBlob, rotation) {
  const photo = await renderJpeg(photoBlob, { rotation, quality: 0.9 });
  const thumb = await renderJpeg(photo, { max: THUMB_MAX, quality: 0.7 });
  return { photo, thumb };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function imageSize(blob) {
  return withImage(blob, (img) => ({ width: img.naturalWidth, height: img.naturalHeight }));
}

// 写真の一部（伝票の正味欄など）を切り出して dataURL にする
export function cropDataUrl(blob, box, { padX = 0.6, padY = 0.5, maxW = 640 } = {}) {
  return withImage(blob, (img) => {
    const bh = box.y1 - box.y0;
    const x0 = Math.max(0, box.x0 - bh * padX);
    const y0 = Math.max(0, box.y0 - bh * padY);
    const x1 = Math.min(img.naturalWidth, box.x1 + bh * padX);
    const y1 = Math.min(img.naturalHeight, box.y1 + bh * padY);
    const s = Math.min(1.5, maxW / (x1 - x0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((x1 - x0) * s);
    canvas.height = Math.round((y1 - y0) * s);
    canvas.getContext("2d").drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  });
}

export { loadImage };
