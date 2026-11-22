# MedStudy AI — Web Học Y Khoa Đơn Giản (Frontend + FastAPI + OpenAI)

Ứng dụng web học Y khoa đơn giản: người dùng nhập câu hỏi trên giao diện web (Frontend), câu hỏi được gửi đến Backend FastAPI, FastAPI gọi OpenAI API và trả câu trả lời có cấu trúc học thuật về cho người dùng.

## Cấu trúc thư mục

```text
houndshark/
├── backend/                # Terminal 3: FastAPI Backend
│   ├── main.py             # API /api/health và /api/ask (gọi OpenAI)
│   ├── requirements.txt    # Thư viện Python cần thiết
│   └── .env.example        # File mẫu chứa OPENAI_API_KEY
└── frontend/               # Terminal 2: Web Frontend
    ├── index.html          # Giao diện hỏi đáp học Y khoa
    ├── styles.css          # Thiết kế giao diện
    ├── app.js              # Logic gọi API FastAPI & hiển thị Markdown
    ├── server.js           # Server chạy local port 3000 (không cần cài thêm thư viện)
    └── package.json
```

## Bước 1: Cấu hình OpenAI API Key

Bạn có **2 cách** để cung cấp OpenAI API Key:

- **Cách 1 (Khuyên dùng):** Sao chép `backend/.env.example` thành `backend/.env` rồi điền key của bạn:
  ```env
  OPENAI_API_KEY=sk-proj-...
  OPENAI_MODEL=gpt-4o-mini
  ```
- **Cách 2 (Thử nhanh):** Chạy cả 2 terminal, mở web và nhấn nút **Cài đặt API** để dán trực tiếp OpenAI API Key trên giao diện.

## Bước 2: Chạy bằng 2 Terminal

### Terminal 3 — Backend (FastAPI, port `8000`)

```powershell
cd backend
.\.venv\Scripts\uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

> Nếu chưa tạo môi trường ảo `.venv`:
> ```powershell
> cd backend
> python -m venv .venv
> .\.venv\Scripts\pip install -r requirements.txt
> .\.venv\Scripts\uvicorn main:app --reload --host 127.0.0.1 --port 8000
> ```

Kiểm tra nhanh Backend:
- Health check: `http://127.0.0.1:8000/api/health`
- Swagger API Docs: `http://127.0.0.1:8000/docs`

### Terminal 2 — Frontend (Web UI, port `3000`)

```powershell
cd frontend
npm run dev
```

Mở trình duyệt tại: **http://127.0.0.1:3000**

## Deploy lên Render (1 link duy nhất cho cả Web + Backend)

Dự án đã có sẵn file `render.yaml` và FastAPI tự động phục vụ giao diện `frontend/` ở đường dẫn `/`.

### Cách 1: Dùng Render Blueprint (Khuyên dùng)
1. Vào [Render Dashboard](https://dashboard.render.com) → **New +** → **Blueprint**.
2. Chọn repo GitHub `kudo2022/Medical_AI` (nhánh `main`).
3. Nhập giá trị cho biến **`OPENAI_API_KEY`** (Render sẽ tự điền Build/Start Command và `OPENAI_MODEL=gpt-4o` từ `render.yaml`).
4. Nhấn **Apply** và chờ deploy xong để lấy link `https://...onrender.com`.

### Cách 2: Tạo Web Service thủ công trên Render
1. Vào **New +** → **Web Service** → chọn repo GitHub (nhánh `main`).
2. Cấu hình:
   - **Runtime:** `Python 3`
   - **Build Command:** `pip install -r backend/requirements.txt`
   - **Start Command:** `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
3. Trong mục **Environment Variables**, thêm:
   - `OPENAI_API_KEY` = `sk-...`
   - `OPENAI_MODEL` = `gpt-4o`
4. Nhấn **Create Web Service**.

## Ghi chú

- Thông tin do AI sinh ra chỉ phục vụ mục đích học tập và ôn thi y khoa, không thay thế chẩn đoán hoặc chỉ định điều trị lâm sàng.
