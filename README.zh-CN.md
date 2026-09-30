<p align="center">
  <img src="assets/icon.png" alt="ClaudeAnywhere icon" width="96" />
</p>

<h1 align="center">ClaudeAnywhere</h1>

<p align="center"><strong>在手机上,接着用你笔记本里那个 Claude Code 对话。</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a>
</p>

不是另开一个会话,也不是在浏览器里塞一个终端。ClaudeAnywhere 挂到你自己 VS Code 里正在运行的那个 Claude Code 窗口上,镜像的就是**那一个**对话:同样的历史、同样的上下文、同样那个正在跑的任务。你在手机上读它、往里打字,发出去的内容落进你离开时开着的那个窗口。

所有环节都跑在你自己的机器上——你的笔记本,加上你自己 VPS 上的一个小中继。中间没有任何第三方服务。

> 与 Anthropic 无关,也未获其背书。这是一个独立项目,不是 Claude Code 自带的 Remote Control 功能。

## 为什么你可能需要它

- **长任务不必把你拴在桌前。** 让它跑起来就走,在公交车上看着,第九分钟它提问时顺手回一句。
- **是同一个对话。** 那些驱动一个全新 headless 会话的工具,没法把你已经开着的那个连同上下文和做了一半的活儿给你看。这个可以。
- **它能按那些根本没有 API 的按钮。** 比如重连一个 MCP server,这件事只作为界面上的一个控件存在——没有 CLI 命令,扩展没注册对应命令,IDE 的 RPC 里也没有。ClaudeAnywhere 点的是那个真实控件。
- **端到端自托管。** 你的笔记本只和你的 VPS 说话。一个密钥,由你自己生成。

## 在手机上能做什么

- 实时阅读任意一个打开的对话,包括正在流式输出的回复。
- 往里发消息。
- 看到 Claude 是在干活还是在等你。
- 新建一个对话,并带上第一条 prompt。
- 列出 MCP server,重连掉线的那个。

## 你需要什么

- 一台装了 Claude Code 扩展、运行 VS Code 的笔记本。
- 一台有域名和 HTTPS 的小 VPS(前面挂 Caddy 或 nginx,见下文)。
- 笔记本上 Node 22+,VPS 上 Python 3.11+。

## 安装

```bash
git clone <your-fork> claude-anywhere
cd claude-anywhere
make setup
```

这会写出 `client/.env` 和 `server/.env`,并装好服务端依赖。然后打开这两个文件,把 `AUTH_TOKEN` 设成**同一个值**——它既是 daemon 的凭据,也是你手机端的密码,故意做成一个密钥:

```bash
openssl rand -hex 32
```

同时把 `client/.env` 里的 `VPS_WS_URL` 改成你中继的 WebSocket 地址。

**在 VPS 上**,把中继放到 TLS 后面再启动:

```bash
make server
```

`server.py` 监听的是一个没有 TLS 的裸 HTTP/WebSocket 端口,你的密码会以明文穿过这条连接。请用 Caddy 或 nginx 在前面终结 `https://` 和 `wss://`。不要把裸端口直接暴露出去。

**在笔记本上**,VS Code 必须带着调试端口启动——这个开关事后补不上:

```bash
make vscode     # 退出 VS Code,带调试端口重新拉起
make client     # 桥接进程
```

然后在手机上打开 `https://your-relay.example.com/`,用同一个 `AUTH_TOKEN` 作为密码登录,挑一个对话。

卡住了?`make check` 会告诉你三条链路里哪条断了——调试端口、两个 `.env`、还是中继。

## 工作原理

```
笔记本上的 VS Code
   └── Claude Code 窗口 ──CDP──► client/daemon.js  (你的笔记本)
                                       │ WebSocket
                                       ▼
                                 server/server.py  (你的 VPS)
                                       │ WebSocket / HTTPS
                                       ▼
                                   手机浏览器
```

daemon 通过 Chrome DevTools Protocol 挂到 VS Code 自己的渲染进程上,从活页面里读出对话内容,只把变化的部分发出去。中继为每个对话保留一份副本,这样你的手机才能往上翻;同时把你的消息送回另一端。daemon 只盯着当前有手机打开的对话——关掉那个页面,它就完全停止轮询。

## 依赖它之前值得知道的

- **它读的是一个闭源扩展的页面。** Claude Code 随时可以在任何一个版本里改动它的标记,改了就会有东西坏掉。这一点是按"**坏得响亮**"来设计的:选择器一旦匹配不上,你的手机会明说,而不是给你看一个空对话。
- **历史有上限**,每个对话 1MB(`MAX_SESSION_BYTES`),超出后从最旧的开始丢。往上翻到此为止。
- **一台笔记本,一个用户。** 第二个 daemon 连上来会顶掉第一个。
- **对话是用它的 VS Code 标签页来标识的。** 关掉再打开,或者重启 VS Code,都算成一个新的。
- **手机端无法回答交互式选择题**——Claude Code 用自己的选择器渲染的那类提问,你能看见问题,但选择仍然要在笔记本上完成。

## 参与开发

架构、wire protocol、这份代码被要求达到的标准,以及怎么跑测试,都在 [AGENTS.md](AGENTS.md)。

```bash
make test
```
