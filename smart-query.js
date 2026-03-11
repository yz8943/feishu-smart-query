const { getFields, searchRecords } = require("./feishu-api")
const { callLLM } = require("./llm")


/**
 * 提取JSON
 */
function parseLLMJson(text) {

  try {
    return JSON.parse(text)
  } catch {

    const match = text.match(/\{[\s\S]*\}/)

    if (!match) {
      throw new Error("LLM JSON解析失败:\n" + text)
    }

    return JSON.parse(match[0])
  }
}

/**
 * 时间语义解析
 */
function parseDateWords(question) {

  const now = new Date()

  if (question.includes("今年")) {

    const start = new Date(now.getFullYear(),0,1).getTime()
    const end = new Date(now.getFullYear()+1,0,1).getTime()

    return { start,end }
  }

  if (question.includes("最近30天")) {

    const end = Date.now()
    const start = end - 30*24*3600*1000

    return { start,end }
  }

  return null
}

/**
 * 修复日期filter
 */
function fixDateFilter(filter) {
  if (!filter?.filter?.conditions) return filter

  for (const c of filter.filter.conditions) {
    if (!Array.isArray(c.value)) continue

    let v = c.value[0]

    // 转为毫秒时间戳
    const ts = toExactDate(v)
    if (ts) {
      if (c.field_name.includes("日期") || c.field_name.includes("时间")) {
        c.value = ["ExactDate", String(ts)]
        if (c.operator === "isGreaterEqual") c.operator = "isGreater"
        if (c.operator === "isLessEqual") c.operator = "isLess"
      }
    }
  }
  return filter
}
/**
 * 修复字段名称，防止LLM生成错误字段
 */
function fixFieldName(filter, fields) {
  const names = fields.map(f => f.name)
  for (const c of filter.filter.conditions) {
    if (!names.includes(c.field_name)) {
      const found = names.find(n => n.includes(c.field_name) || c.field_name.includes(n))
      if (found) c.field_name = found
    }
  }
  return filter
}



/**
 * 过滤重要字段
 */
function pickImportantFields(fields) {

  const keywords = ["日期","时间","作者","主持","性质","类型"]

  return fields.filter(f =>
      keywords.some(k => f.name.includes(k))
  )
}

function ensureFilter(filter) {
  if (!filter.filter) filter.filter = {}
  if (!filter.filter.conditions) filter.filter.conditions = []
  if (!filter.filter.conjunction) filter.filter.conjunction = "and"
  return filter
}

/**
 * 安全添加条件
 */
function addCondition(filter, condition) {
  if (!filter.filter) filter.filter = {}
  if (!filter.filter.conditions) filter.filter.conditions = []
  if (!filter.filter.conjunction) filter.filter.conjunction = "and"
  filter.filter.conditions.push(condition)
}


function fixOperator(filter) {
  const allowed = ["is","isNot","contains","doesNotContain","isEmpty","isNotEmpty",
    "isGreater","isGreaterEqual","isLess","isLessEqual","like","in"]

  for (const c of filter.filter.conditions) {
    if (!allowed.includes(c.operator)) {
      // 自动替换
      if (c.operator === "isWithin") c.operator = "in"
      else c.operator = "is" // 默认兜底
    }
  }
  return filter
}

function toExactDate(value) {
  let ts = 0
  if (typeof value === "number") {
    ts = value
    // 秒级时间戳 → 毫秒
    if (ts < 1e12) ts = ts * 1000
  } else if (typeof value === "string") {
    // 解析 "YYYY-MM-DD"
    const d = new Date(value)
    ts = d.getTime()
  }
  return ts
}

function buildPrompt(question, fields) {

  const fieldList = fields
      .map(f => `- ${f.name} (${f.type})`)
      .join("\n")

  return `
你是飞书多维表格查询助手。

用户问题：
${question}

表字段：

${fieldList}

生成 Feishu Bitable filter JSON。

规则：

1 只返回JSON
2 不要markdown
3 不要解释
4 字段名必须使用上面的字段

格式：

{
 "filter":{
  "conjunction":"and",
  "conditions":[]
 }
}
`
}

async function smartQuery(appToken, tableId, question) {

  console.log("读取字段结构...")

  let  fields = await getFields(appToken, tableId)

  console.log("字段数量:", fields.length);

  fields = pickImportantFields(fields)

  console.log("关键字段:", fields.map(f=>f.name).join(","))

  const prompt = buildPrompt(question, fields)

  console.log("prompt:",prompt);

  console.log("LLM解析问题...")

  const llmResult = await callLLM(prompt)


  let filter;
  try {

    //解析成json
    filter = parseLLMJson(llmResult);
    console.log("LLM filter1:", filter);
    // 初始化 filter 结构，保证 conjunction 存在
    filter = ensureFilter(filter);
    console.log("LLM filter2:", filter);

    filter = fixDateFilter(filter)

    filter = fixFieldName(filter, fields);

    /**
     * 自动时间识别
     */
    const date = parseDateWords(question)
    if (date) {
      const start = toExactDate(date.start);
      const end = toExactDate(date.end);
      addCondition(filter, { field_name:"执行日期", operator:"isGreater", value:["ExactDate",String(start)] })
      addCondition(filter, { field_name:"执行日期", operator:"isLess", value:["ExactDate",String(end)] })
    }

    filter = fixOperator(filter);

    console.log("LLM filter3:", filter);


  } catch (e) {
    console.error("LLM JSON解析失败:", llmResult)
    //throw e
  }

  console.log(
      "最终Filter:",
      JSON.stringify(filter,null,2)
  )
  const records = await searchRecords(
      appToken,
      tableId,
      filter.filter
  )

  console.log("查询记录:", records.length)

  return records
}

module.exports = { smartQuery }