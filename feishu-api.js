const axios = require("axios")

require('dotenv').config();

async function getTenantToken() {


    try {
        console.log("FEISHU_APP_ID："+process.env.FEISHU_APP_ID);
        console.log("FEISHU_APP_SECRET："+process.env.FEISHU_APP_SECRET);

        const response = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/', {
            app_id: process.env.FEISHU_APP_ID,
            app_secret: process.env.FEISHU_APP_SECRET
        }, {
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            }
        });

        if (response.data.code === 0) {
            return response.data.tenant_access_token;
        } else {
            throw new Error(`获取访问令牌失败: ${response.data.msg}`);
        }
    } catch (error) {
        throw new Error(`获取访问令牌时出错: ${error.message}`);
    }


}

async function getFields(appToken, tableId) {

    const token = await getTenantToken()

    const res = await axios.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
        {
            headers: {
                Authorization: `Bearer ${token}`
            }
        }
    )
    return res.data.data.items.map(f => ({
        name: f.field_name,
        type: f.type
    }));
    //return res.data.data.items
}

async function searchRecords(appToken, tableId, filter) {
    const token = await getTenantToken()
    let pageToken = null
    let all = []

    while (true) {
        const res = await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`,
            {
                filter,
                automatic_fields: false,
                page_size: 500,
                page_token: pageToken
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        )

        const resp = res.data
        console.log("searchRecords res.data:", JSON.stringify(res.data));

        // 检查 API 返回
        if (!resp || resp.code !== 0) {
            throw new Error(
                `Feishu Bitable API返回错误: code=${resp?.code}, msg=${resp?.msg}`
            )
        }

        const data = resp.data || {}
        const items = data.items || []

        all.push(...items.map(i => i.fields || {}))

        if (!data.has_more) break
        pageToken = data.page_token
    }

    return all
}

module.exports = {
    getFields,
    searchRecords
}