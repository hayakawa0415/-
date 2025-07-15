// app.js: 納品書管理ツールのメインJS
// Firebase初期化
const firebaseConfig = {
  // ここに自分のFirebase設定を入力
};

const openCameraBtn = document.getElementById('openCamera');
const takePhotoBtn = document.getElementById('takePhoto');
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const capturedImage = document.getElementById('capturedImage');
const capturedImageSection = document.getElementById('capturedImageSection');
const fileUploadInput = document.getElementById('fileUpload');
const deliveryDateInput = document.getElementById('deliveryDate');
const productTypeInput = document.getElementById('productType');
const projectNameInput = document.getElementById('projectName');
const netQuantityInput = document.getElementById('netQuantity');
const saveDeliveryNoteBtn = document.getElementById('saveDeliveryNote');
const saveMessage = document.getElementById('saveMessage');
const exportCsvButton = document.getElementById('exportCsvButton');
const deliveryNoteList = document.getElementById('deliveryNoteList');
const loadingDeliveryNotes = document.getElementById('loadingDeliveryNotes');
const noDeliveryNotesMessage = document.getElementById('noDeliveryNotesMessage');

let deliveryNotes = [];

openCameraBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    video.style.display = 'block';
    takePhotoBtn.style.display = 'block';
    openCameraBtn.disabled = true;
    fileUploadInput.disabled = true;
  } catch (err) {
    alert('カメラへのアクセスが拒否されました');
  }
});

takePhotoBtn.addEventListener('click', () => {
  const context = canvas.getContext('2d');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = canvas.toDataURL('image/png');
  capturedImage.src = imageData;
  capturedImageSection.style.display = 'block';
  // --- カメラ＆画像管理＋OCR（Tesseract.js） ---
  const stream = video.srcObject;
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    video.srcObject = null;
    video.style.display = 'none';
  }
  takePhotoBtn.style.display = 'none';
  openCameraBtn.disabled = false;
  fileUploadInput.disabled = false;
  saveDeliveryNoteBtn.disabled = false;
});

fileUploadInput.addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    capturedImage.src = e.target.result;
    capturedImageSection.style.display = 'block';
    saveDeliveryNoteBtn.disabled = false;
  };
  reader.readAsDataURL(file);
});

saveDeliveryNoteBtn.addEventListener('click', () => {
  const deliveryDate = deliveryDateInput.value.trim();
  const productType = productTypeInput.value.trim();
  const projectName = projectNameInput.value.trim();
  const netQuantity = netQuantityInput.value.trim();
  const imageData = capturedImage.src;
  if (!deliveryDate || !productType || !projectName || !netQuantity || !imageData) {
    showMessage('全ての項目と画像を入力してください', 'error');
    return;
  }
  deliveryNotes.push({ deliveryDate, productType, projectName, netQuantity, imageData, timestamp: new Date().toISOString() });
  showMessage('納品書を保存しました', 'success');
  renderDeliveryNotes();
  clearInputFields();
  capturedImage.src = '';
  capturedImageSection.style.display = 'none';
  saveDeliveryNoteBtn.disabled = true;
});

function clearInputFields() {
  deliveryDateInput.value = '';
  productTypeInput.value = '';
  projectNameInput.value = '';
  netQuantityInput.value = '';
}

