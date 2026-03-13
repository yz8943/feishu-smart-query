// local-query.js - 基于本地 JSON 缓存 + LLM 解析的智能查询
require('dotenv').config({ path: __dirname + '/.env' })

const { loadCache, loadMeta, syncTable, isCacheStale } = require('./sync')
const { callLLM } = require('./llm')

/* -------- 用户配置（名字 → openid 映射，用于人员字段匹配） -------- */

const KNOWN_USERS = [
  { name: "颜宇鹏",  alias: ["YYP", "yyp", "yyy", "YYY", "宇鹏"] },
  { name: "袁启聪",  alias: ["聪", "启聪"] },
  { name: "陈志豪",  alias: ["志豪"] },
  { name: "李立山",  alias: ["立山", "山"] },
  { name: "曾颖卓",  alias: ["颖卓", "卓"] },
  { name: "陈皓沛",  alias: ["皓沛", "Alex"] },
  { name: "郭健能",  alias: ["健能"] },
  { name: "王雨霜",  alias: ["雨霜"] },
  { name: "黄丽莹",  alias: ["丽莹"] },
  { name: "柳笛",    alias: ["笛"] },
  { name: "卢嘉杰",  alias: ["嘉杰"] },
  { name: "曾智聪",  alias: ["智聪"] },
  { name: "赵剑波",  alias: ["剑波"] },
  { name: "黎碧怡",  alias: ["碧怡", "花花"] }
]

/* -------- 主查询入口 -------- */

async function localQuery(appToken, tableId, question) {
  question = question.trim()
  console.log('\n📝 问题:', question)

  // 自动检测缓存是否过期，过期则先同步
  if (isCacheStale(appToken, tableId)) {
    console.log('⚠️  缓存过期，触发同步...')
    await syncTable(appToken, tableId)
  }

  const cache = loadCache(appToken, tableId)
  const meta  = loadMeta(appToken, tableId)

  if (!cache || !cache.records?.length) {
    throw new Error('本地缓存为空，请先执行 sync 命令')
  }

  console.log(`📦 本地缓存: ${cache.total} 条记录，同步时间: ${cache.syncedAt}`)

  // LLM 解析问题，返回 JS 过滤条件描述
  const conditions = await parseConditions(question, meta)
  console.log('🤖 LLM解析条件:', JSON.stringify(conditions, null, 2))

  // 本地过滤（逐条件打印命中数）
  if (conditions.length > 0) {
    for (const cond of conditions) {
      const hitCount = cache.records.filter(r => matchOne(r, cond)).length
      const label = cond.op === 'or' ? 'OR组合' : `${cond.field}[${cond.op}=${JSON.stringify(cond.value || cond.start)}]`
      console.log(`   📌 ${label}: 单独命中 ${hitCount} 条`)
    }
    // 打印各条件单独命中的记录交叉情况
    const perCondHits = conditions.map(cond => new Set(
        cache.records.map((r,i) => matchOne(r, cond) ? i : -1).filter(i => i >= 0)
    ))
    if (perCondHits.length >= 2) {
      const intersection = [...perCondHits[0]].filter(i => perCondHits.every(s => s.has(i)))
      console.log(`   🔀 条件交集: ${intersection.length} 条`)
      // 打印日期命中记录的主持人，看看是不是字段名对不上
      const dateCond = conditions.find(c => c.op === 'dateRange')
      if (dateCond) {
        const dateHits = cache.records.filter(r => matchOne(r, dateCond))
        console.log('   📅 执行日期命中记录的主持人/作者:',
            JSON.stringify(dateHits.map(r => (r['主持人/作者'] || []).map(p => p.name))))
      }
    }
  }
  const results = filterRecords(cache.records, conditions, question)
  console.log(`✅ 最终命中 ${results.length} 条`)

  return results
}

/* -------- LLM 解析问题为结构化条件 -------- */

