# Changelog

## 0.3.2

Removed the left bar and tint on your own chat messages; "(you)" after your name still marks them.

## 0.3.1

Bug fixes: opening an old invite link no longer switches the room to that link's video; a skip logs one line; activity lines have no time and stay activity lines in history sent to late joiners; history sent on join no longer fires notifications or unread counts.

## 0.3.0

1. Who is here: the side panel lists everyone in the room by name, and the log shows when people join, leave or rename. Each person keeps one color everywhere (names, queue, typing line), and your own messages say (you) and carry a left border.
2. Activity lines in the chat log, JukeBot style: started, paused, resumed, jumped to a time, added, removed, skipped and now playing. People who join later see them too.
3. Skip: jump the whole room to the next queued video, from the popup or the side panel.
4. Easier queueing: right-click any YouTube or youtu.be link, or a YouTube watch page, and choose Add to JukeBot queue. The side panel also takes a pasted link. Queued videos show their title, who added them, their length and roughly when they will play.
5. Notifications: the toolbar badge counts unread chat in red while the side panel is closed, and desktop notifications cover chat, songs others add or start, and people joining or leaving. Each kind can be switched off in the side panel.
6. Typing indicators in the side panel.
7. The chat box grows as you type (up to about six lines). Enter sends and Shift+Enter starts a new line; messages keep their line breaks.

New permissions: context menus and notifications.

Fixes: a queue or title change no longer pulls playback back to where it was at the last play, pause or seek. Invite links opened on music.youtube.com now join the room; YouTube Music dropped the invite part of the link before the extension could read it.

## 0.2.1

Your chat identity is now stable: a per-profile ID saved with your name, so your own messages stay marked as yours after you rejoin.

## 0.2.0

Chat in Chrome's side panel, sent browser to browser. Someone who joins late gets the recent messages from the people already in the room.

Fix: when a video ended and the room moved to the next queued video, a browser whose own video ended a moment later could send YouTube's autoplay pick to the room instead.

## 0.1.0

First version: rooms with invite links, synced play, pause, seek and video, and a shared queue.
