# 拣货系统 — 后端 (Railway)

## 部署步骤

### 1. 上传到 GitHub
新建一个仓库（例如 `picking-backend`），把这个文件夹的内容上传进去。

### 2. 部署到 Railway
1. 打开 https://railway.app，用 GitHub 登录
2. **New Project** → **Deploy from GitHub repo** → 选 `picking-backend`
3. 等待部署完成（约 1 分钟）
4. 进入项目 → **Settings** → **Networking** → **Generate Domain**
5. 复制生成的地址，例如：`https://picking-backend-xxx.up.railway.app`

### 3. 设置环境变量
在 Railway 项目页面 → **Variables** → 添加：

| 变量名 | 值 |
|--------|-----|
| `FRONTEND_URL` | 你的 Vercel 前端地址，例如 `https://picking-app.vercel.app` |

> ⚠️ 这一步很重要，否则浏览器会因为 CORS 拒绝请求

---

## 本地测试
```bash
npm install
npm start
# 后端运行在 http://localhost:3000
```
