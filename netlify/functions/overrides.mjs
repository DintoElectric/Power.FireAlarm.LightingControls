// Shared, admin-editable layer stored in Netlify Blobs and merged on top of the
// static panels.json + drawings.json by the app. Everyone can GET it (statuses,
// circuit edits and J-box circuits are public); only a valid admin token may POST.
//
// POWER (original behavior, key 'data'):
//   GET  -> { status:{panel:{n:{live,at}}}, panelStatus:{panel:{live,at}},
//            circuits:{panel:{n:{desc,amps,poles}}}, edited:{panel:{by,at}},
//            jboxCircuits:{label:[ckt,...]} }
//   POST { action:'setStatus',      panel, n, live }                (admin)
//   POST { action:'setPanelStatus', panel, live }                   (admin)
//   POST { action:'setAllStatus',   panel, live, ns }               (admin)
//   POST { action:'editCircuit',    panel, n, desc, amps, poles }   (admin) — stamps edited{by,at}
//   POST { action:'setJboxCircuits', label, circuits:[..] }         (admin) — J-box editor screen
//
// FIRE ALARM / LIGHTING CONTROL (separate key per system, never touches Power data):
//   GET  ?system=firealarm|lighting -> { devices:{id:{done,at,by}}, runs:{id:{done,at,by}} }
//   POST { action:'setProgress', system, kind:'device'|'run', id, done }   (admin)
//        device done = installed, run done = pulled
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const KEY = 'data';
const EMPTY = { status: {}, circuits: {}, edited: {}, panelStatus: {}, jboxCircuits: {} };
const SYSTEMS = ['firealarm', 'lighting'];
const progressKey = (system) => `progress-${system}`;
const emptyProgress = () => ({ devices: {}, runs: {} });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Verify the HMAC token and return the admin's initials, or null if invalid.
// Token shape: `${who}.${exp}.${sig}`  (sig = HMAC(secret, `${who}.${exp}`)).
function tokenIdentity(token) {
  const SECRET = process.env.ADMIN_CODES || process.env.ADMIN_CODE || '';
  if (!SECRET || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [who, exp, sig] = parts;
  if (!exp || !sig || Date.now() > Number(exp)) return null;
  const good = crypto.createHmac('sha256', SECRET).update(`${who}.${exp}`).digest('hex');
  const a = Buffer.from(sig); const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return who || 'ADMIN';
}

// MM/DD/YYYY to match the "DATE TYPED" field on the schedules.
function today() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

// normalize a circuits value (array or comma string) -> array of trimmed strings
function toCircuits(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

export default async (req) => {
  const store = getStore({ name: 'asbuilt-overrides', consistency: req.method === 'POST' ? 'strong' : 'eventual' });

  if (req.method === 'GET') {
    const system = new URL(req.url).searchParams.get('system');
    if (system) {
      if (!SYSTEMS.includes(system)) return json({ ok: false, error: 'bad system' }, 400);
      const prog = (await store.get(progressKey(system), { type: 'json' })) || emptyProgress();
      if (!prog.devices) prog.devices = {};
      if (!prog.runs) prog.runs = {};
      return json(prog);
    }
    const data = (await store.get(KEY, { type: 'json' })) || EMPTY;
    if (!data.jboxCircuits) data.jboxCircuits = {};
    return json(data);
  }

  if (req.method === 'POST') {
    const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const who = tokenIdentity(auth);
    if (who === null) return json({ ok: false, error: 'unauthorized' }, 401);

    let body = {};
    try { body = await req.json(); } catch { return json({ ok: false, error: 'bad body' }, 400); }

    // ---- Fire Alarm / Lighting Control progress (own key; Power data untouched) ----
    if (body.action === 'setProgress') {
      const system = String(body.system || '');
      if (!SYSTEMS.includes(system)) return json({ ok: false, error: 'bad system' }, 400);
      const kind = body.kind === 'device' ? 'devices' : body.kind === 'run' ? 'runs' : null;
      if (!kind) return json({ ok: false, error: 'bad kind' }, 400);
      const id = String(body.id || '');
      if (!id || id.length > 120) return json({ ok: false, error: 'bad id' }, 400);

      const prog = (await store.get(progressKey(system), { type: 'json' })) || emptyProgress();
      prog.devices = prog.devices || {}; prog.runs = prog.runs || {};
      if (body.done) prog[kind][id] = { done: true, at: new Date().toISOString(), by: who };
      else delete prog[kind][id];
      await store.setJSON(progressKey(system), prog);
      return json({ ok: true, data: prog });
    }

    // ---- Power (original behavior) ----
    const data = (await store.get(KEY, { type: 'json' })) || structuredClone(EMPTY);
    data.status = data.status || {}; data.circuits = data.circuits || {}; data.edited = data.edited || {};
    data.panelStatus = data.panelStatus || {}; data.jboxCircuits = data.jboxCircuits || {};

    if (body.action === 'setJboxCircuits') {
      const label = String(body.label || '');
      if (!label) return json({ ok: false, error: 'no label' }, 400);
      const ckts = toCircuits(body.circuits);
      if (ckts.length) data.jboxCircuits[label] = ckts;
      else delete data.jboxCircuits[label]; // empty = clear the override (falls back to static)
      await store.setJSON(KEY, data);
      return json({ ok: true, data });
    }

    const panel = String(body.panel || '');
    if (!panel) return json({ ok: false, error: 'no panel' }, 400);

    if (data.status[panel] && typeof data.status[panel].live === 'boolean') data.status[panel] = {};

    if (body.action === 'setPanelStatus') {
      data.panelStatus[panel] = { live: !!body.live, at: new Date().toISOString(), by: who };
    } else if (body.action === 'setStatus') {
      data.status[panel] = data.status[panel] || {};
      data.status[panel][String(body.n)] = { live: !!body.live, at: new Date().toISOString(), by: who };
    } else if (body.action === 'setAllStatus') {
      data.status[panel] = data.status[panel] || {};
      const at = new Date().toISOString();
      (Array.isArray(body.ns) ? body.ns : []).forEach((n) => { data.status[panel][String(n)] = { live: !!body.live, at, by: who }; });
    } else if (body.action === 'editCircuit') {
      const n = String(body.n);
      data.circuits[panel] = data.circuits[panel] || {};
      data.circuits[panel][n] = {
        desc: body.desc != null ? String(body.desc) : '',
        amps: body.amps === '' || body.amps == null ? '' : Number(body.amps),
        poles: body.poles === '' || body.poles == null ? '' : Number(body.poles),
      };
      data.edited[panel] = { by: who, at: today() };
    } else {
      return json({ ok: false, error: 'bad action' }, 400);
    }

    await store.setJSON(KEY, data);
    return json({ ok: true, data });
  }

  return json({ ok: false }, 405);
};
