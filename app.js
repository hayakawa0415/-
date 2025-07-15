// app.js: 納品書管理ツールのメインJS
// Firebase初期化
const firebaseConfig = {
  // ここに自分のFirebase設定を入力
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// 匿名認証
auth.signInAnonymously().catch(console.error);

// 納品書登録
async function handleNoteSubmit(e) {
  e.preventDefault();
  const date = document.getElementById('date').value;
  const productType = document.getElementById('productType').value;
  const projectName = document.getElementById('projectName').value;
  const netQuantity = Number(document.getElementById('netQuantity').value);
  const imageInput = document.getElementById('imageInput');
  let imageData = '';
  if (imageInput.files[0]) {
    const reader = new FileReader();
    reader.onload = async function(evt) {
      imageData = evt.target.result;
      await saveNote({date, productType, projectName, netQuantity, imageData});
    };
    reader.readAsDataURL(imageInput.files[0]);
  } else {
    await saveNote({date, productType, projectName, netQuantity, imageData});
  }
}

document.getElementById('noteForm').addEventListener('submit', handleNoteSubmit);

async function saveNote(note) {
  const user = auth.currentUser;
  if (!user) return alert('認証エラー');
  const ref = db.collection(`artifacts/__app_id/users/${user.uid}/deliveryNotes`);
  await ref.add({
    ...note,
    timestamp: new Date().toISOString()
  });
  alert('登録完了');
  loadNotes();
}

// 納品書一覧取得
async function loadNotes() {
  const user = auth.currentUser;
  if (!user) return;
  const ref = db.collection(`artifacts/__app_id/users/${user.uid}/deliveryNotes`).orderBy('date', 'desc');
  const snap = await ref.get();
  const notes = snap.docs.map(doc => doc.data());
latestNotes = notes;
  const list = document.getElementById('notesList');
  list.innerHTML = notes.map(n =>
    `<div class="border-b py-2">
      <div>日付: ${n.date}</div>
      <div>品種: ${n.productType}</div>
      <div>工事名: ${n.projectName}</div>
      <div>重量: ${n.netQuantity}kg</div>
      ${n.imageData ? `<img src="${n.imageData}" class="h-16 mt-1">` : ''}
    </div>`
  ).join('');
}
auth.onAuthStateChanged(loadNotes);

// カメラで撮影ボタン
const cameraBtn = document.getElementById('cameraBtn');
if (cameraBtn) {
  cameraBtn.addEventListener('click', () => {
    const imageInput = document.getElementById('imageInput');
    if (imageInput) {
      imageInput.value = '';
      imageInput.click();
    }
  });
}

// CSV出力ボタン
const csvExportBtn = document.getElementById('csvExportBtn');
let latestNotes = [];
if (csvExportBtn) {
  csvExportBtn.addEventListener('click', () => {
    if (!latestNotes.length) {
      alert('出力できるデータがありません');
      return;
    }
    const header = ['日付','品種','工事名','正味重量(kg)'];
    const rows = latestNotes.map(n => [n.date, n.productType, n.projectName, n.netQuantity]);
    const csv = [header, ...rows].map(row => row.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
    const blob = new Blob([csv], {type: 'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'delivery_notes.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

// 画像データ出力ボタン
const outputImageBtn = document.getElementById('outputImageBtn');
if (outputImageBtn) {
  outputImageBtn.addEventListener('click', () => {
    const imageInput = document.getElementById('imageInput');
    if (!imageInput.files[0]) {
      alert('画像が選択されていません');
      return;
    }
    const reader = new FileReader();
    reader.onload = function(evt) {
      const base64 = evt.target.result;
      // 長いのでモーダル表示やconsole出力も可
      prompt('画像データ(Base64)', base64);
    };
    reader.readAsDataURL(imageInput.files[0]);
  });
}

// 画像OCR（ダミー実装）
document.getElementById('ocrBtn').addEventListener('click', () => {
  const imageInput = document.getElementById('imageInput');
  if (!imageInput.files[0]) return alert('画像を選択してください');
  // ここにGemini Vision OCR呼び出しを実装
  document.getElementById('ocrResult').textContent = 'OCR結果: (ここに抽出テキスト)';
});
