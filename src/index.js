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
    if (p === '/debug' && env.DEBUG_KEY && url.searchParams.get('k') === env.DEBUG_KEY && url.searchParams.get('pt')) {
      const { socksFetch, getProxies, proxyId } = await import('./socks.js');
      const list = await getProxies(env);
      const out = {};
      await Promise.all(list.map(async (px) => {
        const t0 = Date.now();
        try {
          const r = await socksFetch(px, 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { fiat: 'VND', page: 1, rows: 1, tradeType: 'SELL', asset: 'USDT', payTypes: [], countries: [] } });
          let code = '?'; try { code = JSON.parse(r.text).code; } catch {}
          out[proxyId(px)] = `HTTP ${r.status} · Binance code ${code} · ${Date.now() - t0}ms`;
        } catch (e) { out[proxyId(px)] = 'ERR ' + e.message + ` · ${Date.now() - t0}ms`; }
      }));
      return json(out);
    }
    if (p === '/debug' && env.DEBUG_KEY && url.searchParams.get('k') === env.DEBUG_KEY && url.searchParams.get('sx')) {
      const { connect } = await import('cloudflare:sockets');
      const { getProxies } = await import('./socks.js');
      const px = (await getProxies(env))[0];
      const log = [];
      const enc = new TextEncoder(), dec = new TextDecoder();
      try {
        const mode = url.searchParams.get('m') || 'plain';
        const sock = connect({ hostname: px.host, port: Number(px.port) }, mode === 'plain' ? undefined : { secureTransport: 'starttls' });
        sock.closed.then(() => log.push('closed ok'), (e) => log.push('closed err ' + e));
        await sock.opened.then((i) => log.push('opened ' + JSON.stringify(i))).catch((e) => log.push('open err ' + e));
        let w = sock.writable.getWriter(); let r = sock.readable.getReader();
        let buf = new Uint8Array(0);
        const need = async (n) => { while (buf.length < n) { const { value, done } = await r.read(); if (done) throw new Error('done@' + buf.length); const b = new Uint8Array(buf.length + value.length); b.set(buf); b.set(value, buf.length); buf = b; } const o = buf.slice(0, n); buf = buf.slice(n); return o; };
        await w.write(new Uint8Array([5, 2, 0, 2])); const g = await need(2); log.push('greet ' + g.join(','));
        const us = enc.encode(px.user), ps = enc.encode(px.pass);
        await w.write(new Uint8Array([1, us.length, ...us, ps.length, ...ps])); log.push('auth ' + (await need(2)).join(','));
        const host = url.searchParams.get('h') || 'ipinfo.io'; const hb = enc.encode(host);
        const tlsOn = mode === 'tls' || mode === 'tls2';
        await w.write(new Uint8Array([5, 1, 0, 3, hb.length, ...hb, tlsOn ? 1 : 0, tlsOn ? 187 : 80])); const h = await need(4); log.push('connect ' + h.join(','));
        if (h[3] === 1) await need(6); else if (h[3] === 4) await need(18); else if (h[3] === 3) { const l = (await need(1))[0]; await need(l + 2); }
        if (mode === 'release' || tlsOn) {
          if (mode === 'tls2') { try { await w.close(); } catch (e) { log.push('wclose ' + e); } }
          w.releaseLock(); r.releaseLock(); log.push('released, leftover ' + buf.length);
          const s2 = tlsOn ? sock.startTls({ expectedServerHostname: host }) : sock;
          if (tlsOn) {
            s2.closed.then(() => log.push('tls closed ok'), (e) => log.push('tls closed err ' + (e && (e.stack || e.message || e))));
            await s2.opened.then((i) => log.push('tls opened ' + JSON.stringify(i))).catch((e) => log.push('tls open err ' + e));
          }
          w = s2.writable.getWriter(); r = s2.readable.getReader();
        }
        await w.write(enc.encode(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: curl/8\r\n\r\n`)); log.push('sent');
        const t0 = Date.now(); let got = buf.length, first = dec.decode(buf);
        for (;;) { const x = await Promise.race([r.read(), new Promise((res) => setTimeout(() => res({ timeout: true }), 8000))]); if (x.timeout) { log.push('read timeout'); break; } if (x.done) { log.push('read done after ' + (Date.now() - t0) + 'ms'); break; } got += x.value.length; if (first.length < 200) first += dec.decode(x.value); }
        log.push('bytes ' + got + ' :: ' + first.slice(0, 200));
      } catch (e) { log.push('ERR ' + e.message); }
      return json({ proxy: px.host, log });
    }
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
