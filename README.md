# 飞书多维表格智能查询 v2 - 本地缓存方案

## 架构对比

```
旧方案（实时API）              新方案（本地缓存）
─────────────────────         ─────────────────────────────
用户提问                       用户提问
  ↓                              ↓
飞书API获取字段结构            LLM 解析条件（基于字段元数据）
  ↓                              ↓
LLM 生成 filter JSON          本地 JSON 直接过滤
  ↓                              ↓
飞书API搜索（受filter限制）    返回结果（毫秒级）
  ↓
返回结果

缺点：                         优点：
- 慢（多次API往返）            - 快（本地过滤，毫秒级）
- filter不支持所有字段类型     - 所有字段类型都能筛选
- 枚举值要先查才知道           - LLM能看到真实数据采样
- 分页有限制                   - 无任何限制
```

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `sync.js` | 全量同步模块：分页拉取飞书数据，写入本地 JSON 缓存 |
| `local-query.js` | 查询模块：LLM 解析条件 + 本地过滤 |
| `cli.js` | 命令行入口，整合所有命令 |
| `cache/` | 自动生成，存放缓存 JSON 和字段元数据 |

---

## 快速开始

### 1. 手动同步（首次使用）

```bash
# 同步默认表格
node cli.js sync

# 同步指定表格
node cli.js sync --table-name 大家车内容制作项目

# 同步所有配置表格
node cli.js sync --all
```

### 2. 查询

```bash
# 推荐：本地缓存查询（新方案）
node cli.js query --question "去年商配"
node cli.js query --question "颜宇鹏主持的项目"
node cli.js query --question "今年1月执行的项目"
node cli.js query --question "最近30天商配项目"

# 兼容：实时API查询（旧方案）
node cli.js smart-query --question "去年商配"
```

### 3. 启动定时自动同步守护进程

```bash
# 前台运行（测试用）
node cli.js watch

# 后台运行（推荐用 pm2）
npm install -g pm2
pm2 start cli.js -- watch
pm2 save
```

---

## 缓存文件说明

同步后会在 `cache/` 目录生成两个文件：

### `{appToken}_{tableId}.json` - 数据缓存
```json
{
  "syncedAt": "2025-01-15T10:30:00.000Z",
  "total": 5234,
  "records": [
    { "项目名称": "XXX节目", "出品性质": {"text": "商配"}, ... },
    ...
  ]
}
```

### `{appToken}_{tableId}.meta.json` - 字段元数据
```json
{
  "fields": [
    {
      "name": "出品性质",
      "type": 3,
      "typeLabel": "单选",
      "options": ["商配", "自制", "联制"],
      "sampleValues": ["商配", "自制"]
    },
    {
      "name": "主持人/作者",
      "type": 11,
      "typeLabel": "人员",
      "sampleValues": ["颜宇鹏", "曾颖卓"]
    }
  ]
}
```
字段元数据传给 LLM，让它理解表格结构和真实选项值。

---

## 查询原理

```
用户问题: "去年商配颜宇鹏主持的项目"
  ↓
传给 LLM，附带字段结构和真实选项值
  ↓
LLM 返回结构化条件:
[
  {"field": "出品性质", "op": "contains", "value": "商配"},
  {"field": "主持人/作者", "op": "person", "value": "颜宇鹏"},
  {"field": "执行日期", "op": "dateRange", "start": "2024-01-01", "end": "2024-12-31"}
]
  ↓
本地 JS 逐条匹配缓存数据（兼容所有字段类型）
  ↓
返回匹配结果
```

---

## 支持的筛选条件类型

| 条件类型 | 支持字段 | 说明 |
|---------|---------|------|
| `contains` | 文本、单选、多选、超链接 | 包含关键词 |
| `person` | 人员字段 | 按姓名/别名匹配，自动解析别名 |
| `dateRange` | 日期字段 | 起止日期范围 |
| `eq/gt/gte/lt/lte` | 数字字段 | 数值比较 |
| `or` | 任意 | 子条件 OR 组合 |
| 无条件兜底 | 全部字段 | 全文搜索 |

---

## 同步频率建议

在 `sync.js` 顶部调整 `SYNC_INTERVAL_MS`：

```js
const SYNC_INTERVAL_MS = 30 * 60 * 1000  // 30分钟（默认）
const SYNC_INTERVAL_MS = 60 * 60 * 1000  // 1小时
const SYNC_INTERVAL_MS =  5 * 60 * 1000  // 5分钟（数据变化频繁时）
```

---

## 环境变量

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxxx
FEISHU_APP_TOKEN=M4kKbxx

OPENAI_BASE_URL=https://api.stepfun.com/v1
OPENAI_API_KEY=xxxx
OPENAI_MODEL=step-3.5-flash
```
