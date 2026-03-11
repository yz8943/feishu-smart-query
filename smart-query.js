// smartQuery.js
const { getFields, searchRecords } = require("./feishu-api");
const { callLLM } = require("./llm");

// 人员名称到ID的映射
const PERSON_ID_MAP = {
  "颜宇鹏": "ou_c5aaa8352b4879d307f2771686e80b47",
  "yyp": "ou_c5aaa8352b4879d307f2771686e80b47",
  "YYP": "ou_c5aaa8352b4879d307f2771686e80b47",
  "曾颖卓": "ou_ae76bfcf2a489bd8f4755d27dcc286bb",
  "李立山": "ou_212ce4c494e44244292abade866c560d",
  "袁启聪": "ou_680416c4db666cf930fe5fafa00d67cf",
};

/**
 * 提取JSON
 */
function parseLLMJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("LLM JSON解析失败:\n" + text);
    return JSON.parse(match[0]);
  }
}

/**
 * 时间语义解析
 */
function parseDateWords(question) {
  const now = new Date();
  if (question.includes("今年")) {
    const start = new Date(now.getFullYear(), 0, 1).getTime();
    const end = new Date(now.getFullYear() + 1, 0, 1).getTime();
    return { start, end };
  }
  if (question.includes("最近30天")) {
    const end = Date.now();
    const start = end - 30 * 24 * 3600 * 1000;
    return { start, end };
  }
  return null;
}

/**
 * 修复日期filter，只处理非 ExactDate 条件
 */
function fixDateFilter(filter) {
  if (!filter?.filter?.conditions) return filter;
  for (const c of filter.filter.conditions) {
    if (!Array.isArray(c.value)) continue;
    if (c.value[0] === "ExactDate") continue;
    let v = c.value[0];
    const ts = toExactDate(v);
    if (ts && (c.field_name.includes("日期") || c.field_name.includes("时间"))) {
      c.value = ["ExactDate", String(ts)];
      if (c.operator === "isGreaterEqual") c.operator = "isGreater";
      if (c.operator === "isLessEqual") c.operator = "isLess";
    }
  }
  return filter;
}

/**
 * 修复字段名称，防止LLM生成错误字段
 */
function fixFieldName(filter, fields) {
  const names = fields.map(f => f.name);
  for (const c of filter.filter.conditions) {
    if (!names.includes(c.field_name)) {
      const found = names.find(n => n.includes(c.field_name) || c.field_name.includes(n));
      if (found) c.field_name = found;
    }
  }
  return filter;
}

/**
 * 过滤重要字段
 */
function pickImportantFields(fields) {
  const keywords = ["日期", "时间", "作者", "主持", "性质", "类型"];
  return fields.filter(f => keywords.some(k => f.name.includes(k)));
}

function ensureFilter(filter) {
  if (!filter.filter) filter.filter = {};
  if (!filter.filter.conditions) filter.filter.conditions = [];
  if (!filter.filter.conjunction) filter.filter.conjunction = "and";
  return filter;
}

/**
 * 安全添加条件
 */
function addCondition(filter, condition) {
  if (!filter.filter) filter.filter = {};
  if (!filter.filter.conditions) filter.filter.conditions = [];
  if (!filter.filter.conjunction) filter.filter.conjunction = "and";
  filter.filter.conditions.push(condition);
}

/**
 * 修复操作符和人员字段
 */
function fixOperator(filter) {
  const allowed = ["is","isNot","contains","doesNotContain","isEmpty","isNotEmpty",
    "isGreater","isGreaterEqual","isLess","isLessEqual","like","in"];
  for (const c of filter.filter.conditions) {
    if (!allowed.includes(c.operator)) {
      if (c.operator === "stringContains" || c.operator === "contains") c.operator = "contains";
      else if (c.operator === "isWithin") c.operator = "in";
      else c.operator = "is";
    }
    if (c.value && !Array.isArray(c.value)) c.value = [c.value];

    // 修复人员字段
    if (c.field_name && ["主持", "作者", "负责人", "人员", "制片"].some(k => c.field_name.includes(k))) {
      if (Array.isArray(c.value)) {
        c.value = c.value.map(v => {
          if (typeof v === "string" && v.startsWith("ou_")) return v;
          return PERSON_ID_MAP[v] || v;
        });
      }
    }
  }
  return filter;
}

function toExactDate(value) {
  let ts = 0;
  if (typeof value === "number") {
    ts = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === "string") {
    ts = new Date(value).getTime();
  }
  return ts;
}

function buildPrompt(question, fields) {
  const fieldList = fields.map(f => `- ${f.name} (${f.type})`).join("\n");
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
5 operator 必须是以下之一: is, isNot, contains, doesNotContain, isEmpty, isNotEmpty, isGreater, isGreaterEqual, isLess, isLessEqual, like, in
6 对于文本包含查询，使用 "contains"

格式：
{
 "filter":{
  "conjunction":"and",
  "conditions":[]
 }
}
`;
}

async function smartQuery(appToken, tableId, question) {
  console.log("读取字段结构...");
  let fields = await getFields(appToken, tableId);
  console.log("字段数量:", fields.length);

  fields = pickImportantFields(fields);
  console.log("关键字段:", fields.map(f => f.name).join(","));

  const prompt = buildPrompt(question, fields);
  console.log("prompt:", prompt);

  console.log("LLM解析问题...");
  const llmResult = await callLLM(prompt);

  let filter;
  try {
    filter = parseLLMJson(llmResult);
    console.log("LLM filter1:", filter);

    filter = ensureFilter(filter);
    console.log("LLM filter2:", filter);

    // **清理原有执行日期条件**
    filter.filter.conditions = filter.filter.conditions.filter(c => c.field_name !== "执行日期");

    filter = fixFieldName(filter, fields);

    // 自动时间识别
    const date = parseDateWords(question);
    if (date) {
      const start = toExactDate(date.start);
      const end = toExactDate(date.end);
      addCondition(filter, { field_name:"执行日期", operator:"isGreater", value:["ExactDate", String(start)] });
      addCondition(filter, { field_name:"执行日期", operator:"isLess", value:["ExactDate", String(end)] });
    }

    filter = fixOperator(filter);

    console.log("LLM filter3:", filter);
  } catch (e) {
    console.error("LLM JSON解析失败:", llmResult);
  }

  console.log("最终Filter:", JSON.stringify(filter, null, 2));
  const records = await searchRecords(appToken, tableId, filter.filter);

  console.log("查询记录:", records.length);
  return records;
}

module.exports = { smartQuery };