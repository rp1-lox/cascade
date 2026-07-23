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
  model elements (which meshes show/hide), visual scale, and plume — generated correctly
  whether the engine already switches configs or not. Each variant is edited in its own
  scoped panel (Engine / Model / Plume tabs) that mirrors the real config structure.
- **Edit Waterfall plumes inline, on the engine** — the full effect editor (per-effect
  on/off toggles, add-effect palette, materials, modifier curves) sits right in the variant
  panel and renders live on the 3D model as you work. Mod templates are **forked
  automatically and silently** the moment you edit one, so shipped plumes are never touched.
- **Build a plume from a blank slate** — start empty and add effects from a palette of
  Waterfall models/shaders harvested from your install. Hover any property for a plain-English
  explanation of what it does.
- **Give Waterfall to engines that don't have it** — a `ModuleWaterfallFX` is minted for you
  (disabled on stock subtypes, so unmodified configs stay stock), with an attach-transform
  picker that lists the part's real transforms and their counts — e.g. one plume on
  `thrustTransform (×30)` lights an entire engine cluster.
- **Propellant presets** — swap fuel mixtures from a list of every combination used in your
  install, with its most common ratios.
- **Share your work as plume packs** — export your custom plumes and engine variants to a zip,
  import a friend's. Name collisions auto-rename, references remap, and variants for parts you
  don't have are skipped with a reason. Nothing of yours is ever overwritten.
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
   - **macOS:** double-click **`Cascade.command`** (double-clicking a `.sh` does nothing on macOS)
   - **Linux:** `./run.sh`

### macOS notes

- Use `Cascade.command`, not `run.sh` — macOS only opens `.command` files in Terminal.
- macOS does **not** ship `python3` by default. If Cascade says Python is missing, run this
  once in Terminal, then double-click again:
  ```sh
  xcode-select --install
  ```
  (Or install Python from <https://www.python.org/downloads/macos/>.)
- If Gatekeeper blocks it ("unidentified developer" / "cannot be opened"), clear the
  download quarantine flag on the folder:
  ```sh
  xattr -dr com.apple.quarantine /path/to/Cascade
  ```
- If you somehow get `Permission denied`, restore the executable bit:
  ```sh
  chmod +x Cascade.command run.sh
  ```

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
