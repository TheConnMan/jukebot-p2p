# JukeBot P2P

Listen to YouTube or YouTube Music in sync with friends, browser to browser. A spiritual successor to [JukeBot](https://github.com/TheConnMan/jukebot), without the server.

## Use

1. Open a video on youtube.com or music.youtube.com, click the extension, and choose Start a room here.
2. Copy the invite link and send it to a friend who has the extension. Opening the link joins the room.
3. Play, pause, seek or pick another video in either browser and everyone follows. Add videos to the shared Up next queue from the popup; when a video ends the room plays the next one, or follows the site's own autoplay if the queue is empty.

## How it works

There is no JukeBot server. The browsers find each other through [Trystero](https://github.com/dmotz/trystero) over public Nostr relays, which only carry the encrypted WebRTC handshake (the room code is the encryption password). After that, room state flows directly between browsers over a WebRTC data channel. Video and audio never leave YouTube: each person's own YouTube tab plays the video, and the extension only moves its play, pause, seek and video id.

The offscreen document (`offscreen.js`) holds the room and its state. The content script (`content.js`) drives the page's video player. Every change bumps a revision number and the highest revision wins, so no peer is the host.

Two browsers behind strict (symmetric) NATs may fail to connect directly; that would need a TURN relay, which this does not ship.

## Test

`npm install`, then `npm run test:e2e` starts two separate Chrome profiles against real YouTube and checks join, pause, seek, video change and queue advance. Set `CHROME` to the Chrome binary and `SITE=music.youtube.com` to run it against YouTube Music.

`scripts/vendor-trystero.sh` rebuilds `vendor/trystero.js`.
