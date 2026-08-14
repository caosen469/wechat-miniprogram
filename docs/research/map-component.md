# 微信小程序地图组件能力调研

## 调研目的
为"旅行地图打卡"功能提供技术可行性依据，调研微信小程序内置 `<map>` 组件的能力、腾讯位置服务 key 申请流程、配额计费模式以及定位授权流程。

**调研日期**：2025-08-14
**调研来源**：微信官方文档、腾讯位置服务官方文档

---

## 1. 微信小程序内置 `<map>` 组件能力

### 1.1 核心属性
**必需属性**：
- `longitude`（number）- 中心经度
- `latitude`（number）- 中心纬度

**可选属性**：
- `scale`（number，默认：16）- 缩放级别（3-20）
- `min-scale` / `max-scale` - 最小/最大缩放边界
- `markers` - 标记点数组
- `polyline` / `polygon` / `circles` - 几何图形叠加
- `show-location`（boolean）- 显示当前位置点及方向
- `enable-3D`（boolean）- 显示 3D 建筑
- `enable-satellite` / `enable-traffic` - 卫星图/交通图
- `subkey` - 地图个性化样式 key
- `layer-style`（number，默认：1）- 地图样式

来源：[微信小程序 map 组件文档](https://developers.weixin.qq.com/miniprogram/dev/component/map.html)

### 1.2 事件能力

| 事件 | 触发条件 | 返回值 |
|------|----------|--------|
| `bindtap` | 点击地图 | 经纬度坐标 |
| `bindmarkertap` | 点击标记点 | `{markerId}` |
| `bindcallouttap` | 点击气泡 | `{markerId}` |
| `bindregionchange` | 视野变化 | `{type, causedBy, detail}` |
| `bindpoitap` | 点击 POI | `{name, longitude, latitude}` |

来源：[微信小程序 map 组件文档](https://developers.weixin.qq.com/miniprogram/dev/component/map.html)

### 1.3 Marker（标记点）能力

**基础属性**：
- `id` - 标记点 ID
- `latitude` / `longitude` - 经纬度
- `iconPath` - 图标路径
- `width` / `height` - 尺寸
- `rotate` / `alpha` - 旋转角度/透明度
- `zIndex` - 层级

**Callout（气泡）**：
- `content` - 文本内容
- `color` / `fontSize` - 文字样式
- `borderWidth` / `borderColor` / `bgColor` - 边框/背景样式
- `padding` - 内边距
- `display` - `'BYCLICK'` 或 `'ALWAYS'`（点击显示或常驻）

**CustomCallout（自定义气泡）**：
- 支持使用 `cover-view` 实现完全自定义的气泡内容
- 可包含图片、按钮、文本等多种元素
- 通过 `marker-id` 绑定到对应 marker
- 灵活性远高于标准 callout

**Label（标签）**：
- 类似 callout 的样式能力
- 可设置锚点位置

**高级能力**：
- **点聚合**（`joinCluster`）- 防止标记点重叠
- **碰撞管理**（v3.4.3+）- 设置 `collision` 和 `collisionRelation`
- **动态更新** - 通过 `MapContext` 的 `addMarkers` / `removeMarkers` 动态管理

来源：[微信小程序 map 组件文档](https://developers.weixin.qq.com/miniprogram/dev/component/map.html)、[微信小程序自定义气泡文档](https://developers.weixin.qq.com/community/develop/doc/0000e23e01cce099b0ca70ca456800)

### 1.4 定位与坐标系统

- **坐标系统**：使用火星坐标系（gcj02）
- **定位显示**：`show-location` 属性显示当前位置及方向
- **自动授权**：v3.13.2+ 版本会在未授权时自动请求权限
- **原生组件**：v2.7.0+ 支持同层渲染

---

## 2. 腾讯位置服务 Key 申请与配额计费

### 2.1 申请流程

1. **注册账号**：在腾讯位置服务官网注册
2. **开发者认证**：选择个人或企业认证
3. **创建应用**：在控制台创建应用
4. **创建 Key**：勾选 WebServiceAPI 并分配配额
5. **配置域名**：在小程序后台设置安全域名 `https://apis.map.qq.com`

来源：[腾讯位置服务 WebServiceAPI 文档](https://lbs.qq.com/miniProgram/jsSdk/jsSdkGuide/jsSdkOverview)

### 2.2 配额与计费模式

**个人开发者**：
- **初始账号**：默认为个人开发者
- **基础功能**：地图展示、定位、搜索等基本功能在免费额度内可免费使用
- **配额管理**：可在 `控制台 > 配额管理 > 账户额度` 查看和分配配额
- **提升配额**：可在 `控制台 → 配额申请 → 提升配额` 中提交申请（3个工作日内审批）

**企业开发者**：
- **认证后**：配额会自动提升
- **大配额需求**：可在控制台申请提升，需详细说明应用需求

**计费规则**：
- **免费额度**：基础功能在一定调用额度内免费
- **超出付费**：当接口调用量超出免费额度后需要付费

来源：[腾讯位置服务 FAQ](https://lbs.qq.com/FAQ/index.html)

### 2.3 个人开发者可用性

**结论**：✅ **个人开发者完全可用**
- 支持个人开发者注册和申请 key
- 基础功能免费提供
- 可通过配额申请获取更高额度
- 适合学习、原型开发和中小型项目

---

## 3. Marker 气泡与打卡功能实现

### 3.1 展示照片缩略图

**✅ 支持多种方式**：

1. **CustomCallout + 图片**：
   ```javascript
   {
     customCallout: {
       anchorX: 0,
       anchorY: 0,
       display: 'BYCLICK',
       content: '<cover-view><cover-image src="/images/thumb.png"/></cover-view>'
     }
   }
   ```

2. **标准 Callout + Content**：
   - 可以在气泡中显示图片
   - 支持 HTML 格式的内容

来源：[微信小程序自定义气泡文档](https://developers.weixin.qq.com/community/develop/doc/0000e23e01cce099b0ca70ca456800)、[地图实现打卡功能实践](https://blog.csdn.net/qq_41646249/article/details/136769337)

### 3.2 展示打分

**✅ 支持**：
- 在 CustomCallout 中通过 `cover-view` 显示星级评分
- 可使用图片或 Unicode 字符实现星级显示
- 完全自定义样式和布局

### 3.3 记录入口

**✅ 完全支持**：
- 在 CustomCallout 中添加"打卡"按钮
- 通过 `bindcallouttap` 事件捕获点击
- 跳转到打卡详情页面或弹出打卡对话框

**实现示例**：
```javascript
// Marker 配置
{
  id: 1,
  latitude: 39.908823,
  longitude: 116.397470,
  customCallout: {
    display: 'BYCLICK',
    content: '<cover-view class="callout"><cover-image src="{{thumb}}"/><cover-view class="rating">⭐⭐⭐⭐⭐</cover-view><cover-view class="btn">打卡</cover-view></cover-view>'
  }
}

// 事件处理
onCalloutTap(e) {
  const { markerId } = e.detail;
  wx.navigateTo({
    url: `/pages/check-in?id=${markerId}`
  });
}
```

来源：[地图实现打卡功能实践](https://blog.csdn.net/qq_41646249/article/details/136769337)、[微信小程序 Marker 个性化攻略](https://zhuanlan.zhihu.com/p/1955995946568639029)

### 3.4 位置选择能力

**wx.chooseLocation API**：
- 打开地图选择位置
- 返回选中位置的 `name`、`address`、`latitude`、`longitude`
- 适用于添加新的打卡点

来源：[wx.chooseLocation 文档](https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.chooseLocation.html)

---

## 4. 获取用户定位的授权流程

### 4.1 授权 API

**主要 API**：
- `wx.getLocation` - 获取精确地理位置
- `wx.getFuzzyLocation` - 获取模糊地理位置（授权要求较低）
- `wx.authorize` - 主动发起授权请求
- `wx.getSetting` - 检查授权状态

来源：[wx.getLocation 文档](https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.getLocation.html)

### 4.2 授权流程

**首次授权**：
1. 调用 `wx.getLocation` 自动弹出授权请求窗口
2. 用户同意后，获得位置权限
3. 可在后续调用中直接获取位置

**提前授权**：
```javascript
wx.authorize({
  scope: 'scope.userLocation',
  success() {
    // 已授权，可直接获取位置
    wx.getLocation({...});
  }
})
```

**检查授权状态**：
```javascript
wx.getSetting({
  success(res) {
    if (!res.authSetting['scope.userLocation']) {
      // 未授权，需要请求授权
    }
  }
})
```

来源：[wx.getLocation 文档](https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.getLocation.html)

### 4.3 用户拒绝处理

**降级方案**：
- 使用 `wx.getFuzzyLocation` 获取模糊位置
- 该接口需要较低级别的授权
- v2.16.0+ 基础库支持

**手动引导**：
```javascript
wx.openSetting({
  success(res) {
    if (res.authSetting['scope.userLocation']) {
      // 用户已手动开启位置权限
    }
  }
})
```

**错误处理**：
```javascript
wx.getLocation({
  fail(err) {
    if (err.errMsg.includes('auth deny')) {
      wx.showModal({
        title: '位置权限未开启',
        content: '请在设置中开启位置权限，以获得更好的体验',
        confirmText: '去设置',
        success(res) {
          if (res.confirm) {
            wx.openSetting();
          }
        }
      });
    }
  }
})
```

来源：[wx.getLocation 文档](https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.getLocation.html)

### 4.4 相关 API 列表

- `wx.onLocationChange` - 监听位置变化
- `wx.startLocationUpdate` - 开始持续监听位置
- `wx.chooseLocation` - 打开地图选择位置
- `wx.choosePoi` - 选择 POI 地点
- `wx.openLocation` - 查看位置

---

## 5. 地图个性化样式

### 5.1 个性化地图能力

**功能**：
- 通过 `subkey` 属性应用自定义地图样式
- 支持 `layer-style` 选择不同图层样式
- 可创建品牌化的地图风格

**申请流程**：
- 在腾讯位置服务控制台申请个性化样式
- 获取 subkey
- 在 map 组件中配置 `subkey` 和 `layer-style`

来源：[微信小程序 map 组件文档](https://developers.weixin.qq.com/miniprogram/dev/component/map.html)

---

## 6. 可行性与注意事项

### 6.1 功能可行性评估

**✅ 完全可行**：

1. **地图展示与交互**：`<map>` 组件提供完整的地图展示、缩放、拖拽等基础能力
2. **打卡点标记**：markers 支持自定义图标、点击事件、气泡弹窗
3. **照片与打分展示**：customCallout 支持完全自定义，可展示图片、评分、按钮
4. **定位授权**：完善的授权流程和降级方案，用户体验良好
5. **个人开发友好**：腾讯位置服务对个人开发者友好，基础功能免费

### 6.2 关键技术要点

**实现打卡功能的推荐方案**：
1. 使用 `<map>` 组件作为地图容器
2. 通过 `markers` 数组管理打卡位置
3. 使用 `customCallout` 自定义气泡，展示照片、评分、打卡按钮
4. 通过 `bindcallouttap` 事件处理打卡操作
5. 集成腾讯位置服务 SDK 进行 POI 搜索和地理编码

**数据流**：
```
用户位置 → 获取定位 → 地图展示 → 用户选择位置 → 打卡操作 → 保存记录
```

### 6.3 注意事项与风险

**技术层面**：
1. **平台兼容性**：customCallout 在 iOS 和 Android 上可能有样式差异，需要充分测试
2. **坐标系统**：注意使用 gcj02 坐标系，避免坐标偏移
3. **性能优化**：大量 marker 时使用点聚合（`joinCluster`）提升性能
4. **授权处理**：做好用户拒绝授权的降级方案

**配额与成本**：
1. **免费额度监控**：注意监控 API 调用量，避免超出免费额度
2. **配额申请**：提前评估需求，必要时申请提升配额
3. **企业认证**：如需更高配额，建议完成企业认证

**用户体验**：
1. **首次授权引导**：首次使用时提供清晰的授权说明
2. **权限拒绝处理**：提供友好的提示和重新授权入口
3. **加载状态**：地图加载时显示 loading 状态
4. **离线处理**：考虑网络异常时的降级体验

### 6.4 推荐开发路径

**阶段一**：基础地图功能
- 集成 `<map>` 组件
- 实现位置获取和地图展示
- 添加基础 marker 和点击事件

**阶段二**：打卡功能
- 实现 customCallout 自定义气泡
- 添加照片展示和评分显示
- 实现打卡按钮和跳转逻辑

**阶段三**：高级功能
- 集成腾讯位置服务 SDK
- 添加 POI 搜索和地理编码
- 实现地图个性化样式
- 优化性能和用户体验

---

## 7. 参考文档

### 官方文档
- [微信小程序 map 组件](https://developers.weixin.qq.com/miniprogram/dev/component/map.html)
- [wx.getLocation API](https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.getLocation.html)
- [wx.chooseLocation API](https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.chooseLocation.html)
- [腾讯位置服务小程序 SDK](https://lbs.qq.com/miniProgram/jsSdk/jsSdkGuide/jsSdkOverview)
- [腾讯位置服务 FAQ](https://lbs.qq.com/FAQ/index.html)

### 技术实践
- [微信小程序原生＜map＞地图实现标记多个位置](https://blog.csdn.net/qq_41646249/article/details/136769337)
- [map组件中的marker上的自定义气泡](https://developers.weixin.qq.com/community/develop/doc/0000e23e01cce099b0ca70ca456800)
- [掌握小程序地图高级定制：从基础到炫酷的Marker个性化全攻略](https://zhuanlan.zhihu.com/p/1955995946568639029)

---

**调研结论**：微信小程序的 `<map>` 组件配合腾讯位置服务 SDK 完全能够实现"旅行地图打卡"功能的所有需求，技术方案成熟可靠，个人开发者友好，建议按推荐路径逐步实现。