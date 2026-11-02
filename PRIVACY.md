# JukeBot P2P privacy policy

Last updated: November 2, 2026

JukeBot P2P is a Chrome extension that keeps a YouTube or YouTube Music video in sync between people in the same room. Playback and private rooms work peer to peer. Public rooms use a directory server operated by the developer.

## What the extension handles

1. The display name you type, and a random ID created on your browser so your own messages show as yours.
2. Chat messages you type in a room.
3. The video ID, title, playback position and play or pause state of the YouTube or YouTube Music tab you share with a room, and the videos you add to the room's queue.
4. Your notification settings.
5. Whether a room is public, its display name, a separate random lobby code and a secret directory listing key.
6. A visitor's name when they knock on a public room, and a member's answer.

## Where it goes

Your name, ID and notification settings are stored only in your browser (Chrome extension storage).

Room data (your name, chat, queue and playback state) is sent to the other people in the same room, directly between browsers over an encrypted WebRTC connection. To find each other, browsers exchange an encrypted connection handshake through public Nostr relays. The relays cannot read the handshake, which is encrypted with the room code. As with any direct connection, people in the room and the relays can see your IP address. Public STUN servers are used to discover your public address.

To show a video's title, the extension asks YouTube's public oEmbed endpoint for it.

Private rooms send nothing to the developer's directory server. When you make a room public, the extension sends the room name, now-playing title, head count, separate lobby code and secret listing key to https://jukebot-directory.theconnman.workers.dev. The server receives the requester's IP address through the network request. Browsing the public directory also sends a request and its IP address to that server. Cloudflare hosts it and processes these requests. The directory database stores the listing fields and last heartbeat time, not IP addresses. Cloudflare may process request metadata as part of hosting the service.

Anyone browsing Public rooms can see the room name, now-playing title, head count and lobby code. The directory never publishes the listing key or real room code, and it does not receive chat, queue history or visitor names. Listings are refreshed once a minute and stop appearing three minutes after their last heartbeat; expired database rows are removed on the next directory request. Turning Public off or the final member leaving attempts to delete the listing immediately.

Knock names and answers travel directly between lobby peers. Accepting a visitor sends the real room code only to that visitor. Room members can see each other's IP addresses, and lobby peers can also see each other's IP addresses. There is no moderation or member removal.

The developer does not sell this data or use it for advertising, credit decisions or any purpose other than room discovery and listening. Chat and shared room data remain in browser memory only while you are in the room.

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Contact

Questions: open an issue at https://github.com/TheConnMan/jukebot-p2p/issues
