# JukeBot P2P

Listen to YouTube or YouTube Music in sync with friends, browser to browser. A spiritual successor to [JukeBot](https://github.com/TheConnMan/jukebot), without the server.

## Install

1. Download the zip from the latest [GitHub Release](https://github.com/TheConnMan/jukebot-p2p/releases/latest).
2. Unzip it.
3. Open chrome://extensions.
4. Turn on Developer mode.
5. Choose Load unpacked.
6. Pick the unzipped folder.
7. After you update, reload the extension card on chrome://extensions.

To release a version, bump the version in manifest.json, add a CHANGELOG.md entry for it, and push a tag vX.Y.Z.

## Use

1. Open a video on youtube.com or music.youtube.com, click the extension, and choose Start a room here. A room name is optional. If you type one, the room code starts with that name (lower case, with spaces turned into hyphens) and ends with random characters so other people cannot guess it. Leave the name blank for a fully random code.
2. Copy the invite link and send it to a friend who has the extension. The link is the site's home page plus the room code, and it works before any video is playing. Opening it joins the room and opens whatever video the room is on. Older links that already include a video still work, and so does pasting a bare room code.
3. Play, pause, seek or pick another video in either browser and everyone follows.
4. Queue videos by right-clicking any YouTube link (or a YouTube watch page) and choosing Add to JukeBot queue, by pasting a link into the side panel, or with Add this tab's video in the popup. When a video ends the room plays the next one, or follows the site's own autoplay if the queue is empty. Skip jumps the room to the next queued video.
5. Choose Open chat in the popup to open Chrome's side panel. It shows who is here, the queue, and a chat log with activity lines (who paused, skipped, added and so on) and typing indicators. Set your name at the top. Everyone gets their own color, and your messages are marked (you). Enter sends a message and Shift+Enter starts a new line.
6. While the side panel is closed, the toolbar badge counts unread messages in red and desktop notifications announce chat and new songs. Desktop notifications also announce people joining and leaving. The Notify switches at the bottom of the panel turn each kind off.

## How it works

There is no JukeBot server. The browsers find each other through [Trystero](https://github.com/dmotz/trystero) over public Nostr relays, which only carry the encrypted WebRTC handshake (the room code is the encryption password). After that, room state flows directly between browsers over a WebRTC data channel. Video and audio never leave YouTube: each person's own YouTube tab plays the video, and the extension only moves its play, pause, seek and video id.

The offscreen document (`offscreen.js`) holds the room and its state. The content script (`content.js`) drives the page's video player. Every change bumps a revision number and the highest revision wins, so no peer is the host.

Two browsers behind strict (symmetric) NATs may fail to connect directly; that would need a TURN relay, which this does not ship.

## Test

`npm install`, then `npm run test:e2e` starts two separate Chrome profiles against real YouTube and checks join, names, chat, activity lines, typing, the unread badge, pause, seek, queueing by link, skip, video change and queue advance. Set `CHROME` to the Chrome binary and `SITE=music.youtube.com` to run it against YouTube Music.

`scripts/vendor-trystero.sh` rebuilds `vendor/trystero.js`.

## Privacy and trademarks

See [PRIVACY.md](PRIVACY.md). The developer receives no data from the extension.

YouTube and YouTube Music are trademarks of Google LLC. JukeBot P2P is not affiliated with or endorsed by YouTube or Google.
