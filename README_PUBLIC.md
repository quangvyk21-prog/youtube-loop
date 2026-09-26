# YouTube Loop — GitHub + Vercel Public

Nền của bản này:
- V10 stable
- End Toggle Only
- Chưa đưa Local AI/Ollama vào production

## Giữ nguyên chức năng
- YouTube player
- Loop A/B
- End toggle: end đã có -> bấm end lần nữa để xóa
- A / S / D
- Q / W
- Combine loop
- Transcript
- MyMemory translation cũ của V10

## Kiến trúc public
- GitHub: lưu source code public
- Vercel: build + host website
- `/api/transcript/:videoId`: chạy trên Vercel Function
- Không cần giữ VS Code / npm run dev trên PC sau khi deploy

## Local development
```powershell
npm install
npm run dev
```

Mở:
http://localhost:5173

## Production
Import repository GitHub vào Vercel.
Vercel dùng:
- Build command: `npm run build`
- Output: `dist`
- Node: `22.x`

File `api/transcript/[videoId].js` xử lý transcript ở production.

## Lưu ý
GitHub Pages đơn thuần không chạy API Node `/api/transcript`, vì vậy bản này được chuẩn bị cho GitHub + Vercel.
