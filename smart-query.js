const { searchRecords, getFields } = require("./feishu-api")
const { callLLM } = require("./llm")

/* ---------------- 人员映射 ---------------- */

const PERSON_ID_MAP = {
  "颜宇鹏": "ou_c5aaa8352b4879d307f2771686e80b47",
  "yyp": "ou_c5aaa8352b4879d307f2771686e80b47",
  "YYP": "ou_c5aaa8352b4879d307f2771686e80b47",
  "曾颖卓": "ou_ae76bfcf2a489bd8f4755d27dcc286bb"
}

/* ---------------- 枚举词典 ---------------- */

const ENUM_DICT = {
  "商配": "出品性质",
  "原创": "出品性质",
  "栏目": "出品性质"
}

/* ---------------- 缓存 ---------------- */

let FIELD_CACHE = null

let FIELD_INDEX = {
  text: [],
  date: [],
  user: [],
  select: []
}

/* ---------------- 加载字段 ---------------- */

async function loadFields(appToken, tableId) {

  if (FIELD_CACHE)
    return FIELD_CACHE

  const res = await getFields(appToken, tableId)

  const fields = res?.data?.items || res?.items || []

  FIELD_CACHE = fields

  buildFieldIndex(fields)

  return fields
}

/* ---------------- 构建字段索引 ---------------- */

function buildFieldIndex(fields) {

  FIELD_INDEX = {
    text: [],
    date: [],
    user: [],
    select: []
  }

  for (const f of fields) {

    const name = f.field_name || f.name
    const type = f.type

    if (!name) continue

    if (type === 1)
      FIELD_INDEX.text.push(name)

    if (type === 5)
      FIELD_INDEX.date.push(name)

    if (type === 11)
      FIELD_INDEX.user.push(name)

    if (type === 3 || type === 4)
      FIELD_INDEX.select.push(name)

  }

  console.log("字段索引:", FIELD_INDEX)

}

/* ---------------- 创建Filter ---------------- */

function createFilter() {

  return {
    filter: {
      conjunction: "and",
      children: []
    }
  }

}

/* ---------------- 主入口 ---------------- */

async function smartQuery(appToken, tableId, question) {

  console.log("问题:", question)

  await loadFields(appToken, tableId)

  let filter = await buildFilter(question)

  filter = fixFilter(filter)

  console.log("最终Filter:", JSON.stringify(filter, null, 2))

  const records = await searchAll(appToken, tableId, filter.filter)

  console.log("查询结果:", records.length)

  return records
}

/* ---------------- 构建Filter ---------------- */

async function buildFilter(question) {

  const filter = createFilter()

  const person = detectPerson(question)

  const time = parseTime(question)

  const enums = detectEnum(question)

  if (person)
    addPerson(filter, person)

  if (time)
    addTime(filter, time)

  if (enums.length)
    filter.filter.children.push(...enums)

  if (filter.filter.children.length > 0)
    return filter

  const llm = await llmParse(question)

  filter.filter.children.push(...llm)

  return filter
}

/* ---------------- 人员识别 ---------------- */

function detectPerson(question) {

  const q = question.toLowerCase()

  for (const name in PERSON_ID_MAP) {

    if (q.includes(name.toLowerCase()))
      return PERSON_ID_MAP[name]

  }

  return null
}

/* ---------------- 添加人员条件 ---------------- */

function addPerson(filter, id) {

  const conditions = []

  for (const field of FIELD_INDEX.user) {

    conditions.push({
      field_name: field,
      operator: "contains",
      value: [id]
    })

  }

  filter.filter.children.push({
    conjunction: "or",
    conditions
  })

}

/* ---------------- 枚举识别 ---------------- */

function detectEnum(question){

  const conditions=[]

  for(const key in ENUM_DICT){

    if(question.includes(key)){

      conditions.push({
        field_name: ENUM_DICT[key],
        operator:"contains",
        value:[key]
      })

    }

  }

  if(conditions.length===0)
    return []

  return [
    {
      conjunction:"or",
      conditions
    }
  ]

}
/* ---------------- 时间解析 ---------------- */

function parseTime(question) {

  return (
      parseYear(question) ||
      parseMonth(question) ||
      parseRecent(question) ||
      parseThisYear(question)
  )

}

function parseYear(question) {

  const m = question.match(/(20\d{2})年/)

  if (!m) return null

  const year = parseInt(m[1])

  const start = new Date(`${year}-01-01`).getTime()
  const end = new Date(`${year}-12-31 23:59:59`).getTime()

  return { start, end }
}

function parseMonth(question) {

  const m = question.match(/(20\d{2})年(\d{1,2})月/)

  if (!m) return null

  const year = parseInt(m[1])
  const month = parseInt(m[2])

  const start = new Date(year, month - 1, 1).getTime()
  const end = new Date(year, month, 0, 23, 59, 59).getTime()

  return { start, end }
}

function parseRecent(question) {

  const m = question.match(/最近(\d+)天/)

  if (!m) return null

  const days = parseInt(m[1])

  const end = Date.now()
  const start = end - days * 86400000

  return { start, end }
}

function parseThisYear(question) {

  if (!question.includes("今年"))
    return null

  const year = new Date().getFullYear()

  const start = new Date(`${year}-01-01`).getTime()
  const end = new Date(`${year}-12-31 23:59:59`).getTime()

  return { start, end }
}

/* ---------------- 添加时间 ---------------- */

function addTime(filter, range) {

  const field = FIELD_INDEX.date[0] || "执行日期"

  filter.filter.children.push({
    conjunction: "and",
    conditions: [
      {
        field_name: field,
        operator: "isGreater",
        value: ["ExactDate", String(range.start)]
      },
      {
        field_name: field,
        operator: "isLess",
        value: ["ExactDate", String(range.end)]
      }
    ]
  })

}

/* ---------------- LLM兜底 ---------------- */

async function llmParse(question) {

  const prompt = `
用户问题:
${question}

生成飞书bitable filter JSON
只返回 children 数组
`

  try {

    const res = await callLLM(prompt)

    const match = res.match(/\[[\s\S]*\]/)

    if (!match)
      return []

    return JSON.parse(match[0])

  } catch {

    return []

  }

}

/* ---------------- Filter去重 ---------------- */

function fixFilter(filter) {

  const seen = new Set()
  const result = []

  for (const c of filter.filter.children) {

    if (c.conditions) {

      const inner = []
      const innerSeen = new Set()

      for (const ic of c.conditions) {

        const key = ic.field_name + JSON.stringify(ic.value)

        if (innerSeen.has(key))
          continue

        innerSeen.add(key)

        inner.push(ic)

      }

      if (inner.length > 0) {

        result.push({
          conjunction: c.conjunction || "and",
          conditions: inner
        })

      }

      continue
    }

    const key = c.field_name + JSON.stringify(c.value)

    if (seen.has(key))
      continue

    seen.add(key)

    result.push(c)

  }

  filter.filter.children = result

  return filter
}

/* ---------------- 自动分页查询 ---------------- */

async function searchAll(appToken, tableId, filter) {

  let pageToken = null
  const res = await searchRecords(
      appToken,
      tableId,
      filter,
      pageToken,
      500
  )

  if (!res) {
    console.log("接口异常:", res)

  }
  return res

}

module.exports = { smartQuery }