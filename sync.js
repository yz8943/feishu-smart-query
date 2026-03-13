// sync.js - 飞书多维表格全量数据同步到本地 JSON 缓存
require('dotenv').config({ path: __dirname + '/.env' })

const fs = require('fs')
const path = require('path')
const axios = require('axios')

/* -------- 配置 -------- */

const CACHE_DIR = path.join(__dirname, 'cache')
const SYNC_INTERVAL_MS = 300 * 60 * 1000  // 5个小时自动同步一次（可按需调整）

/* -------- 工具函数 -------- */

function cacheFile(appToken, tableId) {
  return path.join(CACHE_DIR, `${appToken}_${tableId}.json`)
}

function metaFile(appToken, tableId) {
  return path.join(CACHE_DIR, `${appToken}_${tableId}.meta.json`)
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  }
}

/* -------- 飞书 Token -------- */

async function getTenantToken() {
  const res = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/',
    {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET
    },
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  )
  if (res.data.code !== 0) throw new Error(`获取Token失败: ${res.data.msg}`)
  return res.data.tenant_access_token
}

/* -------- 拉取全量记录（自动分页） -------- */

async function fetchAllRecords(appToken, tableId, token) {
  let pageToken = null
  let all = []
  let page = 1
  let totalPrinted = false

  while (true) {
    const body = {
      automatic_fields: false,
      page_size: 500
    }
    //if (pageToken) body.page_token = pageToken

    const res = await axios.post(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`,
        {
          automatic_fields: false,
          page_size: 500
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          params: pageToken ? { page_token: pageToken } : {}  // ← query参数
        }
    )

    const resp = res.data

    if (!resp || resp.code !== 0) {
      throw new Error(`飞书API错误: code=${resp?.code}, msg=${resp?.msg}`)
    }

    // 只在第一页打印总数
    if (!totalPrinted) {
      console.log(`  总数: ${resp.data.total} 条`)
      totalPrinted = true
    }

    const items = resp.data?.items || []
    const records = items.map(i => i.fields).filter(Boolean)
    all.push(...records)

    console.log(`  第 ${page} 页: ${items.length} 条，累计 ${all.length} 条`)
    page++

    console.log(`  has_more: ${resp.data?.has_more}, page_token: ${resp.data?.page_token}`);

    if (!resp.data?.has_more) break  // has_more 为 false 或不存在时退出

    pageToken = resp.data.page_token  // ← 关键：每次更新为本页返回的新 token
  }

  return all
}
/* -------- 拉取字段结构 -------- */

async function fetchFields(appToken, tableId, token) {
  const res = await axios.get(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return res.data?.data?.items || []
}

/* -------- 主同步函数 -------- */

async function syncTable(appToken, tableId) {
  console.log(`\n🔄 开始同步 appToken=${appToken} tableId=${tableId}`)
  const startTime = Date.now()

  ensureCacheDir()

  const token = await getTenantToken()
  console.log('✅ 获取飞书Token成功')

  // 并行拉取字段和记录
  const [fields, records] = await Promise.all([
    fetchFields(appToken, tableId, token),
    fetchAllRecords(appToken, tableId, token)
  ])

  // 写入记录缓存
  const cacheData = {
    syncedAt: new Date().toISOString(),
    appToken,
    tableId,
    total: records.length,
    records
  }
  fs.writeFileSync(cacheFile(appToken, tableId), JSON.stringify(cacheData, null, 2), 'utf-8')

  // 写入字段元数据（供LLM理解字段结构用）
  const meta = buildMeta(fields, records)
  fs.writeFileSync(metaFile(appToken, tableId), JSON.stringify(meta, null, 2), 'utf-8')

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`✅ 同步完成: ${records.length} 条记录，耗时 ${elapsed}s`)
  console.log(`   缓存文件: ${cacheFile(appToken, tableId)}`)

  return { total: records.length, elapsed }
}

/* -------- 构建字段元数据（采样枚举值） -------- */

function buildMeta(fields, records) {
  const meta = {
    updatedAt: new Date().toISOString(),
    fields: []
  }

  for (const f of fields) {
    const name = f.field_name
    const type = f.type

    const fieldMeta = { name, type, typeLabel: getTypeLabel(type) }

    // 单选/多选：从API字段结构取选项（最准确）
    if (type === 3 || type === 4) {
      fieldMeta.options = (f.property?.options || []).map(o => o.name)
    }

    // 对所有字段：从真实数据中采样枚举值（补充API没有的）
    const sampledValues = sampleFieldValues(records, name, type)
    if (sampledValues.length > 0) {
      fieldMeta.sampleValues = sampledValues
    }

    meta.fields.push(fieldMeta)
  }

  return meta
}

/* -------- 从记录中采样字段值 -------- */

function sampleFieldValues(records, fieldName, type) {
  const valueSet = new Set()

  for (const rec of records) {
    const val = rec[fieldName]
    if (val === undefined || val === null || val === '') continue

    // 文本类型
    if (type === 1 && typeof val === 'string') {
      valueSet.add(val)
    }

    // 单选
    if (type === 3 && val?.text) {
      valueSet.add(val.text)
    }

    // 多选
    if (type === 4 && Array.isArray(val)) {
      val.forEach(v => v?.text && valueSet.add(v.text))
    }

    // 人员
    if (type === 11 && Array.isArray(val)) {
      val.forEach(v => v?.name && valueSet.add(v.name))
    }

    // 只采样前100个不同值
    if (valueSet.size >= 100) break
  }

  return [...valueSet].slice(0, 50)
}

/* -------- 字段类型中文标签 -------- */

function getTypeLabel(type) {
  const map = {
    1: '文本', 2: '数字', 3: '单选', 4: '多选',
    5: '日期', 7: '复选框', 11: '人员', 13: '电话',
    15: '超链接', 17: '附件', 18: '关联', 20: '公式',
    21: '双向关联', 22: '地理位置', 23: '群组', 1001: '创建时间',
    1002: '最后更新时间', 1003: '创建人', 1004: '修改人', 1005: '自动编号'
  }
  return map[type] || `类型${type}`
}

/* -------- 读取缓存 -------- */

function loadCache(appToken, tableId) {
  const file = cacheFile(appToken, tableId)
  if (!fs.existsSync(file)) return null
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  return data
}

function loadMeta(appToken, tableId) {
  const file = metaFile(appToken, tableId)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

/* -------- 检查缓存是否过期 -------- */

function isCacheStale(appToken, tableId, maxAgeMs = SYNC_INTERVAL_MS) {
  const file = cacheFile(appToken, tableId)
  if (!fs.existsSync(file)) return true
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const age = Date.now() - new Date(data.syncedAt).getTime()
  return age > maxAgeMs
}

/* -------- 启动定时自动同步 -------- */

function startAutoSync(tables) {
  console.log(`⏰ 启动自动同步，间隔 ${SYNC_INTERVAL_MS / 60000} 分钟`)

  async function runSync() {
    for (const t of tables) {
      try {
        await syncTable(t.appToken || process.env.FEISHU_APP_TOKEN, t.tableId)
      } catch (err) {
        console.error(`❌ 同步失败 ${t.name}:`, err.message)
      }
    }
  }

  // 首次立即执行
  runSync()

  // 定时重复
  setInterval(runSync, SYNC_INTERVAL_MS)
}

module.exports = {
  syncTable,
  loadCache,
  loadMeta,
  isCacheStale,
  startAutoSync
}
