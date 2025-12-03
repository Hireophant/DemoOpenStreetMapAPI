// ======================================================
// 1. LOGIC BẢN ĐỒ + TÌM POI (Leaflet + Nominatim + Overpass)
// ======================================================

// --- Khởi tạo map Leaflet ---
const map = L.map('map', { zoomControl: false });
L.control.zoom({ position: 'bottomright' }).addTo(map);

// Tâm mặc định là Việt Nam
const vnCenter = [14.0583, 108.2772];
map.setView(vnCenter, 5);

// Layer nền OSM
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

// Nhóm layer chứa các marker POI
let poiLayer = L.layerGroup().addTo(map);

// --- Tham chiếu các phần tử DOM chính ---
const form = document.getElementById('searchForm');
const input = document.getElementById('placeInput');
const panel = document.getElementById('panel');
const results = document.getElementById('results');
const areaNameEl = document.getElementById('areaName');
const closePanelBtn = document.getElementById('closePanel');

// Nút đóng panel kết quả
closePanelBtn.addEventListener('click', () => panel.classList.add('hidden'));

// Helper: thêm một marker vào map
function addMarker(lat, lon, name, desc) {
  const m = L.marker([lat, lon]);
  m.bindPopup(`<b>${name || 'Không rõ tên'}</b><br/>${desc || ''}`);
  m.addTo(poiLayer);
  return m;
}

// Template một dòng item POI trong danh sách
function listItemTemplate(i, name, tags = {}, dist = null) {
  const sub = [
    tags.tourism || tags.amenity || tags.historic || tags.leisure || '',
    tags['addr:street'] || '',
  ]
    .filter(Boolean)
    .join(' · ');
  const d = dist ? ` (~${Math.round(dist)}m)` : '';
  return `<li class="py-2 px-2 flex gap-3 hover:bg-slate-50 rounded-xl">
    <div class="h-8 w-8 rounded-lg bg-slate-100 flex items-center justify-center text-sm">${i}</div>
    <div class="flex-1">
      <div class="font-medium">${name || 'Không rõ tên'}${d}</div>
      <div class="text-xs text-slate-500">${sub}</div>
    </div>
  </li>`;
}

// --- Geocode bằng Nominatim: tìm toạ độ theo địa danh (giới hạn VN) ---
async function geocodeVN(q) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('q', q);
  url.searchParams.set('countrycodes', 'vn');
  url.searchParams.set('limit', '1');

  const res = await fetch(url, { headers: { 'Accept-Language': 'vi' } });
  if (!res.ok) throw new Error('Không truy vấn được Nominatim');

  const data = await res.json();
  if (!data.length) throw new Error('Không tìm thấy địa điểm phù hợp tại Việt Nam');

  const p = data[0];
  return {
    name: p.display_name,
    lat: parseFloat(p.lat),
    lon: parseFloat(p.lon),
  };
}

// --- Gọi Overpass để lấy 5 POI quanh toạ độ ---
async function fetchPOIs(lat, lon) {
  const radius = 6000; // bán kính tìm POI (m)
  const query = `[
    out:json][timeout:25];
    (
      node(around:${radius},${lat},${lon})[tourism];
      node(around:${radius},${lat},${lon})[amenity];
      node(around:${radius},${lat},${lon})[historic];
      way(around:${radius},${lat},${lon})[tourism];
      way(around:${radius},${lat},${lon})[amenity];
      way(around:${radius},${lat},${lon})[historic];
      relation(around:${radius},${lat},${lon})[tourism];
      relation(around:${radius},${lat},${lon})[amenity];
      relation(around:${radius},${lat},${lon})[historic];
    );
    out center 20;`;

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!res.ok) throw new Error('Overpass API lỗi hoặc giới hạn lưu lượng.');

  const data = await res.json();

  // Chuyển các element về dạng điểm có lat/lon + tags
  const pts = (data.elements || [])
    .map((el) => {
      const c = el.center || el; // node có lat/lon; way/relation dùng center
      return {
        id: el.id,
        lat: c.lat,
        lon: c.lon,
        tags: el.tags || {},
        name: (el.tags && (el.tags['name:vi'] || el.tags.name)) || 'POI',
      };
    })
    .filter((p) => p.lat && p.lon);

  // Hàm chấm điểm POI (ưu tiên tourism > amenity > historic > có tên)
  const score = (p) =>
    (p.tags.tourism ? 100 : 0) +
    (p.tags.amenity ? 60 : 0) +
    (p.tags.historic ? 40 : 0) +
    (p.name ? 20 : 0);

  // Khoảng cách đơn giản (cho tie-break nếu score bằng nhau)
  const dist = (p) => Math.hypot(p.lat - lat, p.lon - lon);

  // Sắp xếp theo score rồi theo gần xa
  pts.sort((a, b) => (score(b) - score(a)) || (dist(a) - dist(b)));

  // Chỉ lấy 5 điểm nổi bật nhất
  return pts.slice(0, 5);
}

