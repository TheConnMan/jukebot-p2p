# JukeBot P2P privacy policy

Last updated: October 31, 2026

JukeBot P2P is a Chrome extension that keeps a YouTube or YouTube Music video in sync between people in the same room. It has no server, and the developer receives no data from it.

## What the extension handles

1. The display name you type, and a random ID created on your browser so your own messages show as yours.
2. Chat messages you type in a room.
3. The video ID, title, playback position and play or pause state of the YouTube or YouTube Music tab you share with a room, and the videos you add to the room's queue.
4. Your notification settings.

## Where it goes

Your name, ID and notification settings are stored only in your browser (Chrome extension storage).

Room data (your name, chat, queue and playback state) is sent only to the other people in the same room, directly between browsers over an encrypted WebRTC connection. To find each other, browsers exchange an encrypted connection handshake through public Nostr relays. The relays cannot read the handshake, which is encrypted with the room code. As with any direct connection, people in the room and the relays can see your IP address. Public STUN servers are used to discover your public address.

To show a video's title, the extension asks YouTube's public oEmbed endpoint for it.

The developer does not collect, receive, store, sell or share any of this data, and it is not used for advertising, credit decisions or any purpose other than the listening room. Chat and room data are kept in memory only while you are in the room.

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Contact

Questions: open an issue at https://github.com/TheConnMan/jukebot-p2p/issues
