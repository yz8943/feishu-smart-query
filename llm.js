const axios = require("axios")

async function callLLM(prompt) {

    const res = await axios.post(
        `${process.env.OPENAI_BASE_URL}/chat/completions`,
        {
            model: process.env.OPENAI_MODEL,
            temperature: 0,
            max_tokens: 1000,
            messages: [
                {
                    role: "system",
                    content: "你是飞书多维表格查询助手，只输出 JSON 数组，不输出任何其他内容。"
                },
                {
                    role: "user",
                    content: prompt
                }
            ]
        },
        {
            timeout: 30000, // 30秒超时
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json"
            }
        }
    )

    return res.data.choices[0].message.content
}

module.exports = { callLLM }