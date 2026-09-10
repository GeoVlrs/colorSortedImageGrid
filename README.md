# colorSortedImageGrid

Sorts a folder of images by colour into one NxM grid image. Also fetches the cover art to fill
that folder, from Spotify.

![Example Output Image](exampleOutput.gif)

Originally by [Zach Fox](https://github.com/zfox23/colorSortedImageGrid). See
[CHANGELOG.md](CHANGELOG.md) for what changed in this version.

## Setup

Requires Node 18+.

```bash
npm install
node index.js --help
```

## Sorting

```bash
node index.js                             # sort ./images by hue into a square grid
node index.js -i ./images/test --sortMethod hilbert
node index.js --interactive               # pick options through prompts
```

`--interactive` asks a handful of questions, then offers the rest by section — output, grid and
canvas, sorting details, colour, animation, run mode, performance — so every flag below is
reachable without memorising any of them. It prints the equivalent command at the end, and can save
the answers as a `--config` preset.

| `--sortMethod` | What it does | Best for |
| --- | --- | --- |
| `numeric` (default) | plain sort on one or more `--sortParameter` keys | predictable, supports tiebreak keys |
| `banded` | quantise into bands, sort by a secondary key within each | fixing streaky hue sorts |
| `hilbert` | 3D Hilbert curve through Lab | the smoothest overall gradient |
| `perceptual` | greedy nearest-neighbour walk, CIEDE2000 | the smoothest neighbour-to-neighbour transitions |

Sort keys: `hue`, `saturation`, `value`, `lightness`, `luma`, `labL`, `labA`, `labB`, `dateTaken`,
`filename`.

```bash
node index.js -p hue,luma                                     # tiebreak on luma
node index.js --sortMethod hilbert -d                         # reverse
node index.js --sortMethod banded --sortBands 12 --serpentine # banded, flowing across bands
```

`--sortOrder row-major|column-major` sets the grid fill direction; it's independent of the sort.

## Colour and output

`--colorMethod average|dominant` picks how each image's colour is measured.
`--visualizationMode normal|4x4|dominant` picks what each cell shows.

```bash
node index.js -o ./output/grid.png
node index.js -o files                            # numbered files instead of a grid
node index.js --exportPalette ./output/palette.css
node index.js --padding 12 --borderWidth 3 --background white
```

## Animation

Three GIF modes, chosen with `--animateMode`:

| Mode | What it does | Typical output |
| --- | --- | --- |
| `build` | Reveals the grid one tile at a time, then holds on the finished result | ~145 frames, a few hundred KB |
| `morph` | Tiles fly from filename order into colour order | ~76 frames, a few MB |
| `sweep` (default) | Hard-cuts between values of one setting | one frame per value |

```bash
node index.js --animateMode build                  # the grid assembling itself
node index.js --animateMode morph                  # chaos resolving into a gradient
node index.js --animate --animateOver sortMethod   # sweep through each sort method
```

`--animateFps` (default 25) sets the frame rate, and `--animateHoldMs` how long the finished result
lingers. Morph takes `--morphSeconds` and `--morphStagger` (0 moves every tile at once; the default
0.3 sends them off in a wave). Build takes `--revealPerFrame`, which otherwise auto-scales so a
large collection stays under 240 frames.

Note that GIF stores frame delays in 10ms steps, so 24fps is not representable — ask for it and you
get 25fps, with a line saying so. `build` stays small because each frame encodes only the one tile
that changed; `morph` repaints everything every frame, so keep `--animateWidth` modest for it.

## Watch, dry runs, config

```bash
node index.js --watch                              # re-render whenever the input folder changes
node index.js --dryRun                             # show the plan, write nothing
node index.js --config ./preset.json               # load flags from a JSON file
```

`--watch` and an animation are mutually exclusive. A preset is a JSON object keyed by flag name;
`--interactive` will write one for you.

## Performance and terminal output

Colour analysis is cached between runs (`--no-cache` to disable). `--concurrency` controls
parallelism. `--verbose`/`--quiet` control how much gets printed.

## Fetching cover art from Spotify

```bash
cp .env.example .env    # fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
node index.js fetch --artist "Radiohead" --album "Kid A"
node index.js fetch --input albums.csv --dryRun     # check matches before downloading
```

Get credentials from the [Spotify dashboard](https://developer.spotify.com/dashboard) (Client
Credentials flow — no user login). `.env` is gitignored.

Ambiguity is resolved automatically so a batch never stops to ask; anything short of an exact
match is written to a review report (`./output/spotify-fetch-report.json`, or Markdown for a
`.md` path). `--minConfidence` (default 0.72) sets the bar — see `lib/spotify/match.js` for how
matches are scored.

Filenames default to `Artist - Album.jpg` (`--filenameTemplate '{album}'` for album-only). Before
downloading, each album is checked against what's already in the destination folder — `--force`
to re-download, `--onDuplicate skip|ignore` to change the policy, `--aliases file.json` to map
hand-abbreviated existing filenames. See `lib/spotify/naming.js` for how that comparison works.

Requests run concurrently with automatic rate-limit handling and token refresh (details in
`lib/spotify/client.js`); a failed album is reported and skipped without stopping the batch.

## Tests

```bash
npm test
```

## Licence

MIT, as the original.
