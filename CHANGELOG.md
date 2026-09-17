# Changelog

本项目的所有重要变更记录于此文件。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-09-17

### Added

- 落地页与账号体系：邮箱验证码注册 / 登录 / 改密 / 找回密码 / 昵称头像资料
- 工作台：模板画廊（8 套原创模板）、任务系统（增删改查 / 取消退额）、交互画布（拖拽 / 缩放 / 整理布局 / 灯箱 / 浮动工具栏）
- 真实生图网关对接：文生图（images/generations）+ 图生图（images/edits，参考图 multipart）
- 云端任务队列：租约认领、崩溃回收重排、watch 长轮询实时状态
- 额度计费：注册赠送、按张扣费、失败/取消退回、充值套餐、CDK 兑换、邀请奖励
- 验证码邮件：Mailer 抽象（console / SMTP / Resend / SendGrid）
- Docker 一键部署（多阶段构建 + 数据卷持久化 + 健康检查）
- 质量保障：54 个单元测试、ego-browser 端到端（5 轮）与验收套件（A–F）

[Unreleased]: https://github.com/evanfang0054/motif/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/evanfang0054/motif/releases/tag/v0.1.0
