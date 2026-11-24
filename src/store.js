// Lấy dữ liệu từ các nguồn theo chu kỳ riêng và lưu vào KV.
// Lỗi không xoá số liệu cũ: giữ bản đúng gần nhất + ghi lỗi để hiện cảnh báo nhỏ.
import * as S from './sources.js';
import { getSettings } from './settings.js';

const MIN = 60000;
const vnHour = (ms) => new Date(ms + 7 * 3600000).getUTCHours() + new Date(ms).getUTCMinutes() / 60;

// every: chu kỳ làm mới (ms). heavy: dùng Browser Rendering (tốn giờ trình duyệt → thưa hơn ban đêm)
export const SOURCES = {
  p2p:    { every: 5 * MIN,  label: 'Binance P2P', run: (env, s) => S.p2p(env, { side: s.p2pSide, minLimit: s.p2pMin }) },
  black:  { every: 15 * MIN, label: 'USD chợ đen', run: () => S.blackUsd() },
  sjc:    { every: 15 * MIN, label: 'Vàng SJC', run: () => S.sjc() },
  phuquy: { every: 30 * MIN, label: 'Bạc Phú Quý', run: () => S.phuquy() },
  doji:   { every: 30 * MIN, label: 'Bạc DOJI', heavy: true, run: (env) => S.doji(env) },
  world:  { every: 5 * MIN,  label: 'Vàng/bạc thế giới', run: () => S.world() },
  fx:     { every: 30 * MIN, label: 'Ngoại tệ VCB', run: () => S.fx() },
  fuel:   { every: 60 * MIN, label: 'Xăng PVOIL', run: () => S.fuel() },
};

const key = (k) => 'src:' + k;

export async function readAll(env) {
  const out = {};
  await Promise.all(Object.keys(SOURCES).map(async (k) => { out[k] = (await env.KV.get(key(k), 'json')) || null; }));
  return out;
}

// Tham số P2P đổi (Mua/Bán, hạn mức) → số liệu cũ không còn đúng
const p2pParams = (s) => `${s.p2pSide}|${s.p2pMin}`;

function due(k, rec, s, now, force) {
  if (force) return true;
  if (!rec) return true;
  if (k === 'p2p' && rec.params !== p2pParams(s)) return true;
  const src = SOURCES[k];
  let every = src.every;
  if (src.heavy) {
    const h = vnHour(now);
    if (h < 6 || h >= 22.5) every = 3 * 60 * MIN; // ban đêm giá bạc gần như không đổi
  }
  const last = Math.max(rec.at || 0, rec.errAt || 0);
  return now - last >= every - 30000;
}

/**
 * Làm mới các nguồn đến hạn. opts.only = ['p2p', ...] chỉ làm các nguồn này;
 * opts.force = bỏ qua chu kỳ; opts.light = bỏ nguồn nặng (Browser Rendering)
 */
export async function refresh(env, opts = {}) {
  const now = Date.now();
  const s = await getSettings(env);
  const cur = await readAll(env);
  const keys = (opts.only || Object.keys(SOURCES)).filter((k) => !(opts.light && SOURCES[k].heavy));
  const result = {};
  await Promise.all(keys.map(async (k) => {
    const rec = cur[k];
    if (!due(k, rec, s, now, opts.force)) return;
    try {
      const data = await SOURCES[k].run(env, s);
      const next = { at: Date.now(), data, params: k === 'p2p' ? p2pParams(s) : undefined };
      await env.KV.put(key(k), JSON.stringify(next));
      cur[k] = next;
      result[k] = 'ok';
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 200);
      // P2P đổi tham số mà lỗi → bỏ số liệu cũ (không đúng loại nữa)
      const keep = rec && !(k === 'p2p' && rec.params !== p2pParams(s));
      const next = { ...(keep ? rec : {}), err: msg, errAt: Date.now(), params: k === 'p2p' ? p2pParams(s) : rec?.params };
      if (!keep) delete next.data;
      await env.KV.put(key(k), JSON.stringify(next));
      cur[k] = next;
      result[k] = 'ERR ' + msg;
      console.error('source', k, msg);
    }
  }));
  return { result, data: cur, settings: s };
}
