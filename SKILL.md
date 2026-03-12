# 大家车内容制作项目 — 飞书多维表格智能查询

查询「大家车内容制作项目」飞书多维表格数据。
支持任意自然语言问题，自动转换为飞书 filter 查询。

---

## 触发场景

当用户提问涉及以下内容时调用：

- 查询某位主持人/作者的项目
- 查询某个时间范围内的项目（今年、去年、最近N天、XXXX年、XXXX年X月）
- 查询某种出品性质（商配、自制等）的项目
- 查询某个平台（抖音、B站等）的项目
- 查询某类内容（详情、试驾、评测等）
- 查询某个车型/项目关键词（如"深蓝S09"、"理想L9"）
- 任意组合条件查询（如"去年YYP主持的商配抖音项目"）

---

## Command

```
node cli.js smart-query --question "<问题>"
```

或带参数：

```
node cli.js smart-query \
  --question "<问题>" \
  --table-name "大家车内容制作项目"
```

---

## 查询示例

| 用户问题 | 说明 |
|---|---|
| 去年商配 | 时间+枚举筛选 |
| YYP主持的项目 | 人员筛选（alias识别） |
| 最近30天执行项目 | 相对时间 |
| 今年商配抖音项目 | 多条件组合 |
| 深蓝S09的详情 | 文本+枚举 |
| 2024年颜宇鹏的B站视频 | 年份+人员+平台 |
| 2025年3月的项目 | 精确到月 |

---

## 工作流程

```
用户问题
  │
  ├─ loadFields()       读取表格字段结构（缓存，只调用一次）
  │    └─ 构建字段索引：文本/日期/人员/单选/多选/数字
  │
  ├─ llmBuildChildren() 调用 LLM 生成 filter children
  │    └─ Prompt 包含：完整字段名+类型、所有枚举选项、用户别名+openid、时间戳参考
  │
  ├─ applyTimePatch()   时间规则补丁（规则计算精确时间戳，覆盖 LLM）
  │
  ├─ dedup()            去重
  │
  └─ searchRecords()    调用飞书 API 分页获取全部匹配记录
```

---

## 环境变量

```env
# 飞书应用凭证
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxxx
FEISHU_APP_TOKEN=M4kKbkaQ2ahUlHsoNMFcrnQ0nRh

# LLM（兼容 OpenAI 格式）
OPENAI_BASE_URL=https://api.stepfun.com/v1
OPENAI_API_KEY=xxxx
OPENAI_MODEL=step-3.5-flash
```

---

## 表格配置（tables.js）

```js
module.exports = [
  {
    name: "大家车内容制作项目",
    tableId: "tblAeunK57bV4BdQ",
    appToken: process.env.FEISHU_APP_TOKEN
  }
]
```

---

## 人员配置（smart-query.js 顶部）

在 `KNOWN_USERS` 数组中维护人员别名：

```js
{ name: "颜宇鹏", alias: ["YYP", "yyp", "宇鹏"] }
```

在 `USER_OPENID` 中维护 openid 映射：

```js
"颜宇鹏": "ou_c5aaa8352b4879d307f2771686e80b47"
```

> 人员 openid 获取方式：飞书管理后台 → 成员管理 → 点击成员 → 复制 Open ID

---

## 依赖安装

```bash
npm install
```

依赖：`axios`、`commander`、`dotenv`

---

## 注意事项

- 字段结构首次查询时自动读取并缓存，重启进程后重新读取
- 时间条件由规则计算（非 LLM），确保时间戳精确
- 枚举防误匹配：项目名/型号中的字母不会被误识别为枚举选项
- LLM 无法识别的问题会返回全部记录（空 filter）
