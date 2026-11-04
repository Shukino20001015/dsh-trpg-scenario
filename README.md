# dsh-trpg-scenario

DeepSeek Harness 的 AI 跑团插件：导入剧本包、开局、评分。

## 装

```
dsh plugin --profile desktop add dsh-trpg-scenario
```

或在 DSH 里让 Agent 用 `plugin_manager` 的 `install_bundle` 装本地目录。

装完重启 DSH 一次。

## 用

| 命令 | 作用 |
|---|---|
| `/trpg list` | 列出已装剧本 |
| `/trpg import <zip>` | 导入一个剧本包 |
| `/trpg remove <名称>` | 删除剧本 |
| `/trpg play <名称>` | 开一局 |
| `/trpg judge <名称>` | 开评分会话 |

剧本库默认在 `~/.dsh/trpg/scenarios`。

## 剧本包格式

一个 zip，里面正好六个文件：

```
manifest.yaml    id / title / kind / minutes
system.md        玩法与规则
setting.md       背景、角色、初始困境
opening.md       开场场景
rubric.md        评分维度（每维 0–10）
judge.md         评委系统提示词
```

缺一个就会被拒收，并告诉你缺哪个。

## 上下文怎么进

`play` 时把三个文件作为**三个独立段落**注入系统提示词：

- `trpg/rules` ← `system.md`
- `trpg/world` ← `setting.md`
- `trpg/opening` ← `opening.md`

规则、世界、开场互不污染，换剧本只替换后两段。

## 限制

- 目前只有命令入口，没有图形界面的上传面板
- 依赖系统的 `unzip` 命令解包
- 未在 Windows 上验证

## 许可

MIT