// --- Hàm khoảng cách Haversine (dùng để hiển thị khoảng cách m) ---
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000; // bán kính Trái Đất (m)
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// --- Main flow: xử lý submit form tìm kiếm địa điểm chính ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;

  // Reset layer & kết quả cũ
  poiLayer.clearLayers();
  results.innerHTML = '';
  panel.classList.add('hidden');
  document.getElementById('searchBtn').disabled = true;

  try {
    // 1) Geocode địa điểm do user nhập
    const place = await geocodeVN(q);
    areaNameEl.textContent = place.name;
    map.flyTo([place.lat, place.lon], 13, { duration: 0.8 });

    // 2) Lấy danh sách POI xung quanh
    const pois = await fetchPOIs(place.lat, place.lon);
    if (!pois.length) throw new Error('Chưa có POI phù hợp trong bán kính gần.');

    // 3) Vẽ marker trên map
    const markers = [];
    pois.forEach((p) => {
      const m = addMarker(
        p.lat,
        p.lon,
        p.name,
        Object.values(p.tags).slice(0, 3).join(' · ')
      );
      markers.push(m);
    });

    // 4) Fit map cho vừa tất cả marker
    const g = L.featureGroup(markers);
    map.fitBounds(g.getBounds().pad(0.2));

    // 5) Render danh sách 5 POI
    results.innerHTML = pois
      .map((p, idx) => {
        const d = haversine(place.lat, place.lon, p.lat, p.lon);
        return listItemTemplate(idx + 1, p.name, p.tags, d);
      })
      .join('');

    panel.classList.remove('hidden');

    // 6) BƯỚC CUỐI: gọi OpenWeather để cập nhật card thời tiết
    try {
      const weather = await getCurrentCityWeather(q); // dùng lại hàm phía dưới

      const errorEl = document.getElementById('weatherError');
      const resultBox = document.getElementById('weatherResult');
      const iconImg = document.getElementById('weatherIcon');

      errorEl.textContent = '';
      resultBox.style.display = 'none';
      iconImg.style.display = 'none';

      document.getElementById('weatherCityName').textContent =
        weather.cityDisplayName;
      document.getElementById('weatherTemp').textContent =
        weather.temp.toFixed(1);
      document.getElementById('weatherHumidity').textContent =
        weather.humidity;
      document.getElementById('weatherWind').textContent =
        weather.windSpeed;
      document.getElementById('weatherDescription').textContent =
        weather.description;

      if (weather.icon) {
        iconImg.src = `https://openweathermap.org/img/wn/${weather.icon}@2x.png`;
        iconImg.alt = weather.description;
        iconImg.style.display = 'block';
      }

      resultBox.style.display = 'block';
    } catch (wErr) {
      console.error('Lỗi OpenWeather:', wErr);
      document.getElementById('weatherError').textContent =
        wErr.message || 'Không lấy được dữ liệu thời tiết.';
    }

    // 7) Lưu lịch sử tìm kiếm ở localStorage (client-side)
    const recent = JSON.parse(
      localStorage.getItem('vn-poi-recent') || '[]'
    );
    recent.unshift({ q, ts: Date.now() });
    localStorage.setItem('vn-poi-recent', JSON.stringify(recent.slice(0, 8)));
    // 8) Ghi log vào Firestore nếu user đã đăng nhập
    try {
      await logQuery(q);
    } catch (logErr) {
      console.warn('Không ghi được log Firestore:', logErr);
    }
  } catch (err) {
    alert(err.message || 'Đã có lỗi xảy ra.');
    console.error(err);
  } finally {
    document.getElementById('searchBtn').disabled = false;
  }
});

