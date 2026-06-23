import https from 'node:https';
const FLY_API = 'api.machines.dev';
const APP   = () => process.env.FLY_APP_NAME  || 'magofonte';
const TOKEN = () => process.env.FLY_API_TOKEN || '';
const SIZE_MAP = { dev:'shared-cpu-1x', light:'shared-cpu-2x', standard:'performance-1x', performance:'performance-2x', heavy:'performance-4x' };

async function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: FLY_API, port: 443, path: `/v1/apps/${APP()}${p}`, method,
      headers: { 'Authorization': `Bearer ${TOKEN()}`, 'Content-Type': 'application/json',
                 ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
    }, res => { let s=''; res.on('data',d=>s+=d); res.on('end',()=>{ try{resolve(JSON.parse(s))}catch{resolve(s)} }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

export default {
  async list() {
    const ms = await req('GET', '/machines');
    return (ms||[]).map(m => ({ id:m.id, name:m.name, region:m.region, status:m.state, image:m.config?.image,
      size: Object.keys(SIZE_MAP).find(k=>SIZE_MAP[k]===m.config?.guest?.cpu_kind)||'standard',
      url: m.private_ip ? `http://${m.private_ip}:3000` : null, created_at: m.created_at }));
  },
  async create({ name, region, image, size, stratumPort, apiPort, env, rewardAddress }) {
    const m = await req('POST', '/machines', {
      name, region: region||'ord',
      config: {
        image: image||'registry.fly.io/magofonte:latest',
        guest: { cpu_kind: SIZE_MAP[size]||SIZE_MAP.standard, cpus:1, memory_mb:512 },
        services: [
          { ports:[{ port:stratumPort||3333, handlers:['tcp'] }], protocol:'tcp', internal_port:stratumPort||3333 },
          { ports:[{ port:443, handlers:['tls','http'] }], protocol:'tcp', internal_port:apiPort||3000 },
        ],
        env: { REWARD_ADDRESS: rewardAddress||'',
          ...(env ? Object.fromEntries(env.split('\n').filter(Boolean).map(l=>l.split('='))) : {}) }
      }
    });
    return { id:m.id, name:m.name, region:m.region, status:m.state, image, size, url:null };
  },
  async restart(id) { return req('POST',   `/machines/${id}/restart`); },
  async destroy(id) { await req('POST',   `/machines/${id}/stop`); return req('DELETE', `/machines/${id}`); }
};
