# 🎬 Reelit: Reddit Reels (TikTok-Style Vertical Feed)

A personal TikTok/Instagram Reels style vertical video player for Reddit, powered by a lightweight Chromium extension bridge that securely proxies requests using your logged-in Reddit session cookies and automatically resolves high-definition Reddit & Redgifs videos.

Hosted on GitHub Pages: **[https://yaser-rh.github.io/reelit/](https://yaser-rh.github.io/reelit/)**

---

## 📱 Mobile Setup Guide (Titanium Browser / Android)

### English Guide

#### Step 1: Install Titanium & Add Extension
1. Download and install **Titanium Browser** on your Android phone.
2. Download the extension package:  
   👉 **[reelit-extension.zip](https://github.com/Yaser-rh/reelit/raw/main/reelit-extension.zip)**
3. **Extract / Unpack** the `.zip` file using your phone's file manager into a regular folder *(important: the folder must be unpacked)*.
4. Open Titanium Browser, tap the menu **(⋮)** ➔ **Extensions** (or navigate to `chrome://extensions`).
5. Toggle ON **Developer mode** (top-right corner).
6. Tap **Load unpacked** (or `+ (from .zip/.crx/.user.js)`) and select the unpacked folder.
7. Verify that **Reddit Reels Bridge** is loaded and enabled.

#### Step 2: Log In & Install App to Home Screen (PWA)
1. In Titanium Browser, open [reddit.com](https://www.reddit.com) (or `old.reddit.com`) and **log into your Reddit account**.
2. Open a new tab and navigate to:  
   👉 **`https://yaser-rh.github.io/reelit/`**
3. Tap the menu **(⋮)** ➔ **Share and save** ➔ **Install and create shortcut** ➔ **Install**.
4. Launch **Reelit** directly from your phone's home screen as a full-screen standalone app!

---

### دليل التشغيل والتثبيت بالعربية (متصفح Titanium للأندرويد)

#### الخطوة 1: تثبيت المتصفح وتفعيل الإضافة (Extension)
1. قم بتحميل وتثبيت متصفح **Titanium Browser** على هاتفك الأندرويد.
2. حمّل ملف الإضافة:  
   👉 **[reelit-extension.zip](https://github.com/Yaser-rh/reelit/raw/main/reelit-extension.zip)**
3. قم بـ **فك الضغط (Extract / Unpack)** عن ملف الـ `.zip` باستخدام مدير الملفات بهاتفك إلى مجلد عادي *(ملاحظة مهمة: يجب فك الضغط عن الملف)*.
4. افتح متصفح Titanium، واضغط على زر القائمة **(⋮)** ➔ ثم **الإضافات (Extensions)** (أو اذهب إلى `chrome://extensions`).
5. فعّل خيار **وضع المطور (Developer mode)** في الزاوية العلوية.
6. اضغط على **Load unpacked** (أو زر إضافة الامتدادات) واختر مجلد الإضافة بعد فك الضغط.
7. تأكد من ظهور إضافة **Reddit Reels Bridge** في القائمة وأنها مفعلة.

#### الخطوة 2: تسجيل الدخول وتثبيت التطبيق على الشاشة الرئيسية (PWA)
1. داخل متصفح Titanium، افتح [reddit.com](https://www.reddit.com) (أو `old.reddit.com`) و**سجّل الدخول إلى حسابك في ريديت**.
2. افتح تبويباً جديداً (New Tab) وادخل إلى رابط الموقع:  
   👉 **`https://yaser-rh.github.io/reelit/`**
3. اضغط على قائمة المتصفح **(⋮)** ➔ **مشاركة وحفظ (Share and save)** ➔ **تثبيت وإنشاء اختصار (Install and create shortcut)** ➔ ثم **تثبيت (Install)**.
4. افتح تطبيق **Reelit** الآن من شاشتك الرئيسية كتطبيق مستقل كامل الشاشة!

---

## ⚙️ How It Works (Brief Overview)

```
[ Reelit PWA Frontend ] (GitHub Pages / Android App)
        │
        │  window.postMessage
        ▼
[ Companion Extension ] (Reddit Reels Bridge)
        │
        │  fetch with credentials: 'include'
        ▼
[ Reddit & Redgifs APIs ] (Logged-in cookies + HD Resolvers)
```

1. **Cookie-Powered Session**: The companion extension proxies API requests using your existing browser session cookies. This means Reelit displays your actual subscribed Home feed, upvotes, and saved preferences without asking for your username or password.
2. **Universal Video & Audio Playback**: Plays high-definition Reddit videos (`v.redd.it`) with synced audio streams, and resolves Redgifs streams directly in the background.
3. **Optimized for Mobile**: Built with vertical full-screen swipe snapping, double-tap to like, touch gesture navigation, and offline app-shell caching.

---

## 💻 Desktop Quick Start (Development & PC)

1. Open Chrome, Brave, or Edge and go to `chrome://extensions`.
2. Enable **Developer mode** and click **Load unpacked**.
3. Select the `extension` folder in this repo.
4. Log into Reddit in the same browser profile.
5. Visit [https://yaser-rh.github.io/reelit/](https://yaser-rh.github.io/reelit/) (or run `npm run dev` in `site/`).

---

## 📁 Project Structure

```
reelit/
├── extension/                 # Companion Chrome Extension (Manifest V3)
│   ├── manifest.json          # Permissions & GitHub Pages content script matches
│   ├── background.js          # Service worker (Reddit fetch & Redgifs resolver)
│   └── content.js             # Window postMessage bridge
├── site/                      # Vite Frontend Web App (PWA)
│   ├── index.html             # Shell with header, feed, and status modals
│   ├── main.js                # App entrypoint and UI event binding
│   ├── bridge.js              # Promise-based extension communication bridge
│   ├── reddit.js              # Reddit JSON client and media classifier
│   ├── feed.js                # Scroll-snap controller & video/audio player
│   ├── styles.css             # Full-screen dark mode TikTok UI styling
│   └── vite.config.js         # Vite configuration & vite-plugin-pwa setup
├── reelit-extension.zip       # Ready-to-install extension package for mobile
├── .github/workflows/         # Automated GitHub Actions deployment to Pages
└── README.md
```
