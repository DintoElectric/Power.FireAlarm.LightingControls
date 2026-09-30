# Dinto As-Builts — QR drawing access

A public web app for reaching as-built information by QR code. A scan resolves to
one panel. From there a field tech reads the schedule, and admins mark progress.

Job: **Hartford Hospital, Conklin Building — Observation Unit Renovation Phase II**

Stack: **Vite + React**, `pdfjs-dist` for vector drawing rendering, Phosphor icons,
Netlify Functions + Netlify Blobs for the shared admin layer.

## Three systems

A switch in the header moves between systems. Each system has its own data folder.

| System | Data | QR path | What it shows |
|---|---|---|---|
| Power | `public/data/` | `/p/<panel>` | Circuit schedule, linked drawings with J-boxes highlighted, live/dead status |
| Fire Alarm | `public/data/firealarm/panels.json` | `/fa/<panel>` | One-line diagram per panel: click a run to mark it pulled, click a device to mark it installed |
| Lighting Control | `public/data/lighting/panels.json` | `/lc/<panel>` | Same screen as Fire Alarm (data to be added) |

Fire Alarm and Lighting Control data is taken from the shop drawings and is used as
the as-built reference. Anything flagged `confirm` in the data shows as
"confirm in field" until it is verified.

## Admin

Everyone can view. Only admins can change anything. Admin codes are set in Netlify
under **Site configuration → Environment variables** as `ADMIN_CODES`, and each
person's initials are stamped on what they change.

Admins can:
- Mark Power circuits and panels live or dead, and edit circuit descriptions, amps and poles
- Edit which circuits each J-box carries (Power)
- Mark Fire Alarm / Lighting runs pulled and devices installed

Shared state lives in Netlify Blobs through `netlify/functions/overrides.mjs`:
- Power edits are stored under one key.
- Fire Alarm and Lighting progress are stored under their own keys, separate from Power.

The static JSON files are never rewritten by the app. Corrections to the shop-drawing
data can be made in the JSON without losing any marks that have been saved.

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/
npm run preview    # serve the production build
```

The admin functions need Netlify's runtime, so use `netlify dev` if you want to test
login and saving locally.

## Deploy: GitHub → Netlify

1. In Netlify choose **Add new site → Import an existing project** and pick this repo.
   Build settings come from `netlify.toml` (`npm run build`, publish `dist`).
2. Add the `ADMIN_CODES` environment variable, then redeploy.
3. Optional: point a custom domain at the site.

`netlify.toml` and `public/_redirects` send every path to the app, so QR links such as
`/p/...`, `/fa/...` and `/lc/...` resolve. Both also set `noindex`.

## QR labels

Open `/qr.html` on the deployed site. Choose Power, Fire Alarm or Lighting Control,
and it builds a label for each panel in that system, ready to print or download as PNG.
Labels encode `<site address>/p/<panel>`, `/fa/<panel>` or `/lc/<panel>`.

## Before launch

These are as-built drawings for a hospital, and the URL is public. The app ships with
no login for viewing, and `noindex` keeps it out of search engines but does not gate
access. Confirm this is the intended access model before printing labels.

## Data

- `public/data/panels.json`: Power panel schedules
- `public/data/drawings.json`: Power drawing sheets and J-box tags
- `public/data/panel_locations.json`: text locations for panels not linked to a drawing
- `public/data/firealarm/panels.json`: Fire Alarm panels, loops and devices
- `public/drawings/*.pdf`: source drawing sheets
- `scripts/`: Python helpers used to extract J-boxes and callouts and to import circuits
  for Power

Counts dedupe by label, never by raw array length, because some tags print twice on a
sheet. Sheets link to panels by tag, never by floor.

## Drawing viewer notes

- **Viewport-tile PDF rendering** (`src/DrawingViewer.jsx`): a cached full-page
  backdrop, a viewport tile re-rendered from the vector PDF on every zoom or scroll,
  and an SVG overlay. This keeps the sheet's own labels legible at zoom.
- **Overlay alignment**: the overlay uses `preserveAspectRatio="none"` and an
  unrounded `viewBox` height (`1000 * pdfH / pdfW`). The defaults letterbox the overlay
  and make highlights drift at Fit.
- **J-box highlighting**: a box drawn over the printed label, sized in sheet units and
  scaled by `1/sqrt(zoom)`.

## Layout

Desktop and tablet use a three-column workspace. Columns scroll independently, and
full-sheet mode shows the drawing alone (`Esc` exits). Narrow screens stack the
columns.
