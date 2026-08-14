# 弱网/离线场景的上传策略调研

## 调研目的

针对 GitHub 工单 #8 的需求，调研微信小程序云存储直传（`wx.cloud.uploadFile`）在弱网/离线场景下的行为模式，以及「本地缓存后补传」的技术可行性，为家庭旅行打卡小程序的 MVP 阶段提供技术方案建议。

**调研日期**：2026-08-14  
**调研来源**：微信官方文档、腾讯云开发官方文档、微信开放社区  
**相关工单**：https://github.com/caosen469/wechat-miniprogram/issues/8

---

## 1. `wx.cloud.uploadFile` 云存储直传的弱网/断网行为

### 1.1 超时机制

**全局超时配置**：微信小程序支持在 `app.json` 中通过 `networkTimeout` 参数统一设置各类网络请求的超时时间。

```json
{
  "networkTimeout": {
    "request": 10000,      // wx.request 的超时时间
    "connectSocket": 10000, // wx.connectSocket 的超时时间
    "uploadFile": 10000,    // wx.uploadFile 的超时时间
    "downloadFile": 10000   // wx.downloadFile 的超时时间
  }
}
```

**默认超时时间**：一般请求默认超时时间为 **3秒**，但可通过配置调整。`wx.cloud.uploadFile` 继承此超时配置。

来源：[微信小程序网络性能优化文档](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/network.html)

### 1.2 弱网/断网场景的错误表现

根据微信官方文档，弱网/断网场景下可能出现以下错误：

**网络层面错误**（来自网络性能文档）：
- **`Underlying Transport Error`**：异常，大概率无网络（Android）
- **`Timer Expired`/`The total timed out`**：超时，弱网或无网
- **`TLS handshake failed/timed`**：TLS协商失败/超时
- **`network is down`**：网络关闭

**云存储层面错误**（来自云开发错误码文档）：
- **`-501002`**：云资源通用错误：云端响应超时
- **`-503001`**：云资源文件存储错误：云文件请求失败
- **`-403001`**：SDK 文件存储错误：上传的文件超出大小上限

**中断场景**：
- 小程序切后台 **5秒后**，会中断网络请求，开发者会收到 `interrupted` 的回调
- 切后台期间发起的网络请求会被中断
- iOS 14 本地网络开关关闭会导致局域网不通