// Lần load đầu tiên: đặt 1 marker ở tâm VN
addMarker(
  vnCenter[0],
  vnCenter[1],
  'Việt Nam',
  'Bắt đầu bằng cách nhập địa điểm.'
);

// ===============================================x
// 2. FIREBASE – auth (email/password + Google) + log query search
// ===============================================

const firebaseConfig = {
  apiKey: "AIzaSyAVuKHMYVzb1FB3uzlP-3l9e3C63nkmECE",
  authDomain: "fir-openstreetmap.firebaseapp.com",
  projectId: "fir-openstreetmap",
  storageBucket: "fir-openstreetmap.firebasestorage.app",
  messagingSenderId: "956523695763",
  appId: "1:956523695763:web:c5bcdcf2daabbd479c8766",
  measurementId: "G-3KZHPMWE65"
};

// Khởi tạo Firebase (dùng try/catch để tránh lỗi nếu init nhiều lần)
try {
  firebase.initializeApp(firebaseConfig);
} catch (e) {}

const auth = firebase.auth();
const db = firebase.firestore();

// ==== DOM cho phần auth (nút trên header + modal) ====
const authModal = document.getElementById('authModal');
const openAuthModalBtn = document.getElementById('openAuthModalBtn');
const closeAuthModalBtn = document.getElementById('closeAuthModalBtn');
const signOutBtn = document.getElementById('signOutBtn');
const authUserInfo = document.getElementById('authUserInfo');
const authUserEmailEl = document.getElementById('authUserEmail');
const authEmailInput = document.getElementById('authEmail');
const authPasswordInput = document.getElementById('authPassword');
const authErrorEl = document.getElementById('authError');
const googleSignInBtn = document.getElementById('googleSignInBtn');
const signUpBtn = document.getElementById('signUpBtn');
const signInBtn = document.getElementById('signInBtn');

// Mở / đóng modal
openAuthModalBtn.addEventListener('click', () => {
  authErrorEl.textContent = '';
  authModal.classList.remove('hidden');
});

closeAuthModalBtn.addEventListener('click', () => {
  authModal.classList.add('hidden');
});

// Click ra ngoài phần hộp trắng để đóng
authModal.addEventListener('click', (e) => {
  if (e.target === authModal) authModal.classList.add('hidden');
});

// ========= CÁC HÀM AUTH =========

// Đăng ký tài khoản email/password
async function signUpWithEmailPassword(email, password) {
  return auth.createUserWithEmailAndPassword(email, password);
}

// Đăng nhập email/password
async function signInWithEmailPassword(email, password) {
  return auth.signInWithEmailAndPassword(email, password);
}

// Đăng nhập bằng Google (popup)
async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  return auth.signInWithPopup(provider);
}

// Đăng xuất
async function signOutFirebase() {
  return auth.signOut();
}

// Bắt sự kiện nút Đăng ký
signUpBtn.addEventListener('click', async () => {
  const email = authEmailInput.value.trim();
  const password = authPasswordInput.value.trim();
  authErrorEl.textContent = '';

  if (!email || !password) {
    authErrorEl.textContent = 'Vui lòng nhập đầy đủ email và mật khẩu.';
    return;
  }
  if (password.length < 6) {
    authErrorEl.textContent = 'Mật khẩu phải từ 6 ký tự trở lên.';
    return;
  }

  try {
    await signUpWithEmailPassword(email, password);
    // Sau khi đăng ký thành công, Firebase sẽ tự đăng nhập và onAuthStateChanged sẽ chạy
  } catch (err) {
    console.error(err);
    authErrorEl.textContent = err.message;
  }
});

