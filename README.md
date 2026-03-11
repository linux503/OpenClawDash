# OpenClawDash 🚀

OpenClawDash 是一款专为 OpenClaw 打造的高性能 API 调用监控控制台。它能够实时解析会话日志，为您提供直观的指标展示、费用统计以及系统运行状态监测。

[![Version](https://img.shields.io/badge/version-3.11_V2-blue.svg)](https://github.com/linux503/OpenClawDash)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

--- 预览截图
<img width="1833" height="989" alt="iShot_2026-03-11_下午10 40 57" src="https://github.com/user-attachments/assets/4cea26d2-ec77-4852-bf89-7b76fc076bf5" />
---
## 🌟 OpenClawDash 3.11 V2 升级说明
1. **Hero 白底卡片展示**：指标更直观，视觉层次更清晰。
2. **显示稳定性优化**：指标卡片去除 hover 闪烁，交互更顺滑。
3. **全界面双语支持**：页脚纯黑风格，标题与分享支持中英双语切换。
4. **加载性能提升**：精简字体与动画，加载速度更快。
5. **深度维度分析**：支持 API 用量、费用、Provider/模型拆分统计。
6. **核心功能矩阵**：会话、调用记录、系统信息、技能、日志等功能全面支持中英切换。


---

## 🛠 API 调用监控控制台 (OpenClaw 脚本工具)

查看 OpenClaw 的 API 调用情况（Provider、模型、Token 用量、费用等）。

### 1. 服务管理脚本

使用 `service.sh` 轻松管理监控服务：

```bash
./service.sh {start|stop|restart|status|logs}

明白了，您想要使用 HTML 的方式来嵌入带有点击功能的链接。以下是用 `<a>` 标签格式的 Markdown 内容：

````markdown
# 命令功能说明

- **start**：后台启动监控控制台
- **stop**：停止控制台服务
- **restart**：重启控制台服务
- **status**：查看运行状态、PID、端口、内存与 CPU 占用
- **logs**：实时查看运行日志

## 2. 手动启动

如果您希望在前台调试或查看实时输出，可以使用以下命令：

```bash
node ~/.openclaw/scripts/api-usage-console.js
````

## 3. 数据与访问

* 数据来源：来自 `~/.openclaw/agents/main/sessions/*.jsonl` 会话日志。
* 更新频率：每 30 秒自动刷新同步数据。
* 访问入口：[http://127.0.0.1:18790](http://127.0.0.1:18790)

## 相关项目与扩展
* **核心仓库**：[OpenClawDash](https://github.com/linux503/OpenClawDash)
* **即将发布**：[SkillBox.lol](https://skillbox.lol/)

## 📧 联系与反馈

如果您有任何问题或建议，欢迎随时联系：

* **Email**: [abbtoe@yandex.com](mailto:abbtoe@yandex.com)

