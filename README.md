### openclaw 微证券定制channel插件

插件为websocket客户端，发起微证券websocket服务端连接，支持断开重连

### 安装

- 放到~/.openclaw/extensions目录下，下载依赖npm install 
- 修改配置文件openclaw.json
```
"wzq-channel": {
  "accounts": {
    "default": {
      "enabled": true,
      "token": "",    # 必填，用于文件下载token
      "fileUrl": "",  # 文件下载链接，例如 http://9.134.53.188:8280/svr/openclaw/agent/get_image
      "wsUrl": "" # 微证券websocket服务端url，例如 ws://9.134.53.188:19113/test
    }
  }
}
```
- 重启，openclaw gateway restart即可

### 插件请求结构

| 字段名          |类型|描述|
|--------------|----|----|
| session_id   |string|会话id，上下文有联系|
| content_type |string|请求类型，如：text|
| content      |string|文本内容|


参考样例
```
{ "session_id": "123456", "content_type": "text", "content":"你是谁"}
```


### 插件返回结构
| 字段名          |类型| 描述                       |
|--------------|----|--------------------------|
| content         |string| AI返回的内容，内容可在插件处理也可在服务端处理 |
| content_type |string| 返回类型,text为文本内容           |


### 调试
启动test目录的server.js可以启动服务端，插件会连上，服务端可以命令行输入query，会发送给channel，等待AI执行完插件返回结果


### 坑点注意
1. 异步任务的返回可能会受到多channel的影响导致失败（日志会打印），如cron提醒，保留一个channel即可，其他可以配置不启用
2. 若要支持图片，需要能处理图片的模型，需要在openclaw.json配置
```
"agents": {
    "defaults": {
       "imageModel": {
           "primary": "claude/claude-sonnet-4-6" // 看图的模型
        }
    }
}
```
3. outbound的resolveTarget控制，消息通知投送给谁，先设置成default