来源：[微信小程序网络性能优化](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/network.html)、[云开发错误码文档](https://mp.weixin.qq.com/debug/minigame/dev/wxcloud/reference/errcode.html)

### 1.3 重试行为

**重要发现**：微信小程序的 `wx.cloud.uploadFile` **不提供内置的自动重试机制**。开发者需要自行实现重试逻辑。

**弱网监测能力**：
- 基础库 **2.19.0+** 提供 `wx.onNetworkWeakChange` 弱网变化通知
- **弱网判定标准**（最近8次请求中出现以下之一）：
  - 三次以上连接超时
  - 三次 RTT 超过 400
  - 三次以上丢包
- **通知规则**：状态变化时立即通知，状态不变时 30秒内最多通知一次

**网络状态监听**：
- 用户网络状态变化时通过 `wx.onNetworkStatusChange` 事件通知
- 可用于检测网络恢复，触发补传队列

来源：[微信小程序网络性能优化](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/network.html)

### 1.4 错误区分策略

根据官方文档，可以通过错误特征来区分不同类型的失败：

| 场景 | 错误特征 | 建议处理策略 |
|------|----------|-------------|
| **完全无网络** | `Underlying Transport Error`、`network is down` | 存入本地队列，等待网络恢复 |
| **弱网超时** | `Timer Expired`、`-501002` 云端响应超时 | 指数退避重试，3-5次后存入队列 |
| **文件过大** | `-403001` 文件超出大小上限 | 提示用户压缩文件或减小尺寸 |
| **权限问题** | `-503002` 无权限访问云文件 | 检查云存储权限配置 |
| **用户切后台** | `interrupted` 回调 | 存入队列，等待前台恢复 |

来源：[微信小程序网络性能优化](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/network.html)、[云开发错误码文档](https://mp.weixin.qq.com/debug/minigame/dev/wxcloud/reference/errcode.html)

---

## 2. 「本地缓存后补传」的技术方案

### 2.1 本地临时/缓存文件的有效期

**关键限制**：
- **本地临时文件**（`tempFilePath`）：**只保证在小程序当前生命周期内有效**，一旦小程序被关闭就可能被清理，下次冷启动不保证可用
- **本地缓存文件**：清理时机与代码包相同，只有在需要清理代码包时才会清理
- **本地用户文件**：与缓存文件清理时机一致
- **文件系统总容量**：小程序最多可存储 **200MB** 本地文件
- **Storage 上限**：每个小程序的 storage 上限为 **10MB**

**核心问题**：使用 `wx.chooseMedia` 返回的 `tempFilePath` 在小程序关闭后**不可用**，必须转换为持久存储。

来源：[微信小程序文件系统文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html)、[微信小程序存储文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/storage.html)

### 2.2 `wx.getFileSystemManager` 本地持久存储

**持久化方案**：
使用 `wx.saveFile()` 或 `FileSystemManager.saveFile()` 将临时文件保存为缓存文件。

```javascript
// 将临时文件保存为本地文件
wx.saveFile({
  tempFilePath: tempFilePath,
  success(res) {
    const savedFilePath = res.savedFilePath;
    // savedFilePath 可以持久使用
    // 原 tempFilePath 已不可用
  }
});
```

**注意**：
- 调用 `saveFile` 后，原 `tempFilePath` 将**不可用**（文件被移动）
- 可以通过 `getSavedFileList()` 获取已保存的文件列表
- 可以通过 `removeSavedFile()` 删除不需要的缓存文件

**文件管理能力**：
- 通过 `wx.getFileSystemManager()` 获取全局唯一的文件系统管理器
- 支持文件读写、复制、移动、删除等操作
- 文件系统按小程序和用户维度隔离

来源：[微信小程序文件系统文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html)、[FileSystemManager API](https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.getFileSystemManager.html)

### 2.3 使用 Storage 维护待传队列

**存储限制**：
- **wx.setStorage**：每个小程序 storage 上限为 **10MB**
- 除非用户主动删除或存储空间不足被系统清理，否则数据一直可用
- 适合存储上传队列的元数据（不包含文件本身）

**队列数据结构建议**：
```javascript
// 队列数据结构
const uploadQueue = {
  pending: [
    {
      id: 'unique_id',
      cloudPath: 'cloud://xxx',
      localPath: 'savedFilePath', // 持久化后的文件路径
      fileType: 'image',
      size: 1024000,
      createTime: 1691234567890,
      retryCount: 0,
      lastError: 'timeout'
    }
  ],
  uploading: [] // 正在上传的任务
};
```

**实现要点**：
1. **元数据存储**：使用 `wx.setStorageSync('uploadQueue', uploadQueue)` 存储队列元数据
2. **文件持久化**：使用 `wx.saveFile()` 将 `tempFilePath` 转换为持久路径
3. **状态管理**：区分 `pending`、`uploading`、`failed`、`completed` 状态
4. **幂等性**：服务端需支持重复请求的幂等处理（通过 `cloudPath` 唯一性）

来源：[微信小程序存储文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/storage.html)

### 2.4 onShow 补传机制

**实现流程**：
```javascript
Page({
  onShow() {
    this.checkAndRetryUploads();
  },

  checkAndRetryUploads() {
    const queue = wx.getStorageSync('uploadQueue') || { pending: [], uploading: [] };

    // 检查网络状态
    wx.getNetworkType({
      success: (res) => {
        if (res.networkType !== 'none') {
          // 有网络，处理待上传队列
          this.processUploadQueue(queue.pending);
        }
      }
    });
  },

  processUploadQueue(pendingItems) {
    // 限制并发数，避免过多网络请求
    const concurrency = 3;
    const itemsToProcess = pendingItems.slice(0, concurrency);

    itemsToProcess.forEach(item => {
      this.uploadSingleFile(item);
    });
  }
});
```

**关键技术点**：
1. **网络状态检测**：使用 `wx.getNetworkType` 或 `wx.onNetworkStatusChange` 监听网络变化
2. **并发控制**：限制同时上传的任务数量（建议 3-5 个）
3. **失败重试**：指数退避策略（1s、2s、4s、8s...）
4. **文件清理**：上传成功后及时清理本地文件

来源：[微信小程序网络API文档](https://developers.weixin.qq.com/miniprogram/dev/api/network/wx.getNetworkType.html)、[微信小程序上传API文档](https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/wx.uploadFile.html)

### 2.5 社区实践与成熟模式

**官方工具库**：
- **[miniprogram-file-uploader](https://github.com/wechat-miniprogram/miniprogram-file-uploader)**：微信官方维护的小程序文件上传库，支持分块上传，解决 10MB 大小限制

**社区实践**：
- 离线数据保存与联网自动上传方案（基于 UniApp + TypeScript）
- 前端大文件分片下载与断点续传的实战指南
- 微信小程序开发"避坑"指南（掘金）

**成熟模式总结**：
1. **文件持久化**：`tempFilePath` → `savedFilePath`
2. **元数据存储**：使用 Storage 维护上传队列状态
3. **网络监听**：监听网络状态变化，触发补传
4. **并发控制**：限制并发上传数量
5. **失败重试**：指数退避重试策略
6. **幂等性设计**：服务端支持重复请求的幂等处理

---

## 3. MVP 阶段建议

### 3.1 简单方案：直接失败提示

**适用场景**：
- 开发者是第一次做小程序的生手
- 项目初期，用户量少，网络环境相对稳定
- 快速验证产品核心功能

**实现要点**：
```javascript
wx.cloud.uploadFile({
  cloudPath: 'example.png',
  filePath: tempFilePath,
  success: res => {
    wx.showToast({ title: '上传成功', icon: 'success' });
  },
  fail: err => {
    wx.showModal({
      title: '上传失败',
      content: '网络不稳定，请稍后重试',
      showCancel: false
    });
  }
});
```

**优势**：
- **实现简单**：几行代码即可完成
- **学习成本低**：无需掌握复杂的队列管理
- **快速上线**：缩短开发周期

**劣势**：
- **用户体验差**：弱网场景下频繁失败
- **数据丢失风险**：用户关闭小程序后数据丢失
- **不适应旅行场景**：旅行中常处于弱网环境

**成本评估**：开发时间 1-2 天，无额外技术复杂度。

### 3.2 完整方案：本地队列自动补传

**适用场景**：
- 旅行打卡场景的核心需求
- 用户可能在弱网/离线环境下使用（如户外旅行、地铁等）
- 对用户体验要求较高

**实现要点**：

**1. 文件持久化**：
```javascript
// 选择媒体后立即持久化
wx.chooseMedia({
  count: 9,
  mediaType: ['image'],
  success: res => {
    const tempFiles = res.tempFiles;
    tempFiles.forEach(file => {
      wx.saveFile({
        tempFilePath: file.tempFilePath,
        success: res => {
          // 将 savedFilePath 存储到上传队列
          this.addToUploadQueue({
            localPath: res.savedFilePath,
            cloudPath: `images/${Date.now()}.jpg`,
            size: file.size
          });
        }
      });
    });
  }
});
```

**2. 队列管理**：
```javascript
// 全局队列管理
const uploadQueue = {
  pending: [],
  uploading: [],
  maxRetries: 3,
  concurrency: 3
};

// 添加到队列
addToUploadQueue(item) {
  uploadQueue.pending.push({
    ...item,
    id: Date.now().toString(),
    retryCount: 0,
    createTime: Date.now()
  });
  wx.setStorageSync('uploadQueue', uploadQueue);
  this.processQueue();
}

// 处理队列
processQueue() {
  while (uploadQueue.uploading.length < uploadQueue.concurrency && uploadQueue.pending.length > 0) {
    const item = uploadQueue.pending.shift();
    uploadQueue.uploading.push(item);
    this.uploadSingleFile(item);
  }
}

// 单文件上传
uploadSingleFile(item) {
  wx.cloud.uploadFile({
    cloudPath: item.cloudPath,
    filePath: item.localPath,
    success: res => {
      this.onUploadSuccess(item, res.fileID);
    },
    fail: err => {
      this.onUploadFail(item, err);
    }
  });
}

// 上传成功
onUploadSuccess(item, fileID) {
  // 从上传队列中移除
  uploadQueue.uploading = uploadQueue.uploading.filter(i => i.id !== item.id);
  wx.setStorageSync('uploadQueue', uploadQueue);

  // 清理本地文件
  wx.removeSavedFile({
    filePath: item.localPath
  });

  // 更新数据库记录
  this.db.collection('media_files').add({
    data: {
      fileID: fileID,
      createTime: new Date()
    }
  });

  // 继续处理队列
  this.processQueue();
}

// 上传失败
onUploadFail(item, error) {
  // 从上传中移除
  uploadQueue.uploading = uploadQueue.uploading.filter(i => i.id !== item.id);

  // 重试逻辑
  if (item.retryCount < uploadQueue.maxRetries) {
    item.retryCount++;
    const delay = Math.pow(2, item.retryCount) * 1000; // 指数退避
    setTimeout(() => {
      uploadQueue.pending.unshift(item); // 重新加入队列头部
      this.processQueue();
    }, delay);
  } else {
    // 超过最大重试次数，标记为永久失败
    item.failed = true;
    item.lastError = error.errMsg;
    wx.setStorageSync('uploadQueue', uploadQueue);
  }
}
```

**3. onShow 补传**：
```javascript
Page({
  onShow() {
    this.checkAndRetryFailedUploads();
  },

  checkAndRetryFailedUploads() {
    const queue = wx.getStorageSync('uploadQueue') || { pending: [], uploading: [] };

    // 检查网络状态
    wx.getNetworkType({
      success: (res) => {
        if (res.networkType !== 'none') {
          // 有网络，重置失败任务的重试次数
          queue.pending.forEach(item => {
            if (item.failed) {
              item.failed = false;
              item.retryCount = 0;
            }
          });
          wx.setStorageSync('uploadQueue', queue);
          this.processQueue();
        }
      }
    });
  }
});
```

**优势**：
- **用户体验好**：弱网场景下自动补传，用户无感知
- **数据安全**：文件持久化存储，不会因小程序关闭而丢失
- **适应旅行场景**：支持离线拍摄，联网后自动上传

**劣势**：
- **实现复杂**：需要处理队列、并发、重试、文件清理等逻辑
- **学习成本高**：需要掌握文件系统、存储管理、网络状态监听等API
- **存储限制**：需注意 10MB Storage 和 200MB 文件系统的限制

**成本评估**：开发时间 5-7 天，需要一定的调试和测试工作。

### 3.3 推荐方案

**对于本项目（4-6 人家庭圈旅行打卡小程序）的 MVP 建议**：

**建议采用「本地队列自动补传」方案**，原因如下：

1. **场景契合度高**：旅行场景中用户常处于弱网环境（如户外、地铁、国外等），离线拍摄、联网后自动上传是核心需求
2. **技术可行性高**：微信小程序提供了完整的 API 支持，社区有成熟实践可参考
3. **用户体验重要**：家庭用户对技术复杂度不敏感，但对数据安全和易用性要求高
4. **一次性投入**：虽然初期开发成本高，但一劳永逸，避免后期重构

**实施建议**：
1. **分阶段实现**：
   - **阶段一**（1-2 天）：实现基础的文件持久化和队列存储
   - **阶段二**（2-3 天）：实现上传队列管理和并发控制
   - **阶段三**（1-2 天）：实现网络监听和自动补传

2. **参考成熟方案**：使用微信官方的 [miniprogram-file-uploader](https://github.com/wechat-miniprogram/miniprogram-file-uploader) 作为基础，进行定制化开发

3. **渐进式测试**：
   - 在开发者工具中模拟弱网环境测试
   - 真机测试各种网络场景（WiFi、4G、弱网、离线）
   - 边界情况测试（小程序切换、关闭、内存不足等）

4. **监控和优化**：
   - 添加上传成功率监控
   - 记录常见错误类型，针对性优化
   - 定期清理失败的本地文件，避免存储溢出

---

## 4. 关键技术要点总结

### 4.1 API 汇总

| API | 用途 | 注意事项 |
|-----|------|----------|
| `wx.chooseMedia` | 选择媒体文件 | 返回 `tempFilePath` 需持久化 |
| `wx.cloud.uploadFile` | 上传到云存储 | 无内置重试，需自行实现 |
| `wx.saveFile` | 持久化临时文件 | 调用后原 `tempFilePath` 不可用 |
| `wx.getFileSystemManager` | 文件系统管理 | 提供完整的文件操作能力 |
| `wx.setStorage` | 存储队列元数据 | 上限 10MB，适合存元数据 |
| `wx.getNetworkType` | 检测网络状态 | 用于判断是否启动补传 |
| `wx.onNetworkStatusChange` | 监听网络状态变化 | 可用于网络恢复时触发补传 |
| `wx.onNetworkWeakChange` | 监听弱网状态（2.19.0+） | 可用于弱网优化策略 |

### 4.2 错误处理最佳实践

1. **分类处理**：根据错误类型采取不同策略（无网等待、超时重试、权限检查等）
2. **用户反馈**：提供清晰的错误提示和重试入口
3. **日志记录**：记录错误信息，便于分析和优化
4. **降级方案**：网络异常时提供基础功能的降级体验

### 4.3 存储管理建议

1. **定期清理**：上传成功后及时清理本地文件
2. **容量监控**：监控存储使用情况，避免溢出
3. **LRU 策略**：对本地文件实施最近最少使用淘汰策略
4. **用户提醒**：存储空间不足时提醒用户清理

---

## 5. 参考文档

### 官方文档
- [微信小程序文件系统](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html)
- [微信小程序存储](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/storage.html)
- [FileSystemManager API](https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.getFileSystemManager.html)
- [wx.cloud.uploadFile API](https://developers.weixin.qq.com/minigame/dev/wxcloud/reference-sdk-api/storage/uploadFile/client.uploadFile.html)
- [微信小程序网络性能优化](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/network.html)
- [云开发错误码](https://mp.weixin.qq.com/debug/minigame/dev/wxcloud/reference/errcode.html)
- [wx.getNetworkType](https://developers.weixin.qq.com/miniprogram/dev/api/network/wx.getNetworkType.html)
- [wx.onNetworkStatusChange](https://developers.weixin.qq.com/miniprogram/dev/api/network/wx.onNetworkStatusChange.html)

### 社区资源
- [miniprogram-file-uploader](https://github.com/wechat-miniprogram/miniprogram-file-uploader) - 微信官方文件上传库
- [微信小程序开发"避坑"指南](https://juejin.cn/post/7558321200049733641) - 掘金社区实践分享
- [UniApp + TS 离线数据保存与联网自动上传方案](https://blog.csdn.net/weixin_45844542/article/details/163101939) - CSDN 实践方案

---

## 调研结论

针对 GitHub 工单 #8 的三个问题：

1. **`wx.cloud.uploadFile` 云存储直传在弱网/断网下的实际行为**：
   - 超时时间默认为 3 秒，可通过 `app.json` 配置调整
   - 无内置重试机制，需自行实现
   - 提供详细的错误码用于区分无网/超时/失败场景
   - 小程序切后台 5 秒后会中断网络请求

2. **「本地缓存后补传」的成熟模式**：
   - `tempFilePath` 仅当前生命周期有效，必须通过 `wx.saveFile` 持久化
   - 可使用 `wx.getFileSystemManager` 进行本地文件管理（上限 200MB）
   - 可使用 Storage 维护上传队列元数据（上限 10MB）
   - 通过 `wx.onNetworkStatusChange` 监听网络恢复，触发补传
   - 社区有成熟实践可参考

3. **MVP 建议**：
   - **推荐采用「本地队列自动补传」方案**：虽然实现复杂度高（5-7 天开发），但更契合旅行场景的弱网使用环境，用户体验更好，数据更安全
   - 可分阶段实现，降低开发风险
   - 建议参考微信官方的 miniprogram-file-uploader 工具库进行定制化开发

**最终建议**：对于家庭旅行打卡小程序，离线上传能力是核心功能，值得在 MVP 阶段投入开发资源实现完整的本地队列自动补传方案。