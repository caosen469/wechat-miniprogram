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
| `publishRecord` | `cloudfunctions/publishRecord` | 发布记录（T15/T18）：鉴权 + 媒体/字数/星级复核 + 新地点按 poiId 归并 + 可见范围三档（pair 固化快照）+ 参与者 + 补记时间 |
| `joinCircle` | `cloudfunctions/joinCircle` | 凭邀请码入圈（T17） |
| `createInviteCode` | `cloudfunctions/createInviteCode` | 圈主生成邀请码，24h 有效（T17） |
| `revokeInviteCode` | `cloudfunctions/revokeInviteCode` | 圈主作废邀请码（T17） |
| `removeMember` | `cloudfunctions/removeMember` | 圈主移除成员（T17） |
| `leaveCircle` | `cloudfunctions/leaveCircle` | 成员自退（圈主不可退）（T17） |
| `updateProfile` | `cloudfunctions/updateProfile` | 改昵称/头像（T17） |
| `setPartner` | `cloudfunctions/setPartner` | 圈主指定/更换另一半，只改 `circles.pairIds`（T18） |
| `listFeed` | `cloudfunctions/listFeed` | 记录流水：可见性过滤 + happenedAt 倒序 + 服务端 join 昵称头像（T18） |
| `getRecord` | `cloudfunctions/getRecord` | 记录详情：可见者才返回，不可见/不存在统一 `NOT_VISIBLE`（T18） |
| `getPlaceDetail` | `cloudfunctions/getPlaceDetail` | 地点详情：`{place, records[]}` 可见性过滤（T18） |
| `updateRecord` | `cloudfunctions/updateRecord` | 编辑记录：能看见就能编辑，pair 档以改动时二人组重固化快照（T18） |
| `deleteRecord` | `cloudfunctions/deleteRecord` | 删除记录：能看见就能删除，媒体文件一并从云存储删除（T18） |

> 云函数本地单测：仓库根目录 `npm test`（jest，mock `wx-server-sdk`，不需真实环境）。

## 其他配置项（T15 起）

| 配置 | 位置 | 说明 |
|---|---|---|
| 腾讯位置服务 key | `miniprogram/config/index.js` 的 `tencentMapKey` | 发布页「用当前位置打卡」逆地址反查最近 POI 用。在 [lbs.qq.com](https://lbs.qq.com) 注册 → 创建应用 → 创建 Key（勾选 WebServiceAPI）。留空时该通道提示改用搜索/手动输入。**域名**：需在小程序后台把 `https://apis.map.qq.com` 加入 request 合法域名（开发工具里可先勾选「不校验合法域名」） |
| `wx.getLocation` 权限 | 小程序后台 → 开发 → 接口设置 | 申请开通，使用场景写「打卡时选取当前位置附近的地点」（spec 10.2） |
| `requiredPrivateInfos` | `miniprogram/app.json` | 已声明 `getLocation` + `choosePoi`（spec 10.2） |

## 验收对照（issue #15）

- [ ] 使用正式 AppID（非测试号）创建小程序项目
- [ ] 手机真机预览能打开小程序（Hello World 级）
- [ ] 云开发控制台能看到环境，环境 ID 记录在本文件
- [ ] 项目骨架含双 tab 路由、云函数目录；`hello` 云函数部署并被小程序端调用成功
