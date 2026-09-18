# Douyin IM 术语

面向抖音账号的私信、群聊与会话管理。本文仅定义业务词汇；使用方式见 [使用指南](docs/guide.md)，实现职责见 [架构决策](docs/adr/0008-base-and-sdk-instance-layers.md)。

## 账号与认证

**Client**：
应用持有的多账号管理实例。它管理 Account 的注册、选择和总体生命周期。
_Avoid_：用 Client 指代单个抖音账号或底层 HTTP 连接。

**Account**：
应用管理的一个抖音账号身份及其当前认证上下文。它是联系人和事件的所属账号。
_Avoid_：CreatorAccount、把 Account 与聊天对端 User 混用。

**Session**：
Account 当前持有的一组认证凭据。
_Avoid_：把 Session 与单个 IM token 混用。

**DeviceProfile**：
Account 的设备身份资料，与 Session 分开维护。
_Avoid_：把设备身份与账号 UID 混用。

**Login**：
建立有效 Session 的流程，包含二维码、短信、密码及必要的安全验证。
_Avoid_：用 Login 泛指恢复已有 Session。

**Wake**：
恢复已有 Session，并按配置校验是否可继续使用的流程；恢复失败后进入 Login。
_Avoid_：把 Wake 当作另一种登录凭据。

**Verification**：
平台要求的额外身份或安全验证，完成后才能继续当前登录流程。
_Avoid_：把 Verification 当作验证绕过。

**PendingAccount**：
身份尚未确认的临时账号记录。
_Avoid_：Draft（作品草稿）。

**Promote**：
将 PendingAccount 提升为身份已确认的正式账号记录。
_Avoid_：把 Promote 与已登录账号的权限提升混用。

## 联系人与会话

**Friend**：
当前 Account 的好友私聊联系人。
_Avoid_：用 Friend 泛指任意消息发送者。

**Stranger**：
陌生人收件箱中的私聊联系人，与 Friend 分开管理。
_Avoid_：将陌生人箱解释为群聊。

**Group**：
当前 Account 参与的群会话。
_Avoid_：把群号与某个群成员 UID 混用。

**Member**：
某个 Group 内的一位成员；其角色和群名片属于该群。
_Avoid_：把 Member 当作可跨群共用的用户资料对象。

**Message**：
某个会话内的一条消息；可属于好友私聊、陌生人私聊或群聊。
_Avoid_：用 PrivateMessage 泛指所有上层消息事件。

**Request**：
需要当前 Account 决定同意或拒绝的申请。
_Avoid_：把邀请已发出、成员已入群等事实当作待审批请求。

**Notice**：
会话或关系变化的通知，描述已经发生的事实。
_Avoid_：给 Notice 附加 approve/reject 语义。

## 内容

**Work**：
抖音上的一条作品。当前 SDK 对作品提供只读查询，不代表具备发布或管理权限。
_Avoid_：将 Work 与当前账号拥有、可编辑的作品等同。

**SharedWork**：
IM 消息中的作品或图集分享对象，带有来源会话语境。
_Avoid_：作品管理对象。

**SharedComment**：
IM 消息中的评论分享对象，可查询展示状态。
_Avoid_：可发布、回复或删除的评论对象。

**Follower / Following**：
分别表示关注当前账号的人，以及当前账号已关注的人。
_Avoid_：将关系查询等同于关注/取关操作。