// Bắt sự kiện nút Đăng nhập
signInBtn.addEventListener('click', async () => {
  const email = authEmailInput.value.trim();
  const password = authPasswordInput.value.trim();
  authErrorEl.textContent = '';

  if (!email || !password) {
    authErrorEl.textContent = 'Vui lòng nhập đầy đủ email và mật khẩu.';
    return;
  }

  try {
    await signInWithEmailPassword(email, password);
  } catch (err) {
    console.error(err);
    authErrorEl.textContent = err.message;
  }
});

// Nút đăng nhập bằng Google
googleSignInBtn.addEventListener('click', async () => {
  authErrorEl.textContent = '';
  try {
    await signInWithGoogle();
  } catch (err) {
    console.error(err);
    authErrorEl.textContent = err.message;
  }
});

// Nút Đăng xuất
signOutBtn.addEventListener('click', async () => {
  try {
    await signOutFirebase();
  } catch (err) {
    console.error(err);
  }
});

// Lắng nghe trạng thái đăng nhập và cập nhật UI
auth.onAuthStateChanged((u) => {
  console.log('auth user:', u?.email || 'signed out');

  if (u) {
    authUserEmailEl.textContent = u.email || u.displayName || 'Người dùng';
    authUserInfo.classList.remove('hidden');
    signOutBtn.classList.remove('hidden');
    openAuthModalBtn.classList.add('hidden');
    authModal.classList.add('hidden');    // ẩn modal nếu đang mở
    authErrorEl.textContent = '';
  } else {
    authUserInfo.classList.add('hidden');
    signOutBtn.classList.add('hidden');
    openAuthModalBtn.classList.remove('hidden');
  }
});

// Ghi log query vào Firestore (nếu đã đăng nhập)
async function logQuery(q) {
  const u = auth.currentUser;
  if (!u) return;
  await db.collection('queries').add({
    q,
    user: u.uid,
    email: u.email,
    ts: firebase.firestore.FieldValue.serverTimestamp(),
  });
}


// ==================================================
// 3. OPENWEATHER API – lấy & hiển thị dữ liệu thời tiết
// ==================================================

// TODO: Đây là API key của bạn – không nên public trên repo công khai
const OPENWEATHER_API_KEY = 'bb3f9adab388e35627f2ee0a623096b8';

// Hàm gọi API geocoding của OpenWeather để lấy lat, lon theo tên city
async function getCurrentCityLatLon(cityName) {
  const url = 'https://api.openweathermap.org/geo/1.0/direct';

  const params = new URLSearchParams({
    q: cityName,
    limit: 1,
    appid: OPENWEATHER_API_KEY,
  });

  const response = await fetch(`${url}?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Lỗi khi gọi API geocoding');
  }

  const data = await response.json();

  if (!data || data.length === 0) {
    throw new Error('Không tìm thấy địa điểm phù hợp');
  }

  // Lấy kết quả đầu tiên
  const city = data[0];
  return {
    lat: city.lat,
    lon: city.lon,
    displayName: `${city.name}, ${city.country}`,
  };
}

// Hàm gọi API /data/2.5/weather dùng lat, lon lấy thời tiết hiện tại
async function getCurrentCityWeather(cityName) {
  // Lấy lat, lon trước
  const { lat, lon, displayName } = await getCurrentCityLatLon(cityName);

  const url = 'https://api.openweathermap.org/data/2.5/weather';

  const params = new URLSearchParams({
    lat: lat,
    lon: lon,
    appid: OPENWEATHER_API_KEY,
    units: 'metric', // giống notebook (đơn vị °C)
    lang: 'vi',      // mô tả thời tiết tiếng Việt
  });

  const response = await fetch(`${url}?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Lỗi khi gọi API thời tiết');
  }

  const data = await response.json();

  return {
    raw: data,
    cityDisplayName: displayName,
    temp: data.main.temp,
    humidity: data.main.humidity,
    windSpeed: data.wind.speed,
    description: data.weather[0].description,
    icon: data.weather[0].icon,
  };
}

