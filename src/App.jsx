import { useEffect, useMemo, useState } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import DrawingViewer from './DrawingViewer';
import JboxEditor from './JboxEditor';
import FireAlarmAdmin from './FireAlarmAdmin';
import FireAlarmPage from './FireAlarmPage';
import {
  floorOf, sheetFloor, linkedSheets, boxPlacements, distinctLabels,
  breaker, isSpare, sourceLabel, FLOOR_ORDER, naturalSort,
} from './lib/schedule';

const FN_LOGIN = '/.netlify/functions/admin-login';
const FN_OVR = '/.netlify/functions/overrides';

const DISCLAIMER =
  'QUALIFIED PERSONNEL ONLY. Reference only — not a safe-to-work determination. Live/dead indications and all data shown may be inaccurate or out of date; never rely on this application to determine whether a panel or circuit is energized. Only qualified persons, as defined by NFPA 70E, may examine, adjust, service, or work on this equipment. Always establish an electrically safe work condition per NFPA 70E — apply lockout/tagout and verify the absence of voltage — before working. Paul Dinto Electrical Contractors assumes no liability for any reliance on this application.';

// QR label paths: /p/<panel> = Power, /fa/<panel> = Fire Alarm, /lc/<panel> = Lighting Control
function systemFromPath(pathname) {
  if (/^\/fa(\/|$)/.test(pathname)) return 'firealarm';
  if (/^\/lc(\/|$)/.test(pathname)) return 'lighting';
  return 'power';
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function panelFromSlug(slug, panels) {
  if (!slug) return null;
  const names = new Set(panels.map((p) => p.panel));
  const decoded = decodeURIComponent(slug);
  if (names.has(decoded)) return decoded;
  const cut = decoded.indexOf('-');
  if (cut > 0) { const rest = decoded.slice(cut + 1); if (names.has(rest)) return rest; }
  return null;
}

function buildScheduleRows(circuits) {
  const byN = {}; circuits.forEach((c) => { byN[c.n] = c; });
  const maxN = circuits.length ? Math.max(...circuits.map((c) => c.n)) : 0;
  const nRows = Math.ceil(maxN / 2);
  const side = (first) => {
    const cells = {}; let cn = first;
    while (cn <= maxN) {
      const c = byN[cn];
      if (c) {
        const p = c.poles || 1;
        cells[cn] = { kind: 'cell', span: p, c };
        for (let k = 1; k < p; k++) cells[cn + 2 * k] = { kind: 'covered' };
        cn += 2 * p;
      } else { if (!cells[cn]) cells[cn] = { kind: 'empty' }; cn += 2; }
    }
    return cells;
  };
  const L = side(1), R = side(2);
  const rows = [];
  for (let i = 0; i < nRows; i++) rows.push({ lc: 2 * i + 1, l: L[2 * i + 1], rc: 2 * i + 2, r: R[2 * i + 2] });
  return { rows, maxN };
}

function expandSide(circuits) {
  const byN = {}; circuits.forEach((c) => { byN[c.n] = c; });
  const out = []; const covered = new Set();
  circuits.map((c) => c.n).sort((a, b) => a - b).forEach((n) => {
    if (covered.has(n)) return;
    const c = byN[n]; const p = c.poles || 1;
    for (let k = 0; k < p; k++) {
      const dn = n + 2 * k;
      out.push({ dn, c, primary: k === 0 });
      if (k > 0) covered.add(dn);
    }
  });
  return out.sort((a, b) => a.dn - b.dn);
}

function ScheduleCells({ cell }) {
  if (!cell || cell.kind === 'empty') return (<><td></td><td></td><td className="d"></td></>);
  if (cell.kind === 'covered') return null;
  const c = cell.c;
  return (<><td rowSpan={cell.span}>{c.poles || 1}</td><td rowSpan={cell.span}>{c.amps || ''}</td><td rowSpan={cell.span} className="d">{c.desc}</td></>);
}

const SYSTEMS = [
  { id: 'power', label: 'Power' },
  { id: 'firealarm', label: 'Fire Alarm' },
  { id: 'lighting', label: 'Lighting Control' },
];

function SystemSwitch({ system, onChange }) {
  return (
    <div className="floor-chips" style={{ margin: 0 }}>
      {SYSTEMS.map((s) => (
        <button key={s.id} className="fbtn" data-on={s.id === system ? '1' : '0'} onClick={() => onChange(s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const { slug } = useParams();
  const loc = useLocation();
  const startSystem = systemFromPath(loc.pathname);
  const [rawPanels, setRawPanels] = useState([]);
  const [sheets, setSheets] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [locations, setLocations] = useState({});

  const [overrides, setOverrides] = useState({ status: {}, circuits: {}, edited: {}, panelStatus: {}, jboxCircuits: {} });
  const [token, setToken] = useState(() => sessionStorage.getItem('adminToken') || '');
  const admin = !!token;
  const [loginOpen, setLoginOpen] = useState(false);
  const [code, setCode] = useState('');
  const [loginErr, setLoginErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState({});
  const [savingN, setSavingN] = useState(null);
  const [statusBusyN, setStatusBusyN] = useState(null);

  const [sel, setSel] = useState(null);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(null);
  const [selCircuit, setSelCircuit] = useState(null);
  const [floor, setFloor] = useState('All');
  const [sheetId, setSheetId] = useState(null);
  const [full, setFull] = useState(false);
  const [collapsed, setCollapsed] = useState(!!slug && startSystem === 'power');
  const [jboxEdit, setJboxEdit] = useState(false);
  const [discShow, setDiscShow] = useState(true);
  const [discAck, setDiscAck] = useState(false);
  const [system, setSystem] = useState(startSystem);
  const [faEdit, setFaEdit] = useState(false);     // "Edit Loops" editor open (Fire Alarm / Lighting)
  const [faRefresh, setFaRefresh] = useState(0);   // bumped when the editor closes so the main page reloads its marks

  const applyOverrides = (d) => setOverrides({
    status: d.status || {}, circuits: d.circuits || {}, edited: d.edited || {},
    panelStatus: d.panelStatus || {}, jboxCircuits: d.jboxCircuits || {},
  });

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch('/data/panels.json').then((r) => r.json()),
      fetch('/data/drawings.json').then((r) => r.json()),
      fetch('/data/panel_locations.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]).then(([pd, dd, loc2]) => {
      if (!alive) return;
      setRawPanels(pd.panels); setSheets(dd.sheets); setLocations(loc2 || {}); setLoaded(true);
    }).catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  const refreshOverrides = () => {
    fetch(FN_OVR).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) applyOverrides(d); }).catch(() => { /* backend not up yet */ });
  };
  useEffect(() => {
    refreshOverrides();
    const onFocus = () => refreshOverrides();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { if (jboxEdit) setJboxEdit(false); else if (full) setFull(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, jboxEdit]);

  const panels = useMemo(() => rawPanels.map((p) => {
    const ce = overrides.circuits[p.panel];
    const ed = overrides.edited[p.panel];
    if (!ce && !ed) return p;
    const circuits = ce ? p.circuits.map((c) => {
      const o = ce[String(c.n)];
      return o ? { ...c, desc: o.desc, amps: o.amps === '' ? '' : o.amps, poles: o.poles === '' ? '' : o.poles } : c;
    }) : p.circuits;
    const edAt = ed ? (typeof ed === 'string' ? ed : ed.at) : null;
    const edBy = ed && typeof ed === 'object' ? ed.by : null;
    const meta = edAt ? { ...(p.meta || {}), date: edAt, editedBy: edBy } : p.meta;
    return { ...p, circuits, meta };
  }), [rawPanels, overrides]);

  const mergedSheets = useMemo(() => {
    const jc = overrides.jboxCircuits || {};
    if (!Object.keys(jc).length) return sheets;
    return sheets.map((s) => ({ ...s, jboxes: s.jboxes.map((b) => (jc[b.label] ? { ...b, circuits: jc[b.label] } : b)) }));
  }, [sheets, overrides.jboxCircuits]);

  const circuitLive = (name, n) => { const s = overrides.status[name]; return !!(s && s[String(n)] && s[String(n)].live); };
  const anyCircuitLive = (name) => { const s = overrides.status[name]; return !!(s && Object.values(s).some((v) => v && v.live)); };
  const panelLive = (name) => { const s = overrides.panelStatus[name]; return !!(s && s.live); };
  const panelAnyLive = (name) => panelLive(name) || anyCircuitLive(name);

  const totalCircuits = useMemo(() => panels.reduce((s, p) => s + p.circuits.length, 0), [panels]);
  const inFloor = (p) => floor === 'All' || floorOf(p.panel) === floor;
  const presentFloors = FLOOR_ORDER.filter((g) => panels.some((p) => floorOf(p.panel) === g));

  const panel = panels.find((p) => p.panel === sel) || null;
  const linked = linkedSheets(mergedSheets, sel);
  const sheet = linked.find((s) => s.id === sheetId) || linked[0] || null;

  useEffect(() => {
    if (!panels.length || sel) return;
    setSel(panelFromSlug(slug, panels) || panels[0].panel);
  }, [panels, slug, sel]);

  const searching = q.trim().length >= 2;
  const results = useMemo(() => {
    if (!searching) return [];
    const needle = q.trim().toUpperCase();
    const out = [];
    panels.filter(inFloor).forEach((p) => p.circuits.forEach((c) => {
      if ((c.desc || '').toUpperCase().includes(needle) || p.panel.toUpperCase().includes(needle)) {
        out.push({ panel: p.panel, n: c.n, desc: c.desc, bk: breaker(c) });
      }
    }));
    return out;
  }, [q, searching, panels, floor]);

  const selectPanel = (name) => { setSel(name); setQ(''); setPick(null); setSelCircuit(null); setSheetId(null); setEdits({}); if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) setCollapsed(true); };
  const openResult = (r) => {
    setSel(r.panel); setQ(''); setSheetId(null);
    setPick({ tag: r.panel + ' · ckt ' + r.n, desc: r.desc, bk: r.bk });
    setSelCircuit(r.n != null ? String(r.n) : null);
  };
  const toggleCircuitN = (dn, c) => {
    const cn = String(dn);
    if (selCircuit === cn) { setSelCircuit(null); setPick(null); }
    else { setSelCircuit(cn); setPick({ tag: panel.panel + ' · ckt ' + dn, desc: c.desc, bk: breaker(c) }); }
  };

  const doLogin = async () => {
    setBusy(true); setLoginErr('');
    try {
      const r = await fetch(FN_LOGIN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      const d = await r.json();
      if (d.ok && d.token) { sessionStorage.setItem('adminToken', d.token); setToken(d.token); setLoginOpen(false); setCode(''); }
      else setLoginErr(d.error || 'Wrong code');
    } catch { setLoginErr('Login unavailable — is the backend deployed?'); }
    setBusy(false);
  };
  const logout = () => { sessionStorage.removeItem('adminToken'); setToken(''); };
  const setCircuitStatus = async (c, live) => {
    if (!admin || !panel) return;
    setStatusBusyN(c.n);
    try {
      const r = await fetch(FN_OVR, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'setStatus', panel: panel.panel, n: c.n, live }),
      });
      if (r.status === 401) { logout(); setLoginErr('Session expired — log in again.'); }
      const d = await r.json().catch(() => null);
      if (d && d.data) applyOverrides(d.data);
    } catch { /* ignore */ }
    setStatusBusyN(null);
  };
  const setAllStatus = async (live) => {
    if (!admin || !panel) return;
    setBusy(true);
    try {
      const r = await fetch(FN_OVR, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'setAllStatus', panel: panel.panel, live, ns: panel.circuits.map((c) => c.n) }),
      });
      if (r.status === 401) { logout(); setLoginErr('Session expired — log in again.'); }
      const d = await r.json().catch(() => null);
      if (d && d.data) applyOverrides(d.data);
    } catch { /* ignore */ }
    setBusy(false);
  };
  const setPanelStatus = async (live) => {
    if (!admin || !panel) return;
    setBusy(true);
    try {
      const r = await fetch(FN_OVR, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'setPanelStatus', panel: panel.panel, live }),
      });
      if (r.status === 401) { logout(); setLoginErr('Session expired — log in again.'); }
      const d = await r.json().catch(() => null);
      if (d && d.data) applyOverrides(d.data);
    } catch { /* ignore */ }
    setBusy(false);
  };

  const setField = (c, field, value) => setEdits((prev) => {
    const base = prev[c.n] || { desc: c.desc || '', amps: c.amps ?? '', poles: c.poles ?? '' };
    return { ...prev, [c.n]: { ...base, [field]: value } };
  });
  const saveCircuit = async (c) => {
    if (!admin || !panel) return;
    const v = edits[c.n]; if (!v) return;
    setSavingN(c.n);
    try {
      const r = await fetch(FN_OVR, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'editCircuit', panel: panel.panel, n: c.n, desc: v.desc, amps: v.amps, poles: v.poles }),
      });
      if (r.status === 401) { logout(); setLoginErr('Session expired — log in again.'); }
      const d = await r.json().catch(() => null);
      if (d && d.data) {
        applyOverrides(d.data);
        setEdits((prev) => { const n = { ...prev }; delete n[c.n]; return n; });
      }
    } catch { /* ignore */ }
    setSavingN(null);
  };

  const saveJbox = async (label, circuits) => {
    if (!admin) return;
    const r = await fetch(FN_OVR, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: 'setJboxCircuits', label, circuits }),
    });
    if (r.status === 401) { logout(); setLoginErr('Session expired — log in again.'); throw new Error('unauthorized'); }
    const d = await r.json().catch(() => null);
    if (d && d.data) applyOverrides(d.data);
    else throw new Error('save failed');
  };

  const placements = boxPlacements(sheet, sel);
  const hitLabels = distinctLabels(placements).sort(naturalSort);
  const circuitLabels = (sheet && selCircuit)
    ? distinctLabels(placements.filter((b) => (b.circuits || []).includes(selCircuit))).sort(naturalSort)
    : [];

  const oddRows = panel ? expandSide(panel.circuits.filter((c) => c.n % 2 === 1)) : [];
  const evenRows = panel ? expandSide(panel.circuits.filter((c) => c.n % 2 === 0)) : [];
  const spareCount = panel ? panel.circuits.filter(isSpare).length : 0;
  const schedule = panel ? buildScheduleRows(panel.circuits) : { rows: [], maxN: 0 };

  const ensureQR = () => new Promise((resolve) => {
    if (window.QRCode) return resolve();
    const el = document.createElement('script');
    el.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    el.onload = resolve; el.onerror = resolve; document.head.appendChild(el);
  });
  const printSchedule = async () => {
    if (!panel) return;
    await ensureQR();
    const holder = document.getElementById('print-qr');
    if (holder && window.QRCode) {
      holder.innerHTML = '';
      new window.QRCode(holder, { text: window.location.origin + '/p/' + encodeURIComponent(panel.panel), width: 92, height: 92, correctLevel: window.QRCode.CorrectLevel.M });
    }
    setTimeout(() => window.print(), 250);
  };

  const gridCols = full
    ? 'minmax(0,1fr)'
    : collapsed
      ? (admin ? '380px minmax(0,1fr)' : '300px minmax(0,1fr)')
      : (admin ? '196px 380px minmax(0,1fr)' : '196px 300px minmax(0,1fr)');
  const liveCount = panel ? panel.circuits.filter((c) => circuitLive(panel.panel, c.n)).length : 0;
  const pExplicit = panel ? panelLive(panel.panel) : false;
  const plive = panel ? (pExplicit || anyCircuitLive(panel.panel)) : false; // any live circuit forces panel live
  const location = sel ? locations[sel] : null;
  const liveMap = {};
  if (panel) {
    const byN = {}; panel.circuits.forEach((c) => { byN[c.n] = c; });
    const covered = new Set();
    panel.circuits.map((c) => c.n).sort((a, b) => a - b).forEach((n) => {
      if (covered.has(n)) return;
      const c = byN[n]; const pn = c.poles || 1; const lv = circuitLive(panel.panel, n);
      for (let k = 0; k < pn; k++) { liveMap[n + 2 * k] = lv; if (k > 0) covered.add(n + 2 * k); }
    });
  }
  const cktColor = (n) => (n in liveMap ? (liveMap[n] ? '#b3202f' : '#137a2e') : undefined); // live = red, dead = green

  const closeFaEdit = () => { setFaEdit(false); setFaRefresh((n) => n + 1); };
  const scanPanel = slug && system === startSystem ? safeDecode(slug) : null;

  return (
    <>
    <div className="app">
      <header className="topbar">
        {!full && (
          <button className="fbtn collapse-btn" style={system === 'power' ? undefined : { display: 'none' }} data-on={collapsed ? '0' : '1'} onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? 'Show panel list' : 'Hide panel list'} aria-label="Toggle panel list">☰ Panels</button>
        )}
        <span className="wordmark">Dinto <span className="wordmark-2">As-Builts</span></span>
        <span className="tag tag-neutral">Public link · no sign-in</span>
        <SystemSwitch system={system} onChange={(s) => { setSystem(s); setFaEdit(false); }} />
        <input
          className="input search" style={system === 'power' ? undefined : { display: 'none' }}
          placeholder={panels.length ? `Search ${totalCircuits.toLocaleString()} circuits — try REFRIGERATOR, RTU, 324A` : 'Search circuits'}
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search circuits"
        />
        {!loaded && <span className="status">loading schedules…</span>}
        <div className="admin-box">
          {admin ? (
            <>
              {system === 'power' && <button className="btn btn-secondary" onClick={() => setJboxEdit(true)}>Edit J-boxes</button>}
              {system !== 'power' && <button className="btn btn-secondary" onClick={() => setFaEdit(true)}>Edit Loops</button>}
              <span className="tag tag-accent">Admin</span>
              <button className="btn btn-ghost" onClick={logout}>Log out</button>
            </>
          ) : loginOpen ? (
            <div className="admin-login">
              <input className="input" style={{ width: 110 }} type="password" inputMode="numeric" placeholder="Admin code"
                value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doLogin()} autoFocus />
              <button className="btn btn-primary" onClick={doLogin} disabled={busy}>Enter</button>
              <button className="btn btn-ghost" onClick={() => { setLoginOpen(false); setLoginErr(''); }}>Cancel</button>
              {loginErr && <span className="status" style={{ color: '#e5484d' }}>{loginErr}</span>}
            </div>
          ) : (
            <button className="btn btn-secondary" onClick={() => setLoginOpen(true)}>Admin</button>
          )}
        </div>
      </header>

      {system !== 'power' ? (
        <FireAlarmPage system={system} initialPanel={scanPanel} refreshKey={faRefresh} />
      ) : (
      <div className="grid" style={{ gridTemplateColumns: gridCols }}>
        {!full && !collapsed && (
          <aside className="col-panels scrolly">
            <div className="eyebrow" style={{ marginBottom: 10 }}>Panels · {panels.filter(inFloor).length}</div>
            <div className="floor-chips">
              {['All', ...presentFloors].map((f) => (
                <button key={f} className="fbtn" data-on={f === floor ? '1' : '0'} onClick={() => setFloor(f)}>
                  {f === 'All' ? 'All' : f.replace('Level ', 'L')}
                </button>
              ))}
            </div>
            {FLOOR_ORDER.filter((g) => floor === 'All' || g === floor).map((g) => {
              const items = panels.filter((p) => floorOf(p.panel) === g);
              if (!items.length) return null;
              return (
                <div key={g} className="floor-group">
                  <div className="floor-head">{g}</div>
                  {items.map((p) => (
                    <button key={p.panel} className="pbtn" data-on={p.panel === sel ? '1' : '0'} onClick={() => selectPanel(p.panel)}>
                      <span className={'lamp ' + (panelAnyLive(p.panel) ? 'on' : 'off')} title={panelAnyLive(p.panel) ? 'Has live circuits' : 'No live circuits'} />
                      <span className="mono" style={{ fontSize: 13 }}>{p.panel}</span>
                      <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-muted)' }}>{p.circuits.length}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </aside>
        )}

        {!full && (
          <section className="col-schedule scrolly">
            {searching ? (
              <div>
                <div className="eyebrow">Results for “{q.trim()}” · {results.length > 60 ? `${results.length} (showing 60)` : results.length}</div>
                <div className="result-list">
                  {results.slice(0, 60).map((r, i) => (
                    <button key={i} className="result" onClick={() => openResult(r)}>
                      <span className="mono" style={{ fontSize: 13, color: 'var(--color-accent)' }}>{r.panel} · {r.n ?? '—'}</span>
                      <span style={{ fontSize: 14 }}>{r.desc}</span>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--color-text-2)', textAlign: 'right' }}>{r.bk}</span>
                    </button>
                  ))}
                  {!results.length && <div className="status" style={{ marginTop: 8 }}>No circuit or panel matches “{q.trim()}”.</div>}
                </div>
              </div>
            ) : panel ? (
              <div>
                <div className="scanned"><span className="scanned-dot" />Scanned · panel label</div>
                <div className="mono designation">{panel.panel}</div>
                <div className="source-line">{sourceLabel(panel)} · {panel.circuits.length} circuits scheduled · {spareCount} spare</div>
                {location && <div style={{ fontSize: 12.5, color: 'var(--color-text-2)', marginTop: 8 }}><span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>Location</span> · {location}</div>}

                <div className={'status-summary ' + (plive ? 'has-live' : 'none-live')}>
                  <span className={'lamp big ' + (plive ? 'on' : 'off')} />
                  <span className="status-text">Panel power {plive ? '— ON (energized)' : '— off'}</span>
                  {admin && (
                    <span className="bulk">
                      <button className="btn btn-secondary" disabled={busy} onClick={() => setPanelStatus(!pExplicit)}>{pExplicit ? 'Mark panel dead' : 'Mark panel live'}</button>
                    </span>
                  )}
                </div>

                <div className={'status-summary ' + (liveCount > 0 ? 'has-live' : 'none-live')}>
                  <span className={'lamp big ' + (liveCount > 0 ? 'on' : 'off')} />
                  <span className="status-text">{liveCount} of {panel.circuits.length} circuits marked live</span>
                </div>

                <div style={{ marginTop: 12 }}><button className="btn btn-secondary" onClick={printSchedule}>Export / print schedule (PDF)</button></div>

                {hitLabels.length > 0 && (
                  <div className="jbox-block">
                    <div className="eyebrow" style={{ marginBottom: 7 }}>J-boxes fed from this panel · {hitLabels.length}</div>
                    <div className="mono jbox-list scrolly">{hitLabels.map((label) => <span key={label}>{label}</span>)}</div>
                  </div>
                )}

                {pick && (
                  <div className="card elev-sm trace-card">
                    <div className="card-kicker">{pick.tag}{selCircuit ? ' · filtering boxes' : ' · traced'}</div>
                    <div style={{ fontSize: 14 }}>{pick.desc}</div>
                    <div className="mono" style={{ fontSize: 12, color: 'var(--color-text-2)' }}>{pick.bk}</div>
                    {selCircuit && (
                      <div style={{ fontSize: 12.5, color: 'var(--color-text-2)' }}>
                        {circuitLabels.length
                          ? `${circuitLabels.length} J-box${circuitLabels.length === 1 ? '' : 'es'} on circuit ${selCircuit}${sheet ? ' (this sheet)' : ''} highlighted.`
                          : `No J-box on this sheet carries circuit ${selCircuit}${placements.some((b) => b.circuits) ? '.' : ' — circuit data not entered for this panel yet.'}`}
                      </div>
                    )}
                    <div><button className="btn btn-ghost" onClick={() => { setPick(null); setSelCircuit(null); }}>{selCircuit ? 'Clear circuit filter' : 'Clear trace'}</button></div>
                  </div>
                )}

                {admin && <div className="edit-hint">Admin — click a lamp to flip that circuit live/dead; edit description / amps / poles and Save. Set a circuit's <b>poles</b> to 2 or 3 to join it with the next same-side circuits; set it back to 1 to split them to unused. Multi-pole breakers share one lamp.</div>}
                <div className="ckt-cols">
                  {[oddRows, evenRows].map((rows, ci) => (
                    <div key={ci}>
                      {admin ? (
                        <div className="ehd"><span /><span>Ckt</span><span>Description</span><span>A</span><span>P</span><span /></div>
                      ) : (
                        <div className="chd"><span /><span>Ckt</span><span>Description</span><span style={{ textAlign: 'right' }}>Breaker</span></div>
                      )}
                      {rows.map((d) => {
                        const c = d.c; const dn = d.dn;
                        const spare = isSpare(c);
                        const on = selCircuit === String(dn);
                        const clive = circuitLive(panel.panel, c.n);
                        const lampBtn = (
                          <button className="lamp-tog" disabled={statusBusyN === c.n} title={clive ? 'Live — click to mark dead' : 'Dead — click to mark live'} onClick={() => setCircuitStatus(c, !clive)}><span className={'lamp ' + (clive ? 'on' : 'off')} /></button>
                        );
                        if (admin) {
                          if (!d.primary) {
                            return (
                              <div className="erow covered" key={dn}>
                                {lampBtn}
                                <button className="erow-ckt" data-on={on ? '1' : '0'} onClick={() => toggleCircuitN(dn, c)}>{dn}</button>
                                <span className="cont" style={{ gridColumn: 'span 4' }}>↳ {c.desc}</span>
                              </div>
                            );
                          }
                          const e = edits[c.n];
                          const dv = e ? e.desc : (c.desc || '');
                          const av = e ? e.amps : (c.amps ?? '');
                          const pv = e ? e.poles : (c.poles ?? '');
                          const dirty = e && (String(dv) !== String(c.desc || '') || String(av) !== String(c.amps ?? '') || String(pv) !== String(c.poles ?? ''));
                          return (
                            <div className="erow" key={dn}>
                              {lampBtn}
                              <button className="erow-ckt" data-on={on ? '1' : '0'} onClick={() => toggleCircuitN(dn, c)} title="Highlight J-boxes on this circuit">{dn}</button>
                              <input className="einput" value={dv} placeholder="description" onChange={(ev) => setField(c, 'desc', ev.target.value)} />
                              <input className="einput num" value={av} inputMode="numeric" placeholder="A" onChange={(ev) => setField(c, 'amps', ev.target.value)} />
                              <input className="einput num" value={pv} inputMode="numeric" placeholder="P" onChange={(ev) => setField(c, 'poles', ev.target.value)} />
                              {dirty ? <button className="btn btn-primary esave" disabled={savingN === c.n} onClick={() => saveCircuit(c)}>{savingN === c.n ? '…' : 'Save'}</button> : <span />}
                            </div>
                          );
                        }
                        if (!d.primary) {
                          return (
                            <button key={dn} className="crow covered" onClick={() => toggleCircuitN(dn, c)}
                              style={on ? { background: 'var(--color-surface)', boxShadow: 'inset 0 0 0 1px var(--color-accent)' } : undefined}>
                              <span className={'lamp ' + (clive ? 'on' : 'off')} title={clive ? 'Live' : 'Dead'} />
                              <span className="mono" style={{ fontSize: 13, color: 'var(--color-muted)' }}>{dn}</span>
                              <span className="cont" style={{ gridColumn: 'span 2', fontSize: 13 }}>↳ {c.desc}</span>
                            </button>
                          );
                        }
                        return (
                          <button key={dn} className="crow" onClick={() => toggleCircuitN(dn, c)}
                            style={on ? { background: 'var(--color-surface)', boxShadow: 'inset 0 0 0 1px var(--color-accent)' } : undefined}>
                            <span className={'lamp ' + (clive ? 'on' : 'off')} title={clive ? 'Live' : 'Dead'} />
                            <span className="mono" style={{ fontSize: 13, color: spare ? 'var(--color-faint)' : 'var(--color-accent)' }}>{dn}</span>
                            <span style={{ fontSize: 13.5, color: spare ? 'var(--color-muted)' : 'var(--color-text)' }}>{c.desc}</span>
                            <span className="mono" style={{ fontSize: 12, textAlign: 'right', color: 'var(--color-text-2)' }}>{breaker(c)}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="status" style={{ marginTop: 20 }}>{loaded ? 'Select a panel.' : 'Loading…'}</div>
            )}
          </section>
        )}

        <DrawingViewer
          sheet={sheet} panel={sel} selCircuit={selCircuit} linked={linked}
          sheetId={sheet ? sheet.id : null} onPickSheet={setSheetId} location={location}
          full={full} onToggleFull={() => setFull((v) => !v)} circuitLive={circuitLive}
        />
      </div>
      )}
    </div>

    {/* Safety disclaimer — full-screen acknowledgment gate on load, then a re-read bubble */}
    {discShow && (
      <div className="disc-modal" role="dialog" aria-modal="true" onClick={discAck ? () => setDiscShow(false) : undefined}>
        <div className="disc-card scrolly" onClick={(e) => e.stopPropagation()}>
          <div className="disc-title">Safety Notice — Read Before Use</div>
          <div className="disc-text">{DISCLAIMER}</div>
          <div className="disc-actions">
            {discAck
              ? <button className="btn btn-secondary" onClick={() => setDiscShow(false)}>Close</button>
              : <button className="btn btn-primary disc-ack" onClick={() => { setDiscAck(true); setDiscShow(false); }}>I acknowledge</button>}
          </div>
        </div>
      </div>
    )}
    {discAck && !discShow && (
      <button className="disc-bubble" onClick={() => setDiscShow(true)} title="Read the safety notice again">Reference only — safety notice</button>
    )}

    {jboxEdit && admin && (
      <JboxEditor sheets={mergedSheets} onSave={saveJbox} onClose={() => setJboxEdit(false)} />
    )}

    {faEdit && admin && system !== 'power' && (
      <FireAlarmAdmin
        system={system} admin={admin} token={token} onUnauthorized={logout}
        initialPanel={scanPanel} onClose={closeFaEdit}
      />
    )}

    {system === 'power' && panel && !jboxEdit && (
      <div className="print-schedule">
        <div className="ps-head">
          <img className="ps-logo" src="/dinto-logo.png" alt="Dinto Electrical Contractors" />
          <div className="ps-title">PANEL: {panel.panel}</div>
          <div className="ps-meta">
            <div>PANEL LOCATION: {panel.meta ? panel.meta.location : ''}</div>
            <div>DATE TYPED: {panel.meta ? panel.meta.date : ''}{panel.meta && panel.meta.editedBy ? ` (${panel.meta.editedBy})` : ''}</div>
            <div className="sp">VOLTAGE:&nbsp; {panel.meta ? panel.meta.voltage : ''}</div>
            <div>PH/WIRE:&nbsp; {panel.meta ? panel.meta.phwire : ''}</div>
            <div>FED FROM: {panel.meta ? panel.meta.fedfrom : ''}</div>
          </div>
          <div id="print-qr" className="ps-qr" />
        </div>
        <table className="ps-table">
          <colgroup>
            <col style={{ width: '4%' }} /><col style={{ width: '6%' }} /><col style={{ width: '6%' }} /><col style={{ width: '34%' }} />
            <col style={{ width: '4%' }} /><col style={{ width: '6%' }} /><col style={{ width: '6%' }} /><col style={{ width: '34%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>CKT#</th><th>Poles</th><th>Amps</th><th>Description</th>
              <th>CKT#</th><th>Poles</th><th>Amps</th><th>Description</th>
            </tr>
          </thead>
          <tbody>
            {schedule.rows.map((row, i) => (
              <tr key={i}>
                <td className="ckt" style={{ color: cktColor(row.lc) }}>{row.lc <= schedule.maxN ? row.lc : ''}</td>
                <ScheduleCells cell={row.l} />
                <td className="ckt" style={{ color: cktColor(row.rc) }}>{row.rc <= schedule.maxN ? row.rc : ''}</td>
                <ScheduleCells cell={row.r} />
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ps-foot">
          <div>121 Turnpike Drive | Middlebury, CT 06762 | Tel: 203-575-9473</div>
          <div>DINTOELECTRIC.COM | CT State Electrical License #100760 | AA/EOE</div>
        </div>
      </div>
    )}
    </>
  );
}
