# @guaguasong/dsh-attachment-s3

[English](README.md) | 中文

DeepSeek Harness 附件 seam 的 S3 存储。它实现 [`AttachmentStore`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/attachment/attachment) —— 与内置的 `@deepseek-ai/dsh-attachment-local`（存在 `DSH_HOME` 下）是同一个抽象服务 —— 于是会话图片存进 bucket，而不是绑在录入它的那台机器上。该 seam 只接受一个 provider，所以本插件是**替换**本地后端，不与之并存。

bucket 对模型完全不可见：写进会话日志的仍是那个不透明的 `sha256:` 引用，因此在两个后端之间迁移不改变一份 transcript 的含义。

## 安装

```sh
dsh plugin --profile <name> add @guaguasong/dsh-attachment-s3
export DSH_ATTACHMENT_S3_BUCKET=my-attachments
export DSH_ATTACHMENT_S3_REGION=us-east-1
dsh --profile <name>
```

本包声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，`dsh plugin` 会把它追加到该 profile 的 bundle 层栈。它的 patch 会禁用 `dsh-base` 插入的 `attachment-local` 行，并加入 `attachment-s3` 行。启动前确认这两件事：

```sh
dsh --profile <name> --dump-config | grep -A2 'id: attachment'
```

`dsh plugin --profile <name> remove @guaguasong/dsh-attachment-s3` 会撤销安装并恢复本地后端。

### 环境变量

bundle patch 在挂载时从环境读取配置。`DSH_` 前缀的名字必须来自启动环境——`export` 出来或写在拉起 dsh 的服务单元里；launcher 拒绝 `.env` 文件里的该前缀。凭据**值**的变量名由你自己定，可以放进 `$DSH_HOME/.env`。

| 变量 | 配置字段 |
|---|---|
| `DSH_ATTACHMENT_S3_BUCKET` | `bucket` —— 必填；未设置时启动即在该行失败，而不是把附件存到别处 |
| `DSH_ATTACHMENT_S3_REGION` | `region` |
| `DSH_ATTACHMENT_S3_ENDPOINT` | `endpoint` —— S3 兼容服务 |
| `DSH_ATTACHMENT_S3_FORCE_PATH_STYLE` | `forcePathStyle` —— 设为 `true` 启用 |
| `DSH_ATTACHMENT_S3_PREFIX` | `prefix` |
| `DSH_ATTACHMENT_S3_ACCESS_KEY_ID_REF` | `accessKeyIdRef` —— 持有密钥的变量**名字**，不是密钥本身 |
| `DSH_ATTACHMENT_S3_SECRET_ACCESS_KEY_REF` | `secretAccessKeyRef` |
| `DSH_ATTACHMENT_S3_SESSION_TOKEN_REF` | `sessionTokenRef` |
| `DSH_ATTACHMENT_S3_VARIANT_CACHE_DIR` | `variantCacheDir` |

不想依赖环境变量，就把该行固定写进 `$DSH_HOME/profiles/<name>/cordis.patch.yml`——它在所有 bundle 层之后应用。按 id 定位的 patch 会替换整个 `config`，要保留的字段需一并重述：

```yaml
- id: attachment-s3
  name: '@guaguasong/dsh-attachment-s3'
  config:
    bucket: my-attachments
    region: us-east-1
```

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `bucket` | —（必填） | 存放全部附件对象的 bucket。 |
| `region` | 由 SDK 解析 | bucket 所在区域。 |
| `endpoint` | AWS S3 | S3 兼容服务的 endpoint。 |
| `forcePathStyle` | `false` | path-style 寻址，多数 S3 兼容服务需要。 |
| `prefix` | `attachments/v1` | 本部署拥有的对象键前缀。 |
| `accessKeyIdRef` | — | 持有 access key id 的环境变量名。 |
| `secretAccessKeyRef` | — | 持有 secret access key 的环境变量名。 |
| `sessionTokenRef` | — | 持有 session token 的环境变量名。 |
| `maxImageBytes` | 20 MiB | 提交的单张图片最大编码字节数。 |
| `maxImagesPerMessage` | 20 | 单条消息最大图片数。 |
| `maxMessageImageBytes` | 200 MiB | 单条消息图片编码字节总量上限。 |
| `maxImagePixels` | 64,000,000 | 提交的单张图片固有宽 × 高上限。 |
| `maxImageDimension` | 8192 | 单张图片固有宽、高各自的上限（按边）。 |
| `normalizedImageMaxDimension` | 2048 | 入库图片的长边；超过的会被缩到这个尺寸。 |
| `normalizedImageMaxBytes` | 4 MiB | 入库图片的字节预算。 |
| `variantCacheDir` | Harness home 下 | 派生请求图片的本地缓存目录。 |

准入、归一化、请求图片派生都委托给内置的 `@deepseek-ai/dsh-attachment-local`——它把这些能力导出为普通函数；上表的默认值也是从它再导出而非另抄一份。这样两个后端共用同一套编码策略：同一张图被接受、入库、送到模型面前的结果都一致，本包只负责 bucket 那一半。bucket 本就管辖的对象策略——默认加密、存储类别、生命周期——交给 bucket。