// Event: bấm nút "Xem thời tiết" trong box riêng
document
  .getElementById('searchWeatherBtn')
  .addEventListener('click', async () => {
    const cityInput = document.getElementById('cityInput');
    const errorEl = document.getElementById('weatherError');
    const resultBox = document.getElementById('weatherResult');
    const iconImg = document.getElementById('weatherIcon');

    const cityName = cityInput.value.trim();

    errorEl.textContent = '';
    resultBox.style.display = 'none';
    iconImg.style.display = 'none';

    if (!cityName) {
      errorEl.textContent = 'Vui lòng nhập địa điểm.';
      return;
    }

    try {
      errorEl.textContent = 'Đang tải dữ liệu thời tiết...';
      const weather = await getCurrentCityWeather(cityName);
      errorEl.textContent = '';

      // Cập nhật UI trong card thời tiết
      document.getElementById('weatherCityName').textContent =
        weather.cityDisplayName;
      document.getElementById('weatherTemp').textContent =
        weather.temp.toFixed(1);
      document.getElementById('weatherHumidity').textContent =
        weather.humidity;
      document.getElementById('weatherWind').textContent =
        weather.windSpeed;
      document.getElementById('weatherDescription').textContent =
        weather.description;

      if (weather.icon) {
        iconImg.src = `https://openweathermap.org/img/wn/${weather.icon}@2x.png`;
        iconImg.alt = weather.description;
        iconImg.style.display = 'block';
      }

      resultBox.style.display = 'block';
    } catch (err) {
      console.error(err);
      errorEl.textContent =
        err.message || 'Có lỗi xảy ra khi lấy dữ liệu thời tiết.';
    }
  });
  // ======================================================
// 4. TÍNH NĂNG DỊCH THUẬT (EN -> VI)
// ======================================================

// Các phần tử DOM liên quan
const translateBox = document.getElementById('translateBox');
const toggleTranslateBtn = document.getElementById('toggleTranslateBox');
const translateBtn = document.getElementById('translateBtn');
const enInput = document.getElementById('enInput');
const viOutput = document.getElementById('viOutput');
const translateError = document.getElementById('translateError');
const translateResult = document.getElementById('translateResult');

// Nút mở/đóng popup
toggleTranslateBtn.addEventListener('click', () => {
  translateBox.classList.toggle('hidden');
});

// Hàm gọi API Google Translate miễn phí
async function translateToVietnamese(text) {
  const baseUrl = 'https://translate.googleapis.com/translate_a/single';
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'en',
    tl: 'vi',
    dt: 't',
    q: text
  });

  const res = await fetch(`${baseUrl}?${params.toString()}`);
  if (!res.ok) throw new Error('Lỗi khi gọi API dịch thuật.');
  
  const data = await res.json();
  return data[0].map(seg => seg[0]).join('');
}

// Nút "Dịch sang tiếng Việt"
translateBtn.addEventListener('click', async () => {
  const text = enInput.value.trim();
  translateError.textContent = '';
  translateResult.style.display = 'none';

  if (!text) {
    translateError.textContent = 'Vui lòng nhập câu tiếng Anh.';
    return;
  }

  try {
    translateError.textContent = 'Đang dịch...';
    const translated = await translateToVietnamese(text);
    viOutput.textContent = translated;
    translateError.textContent = '';
    translateResult.style.display = 'block';
  } catch (err) {
    console.error(err);
    translateError.textContent = 'Không thể dịch. Vui lòng thử lại.';
  }
});

