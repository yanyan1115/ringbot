# ringbot

在个人微信里给 Claude Code 派活，然后人可以走开：活干完了，它会给你打电话报完工（没接就在微信里发一段文字总结）。微信接 Claude Code 的方案已经有好几份，我们看过的几份都不会打电话；这个会。

> 如果对你有帮助，欢迎点个 Star 鼓励作者～⭐
>
> If this helps you, a Star would mean a lot to the author ⭐

[English](README.en.md)

## 你最后会得到什么

- 在个人微信里给自己的 Claude Code 发活（文字、语音、图片都行；语音自动转文字）。
- 走的是企业微信「自建应用」＋微信插件这条官方路线：不扫码登录个人微信号；只认白名单里的人，不接群。
- Claude Code 干完活，用 [ringringring](https://github.com/yanyan1115/ringringring)（Linphone 接听）打电话给你报一句结果；没接通就在微信里发文字总结；夜里（默认 23:00～08:00，可改）只发文字不打。
- 挂断后微信里自动出一条「ᯅ 通话时长 mm:ss」，没接通出「ᯅ 未接通」。

每个人自己部署，没有任何托管的中转服务：你的消息只经过你自己的机器和企业微信官方接口。

## 架构

```
个人微信 <-> 微信插件 <-> 企业微信「自建应用」
                              |  HTTPS 回调
                              v
                    Cloudflare 隧道 (你的子域名)
                              |
                              v
        callback_server.py (127.0.0.1:8765，验签 + AES 解密)
                              |  写入 <state>/inbox/*.json
                              v
        plugin/server.ts (MCP channel，轮询队列，注入 Claude Code 会话)
                              |  Claude 调 reply 工具 -> 企业微信 message/send -> 你的微信
                              |
     通话记录文件 (jsonl) <---+---> ringringring 电话插件 (dial / talk / hang_up)
     WECOM_CALL_LOG == RINGRINGRING_CALL_LOG        |
                                                    v
                                                 你的手机 (Linphone)
```

仓库内容：

| 目录 | 作用 |
|---|---|
| `plugin/` | Claude Code 插件：MCP channel（收发微信、语音转文字、通话气泡）＋ `report-done` skill（做完怎么报） |
| `callback/` | 企业微信回调接收程序（Python） |
| `systemd/` | 回调程序和 Cloudflare 隧道的 systemd 示例单元 |

## 先说清楚的限制

- 企业微信要求给应用配置「企业可信 IP」，发消息的机器出口必须是这个固定 IP。家用宽带的动态 IP 基本不行，需要一台有固定公网 IP 的机器（一台便宜的 VPS 就够，Claude Code 本来也适合跑在 VPS 上）。如果你有更好的办法欢迎提 issue。
- 只支持企业微信官方回调能收到的消息：文字、图片、语音、视频、位置、链接。官方回调没有「文件」类型，收不到文件。
- 需要有一个自己的域名（回调地址要 HTTPS），本文用 Cloudflare 隧道，不用开端口。

## 安装

### 1. 注册企业微信，建自建应用

1. 用电脑打开企业微信官网注册一个企业（个人也能注册，不需要营业执照）。记下「我的企业」里的 **企业 ID（CorpID）**。
2. 「应用管理」->「自建」->「创建应用」：名字就是你在微信里看到的会话名。记下 **AgentId**；**Secret** 在企业微信 App 里查看。
3. 拿完 Secret 后，把手机上的企业微信 App 退出登录或卸载。它在线会把消息抢走，微信插件就收不到了。
4. 「我的企业」->「微信插件」：用个人微信扫码关注，新建的应用一般会直接出现在微信里。

### 2. 准备配置文件

```bash
sudo mkdir -p /etc/wecom-agent && sudo chmod 700 /etc/wecom-agent
sudoedit /etc/wecom-agent/wecom.env      # 保存后 chmod 600；服务用非 root 用户跑的话，目录和文件 chown 给那个用户；`/var/lib/wecom-agent`（回调写 inbox 的地方）也要 chown 给它
```

内容（用编辑器填，不要把真实值贴进聊天、issue 或命令历史）：

```
WECOM_CORP_ID=
WECOM_AGENT_ID=
WECOM_SECRET=
WECOM_CALLBACK_TOKEN=
WECOM_ENCODING_AES_KEY=
WECOM_ALLOWED_USERS=
```

- `WECOM_CALLBACK_TOKEN`：32 位随机字母数字；`WECOM_ENCODING_AES_KEY`：43 位随机字母数字（企业微信后台也有「随机获取」按钮）。
- 本地生成示例：`python3 -c "import secrets,string;print(''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(43)))"`，输出直接用编辑器粘进文件；`WECOM_CALLBACK_TOKEN` 把 43 换成 32。
- `WECOM_ALLOWED_USERS`：**白名单，必填**。填你自己的企业微信 UserID（多个用逗号隔开）。不填的话任何扫码进了你企业的人都能给你的 Claude Code 发消息。先不知道 UserID 没关系：白名单空着的时候回调不收任何消息，只在日志里记一行 `from=<UserID>`：给应用发一条消息，从回调日志里抄出 UserID，填回来并重启回调。
- 验证凭证对不对：访问 `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=<企业ID>&corpsecret=<Secret>`，返回 `errcode: 0` 就对了（这条命令里有密钥，别留在历史记录里，推荐用脚本读 env）。

### 3. 启动回调接收程序

在仓库根目录执行：

```bash
sudo mkdir -p /opt/ringbot && sudo cp -r callback systemd /opt/ringbot/
cd /opt/ringbot && sudo python3 -m venv .venv && sudo .venv/bin/pip install -r callback/requirements.txt
sudo cp systemd/ringbot-callback.service.example /etc/systemd/system/ringbot-callback.service
# 按你的路径改 ExecStart，然后
sudo systemctl daemon-reload && sudo systemctl enable --now ringbot-callback
```

它只监听 `127.0.0.1:8765`，路径固定 `/wecom/callback`。

### 4. 回调域名（Cloudflare 隧道）

1. 域名托管到 Cloudflare，在 Zero Trust 里建一个 named tunnel，服务指向 `http://127.0.0.1:8765`，公共主机名例如 `wx.example.com`。
2. 安装 `cloudflared`，把隧道令牌写进 `/etc/wecom-agent/tunnel.env`（`TUNNEL_TOKEN=...`，权限 600），然后：
   ```bash
   sudo cp systemd/ringbot-tunnel.service.example /etc/systemd/system/ringbot-tunnel.service
   sudo systemctl daemon-reload && sudo systemctl enable --now ringbot-tunnel
   ```
3. 验证：`curl -i "https://wx.example.com/wecom/callback?msg_signature=x&timestamp=1&nonce=1&echostr=x"` 应返回 403，同时回调日志有 `GET bad signature`，说明链路通了。

### 5. 在企业微信后台填回调和可信 IP

应用详情页：

- 「接收消息」->「设置 API 接收」：URL 填 `https://wx.example.com/wecom/callback`，Token 和 EncodingAESKey 填 env 文件里的值，点保存。保存时企业微信会发验证请求，回调日志出现 `GET verify ok` 就成功。
- 「开发者接口」->「企业可信 IP」：填运行本程序那台机器的公网出口 IP。填错的话发消息会报 errcode 60020（插件会提示「企业可信 IP 没填本机出口地址」）。

### 6. 安装 Claude Code 插件

需要 [bun](https://bun.sh) 和 `ffmpeg`（语音转码用）；`bun` 要在跑 Claude Code 的那个用户的 PATH 里。插件每次启动会自己跑一次 `bun install`（要联网），下面这步只是提前装好。

```bash
cd plugin && bun install
```

然后把插件目录挂进 Claude Code，并以 channel 方式加载。具体参数随 Claude Code 版本不同，大致是：

```bash
claude --plugin-dir /path/to/ringbot/plugin \
       --dangerously-load-development-channels plugin:wecom@inline
```

（channel 功能目前仍是研究预览，参数请以你所用版本的 `claude --help` 和官方文档为准。）插件的 MCP 服务名叫 `wecom`，启动后会读 `/etc/wecom-agent/wecom.env`，并从 `/var/lib/wecom-agent/inbox` 取回调写下的消息。路径不是默认的话，启动 `claude` 之前先 `export WECOM_ENV=... WECOM_STATE=...`。同一个队列只能被一个会话加载，否则会抢消息。

### 7. 安装电话：ringringring

按 <https://github.com/yanyan1115/ringringring> 的 README 安装并在手机上配好 Linphone。然后让两边写同一个通话记录文件：

- ringringring 侧：`RINGRINGRING_CALL_LOG=/path/to/calls.jsonl`（默认 `~/.local/state/ringringring/calls.jsonl`）
- 本插件侧（在 `wecom.env` 里）：`WECOM_CALL_LOG=/path/to/calls.jsonl`

两边路径必须是同一个文件。每通电话结束 ringringring 追加一行 `{"at","dir","answered","seconds","via"}`；只有 `"via":"wechat"` 的（Claude 拨号时带了 `via="wechat"`，即用户在微信里叫打、或给微信派的活报完工）才在微信里发气泡，别的入口来的电话不发。不配 `WECOM_CALL_LOG` 则气泡功能关闭。

`report-done` skill 随插件一起加载；里面「安静时段 23:00～08:00」那一行请改成你自己的作息。

### 8. 测试

1. 在微信里给应用发「你好」，Claude Code 会话里应出现 `<channel source="wecom" ...>`，让它 reply 一句，你的微信能收到。
2. 发一条语音，会话里应看到「(语音) 转写：...」。
3. 派一个要几分钟的活，等它做完：应先在微信收到「收到，做完打给你」，做完后手机响。接起来或不接，挂断后微信里应出现「ᯅ 通话时长」或「ᯅ 未接通」。

## 配置项

`wecom.env`（`KEY=value`，每行一个，`#` 开头是注释）里的变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WECOM_CORP_ID` | 无，必填 | 企业 ID |
| `WECOM_AGENT_ID` | 无，必填 | 自建应用 AgentId |
| `WECOM_SECRET` | 无，必填 | 自建应用 Secret |
| `WECOM_CALLBACK_TOKEN` | 无，必填 | 回调 Token（回调程序用） |
| `WECOM_ENCODING_AES_KEY` | 无，必填 | 回调 EncodingAESKey（回调程序用） |
| `WECOM_ALLOWED_USERS` | 空 | 白名单 UserID，逗号分隔。务必填；也是气泡发送的对象（第一个） |
| `WECOM_CALL_LOG` | 空（关） | 电话插件的通话记录文件，支持 `~` |
| `WECOM_STT_PROVIDER` | `openai` | `openai`（任何 OpenAI 兼容的 /audio/transcriptions，默认 Groq）或 `elevenlabs`（Scribe，失败回落到前者） |
| `WECOM_STT_ENV_FILE` | 空 | 存 `GROQ_API_KEY`（或 `STT_KEY`）的文件路径；不配则没有 Whisper 转写 |
| `WECOM_STT_ELEVEN_ENV_FILE` | 同 `WECOM_STT_ENV_FILE` | 存 `ELEVENLABS_API_KEY` 的文件路径 |
| `WECOM_STT_URL` | `https://api.groq.com/openai/v1/audio/transcriptions` | Whisper 兼容接口地址 |
| `WECOM_STT_MODEL` | `whisper-large-v3-turbo` | Whisper 模型名 |
| `WECOM_STT_ELEVEN_MODEL` | `scribe_v1` | Scribe 模型名 |
| `WECOM_STT_PROMPT` | 空 | 转写提示词，宜短（如「以下是普通话的句子。」）；过长的人名列表可能让 Groq 返回空 |

进程环境变量（systemd 的 `Environment=` 或 shell）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WECOM_ENV` | `/etc/wecom-agent/wecom.env` | env 文件路径（插件和回调都读） |
| `WECOM_STATE` | `/var/lib/wecom-agent` | 插件的状态目录（inbox、done、media、seen-users、seen-msgids、aliases.json） |
| `WECOM_INBOX` | `/var/lib/wecom-agent/inbox` | 回调程序写入的队列目录（只有回调读这个变量），必须等于插件那边的 `$WECOM_STATE/inbox`，否则插件一直对着空目录；`seen-msgids` 写在它的上一级目录 |
| `WECOM_PORT` | `8765` | 回调程序监听端口（127.0.0.1） |
| `WECOM_API` | `https://qyapi.weixin.qq.com/cgi-bin` | 企业微信 API 地址 |

可选：`$WECOM_STATE/aliases.json`（权限 600）写 `{"<UserID>": "alias"}`，会话里就只显示别名而不是真实 UserID。

## 安全说明

- 只用企业微信官方路线，不登录个人微信账号。
- 白名单之外的人发来的消息，回调程序直接丢弃（日志 `POST from non-allowed user, dropped`），`reply` 工具也只会发给白名单或发过消息的人。
- 不接群聊。
- 密钥只放在 env 文件（权限 600），代码不打印它们。

## 致谢

参考了 RoronoaHaruka/wecom-companion-guide 的 README 思路，没有使用其代码。

由 Claude Opus 5.5 编写。

## 许可

[AGPL-3.0-or-later](LICENSE)。