async function parseConditions(question, meta) {
  const fieldDesc = buildFieldDesc(meta)

  // ① JS侧预解析人名别名，避免LLM把人名误解为栏目/关键词
  const personHints = resolvePersonHints(question)

  // ② JS侧预解析相对时间，避免LLM算错或忽略
  const dateHints = resolveDateHints(question)

  const personSection = personHints.length
      ? `## 人名预解析（已识别，直接使用，不要自行推断）\n` +
      personHints.map(p => `- "${p.raw}" 对应的人员姓名是 "${p.name}"`).join('\n')
      : ''

  const dateSection = dateHints
      ? `## 时间预解析（已计算好，直接使用）\n- "${dateHints.raw}" 对应的日期范围是 ${dateHints.start} ~ ${dateHints.end}`
      : `## 今天日期\n${new Date().toISOString().slice(0, 10)}`

  const prompt = `你是飞书多维表格的查询助手。根据用户问题，提取筛选条件，返回 JSON 数组。

## 表格字段结构
${fieldDesc}

${dateSection}

${personSection}

## 用户问题
${question}

## 输出规则
返回一个 JSON 数组，每个元素是一个筛选条件对象，支持以下格式：

文本/单选/多选字段包含某值:
{"field": "字段名", "op": "contains", "value": "关键词"}

人员字段（按姓名匹配，value填真实姓名）:
{"field": "字段名", "op": "person", "value": "姓名"}

日期字段范围（start/end 格式 yyyy-mm-dd）:
{"field": "字段名", "op": "dateRange", "start": "...", "end": "..."}

数字字段:
{"field": "字段名", "op": "gt|lt|eq|gte|lte", "value": 数字}

多条件 OR 组合:
{"op": "or", "conditions": [...子条件数组...]}

## 严格规则
- 只返回 JSON 数组，不要任何解释和 Markdown 代码块
- 字段名必须从上面字段结构中选取，不可自造
- 人名/时间已在上方预解析，直接使用预解析结果，不要再自行推断
- 问题中出现的人名/别名只能映射到人员字段，绝对不能映射到文本/单选等其他字段
- 如果问题没有明确筛选条件，返回 []

示例:
[{"field": "出品性质", "op": "contains", "value": "商配"}, {"field": "执行日期", "op": "dateRange", "start": "2024-01-01", "end": "2024-12-31"}]`

  try {
    const res = await callLLM(prompt)
    const match = res.match(/\[[\s\S]*\]/)
    if (!match) return []
    return JSON.parse(match[0])
  } catch (err) {
    console.warn('⚠️  LLM解析失败，返回空条件:', err.message)
    return []
  }
}

/* -------- 预解析：人名别名 → [{raw, name}] -------- */

function resolvePersonHints(question) {
  const q = question.toLowerCase()
  const hits = []
  for (const u of KNOWN_USERS) {
    const words = [u.name, ...(u.alias || [])]
    for (const w of words) {
      if (q.includes(w.toLowerCase())) {
        hits.push({ raw: w, name: u.name })
        break
      }
    }
  }
  return hits
}

/* -------- 预解析：相对时间 → { raw, start, end } -------- */

