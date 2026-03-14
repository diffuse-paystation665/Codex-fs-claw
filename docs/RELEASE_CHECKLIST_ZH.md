# Codex Claw 发布前检查清单

## 1. 密钥与隐私

- [ ] 轮换飞书 `App Secret`
- [ ] 确认 `.env` 没有被加入 Git
- [ ] 确认 `data/`、`logs/`、`dist/` 没有被加入 Git
- [ ] 确认 `.playwright-cli/`、`output/` 这类本地产物目录没有被加入 Git
- [ ] 检查 README、教程、截图、GIF 里没有真实密钥
- [ ] 检查录屏里没有个人路径、账号信息、日志片段

## 2. 默认配置

- [ ] `.env.example` 默认是 `CODEX_CONTROL_SCOPE=workspace`
- [ ] `.env.example` 没把 `ALLOWED_OPEN_IDS=*` 作为正式示例
- [ ] README 首屏强调的是“安全默认”，不是“整机控制默认开启”

## 3. 功能验证

- [ ] `npm run build` 通过
- [ ] `npm test` 通过
- [ ] 安全默认模式下，只读查询可直接执行
- [ ] 写文件、执行命令、进程控制都先走审批
- [ ] 定时任务可正常创建、列出、查看历史
- [ ] skills 可正常列出，安装会先审批
- [ ] 非白名单账号会被拒绝

## 4. 高级模式验证

- [ ] 显式设置 `CODEX_CONTROL_SCOPE=computer` 后，高风险获批任务可正常执行
- [ ] README 对高级模式的风险提示与真实行为一致

## 5. 文档与包装

- [ ] README 在 GitHub 页面显示正常，没有乱码
- [ ] 中文安装教程能按步骤跑通
- [ ] 发布文案和仓库描述都已准备好
- [ ] GitHub About 的 Description / Topics / Social Preview 已补好
- [ ] 演示截图或 GIF 已去隐私

## 6. 一键发布前最后一步

- [ ] 先跑 `npm run github:check`
- [ ] `git status` 看起来干净，没有误带本地配置和日志
- [ ] 远程 GitHub 仓库已创建
- [ ] 再执行 `npm run github:publish -- https://github.com/你的用户名/你的仓库名.git`
