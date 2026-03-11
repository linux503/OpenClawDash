# OpenClaw 脚本工具

## API 调用监控控制台


查看 OpenClaw 的 API 调用情况（Provider、模型、Token 用量、费用等）。

### 服务管理脚本

```bash
./service.sh {start|stop|restart|status|logs}
```
<img width="1810" height="954" alt="iShot_2026-03-11_下午1 14 20" src="https://github.com/user-attachments/assets/3ddedd81-a79c-45d0-84b0-2983d326e251" />
![Uploading iShot_2026-03-11_下午1.14.29.png…]()
![Uploading iShot_2026-03-11_下午1.14.40.png…]()

![Uploading iShot_2026-03-11_下午1.15.00.png…]()

| 命令 | 说明 |
|------|------|
| `start` | 后台启动监控控制台 |
| `stop` | 停止控制台 |
| `restart` | 重启控制台 |
| `status` | 查看运行状态、PID、端口、内存与 CPU 占用 |
| `logs` | 实时查看日志 |

**手动启动：**
```bash
node ~/.openclaw/scripts/api-usage-console.js
```

**访问：** http://127.0.0.1:18790

数据来自 `~/.openclaw/agents/main/sessions/*.jsonl` 会话日志，每 30 秒自动刷新。

