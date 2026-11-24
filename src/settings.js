// Cài đặt (đổi bằng /setting trong bot Telegram), lưu ở KV
export const DEFAULT_SETTINGS = {
  p2pMin: 10_000_000,     // chỉ lấy quảng cáo có hạn mức tối đa > số này (VND)
  showBuy: false,         // P2P: mặc định chỉ hiện giá Bán USDT; bật để hiện thêm giá Mua
  unit: 1,                // giá vàng/bạc hiện cho 1 lượng hay 10 lượng
  showE5: false,          // hiện thêm xăng E5 RON 92 cạnh E10
  showBybit: true,        // dòng nhỏ đối chiếu giá Bybit P2P
  showOkx: true,          // dòng nhỏ đối chiếu giá OKX P2P
  showChart: true,        // biểu đồ 1 tuần giá Binance P2P
};
export const P2P_MINS = [10_000_000, 100_000_000, 300_000_000];

export async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...((await env.KV.get('settings', 'json')) || {}) };
}
export async function saveSettings(env, s) {
  await env.KV.put('settings', JSON.stringify(s));
}