配置里携带的是凭据**引用**而非值，与 harness 的[凭据 seam](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/credentials) 一致。每次请求重新解析：加载了凭据 provider 就走 `ctx.credentials`，否则走进程环境，因此轮换后的密钥下一次请求即生效。两个 key 引用要么都写要么都不写：只写一半会在加载时失败，而不是悄悄用 SDK 环境里的默认身份签名。都不写正是实例角色部署的常规做法。

## 存储方式

```
<prefix>/objects/<哈希前两位>/<sha256 十六进制>
```

每张不同的图片一个不可变对象：`Content-Type` 为校验过的媒体类型，SHA-256 作为对象校验和发送，固有 `width`/`height` 记入对象元数据。会话日志里记的是 `sha256:<hex>`——不透明 id，既不是键也不是 URL。前缀里的 `v1` 段把未来不兼容的布局隔开。

进 bucket 的是**归一化之后**的图片，而不是提交的原始字节：准入会把过大的源缩到入库长边并按字节预算重编码，引用里记下原始尺寸。送进模型请求的那一版则按需从入库对象派生、缓存在本地——它可复现，不该占 bucket。

- **一次写入。** 上传是条件写（`If-None-Match: *`），并发写入相同字节的写者不会互相覆盖。竞争失败的一方不重传，而是校验已存在的对象：有校验和就比校验和，不搬字节；没有就把对象读回来比对——否则等长替换会让这次保存发布一个之后永远读不出来的引用。
- **读取即校验。** 读取只请求引用声明的字节范围，回来后重算摘要并重解析图片头，因此 bucket 侧的替换以 `ATTACHMENT_CORRUPT` 暴露，不会进入模型请求。
- **失败码。** 准入保留 seam 中调用方可纠正的码（`IMAGE_TOO_LARGE`、`IMAGE_TYPE_MISMATCH`、`IMAGE_TOO_MANY_PIXELS`、`IMAGE_DIMENSION_TOO_LARGE`、`INVALID_IMAGE`）；存储失败为 `ATTACHMENT_WRITE_FAILED`、`ATTACHMENT_READ_FAILED`、`ATTACHMENT_NOT_FOUND`、`ATTACHMENT_CORRUPT`，各自带上底层 cause。

## S3 兼容服务

本后端对 bucket 有四项要求：拒绝已占用键的条件写、可发送并读回的对象校验和、range 读取、可区分的「键不存在」。AWS S3 四项齐全，其他服务各有差异。接入前先探测：

```sh
PROBE_ENDPOINT=https://s3.example.com PROBE_REGION=us-east-1 PROBE_BUCKET=<bucket> \
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... pnpm run probe
```

它写入并删除一个小对象，报告该服务在每项行为上的表现。**忽略**条件写的服务仍然可用：键就是字节的摘要，覆盖写入的正是已经在那里的字节，而且发布引用的正是写入它的那一方——存储依然去重，重复的只是上传。**拒绝**条件写或校验和头的服务，本后端按现状跑不了。

## 开发

```sh
pnpm install       # 会跑 `prepare`，构建出 lib/
pnpm run test      # 单元测试，包含用真实 AWS SDK 打本地回环 S3 兼容服务
pnpm run typecheck
pnpm run build
pnpm run test:e2e  # 真实 bucket；没有 DSH_S3_E2E_BUCKET 时自动跳过
```

`pnpm run test` 不需要 bucket 也不需要联网：`tests/support/fake-s3.ts` 直接应答 SDK 真正发出的 S3 请求，签名、条件写、range 读取和状态码分类都是真实走过的。e2e 读取 `DSH_S3_E2E_BUCKET`，可选 `DSH_S3_E2E_REGION`、`DSH_S3_E2E_ENDPOINT`、`DSH_S3_E2E_FORCE_PATH_STYLE`、`DSH_S3_E2E_PREFIX`；它写在每次运行随机生成的前缀下，并删除自己写入的对象。

发布时 `prepublishOnly` 会先跑：clean、typecheck、全套测试、build。

## 已知限制与未尽事项

- **没有保留期与删除。** 对象只写不删；两个后端的 seam 都没有保留策略。只能靠 bucket 生命周期规则回收，而过期掉某个会话仍在引用的对象会让该附件变成 `ATTACHMENT_NOT_FOUND`。
- **只支持图片。** seam 的第一版面只承载 PNG、JPEG、WebP、GIF。
- **一个部署一个 bucket。** 把会话或工作区路由到不同 bucket 需要一层本包没有的路由。
- **整对象传输。** 读取会把整张图片缓冲进内存，受 `maxImageBytes` 约束。
- **共享不只需要附件。** 会话日志仍在该 profile 的持久化后端所在之处——默认是 `$DSH_HOME/sessions`，机器本地。bucket 让附件持久且集中受管，但它本身并不能让另一台机器读到某个会话。
