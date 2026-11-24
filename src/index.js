import { refresh, readAll } from './store.js';
import { buildView } from './view.js';
import { getSettings } from './settings.js';
import { handleTelegram, setupWebhook, sendMsg, ownerId } from './telegram.js';
import { autoUpdate } from './updater.js';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Telegram có thể tạm khoá bot mới tạo (lỗi 429). Cron tự thử nối webhook tới khi được.
async function autoConnect(env) {
  if (!env.TELEGRAM_BOT_TOKEN || (await env.KV.get('tg:ready')) === env.TELEGRAM_BOT_TOKEN.split(':')[0]) return;
  const origin = (await env.KV.get('origin')) || 'https://trmnl-price.meohocgioi.workers.dev';
  const r = await setupWebhook(env, origin, { welcome: true });
  if (r.ok) await env.KV.put('tg:ready', env.TELEGRAM_BOT_TOKEN.split(':')[0]);
}

// Báo qua Telegram khi mọi proxy SOCKS5 đều lỗi (tối đa 1 lần / 6 giờ)
async function proxyAlert(env, res) {
  if (!res) return;
  if (res === 'ok') { await env.KV.delete('alert:proxy'); return; }
  if (!/proxy/i.test(res) || (await env.KV.get('alert:proxy'))) return;
  const owner = await ownerId(env);
  if (!owner || !env.TELEGRAM_BOT_TOKEN) return;
  await sendMsg(env, owner, '🧦 <b>Proxy cho Binance P2P đang lỗi</b> — TRMNL không có giá P2P.\nGửi proxy mới: <code>/proxy link-t.me/socks</code>\n\n<i>' + res.replace(/^ERR /, '').replace(/</g, '&lt;').slice(0, 400) + '</i>', [[{ text: '🧦 Xem proxy', callback_data: 'proxy' }]]);
  await env.KV.put('alert:proxy', '1', { expirationTtl: 6 * 3600 });
}

export async function screen(env) {
  return buildView(await readAll(env), await getSettings(env));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/' || p === '/health') return json({ ok: true, name: 'trmnl-price', version: env.VERSION || null });

    // Dữ liệu cho TRMNL (Polling). Cron làm mới 5 phút/lần; ở đây chỉ bù khi cron trễ (bỏ nguồn nặng).
    if (p === '/trmnl') {
      const last = Number(await env.KV.get('lastRefresh')) || 0;
      if (Date.now() - last > 12 * 60000) await refresh(env, { light: true });
      return json(await screen(env));
    }

    // Kiểm tra nhanh (chỉ bật khi có biến DEBUG_KEY — bản deploy bình thường không có)
    if (p === '/debug' && env.DEBUG_KEY && url.searchParams.get('k') === env.DEBUG_KEY && url.searchParams.get('bn')) {
      const out = {};
      const tests = {
        bybit: ['https://api2.bybit.com/fiat/otc/item/online', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenId: 'USDT', currencyId: 'VND', side: '0', size: '5', page: '1', payment: [], amount: '' }) }],
        okx: ['https://www.okx.com/v3/c2c/tradingOrders/books?quoteCurrency=VND&baseCurrency=USDT&side=sell&paymentMethod=all&userType=all&showTrade=false&showFollow=false&showAlreadyTraded=false&isAbleFilter=false', {}],
        mexc: ['https://p2p.mexc.com/api/market?adsType=1&coinId=128&currency=VND&page=1&pageSize=5', {}],
      };
      for (const [k, u] of Object.entries(tests)) {
        try { const [uu, init] = u; const r = await fetch(uu, { ...init, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', ...(init.headers || {}) } }); out[k] = r.status + ' ' + (await r.text()).slice(0, 300).replace(/\s+/g, ' '); }
        catch (e) { out[k] = 'ERR ' + e.message; }
      }
      return json(out);
    }
    if (p === '/debug' && env.DEBUG_KEY && url.searchParams.get('k') === env.DEBUG_KEY && url.searchParams.get('px')) {
      const { socksFetch, getProxies, proxyId } = await import('./socks.js');
      const out = {};
      for (const px of await getProxies(env)) {
        for (const t of ['http://ipinfo.io/json', 'https://ipinfo.io/json', 'https://www.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', 'https://c2c.binance.com/bapi/c2c/v2/friendly/c2c/adv/search']) {
          const post = t.includes('bapi');
          try {
            const r = await socksFetch(px, t, post ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: { fiat: 'VND', page: 1, rows: 1, tradeType: 'SELL', asset: 'USDT' } } : {});
            out[proxyId(px) + ' ' + t] = r.status + ' ' + r.text.slice(0, 160).replace(/\s+/g, ' ');
          } catch (e) { out[proxyId(px) + ' ' + t] = 'ERR ' + e.message; }
        }
      }
      return json(out);
    }
    if (p === '/debug' && env.DEBUG_KEY && url.searchParams.get('k') === env.DEBUG_KEY) {
      const only = url.searchParams.get('only');
      const r = await refresh(env, { force: true, only: only ? only.split(',') : undefined });
      const trace = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then((x) => x.text()).catch((e) => String(e));
      const where = trace.split('\n').filter((l) => /^(ip|colo|loc)=/.test(l)).join(' ');
      return json({ where, result: r.result, view: buildView(r.data, r.settings) });
    }

    if (p === '/tg' && req.method === 'POST') return handleTelegram(req, env, ctx);
    if (p === '/setup') {
      await env.KV.put('origin', url.origin);
      const r = await setupWebhook(env, url.origin, { welcome: true });
      if (r.ok && env.TELEGRAM_BOT_TOKEN) await env.KV.put('tg:ready', env.TELEGRAM_BOT_TOKEN.split(':')[0]);
      return json(r);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const r = await refresh(env);
      await env.KV.put('lastRefresh', String(Date.now()));
      if (Object.keys(r.result).length) console.log('refresh', JSON.stringify(r.result));
      await proxyAlert(env, r.result.p2p);
    })().catch((e) => console.error('refresh', e)));
    ctx.waitUntil(autoConnect(env).catch((e) => console.error('autoConnect', e)));
    ctx.waitUntil(autoUpdate(env).catch((e) => console.error('autoUpdate', e)));
  },
};
