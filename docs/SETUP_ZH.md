# Codex Claw 安装教程

这份教程按“安全默认模式”来写，适合第一次安装。

目标效果是：

- 你在飞书里私聊机器人
- 机器人把消息交给本机 Codex
- 只读请求直接回答
- 写文件、执行命令、进程控制等高风险请求先审批

## 0. 准备环境

在项目目录打开 PowerShell：

```powershell
cd "C:\your-workspace\CodexClaw"
node -v
npm -v
```

只要 `node` 和 `npm` 都能输出版本号，就可以继续。

## 1. 先让 Codex 在本机可用

```powershell
npx codex login
```

登录完成后再试一次：

```powershell
npx codex --help
```

如果能正常输出帮助信息，说明本机 Codex 已经准备好了。

## 2. 在飞书开放平台创建应用

1. 打开飞书开放平台
2. 创建一个“企业自建应用”
3. 开启机器人能力
4. 记下两个值

- `App ID`
- `App Secret`

## 3. 开启长连接和消息事件

在飞书应用后台完成这几件事：

1. 打开“事件订阅”
2. 选择“长连接模式”
3. 订阅事件 `im.message.receive_v1`
4. 给应用开通接收和发送消息相关权限
5. 如果后台提示“发布版本”，记得发布

首版就是靠长连接收发消息，所以不需要公网域名，也不需要 HTTP 回调地址。

## 4. 配置 `.env`

先复制示例文件：

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env`，第一次先只改这些：

```env
FEISHU_APP_ID=你的 App ID
FEISHU_APP_SECRET=你的 App Secret
ALLOWED_OPEN_IDS=你的 open_id
WORKSPACE_ROOTS=C:\your-workspace\CodexClaw
CODEX_CONTROL_SCOPE=workspace
```

### 这些配置是什么意思

- `ALLOWED_OPEN_IDS`
  只有白名单里的飞书账号可以使用这个机器人
- `WORKSPACE_ROOTS`
  Codex 在安全默认模式下允许操作的目录
- `CODEX_CONTROL_SCOPE=workspace`
  公开版推荐的默认模式，只开放工作区范围

如果你只是本地临时调试，可以先用：

```env
ALLOWED_OPEN_IDS=*
```

但不要把它当正式配置。

## 5. 启动项目

```powershell
npm install
npm run build
npm start
```

如果启动成功，终端会开始监听飞书长连接。

## 6. 在飞书里测试

先发一句最简单的话：

```text
你好
```

再试只读请求：

```text
帮我看看当前工作目录里有什么文件
```

再试高风险请求：

```text
帮我创建一个 test.txt，内容是 hello
```

正常行为应该是：

1. 只读请求直接回结果
2. 高风险请求先回审批编号
3. 你再发

```text
/approve 审批编号
```

4. 它才继续执行

如果你想取消，就发：

```text
/reject 审批编号
```

## 6.1 试一下定时任务

如果前面的基础链路已经跑通，可以再试一个定时任务：

```text
/cron add 09:00 帮我总结当前工作目录里有什么变化
```

自然语言也可以：

```text
每天早上9点帮我总结当前工作目录里有什么变化
每周五下午6点帮我总结本周这个项目目录里的改动
每隔2小时帮我检查一次当前工作区风险
```

然后查看列表：

```text
/cron list
```

查看最近运行历史：

```text
/cron history
```

## 6.2 试一下 skills

查看本机已安装的 Codex skills：

```text
/skill list
帮我看看本机有哪些技能
```

查看官方可安装 skills：

```text
/skill list curated
/skill list experimental
```

安装一个官方 skill：

```text
/skill install playwright
给我装一个 playwright skill
```

从 GitHub 链接安装：

```text
/skill install url https://github.com/openai/skills/tree/main/skills/.experimental/playwright-interactive
帮我安装这个 skill https://github.com/openai/skills/tree/main/skills/.experimental/playwright-interactive
```

skill 安装会先要求审批。安装完成后，建议重启桥接服务：

```powershell
npm run bridge:restart
```

## 7. 什么时候再开整机控制模式

默认不要急着开：

```env
CODEX_CONTROL_SCOPE=computer
```

只在这三件事都满足时再启用：

1. 你已经确认安全默认模式跑通
2. 你理解批准后会给 Codex 更强的本机权限
3. 机器人只对你自己的飞书账号开放

## 常见问题

### 1. 飞书里发消息，机器人没反应

优先检查：

- 事件订阅有没有打开
- 是否选择了长连接模式
- `im.message.receive_v1` 是否已订阅
- 应用是否已经发布
- `npm start` 的终端是否还开着

### 2. 机器人提示不在白名单

说明当前发送者的 `open_id` 不在 `ALLOWED_OPEN_IDS` 里。

### 3. 机器人能聊天，但执行总卡住

最常见的原因有两个：

- 你还没回 `/approve <id>`
- `WORKSPACE_ROOTS` 没配对，导致目标路径不在允许范围里

### 4. 机器人提示 Codex 没登录

重新执行：

```powershell
npx codex login
```

然后重启：

```powershell
npm run bridge:restart
```

## 跑通后的建议

1. 把 `ALLOWED_OPEN_IDS` 收紧到你自己的 `open_id`
2. 把 `WORKSPACE_ROOTS` 缩到真正需要的目录
3. 发布前轮换飞书 `App Secret`
4. 如果要录屏，先确认画面里没有个人路径、密钥和日志片段
