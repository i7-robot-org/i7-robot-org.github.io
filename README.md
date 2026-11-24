# i7-robot-org.github.io

https://i7-robot-org.github.io/ 的发布仓库：首页是 i7 导航取水 Demo 展示页，`/plans/` 是具身项目方案库。

这里的网页文件都是生成的，**不要直接改**。源文件在私有仓库 `i7-robot-org/i7-robot`（`docs/showcase`、`plans/site`，由 `pages/assemble.py` 拼装）。改动合入 i7-robot 的 `main` 后，本仓库的 [Publish site](.github/workflows/publish.yml) 工作流每 30 分钟检查一次并自动发布；也可以在 Actions 页手动运行，`ref` 填分支、tag 或提交 SHA。

工作流用 secret `I7_ROBOT_READ_KEY`（i7-robot 的只读 deploy key）拉取源文件。构建放在这个公开仓库里跑，是因为私有仓库的 Actions 分钟数按组织计费，公开仓库的 GitHub 托管 runner 免费。
