const { program } = require("commander")
const { smartQuery } = require("./smart-query")

program
    .command("smart-query")
    .requiredOption("--app-token <token>")
    .requiredOption("--table-id <id>")
    .requiredOption("--question <text>")
    .action(async (options) => {

        const records = await smartQuery(
            options.appToken,
            options.tableId,
            options.question
        )

        console.log(JSON.stringify(records, null, 2))

    })

program.parse(process.argv)