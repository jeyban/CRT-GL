# ⚡ Crypto CRT Scanner

A live Candle Range Theory (CRT) anticipation scanner for MEXC USDT pairs.

Scans ~100 pairs across **1H**, **4H**, and **1D** timeframes and detects:
- **Bullish CRT**: C2 sweeps above C1 high → price reclaims below C1 high
- **Bearish CRT**: C2 sweeps below C1 low → price reclaims above C1 low

---

## 📁 Project Structure

```
crypto-crt-scanner/
├── backend/
│   ├── server.js              # Express entry point
│   ├── routes/scanner.js      # API routes
│   ├── services/
│   │   ├── mexc.js            # MEXC API integration
│   │   ├── crtLogic.js        # CRT detection logic
│   │   └── scheduler.js       # Cron jobs + scan runner
│   ├── data/store.js          # In-memory alert store
│   └── package.json
└── frontend/
    ├── index.html             # Dashboard UI
    ├── app.js                 # Dashboard JS
    └── vercel.json            # Vercel config
```

---

## 🚀 Quick Start (Local)

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

Backend runs on: `http://localhost:3001`

### 2. Frontend

Open `frontend/index.html` directly in a browser,  
OR use VS Code's **Live Server** extension.

> The initial 1H scan runs automatically on backend startup (~30 seconds to complete).

### 3. Trigger a manual scan (for testing)

```bash
curl -X POST http://localhost:3001/api/scan/1h
```

---

## 🌐 Deployment

### Backend → Render.com

1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your repo, set root dir to `backend/`
4. Build command: `npm install`
5. Start command: `node server.js`
6. Add env var: `FRONTEND_URL=https://your-app.vercel.app`
7. Deploy

### Frontend → Vercel

1. Go to [vercel.com](https://vercel.com) → New Project
2. Connect your repo, set root dir to `frontend/`
3. Deploy (auto-detected as static)
4. **Important**: Update `window.BACKEND_URL` in `index.html` to your Render URL

```html
<script>
  window.BACKEND_URL = "https://your-backend.onrender.com/api";
</script>
```

---

## 📡 API Endpoints

| Method | Endpoint            | Description                    |
|--------|---------------------|--------------------------------|
| GET    | `/api/alerts`       | All alerts (all timeframes)    |
| GET    | `/api/alerts/1h`    | 1H alerts only                 |
| GET    | `/api/alerts/4h`    | 4H alerts only                 |
| GET    | `/api/alerts/1d`    | 1D alerts only                 |
| POST   | `/api/scan/1h`      | Trigger 1H scan manually       |
| POST   | `/api/scan/4h`      | Trigger 4H scan manually       |
| POST   | `/api/scan/1d`      | Trigger 1D scan manually       |
| GET    | `/api/status`       | Health check + last scan times |

---

## ⏰ Scan Schedule

| Timeframe | Schedule                          |
|-----------|-----------------------------------|
| 1H        | Every hour at :15 (e.g. 8:15 AM) |
| 4H        | 1AM, 5AM, 9AM, 1PM, 5PM, 9PM     |
| 1D        | 8PM daily                         |

---

## 🧠 CRT Logic

```
Bullish CRT:
  (C2_high > C1_high) AND (currentPrice < C1_high)
  → Sweep above, then rejection back down

Bearish CRT:
  (C2_low < C1_low) AND (currentPrice > C1_low)
  → Sweep below, then rejection back up
```

No candle close required — detection is live and aggressive.

---

## 🔧 Customization

- **Change pairs**: Edit `USDT_PAIRS` in `backend/services/mexc.js`
- **Change scan times**: Edit cron expressions in `backend/services/scheduler.js`
- **Change refresh rate**: Edit `REFRESH_INTERVAL` in `frontend/app.js`
- **Change backend URL**: Edit `window.BACKEND_URL` in `frontend/index.html`
