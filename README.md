# JukeBot P2P

Listen to YouTube or YouTube Music in sync with friends, browser to browser. A spiritual successor to [JukeBot](https://github.com/TheConnMan/jukebot), with peer-to-peer playback and optional public room discovery.

## Install

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/ndapkngicjifglcgjeimindjgegplelh). Chrome keeps it up to date.

To load a release build by hand instead:

1. Download the zip from the latest [GitHub Release](https://github.com/TheConnMan/jukebot-p2p/releases/latest).
2. Unzip it.
3. Open chrome://extensions.
4. Turn on Developer mode.
5. Choose Load unpacked.
6. Pick the unzipped folder.
7. After you update, reload the extension card on chrome://extensions.

To release a version, bump the version in manifest.json, add a CHANGELOG.md entry for it, and push a tag vX.Y.Z on a commit that is already on main (the release fails otherwise). That tag push creates the GitHub Release and submits the build to the Chrome Web Store for review. The store publishes it automatically once it is approved.

## Use

1. Open a video on youtube.com or music.youtube.com, click the extension, and choose Start a room here. A room name is optional. If you type one, the room code starts with that name (lower case, with spaces turned into hyphens) and ends with random characters so other people cannot guess it. Leave the name blank for a fully random code.
2. To list a room in Public rooms, turn on List publicly before starting, or use the Public switch in the room popup. Any member can change it. Visitors see the room name, current song and head count. Set Your name at the top of the popup (it is the same name the side panel shows), then choose Knock to ask to join. Knock stays disabled while the name is empty. Members see a card above the side-panel chat and can Let in or Decline. The first answer wins. A decline or two minutes without an answer shows "Nobody let you in. Try again later." Cancel withdraws a knock. Public admission stops at 12 people, and full rooms remain visible with a disabled Full button.
3. Copy the invite link and send it to a friend who has the extension. The link is the site's home page plus the room code, and it works before any video is playing. Opening it joins the room and opens whatever video the room is on. Older links that already include a video still work, and so does pasting a bare room code.
4. Play, pause, seek or pick another video in either browser and everyone follows.
5. Queue videos by right-clicking any YouTube link (or a YouTube watch page) and choosing Add to JukeBot queue, by pasting a link into the side panel, or with Add this tab's video in the popup. When a video ends the room plays the next one, or follows the site's own autoplay if the queue is empty. Skip jumps the room to the next queued video.
6. Choose Open chat in the popup to open Chrome's side panel. It shows who is here, the queue, and a chat log with activity lines (who paused, skipped, added and so on) and typing indicators. Set your name at the top. Everyone gets their own color, and your messages are marked (you). Enter sends a message and Shift+Enter starts a new line.
7. While the side panel is closed, the toolbar badge counts unread messages in red and desktop notifications announce chat and new songs. Desktop notifications also announce people joining, leaving and knocking, under the people switch. The Notify switches at the bottom of the panel turn each kind off.

## How it works

Playback and private rooms need no JukeBot server. The browsers find each other through [Trystero](https://github.com/dmotz/trystero) over public Nostr relays, which only carry the encrypted WebRTC handshake (the room code is the encryption password). After that, room state flows directly between browsers over a WebRTC data channel. Video and audio never leave YouTube: each person's own YouTube tab plays the video, and the extension only moves its play, pause, seek and video id.

The offscreen document (`offscreen.js`) holds the room and its state. The content script (`content.js`) drives the page's video player. Every change bumps a revision number and the highest revision wins, so no peer is the host.

Public rooms use a small optional directory at https://jukebot-directory.theconnman.workers.dev. It holds only a separate random lobby code, room name, now-playing title and head count. A random secret key in the shared room state owns the listing and never appears in directory results. The member with the lowest connected peer ID heartbeats every 60 seconds; a listing expires after three minutes without a heartbeat. Members also join the lobby through Trystero. A knock travels over that peer connection, and the lowest connected room peer settles competing answers. An accepted knock receives the real room code, the current video, its position and the site (youtube.com or YouTube Music) the room plays on, only on a message targeted to that visitor. Letting them in is the confirmation, so their tab joins without a prompt and opens that video on that site, wherever they knocked from. The new arrival is a normal member. Existing invites and pasted codes still join directly without knocking, including when public admission is full. Turning Public off leaves the lobby and removes the listing. Private rooms do not contact the directory; browsing Public rooms makes a directory request.

Two browsers behind strict (symmetric) NATs may fail to connect directly; that would need a TURN relay, which this does not ship.

## Test

`npm ci --prefix server` and `npm test --prefix server` run the directory tests against a real local Workers runtime with SQLite Durable Objects. CI runs these tests in the `check` job. They cover validation, capacity, key ownership, CORS, heartbeat and three-minute expiry by aging the test database records.

`npm ci`, then `CHROME=/path/to/chrome npm run test:e2e` starts three separate Chrome profiles for public discovery, a full listing, knocking under a typed name, decline, cancel, admission and landing on the room's video from a non-YouTube tab and from the other site's home page, activity, directory counts, heartbeat handoff and unlisting. It then runs the existing two-profile suite against real YouTube and checks join, names, chat, activity lines, typing, the unread badge, pause, seek, queueing by link, skip, video change and queue advance. Use `E2E_PUBLIC_ONLY=1` to run only the public scenario, `DIRECTORY_URL=http://localhost:8787` to point the browser profiles at `npx wrangler dev` in `server/`, and `E2E_ARTIFACTS` to save screenshots of the new UI. The extension URL override is stored as `directoryUrl` in local extension storage for tests. Set `SITE=music.youtube.com` to run it against YouTube Music.

`scripts/vendor-trystero.sh` rebuilds `vendor/trystero.js`.

## Deploy the public directory

The directory has its own package in `server/` and needs no extension build step or added host permission. From `server/`, run `npm ci`, then `npx wrangler deploy` with Cloudflare credentials supplied by your shell or Wrangler login. `wrangler.toml` creates `jukebot-directory` on workers.dev and one SQLite-backed Durable Object through a `new_sqlite_classes` migration. No custom domain, rate limiter or moderation endpoint is configured.

The directory caps names at 80 characters, titles at 200, keys and lobby codes at 24 to 80 safe characters, counts at 0 to 12, request bodies at 4096 bytes, and live listings at 32. The small cap and one-minute heartbeats target the Workers free tier. Cloudflare's free quotas still apply to total traffic. The API accepts `POST /rooms` with `{key, lobby, name, title, count}`, `DELETE /rooms/<key>`, and `GET /rooms`, returning only `{lobby, name, title, count}` per listing. Wrong-key updates are rejected; deleting an unknown key returns 404. Expired rows are removed on the next directory request.

Before releasing 0.5.1, update the Chrome Web Store privacy/data disclosure for public room directory data.

## Privacy and trademarks

See [PRIVACY.md](PRIVACY.md). Private rooms send nothing to the directory. Public room listings and directory requests reach the developer's directory server as described in the policy.

YouTube and YouTube Music are trademarks of Google LLC. JukeBot P2P is not affiliated with or endorsed by YouTube or Google.
