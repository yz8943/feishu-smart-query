const { searchRecords, getFields } = require("./feishu-api")
const { callLLM } = require("./llm")

/* ================================================================
   用户配置区 — 维护人员别名与 openid 映射
   ================================================================ */

const KNOWN_USERS = [
  { name: "颜宇鹏",  alias: ["YYP", "yyp", "宇鹏"] },
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

const USER_OPENID = {
  "颜宇鹏": "ou_c5aaa8352b4879d307f2771686e80b47",
  "曾颖卓":  "ou_ae76bfcf2a489bd8f4755d27dcc286bb"
}

/* ================================================================
   字段缓存（进程级，避免重复请求）
   ================================================================ */

let FIELD_CACHE = null

let IDX = {
  text:          [],
  date:          [],
  user:          [],
  select:        [],
  number:        [],
  selectOptions: {},
  allFieldNames: []
}

/* ================================================================
   加载并索引字段
   ================================================================ */

async function loadFields(appToken, tableId) {

  if (FIELD_CACHE) return

  const raw = await getFields(appToken, tableId)

  let fields = []
  if (Array.isArray(raw))       fields = raw
  else if (raw?.items)          fields = raw.items
  else if (raw?.data?.items)    fields = raw.data.items

  FIELD_CACHE = fields

  IDX = { text: [], date: [], user: [], select: [], number: [], selectOptions: {}, allFieldNames: [] }

  for (const f of fields) {
    const name = f.field_name || f.name
    const type = f.type
    if (!name) continue

    IDX.allFieldNames.push(name)

    if (type === 1)  IDX.text.push(name)
    if (type === 2)  IDX.number.push(name)
    if (type === 5)  IDX.date.push(name)
    if (type === 11) IDX.user.push(name)

    if (type === 3 || type === 4) {
      IDX.select.push(name)
      const opts = f.property?.options || []
      IDX.selectOptions[name] = opts.map(o => o.name)
    }
  }

  console.log("字段索引:", JSON.stringify(IDX, null, 2))
}

/* ================================================================
   主入口
   ================================================================ */

async function smartQuery(appToken, tableId, question) {

  question = question.trim()
  console.log("\n========== smartQuery ==========")
  console.log("问题:", question)

  await loadFields(appToken, tableId)

  // ★ 纯项目名称搜索模式：无人名、无时间词、无出品性质关键词
  //   直接用项目名称做全文搜索，跳过LLM，避免把名称拆成多字段AND导致0结果
  if (isPureNameQuery(question)) {
    console.log('🔍 纯名称搜索模式，跳过LLM，直接用项目名称搜索')
    const filter = {
      conjunction: "and",
      children: [{
        conjunction: "and",
        conditions: [{ field_name: "项目名称", operator: "contains", value: [question] }]
      }]
    }
    console.log("\n最终 Filter:", JSON.stringify(filter, null, 2))
    const records = await searchRecords(appToken, tableId, filter)
    console.log("命中记录数:", records.length)
    return records
  }

  // 1. LLM 生成 filter children
  let children = await llmBuildChildren(question)

  // 2. 规则后处理：补充 LLM 漏掉的人员/枚举条件，修正文本条件里混入的噪音
  children = rulePostProcess(question, children)

  // 3. 时间规则补丁
  children = applyTimePatch(question, children)

  // 4. 格式校验与自动修正
  children = validateChildren(children)

  // 5. 组装并去重
  const filter = dedup({ filter: { conjunction: "and", children } })

  console.log("\n最终 Filter:", JSON.stringify(filter, null, 2))

  const records = await searchRecords(appToken, tableId, filter.filter)

  console.log("命中记录数:", records.length)

  return records
}

/* ================================================================
   判断是否为纯项目名称查询
   条件：无人名别名、无时间词、无出品性质词
   ================================================================ */

const NATURE_KEYWORDS = ['商配', '自制', '联制', '商单']

const TIME_PATTERNS = [
  /下下[周星期]/, /下[周星期]/, /本[周星期]/, /这[周星期]/,
  /上[周星期]/, /今[天日年]/, /去年/, /明[天日]/,
  /最近\d+天/, /最近一?[周个]?月/, /\d{4}年/
]

function isPureNameQuery(question) {
  // 含人名别名 → 不是纯名称查询
  const q = question.toLowerCase()
  for (const u of KNOWN_USERS) {
    const words = [u.name, ...(u.alias || [])]
    if (words.some(w => q.includes(w.toLowerCase()))) return false
  }
  // 含时间词 → 不是纯名称查询
  if (TIME_PATTERNS.some(p => p.test(question))) return false
  // 含出品性质词 → 不是纯名称查询
  if (NATURE_KEYWORDS.some(k => question.includes(k))) return false
  return true
}

/* ================================================================
   规则后处理
   — LLM 返回后，用规则补充漏掉的条件、修正混入文本值的噪音
   ================================================================ */

function rulePostProcess(question, children) {

  // ---- 1. 确保人员条件格式正确（叶子 is → 包进 conjunction:or） ----
  children = children.map(c => {
    if (
        c.field_name && IDX.user.includes(c.field_name) &&
        c.operator === "is" && Array.isArray(c.value)
    ) {
      console.log("修正人员条件格式: 叶子→嵌套")
      return { conjunction: "or", conditions: [{ field_name: c.field_name, operator: "is", value: c.value }] }
    }
    return c
  })

  // ---- 2. 从问题中识别人员，补充 LLM 漏掉的人员条件 ----
  const existingOpenids = new Set()
  for (const c of children) {
    const conds = c.conditions || (c.field_name ? [c] : [])
    for (const ic of conds) {
      if (IDX.user.includes(ic.field_name)) {
        ic.value.forEach(v => existingOpenids.add(v))
      }
    }
  }

  const q = question.toLowerCase()
  const missingPersonConditions = []
  for (const u of KNOWN_USERS) {
    const matched = [u.name, ...(u.alias || [])].some(w => q.includes(w.toLowerCase()))
    if (!matched) continue
    const oid = USER_OPENID[u.name]
    if (!oid || existingOpenids.has(oid)) continue
    const userField = IDX.user[0] || "主持人/作者"
    console.log(`规则补充人员条件: ${u.name} → ${oid}`)
    missingPersonConditions.push({
      conjunction: "or",
      conditions: [{ field_name: userField, operator: "is", value: [oid] }]
    })
    existingOpenids.add(oid)
  }
  if (missingPersonConditions.length) {
    children = [...children, ...missingPersonConditions]
  }

  // ---- 3. 从问题中识别枚举值，补充 LLM 漏掉的枚举条件 ----
  //   ★ 新增：如果某枚举词是更长枚举选项的子串且那个更长选项也出现在问题中，跳过
  const existingEnumKeys = new Set()
  for (const c of children) {
    if (c.field_name && IDX.select.includes(c.field_name)) {
      existingEnumKeys.add(c.field_name + ":" + (c.value || []).join(","))
    }
  }

  for (const fieldName of IDX.select) {
    for (const opt of (IDX.selectOptions[fieldName] || [])) {
      // 短选项（≤2字符）要求前后是分隔符或字符串边界，防止误匹配"S09"里的"S"
      const basicMatch = opt.length <= 2
          ? new RegExp(`(^|[-_\\s/])${escapeReg(opt)}($|[-_\\s/])`).test(question)
          : question.includes(opt)

      if (!basicMatch) continue

      // ★ 跳过：该枚举词是其他更长枚举选项的子串，且那个更长选项也出现在问题中
      if (isSubstringOfLongerMatch(opt, question, fieldName)) continue

      const key = fieldName + ":" + opt
      if (existingEnumKeys.has(key)) continue
      console.log(`规则补充枚举条件: ${fieldName} contains "${opt}"`)
      children.push({ conjunction: "and", conditions: [{ field_name: fieldName, operator: "contains", value: [opt] }] })
      existingEnumKeys.add(key)
    }
  }

  // ---- 4. 清洗文本条件的 value：剔除混入的人名别名和枚举词 ----
  const allAliases = []
  for (const u of KNOWN_USERS) {
    allAliases.push(u.name, ...(u.alias || []))
  }
  const allOpts = Object.values(IDX.selectOptions).flat().filter(o => o.length > 1)

  children = children.map(c => {
    if (!c.field_name || !IDX.text.includes(c.field_name)) return c
    if (!Array.isArray(c.value)) return c

    const cleaned = c.value.map(v => {
      let s = v
      const sortedAliases = [...allAliases].sort((a, b) => b.length - a.length)
      for (const alias of sortedAliases) {
        s = s.replace(
            new RegExp(`(^|[-_\\s])${escapeReg(alias)}($|[-_\\s])`, "gi"),
            (_, pre, suf) => (pre && suf) ? pre : ""
        )
      }
      for (const opt of allOpts) {
        s = s.replace(
            new RegExp(`(^|[-_\\s])${escapeReg(opt)}($|[-_\\s])`, "g"),
            (_, pre, suf) => (pre && suf) ? pre : ""
        )
      }
      return s.replace(/^[-_\s]+|[-_\s]+$/g, "").trim()
    }).filter(v => v.length > 0)

    if (cleaned.length === 0) {
      console.log(`文本条件清洗后为空，跳过: ${c.field_name}`)
      return null
    }
    if (cleaned.join() !== c.value.join()) {
      console.log(`文本条件清洗: "${c.value}" → "${cleaned}"`)
    }
    return { ...c, value: cleaned }
  }).filter(Boolean)

  return children
}

/* ================================================================
   判断某枚举词是否是同字段或其他字段中更长选项的子串，
   且那个更长选项也出现在问题中 → 避免"情怀车"被误识别成短枚举
   ================================================================ */

function isSubstringOfLongerMatch(opt, question, currentField) {
  for (const fieldName of IDX.select) {
    for (const other of (IDX.selectOptions[fieldName] || [])) {
      if (other === opt) continue
      if (other.includes(opt) && question.includes(other)) {
        console.log(`跳过枚举词 "${opt}"（是更长选项 "${other}" 的子串，且后者也出现在问题中）`)
        return true
      }
    }
  }
  return false
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/* ================================================================
   LLM 构建 filter children
   ================================================================ */

async function llmBuildChildren(question) {

  const prompt = buildPrompt(question)
  console.log("\n--- LLM Prompt ---\n", prompt)

  try {
    const raw = await callLLM(prompt)
    console.log("\n--- LLM 返回 ---\n", raw)

    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim()
    const m = cleaned.match(/\[[\s\S]*\]/)

    if (!m) {
      console.warn("LLM 未返回 JSON 数组，使用空 filter（返回全部记录）")
      return []
    }

    const parsed = JSON.parse(m[0])
    return Array.isArray(parsed) ? parsed : []

  } catch (e) {
    console.error("LLM 解析异常:", e.message)
    return []
  }
}

/* ================================================================
   构建 Prompt
   ================================================================ */

function buildPrompt(question) {

  const now      = new Date()
  const thisYear = now.getFullYear()
  const lastYear = thisYear - 1

  const userLines = KNOWN_USERS
      .filter(u => USER_OPENID[u.name])
      .map(u => `${[u.name, ...u.alias].join("/")}=${USER_OPENID[u.name]}`)
      .join(" ")

  const selectLines = IDX.select.map(f =>
      `${f}:[${(IDX.selectOptions[f] || []).join(",")}]`
  ).join("\n")

  const textLine = IDX.text.join(",")
  const userField = IDX.user[0] || "主持人/作者"
  const dateField = IDX.date[0] || "执行日期"

  const nowMs = Date.now()
  const lyStart  = new Date(`${lastYear}-01-01`).getTime()
  const lyEnd    = new Date(`${lastYear}-12-31T23:59:59`).getTime()
  const tyStart  = new Date(`${thisYear}-01-01`).getTime()
  const tyEnd    = new Date(`${thisYear}-12-31T23:59:59`).getTime()
  const weekStart = nowMs - 7 * 86400000
  const monthStart = nowMs - 30 * 86400000

  const allFieldList = IDX.allFieldNames.join("、")

  return `任务：将用户问题转为飞书bitable查询条件，输出JSON数组。

【可用字段名，field_name只能从这里选】
${allFieldList}

【文本字段，用contains】${textLine}
【日期字段，用isGreater/isLess】${dateField}
【人员字段，用is+openid】${userField}
【单/多选字段，用contains】
${selectLines}

【用户openid对照表】
${userLines}

【时间戳】去年${lastYear}:${lyStart}~${lyEnd} 今年${thisYear}:${tyStart}~${tyEnd} 最近一周:${weekStart}~${nowMs} 最近30天:${monthStart}~${nowMs}

【拆分规则——核心】
问题中混合了多种信息，必须各自拆成独立条件：
- 人名/别名 → 人员条件（用openid）
- 平台/性质/类型等枚举词 → 枚举条件（必须完整匹配选项列表中的词）
- 剩余车型/项目关键词 → 文本contains条件
例："深蓝S09-YYP抖音详情" 拆为4个独立条件：
  {"field_name":"项目名称","operator":"contains","value":["深蓝S09"]}
  {"conjunction":"or","conditions":[{"field_name":"主持人/作者","operator":"is","value":["ou_c5aaa8352b4879d307f2771686e80b47"]}]}
  {"field_name":"平台","operator":"contains","value":["抖音"]}
  {"field_name":"内容类型","operator":"contains","value":["详情"]}

【注意】
- field_name只能是上方字段列表中的真实字段名，禁止自造字段
- 文本字段禁止用is，只能用contains
- 枚举只匹配选项列表中完整存在的词，禁止拆字母（S09中的S不是选项）
- 如果问题是一个完整项目名称（含连字符、混合中英文数字），只生成一条项目名称contains条件，不要拆成多个字段
- 只输出JSON数组，不要任何解释

用户问题：${question}

输出：`
}

/* ================================================================
   时间规则补丁 — 移除 LLM 日期条件，替换为规则精确计算结果
   ================================================================ */

function applyTimePatch(question, children) {

  const range = parseTime(question)
  if (!range) return children

  const dateFields = new Set([...IDX.date, "执行日期"])

  const cleaned = children.filter(c => {
    if (c.conditions) {
      return !c.conditions.some(ic => dateFields.has(ic.field_name))
    }
    return !dateFields.has(c.field_name)
  })

  const field = IDX.date[0] || "执行日期"
  cleaned.push({
    conjunction: "and",
    conditions: [
      { field_name: field, operator: "isGreater", value: ["ExactDate", String(range.start)] },
      { field_name: field, operator: "isLess",    value: ["ExactDate", String(range.end)]   }
    ]
  })

  return cleaned
}

function parseTime(q) {
  return parseMonth(q) || parseYear(q) || parseRecent(q) || parseRecentWeek(q) || parseRecentMonth(q) || parseThisYear(q) || parseLastYear(q) || parseThisMonth(q) || parseLastMonth(q)
}

function parseYear(q) {
  const m = q.match(/(20\d{2})年/)
  if (!m) return null
  const y = +m[1]
  return { start: new Date(`${y}-01-01`).getTime(), end: new Date(`${y}-12-31T23:59:59`).getTime() }
}

function parseMonth(q) {
  const m = q.match(/(20\d{2})年(\d{1,2})月/)
  if (!m) return null
  const y = +m[1], mo = +m[2]
  return { start: new Date(y, mo-1, 1).getTime(), end: new Date(y, mo, 0, 23, 59, 59).getTime() }
}

function parseRecent(q) {
  const m = q.match(/最近(\d+)天/)
  if (!m) return null
  const end = Date.now()
  return { start: end - +m[1] * 86400000, end }
}

function parseRecentWeek(q) {
  if (!q.match(/最近一?周|最近7天|这周|本周/)) return null
  const end = Date.now()
  return { start: end - 7 * 86400000, end }
}

function parseRecentMonth(q) {
  if (!q.match(/最近一?个?月|最近30天/)) return null
  const end = Date.now()
  return { start: end - 30 * 86400000, end }
}

function parseThisYear(q) {
  if (!q.includes("今年")) return null
  const y = new Date().getFullYear()
  return { start: new Date(`${y}-01-01`).getTime(), end: new Date(`${y}-12-31T23:59:59`).getTime() }
}

function parseLastYear(q) {
  if (!q.includes("去年")) return null
  const y = new Date().getFullYear() - 1
  return { start: new Date(`${y}-01-01`).getTime(), end: new Date(`${y}-12-31T23:59:59`).getTime() }
}

function parseThisMonth(q) {
  if (!q.includes("本月") && !q.includes("这个月") && !q.includes("当月")) return null
  const now = new Date()
  return { start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), end: new Date(now.getFullYear(), now.getMonth()+1, 0, 23, 59, 59).getTime() }
}

function parseLastMonth(q) {
  if (!q.includes("上个月") && !q.includes("上月")) return null
  const now = new Date()
  return { start: new Date(now.getFullYear(), now.getMonth()-1, 1).getTime(), end: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).getTime() }
}

