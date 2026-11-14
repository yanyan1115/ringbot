# ringbot

Dispatch work to Claude Code from your personal WeChat, then walk away: when the job is done, it phones you to report (and falls back to a text summary in WeChat if you do not pick up). Other WeChat to Claude Code bridges exist, but none of the ones we looked at call you; this one does.

> If this helps you, a Star would mean a lot to the author ⭐
>
> 如果对你有帮助，欢迎点个 Star 鼓励作者～⭐

[中文](README.md)

## What you end up with

- Send tasks to your own Claude Code from personal WeChat (text, voice, images; voice is transcribed automatically).
- It uses the official WeCom (WeChat Work) route: a self-built app plus the WeChat plugin. It never logs into a personal WeChat account. Whitelist only, no group chats.
- When Claude Code finishes, it calls you through [ringringring](https://github.com/yanyan1115/ringringring) (answered in Linphone) and reports in a sentence or two. If you miss the call it sends a text summary in WeChat. At night (default 23:00 to 08:00, editable) it only texts.
- After the call ends, WeChat shows "ᯅ 通话时长 mm:ss" (call duration), or "ᯅ 未接通" (not answered) if you did not pick up.

Everyone self-hosts. There is no hosted relay: your messages only pass through your own machine and the official WeCom API.

## Architecture

```
Personal WeChat <-> WeChat plugin <-> WeCom self-built app
                                          |  HTTPS callback
                                          v
                            Cloudflare tunnel (your subdomain)
                                          |
                                          v
          callback_server.py (127.0.0.1:8765, verify signature + AES decrypt)
                                          |  writes <state>/inbox/*.json
                                          v
          plugin/server.ts (MCP channel: polls the queue, injects into Claude Code)
                                          |  Claude calls reply -> WeCom message/send -> your WeChat
                                          |
        call log file (jsonl) <-----------+-----> ringringring phone plugin (dial / talk / hang_up)
        WECOM_CALL_LOG == RINGRINGRING_CALL_LOG            |
                                                           v
                                                    your phone (Linphone)
```

| Directory | Purpose |
|---|---|
| `plugin/` | Claude Code plugin: MCP channel (WeChat in/out, voice transcription, call bubble) plus the `report-done` skill |
| `callback/` | WeCom callback receiver (Python) |
| `systemd/` | Example units for the callback and the Cloudflare tunnel |

## Limitations, honestly

- WeCom requires a "trusted IP" for the app, and the machine that sends messages must egress from that fixed IP. Home broadband with a dynamic IP generally does not work; you need a machine with a fixed public IP (a cheap VPS is enough, and Claude Code runs well on one anyway). If you know a better way, please open an issue.
- Only message types delivered by the official callback are supported: text, image, voice, video, location, link. The official callback has no "file" type, so files cannot be received.
- You need a domain of your own (the callback URL must be HTTPS). This guide uses a Cloudflare tunnel, so no open ports are needed.
- The bubble text and the bundled skill are in Chinese; edit `server.ts` and `skills/report-done/SKILL.md` if you want another language.

## Setup

### 1. Register WeCom and create a self-built app

1. Register an enterprise on the WeCom website from a computer (individuals can register; no business license needed). Note the **CorpID** under "My Enterprise".
2. App Management -> Self-built -> Create App. The app name is the conversation name you will see in WeChat. Note the **AgentId**; the **Secret** is viewed inside the WeCom mobile app.
3. After you have the Secret, log out of or uninstall the WeCom mobile app. While it is online it grabs the messages and the WeChat plugin gets nothing.
4. My Enterprise -> WeChat Plugin: scan the QR code with your personal WeChat. The new app normally shows up in WeChat right away.

### 2. Create the env file

```bash
sudo mkdir -p /etc/wecom-agent && sudo chmod 700 /etc/wecom-agent
sudoedit /etc/wecom-agent/wecom.env      # chmod 600 after saving; if the service runs as a non-root user, chown the dir and file to that user, and also `/var/lib/wecom-agent` (where the callback writes the inbox)
```

Contents (fill in with an editor; do not paste real values into chats, issues, or shell history):

```
WECOM_CORP_ID=
WECOM_AGENT_ID=
WECOM_SECRET=
WECOM_CALLBACK_TOKEN=
WECOM_ENCODING_AES_KEY=
WECOM_ALLOWED_USERS=
```

- `WECOM_CALLBACK_TOKEN`: 32 random alphanumeric characters. `WECOM_ENCODING_AES_KEY`: 43 random alphanumeric characters (the WeCom console also has a "random generate" button).
- Local generation example: `python3 -c "import secrets,string;print(''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(43)))"`, then paste the output into the file with your editor. For `WECOM_CALLBACK_TOKEN`, change 43 to 32.
- `WECOM_ALLOWED_USERS`: **the whitelist, required.** Put your own WeCom UserID (comma-separated for several). Without it, anyone who joins your enterprise can send messages into your Claude Code. While the whitelist is empty the callback queues nothing and only logs `from=<UserID>`: send the app a message, copy your UserID from the callback log, fill it in and restart the callback.
- To check the credentials, call `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=<CorpID>&corpsecret=<Secret>`; `errcode: 0` means they are right (that URL contains a secret, so do not leave it in shell history; a small script that reads the env file is better).

### 3. Run the callback receiver

From the repo root:

```bash
sudo mkdir -p /opt/ringbot && sudo cp -r callback systemd /opt/ringbot/
cd /opt/ringbot && sudo python3 -m venv .venv && sudo .venv/bin/pip install -r callback/requirements.txt
sudo cp systemd/ringbot-callback.service.example /etc/systemd/system/ringbot-callback.service
# adjust ExecStart to your paths, then
sudo systemctl daemon-reload && sudo systemctl enable --now ringbot-callback
```

It listens on `127.0.0.1:8765` only, at the fixed path `/wecom/callback`.

### 4. Callback domain (Cloudflare tunnel)

1. Put your domain on Cloudflare and create a named tunnel in Zero Trust, with the service pointing at `http://127.0.0.1:8765` and a public hostname such as `wx.example.com`.
2. Install `cloudflared`, write the tunnel token to `/etc/wecom-agent/tunnel.env` (`TUNNEL_TOKEN=...`, mode 600), then:
   ```bash
   sudo cp systemd/ringbot-tunnel.service.example /etc/systemd/system/ringbot-tunnel.service
   sudo systemctl daemon-reload && sudo systemctl enable --now ringbot-tunnel
   ```
3. Verify: `curl -i "https://wx.example.com/wecom/callback?msg_signature=x&timestamp=1&nonce=1&echostr=x"` should return 403, and the callback log should show `GET bad signature`. That means the path works end to end.

### 5. Fill in the callback and trusted IP in the WeCom console

On the app detail page:

- Receive Messages -> Set API Receive: URL `https://wx.example.com/wecom/callback`, and the Token and EncodingAESKey from your env file, then save. WeCom sends a verification request on save; `GET verify ok` in the callback log means success.
- Developer API -> Enterprise Trusted IP: enter the public egress IP of the machine running this. A wrong value makes sending fail with errcode 60020 (the plugin hints that the trusted IP does not match this machine's egress address).

### 6. Install the Claude Code plugin

You need [bun](https://bun.sh) and `ffmpeg` (for voice transcoding). `bun` must be on the PATH of the user who runs Claude Code. The plugin runs `bun install` itself on every start (needs network); the step below just installs ahead of time.

```bash
cd plugin && bun install
```

Then load the plugin directory into Claude Code as a channel. Exact flags vary by Claude Code version; roughly:

```bash
claude --plugin-dir /path/to/ringbot/plugin \
       --dangerously-load-development-channels plugin:wecom@inline
```

(Channels are still a research preview; check `claude --help` and the official docs for your version.) The MCP server is named `wecom`. On start it reads `/etc/wecom-agent/wecom.env` and takes messages from `/var/lib/wecom-agent/inbox`, where the callback drops them. For non-default paths, `export WECOM_ENV=... WECOM_STATE=...` before launching `claude`. Only one session may load the plugin per queue, otherwise they fight over messages.

### 7. Install the phone: ringringring

Follow the README at <https://github.com/yanyan1115/ringringring> and set up Linphone on your phone. Then make both sides use the same call log file:

- ringringring side: `RINGRINGRING_CALL_LOG=/path/to/calls.jsonl` (default `~/.local/state/ringringring/calls.jsonl`)
- this plugin (in `wecom.env`): `WECOM_CALL_LOG=/path/to/calls.jsonl`

It must be the same file. When a call ends, ringringring appends one line `{"at","dir","answered","seconds","via"}`. Only lines with `"via":"wechat"` become a WeChat bubble (Claude passes `via="wechat"` to `dial` when the user asked for the call in WeChat or when reporting a job sent from WeChat); calls from other channels get none. Without `WECOM_CALL_LOG` the bubble feature is off.

The `report-done` skill loads with the plugin. Edit its "quiet hours 23:00 to 08:00" line to match your own schedule.

### 8. Test

1. Send "hello" to the app in WeChat. A `<channel source="wecom" ...>` message should appear in the Claude Code session; ask it to reply and check your WeChat.
2. Send a voice message; the session should show "(语音) 转写：..." (the transcript).
3. Dispatch a task that takes a few minutes. You should first get "收到，做完打给你" in WeChat, then a phone call when it finishes. After hanging up (or missing it), WeChat shows "ᯅ 通话时长" or "ᯅ 未接通".

## Configuration

Variables in `wecom.env` (`KEY=value`, one per line, `#` for comments):

| Variable | Default | Notes |
|---|---|---|
| `WECOM_CORP_ID` | none, required | Enterprise ID |
| `WECOM_AGENT_ID` | none, required | Self-built app AgentId |
| `WECOM_SECRET` | none, required | Self-built app Secret |
| `WECOM_CALLBACK_TOKEN` | none, required | Callback Token (used by the callback receiver) |
| `WECOM_ENCODING_AES_KEY` | none, required | Callback EncodingAESKey (used by the callback receiver) |
| `WECOM_ALLOWED_USERS` | empty | Whitelisted UserIDs, comma-separated. Set it. The first entry is also the recipient of call bubbles |
| `WECOM_CALL_LOG` | empty (off) | Call log file written by the phone plugin; `~` is expanded |
| `WECOM_STT_PROVIDER` | `openai` | `openai` (any OpenAI-compatible /audio/transcriptions, default Groq) or `elevenlabs` (Scribe, falls back to the former on failure) |
| `WECOM_STT_ENV_FILE` | empty | Path of a file holding `GROQ_API_KEY` (or `STT_KEY`); without it there is no Whisper transcription |
| `WECOM_STT_ELEVEN_ENV_FILE` | same as `WECOM_STT_ENV_FILE` | Path of a file holding `ELEVENLABS_API_KEY` |
| `WECOM_STT_URL` | `https://api.groq.com/openai/v1/audio/transcriptions` | Whisper-compatible endpoint |
| `WECOM_STT_MODEL` | `whisper-large-v3-turbo` | Whisper model name |
| `WECOM_STT_ELEVEN_MODEL` | `scribe_v1` | Scribe model name |
| `WECOM_STT_PROMPT` | empty | Transcription prompt, keep it short (for example "以下是普通话的句子。"); a long list of names can make Groq return empty text |

Process environment variables (systemd `Environment=` or the shell):

| Variable | Default | Notes |
|---|---|---|
| `WECOM_ENV` | `/etc/wecom-agent/wecom.env` | Env file path (read by both the plugin and the callback) |
| `WECOM_STATE` | `/var/lib/wecom-agent` | Plugin state dir (inbox, done, media, seen-users, seen-msgids, aliases.json) |
| `WECOM_INBOX` | `/var/lib/wecom-agent/inbox` | Queue dir the callback writes to (only the callback reads this variable); must equal the plugin's `$WECOM_STATE/inbox`, otherwise the plugin polls an empty dir. `seen-msgids` goes in its parent dir |
| `WECOM_PORT` | `8765` | Callback listen port (127.0.0.1) |
| `WECOM_API` | `https://qyapi.weixin.qq.com/cgi-bin` | WeCom API base URL |

Optional: `$WECOM_STATE/aliases.json` (mode 600) with `{"<UserID>": "alias"}`, so the session only sees the alias and never the real UserID.

## Security notes

- Official WeCom route only; no personal WeChat account login.
- Messages from anyone outside the whitelist are dropped by the callback (log line `POST from non-allowed user, dropped`), and the `reply` tool only sends to whitelisted or previously seen users.
- No group chats.
- Secrets live only in the env file (mode 600) and are never printed by the code.

## Acknowledgements

The README approach was inspired by RoronoaHaruka/wecom-companion-guide; none of its code is used here.

Written by Claude Opus 5.5.

## License

[AGPL-3.0-or-later](LICENSE).
