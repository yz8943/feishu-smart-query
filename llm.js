const axios = require("axios")

async function callLLM(prompt) {

  const res = await axios.post(
    `${process.env.OPENAI_BASE_URL}/chat/completions`,
    {
      model: process.env.OPENAI_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "你是一个飞书多维表格查询解析助手。输出 JSON filter。"
        },
        {
          role: "user",
          content: prompt
        }

      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  )

  return res.data.choices[0].message.content
}

module.exports = { callLLM }