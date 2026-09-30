<p align="center">
  <img src="assets/icon.png" alt="ClaudeAnywhere icon" width="96" />
</p>

<h1 align="center">ClaudeAnywhere</h1>

<p align="center"><strong>带上自己的 Claude Remote,走到哪儿用到哪儿。</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a>
</p>

它不新开会话,也不是往浏览器里塞一个终端。ClaudeAnywhere 挂在你自己 VS Code 那个 Claude Code 窗口上,你在手机上看到的就是它:一样的历史,一样的上下文,一样那个正跑着的任务。手机上打的字,会落进你离开时开着的那个窗口。

**很多公司不让用官方托管的 Remote Control**,通常是数据策略的原因。ClaudeAnywhere 能力一样,只是不经手别人:你的笔记本,你 VPS 上一个很小的中继,一个你自己生成的密钥。数据不出你自己的机器,中间也没有第三方服务。

> 与 Anthropic 无关,也未获其背书。这是一个独立项目,不是 Claude Code 自带的 Remote Control。

## 它能解决什么

- **长任务不用守着。** 开跑就走,路上瞄两眼,它第九分钟提问的时候顺手答一句。
- **就是原来那个对话。** 别的工具都是另起一个 headless 会话,你之前聊到哪、做了一半的活儿,它看不见。这个看得见。
- **能点那些没有 API 的按钮。** 比如 MCP server 断了要重连,这事只有界面上一个按钮能干:CLI 没这个命令,扩展没注册,IDE 的 RPC 里也没有。ClaudeAnywhere 点的就是那个按钮。
- **全套自托管。** 笔记本只连你的 VPS,没有别的出口。公司不让用托管服务的话,这套东西能力相同,但机器都是你自己的。

## 手机上能干什么

- 实时看任意一个开着的对话,回复流式输出的过程也看得到。
- 往里发消息。
- 知道 Claude 是在跑还是在等你。
- 新开一个对话,顺带把第一句话发进去。
- 列出 MCP server,把掉线的那个重连上。

## 需要准备什么

- 一台笔记本,装了 VS Code 和 Claude Code 扩展。
- 一台小 VPS,有域名,前面挂 Caddy 或 nginx 做 HTTPS(下面会说为什么必须)。
- 笔记本上 Node 22+,VPS 上 Python 3.11+。

## 装起来

```bash
git clone <your-fork> claude-anywhere
cd claude-anywhere
make setup
```

这一步会生成 `client/.env` 和 `server/.env`,顺便装好服务端依赖。接着把两个文件里的 `AUTH_TOKEN` 改成**同一个值**。它既是 daemon 的凭据,也是你手机登录的密码——故意只设一个,少一样东西要记:

```bash
openssl rand -hex 32
```

`client/.env` 里的 `VPS_WS_URL` 也改成你中继的地址。

**VPS 这边**,先把 TLS 架好再启动:

```bash
make server
```

`server.py` 监听的是裸 HTTP/WebSocket,自己不做 TLS,你的密码会明文走过去。所以务必用 Caddy 或 nginx 在前面终结 `https://` 和 `wss://`,别把裸端口直接放出去。

**笔记本这边**,VS Code 必须带调试端口启动,这个开关起来之后就补不上了:

```bash
make vscode     # 退掉 VS Code,带调试端口重新拉起
make client     # 桥接进程
```

然后手机打开 `https://your-relay.example.com/`,密码就是刚才那个 `AUTH_TOKEN`,选一个对话进去。

哪一步不通,跑 `make check`。它会分别告诉你调试端口、两个 `.env`、中继这三处哪里出了问题。

## 怎么做到的

```
笔记本上的 VS Code
   └── Claude Code 窗口 ──CDP──► client/daemon.js  (笔记本)
                                       │ WebSocket
                                       ▼
                                 server/server.py  (VPS)
                                       │ WebSocket / HTTPS
                                       ▼
                                    手机浏览器
```

daemon 用 Chrome DevTools Protocol 挂到 VS Code 的渲染进程上,直接从活页面里把对话读出来,只发变动的部分。中继给每个对话存一份,这样手机才翻得回去;你发的消息也走它送回来。没有手机开着的对话,daemon 根本不去轮询。

## 用之前最好知道这些

- **它读的是闭源扩展的页面。** Claude Code 哪个版本改了 DOM,这边就会坏。所以它是奔着**坏得让你立刻知道**去做的:选择器一旦对不上,手机上会直说,而不是给你看一个空对话。
- **历史有上限**,每个对话 1MB(`MAX_SESSION_BYTES`),满了从最旧的开始扔。往上翻到这儿为止。
- **一台笔记本,一个人用。** 第二个 daemon 连上来会把第一个顶掉。
- **对话是按 VS Code 标签页认的。** 关掉重开,或者重启 VS Code,就算另一个对话了。
- **交互式选择题手机上答不了。** Claude Code 用自己的选择器弹出来的那种问题,你看得见,但得回电脑上选。

## 参与开发

架构、wire protocol、这份代码的质量标准、怎么跑测试,都在 [AGENTS.md](AGENTS.md) 里。

```bash
make test
```
