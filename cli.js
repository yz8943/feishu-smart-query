// cli.js
require('dotenv').config({ path: __dirname + '/.env' }); // 加载 .env
const { program } = require("commander");
const { smartQuery } = require("./smart-query");
const tables = require("./tables");

program
  .command("smart-query")
  .requiredOption("--question <text>", "要查询的问题")
  .option("--table-name <name>", "多维表格名称，优先匹配配置文件")
  .option("--app-token <token>", "Feishu App Token，CLI 参数覆盖默认")
  .option("--table-id <id>", "Bitable Table ID，CLI 参数覆盖默认")
  .action(async (options) => {
    // token 优先 CLI > .env
    const appToken = options.appToken || process.env.FEISHU_APP_TOKEN;
    let tableId = options.tableId;

    let tableName = options.tableName;

    // 如果没传 table-name 且没传 tableId，默认取第一个表格
    if (!tableId && !tableName) {
      const defaultTable = tables[0];
      tableId = defaultTable.tableId;
      tableName = defaultTable.name;
      console.log(`⚡ 未指定表格，默认使用第一个表格: ${tableName}`);
    }

    // 如果传了 table-name，从配置文件获取 tableId
    if (tableName) {
      const conf = tables.find(t => t.name === tableName);
      if (!conf) {
        console.error(`⚠️ 未找到表格配置: ${tableName}`);
        process.exit(1);
      }
      tableId = tableId || conf.tableId;
    }

    // 校验必要参数
    if (!appToken || !tableId) {
      console.error("⚠️ app-token 或 table-id 未设置，请在 .env 或 CLI 传入");
      process.exit(1);
    }

    // 调试打印
    console.log("使用的参数：");
    console.log("appToken:", appToken);
    console.log("tableId:", tableId);
    console.log("question:", options.question);

    try {
      const records = await smartQuery(appToken, tableId, options.question);
      console.log("最终记录:", records.length);
      //console.log(JSON.stringify(records, null, 2));
    } catch (err) {
      console.error("查询失败:", err.message);
    }
  });

program.parse(process.argv);