// Cài đặt (đổi bằng /setting trong bot Telegram), lưu ở KV
export const DEFAULT_SETTINGS = {
  p2pSide: 'SELL',        // SELL = giá Bán USDT (tab Sell trên Binance) · BUY = giá Mua
  p2pMin: 10_000_000,     // chỉ lấy quảng cáo có hạn mức tối đa > số này (VND)
  unit: 1,                // giá vàng/bạc hiện cho 1 lượng hay 10 lượng
  showE5: false,          // hiện thêm xăng E5 RON 92 cạnh E10
};
export const P2P_MINS = [10_000_000, 50_000_000, 100_000_000, 200_000_000];

export async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...((await env.KV.get('settings', 'json')) || {}) };
}
export async function saveSettings(env, s) {
  await env.KV.put('settings', JSON.stringify(s));
}