function resolveDateHints(question) {
  const now = new Date()
  const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay() // 1=周一 7=周日
  const monday = new Date(now)
  monday.setDate(now.getDate() - dayOfWeek + 1)
  monday.setHours(0, 0, 0, 0)
  const fmt = d => d.toISOString().slice(0, 10)

  if (question.includes('下下周') || question.includes('下下星期')) {
    const start = new Date(monday); start.setDate(monday.getDate() + 14)
    const end   = new Date(start);  end.setDate(start.getDate() + 6)
    return { raw: '下下周', start: fmt(start), end: fmt(end) }
  }
  if (question.includes('下周') || question.includes('下星期')) {
    const start = new Date(monday); start.setDate(monday.getDate() + 7)
    const end   = new Date(start);  end.setDate(start.getDate() + 6)
    return { raw: '下周', start: fmt(start), end: fmt(end) }
  }
  if (question.includes('本周') || question.includes('这周') || question.includes('本星期')) {
    const end = new Date(monday); end.setDate(monday.getDate() + 6)
    return { raw: '本周', start: fmt(monday), end: fmt(end) }
  }
  // "今天/明天" 只在明确说"今天执行/今天录制/今天上线"等时才加日期条件
  // 单独出现的"今天"通常是口语，不加日期限制
  if ((question.includes('今天') || question.includes('今日')) &&
      (question.includes('执行') || question.includes('录制') || question.includes('上线') || question.includes('交片'))) {
    const today = fmt(now)
    return { raw: '今天', start: today, end: today }
  }
  if ((question.includes('明天') || question.includes('明日')) &&
      (question.includes('执行') || question.includes('录制') || question.includes('上线') || question.includes('交片'))) {
    const tom = new Date(now); tom.setDate(now.getDate() + 1)
    const d = fmt(tom); return { raw: '明天', start: d, end: d }
  }
  const recentMatch = question.match(/最近(\d+)天/)
  if (recentMatch) {
    const days = parseInt(recentMatch[1])
    const start = new Date(now); start.setDate(now.getDate() - days)
    return { raw: `最近${days}天`, start: fmt(start), end: fmt(now) }
  }
  if (question.includes('上周') || question.includes('上星期')) {
    const start = new Date(monday); start.setDate(monday.getDate() - 7)
    const end   = new Date(monday); end.setDate(monday.getDate() - 1)
    return { raw: '上周', start: fmt(start), end: fmt(end) }
  }
  if (question.includes('今年')) {
    const y = now.getFullYear()
    return { raw: '今年', start: `${y}-01-01`, end: `${y}-12-31` }
  }
  if (question.includes('去年')) {
    const y = now.getFullYear() - 1
    return { raw: '去年', start: `${y}-01-01`, end: `${y}-12-31` }
  }
  const monthMatch = question.match(/(20\d{2})年(\d{1,2})月/)
  if (monthMatch) {
    const y = parseInt(monthMatch[1]), m = parseInt(monthMatch[2])
    const end = new Date(y, m, 0)
    return { raw: `${y}年${m}月`, start: `${y}-${String(m).padStart(2,'0')}-01`, end: fmt(end) }
  }
  const yearMatch = question.match(/(20\d{2})年?/)
  if (yearMatch) {
    const y = yearMatch[1]
    return { raw: `${y}年`, start: `${y}-01-01`, end: `${y}-12-31` }
  }
  return null
}

/* -------- 构建字段说明给 LLM -------- */

function buildFieldDesc(meta) {
  if (!meta?.fields) return '（无字段信息）'

  return meta.fields.map(f => {
    let line = `- ${f.name}（${f.typeLabel}）`
    if (f.options?.length) {
      line += `，选项: [${f.options.join(', ')}]`
    } else if (f.sampleValues?.length) {
      line += `，示例值: [${f.sampleValues.slice(0, 10).join(', ')}]`
    }
    return line
  }).join('\n')
}

/* -------- 本地记录过滤 -------- */

function filterRecords(records, conditions, originalQuestion) {
  if (!conditions || conditions.length === 0) {
    // 没有解析出条件时，做全文搜索兜底
    return fullTextSearch(records, originalQuestion)
  }

  return records.filter(rec => matchAll(rec, conditions))
}

/* -------- 匹配所有条件（AND） -------- */

function matchAll(rec, conditions) {
  return conditions.every(cond => matchOne(rec, cond))
}

/* -------- 匹配单个条件 -------- */

