# OpenClaw 脚本工具

## API 调用监控控制台

查看 OpenClaw 的 API 调用情况（Provider、模型、Token 用量、费用等）。

### 服务管理脚本

```bash
./service.sh {start|stop|restart|status|logs}
```

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
