// Các nguồn dữ liệu giá. Mỗi hàm trả về object dữ liệu hoặc ném lỗi.
import puppeteer from '@cloudflare/puppeteer';
import { socksFetch, getProxies, saveProxies, proxyId } from './socks.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const H = { 'user-agent': UA, 'accept-language': 'vi,en;q=0.8' };

async function get(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...H, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  if (!r.ok) {
    const why = /cloudflare|attention required|just a moment/i.test(text) ? ' (trang chặn máy chủ)' : '';
    throw new Error(`HTTP ${r.status}${why}`);
  }
  return text;
}

// ---------- tiện ích đọc HTML ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);

const clean = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Tách bảng HTML thành các hàng, mỗi hàng là mảng text của ô (th/td)
export function rows(html) {
  const out = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => clean(c[1]));
    if (cells.length) out.push(cells);
  }
  return out;
}

// "130,000" → 130000 ; "19.100" (kiểu VN) → 19100
export const num = (s) => {
  const t = String(s ?? '').replace(/[^\d.,-]/g, '');
  if (!t) return null;
  const n = Number(t.replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const findRow = (rs, re) => rs.find((r) => re.test(r[0]));

// ---------- 1. Binance P2P ----------
// side: 'SELL' = tab Bán (giá bạn bán USDT được), 'BUY' = tab Mua
export async function p2p(env, { side = 'SELL', minLimit = 10_000_000, count = 3 } = {}) {
  const body = {
    fiat: 'VND', page: 1, rows: 20, tradeType: side, asset: 'USDT', countries: [],
    proMerchantAds: false, shieldMerchantAds: false, filterType: 'all', periods: [],
    additionalKycVerifyFilter: 0, publisherType: null, payTypes: [], classifies: ['mass', 'profession', 'fiat_trade'],
  };
  const post = await p2pTransport(env);
  const all = [];
  for (let page = 1; page <= 3 && all.length < 60; page++) {
    const text = await post(JSON.stringify({ ...body, page }));
    let j;
    try { j = JSON.parse(text); } catch { throw new Error('Binance trả về dữ liệu lạ'); }
    if (j.code !== '000000') throw new Error(`Binance: ${j.message || j.code}`);
    const d = j.data || [];
    all.push(...d);
    // đủ 3 quảng cáo hợp lệ thì thôi
    const ok = all.filter((x) => valid(x, minLimit));
    if (ok.length >= count || d.length < 20) break;
  }
  const ads = all.filter((x) => valid(x, minLimit)).slice(0, count).map((x) => ({
    name: x.advertiser?.nickName || '?',
    price: Number(x.adv.price),
    min: Number(x.adv.minSingleTransAmount),
    max: Number(x.adv.dynamicMaxSingleTransAmount || x.adv.maxSingleTransAmount),
    orders: x.advertiser?.monthOrderCount ?? null,
    rate: x.advertiser?.monthFinishRate != null ? Math.round(x.advertiser.monthFinishRate * 1000) / 10 : null,
  }));
  return { side, minLimit, ads, via: post.via };
}

const P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

// Chọn đường gọi Binance: thử lần lượt các proxy SOCKS5 (KV "proxies"), proxy nào chạy được thì dùng;
// chưa có proxy nào thì gọi thẳng (Binance thường chặn → lỗi 403).
async function p2pTransport(env) {
  const list = await getProxies(env);
  if (!list.length) {
    const f = async (b) => get(P2P_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
    f.via = 'trực tiếp';
    return f;
  }
  const errs = [];
  // proxy chạy tốt gần nhất lên trước
  const order = [...list].sort((a, b) => (b.okAt || 0) - (a.okAt || 0));
  for (const p of order) {
    const f = async (b) => {
      const r = await socksFetch(p, P2P_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: b });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return r.text;
    };
    try {
      // thử nhanh 1 lần; được thì dùng proxy này cho cả lượt
      const probe = await f(JSON.stringify({ fiat: 'VND', page: 1, rows: 1, tradeType: 'SELL', asset: 'USDT', payTypes: [], countries: [] }));
      JSON.parse(probe);
      await markProxy(env, p, null);
      f.via = proxyId(p);
      return f;
    } catch (e) {
      errs.push(`${proxyId(p)}: ${e.message}`);
      await markProxy(env, p, e.message);
    }
  }
  throw new Error('Tất cả proxy lỗi — ' + errs.join(' · ') + ' — gửi proxy mới bằng /proxy');
}

async function markProxy(env, p, err) {
  const list = await getProxies(env);
  const x = list.find((q) => proxyId(q) === proxyId(p));
  if (!x) return;
  if (err) { x.err = String(err).slice(0, 120); x.errAt = Date.now(); }
  else { x.okAt = Date.now(); delete x.err; }
  await saveProxies(env, list);
}

// Bỏ quảng cáo "Promoted Ad" (privilegeType 8); chỉ giữ quảng cáo có hạn mức tối đa > minLimit
function valid(x, minLimit) {
  if (x.privilegeType === 8 || /promot/i.test(x.privilegeDesc || '')) return false;
  const max = Number(x.adv?.dynamicMaxSingleTransAmount || x.adv?.maxSingleTransAmount);
  return max > minLimit;
}

// ---------- 2. USD chợ đen (tygiausd.org) ----------
export async function blackUsd() {
  const html = await get('https://tygiausd.org/');
  const m = html.match(/<h3>\s*USD chợ đen\s*<\/h3>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  if (!m) throw new Error('Không thấy dòng USD chợ đen');
  const cell = (s) => {
    const sp = s.match(/<span class="([^"]*)">([^<]*)<\/span>/);
    const ch = sp ? num(sp[2]) : null;
    const down = sp && /\b(d|down|text-danger)\b/.test(sp[1]);
    return { v: num(s.replace(/<span[\s\S]*$/, '')), ch: ch == null ? null : down ? -ch : ch };
  };
  const b = cell(m[1]), s = cell(m[2]);
  if (!b.v || !s.v) throw new Error('Không đọc được giá USD chợ đen');
  return { buy: b.v, sell: s.v, buyCh: b.ch, sellCh: s.ch };
}

// ---------- 3. Vàng SJC (bảng SJC đăng lại trên tygiausd.org, đơn vị 1.000đ/lượng) ----------
// sjc.com.vn chặn máy chủ Cloudflare nên lấy bảng giá SJC từ tygiausd.org
export async function sjc() {
  const html = await get('https://tygiausd.org/giavang/gia-vang-hom-nay');
  const rs = rows(html);
  const pick = (re) => {
    const r = findRow(rs, re);
    if (!r) return null;
    const buy = num(r[1]), sell = num(r[2]);
    return { buy: buy ? buy * 1000 : null, sell: sell ? sell * 1000 : null };
  };
  const bar = pick(/^Vàng miếng SJC/i) || pick(/^SJC HCM/i);
  const ring = pick(/^SJC 0\.5c/i);
  if (!bar?.sell) throw new Error('Không thấy giá vàng miếng SJC');
  return { bar, ring };
}

// ---------- 4a. Bạc Phú Quý (VNĐ/lượng) ----------
export async function phuquy() {
  const html = await get('https://giabac.phuquygroup.vn/');
  const rs = rows(html);
  const r = findRow(rs, /BẠC MIẾNG PHÚ QUÝ 999 1 LƯỢNG/i) || findRow(rs, /PHÚ QUÝ 999.*LƯỢNG/i);
  if (!r) throw new Error('Không thấy giá bạc Phú Quý 1 lượng');
  const kg = findRow(rs, /1\s*KILO/i);
  const upd = clean(html).match(/Cập nhật lần cuối:?\s*(\d{1,2}:\d{2}\s+\d{1,2}\/\d{1,2}\/\d{4})/i);
  return {
    buy: num(r[2]), sell: num(r[3]),
    kgBuy: kg ? num(kg[2]) : null, kgSell: kg ? num(kg[3]) : null,
    updated: upd ? upd[1] : null,
  };
}

// ---------- 4b. Bạc DOJI (trang dùng JavaScript → mở bằng Browser Rendering của Cloudflare) ----------
export async function doji(env) {
  if (!env.BROWSER) throw new Error('Thiếu Browser Rendering');
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto('https://banggia.doji.vn/gold-price', { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('table.price-table td', { timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText);
    const line = (re) => text.split('\n').find((l) => re.test(l));
    const parse = (l) => {
      if (!l) return null;
      const ns = l.split('\t').map((x) => x.trim()).filter((x) => /^[\d.,]+$/.test(x));
      // đơn vị trên trang: nghìn VND/lượng; cột: [STT?, mua, bán]
      const [buy, sell] = ns.slice(-2).map((x) => num(x) * 1000);
      return { buy, sell };
    };
    const one = parse(line(/BẠC DOJI 99\.9 - 1 LƯỢNG/i));
    if (!one?.sell) throw new Error('Không thấy giá bạc DOJI 1 lượng');
    const upd = text.match(/BẢNG GIÁ BẠC DOJI\s*\n\s*Cập nhật\s*([^\n]+)/i);
    return { buy: one.buy, sell: one.sell, updated: upd ? upd[1].trim() : null };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- 5. Vàng / bạc thế giới (TradingView) ----------
export const WORLD = [
  { key: 'gold', symbol: 'OANDA:XAUUSD', name: 'Vàng TG', short: 'XAU' },
  { key: 'silver', symbol: 'TVC:SILVER', name: 'Bạc TG', short: 'XAG' },
];
export async function world() {
  const out = {};
  await Promise.all(WORLD.map(async (w) => {
    const text = await get(`https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent(w.symbol)}&fields=close,change,change_abs`);
    const j = JSON.parse(text);
    if (j.close == null) throw new Error(`TradingView không có giá ${w.symbol}`);
    out[w.key] = { symbol: w.symbol, price: j.close, pct: j.change ?? null, abs: j.change_abs ?? null };
  }));
  return out;
}

// ---------- 6. Ngoại tệ (Vietcombank) ----------
export const FX = [
  { code: 'CNY', name: 'Nhân dân tệ' },
  { code: 'JPY', name: 'Yên Nhật' },
  { code: 'GBP', name: 'Bảng Anh' },
  { code: 'USD', name: 'USD (VCB)' },
];
export async function fx() {
  const xml = await get('https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx');
  const out = {};
  for (const m of xml.matchAll(/<Exrate\s+([^>]*?)\/>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2].trim()]));
    if (FX.some((f) => f.code === a.CurrencyCode)) {
      out[a.CurrencyCode] = { buy: num(a.Buy), transfer: num(a.Transfer), sell: num(a.Sell) };
    }
  }
  if (!out.CNY) throw new Error('Không đọc được tỷ giá Vietcombank');
  const t = xml.match(/<DateTime>([^<]+)<\/DateTime>/);
  return { rates: out, updated: t ? t[1] : null };
}

// ---------- 7. Xăng E10 (PVOIL) ----------
export async function fuel() {
  const html = await get('https://www.pvoil.com.vn/tin-gia-xang-dau');
  const rs = rows(html);
  const r = findRow(rs.map((x) => x.slice(1)), /Xăng E10/i);
  if (!r) throw new Error('Không thấy giá xăng E10');
  const when = clean(html).match(/Giá điều chỉnh lúc\s*(\d{1,2}:\d{2})\s*ngày\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const e5 = findRow(rs.map((x) => x.slice(1)), /Xăng E5/i);
  return {
    name: r[0].replace(/^Xăng\s*/i, ''),
    price: num(r[1]),
    change: num(r[2]),
    e5: e5 ? { name: e5[0].replace(/^Xăng\s*/i, ''), price: num(e5[1]), change: num(e5[2]) } : null,
    since: when ? `${when[1]} ${when[2]}` : null,
  };
}
