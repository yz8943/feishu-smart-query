# Feishu Bitable 本地缓存智能查询

飞书多维表格内容制作项目查询工具。  
全量数据缓存到本地 JSON，通过 LLM 解析自然语言条件后本地过滤，速度快、支持所有字段类型。

---

## 适用问题类型

以下类型的问题应调用此工具：

- 查询某主持人/作者的项目
- 查询某时间范围内的项目（今年、去年、下周、下下周、最近N天、具体年月等）
- 查询某出品性质的项目（商配、自制、联制等）
- 多条件组合查询（人员 + 时间 + 出品性质等）
- 查询项目名称、上线日期、交片日期等任意字段

---

## 命令

```
node cli.js query --question "问题"
```

可选参数：
- `--table-name <名称>` 指定表格（默认取第一个）
- `--app-token <token>` 覆盖默认 App Token
- `--table-id <id>` 覆盖默认 Table ID

---

## 示例问题

```bash
node cli.js query --question "yyp今年商配"
node cli.js query --question "颜宇鹏下周项目"
node cli.js query --question "去年商配"
node cli.js query --question "曾颖卓2026商单"
node cli.js query --question "最近30天执行项目"
node cli.js query --question "2025年3月上线的项目"
node cli.js query --question "yyy下下周项目"
```

---

## 输出字段

每条结果只输出以下字段：

| 字段 | 说明 |
|------|------|
| 出品性质 | 商配 / 自制 / 联制等 |
| 项目名称 | 项目标题 |
| 主持人/作者 | 人员姓名，多人逗号分隔 |
| 上线日期 | 格式 yyyy-mm-dd |
| 实际交片日期 | 格式 yyyy-mm-dd |
| 执行日期 | 格式 yyyy-mm-dd |

---

## 人员别名对照表

查询时可使用真实姓名或以下别名，系统自动识别：

| 姓名 | 可用别名 |
|------|---------|
| 颜宇鹏 | yyp、YYP、yyy、YYY、宇鹏 |
| 袁启聪 | 聪、启聪 |
| 陈志豪 | 志豪 |
| 李立山 | 立山、山 |
| 曾颖卓 | 颖卓、卓 |
| 陈皓沛 | 皓沛、Alex |
| 郭健能 | 健能 |
| 王雨霜 | 雨霜 |
| 黄丽莹 | 丽莹 |
| 柳笛 | 笛 |
| 卢嘉杰 | 嘉杰 |
| 曾智聪 | 智聪 |
| 赵剑波 | 剑波 |
| 黎碧怡 | 碧怡、花花 |

---

## 时间表达方式

以下时间词在 JS 侧预先计算好日期范围再传给 LLM，不依赖 LLM 推断：

| 说法 | 对应范围 |
|------|---------|
| 今年 | 本年 1月1日 ~ 12月31日 |
| 去年 | 上一年 1月1日 ~ 12月31日 |
| 本周 / 这周 | 本周一 ~ 本周日 |
| 下周 | 下周一 ~ 下周日 |
| 下下周 | 下下周一 ~ 下下周日 |
| 上周 | 上周一 ~ 上周日 |
| 最近N天 | 今天往前N天 |
| 今天执行/上线/交片 | 当天（单说"今天"不加日期限制） |
| 2026 / 2026年 | 该年 1月1日 ~ 12月31日 |
| 2025年3月 | 该月 1日 ~ 末日 |

---

## 数据同步

### 手动同步
```bash
node cli.js sync           # 同步默认表格
node cli.js sync --all     # 同步所有配置表格
```

### 自动定时同步（30分钟/次）
```bash
node cli.js watch          # 前台运行
pm2 start cli.js -- watch  # 后台运行（推荐）
```

缓存文件位于 `cache/` 目录，同步一次约拉取 5000+ 条记录。

---

## 工作流程

```
用户自然语言问题
  ↓
JS预处理：人名别名 → 真实姓名，相对时间 → 具体日期范围
  ↓
LLM 解析剩余条件 → 结构化 JSON 数组
  ↓
本地 JSON 缓存逐条匹配（支持文本/单选/多选/人员/日期/数字所有字段类型）
  ↓
返回匹配结果（输出指定6个字段）
```

---

## 文件结构

| 文件 | 作用 |
|------|------|
| `cli.js` | 命令行入口，`query` / `sync` / `watch` 命令 |
| `sync.js` | 全量同步：分页拉取飞书数据 → 本地 JSON + 字段元数据 |
| `local-query.js` | 查询核心：预处理 + LLM解析 + 本地过滤 |
| `llm.js` | LLM 调用封装 |
| `tables.js` | 表格配置（name / tableId） |
| `cache/*.json` | 数据缓存（自动生成） |
| `cache/*.meta.json` | 字段元数据，含选项值采样（供 LLM 理解字段结构） |

---

## 环境变量（.env）

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxxx
FEISHU_APP_TOKEN=M4kKbxx

OPENAI_BASE_URL=https://api.stepfun.com/v1
OPENAI_API_KEY=xxxx
OPENAI_MODEL=step-3.5-flash
```

---

## 依赖安装

```bash
npm install
```
