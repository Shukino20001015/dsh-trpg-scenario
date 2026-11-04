# dsh-trpg-scenario

DeepSeek Harness 的 AI 跑团插件：导入剧本包、开局、评分。

## 装

最快（国内也快，走 npmmirror 镜像）：

```
dsh plugin --profile <profile> add dsh-trpg-scenario@latest
```

从 GitHub 装（无需 npm）：

```
dsh plugin --profile <profile> add github:Shukino20001015/dsh-trpg-scenario
```

注意：desktop profile 不接受 CLI 安装，要在 App 内装，或按 `安装提示词.md` 里的等价做法手工写入 profile。

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

## 玩法

装好之后，界面上会多一张开场卡（在输入框下方）：

1. 点「开一局」→ 卡片把剧本载入**当前会话**
2. 直接在同一个窗口说你要做什么
3. 不需要新建会话，也不需要跳转

卡片的按钮调的是宿主侧的 `/trpg play <剧本名>`；命令把剧本设定作为一条消息写进当前会话最前面，模型随即开始扮演。

## 已知取舍

- 开场白会以"你发的消息"的形式出现在历史里，不是独立的系统卡片
- 目前卡片上的剧本信息是内置的示例（招聘会）；接真实剧本列表还需要一层客户端与宿主的数据通道
