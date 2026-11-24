// Biến dữ liệu thô thành nội dung hiển thị (TRMNL + Telegram)
import { SOURCES } from './store.js';
import { FX, WORLD } from './sources.js';
import { hhmm, stamp } from './util.js';

// 26392 → "26.392" ; 156.25 → "156,25"
export function vnd(n, dec = 0) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const x = Number(n);
  const [i, f] = Math.abs(x).toFixed(dec).split('.');
  const s = i.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (x < 0 ? '-' : '') + s + (f && /[1-9]/.test(f) ? ',' + f : '');
}
// 10.000.000 → "10tr" ; 1.500.000.000 → "1,5 tỷ"
export function short(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (Math.round(n / 1e8) / 10).toString().replace('.', ',') + ' tỷ';
  if (n >= 1e6) return Math.round(n / 1e6) + 'tr';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}
const signed = (n, fmt = vnd) => (n == null ? '' : (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n)));
const usd = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const SIDE_LABEL = { SELL: 'BÁN', BUY: 'MUA' };

function age(rec, now) {
  if (!rec?.at) return null;
  return now - rec.at;
}

export function buildView(all, s, now = Date.now()) {
  const warn = [];
  const st = (k) => {
    const rec = all[k];
    const has = !!rec?.data;
    const a = age(rec, now);
    const stale = has && a > Math.max(3 * SOURCES[k].every, 45 * 60000) * (SOURCES[k].heavy ? 4 : 1);
    if (rec?.err && (!has || stale)) warn.push(`${SOURCES[k].label}: ${rec.err}`);
    else if (stale) warn.push(`${SOURCES[k].label}: số liệu lúc ${stamp(rec.at)}`);
    return { has, d: rec?.data, stale, err: rec?.err || null };
  };
  const unit = s.unit === 10 ? 10 : 1;
  const u = (n) => (n == null ? null : n * unit);

  // 1. P2P
  const P = st('p2p');
  const p2p = {
    side: SIDE_LABEL[s.p2pSide] || 'BÁN',
    min: short(s.p2pMin),
    has: P.has && P.d.ads?.length > 0,
    stale: P.stale,
    error: P.has ? '' : shortErr(P.err),
    ads: (P.d?.ads || []).map((a, i) => ({
      rank: i + 1, name: a.name, price: vnd(a.price), limit: `${short(a.min)}–${short(a.max)}`,
      orders: a.orders ?? '', rate: a.rate != null ? a.rate + '%' : '',
    })),
  };
  if (P.has && !p2p.ads.length) p2p.error = `Không có quảng cáo hạn mức > ${short(s.p2pMin)}`;

  // 2. USD chợ đen
  const B = st('black');
  const black = B.has
    ? { has: true, buy: vnd(B.d.buy), sell: vnd(B.d.sell), buy_ch: signed(B.d.buyCh), sell_ch: signed(B.d.sellCh), stale: B.stale }
    : { has: false, error: shortErr(B.err) };

  // 3. Ngoại tệ VCB
  const F = st('fx');
  const fx = FX.filter((f) => f.code !== 'USD').map((f) => {
    const r = F.d?.rates?.[f.code];
    const dec = f.code === 'JPY' ? 2 : 0;
    return { code: f.code, name: f.name, buy: r ? vnd(r.buy ?? r.transfer, dec) : '—', transfer: r ? vnd(r.transfer, dec) : '—', sell: r ? vnd(r.sell, dec) : '—' };
  });
  const usdVcb = F.d?.rates?.USD ? { buy: vnd(F.d.rates.USD.buy), sell: vnd(F.d.rates.USD.sell) } : null;

  // 4. Vàng SJC
  const G = st('sjc');
  const gold = G.has
    ? {
        has: true, stale: G.stale,
        bar: { buy: vnd(u(G.d.bar.buy)), sell: vnd(u(G.d.bar.sell)) },
        ring: G.d.ring ? { buy: vnd(u(G.d.ring.buy)), sell: vnd(u(G.d.ring.sell)) } : null,
      }
    : { has: false, error: shortErr(G.err) };

  // 5. Bạc
  const D = st('doji'), Q = st('phuquy');
  const silver = [
    { name: 'DOJI', has: D.has, stale: D.stale, buy: D.has ? vnd(u(D.d.buy)) : '—', sell: D.has ? vnd(u(D.d.sell)) : '—', error: D.has ? '' : shortErr(D.err) },
    { name: 'Phú Quý', has: Q.has, stale: Q.stale, buy: Q.has ? vnd(u(Q.d.buy)) : '—', sell: Q.has ? vnd(u(Q.d.sell)) : '—', error: Q.has ? '' : shortErr(Q.err) },
  ];

  // 6. Thế giới
  const W = st('world');
  const world = WORLD.map((w) => {
    const r = W.d?.[w.key];
    return r
      ? { name: w.name, short: w.short, price: usd(r.price, w.key === 'gold' ? 2 : 3), pct: r.pct == null ? '' : (r.pct >= 0 ? '+' : '−') + Math.abs(r.pct).toFixed(2) + '%', up: (r.pct ?? 0) >= 0, has: true }
      : { name: w.name, short: w.short, price: '—', pct: '', up: true, has: false };
  });

  // 7. Xăng
  const X = st('fuel');
  const fuel = X.has
    ? {
        has: true, name: X.d.name, price: vnd(X.d.price), change: X.d.change ? signed(X.d.change) : '',
        since: X.d.since ? X.d.since.replace(/\/\d{4}$/, '') : '',
        e5: s.showE5 && X.d.e5 ? { name: X.d.e5.name, price: vnd(X.d.e5.price), change: X.d.e5.change ? signed(X.d.e5.change) : '' } : null,
      }
    : { has: false, error: shortErr(X.err) };

  return {
    updated: hhmm(now), updated_full: stamp(now),
    unit, unit_label: unit === 10 ? '10 lượng' : '1 lượng',
    p2p, black, fx, usd_vcb: usdVcb, gold, silver, world, fuel,
    warn: warn.join(' · '), warn_count: warn.length,
  };
}

function shortErr(e) {
  if (!e) return 'Đang lấy dữ liệu…';
  if (/HTTP 403|HTTP 451/.test(e)) return 'Nguồn chặn máy chủ';
  return e.length > 60 ? e.slice(0, 57) + '…' : e;
}
