# Account 以 platformUid 为唯一标识

每个已确认账号以规范 `platformUid` 作为目录主键，对外由 `account.uid` 暴露。
当前存储实现优先读取登录结果 `user_data.user_id_str`，其次为字符串 `user_data.user_id`；
不将 Passport Cookie 的 `uid_tt` 或 `sec_uid` 直接当作规范主键。缺少可靠身份时中止提升。

`accountId` 是账号注册/选择的输入，可是规范身份、已记录别名或登录手机号；
它不保证原样成为存储目录名。`account.imUid` 是 IM 身份，不能与手机号或 `secUid` 任意替换。

扫码进行中尚无 `platformUid` 时，使用 **PendingAccount** 存放在 `accounts/_pending/`，登录成功后通过 **Promote** 迁移到 `accounts/<platformUid>/`。

曾考虑用户自定义 accountId（便于记忆与换绑），但会增加与平台身份对账的映射层；当前选择以平台 ID 为唯一键，减少漂移与并发写冲突。
