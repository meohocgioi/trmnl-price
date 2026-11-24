// Gọi HTTPS qua proxy SOCKS5 (có user/pass) bằng TCP socket của Cloudflare Workers.
// Dùng cho Binance P2P vì Binance chặn địa chỉ IP của Cloudflare (đăng ký ở Mỹ).
import { connect } from 'cloudflare:sockets';

const enc = new TextEncoder();
const dec = new TextDecoder();

// Đọc từ stream theo số byte cần, giữ phần thừa cho lần sau
class Reader {
  constructor(readable) { this.r = readable.getReader(); this.buf = new Uint8Array(0); }
  async fill(n) {
    while (this.buf.length < n) {
      const { value, done } = await this.r.read();
      if (done) throw new Error('Proxy đóng kết nối');
      const b = new Uint8Array(this.buf.length + value.length);
      b.set(this.buf); b.set(value, this.buf.length); this.buf = b;
    }
  }
  async take(n) { await this.fill(n); const out = this.buf.slice(0, n); this.buf = this.buf.slice(n); return out; }
  release() { this.r.releaseLock(); }
}

const withTimeout = (p, ms, msg) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

// proxy: { host, port, user, pass }
export async function socksFetch(proxy, url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return withTimeout(doFetch(proxy, url, { method, headers, body }), timeout, 'Proxy quá thời gian chờ');
}

async function doFetch(proxy, url, { method, headers, body }) {
  const u = new URL(url);
  const port = Number(u.port) || 443;
  const sock = connect({ hostname: proxy.host, port: Number(proxy.port) }, { secureTransport: 'starttls' });
  try {
    const w = sock.writable.getWriter();
    const rd = new Reader(sock.readable);

    // 1. Chào: hỗ trợ "không xác thực" (0) và "user/pass" (2)
    await w.write(new Uint8Array([5, 2, 0, 2]));
    const g = await rd.take(2);
    if (g[0] !== 5) throw new Error('Không phải proxy SOCKS5');
    if (g[1] === 2) {
      const us = enc.encode(proxy.user || ''), ps = enc.encode(proxy.pass || '');
      await w.write(new Uint8Array([1, us.length, ...us, ps.length, ...ps]));
      const a = await rd.take(2);
      if (a[1] !== 0) throw new Error('Proxy sai user/pass');
    } else if (g[1] !== 0) throw new Error('Proxy từ chối kiểu đăng nhập');

    // 2. Yêu cầu nối tới host:port (theo tên miền)
    const hb = enc.encode(u.hostname);
    await w.write(new Uint8Array([5, 1, 0, 3, hb.length, ...hb, port >> 8, port & 255]));
    const h = await rd.take(4);
    if (h[1] !== 0) throw new Error(`Proxy không nối được tới ${u.hostname} (mã ${h[1]})`);
    if (h[3] === 1) await rd.take(6);
    else if (h[3] === 4) await rd.take(18);
    else if (h[3] === 3) { const l = (await rd.take(1))[0]; await rd.take(l + 2); }
    w.releaseLock(); rd.release();

    // 3. Bật TLS tới máy chủ đích rồi gửi HTTP/1.1
    const tls = u.protocol === 'https:' ? sock.startTls({ expectedServerHostname: u.hostname }) : sock;
    const tw = tls.writable.getWriter();
    const bodyBytes = body == null ? null : enc.encode(typeof body === 'string' ? body : JSON.stringify(body));
    const hdr = {
      Host: u.hostname, Connection: 'close', 'Accept-Encoding': 'identity', Accept: '*/*', ...headers,
      ...(bodyBytes ? { 'Content-Length': String(bodyBytes.length) } : {}),
    };
    const head = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n` + Object.entries(hdr).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n';
    await tw.write(enc.encode(head));
    if (bodyBytes) await tw.write(bodyBytes);
    tw.releaseLock();

    // 4. Đọc hết phản hồi (máy chủ đóng kết nối vì Connection: close)
    const raw = new Uint8Array(await new Response(tls.readable).arrayBuffer());
    return parseHttp(raw);
  } finally {
    sock.close().catch(() => {});
  }
}

function parseHttp(raw) {
  let i = 0;
  for (; i < raw.length - 3; i++) if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) break;
  if (i >= raw.length - 3) throw new Error(`Phản hồi HTTP không hợp lệ (${raw.length} byte: ${dec.decode(raw.slice(0, 80)).replace(/[^\x20-\x7e]/g, '.')})`);
  const lines = dec.decode(raw.slice(0, i)).split('\r\n');
  const status = Number(lines[0].split(' ')[1]) || 0;
  const headers = {};
  for (const l of lines.slice(1)) { const k = l.indexOf(':'); if (k > 0) headers[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim(); }
  let body = raw.slice(i + 4);
  if (/chunked/i.test(headers['transfer-encoding'] || '')) body = dechunk(body);
  return { status, headers, text: dec.decode(body) };
}

function dechunk(b) {
  const parts = []; let p = 0;
  while (p < b.length) {
    let e = p; while (e < b.length - 1 && !(b[e] === 13 && b[e + 1] === 10)) e++;
    const size = parseInt(dec.decode(b.slice(p, e)).split(';')[0].trim(), 16);
    if (!size) break;
    parts.push(b.slice(e + 2, e + 2 + size));
    p = e + 2 + size + 2;
  }
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

// ---------- Quản lý danh sách proxy (KV "proxies") ----------
// Nhận: link t.me/socks?server=..&port=..&user=..&pass=.. · socks5://user:pass@host:port · host:port:user:pass
export function parseProxy(text) {
  const s = String(text || '').trim();
  let m = s.match(/[?&]server=([^&\s]+)/i);
  if (m) {
    const q = new URLSearchParams(s.slice(s.indexOf('?') + 1).split(/\s/)[0]);
    const host = q.get('server'), port = Number(q.get('port'));
    if (host && port) return { host, port, user: q.get('user') || '', pass: q.get('pass') || '' };
  }
  m = s.match(/socks5h?:\/\/(?:([^:@\s]+):([^@\s]+)@)?([\w.-]+):(\d+)/i);
  if (m) return { host: m[3], port: Number(m[4]), user: decodeURIComponent(m[1] || ''), pass: decodeURIComponent(m[2] || '') };
  m = s.match(/^([\w.-]+):(\d{2,5})(?::([^:\s]+):(\S+))?$/);
  if (m) return { host: m[1], port: Number(m[2]), user: m[3] || '', pass: m[4] || '' };
  return null;
}

export const proxyId = (p) => `${p.host}:${p.port}`;
export async function getProxies(env) { return (await env.KV.get('proxies', 'json')) || []; }
export async function saveProxies(env, list) { await env.KV.put('proxies', JSON.stringify(list)); }
