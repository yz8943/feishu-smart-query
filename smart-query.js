const { searchRecords, getFields } = require("./feishu-api")
const { callLLM } = require("./llm")

/* ---------------- 用户配置 ---------------- */

const KNOWN_USERS = [
  { name: "颜宇鹏", alias: ["YYP", "yyp", "宇鹏"] },
  { name: "袁启聪", alias: ["聪", "启聪"] },
  { name: "陈志豪", alias: ["志豪"] },
  { name: "李立山", alias: ["立山", "山"] },
  { name: "曾颖卓", alias: ["颖卓", "卓"] },
  { name: "陈皓沛", alias: ["皓沛", "Alex"] },
  { name: "郭健能", alias: ["健能"] },
  { name: "王雨霜", alias: ["雨霜"] },
  { name: "黄丽莹", alias: ["丽莹"] },
  { name: "柳笛", alias: ["笛"] },
  { name: "卢嘉杰", alias: ["嘉杰"] },
  { name: "曾智聪", alias: ["智聪"] },
  { name: "赵剑波", alias: ["剑波"] },
  { name: "黎碧怡", alias: ["碧怡", "花花"] }
]

/* ---------------- openid映射（你自己填） ---------------- */

const USER_OPENID = {
  "颜宇鹏": "ou_c5aaa8352b4879d307f2771686e80b47",
  "曾颖卓": "ou_ae76bfcf2a489bd8f4755d27dcc286bb"
}

/* ---------------- 字段缓存 ---------------- */

let FIELD_CACHE = null

let FIELD_INDEX = {
  text: [],
  date: [],
  user: [],
  select: [],
  selectOptions: {},
  optionMap: {}
}

/* ---------------- 加载字段 ---------------- */

async function loadFields(appToken, tableId) {

  if (FIELD_CACHE) return FIELD_CACHE

  const res = await getFields(appToken, tableId)

  console.log("fields raw:", JSON.stringify(res, null, 2))

  let fields = []

  if (res?.data?.items) fields = res.data.items
  else if (res?.items) fields = res.items
  else if (Array.isArray(res)) fields = res

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
    select: [],
    selectOptions: {},
    optionMap: {}
  }

  for (const f of fields) {

    const name = f.field_name || f.name
    const type = f.type

    if (!name) continue

    if (type === 1) FIELD_INDEX.text.push(name)

    if (type === 5) FIELD_INDEX.date.push(name)

    if (type === 11) FIELD_INDEX.user.push(name)

    if (type === 3 || type === 4) {

      FIELD_INDEX.select.push(name)

      const opts = f.property?.options || []

      FIELD_INDEX.selectOptions[name] = opts.map(o => o.name)

      for (const o of opts) {

        FIELD_INDEX.optionMap[o.name] = name
      }
    }
  }
}

/* ---------------- 创建filter ---------------- */

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

  question = question.trim()

  console.log("问题:", question)

  await loadFields(appToken, tableId)

  let filter = await buildFilter(question)

  filter = fixFilter(filter)

  console.log("最终Filter:", JSON.stringify(filter, null, 2))

  const records = await searchRecords(appToken, tableId, filter.filter)

  console.log("查询结果:", records.length)

  return records
}

/* ---------------- 构建filter ---------------- */

async function buildFilter(question) {

  const filter = createFilter()

  const persons = detectPerson(question)
  const time = parseTime(question)
  const enums = detectEnum(question)

  if (persons) addPerson(filter, persons)

  if (time) addTime(filter, time)

  if (enums.length) filter.filter.children.push(...enums)

  if (filter.filter.children.length > 0) return filter

  const llm = await llmParse(question)

  filter.filter.children.push(...llm)

  return filter
}

/* ---------------- 人员识别（新增） ---------------- */

function detectPerson(question) {

  const q = question.toLowerCase()

  const ids = []

  for (const u of KNOWN_USERS) {

    const words = [u.name, ...(u.alias || [])]

    for (const w of words) {

      if (q.includes(w.toLowerCase())) {

        const id = USER_OPENID[u.name]

        if (id) ids.push(id)

        break
      }
    }
  }

  return ids.length ? ids : null
}

/* ---------------- 添加人员 ---------------- */

function addPerson(filter, ids) {

  const conditions = []

  for (const id of ids) {

    conditions.push({
      field_name: "主持人/作者",
      operator: "is",
      value: [id]
    })
  }

  filter.filter.children.push({
    conjunction: "or",
    conditions
  })
}

/* ---------------- 枚举识别 ---------------- */

function detectEnum(question) {

  const conditions = []

  for (const opt in FIELD_INDEX.optionMap) {

    if (question.includes(opt)) {

      const field = FIELD_INDEX.optionMap[opt]

      conditions.push({
        field_name: field,
        operator: "contains",
        value: [opt]
      })
    }
  }

  if (!conditions.length) return []

  return [{
    conjunction: "or",
    conditions
  }]
}

/* ---------------- 时间解析 ---------------- */

function parseTime(question) {

  return parseYear(question)
      || parseMonth(question)
      || parseRecent(question)
      || parseThisYear(question)
      || parseLastYear(question)
}

/* 年 */

function parseYear(question) {

  const m = question.match(/(20\d{2})年/)

  if (!m) return null

  const year = parseInt(m[1])

  return {
    start: new Date(`${year}-01-01`).getTime(),
    end: new Date(`${year}-12-31 23:59:59`).getTime()
  }
}

/* 月 */

function parseMonth(question) {

  const m = question.match(/(20\d{2})年(\d{1,2})月/)

  if (!m) return null

  const year = parseInt(m[1])
  const month = parseInt(m[2])

  return {
    start: new Date(year, month - 1, 1).getTime(),
    end: new Date(year, month, 0, 23, 59, 59).getTime()
  }
}

/* 最近 */

function parseRecent(question) {

  const m = question.match(/最近(\d+)天/)

  if (!m) return null

  const days = parseInt(m[1])

  const end = Date.now()

  return {
    start: end - days * 86400000,
    end
  }
}

/* 今年 */

function parseThisYear(question) {

  if (!question.includes("今年")) return null

  const year = new Date().getFullYear()

  return {
    start: new Date(`${year}-01-01`).getTime(),
    end: new Date(`${year}-12-31 23:59:59`).getTime()
  }
}

/* 去年 */

function parseLastYear(question) {

  if (!question.includes("去年")) return null

  const year = new Date().getFullYear() - 1

  return {
    start: new Date(`${year}-01-01`).getTime(),
    end: new Date(`${year}-12-31 23:59:59`).getTime()
  }
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
只返回children数组
`

  try {

    const res = await callLLM(prompt)

    const match = res.match(/\[[\s\S]*\]/)

    if (!match) return []

    return JSON.parse(match[0])

  } catch {

    return []
  }
}

/* ---------------- filter去重 ---------------- */

function fixFilter(filter) {

  const seen = new Set()

  const result = []

  for (const c of filter.filter.children) {

    if (c.conditions) {

      const inner = []

      const innerSeen = new Set()

      for (const ic of c.conditions) {

        const key = ic.field_name + JSON.stringify(ic.value)

        if (!innerSeen.has(key)) {

          innerSeen.add(key)

          inner.push(ic)
        }
      }

      if (inner.length) {

        result.push({
          conjunction: c.conjunction || "and",
          conditions: inner
        })
      }

      continue
    }

    const key = c.field_name + JSON.stringify(c.value)

    if (seen.has(key)) continue

    seen.add(key)

    result.push(c)
  }

  filter.filter.children = result

  return filter
}

module.exports = {
  smartQuery
}