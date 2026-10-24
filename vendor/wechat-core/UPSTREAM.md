# 来源

从 https://github.com/xcisxc29/dsh-wechat 的 packages/core 复制，MIT 许可证保留于 LICENSE。
固定提交：5f7d69a8f83faad5a1154aec23aedb969c610931。
不包含 DSH 宿主层。构建使用本项目 TypeScript 配置。

本地补丁：ChannelMonitor 在 onMessage 全部完成后才提交增量游标，确保桥接持久化入站消息后再推进游标。
登录轮询间隔为 3–6 秒；失败指数退避；连续 5 次认证或协议硬失败停止。
已取消的本地 sleep 立即结束，避免关机时仍等待退避计时器。