/* ================================================================
   校验 children — 过滤掉 LLM 生成的非法条件
   ================================================================ */

function validateChildren(children) {

  if (!Array.isArray(children)) return []

  const allFields  = new Set(IDX.allFieldNames)
  const textFields = new Set(IDX.text)

  const fixLeaf = (ic) => {
    if (ic.operator === "is" && textFields.has(ic.field_name)) {
      console.warn(`自动修正: ${ic.field_name} is → contains`)
      return { ...ic, operator: "contains" }
    }
    if (IDX.select.includes(ic.field_name) && Array.isArray(ic.value)) {
      const validOpts = IDX.selectOptions[ic.field_name] || []
      if (validOpts.length > 0) {
        const filteredValues = ic.value.filter(v => validOpts.includes(v))
        if (filteredValues.length === 0) {
          console.warn(`枚举条件值不合法，跳过: ${ic.field_name} = ${JSON.stringify(ic.value)}`)
          return null
        }
        if (filteredValues.length !== ic.value.length) {
          console.warn(`枚举条件部分值不合法，已过滤: ${ic.field_name} ${JSON.stringify(ic.value)} → ${JSON.stringify(filteredValues)}`)
          return { ...ic, value: filteredValues }
        }
      }
    }
    return ic
  }

  const result = []

  for (const c of children) {

    if (c.conjunction && Array.isArray(c.conditions)) {
      const validInner = c.conditions
          .filter(ic =>
              ic.field_name && typeof ic.field_name === "string" &&
              ic.operator   && typeof ic.operator === "string" &&
              Array.isArray(ic.value) &&
              (allFields.size === 0 || allFields.has(ic.field_name))
          )
          .map(fixLeaf)
          .filter(Boolean)
      if (validInner.length) {
        result.push({ conjunction: c.conjunction, conditions: validInner })
      } else {
        console.warn("跳过非法嵌套条件:", JSON.stringify(c))
      }
      continue
    }

    if (
        c.field_name && typeof c.field_name === "string" &&
        c.operator   && typeof c.operator === "string" &&
        Array.isArray(c.value) &&
        (allFields.size === 0 || allFields.has(c.field_name))
    ) {
      const fixed = fixLeaf(c)
      if (fixed) result.push({ conjunction: "and", conditions: [fixed] })
      else console.warn("跳过非法枚举条件:", JSON.stringify(c))
      continue
    }

    console.warn("跳过非法条件:", JSON.stringify(c))
  }

  console.log(`validateChildren: ${children.length} 个条件 → 有效 ${result.length} 个`)
  return result
}

/* ================================================================
   去重
   ================================================================ */

function dedup(filterObj) {

  const seen = new Set()
  const result = []

  for (const c of filterObj.filter.children) {
    if (c.conditions) {
      const innerSeen = new Set()
      const inner = c.conditions.filter(ic => {
        const k = ic.field_name + JSON.stringify(ic.value)
        if (innerSeen.has(k)) return false
        innerSeen.add(k); return true
      })
      if (inner.length) result.push({ ...c, conditions: inner })
      continue
    }
    const k = c.field_name + JSON.stringify(c.value)
    if (!seen.has(k)) { seen.add(k); result.push(c) }
  }

  filterObj.filter.children = result
  return filterObj
}

module.exports = { smartQuery }
