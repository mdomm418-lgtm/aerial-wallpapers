# Development

## Build targets

Common tasks are available via `make`:

| Command          | Description                                        |
| ---------------- | -------------------------------------------------- |
| `make build`     | Build the TypeScript sources                       |
| `make typecheck` | Type-check without emitting                        |
| `make install`   | Build and install into `~/.local`                  |
| `make pack`      | Build an installable zip in `dist/`                |
| `make enable`    | Enable the extension                               |
| `make disable`   | Disable the extension                              |
| `make prefs`     | Open the preferences window                        |
| `make renderer`  | Run the renderer standalone (`ARGS=...`)           |
| `make lint`      | Run ESLint                                         |
| `make lint-fix`  | Run ESLint with auto-fix                           |
| `make log`       | Follow the GNOME Shell log                         |
| `make pot`       | Regenerate the translation template                |
| `make merge-po`  | Regenerate `.pot` and merge into all `.po` files   |

Run `make help` to see all targets.

## Reloading during development

GNOME Shell caches an extension's JavaScript modules for the whole session, so
`disable`/`enable` does **not** pick up changes to Shell-side code
(`extension.js`: panel menu, picker, wallpaper actors). Log out and back in after
`make install`.

Two things are exempt and can be iterated on without logging out:

- **Preferences** runs in its own process, so `make install` plus reopening the
  window is enough.
- **The renderer** is a separate `Gtk.Application`, so toggling the extension off
  and on restarts it with new code. It can also be run directly with
  `make renderer` for faster iteration.

## Architecture

- `src/extension.ts` — lifecycle: spawns the renderer, owns the panel menu,
  picker, keybinding, auto-pause modules, and playback state.
- `src/gnomeShellOverride.ts` / `src/wallpaper.ts` — clone the renderer's windows
  into the desktop background, the overview, and the lock screen.
- `src/renderer/renderer.ts` — a standalone GTK4 app, one window per monitor, that
  owns playback and exports D-Bus controls.
- `src/renderer/playerSlot.ts` — one `GstPlay` pipeline plus its paintable. Two
  slots exist; one plays while the other pre-rolls, and transitions crossfade the
  paired `Gtk.Picture` opacities.
- `src/renderer/library.ts` / `playlist.ts` — manifest fetching and caching, and
  the shuffle deck with blocklist and pin-once semantics.
- `src/renderer/thumbnails.ts` — downloads the published WebP previews and
  transcodes them to PNG with GStreamer, because no WebP pixbuf loader is
  guaranteed to be installed.

Two constraints are worth knowing before changing the renderer:

- **No top-level `await` in renderer modules.** `Gtk.Application.run()` blocks, so
  if it is reached from inside a promise reaction job the GJS promise dispatcher
  never runs again and playback silently deadlocks with black windows. Import GI
  modules statically.
- **Configure GStreamer sources from the main loop.** Handling `source-setup` means
  being called on a streaming thread, which crashes GJS. `httpSource.ts` instead
  polls the pipeline after `READY` to apply `ssl-strict` and friends.

## Release

Pushing a `v*` tag triggers the [`build.yml`](../.github/workflows/build.yml)
workflow, which builds the zip and publishes a GitHub Release with it attached.

1. Bump `version:` in [`meson.build`](../meson.build) (a plain integer,
   incremented by 1 — GNOME uses it to detect updates), commit, and merge.
2. Tag the release commit and push:

   ```bash
   git tag -a v1.0.0 -m "Release 1.0.0"
   git push origin v1.0.0
   ```

To re-cut, delete the tag (and its Release) first:

```bash
git tag -d v1.0.0                    # local
git push origin :refs/tags/v1.0.0    # remote
```

The same zip can be built locally with `make pack` and installed with:

```bash
gnome-extensions install --force dist/aerial-wallpapers@michael-d-murray.com.shell-extension.zip
```

## Translations

`src/po/` carries the translations inherited from Hanabi, which still cover the
strings the two projects share (rendering and auto-pause options). After changing
user-visible strings, run `make merge-po` so the `.pot` and every `.po` are updated
together.

## License headers

License headers in `src/` are managed with
[licensure](https://github.com/chasinglogic/licensure); configuration is in
[`.licensure.yml`](../.licensure.yml).

```bash
licensure --project --check      # verify
licensure --project --in-place   # apply
```

Files derived from Hanabi keep their original copyright line and add ours; new
files carry ours alone.
