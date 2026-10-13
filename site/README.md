# Figma Forge — marketing site

Static. No build step, no dependencies.

```
python3 -m http.server 8731     # then open http://127.0.0.1:8731
```

## Layout

| Path | |
|---|---|
| `index.html` | Overview — hero inspect widget, surfaces, fidelity, work, roadmap, beta modal |
| `install.html` | Prerequisites, steps, troubleshooting |
| `releases.html` | Changelog and known issues |
| `assets/style.css` | All styling. Dark-first; light via `[data-theme="light"]` |
| `assets/app.js` | Inspect widget, cursors, tabs, terminal replay, theme, beta modal |
| `llms.txt`, `ai.txt`, `robots.txt`, `sitemap.xml` | Crawler and agent files |

## Notes for whoever touches this next

- **The hero widget measures itself.** Selection chrome reads real `getBoundingClientRect`
  values off the mock composition, and the layer tree is bound to the same nodes in both
  directions. If you change the mock, the numbers follow automatically.
- **Chrome specs are borrowed from shipped tools, not invented**: tldraw's 40px dot grid
  with a 10px sub-grid at 0.17 opacity; Onlook's handles filled with the page background
  rather than white; snap guides 1px, solid and instant — never animate them, the
  instantaneity is what makes a snap read as a snap.
- **Three accents, each with a job**: `--act` action, `--sel` selection, `--snap` guides.
  Don't add a fourth without taking one away.
- **The beta form has no backend.** It writes to `localStorage` and says so in the copy.
  Point the submit handler in `app.js` at a real endpoint and update that line together.
- `showcase-gosolar.jpg` and `showcase-ellum.jpg` are screenshots of third-party live
  sites, labelled SOURCE rather than EXPORTED because they have not been through the
  pipeline. Swap the label when they have.

## Deploy

```
vercel deploy --prod --scope aviofla
```
