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

// progress dot: done = filled blue, part = filled amber, none = hollow gray
const dot = (state) => ({
  width: 9, height: 9, borderRadius: '50%', flex: 'none', display: 'inline-block', boxSizing: 'border-box',
  background: state === 'done' ? COLOR : state === 'part' ? AMBER : 'transparent',
  border: `2px solid ${state === 'done' ? COLOR : state === 'part' ? AMBER : PENDING}`,
});

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

export default function FireAlarmPage({ system, initialPanel, refreshKey }) {
  const [data, setData] = useState(null);
  const [loadState, setLoadState] = useState('loading'); // loading | ok | missing
  const [progress, setProgress] = useState({ devices: {}, runs: {} });
  const [selLoop, setSelLoop] = useState(null);
  const [printedAt, setPrintedAt] = useState(() => new Date());

  const label = LABELS[system] || system;

  // Static shop-drawing data for this system
  useEffect(() => {
    let alive = true;
    setLoadState('loading'); setData(null); setSelLoop(null);
    fetch(`/data/${system}/panels.json`)
      .then((r) => { if (!r.ok) throw new Error('missing'); return r.json(); })
      .then((d) => {
        if (!alive) return;
        if (!d || !Array.isArray(d.panels) || !d.panels.length) throw new Error('empty');
        // open on the scanned panel's first loop if the QR named one, else the first loop
        const want = initialPanel ? String(initialPanel).toUpperCase() : null;
        const pm = want ? d.panels.find((p) => String(p.panel).toUpperCase() === want) : null;
        const firstLoop = ((pm || d.panels[0]).loops || [])[0]
          || d.panels.flatMap((p) => p.loops || [])[0];
        setData(d); setSelLoop(firstLoop ? firstLoop.id : null); setLoadState('ok');
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
  useEffect(() => { setProgress({ devices: {}, runs: {} }); }, [system]);
  useEffect(() => { refresh(); }, [system, refreshKey]);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [system]);

  // While this page is showing, printing outputs the progress sheet
  // (hides the normal app root for print). Removed again when leaving.
  useEffect(() => {
    if (loadState !== 'ok') return undefined;
    document.body.classList.add('has-fa-print');
    return () => document.body.classList.remove('has-fa-print');
  }, [loadState]);

  const wrap = { padding: '16px 20px' };

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

  const loops = data.panels.flatMap((p) => (p.loops || []).map((lp) => ({ lp, panel: p })));
  if (!loops.length) {
    return (
      <div style={wrap}>
        <div className="designation mono" style={{ marginBottom: 8 }}>{label}</div>
        <div className="status">No loops have been added to {label} yet.</div>
      </div>
    );
  }
  const cur = loops.find((x) => x.lp.id === selLoop) || loops[0];
  const lp = cur.lp;
  const panel = cur.panel;

  const doneDev = (id) => !!(progress.devices[id] && progress.devices[id].done);
  const doneRun = (id) => !!(progress.runs[id] && progress.runs[id].done);
  const stats = (l) => {
    const n = l.devices.length;
    const inst = l.devices.filter((d) => doneDev(d.id)).length;
    let pulled = 0;
    for (let i = 0; i <= n; i++) if (doneRun(`${l.id}:R${i}`)) pulled += 1;
    return { n, inst, pulled, runs: n + 1, complete: n > 0 && inst === n && pulled === n + 1, started: inst > 0 || pulled > 0 };
  };
  const st = stats(lp);
  const stateOf = (s) => (s.complete ? 'done' : s.started ? 'part' : 'none');

  // panel-wide totals for the printed sheet
  let devTotal = 0, devDone = 0, runTotal = 0, runDone = 0;
  (panel.loops || []).forEach((l) => {
    const s = stats(l);
    devTotal += s.n; devDone += s.inst; runTotal += s.runs; runDone += s.pulled;
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

      {(panel.loops || []).map((l) => {
        const s = stats(l);
        const eolRid = `${l.id}:R${s.n}`;
        const eolOn = doneRun(eolRid);
        return (
          <div className="fa-loop" key={l.id}>
            <div className="fa-loop-h">
              NAC {l.id}
              <span>{s.inst}/{s.n} installed · {s.pulled}/{s.runs} pulled</span>
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
                {l.devices.map((d, i) => {
                  const rid = `${l.id}:R${i}`;
                  const runOn = doneRun(rid);
                  const devOn = doneDev(d.id);
                  const from = i === 0 ? panel.panel : l.devices[i - 1].id.split(':').pop();
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
                  <td className="d">{l.eol || 'EOL'}</td>
                  <td>{s.n > 0 ? l.devices[s.n - 1].id.split(':').pop() : panel.panel}</td>
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

  const eolRidCur = `${lp.id}:R${st.n}`;
  const eolOnCur = doneRun(eolRidCur);

  return (
    <>
    <div className="grid" style={{ gridTemplateColumns: '196px 340px minmax(0,1fr)' }}>
      {/* Column 1 — loop list, grouped by panel (like the Power panel list) */}
      <aside className="col-panels scrolly">
        <div className="eyebrow" style={{ marginBottom: 10 }}>Loops · {loops.length}</div>
        {data.panels.map((p) => {
          const items = loops.filter((x) => x.panel === p);
          if (!items.length) return null;
          return (
            <div key={p.panel} className="floor-group">
              <div className="floor-head">{p.panel}</div>
              {items.map(({ lp: l }) => {
                const s = stats(l);
                return (
                  <button key={l.id} className="pbtn" data-on={l.id === lp.id ? '1' : '0'} onClick={() => setSelLoop(l.id)}>
                    <span style={dot(stateOf(s))} title={s.complete ? 'Complete' : s.started ? 'In progress' : 'Not started'} />
                    <span className="mono" style={{ fontSize: 13 }}>{l.label}</span>
                    <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-muted)' }}>{s.inst}/{s.n}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        <div style={{ marginTop: 14, padding: '0 9px', fontSize: 11.5, color: 'var(--color-muted)', lineHeight: 1.9 }}>
          <div><span style={{ ...dot('done'), marginRight: 6, verticalAlign: 'middle' }} />Complete</div>
          <div><span style={{ ...dot('part'), marginRight: 6, verticalAlign: 'middle' }} />In progress</div>
          <div><span style={{ ...dot('none'), marginRight: 6, verticalAlign: 'middle' }} />Not started</div>
        </div>
      </aside>

      {/* Column 2 — loop schedule (like the Power circuit schedule) */}
      <section className="col-schedule scrolly">
        <div className="scanned"><span className="scanned-dot" />{label} · loop</div>
        <div className="mono designation">{lp.label}</div>
        <div className="source-line">NAC {lp.id} · {st.n} device{st.n === 1 ? '' : 's'} · {lp.eol || 'EOL'}</div>
        <div className="source-line">{panel.title}</div>
        <div className="source-line">{[panel.type, panel.node && 'Node ' + panel.node, panel.power].filter(Boolean).join(' · ')}</div>
        {data.draft && (
          <div style={{ fontSize: 12.5, color: AMBER, marginTop: 8 }}>
            Draft data from the shop drawings — devices marked “confirm in field” need verification.
          </div>
        )}

        <div className="status-summary">
          <span style={{ ...dot(st.inst === st.n && st.n > 0 ? 'done' : st.inst > 0 ? 'part' : 'none'), width: 14, height: 14 }} />
          <span className="status-text">{st.inst} of {st.n} devices installed</span>
        </div>
        <div className="status-summary">
          <span style={{ ...dot(st.pulled === st.runs ? 'done' : st.pulled > 0 ? 'part' : 'none'), width: 14, height: 14 }} />
          <span className="status-text">{st.pulled} of {st.runs} runs pulled</span>
        </div>

        <div style={{ marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={printSheet}>Export / print progress sheet (PDF)</button>
        </div>

        <div style={{ marginTop: 22 }}>
          <div className="chd">
            <span /><span>#</span><span>Device</span><span style={{ textAlign: 'right' }}>Run in</span>
          </div>
          {lp.devices.map((d, i) => {
            const on = doneDev(d.id);
            const rid = `${lp.id}:R${i}`;
            const ron = doneRun(rid);
            const from = i === 0 ? panel.panel : lp.devices[i - 1].id;
            return (
              <div key={d.id} className="crow" style={{ cursor: 'default' }}>
                <span style={{ ...dot(on ? 'done' : 'none'), marginTop: 4 }} title={on ? 'Installed ' + stamp(progress.devices[d.id]) : 'Not installed'} />
                <span className="mono" style={{ fontSize: 13, color: 'var(--color-accent)' }}>{d.id.split('-').pop()}</span>
                <span style={{ fontSize: 13.5 }}>
                  <span style={{ display: 'block' }}>{d.room} · {d.name}</span>
                  <span className="mono" style={{ display: 'block', fontSize: 11.5, color: 'var(--color-text-2)' }}>{devLabel(d)}</span>
                  {d.confirm && <span style={{ display: 'block', fontSize: 11.5, color: AMBER, fontWeight: 600 }}>⚠ confirm in field</span>}
                </span>
                <span className="mono" style={{ fontSize: 13, textAlign: 'right', color: ron ? COLOR : 'var(--color-faint)' }}
                  title={`${from} → ${d.id}\n${ron ? 'Pulled ' + stamp(progress.runs[rid]) : 'Not pulled'}`}>
                  {ron ? '✓' : '—'}
                </span>
              </div>
            );
          })}
          <div className="crow" style={{ cursor: 'default' }}>
            <span />
            <span className="mono" style={{ fontSize: 12, color: 'var(--color-muted)' }}>EOL</span>
            <span style={{ fontSize: 13.5 }}>
              <span style={{ display: 'block' }}>End-of-line resistor</span>
              <span className="mono" style={{ display: 'block', fontSize: 11.5, color: 'var(--color-text-2)' }}>{lp.eol || 'EOL'}</span>
            </span>
            <span className="mono" style={{ fontSize: 13, textAlign: 'right', color: eolOnCur ? COLOR : 'var(--color-faint)' }}
              title={eolOnCur ? 'Pulled ' + stamp(progress.runs[eolRidCur]) : 'Not pulled'}>
              {eolOnCur ? '✓' : '—'}
            </span>
          </div>
          <div className="edit-hint">The Run in column shows whether the wire run from the previous device (or the panel) into this device is pulled.</div>
        </div>
      </section>

      {/* Column 3 — as-built drawing (placeholder until the fire alarm sheets are loaded) */}
      <div className="viewer">
        <div className="viewer-head">
          <span className="eyebrow">Sheet</span>
        </div>
        <div className="gridpaper empty-well">
          <div className="empty-msg">
            No as-built drawing added yet.<br />
            Loop {lp.label}’s runs and devices will show here once the fire alarm sheets are loaded.
          </div>
        </div>
      </div>
    </div>
    {createPortal(printBlock, document.body)}
    </>
  );
}