function matchOne(rec, cond) {
  // OR 组合条件
  if (cond.op === 'or') {
    return cond.conditions?.some(c => matchOne(rec, c)) ?? true
  }

  const val = rec[cond.field]

  // 字段不存在：日期/人员条件跳过（该记录无此字段，不强制不匹配）
  // contains/eq等精确条件才视为不匹配
  if (cond.field && !(cond.field in rec)) {
    if (cond.op === 'dateRange' || cond.op === 'person') return false
    if (cond.op === 'contains') return false
    return false
  }

  switch (cond.op) {

    case 'contains': {
      const keyword = String(cond.value).toLowerCase()
      return fieldContains(val, keyword)
    }

    case 'person': {
      // 人员字段：飞书返回 [{name, id, ...}]
      const targetName = resolvePersonName(cond.value)
      return fieldPersonMatch(val, targetName)
    }

    case 'dateRange': {
      let ts = extractTimestamp(val)
      if (ts === null || ts === undefined) return false
      // 飞书日期字段有时是秒级时间戳（10位），统一转为毫秒
      if (ts < 9999999999) ts = ts * 1000
      // 用本地时间解析日期避免UTC时区偏差
      const start = cond.start ? parseLocalDate(cond.start, false) : 0
      const end   = cond.end   ? parseLocalDate(cond.end,   true)  : Infinity
      return ts >= start && ts <= end
    }

    case 'eq':  return extractNumber(val) === cond.value
    case 'gt':  return extractNumber(val) >   cond.value
    case 'gte': return extractNumber(val) >=  cond.value
    case 'lt':  return extractNumber(val) <   cond.value
    case 'lte': return extractNumber(val) <=  cond.value

    default:
      return true
  }
}

/* -------- 字段包含关键词（兼容各种字段类型） -------- */

function fieldContains(val, keyword) {
  if (val === null || val === undefined) return false

  // 字符串
  if (typeof val === 'string') {
    return val.toLowerCase().includes(keyword)
  }

  // 数字
  if (typeof val === 'number') {
    return String(val).includes(keyword)
  }

  // 飞书文本对象 { text: "..." }
  if (typeof val === 'object' && val !== null) {

    // 单选 { text: "商配" }
    if (val.text) return val.text.toLowerCase().includes(keyword)

    // 多选 [{ text: "A" }, { text: "B" }]
    if (Array.isArray(val)) {
      return val.some(item => {
        if (typeof item === 'string') return item.toLowerCase().includes(keyword)
        if (item?.text)  return item.text.toLowerCase().includes(keyword)
        if (item?.name)  return item.name.toLowerCase().includes(keyword)
        if (item?.value) return String(item.value).toLowerCase().includes(keyword)
        return false
      })
    }

    // 超链接 { link: "...", text: "..." }
    if (val.link) return val.link.toLowerCase().includes(keyword)
  }

  return false
}

/* -------- 人员字段匹配 -------- */

function fieldPersonMatch(val, targetName) {
  if (!val) return false

  const names = extractPersonNames(val)
  return names.some(n => n.toLowerCase().includes(targetName.toLowerCase()))
}

/* -------- 提取人员名字列表 -------- */

function extractPersonNames(val) {
  if (Array.isArray(val)) {
    return val.map(v => v?.name || '').filter(Boolean)
  }
  if (val?.name) return [val.name]
  return []
}

/* -------- 解析人名别名 -------- */

function resolvePersonName(input) {
  const q = input.toLowerCase()
  for (const u of KNOWN_USERS) {
    const words = [u.name, ...(u.alias || [])]
    if (words.some(w => q.includes(w.toLowerCase()))) {
      return u.name
    }
  }
  return input  // 原样返回
}

/* -------- 解析本地日期字符串为时间戳（避免UTC偏差） -------- */

function parseLocalDate(dateStr, endOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (endOfDay) return new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

/* -------- 提取时间戳 -------- */

function extractTimestamp(val) {
  if (!val) return null

  // 飞书日期字段直接是毫秒时间戳数字
  if (typeof val === 'number') return val

  // 某些情况可能是字符串时间戳
  if (typeof val === 'string') {
    const n = Number(val)
    if (!isNaN(n)) return n
    const d = new Date(val)
    if (!isNaN(d.getTime())) return d.getTime()
  }

  return null
}

/* -------- 提取数字 -------- */

function extractNumber(val) {
  if (typeof val === 'number') return val
  if (typeof val === 'string') return parseFloat(val)
  return NaN
}

/* -------- 全文搜索兜底 -------- */

function fullTextSearch(records, question) {
  const keywords = question.split(/\s+/).filter(k => k.length > 0)
  if (!keywords.length) return records

  return records.filter(rec => {
    const text = JSON.stringify(rec).toLowerCase()
    return keywords.every(k => text.includes(k.toLowerCase()))
  })
}

module.exports = { localQuery }