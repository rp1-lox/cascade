# Cascade

**A GUI for out-of-KSP Waterfall plume editing.**

Cascade is a local, browser-based tool for editing engines in a **modded Kerbal Space
Program** install without wrestling with Waterfall's in-game editor. It reads your actual
compiled game database, renders each engine's 3D model **and** its Waterfall plume the way
it looks in flight, and generates clean ModuleManager patches you can drop back into the game.

## What it does

- **Browse every engine** in your install by its in-game name; edit thrust, ISP (as a table),
  heat, and propellants.
- **Add whole engine-config variants** — new B9PartSwitch subtypes with their own stats, fuel,
  model elements (which meshes show/hide), and plume — generated correctly whether the engine
  already switches configs or not.
- **Edit & preview Waterfall plumes**, including **building one from a blank slate** — start
  empty and add effects from a palette of Waterfall models/shaders, tune materials and
  modifier curves, and see it render live.
- **Preview per-variant plumes** in the 3D viewer before you ever launch KSP.
- **Compile** everything to `GameData/zzzz_EngineEditor/` as `:FINAL` ModuleManager patches —
  lint-checked, so it refuses to emit broken configs.

Everything is **data-derived** — no per-mod whitelists — so it works dropped into any KSP
install.

## Requirements

- Kerbal Space Program with **ModuleManager**, launched at least once (so its config cache
  exists).
- **Windows:** nothing else — the release bundles a Python runtime.
- **Linux / macOS:** Python 3 (nearly always already installed).

## Install (release)

Grab the latest release, then:

1. Unzip it.
2. Move the `Cascade` folder into your KSP root — the folder that contains `GameData`.
3. Run it:
   - **Windows:** double-click `run.bat`
   - **Linux / macOS:** `./run.sh`

First launch indexes your installed mods (~1–2 min; near-instant afterward), then opens the
editor at <http://localhost:8151>. Keep the console window open while you use it.

## Running from source

Cascade is pure Python standard library — no dependencies. From a checkout placed at
`<KSP>/Cascade/` (or any folder name inside your KSP root):

```sh
python indexer/run_index.py   # build the index for your install
python server.py              # serve at http://localhost:8151
```

## Layout

```
server.py        local HTTP server + API
launch.py        one-shot bootstrap (index -> serve -> open browser)
indexer/         ConfigCache + .mu parsers, ModuleManager/B9PS provenance, plume compile
web/             the browser UI (WebGL model + Waterfall plume renderer)
data/            starter templates (the per-install index is generated here, not tracked)
docs/            design notes
```

## Applying / sharing results

"Compile / Apply" writes patches into `GameData/zzzz_EngineEditor/`. Those are normal
ModuleManager patches — to share your results with someone, send them that folder; they do
**not** need Cascade for the patches to work.
