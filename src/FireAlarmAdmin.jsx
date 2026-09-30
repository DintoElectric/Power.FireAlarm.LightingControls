import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const FN_OVR = '/.netlify/functions/overrides';
const LABELS = { firealarm: 'Fire Alarm', lighting: 'Lighting Control' };
const QR_PATH = { firealarm: '/fa/', lighting: '/lc/' };
const COLOR = '#1f6feb';
const PENDING = '#9aa0a6';
const AMBER = '#d9a441';

const devLabel = (d) => (d.type === 'SPEAKER/STROBE'
  ? `SPKR/STROBE ${d.cd}cd${d.tap ? ' · ' + d.tap : ''}`
  : `${d.type} ${d.cd}cd`);

const stamp = (p) => {
  if (!p) return '';
  const when = p.at ? new Date(p.at).toLocaleDateString() : '';
  return [when, p.by].filter(Boolean).join(' · ');
};

// Print-only styling for the progress sheet. Reuses the Power schedule's
// .print-schedule / .ps-* classes from styles.css and adds the pieces below.
const PRINT_CSS = `
@media print {
  body.has-fa-print #root { display: none !important; }
  .fa-print .fa-project { font-size: 11px; font-weight: 700; margin: 6px 0 2px; }
  .fa-print .fa-note { font-size: 9px; color: #333; margin-bottom: 6px; }
  .fa-print .fa-loop { break-inside: avoid; margin-bottom: 14px; }
  .fa-print .fa-loop-h { font-size: 12px; font-weight: 700; margin: 10px 0 4px; }
  .fa-print .fa-loop-h span { font-weight: 400; font-size: 10px; margin-left: 10px; }
  .fa-print .fa-table { font-size: 10px; }
  .fa-print .fa-table td { height: 20px; }
  .fa-print .fa-table tr { break-inside: avoid; }
  .fa-print .fa-table td.fa-done { background: #e6efff; }
  .fa-print .fa-box { display: inline-block; width: 11px; height: 11px; border: 1px solid #000; vertical-align: middle; text-align: center; font-size: 10px; line-height: 10px; font-weight: 700; }
  .fa-print .fa-stamp { font-size: 8.5px; margin-left: 3px; }
}
`;

