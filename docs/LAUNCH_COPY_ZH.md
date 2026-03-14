# Codex Claw 发布文案

这份文案可以直接拿去发 GitHub、即刻、X、V2EX、朋友圈。

## GitHub 仓库描述

直接用这一句：

> Put official Codex into Feishu private chat, with approval-gated local control.

## GitHub About 建议

- Description:
  `Put official Codex into Feishu private chat with approval-gated local control.`
- Website:
  `https://github.com/R2Phil-hub/Codex-fs-claw`
- Topics:
  `codex`, `feishu`, `lark`, `agent`, `local-first`, `approval-workflow`, `cron`, `automation`, `skills`, `typescript`
- Social Preview:
  upload [assets/social-preview.png](../assets/social-preview.png)

## 中文标题备选

- 把官方 Codex 接进飞书，而且默认更安全
- 我做了一个能在飞书里直接控制 Codex 的本地助手
- 不用公网回调，把 Codex 装进飞书私聊
- 一个带审批流的飞书版 Codex 本机操作器
- 把官方 Codex 变成飞书里的本机操作器

## 一句话短介绍

Codex Claw 是一个运行在本机的飞书私聊助手，底层直接调用官方 Codex。  
默认只开放工作区，高风险操作先审批，再执行。

## 首发推荐文案

如果你只发一条，最推荐用这段：

最近做了个本地优先的小项目：`Codex Claw`

它把官方 Codex 接进飞书私聊，而且不是“只能聊天”的那种机器人。

- 默认只开放工作区
- 写文件、执行命令、装 skill 会先审批
- 不用公网回调，不用 `ngrok`
- 还支持自然语言定时任务

如果你想做的是“边界清楚、能真正在本机做事”的 AI 操作器，这个项目应该会有点意思。

## 标准中文版介绍

我做了一个本地优先的飞书私聊机器人，底层直接用官方 Codex。

它解决的不是“怎么再做一个聊天机器人”，而是这几个更实际的问题：

- 想把 Codex 接进日常沟通工具
- 不想折腾公网回调和 `ngrok`
- 不想让 AI 在本机上裸奔执行
- 想保留文件、命令、定时任务、skills 这些实用能力

最后做成的形态是：

- 飞书私聊作为入口
- 官方 Codex 做大脑
- 默认安全工作区模式
- 文件改动、命令执行、skill 安装先审批

## 强一点的发布版

最近做了个挺有意思的小项目：`Codex Claw`

它做的事情很直接：
把官方 Codex 装进飞书私聊，而且不是“只能闲聊”的那种机器人。

你可以在飞书里直接问它当前目录、项目文件、工作区状态；
如果你让它写文件、执行命令、打开程序、安装 skill，它不会直接跑，而是先给你审批编号，确认后再执行。

我觉得比较值钱的地方有这几个：

- 官方 Codex 做大脑
- 不用公网回调
- 默认安全模式，不把整机控制当成出厂默认
- 真要开整机控制，也必须显式 opt-in

## X / 英文版

Built a local-first Feishu assistant powered by official Codex.

No public callback.
No ngrok.
Safe defaults by default.
Approval-gated local execution when you need it.

## 即刻 / 朋友圈 / 群分享版

最近把官方 Codex 接进飞书私聊做成了一个本地助手，叫 `Codex Claw`。

它不是只会聊两句，而是真的能帮你看工作区、跑本地任务、装 skills。
但我把默认策略收得比较紧：

- 默认只开放工作区
- 高风险操作必须先审批
- 不需要公网回调

如果你想要的是“能装、能用、边界又比较清楚”的本地 AI 操作器，这个项目应该会有点意思。

## 演示视频脚本

最推荐录一个 20 到 30 秒的视频，顺序如下：

1. 飞书发：`帮我看看当前工作目录里有什么文件`
2. 机器人直接返回目录结果
3. 飞书发：`帮我创建一个 demo.txt，内容是 hello`
4. 机器人返回审批编号
5. 你回复：`/approve xxxxxxxx`
6. 机器人回报创建成功

如果你想再加一个亮点镜头：

7. 飞书发：`给我装一个 playwright skill`
8. 机器人返回审批编号
9. 批准后提示安装成功

这套脚本最容易让人一眼看懂：

`飞书聊天入口 + 官方 Codex + 审批执行`

## 首屏卖点固定写法

建议在 README、帖子、视频封面里反复强调这 4 个点：

- 官方 Codex 做大脑
- 飞书私聊直接可用
- 高风险操作先审批
- 不用公网回调

## 首发 Release 标题建议

- `v0.1.0: Codex Claw initial release`
- `First public release: Codex Claw`
- `Codex Claw 0.1.0 - Feishu private chat + official Codex`
