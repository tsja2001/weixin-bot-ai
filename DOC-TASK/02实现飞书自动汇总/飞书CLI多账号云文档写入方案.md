# 飞书 CLI 多账号云文档写入方案

## 背景

设备会自动化执行多个项目任务，并生成需要汇总的数据。不同项目的数据需要写入不同飞书账号的云文档，例如：

- A 项目写入 A 飞书账号的云文档
- B 项目写入 B 飞书账号的云文档
- C 项目写入 C 飞书账号的云文档

已确认 A、B、C 是不同飞书账号。

## 调研结论

可以通过 `lark-cli` 的 `profile` 机制实现多账号区分，不需要为每次命令做复杂的手动切换。

`lark-cli` 支持全局参数 `--profile <name>`。每个 profile 保存一套应用配置和用户授权 token。自动化任务执行时，只要明确指定 profile，就可以按项目使用对应飞书账号访问和写入云文档。

示例：

```bash
lark-cli --profile user_a docs +update --doc <A文档token> ...
lark-cli --profile user_b docs +update --doc <B文档token> ...
lark-cli --profile user_c docs +update --doc <C文档token> ...
```

## 当前验证状态

当前设备已安装 `lark-cli version 1.0.48`，并完成了一个飞书账号授权。

已验证能力：

- 可以查看授权状态：`lark-cli auth status`
- 可以搜索当前账号拥有的云文档：`lark-cli drive +search --as user --mine`
- 可以读取 DOCX 云文档正文：`lark-cli docs +fetch --as user --api-version v2`

当前已有 profile：

```text
name: cli_aaa83f5fcf229bfc
user: 杨卓然
tokenStatus: valid
```

## 推荐实现方式

为每个飞书账号创建独立 profile，并在自动化任务配置中保存 profile 名称和目标文档 token。

建议配置结构：

```json
{
  "projectA": {
    "profile": "user_a",
    "docToken": "<A文档token>"
  },
  "projectB": {
    "profile": "user_b",
    "docToken": "<B文档token>"
  },
  "projectC": {
    "profile": "user_c",
    "docToken": "<C文档token>"
  }
}
```

自动化写入时根据项目选择对应 profile：

```bash
lark-cli --profile user_a docs +update --api-version v2 --doc <A文档token> ...
```

## 初始化流程

每个飞书账号需要初始化一次。

1. 添加 profile：

```bash
lark-cli profile add --name user_a --app-id <app_id> --app-secret-stdin --brand feishu
```

2. 使用对应飞书账号扫码授权：

```bash
lark-cli --profile user_a auth login --domain docs,drive
```

如果后续需要写电子表格、多维表格或发送消息，可以增加业务域：

```bash
lark-cli --profile user_a auth login --domain docs,drive,sheets,base,im
```

3. 验证授权：

```bash
lark-cli --profile user_a auth status
```

4. 验证文档访问：

```bash
lark-cli --profile user_a docs +fetch --as user --api-version v2 --doc <文档token> --limit 5
```

## App ID 选择

如果 A、B、C 账号属于同一飞书开放平台应用可授权范围，可以复用同一个 `app_id/app_secret`，分别创建不同 profile 并让不同用户扫码授权。

如果 A、B、C 属于不同租户，或需要更清晰的权限隔离和审计，建议为不同租户或账号配置独立应用，再分别创建 profile。

## 注意事项

- 自动化脚本必须显式传入 `--profile`，避免写入默认账号。
- profile 名称建议和项目或账号绑定，例如 `project_a_user`。
- 文档 token 和 profile 的映射应放在配置文件或数据库中，不要硬编码在业务逻辑里。
- 用户授权 token 有有效期，`lark-cli` 当前包含 `offline_access` scope，正常情况下可刷新；仍建议定期执行 `auth status` 做健康检查。
- 写入云文档前，建议先做一次只读校验，确认 profile 对目标文档有访问权限。

## 结论

该需求可以直接通过命令行区分用户实现。核心方案是每个飞书账号一个 `lark-cli profile`，自动化执行时通过 `--profile` 指定账号，通过目标文档 token 指定写入位置。