export default function FireAlarmAdmin({ system, admin, token, onUnauthorized, initialPanel }) {
  const [data, setData] = useState(null);
  const [loadState, setLoadState] = useState('loading'); // loading | ok | missing
  const [progress, setProgress] = useState({ devices: {}, runs: {} });
  const [selPanel, setSelPanel] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [err, setErr] = useState('');
  const [printedAt, setPrintedAt] = useState(() => new Date());

  const label = LABELS[system] || system;

  // Static shop-drawing data for this system
  useEffect(() => {
    let alive = true;
    setLoadState('loading'); setData(null); setSelPanel(null);
    fetch(`/data/${system}/panels.json`)
      .then((r) => { if (!r.ok) throw new Error('missing'); return r.json(); })
      .then((d) => {
        if (!alive) return;
        if (!d || !Array.isArray(d.panels) || !d.panels.length) throw new Error('empty');
        // open on the scanned panel if the QR named one that exists, else the first panel
        const want = initialPanel ? String(initialPanel).toUpperCase() : null;
        const match = want ? d.panels.find((p) => String(p.panel).toUpperCase() === want) : null;
        setData(d); setSelPanel((match || d.panels[0]).panel); setLoadState('ok');
      })
      .catch(() => { if (alive) setLoadState('missing'); });
    return () => { alive = false; };
  }, [system]);

  // Progress marks (installed / pulled), shared and stored by the backend
  const refresh = () => {
    fetch(`${FN_OVR}?system=${system}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setProgress({ devices: d.devices || {}, runs: d.runs || {} }); })
      .catch(() => { /* backend not up yet */ });
  };
  useEffect(() => {
    setProgress({ devices: {}, runs: {} });
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [system]);

  // While the progress screen is showing, printing should output the progress sheet
  // (hides the normal app root for print). Removed again when leaving this screen.
  useEffect(() => {
    if (loadState !== 'ok') return undefined;
    document.body.classList.add('has-fa-print');
    return () => document.body.classList.remove('has-fa-print');
  }, [loadState]);

  const toggle = async (kind, id) => {
    if (!admin) return;
    const bucket = kind === 'device' ? 'devices' : 'runs';
    const done = !(progress[bucket][id] && progress[bucket][id].done);
    setBusyKey(kind + ':' + id); setErr('');
    try {
      const r = await fetch(FN_OVR, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'setProgress', system, kind, id, done }),
      });
      if (r.status === 401) {
        onUnauthorized();
        setErr('Session expired — log in again.');
      } else {
        const d = await r.json().catch(() => null);
        if (d && d.data) setProgress({ devices: d.data.devices || {}, runs: d.data.runs || {} });
        else setErr('Save failed — try again.');
      }
    } catch {
      setErr('Save failed — check your connection.');
    }
    setBusyKey(null);
  };

  const wrap = { padding: '16px 20px', overflow: 'auto', flex: 1, minHeight: 0 };

  if (loadState === 'loading') {
    return <div style={wrap}><div className="status">Loading {label}…</div></div>;
  }
  if (loadState === 'missing') {
    return (
      <div style={wrap}>
        <div className="designation mono" style={{ marginBottom: 8 }}>{label}</div>
        <div className="status">No {label} data has been added yet.</div>
      </div>
    );
  }

  const panel = data.panels.find((p) => p.panel === selPanel) || data.panels[0];
  const doneDev = (id) => !!(progress.devices[id] && progress.devices[id].done);
  const doneRun = (id) => !!(progress.runs[id] && progress.runs[id].done);

  // panel-wide totals
  let devTotal = 0, devDone = 0, runTotal = 0, runDone = 0;
  panel.loops.forEach((lp) => {
    lp.devices.forEach((d) => { devTotal += 1; if (doneDev(d.id)) devDone += 1; });
    for (let i = 0; i <= lp.devices.length; i++) {
      runTotal += 1; if (doneRun(`${lp.id}:R${i}`)) runDone += 1;
    }
  });

  const ensureQR = () => new Promise((resolve) => {
    if (window.QRCode) return resolve();
    const el = document.createElement('script');
    el.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    el.onload = resolve; el.onerror = resolve; document.head.appendChild(el);
  });
  const printSheet = async () => {
    await ensureQR();
    const holder = document.getElementById('fa-print-qr');
    if (holder && window.QRCode) {
      holder.innerHTML = '';
      new window.QRCode(holder, {
        text: window.location.origin + (QR_PATH[system] || '/fa/') + encodeURIComponent(panel.panel),
        width: 92, height: 92, correctLevel: window.QRCode.CorrectLevel.M,
      });
    }
    setPrintedAt(new Date());
    setTimeout(() => window.print(), 250);
  };

  const legendDot = (filled) => ({
    display: 'inline-block', width: 14, height: 14, borderRadius: '50%', verticalAlign: 'middle', marginRight: 6,
    boxSizing: 'border-box',
    background: filled ? COLOR : 'transparent',
    border: filled ? `2px solid ${COLOR}` : `2px solid ${PENDING}`,
  });

  const mark = (on, p) => (on
    ? (<><span className="fa-box">✓</span><span className="fa-stamp">{stamp(p)}</span></>)
    : <span className="fa-box" />);

  const printBlock = (
    <div className="print-schedule fa-print">
      <style>{PRINT_CSS}</style>
      <div className="ps-head">
        <img className="ps-logo" src="/dinto-logo.png" alt="Dinto Electrical Contractors" />
        <div className="ps-title">PANEL: {panel.panel}</div>
        <div className="ps-power">{label.toUpperCase()} — AS-BUILT PROGRESS</div>
        <div className="ps-meta">
          <div>EQUIPMENT: {panel.type || ''}</div>
          <div>NODE: {panel.node || ''}</div>
          <div>POWER: {panel.power || ''}</div>
          <div>INSTALLED: {devDone} of {devTotal} devices</div>
          <div>PULLED: {runDone} of {runTotal} runs</div>
          <div>PRINTED: {printedAt.toLocaleDateString()}</div>
        </div>
        <div id="fa-print-qr" className="ps-qr" />
      </div>
      {data.project && <div className="fa-project">{data.project}</div>}
      <div className="fa-note">
        {data.draft ? 'Draft data from the shop drawings. ' : ''}* = confirm in field. Shaded boxes are complete; date and initials show who marked them.
      </div>

      {panel.loops.map((lp) => {
        const n = lp.devices.length;
        const instCount = lp.devices.filter((d) => doneDev(d.id)).length;
        let pulledCount = 0;
        for (let i = 0; i <= n; i++) if (doneRun(`${lp.id}:R${i}`)) pulledCount += 1;
        const eolRid = `${lp.id}:R${n}`;
        const eolOn = doneRun(eolRid);
        return (
          <div className="fa-loop" key={lp.id}>
            <div className="fa-loop-h">
              NAC {lp.id}
              <span>{instCount}/{n} installed · {pulledCount}/{n + 1} pulled</span>
            </div>
            <table className="ps-table fa-table">
              <colgroup>
                <col style={{ width: '15%' }} /><col style={{ width: '10%' }} /><col style={{ width: '17%' }} />
                <col style={{ width: '10%' }} /><col style={{ width: '22%' }} /><col style={{ width: '13%' }} /><col style={{ width: '13%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Device</th><th>Run from</th><th>Type</th><th>Room</th><th>Location</th><th>Run pulled</th><th>Installed</th>
                </tr>
              </thead>
              <tbody>
                {lp.devices.map((d, i) => {
                  const rid = `${lp.id}:R${i}`;
                  const runOn = doneRun(rid);
                  const devOn = doneDev(d.id);
                  const from = i === 0 ? panel.panel : lp.devices[i - 1].id.split(':').pop();
                  return (
                    <tr key={d.id}>
                      <td className="d mono">{d.id}</td>
                      <td>{from}</td>
                      <td className="d">{devLabel(d)}</td>
                      <td>{d.room}{d.confirm ? ' *' : ''}</td>
                      <td className="d">{d.name}</td>
                      <td className={runOn ? 'd fa-done' : 'd'}>{mark(runOn, progress.runs[rid])}</td>
                      <td className={devOn ? 'd fa-done' : 'd'}>{mark(devOn, progress.devices[d.id])}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td className="d">{lp.eol || 'EOL'}</td>
                  <td>{n > 0 ? lp.devices[n - 1].id.split(':').pop() : panel.panel}</td>
                  <td className="d">End-of-line resistor</td>
                  <td></td>
                  <td className="d"></td>
                  <td className={eolOn ? 'd fa-done' : 'd'}>{mark(eolOn, progress.runs[eolRid])}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}

      <div className="ps-foot">
        <div>121 Turnpike Drive | Middlebury, CT 06762 | Tel: 203-575-9473</div>
        <div>DINTOELECTRIC.COM | CT State Electrical License #100760 | AA/EOE</div>
      </div>
    </div>
  );

  return (
    <>
    <div style={wrap}>
      <div className="eyebrow" style={{ marginBottom: 6 }}>{label} · as-built progress</div>
      <div className="mono designation">{panel.panel}</div>
      <div className="source-line">{panel.title}</div>
      <div className="source-line">{[panel.type, panel.node && 'Node ' + panel.node, panel.power].filter(Boolean).join(' · ')}</div>
      {data.draft && (
        <div style={{ fontSize: 12.5, color: AMBER, marginTop: 6 }}>
          Draft data taken from the shop drawings — devices marked “confirm in field” need verification.
        </div>
      )}

      {data.panels.length > 1 && (
        <div className="floor-chips" style={{ marginTop: 12 }}>
          {data.panels.map((p) => (
            <button key={p.panel} className="fbtn" data-on={p.panel === panel.panel ? '1' : '0'} onClick={() => setSelPanel(p.panel)}>{p.panel}</button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 14, fontSize: 14, alignItems: 'center' }}>
        <span><b>{devDone}</b> of {devTotal} devices installed</span>
        <span><b>{runDone}</b> of {runTotal} runs pulled</span>
        <button className="btn btn-secondary" onClick={printSheet}>Print progress sheet</button>
      </div>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, fontSize: 12.5, color: 'var(--color-text-2, #555)' }}>
        <span><span style={legendDot(true)} />Installed</span>
        <span><span style={legendDot(false)} />Not installed</span>
        <span>
          <span style={{ display: 'inline-block', width: 26, height: 6, borderRadius: 3, background: COLOR, verticalAlign: 'middle', marginRight: 6 }} />Pulled
        </span>
        <span>
          <span style={{ display: 'inline-block', width: 26, height: 0, borderTop: `3px dashed ${PENDING}`, verticalAlign: 'middle', marginRight: 6 }} />Not pulled
        </span>
      </div>

      <div className="edit-hint" style={{ marginTop: 10 }}>
        {admin
          ? 'Admin — click a run to mark it pulled; click a device to mark it installed. Click again to undo.'
          : 'Read-only view. Log in as admin to mark runs pulled and devices installed.'}
      </div>
      {err && <div className="status" style={{ color: '#e5484d', marginTop: 8 }}>{err}</div>}

      {panel.loops.map((lp) => {
        const n = lp.devices.length;
        const instCount = lp.devices.filter((d) => doneDev(d.id)).length;
        let pulledCount = 0;
        for (let i = 0; i <= n; i++) if (doneRun(`${lp.id}:R${i}`)) pulledCount += 1;

        const runBtn = (i) => {
          const rid = `${lp.id}:R${i}`;
          const on = doneRun(rid);
          const p = progress.runs[rid];
          const from = i === 0 ? panel.panel : lp.devices[i - 1].id;
          const to = i === n ? 'EOL' : lp.devices[i].id;
          return (
            <button
              key={rid}
              disabled={!admin || busyKey === 'run:' + rid}
              onClick={() => toggle('run', rid)}
              title={`${from} → ${to}\n${on ? 'Pulled ' + stamp(p) : 'Not pulled'}${admin ? '\nClick to ' + (on ? 'undo' : 'mark pulled') : ''}`}
              style={{
                width: 76, height: 28, flex: '0 0 76px', padding: 0, border: 0, background: 'none',
                display: 'flex', alignItems: 'center', cursor: admin ? 'pointer' : 'default',
              }}
            >
              <span style={{
                display: 'block', width: '100%', boxSizing: 'border-box',
                height: on ? 6 : 0, borderRadius: 3,
                background: on ? COLOR : 'transparent',
                borderTop: on ? 'none' : `3px dashed ${PENDING}`,
              }} />
            </button>
          );
        };

        const items = [];
        items.push(
          <div key="panel" style={{
            width: 92, flex: '0 0 92px', minHeight: 56, boxSizing: 'border-box', padding: '6px 8px',
            border: '2px solid var(--color-text, #222)', borderRadius: 6, textAlign: 'center',
          }}>
            <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{panel.panel}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--color-text-2, #555)' }}>{lp.label}</div>
          </div>
        );
        lp.devices.forEach((d, i) => {
          items.push(runBtn(i));
          const on = doneDev(d.id);
          const p = progress.devices[d.id];
          items.push(
            <div key={d.id} style={{ position: 'relative', width: 28, flex: '0 0 28px' }}>
              <button
                disabled={!admin || busyKey === 'device:' + d.id}
                onClick={() => toggle('device', d.id)}
                title={`${d.id}\n${on ? 'Installed ' + stamp(p) : 'Not installed'}${admin ? '\nClick to ' + (on ? 'undo' : 'mark installed') : ''}`}
                style={{
                  width: 28, height: 28, borderRadius: '50%', boxSizing: 'border-box', padding: 0,
                  background: on ? COLOR : 'var(--color-bg, #fff)',
                  border: on ? `2px solid ${COLOR}` : `2px solid ${PENDING}`,
                  color: '#fff', fontSize: 15, lineHeight: 1, fontWeight: 700,
                  cursor: admin ? 'pointer' : 'default',
                }}
              >{on ? '✓' : ''}</button>
              <div style={{ width: 104, marginLeft: -38, marginTop: 6, textAlign: 'center', fontSize: 11.5, lineHeight: 1.3 }}>
                <div className="mono" style={{ fontWeight: 700, color: on ? COLOR : 'var(--color-text, #222)' }}>{d.id.split(':').pop()}</div>
                <div className="mono" style={{ color: 'var(--color-text-2, #555)' }}>{devLabel(d)}</div>
                <div className="mono">{d.room}</div>
                <div style={{ color: 'var(--color-text-2, #555)' }}>{d.name}</div>
                {d.confirm && <div style={{ color: AMBER, fontWeight: 600 }}>⚠ confirm in field</div>}
              </div>
            </div>
          );
        });
        items.push(runBtn(n));
        items.push(
          <div key="eol" className="mono" style={{
            width: 64, flex: '0 0 64px', height: 28, boxSizing: 'border-box', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, border: '2px solid var(--color-text, #222)', borderRadius: 4,
          }}>{lp.eol || 'EOL'}</div>
        );

        return (
          <div key={lp.id} style={{ marginTop: 26 }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span className="mono" style={{ fontSize: 14, fontWeight: 700 }}>NAC {lp.id}</span>
              <span style={{ fontSize: 12.5, color: 'var(--color-text-2, #555)' }}>
                {instCount}/{n} installed · {pulledCount}/{n + 1} pulled
              </span>
            </div>
            <div style={{ overflowX: 'auto', paddingTop: 12, paddingBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', minWidth: 'max-content', paddingLeft: 38, paddingRight: 38 }}>
                {items}
              </div>
            </div>
          </div>
        );
      })}
    </div>
    {createPortal(printBlock, document.body)}
    </>
  );
}
