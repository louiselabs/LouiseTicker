# LouiseTicker

Subscribe to RSS feeds, browse them in a modular tabbed interface, pick the stories you want, and LouiseTicker compiles them into an **output RSS feed** for a TV news ticker. It also serves JSON, plain text and a ready-made on-air ticker page.

No dependencies: all you need is [Node.js](https://nodejs.org) 18 or newer.

## Start

- Double-click **`start.bat`**, or run `npm start`
- Open <http://localhost:4400>

Use **`start-lan.bat`** (or `npm run start:lan`) when the ticker or playout machine is a different computer. The feeds and ticker page can then be reached on your network, and editing is still only allowed from this computer.

Your data is saved in `data/louiseticker.json`.

## Using it

1. **Add feeds** with **＋ Add feed**. Paste a feed URL, or just a website address and the feed is found automatically. You can also use the quick-add presets or import an OPML file.
2. Each feed opens as a **tab**. **★ All stories** merges every feed, newest first, with duplicate headlines hidden.
3. **Click a story** to add it to the current output, and click it again to remove it. **⚡** adds it as *breaking*. You can also **drag** a story into the output list to put it at a specific position.
4. The **output panel** on the right is your ticker playlist:
   - drag to reorder
   - double-click a headline (or ✎) to rewrite it for air; ↺ restores the original
   - ⚡ breaking · ⏸ hold (keep it in the list but off air) · ⏱ auto-expire · ✕ remove
   - type **custom lines** (weather, promos, "coming up…") that aren't from any feed
5. Point the ticker system at the output URL shown above the list.

### Modular layout
- **◫ Split** opens up to 4 side-by-side panes, and each pane has its own tab.
- Drag tabs to reorder them. Drop a tab onto another pane's story list to show it there.
- Close tabs with ✕ (or middle-click) and bring them back with ▾. Closing a tab doesn't unsubscribe the feed.
- Tabs show a red badge counting new stories, and new stories are marked **NEW**.

### Outputs
You can have several outputs, for example *Main*, *Sport* and *Breaking only*. Each one has its own URLs and settings (⚙ next to the output selector):

- channel title and description
- max items on air, max headline length, ALL CAPS
- **show the source**: as a coloured badge (in the feed's colour), as text before the headline ("BBC: …") or after it ("… (BBC)"), or not at all. The source is the feed's editable *ticker label*. RSS and TXT can't carry colour, so there the badge becomes "BBC: …".
- breaking label and breaking-first ordering, or sort by newest instead of manual order
- auto-expire after N hours
- **auto-add keywords**: new stories that match are added automatically, and you can limit this to chosen feeds. Matches are highlighted in the lists. `*` works as a wildcard.
- **block keywords**: stories that match are never auto-added and are dimmed in the lists

- **clock** on the ticker page: show or hide it, 12- or 24-hour format, any time zone (or the ticker computer's own time), an optional label such as "PARIS", and seconds

"Copy to output…" copies the current playlist into another output.

## Output endpoints

| URL | Format |
|---|---|
| `/out/<id>.rss` | RSS 2.0 (breaking label and source prefix are baked into `<title>`) |
| `/out/<id>.json` | JSON with `title`, `headline`, `text`, `source`, `sourceColor`, `breaking` per item |
| `/out/<id>.txt` | One line with all headlines joined by the separator |
| `/ticker?out=<id>` | Full-screen scrolling ticker (browser source for OBS / vMix / CasparCG) |
| `/feed.rss` | Shortcut for the first output |

The default output id is `main`. Every endpoint sends `Access-Control-Allow-Origin: *`.

### Ticker page options
`/ticker?out=main&speed=110&size=34&bg=0b0d12&fg=ffffff&accent=e5383b&label=NEWS&clock=1&position=bottom&font=Arial`

- `bg=transparent` gives an overlay.
- `label=none` hides the label block.
- The clock follows the output's clock settings. On one ticker page you can override them with `clock=0` (hide), `clock=12` or `clock=24` (format), `tz=America/New_York`, `clocklabel=NYC` and `seconds=1`. This lets you run, say, a Paris ticker and a New York ticker from the same output.
- `source=badge|prefix|suffix|none` overrides the output's "Show the source" setting for this ticker page only.
- `sourcecolor=e5383b` gives every source badge the same colour instead of each feed's own colour.
- `position=top|bottom|fill` sets where the bar sits.
- The label switches to the breaking label and pulses while breaking items are on air.
- Changes appear live, but only at the end of a scroll loop, so the text never jumps.

## Keyboard
`/` search · `R` refresh all · `A` add feed · `S` split · `1`–`9` switch tab · `[` `]` previous / next tab

## Configuration (environment variables)
- `PORT` (default `4400`)
- `LAN=1`: listen on all network interfaces
- `HOST`: the address to listen on
- `ALLOW_REMOTE_ADMIN=1`: also allow editing from other machines. There is no login, so use this only on a trusted network.
- `DATA_FILE`: where the data is stored

## Tests
`npm test` runs the parser smoke tests.
