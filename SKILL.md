# Feishu Bitable Query

查询飞书多维表格数据的工具。  
支持使用自然语言查询项目、主持人、执行日期、出品性质等信息。

AI 应在用户询问以下类型问题时调用该工具：

- 查询飞书多维表格记录
- 查询某个主持人的项目
- 查询某个时间范围内的执行项目
- 查询某种出品性质（如商配）的项目
- 查询最近、去年、今年等时间范围的数据

示例问题：

- 去年商配
- 颜宇鹏主持的项目
- 最近30天执行项目
- 今年商配项目
- 2024年执行的项目

---

## Command

smart-query

---

## Parameters

app-token  
飞书多维表格 App Token

table-id  
飞书表格 Table ID

question  
用户的自然语言问题

---

## Example

smart-query \
--app-token M4kKbxx \
--table-id tbxx \
--question "去年商配"

---

## What this tool does

1. 读取飞书多维表格字段结构
2. 使用 LLM 解析用户问题
3. 生成 Feishu filter JSON
4. 调用飞书 records/search API
5. 分页获取全部记录
6. 返回匹配结果

---

## Environment Variables

需要配置以下环境变量：

FEISHU_APP_ID  
FEISHU_APP_SECRET  

OPENAI_BASE_URL  
OPENAI_API_KEY  
OPENAI_MODEL  

示例：

export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxxx

export OPENAI_BASE_URL=https://api.stepfun.com/v1
export OPENAI_API_KEY=xxxx
export OPENAI_MODEL=step-3.5-flash

---

## Dependencies

需要 Node.js 依赖：

npm install axios