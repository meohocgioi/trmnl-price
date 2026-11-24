// Định dạng thời gian theo giờ Việt Nam
const TZ = 'Asia/Ho_Chi_Minh';
const OFFSET = 7 * 3600000; // UTC+7 (VN không đổi giờ mùa hè)

const vn = (ms) => new Date(ms + OFFSET); // dùng các hàm getUTC* trên kết quả
const p2 = (n) => String(n).padStart(2, '0');
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const WD_FULL = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

export const hhmm = (ms) => { const d = vn(ms); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
export const ddmm = (ms) => { const d = vn(ms); return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}`; };
export const wd = (ms) => WD[vn(ms).getUTCDay()];
export const wdFull = (ms) => WD_FULL[vn(ms).getUTCDay()];
const dayIndex = (ms) => Math.floor((ms + OFFSET) / 86400000);

// "15:50" nếu hôm nay, "Mai 15:50", "T7 19:00" trong tuần, "11/12 05:00" xa hơn
export function when(ms, now = Date.now()) {
  const dd = dayIndex(ms) - dayIndex(now);
  if (dd === 0) return hhmm(ms);
  if (dd === 1) return `Mai ${hhmm(ms)}`;
  if (dd > 1 && dd < 7) return `${wd(ms)} ${hhmm(ms)}`;
  return `${hhmm(ms)} ${ddmm(ms)}`;
}

// Khoảng thời gian dài: "16 ngày 18 giờ", "4 giờ 29 phút", "12 phút"
export function durLong(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  if (d > 0) return h ? `${d} ngày ${h} giờ` : `${d} ngày`;
  if (h > 0) return mi ? `${h} giờ ${mi} phút` : `${h} giờ`;
  return `${mi} phút`;
}

// Khoảng thời gian gọn: "16n 18g", "4g29", "12p"
export function durShort(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  if (d > 0) return `${d}n ${h}g`;
  if (h > 0) return `${h}g${p2(mi)}`;
  return `${mi}p`;
}

export const stamp = (ms) => `${hhmm(ms)} ${ddmm(ms)}`;

export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const clamp = (n, a = 0, b = 100) => Math.min(b, Math.max(a, n));

export { TZ };
