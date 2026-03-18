// cli.js
require('dotenv').config({ path: __dirname + '/.env' })

const { program } = require('commander')
const { syncTable, startAutoSync } = require('./../sync')
const { localQuery } = require('./../local-query')
const tables = require('./../tables')

/* -------- 辅助：解析 appToken / tableId -------- */

function resolveTable(options) {
  const appToken = options.appToken || process.env.FEISHU_APP_TOKEN

  let tableId = options.tableId
  let tableName = options.tableName

  if (!tableId && !tableName) {
    const def = tables[0]
    tableId = def.tableId
    tableName = def.name
    console.log(`⚡ 未指定表格，默认使用: ${tableName}`)
  }

  if (tableName && !tableId) {
    const conf = tables.find(t => t.name === tableName)
    if (!conf) {
      console.error(`⚠️  未找到表格配置: ${tableName}`)
      process.exit(1)
    }
    tableId = conf.tableId
  }

  if (!appToken || !tableId) {
    console.error('⚠️  缺少 app-token 或 table-id，请在 .env 或 CLI 传入')
    process.exit(1)
  }

  return { appToken, tableId }
}

/* ========================================================
   命令1: sync - 手动触发全量同步
   用法: node cli.js sync
         node cli.js sync --table-name 大家车内容制作项目
   ======================================================== */

program
  .command('sync')
  .description('全量同步飞书多维表格到本地缓存')
  .option('--table-name <name>', '多维表格名称')
  .option('--app-token <token>', 'Feishu App Token')
  .option('--table-id <id>', 'Bitable Table ID')
  .option('--all', '同步所有配置表格')
  .action(async (options) => {
    if (options.all) {
      for (const t of tables) {
        const appToken = t.appToken || process.env.FEISHU_APP_TOKEN
        try {
          await syncTable(appToken, t.tableId)
        } catch (err) {
          console.error(`❌ ${t.name} 同步失败:`, err.message)
        }
      }
    } else {
      const { appToken, tableId } = resolveTable(options)
      try {
        const result = await syncTable(appToken, tableId)
        console.log(`\n🎉 同步完成! 共 ${result.total} 条，耗时 ${result.elapsed}s`)
      } catch (err) {
        console.error('❌ 同步失败:', err.message)
        process.exit(1)
      }
    }
  })

/* ========================================================
   命令2: smart-query - 基于本地缓存的智能查询（新方案）
   用法: node cli.js query --question "去年商配"
   ======================================================== */

program
  .command('smart-query')
  .description('基于本地缓存的智能查询（推荐）')
  .requiredOption('--question <text>', '要查询的问题')
  .option('--table-name <name>', '多维表格名称')
  .option('--app-token <token>', 'Feishu App Token')
  .option('--table-id <id>', 'Bitable Table ID')
  .option('--no-auto-sync', '禁止自动同步过期缓存')
  .action(async (options) => {
    const { appToken, tableId } = resolveTable(options)

    try {
      const records = await localQuery(appToken, tableId, options.question)
      console.log(`\n📊 查询结果: ${records.length} 条`)
        const formatted = records.map(r => ({
            出品性质:     extractText(r['出品性质']),
            项目名称:     extractText(r['项目名称']),
            '主持人/作者': extractPersons(r['主持人/作者']),
            上线日期:     formatDate(r['上线日期']),
            实际交片日期: formatDate(r['实际交片日期']),
            执行日期:     formatDate(r['执行日期'])
        }))

        console.log(JSON.stringify(formatted, null, 2));

    } catch (err) {
      console.error('❌ 查询失败:', err.message)
      process.exit(1)
    }
  })


/* ========================================================
   命令4: watch - 启动守护进程，定时自动同步
   用法: node cli.js watch
   （生产环境建议用 pm2 / systemd 运行）
   ======================================================== */

program
  .command('watch')
  .description('启动定时自动同步守护进程')
  .action(() => {
    startAutoSync(
      tables.map(t => ({
        ...t,
        appToken: t.appToken || process.env.FEISHU_APP_TOKEN
      }))
    )
    console.log('🚀 守护进程已启动，按 Ctrl+C 退出')
  })

program.parse(process.argv)



/* -------- 字段提取辅助函数 -------- */

// 提取文本（兼容字符串、{text:...}、[{text:...}]）
function extractText(val) {
    if (!val) return ''
    if (typeof val === 'string') return val
    if (val.text) return val.text
    if (Array.isArray(val)) return val.map(v => v?.text || v?.name || '').filter(Boolean).join(', ')
    return String(val)
}

// 提取人员姓名列表
function extractPersons(val) {
    if (!val) return ''
    if (Array.isArray(val)) return val.map(v => v?.name || '').filter(Boolean).join(', ')
    if (val.name) return val.name
    return String(val)
}

// 格式化日期（飞书日期字段是毫秒时间戳）
function formatDate(val) {
    if (!val) return ''
    const ts = typeof val === 'number' ? val : Number(val)
    if (isNaN(ts)) return String(val)
    const d = new Date(ts)
    const yyyy = d.getFullYear()
    const mm   = String(d.getMonth() + 1).padStart(2, '0')
    const dd   = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}