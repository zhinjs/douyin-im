# ADR 0003：业务对象直接承载动作

已接受。公开路径保持为 Client → Account → 联系人；被动消息通过 event.account 和当前联系人执行动作。
列表查询与同步 pick 分开，避免选择一个对象时隐式发生网络请求。

共同聊天动作在 ChatContact 实现，群、好友、陌生人只增加各自差异；
账号拥有唯一的发送器、连接上下文和联系人缓存。独立模块仅保留真正需要集中维护的复杂性：

- AccountAuth：多步认证、验证续登和身份确认。
- AccountRuntime / ConnectionManager：协议状态、连接生命周期与资源清理。
- OutboundSender：内容构建、上传和发送通道。
- ImInboxQueries：列表查询及资料映射。
- EventAssembler / 路由：通知和申请装配、缓存更新与同实例派发。

不再通过一组镜像业务接口逐层转发，也不为维持旧类名保留兼容包装。
这使业务动作可以从所属对象直接定位到规则实现；协议编码和上传细节仍集中在协议模块中复用。

继承职责与当前目录以 [ADR 0008](0008-base-and-sdk-instance-layers.md) 为唯一架构说明；
调用示例见 [使用指南](../guide.md)，协议模块的保留理由见 [ADR 0004](0004-im-protocol-modules.md)。
