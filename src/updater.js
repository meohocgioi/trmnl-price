// Tự cập nhật code: mỗi 15 phút so commit mới nhất trên GitHub với phiên bản đang chạy;
// khác nhau → chạy workflow "Deploy Worker". /update làm ngay lập tức.
const REPO = (env) => env.GH_REPO || 'meohocgioi/trmnl-price';
const CHECK_EVERY = 15 * 60000;

const gh = (env, path, init = {}) =>
  fetch(`https://api.github.com/repos/${REPO(env)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json',
      'user-agent': 'trmnl-price-bot', 'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

export async function latestCommit(env) {
  const r = await gh(env, '/commits/main');
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
  const j = await r.json();
  return { sha: j.sha.slice(0, 7), msg: (j.commit?.message || '').split('\n')[0] };
}

export async function dispatchDeploy(env) {
  const r = await gh(env, '/actions/workflows/deploy.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
  if (r.status !== 204) throw new Error(`GitHub HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// Trả về { latest, current, deploying }
export async function checkUpdate(env, { force = false } = {}) {
  if (!env.GH_TOKEN) return { error: 'no GH_TOKEN' };
  const latest = await latestCommit(env);
  const current = env.VERSION || null;
  const isNew = latest.sha !== current;
  // Tránh deploy lặp cho cùng 1 commit (deploy mất ~1–2 phút)
  const pending = await env.KV.get('upd:dispatched');
  let deploying = false;
  if (force || (isNew && pending !== latest.sha)) {
    await dispatchDeploy(env);
    await env.KV.put('upd:dispatched', latest.sha, { expirationTtl: 3600 });
    deploying = true;
  }
  return { latest, current, isNew, deploying };
}

// Cron: kiểm tra 15 phút/lần
export async function autoUpdate(env) {
  if (!env.GH_TOKEN) return;
  const last = Number(await env.KV.get('upd:lastCheck')) || 0;
  if (Date.now() - last < CHECK_EVERY - 30000) return;
  await env.KV.put('upd:lastCheck', String(Date.now()));
  const r = await checkUpdate(env);
  if (r.deploying) console.log('auto update →', r.latest.sha, r.latest.msg);
}
