# Changelog

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
