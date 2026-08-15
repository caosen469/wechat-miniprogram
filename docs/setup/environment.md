# 环境信息（T13）

> AppID 与环境 ID 是两个不同的东西，都记录在这里。**本文件是唯一填写处**，`miniprogram/config/index.js` 的 `env` 从这里抄。

## 关键标识

| 项 | 值 | 说明 |
|---|---|---|
| AppID | `（待填：微信公众平台 → 开发 → 开发管理 → 开发设置）` | 正式 AppID，**非测试号** |
| 云开发环境 ID | `（待填：微信开发者工具 → 云开发控制台，形如 cloud1-0gxxxxxxxx）` | 不是 AppID |
| 基础库版本 | 3.8.12（project.config.json 锁定） | |
| 微信开发者工具版本 | `（待填）` | |

## 人工步骤清单（按序执行）

1. **注册小程序**：[mp.weixin.qq.com](https://mp.weixin.qq.com) → 立即注册 → 小程序 → 个人主体。
   - 类目选 **工具 - 笔记/记录**（个人主体无「社交」类目，见 mvp-spec 10.1）。
   - 名称/简介/页面文案避免「社区」「社交」「分享给好友」表述，定位「家庭相册/记录工具」。
2. **安装微信开发者工具**（稳定版），用微信扫码登录。
3. **导入本项目**：开发者工具 → 导入项目 → 目录选仓库根 → AppID 填上表正式 AppID（替换 `project.config.json` 里的占位 `touristappid`）。
4. **开通云开发**：工具栏「云开发」→ 开通 → 按量付费（免费额度内不扣费）→ 记下**环境 ID** 填入上表，并同步到 `miniprogram/config/index.js` 的 `env`。
5. **部署测试云函数**：编辑器中右键 `cloudfunctions/hello` → 「上传并部署：云端安装依赖」。
6. **真机预览**：工具栏「预览」扫码 → 手机上看到 Hello World → 点「测试云函数连通」按钮，显示 `Hello World from cloud function（openid: …）` 即全链路通。

## 云函数部署清单

新增云函数后，在微信开发者工具中右键对应目录 → 「上传并部署：云端安装依赖」：

| 函数 | 目录 | 用途 |
|---|---|---|
| `hello` | `cloudfunctions/hello` | 环境健康检查（阶段 0） |
| `bootstrap` | `cloudfunctions/bootstrap` | 冷启动鉴权：openid → 成员身份；不在圈返回 `{me: null}`（T14） |
| `createCircle` | `cloudfunctions/createCircle` | 建圈：创建者即圈主，生成 `circles`/`members` 文档（T14） |

> 云函数本地单测：仓库根目录 `npm test`（jest，mock `wx-server-sdk`，不需真实环境）。

## 验收对照（issue #15）

- [ ] 使用正式 AppID（非测试号）创建小程序项目
- [ ] 手机真机预览能打开小程序（Hello World 级）
- [ ] 云开发控制台能看到环境，环境 ID 记录在本文件
- [ ] 项目骨架含双 tab 路由、云函数目录；`hello` 云函数部署并被小程序端调用成功