function showMessage(message, type) {
  saveMessage.textContent = message;
  saveMessage.className = 'p-4 mt-4 rounded-lg text-sm ' + (type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800');
  saveMessage.style.display = 'block';
  setTimeout(() => { saveMessage.style.display = 'none'; }, 2000);
}

function renderDeliveryNotes() {
  deliveryNoteList.innerHTML = '';
  if (deliveryNotes.length === 0) {
    noDeliveryNotesMessage.style.display = 'block';
    exportCsvButton.disabled = true;
    return;
  }
  noDeliveryNotesMessage.style.display = 'none';
  exportCsvButton.disabled = false;
  deliveryNotes.slice().reverse().forEach(note => {
    const li = document.createElement('li');
    li.className = 'flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 bg-gray-50 rounded-lg shadow-sm mb-3';
    li.innerHTML = `
      <div class="flex-1 delivery-note-info">
        <p class="text-lg font-medium text-gray-800">日付: ${note.deliveryDate}</p>
        <p class="text-gray-600">品種: ${note.productType}</p>
        <p class="text-gray-600">工事名（荷受人）: ${note.projectName}</p>
        <p class="text-gray-600">正味（数量）: ${note.netQuantity}kg</p>
        <p class="text-gray-500 text-xs">${new Date(note.timestamp).toLocaleString('ja-JP')}</p>
      </div>
      <div class="flex items-center space-x-2 mt-3 sm:mt-0">
        <button class="view-button bg-gray-500 text-white px-4 py-2 rounded-full font-semibold text-sm">表示</button>
        <button class="delete-button bg-red-500 text-white px-4 py-2 rounded-full font-semibold text-sm">削除</button>
      </div>
    `;
    li.querySelector('.view-button').addEventListener('click', () => {
      showImageModal(note.imageData);
    });
    li.querySelector('.delete-button').addEventListener('click', () => {
      if (confirm('この納品書を削除しますか？')) {
        deliveryNotes = deliveryNotes.filter(n => n !== note);
        renderDeliveryNotes();
      }
    });
    deliveryNoteList.appendChild(li);
  });
}

function showImageModal(imageData) {
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center p-4 z-50';
  modal.innerHTML = `
    <div class="bg-white p-6 rounded-lg shadow-xl max-w-lg w-full relative">
      <button class="absolute top-3 right-3 text-gray-600 hover:text-gray-900 text-2xl font-bold" id="closeImageModal">&times;</button>
      <h3 class="text-xl font-semibold mb-4 text-gray-800">納品書画像</h3>
      <img src="${imageData}" alt="Delivery Note Image" class="max-w-full h-auto rounded-lg mb-4">
      <p class="text-sm text-gray-600">この画像は納品書のコピーです。</p>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('closeImageModal').addEventListener('click', () => {
    document.body.removeChild(modal);
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      document.body.removeChild(modal);
    }
  });
}

exportCsvButton.addEventListener('click', () => {
  if (deliveryNotes.length === 0) return;
  let csvContent = '\uFEFF工事名,日付,品種,正味（数量）(kg)\n';
  deliveryNotes.forEach(note => {
    const escapeCsv = (value) => {
      if (value === null || value === undefined) return '';
      let stringValue = String(value);
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    };
    csvContent += `${escapeCsv(note.projectName)},${escapeCsv(note.deliveryDate)},${escapeCsv(note.productType)},${escapeCsv(note.netQuantity)}\n`;
  });
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  const timestamp = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  a.download = `納品書データ_${timestamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// OCRボタン生成・イベント追加
const ocrProgress = document.createElement('div');
ocrProgress.id = 'ocrProgress';
ocrProgress.className = 'text-center text-blue-600 mb-2';
document.getElementById('capturedImageSection').insertBefore(ocrProgress, capturedImage.nextSibling);

const ocrBtn = document.createElement('button');
ocrBtn.id = 'ocrBtn';
ocrBtn.textContent = '画像から文字データ抽出（OCR）';
ocrBtn.className = 'bg-blue-500 text-white px-6 py-3 rounded-full font-semibold shadow-lg w-full mb-2';
document.getElementById('capturedImageSection').insertBefore(ocrBtn, downloadImageBtn);

ocrBtn.addEventListener('click', async () => {
  if (!capturedImage.src) {
    showMessage('画像がありません', 'error');
    return;
  }
  ocrProgress.textContent = 'OCR処理中...';
  try {
    const result = await Tesseract.recognize(capturedImage.src, 'jpn', {
      logger: m => {
        if (m.status === 'recognizing text') {
          ocrProgress.textContent = `OCR進行中: ${Math.round(m.progress * 100)}%`;
        }
      }
    });
    ocrProgress.textContent = 'OCR完了';
    // 結果を入力欄に反映（簡易パターンマッチ）
    const text = result.data.text;
    // 日付（YYYY/MM/DD）
    const dateMatch = text.match(/\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/);
    if(dateMatch) deliveryDateInput.value = dateMatch[0].replace(/\-/g, '/');
    // 品種（例: 生コンクリートなど）
    const productMatch = text.match(/品種[:：]?\s*(\S+)/);
    if(productMatch) productTypeInput.value = productMatch[1];
    // 工事名（「工事名」または「荷受人」）
    const projectMatch = text.match(/(?:工事名|荷受人)[:：]?\s*(\S+)/);
    if(projectMatch) projectNameInput.value = projectMatch[1];
    // 正味（数量）kg
    const netMatch = text.match(/正味[:：]?\s*([\d,\.]+)/);
    if(netMatch) netQuantityInput.value = netMatch[1].replace(/,/g, '');
    showMessage('OCR結果を入力欄に反映しました', 'success');
  } catch (e) {
    ocrProgress.textContent = '';
    showMessage('OCR処理に失敗しました', 'error');
  }
});

// 画像として保存ボタン
const downloadImageBtn = document.getElementById('downloadImageBtn');
downloadImageBtn.addEventListener('click', () => {
  if (!capturedImage.src) {
    showMessage('保存できる画像がありません', 'error');
    return;
  }
  // デフォルトはPNGとして保存
  const a = document.createElement('a');
  a.href = capturedImage.src;
  a.download = '納品書画像_' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

// 初期化
renderDeliveryNotes();

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
