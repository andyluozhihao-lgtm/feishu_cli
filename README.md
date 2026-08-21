# Feishu weekly task notifier

这个小工具会读取周会待办 Base 视图中的记录，筛出状态为 `待办` / `进行中` 的事项，按 `待办负责人` 分组，并通过飞书群机器人 webhook 发送提醒。如果没有符合条件的待办，则跳过发送，不打扰群成员。

## 配置

复制示例环境变量并填入你的 webhook：

```bash
cp .env.example .env
```

最少需要配置：

```bash
export LARK_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/..."
```

如果机器人开启了签名校验，也配置：

```bash
export LARK_WEBHOOK_SECRET="..."
```

## 试运行

先只预览消息，不发送：

```bash
npm run notify:dry-run
```

确认内容没问题后发送：

```bash
npm run notify
```

## 云端定时运行

推荐把推送执行者放到 GitHub Actions，而不是本机 `launchd`。这样即使这台电脑关机、睡眠、没有用户登录，本提醒也会按云端计划运行。

本仓库已经包含工作流 `.github/workflows/weekly-task-notifier.yml`：

- 每天 `10:13`（Asia/Shanghai）自动运行。
- 支持在 GitHub Actions 页面手动点 `Run workflow` 立即试跑。
- 云端使用 `LARK_IDENTITY=bot`，通过飞书应用身份读取 Base，再通过群机器人 webhook 推送。

在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions` 中配置：

Secrets：

```text
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/...
LARK_WEBHOOK_SECRET=
```

Variables（可选；不填时脚本会使用内置默认值）：

```text
LARK_BASE_TOKEN=P8HZbDIw4aOidbs3iL4cj3skndc
LARK_TABLE_ID=tblujFmRD6W9if1e
LARK_VIEW_ID=vewGywBr8d
BASE_URL=https://zhuanspirit.feishu.cn/base/P8HZbDIw4aOidbs3iL4cj3skndc?table=tblujFmRD6W9if1e&view=vewGywBr8d#CategoryScheduledTask
ACTIVE_STATUSES=待办,进行中
INCLUDE_UNASSIGNED=1
```

还需要在飞书侧确认：

1. 应用已开通读取 Base 记录所需权限，并发布/生效。
2. 这个应用或机器人已经被添加到对应 Base，且拥有目标表/视图读取权限。

## 本机备用定时运行

macOS 可以用 `launchd` 每天定时执行。示例 plist 在 `launchd/com.zhuanspirit.weekly-task-notifier.plist`，把里面的环境变量补全后加载即可。

```bash
launchctl load ~/Library/LaunchAgents/com.zhuanspirit.weekly-task-notifier.plist
```

如需改提醒时间，调整 plist 里的 `StartCalendarInterval`。
