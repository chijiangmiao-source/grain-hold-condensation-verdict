# 散粮船舱口通风露点判定（Vue 3 + Go Gin）

散粮船抵港前遇到昼夜温差，大副需要决定是否开启舱口通风。**只看相对湿度会误判**：
相对湿度只表示空气接近饱和的程度，是否会在冷粮表面结露，取决于粮温与舱内空气
**露点温度**之差。本应用按 Magnus 公式计算露点，并以未舍入的温差给出通风结论。

前端（Vue 3 + Vite）只负责录入与展示，**不在浏览器里复算**；所有 γ、Td、Δ 与结论
均由 Go（Gin）API 计算并返回，SQLite 同时保存输入、未舍入中间量和结论，因此
“页面一套、API 一套”不可能发生，合法提交刷新后结论仍然一致。

---

## 一、复算口径（务必以此为准）

### 1. 输入与量纲

| 字段 | 含义 | 单位 | 合法范围 |
| --- | --- | --- | --- |
| `voyage` | 航次代号 | 文本 | 非空（自动去除首尾空白） |
| `hatch` | 舱号 | 文本 | 非空 |
| `Tg` | 粮温 | ℃ | −20.0 ≤ Tg ≤ 60.0 |
| `Ta` | 舱内气温 | ℃ | −20.0 ≤ Ta ≤ 60.0 |
| `RH` | 相对湿度 | % | 1.0 ≤ RH ≤ 100.0 |

任一数值**非有限**（`NaN`、`±Infinity`、`1e999` 这类溢出字面量）或**越界**，
整次请求返回 **HTTP 422**，逐字段给出错误，**不生成任何记录**。

### 2. 公式（顺序固定，不跳步舍入）

```
γ  = ln(RH/100) + 17.62 × Ta / (243.12 + Ta)
Td = 243.12 × γ / (17.62 − γ)
Δ  = Tg − Td
```

- γ、Td、Δ 全程使用 **float64 未舍入值**参与下一步运算和最终判定；
- 仅在“展示”时按**四舍五入（round half away from zero）保留两位小数**，
  即 Go 的 `math.Round(v*100)/100`；
- SQLite 中保存的是未舍入的 `gamma / td / delta`（REAL），展示值在读取时再派生。

### 3. 判定区间（闭区间，含两个端点）

以**未舍入 Δ** 为准：

| 条件 | 结论 | 含义 |
| --- | --- | --- |
| Δ > 2.00 | `allowed` 允许通风 | 粮温显著高于露点 |
| Δ < −2.00 | `denied` 禁止通风 | 湿空气会在冷粮表面结露 |
| **−2.00 ≤ Δ ≤ 2.00（含 −2.00 与 2.00）** | `retest` 暂停并复测 | 临界区间 |

关键：**结论绝不能用页面上的两位小数反推**。例如未舍入 Δ = 2.004 时展示为
`2.00`，但仍判“允许”；未舍入 Δ = 1.998 时展示也是 `2.00`，却判“复测”。
所以前端只渲染 API 返回的 `verdict`。两个数学端点 Δ = ±2.00 都只能落入
“复测”，这一点在 Go 单元测试、HTTP 集成测试、Playwright E2E 和验收探针中
均有专门用例（含 ULP 级边界与二分定位）。

### 4. 校验示例

| 输入（Ta=20, RH=70，Td≈14.3592） | 未舍入 Δ | 展示 Δ | 结论 |
| --- | --- | --- | --- |
| Tg = 16.36 | 2.0008 | 2.00 | allowed |
| Tg = 16.357 | 1.9978 | 2.00 | **retest** |
| Tg = 12.36 | −1.9992 | −2.00 | **retest** |
| Tg = 12.357 | −2.0022 | −2.00 | denied |
| Tg = 25 | 10.6408 | 10.64 | allowed |
| Tg = 5（Ta=28, RH=95） | — | — | denied |

---

## 二、架构

```
浏览器 (Vue 3 SPA)
   │  同源 /api/*
   ▼
nginx (web 容器，托管 dist 并反代 /api)
   │
   ▼
Go Gin (api 容器)  ── decision.Evaluate()  ← 唯一的公式实现
   │
   ▼
SQLite 文件 (modernc.org/sqlite，纯 Go，静态编译；命名卷 api-data)
```

- 后端：Go 1.23、Gin、modernc.org/sqlite（无 CGO）、testify；
- 前端：Vue 3 + Vue Router + Vite，Vitest + @vue/test-utils，Playwright；
- 计算实现在 `api/internal/decision/decision.go`，HTTP 层与测试都调用它。

## 三、目录结构

