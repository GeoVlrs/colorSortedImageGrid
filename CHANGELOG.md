# Changelog

## Unreleased

### Added

- `--interactive` now reaches every grid option. It keeps its short spine of questions and then
  offers the rest behind a section picker mirroring the `--help` groups, so a plain run is as short
  as it was while nothing is flags-only any more. Which questions apply is derived from the answers
  so far (`--hilbertBits` only under a hilbert sort, the morph flags only under morph), and every
  numeric prompt validates against the same rules yargs uses.
- The wizard can save its answers as a `--config` preset, which needed no loading code: `--config`
  already read exactly that shape.
- Two new animation modes, selected with `--animateMode`. `build` reveals the grid one tile at a
  time; `morph` tweens tiles from filename order into sorted order. Both are GIF, with no new
  dependencies. `--animate` on its own still means the original sweep.
- `--animateFps`, `--animateHoldMs`, `--animateEasing`, `--revealPerFrame`, `--morphSeconds`,
  `--morphStagger` and `--morphHoldMs`.

### Changed

- `lib/animate.js` became `lib/animate/`, with each mode behind a shared frame interface: modes are
  async generators yielding raw RGBA plus an optional dirty rect, and one sink turns them into GIF
  bytes. Build exploits that dirty rect to encode only the tile that changed, which is why a
  145-frame animation is ~440KB rather than tens of megabytes.
- `lib/interactive.js` became `lib/interactive/`: `sections.js` decides which questions apply,
  `summary.js` turns answers back into flags, and `index.js` is orchestration and wording only. The
  first two are pure, which is what made the wizard testable at all.
- `--help` and flag-validation errors went from ~620ms to ~250ms. The CLI was loading Jimp, culori,
  quantize and exifr before printing anything, because option values lived in the same modules as
  the behaviour and `index.js` statically imported every runner. Option values now live in
  `lib/constants.js` and `lib/animate/constants.js`, and the runners load on demand.

### Fixed

- Interactive mode printed a command that did not reproduce the run. `--dryRun` was set but never
  emitted, so copying the printed command would have rendered for real. The flag reconstruction is
  now table-driven and covered by a round-trip test through the parser, which fails if any option
  the wizard can set is left out.
- Interactive mode enforced only whatever subset of the range rules its prompts had hand-rolled -
  `--sortBands -5` was accepted there and rejected on the command line. Both paths now share
  `lib/validate.js`; the messages are unchanged.
- `--watch` together with an animation is rejected instead of silently ignoring the watch, which is
  what `index.js` did by dispatching to the animator first.
- A non-numeric value for `--padding`, `--borderWidth` or the hold-time flags parsed as `NaN` and
  was accepted. It now says so.
- Sweep pinned every frame's dimensions to the first frame's, so a later frame of a different size
  would have been encoded with a mismatched data length. It now fails with a message naming the
  frame instead.
- Sweep computed its grid from the base options rather than the current frame's, so a
  visualisation-mode sweep could lay out a frame using the wrong column count.
- `lib/animate.js` imported `RunError` from `run.js`, pulling in the whole render pipeline to get
  one error class.

## v2.0.0

Rewrite of the original single-file script into `lib/` modules (ESM, Node >=18), plus a new
`fetch` subcommand. The original is preserved as `index.original.js.bak`.

### Fixed (behaviour changes from the original)

- **Colour extraction.** The original read the average pixel by slicing a hex string, which
  misaligned whenever the red channel was below 16 — a pure blue image was analysed as
  `(80, 15, 255)` instead of `(5, 0, 255)`. Dark and blue-heavy images sorted to the wrong place.
- **`--sortOrder row-major`.** The compositing loop always filled column-by-column and only
  swapped its bounds, so on a square grid `row-major` and `column-major` produced identical
  output, and on a non-square grid `row-major` misplaced images.
- **`.jpeg` files.** The extension filter was a substring test for `.jpg`, which does not match
  `.jpeg`, so those files were silently ignored. Uppercase extensions were dropped too.
- **`--sortParameter value`** now means true HSV value. The original called its conversion HSV
  but computed HSL, so `value` was really lightness — still available as the separate
  `lightness` key.

### Added

- Sort methods `banded`, `hilbert` and `perceptual`, multi-key sorting with a filename tiebreak,
  and descending order.
- `--colorMethod dominant`: real median-cut dominant-colour extraction, as an alternative to the
  single-pixel average.
- Per-image colour analysis cache, animated GIF output, watch mode, interactive mode.
- Rebuilt terminal UI: progress bars, coloured output, a true-colour swatch preview strip,
  `--quiet`/`--verbose`.
- `colorgrid fetch`: downloads album cover art from Spotify (Client Credentials flow), with
  automatic fuzzy matching, duplicate detection against the existing collection, rate-limit
  handling, and a review report. See the rationale comments in `lib/spotify/` for the matching
  and retry design.
