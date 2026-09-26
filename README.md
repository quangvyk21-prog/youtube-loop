# YouTube Loop V10 - Live Sidebar End

Bản này lấy trực tiếp từ V8 và chỉ thay đúng một phần:

- Sau khi đã chọn `start` nhưng chưa chọn `end`, phần thời gian `end` ngay trên thẻ loop bên trái sẽ chạy theo thời gian video hiện tại.
- Cập nhật theo đơn vị **1 giây**.
- Ví dụ:
  - `00:58 - 00:59`
  - `00:58 - 01:00`
  - `00:58 - 01:01`
- Khi bấm `end`, mốc end được chốt và không chạy nữa.

Mọi chức năng khác giữ nguyên V8.

## Chạy
```bash
npm install
npm run dev
```
