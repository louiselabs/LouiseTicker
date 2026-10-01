# LouiseTicker

Subscribe to RSS feeds, browse them in a modular tabbed interface, pick the stories you want, and LouiseTicker compiles them into an **output RSS feed** for a TV news ticker. It also serves JSON, plain text and a ready-made on-air ticker page.

No dependencies: all you need is [Node.js](https://nodejs.org) 18 or newer.

## Start

- Double-click **`start.bat`**, or run `npm start`
- Open <http://localhost:4400> and log in. The first start creates two accounts, **admin / password** and **journalist / password**. Change both passwords straight away (account menu, top right).

Use **`start-lan.bat`** (or `npm run start:lan`) when the ticker or playout machine is a different computer. The control panel, feeds and ticker page can then be reached on your network. Everyone logs in with their own account. The connection is plain HTTP, so use this on a trusted studio network only.

Your data is saved in `data/louiseticker.json`.

## Using it

1. **Add feeds** with **＋ Add feed**. Paste a feed URL, or just a website address and the feed is found automatically. You can also use the quick-add presets or import an OPML file.
2. Each feed opens as a **tab**. **★ All stories** merges every feed, newest first, with duplicate headlines hidden.
3. **Click a story** to add it to the current output, and click it again to remove it. **⚡** adds it as *breaking*. You can also **drag** a story into the output list to put it at a specific position.
4. The **output panel** on the right is your ticker playlist:
   - drag to reorder
   - double-click a headline (or ✎) to rewrite it for air; ↺ restores the original
   - ⚡ breaking · ⏸ hold (keep it in the list but off air) · ⏰ timing · ✕ remove
   - changes wait in the preview until you press **TAKE** (see below)
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
- breaking label and breaking-first ordering, or sort by newest instead of manual order
- auto-expire after N hours
- **auto-add keywords**: new stories that match are added automatically, and you can limit this to chosen feeds. Matches are highlighted in the lists. `*` works as a wildcard.
- **block keywords**: stories that match are never auto-added and are dimmed in the lists

"Copy to output…" copies the current playlist into another output.

### Preview → TAKE
Edits don't go straight to air. The output list is the **preview**, and the ticker, RSS, JSON and TXT outputs show the **program** (what is on air). It works like a vision mixer:

- Items in the list are marked **NEW** or **CHANGED** compared with what is on air. Items that will disappear are listed under "Removed on TAKE".
- Press **TAKE** (or `Ctrl+Enter`) to put the preview on air. The button shows how many changes are waiting and pulses while there are some. **Revert** throws the preview changes away.
- The bottom of the window is a two-row multiviewer: **PVW** (preview) above **PGM** (on air).
- Some things go on air without TAKE: schedule windows opening and closing, end times, live weather values, and feed label or colour changes.
- If you prefer the old behaviour, tick **Direct mode** in ⚙ output settings.

### Timing (scheduling)
Click **⏰** on any item, or before adding a custom line, to set:
- **Start**: now, or at a date and time.
- **End**: never, after 15 min to 24 h, or at a date and time.
- **Daily window**: e.g. 07:00–09:00 on weekdays. A window can run past midnight (22:00–02:00), and the same time twice means all day.

Each item shows its timing and whether it is on air now. Items outside their window are dimmed. Daily windows follow the ticker clock's time zone (set in the designer). Scheduled items go on and off air by themselves, within about 20 seconds.

### Live weather (Open-Meteo)
**🌤 ＋ Live weather** adds a line that keeps itself up to date:
- Search for places and add several.
- Choose one combined line ("Météo : Paris 21° 🌤️ (16°/21°) · Lyon 21° ☁️") or one line per place.
- Choose what to show: now, today's min/max, tomorrow, wind. Units are °C/°F, the language French or English, and icons can be switched on or off.

The text refreshes every 10 minutes. If Open-Meteo is unreachable, the last values stay on air. Click ✎ on the line to change it.

Open-Meteo's free API is for **non-commercial use**. For a broadcast channel, take a commercial plan at open-meteo.com and paste the key in **⚙ Settings → Live data**, or set the `OPENMETEO_API_KEY` environment variable. The key stays on the LouiseTicker computer.

### Categories
Stories can carry a ticker category such as *Sport*, *Weather* or *Politics*, each with its own colour. Categories are set in three ways, and the earlier ones in this list win:

1. **By hand.** When you add a story (click, ⚡, drag, or "add all"), a small pop-up asks for its category. Press `1`–`9` or click to pick, `0` for none, `Enter` to accept the highlighted suggestion, or `Esc` to cancel. You can change it later by clicking the category chip in the output list. Custom lines have their own category menu.
2. **Per feed.** In a feed's settings (⚙ on its tab), choose one category for all its stories. This suits single-topic feeds such as a sport or weather feed.
3. **Automatically.** A category's *match words* are looked for in the story's RSS `<category>` tags and in its web address (e.g. `/sport/`). The first category in the list that matches wins.

In **⚙ Settings → Ticker categories** you can switch off the pop-up ("Ask for a category each time I add a story") and the automatic guessing ("Guess categories from RSS tags and links"). With guessing off, only feed categories and your own choices are used. Edit the list there too. There you can rename, recolour, change match words and reorder for priority, and each category shows how many stored stories it currently catches. Story cards in the feed tabs show the category a story will get.

Some feeds (BBC News, for example) carry no category tags, and their links don't name a section, so their general stories stay uncategorised unless you set a feed category or pick one by hand.

On the ticker, categories appear as a coloured badge or coloured word before the headline. In one-at-a-time mode they can also appear **in the label block**, which then switches per headline, e.g. a green "SPORT" or a yellow "BUSINESS". You choose this in the designer under **Labels**. The RSS feed gets a `<category>` per item, and text outputs read "Sport | BBC: headline".

## Output endpoints

| URL | Format |
|---|---|
| `/out/<id>.rss` | RSS 2.0 (breaking label and source prefix are baked into `<title>`) |
| `/out/<id>.json` | JSON with `title`, `headline`, `text`, `source`, `sourceColor`, `breaking` per item |
| `/out/<id>.txt` | One line with all headlines joined by the separator |
| `/ticker?out=<id>` | Full-screen scrolling ticker (browser source for OBS / vMix / CasparCG) |
| `/feed.rss` | Shortcut for the first output |

The default output id is `main`. Every endpoint sends `Access-Control-Allow-Origin: *`.

### Ticker designer
Open the **🎨** button next to the output selector to design how the ticker looks. A live 1920×1080 preview shows sample headlines if nothing is on air, and nothing changes on air until you press **Save & go live**. All screens showing the output then update within a couple of seconds. The designer covers:

- **Display**: *continuous crawl*, or *one at a time* with a time per headline and a slide, push, fade or cut transition. In one-at-a-time mode, **breaking news cuts in immediately** when it's flagged, and the label switches to the breaking label only while a breaking headline is on screen. Breaking items then come back after every N other headlines (you set N; *in turn* means no extra repeats). In one-at-a-time mode, single-line headlines too long for the bar scroll through to the end before the next one. You can also allow **multi-line headlines** (up to 4 lines). With automatic bar height, the bar either always fits the maximum number of lines or grows with each headline. With a fixed bar height, text that doesn't fit shrinks slightly and then ends with "…".
- **Labels**: how to show the category (badge, coloured word, in the label block, or not at all) and the source (badge, text before, text after, or not at all).
- **Layout**: top or bottom of the screen, bar height, distance from the screen edges, rounded corners, label block on/off and its text, an optional logo image, drop shadow.
- **Text**: font (any font installed on the ticker computer, plus a few Google fonts that need an internet connection), size and weight.
- **Colours**: bar, text, label, clock, separators and breaking, source badges, bar opacity (0 % gives a transparent overlay), breaking pulse.
- **Clock**: on/off, 12- or 24-hour format, time zone, label, seconds.
- **Themes**: one-click starting points (Classic red, Midnight, Daylight, Sport, Royal, Floating, Full width), plus *Reset to default*.

The designer also shows the browser-source URL to copy into OBS, vMix or CasparCG.

### Ticker page options
The URL options below override the designer settings for one screen only:
`/ticker?out=main&mode=flip&flip=6&transition=slide&speed=110&size=34&bg=0b0d12&fg=ffffff&accent=e5383b&label=NEWS&position=bottom&font=Arial`

- `mode=crawl|flip` sets the display mode. `flip` is the number of seconds per headline, and `transition` is `slide`, `push`, `fade` or `none`.
- `bg=transparent` gives an overlay.
- `label=none` hides the label block.
- The clock follows the output's clock settings. On one ticker page you can override them with `clock=0` (hide), `clock=12` or `clock=24` (format), `tz=America/New_York`, `clocklabel=NYC` and `seconds=1`. This lets you run, say, a Paris ticker and a New York ticker from the same output.
- `source=badge|prefix|suffix|none` and `category=badge|text|label|none` override the designer's label settings for this ticker page only.
- `lines=2` (up to 4) allows multi-line headlines in one-at-a-time mode, and `grow=1` makes the bar grow with each headline.
- `sourcecolor=e5383b` gives every source badge the same colour instead of each feed's own colour.
- `position=top|bottom|fill` sets where the bar sits.
- The label switches to the breaking label and pulses while breaking items are on air.
- Changes appear live. In crawl mode they wait for the end of a scroll loop so the text never jumps, and in one-at-a-time mode they appear with the next headline.

## Accounts and roles
Everyone logs in with a username and password. There are two roles:

| | Journalist | Admin |
|---|:-:|:-:|
| Browse feeds, pick, edit, reorder and remove stories, breaking, hold, timing | ✓ | ✓ |
| Custom lines and live weather lines | ✓ | ✓ |
| **TAKE** / Revert | ✓ | ✓ |
| Subscribe to feeds, edit feeds, import OPML | ✓ | ✓ |
| Categories (on stories and the category list) | ✓ | ✓ |
| Keyword rules (auto-add / block) | ✓ | ✓ |
| Copy items to another output, read the as-run log | ✓ | ✓ |
| Global settings (refresh interval, category guessing, Open-Meteo key) | | ✓ |
| Create / delete outputs, output formatting, Direct mode | | ✓ |
| Ticker designer (look, layout, display mode, labels, clock) | | ✓ |
| Accounts: create journalists or admins, reset passwords, disable, delete | | ✓ |
| Export the as-run log as CSV | | ✓ |

Some details:
- Admins manage accounts from the account menu (top right) → **Manage accounts…**. Everyone can change their own password there.
- Disabling an account, deleting it or resetting its password logs it out everywhere. LouiseTicker always keeps at least one active admin.
- Passwords are stored as salted scrypt hashes. Sessions last 12 hours from your last action, and survive a restart of LouiseTicker.
- After 10 wrong passwords from one address, logging in from there is paused for 10 minutes.
- The ticker system's addresses (`/out/…` and `/ticker`) stay public, so OBS, vMix and CasparCG need no login.

## As-run log
**📋 As-run** shows who did what and what went on air, newest first. You can filter by day, type, output, account or text. Admins can export it as CSV (opens in Excel). It records:
- **TAKEs**: who, when, what went on and off, and the full list now on air.
- **Scheduled items** going on or off air, and items reaching their end time (account *system*).
- Stories added, edited, removed or reordered, including headline rewrites, breaking, hold, category and timing changes. Stories added by keyword rules are recorded as *keyword rule*.
- Logins, logouts and failed logins (with the address), and password and account changes.
- Feeds, categories, keyword rules, settings, outputs and design changes.

Each item in the output list also shows who added it and who last edited it. The log is stored in `data/louiseticker-asrun.jsonl`, one line per event, and is never trimmed automatically.

## Keyboard
`/` search · `R` refresh all · `A` add feed · `S` split · `1`–`9` switch tab · `[` `]` previous / next tab

## Configuration (environment variables)
- `PORT` (default `4400`)
- `LAN=1`: listen on all network interfaces
- `HOST`: the address to listen on
- `DATA_FILE`: where the data is stored

## Tests
`npm test` runs the parser smoke tests.
