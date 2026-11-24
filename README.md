# TRMNL Bảng giá

Plugin TRMNL hiện bảng giá, điều khiển bằng bot Telegram, chạy hoàn toàn trên **Cloudflare Workers** (không cần máy chủ):

| Mục | Nguồn | Làm mới |
|---|---|---|
| USDT P2P (3 quảng cáo đầu, bỏ *Promoted Ad*, hạn mức tối đa > 10 triệu) | Binance P2P | 5 phút |
| USD chợ đen | tygiausd.org | 15 phút |
| Vàng SJC (miếng + nhẫn 9999) | bảng giá SJC đăng lại trên tygiausd.org (sjc.com.vn chặn máy chủ Cloudflare) | 15 phút |
| Bạc DOJI 99.9 | banggia.doji.vn (mở bằng Browser Rendering) | 30 phút (ban đêm 3 giờ) |
| Bạc Phú Quý 999 | giabac.phuquygroup.vn | 30 phút |
| Vàng / bạc thế giới | TradingView: `OANDA:XAUUSD`, `TVC:SILVER` | 5 phút |
| CNY, JPY, GBP | Vietcombank | 30 phút |
| Xăng E10 RON 95 (+ E5 nếu bật) | PVOIL | 1 giờ |

Có đủ 4 cỡ màn hình TRMNL (full, nửa ngang, nửa dọc, 1/4).

## Cài đặt (1 lần)

### 1. GitHub Secrets
Repo → *Settings → Secrets and variables → Actions → New repository secret*:

| Tên | Giá trị | Bắt buộc |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | token Cloudflare (giống các repo trmnl khác) | ✅ |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID Cloudflare | ✅ |
| `TELEGRAM_BOT_TOKEN` | token bot mới từ @BotFather | ✅ |
| `TELEGRAM_OWNER_ID` | Telegram user ID của bạn | không (bỏ trống thì người đầu tiên bấm /start là chủ) |
| `GH_TOKEN` | GitHub fine-grained token, quyền **Actions: Read and write** cho repo này | cho /update |
| `TRMNL_MCP_KEY` | MCP API key của plugin "Bảng giá" trên TRMNL | cho /preview |

Sau đó vào tab **Actions → Deploy Worker → Run workflow**.

### 2. TRMNL
Private Plugin **Bảng giá** → Strategy **Polling** → Polling URL:
`https://trmnl-price.meohocgioi.workers.dev/trmnl`
Markup: dán `trmnl/shared.liquid` vào ô **Shared**, và 4 file `full` / `half_horizontal` / `half_vertical` / `quadrant` (mỗi file 1 dòng) vào từng ô tương ứng.

Sửa giao diện: sửa `trmnl/_style.liquid`, `trmnl/_body.liquid` rồi chạy `node scripts/gen-views.mjs`.

## Lệnh Telegram
`/gia` `/preview` `/preview all` `/setting` `/trmnl` `/update` `/version` `/help`

- `/setting`: giá **Bán** hay **Mua** USDT, hạn mức P2P (> 10tr / 50tr / 100tr / 200tr), giá vàng/bạc cho **1 lượng** hay **10 lượng**, hiện thêm xăng E5.
- Code mới trên GitHub tự deploy trong vòng 15 phút; `/update` lấy lại giá + deploy ngay.