```
api/
  cmd/server/            程序入口（API_PORT / DB_PATH 可配）
  internal/decision/     Magnus 公式、范围校验、区间判定（唯一计算口径）
  internal/store/        SQLite 建表、增查（保存未舍入中间量）
  internal/httpapi/      Gin 路由、422 字段错误、公式代入明细
web/
  src/lib/api.js         仅做 fetch，不含任何公式
  src/pages/             录入页 HomePage、详情页 DetailPage
  src/components/        VerdictBadge 等展示组件
  test/unit/             Vitest 单元/组件测试
  test/e2e/              Playwright 端到端（真实 Gin + SQLite）
verify/
  Dockerfile             一次性验收镜像（Playwright 镜像 + Go 工具链）
  entrypoint.sh          go test → 独立复算探针 → Playwright
  acceptance.mjs         用独立复写的 Magnus 公式核对真实服务，假接口过不了
scripts/e2e-serve.sh     本地一键起真实栈供 Playwright 使用
docker-compose.yml       api / web / verify 三个服务
```

## 四、用 Docker Compose 运行

```bash
docker compose up --build
# 浏览器打开 http://localhost:8081 （WEB_PORT 默认 8081，API 宿主端口默认 8080）
```

覆盖宿主端口（容器内端口不变）：

```bash
WEB_PORT=9000 API_PORT=9001 docker compose up --build
# web -> http://localhost:9000   api -> http://localhost:9001
```

也可复制 `.env.example` 为 `.env` 后直接 `docker compose up`。

### 一次性验收服务 `verify`

`verify` 是一次性服务（`restart: "no"`，带 compose profile），它会等待
api/web 健康后依次执行：

1. `go test ./...`（testify 单元 + HTTP/SQLite 集成测试）；
2. `verify/acceptance.mjs`：**独立复写** Magnus 公式核对真实 API 的数值与结论，
   校验刷新一致性、两个临界端点、422 不落库；
3. Playwright/Chromium 经 nginx → Gin → SQLite 跑浏览器端到端。

```bash
docker compose build
docker compose run --rm verify
```

全部通过会打印 `VERIFY OK ...`，容器随即退出，不影响常驻的 api/web 服务。

## 五、本地开发（不用 Docker）

前置：Go 1.23+、Node 20+。

```bash
# 终端 1：API（:8080，SQLite 文件可指定）
cd api
DB_PATH=./ventilation.db API_PORT=8080 go run ./cmd/server

# 终端 2：前端（:5173，/api 自动代理到 8080）
cd web
npm install
npm run dev
```

### 运行测试

```bash
# Go：testify
(cd api && go test ./... -count=1)

# 前端：Vitest 单元/组件测试
(cd web && npm test)

# 端到端：脚本自动编译并启动真实 Gin（临时 SQLite）+ vite preview，
# 再由 Playwright 驱动 Chromium
(cd web && npm run test:e2e)
```

## 六、HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/healthz` | 健康检查 |
| POST | `/api/assessments` | 提交一次评估；成功 201，非法 422 |
| GET | `/api/assessments` | 列表（最新在前） |
| GET | `/api/assessments/:id` | 详情，含公式逐行代入字符串 |

成功响应（节选）：

```json
{
  "id": 1, "voyage": "V-2026-09", "hatch": "3H",
  "tg": 25, "ta": 20, "rh": 70,
  "gamma": 0.9826379171132591, "gamma_display": 0.98,
  "td": 14.359183217771522,    "td_display": 14.36,
  "delta": 10.640816782228478, "delta_display": 10.64,
  "verdict": "allowed",
  "formula": {
    "gamma_line": "γ = ln(RH/100) + 17.62 × Ta / (243.12 + Ta) = ln(70/100) + 17.62 × 20 / (243.12 + 20) = 0.982638（展示值 0.98）",
    "td_line": "Td = 243.12 × γ / (17.62 − γ) = … = 14.359183 ℃（展示值 14.36 ℃）",
    "delta_line": "Δ = Tg − Td = 25 − 14.359183 = 10.640817 ℃（展示值 10.64 ℃）",
    "rule_line": "判定以未舍入 Δ 为准：Δ > 2.00 允许通风；Δ < −2.00 禁止通风；−2.00 ≤ Δ ≤ 2.00（含两端点）暂停并复测。"
  }
}
```

422 响应（整次拒绝、不落库）：

```json
{
  "error": "输入校验失败，未生成任何记录",
  "fields": [
    { "field": "tg", "code": "out_of_range", "message": "粮温 Tg必须在 -20.0 至 60.0 之间" },
    { "field": "rh", "code": "not_finite", "message": "相对湿度 RH必须为有限数值" }
  ]
}
```

详情页直接展示 `formula.*_line` 的代入文本与持久化的未舍入值，使审计口径一目了然。
