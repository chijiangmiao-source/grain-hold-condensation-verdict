# 散粮船舱口通风露点判定（Vue 3 + Go Gin）

散粮船抵港前遇到昼夜温差，大副需要决定是否开启舱口通风。**只看相对湿度会误判**：
相对湿度只表示空气接近饱和的程度，是否会在冷粮表面结露，取决于粮温与舱内空气
**露点温度**之差。本应用按 Magnus 公式计算露点，并以未舍入的温差给出通风结论。

前端（Vue 3 + Vite）只负责录入与展示，**不在浏览器里复算**；所有 γ、Td、Δ 与结论
均由 Go（Gin）API 计算并返回，SQLite 同时保存输入、未舍入中间量和结论，因此
“页面一套、API 一套”不可能发生，合法提交刷新后结论仍然一致。

同一航次同一舱位**连续测量**时，成功的提交会在**同一数据库事务**内锁定该舱按创建
顺序的最近一条有效记录作为前序（首测无前序）；详情接口在此之上返回两者的未舍入
变化量（粮温、气温、湿度、露点、温差），页面用首次测量提示或对照卡展示，浏览器
同样不参与减法复算。

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
  internal/store/        SQLite 建表/增量迁移、增查（未舍入中间量 + 同舱前序 prev_id + 独立 robustness_checks 核查表）
  internal/httpapi/      Gin 路由、422 字段错误、公式代入明细、稳健性核查
web/
  src/lib/api.js         仅做 fetch，不含任何公式
  src/pages/             录入页 HomePage、详情页 DetailPage、舱位概览页 OverviewPage、
                         核查发起页 RobustnessLaunchPage、核查详情页 RobustnessCheckPage
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
   校验刷新一致性、两个临界端点、422 不落库，以及舱位概览按 `MAX(id)` 取每舱最新项；
   另用交错舱位与重复舱位验证**批量提交**的批内前序关联、概览最新项，以及中间行越界时
   整批回滚（无部分记录、无断裂关联）；并以独立公式逐组复算稳健性核查的**八组边界**，
   验收稳定样本、跨结论敏感样本（含负侧）、非法误差不落库（不占编号）、原评估缺失与凭核查编号刷新一致；
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
| POST | `/api/assessments` | 提交一次评估；成功 201，请求体结构/格式错误 400，字段非法 422 |
| POST | `/api/assessments/batch` | 一次提交 **1～20 行**有序测量（批量抄录）；成功 201，结构/格式错误 400，任一行字段非法 422（带行号，整批不落库） |
| GET | `/api/assessments` | 列表（最新在前） |
| GET | `/api/assessments/:id` | 详情，含公式逐行代入字符串；复测记录另含可选前序对照 `comparison` |
| POST | `/api/assessments/:id/robustness-checks` | 以某条评估为中心发起一次**稳健性核查**；成功 201，原评估不存在/误差非法 422（逐字段反馈，不落库） |
| GET | `/api/robustness-checks/:id` | 按**核查编号**读取不可变核查详情（原评估快照、误差范围、八组边界结果、结论集合） |
| GET | `/api/voyages/:voyage/hatches/latest` | 舱位概览（只读）：该航次每个舱号各一条**最新**快照，按舱号升序 |

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

422 响应（字段级错误，整次拒绝、不落库）：

```json
{
  "error": "输入校验失败，未生成任何记录",
  "fields": [
    { "field": "tg", "code": "out_of_range", "message": "粮温 Tg必须在 -20.0 至 60.0 之间" },
    { "field": "rh", "code": "not_finite", "message": "相对湿度 RH必须为有限数值" }
  ]
}
```

400 响应（请求体结构/格式错误，不逐字段报错、不落库）。以下请求与“缺字段”无关，
不会被误报成五个字段全部缺失：

- 顶层不是 JSON 对象：`null`、`[]`、标量；
- 对象闭合后附带任何内容（`{"…":…}]`、`{"…":…} GARBAGE`、第二个 JSON 值等）；
- 同一字段在对象中重复声明（即使两处值相同），避免“同字段两个值”的歧义；
- 空请求体或非法 JSON 文本。

```json
{ "error": "请求体格式错误：字段 \"rh\" 重复声明，请求含义不唯一" }
```

注意 `1e999` 这类**值**的非有限问题走 422（`code: "not_finite"`），不属于
结构/格式错误；结构校验只判定文档形态，不影响逐字段报错能力。

详情页直接展示 `formula.*_line` 的代入文本与持久化的未舍入值，使审计口径一目了然。

### 批量录入（靠港前集中抄录）

大副在录入页可切换到**批量模式**，按测量先后一次填写**最多 20 行**航次、舱号、
粮温、气温与湿度并一次提交。录入页的“单条录入 / 批量录入”只是同一表单的两种形态：
单条请求与响应结构完全不变。

请求体顶层是一个有序数组（行顺序即测量顺序）：

```json
{
  "measurements": [
    { "voyage": "V-2026-09", "hatch": "3H", "tg": 25, "ta": 20, "rh": 70 },
    { "voyage": "V-2026-09", "hatch": "2P", "tg": 24, "ta": 20, "rh": 70 },
    { "voyage": "V-2026-09", "hatch": "3H", "tg": 23.5, "ta": 21, "rh": 75 }
  ]
}
```

- 服务端**逐行复用**单条提交的解析、范围校验与 `decision.Evaluate` 露点判定（同一套
  代码路径，两处口径不可能分叉）；
- 只有**所有行都合法**才在**单个事务**中按数组顺序依次保存，成功返回
  **201** `{"count": n, "items": [ <与单条 POST 完全相同的 DTO>… ]}`，
  `items` 按创建顺序排列、id 连续递增；每行项仍含 `formula`、不含 `comparison`；
- **批内关联**：同航次同舱的后续行，其前序就是**本批较早**插入的那一行（事务内
  `SELECT … ORDER BY id DESC` 能读到本事务自己刚写入的行）；批量中未出现的舱位，
  其首行仍承接**数据库中**该舱最近的有效前序；全新航次舱位为首测、无前序；
- **任一行非法 → 整批不落库**：返回 **422**，逐行给出**行号（1 基）与原字段错误**，
  页面保留全部输入、标记并滚动定位到第一个问题行：

```json
{
  "error": "批量输入校验失败，整批未保存任何记录",
  "rows": [
    { "row": 2, "fields": [
      { "field": "tg", "code": "out_of_range", "message": "粮温 Tg必须在 -20.0 至 60.0 之间" }
    ] }
  ]
}
```

- 保存过程中事务失败同样整体回滚，**不留部分记录、不留断裂关联**；
- 结构/格式错误仍是 **400**（不是 422）：顶层非对象、缺少/非数组的 `measurements`、
  空数组、超过 20 行、某行不是对象、行内字段重复/未知、对象后多余内容等；
- 提交成功后页面按行显示评估编号、未舍入/展示温差与结论，每行可进入**既有详情页**
  （复测行的详情照常带 `comparison`）；历史列表与舱位概览立即按**真实创建顺序**
  （`MAX(id)`）反映这批记录。

### 前序对照（仅详情接口）

成功提交时，服务端在**同一事务**内按 `voyage + hatch` 找到按创建顺序（id）最近的
前一条**有效**记录，把其编号存入新行的 `prev_id`：

- 该航次该舱位的**首测**没有前序：POST、列表、详情的字段均与旧版一致（不含 `comparison`）；
- 复测记录的**详情响应**在原字段上额外增加可选 `comparison`；POST 响应与列表项永不含该块；
- 前序的选取只看同航次同舱，交错舱位提交不会串舱；422 不落库，也不会成为任何记录的前序。

有可用前序时：

```json
"comparison": {
  "available": true,
  "previous": {
    "id": 7, "voyage": "V-2026-09", "hatch": "3H",
    "tg": 25.345, "ta": 20.123, "rh": 71.5,
    "gamma": 1.051, "td": 15.359183217771522, "delta": 9.985816782228477,
    "gamma_display": 1.05, "td_display": 15.36, "delta_display": 9.99,
    "verdict": "allowed",
    "created_at": "2026-09-12T00:00:00Z"
  },
  "changes": {
    "tg": -1.227999999999998, "ta": 1.8639999999999972, "rh": -3.25,
    "td": 1.058764057682854, "delta": -2.286764057682852
  }
}
```

`changes.*` 全部是 **Go 用未舍入 float64 计算的（本次 − 前序）**：粮温、气温、
湿度、露点、温差五项，浏览器只渲染，不做减法。

若保存的前序记录事后已不存在，或已不属于同一航次同一舱，当前评估照常返回，对照
标记为不可用，**不会临时改绑**到其他记录：

```json
"comparison": { "available": false, "prev_id": 99, "reason": "保存的前序记录已不存在，无法形成对照" }
```

页面据此显示“首次测量”提示、对照卡（含前序摘要链接与五项未舍入变化量）或
“前序对照不可用”的明确告警。

### 舱位概览（按航次，只读）

抵港交接时，大副要在同一航次的多舱记录里快速确认**各舱当前风险**，不必逐条
打开历史详情，也不能把较早的测量误当成当前依据。历史区为每个出现过的航次
提供一个“舱位概览”入口：

```
GET /api/voyages/:voyage/hatches/latest
```

- 服务端按 `voyage` 过滤、按 `hatch` 分组，以**最大记录编号 `MAX(id)`** 确定
  每个舱号唯一的最新项——不看 `created_at` 文本，因此交错提交、甚至同一
  纳秒时间戳（或时钟回拨的旧时间戳）都不会选错记录；判定口径与“最新=创建
  顺序最后一条”一致。
- 结果按**舱号升序**稳定排序（同舱号再以 id 兜底），多次读取顺序一致。
- 仅返回该航次本舱记录；同舱号但属于其他航次的行绝不串入。
- **航次不存在**时是正常的 `200` + 空集合：`{"voyage":…,"items":[]}`，不是错误。
- 航次代号含 `/` 时用百分号编码访问（`V/A` → `/api/voyages/V%2FA/...`），
  路由按原始路径匹配并反转义；**非法路径编码**（如 `%zz`、残缺的 `%`）由
  net/http 在进入处理前直接以 **400** 拒绝，空航次段（`/voyages//...`）返回
  明确的 400 请求错误；错误页保留“返回历史区”入口。

响应是比详情更精简的只读快照（**不含** `formula` 与 `comparison`）：

```json
{
  "voyage": "V-2026-09",
  "items": [
    {
      "id": 12, "voyage": "V-2026-09", "hatch": "2P",
      "tg": 26, "ta": 20, "rh": 70,
      "gamma": 0.9826379171132591, "td": 14.359183217771522,
      "delta": 11.640816782228478,
      "gamma_display": 0.98, "td_display": 14.36, "delta_display": 11.64,
      "verdict": "allowed",
      "created_at": "2026-09-13T08:00:00Z"
    }
  ]
}
```

页面逐行展示舱号、最新评估编号、测量时间、**未舍入 Δ** 与展示 Δ、结论，
每一行可直接跳到该记录的原详情；页面完全渲染接口返回值，不在浏览器里挑选
或重算“最新项”。该接口为只读，POST/列表/详情/前序关联及旧响应结构均不变。

### 稳健性核查（仪表误差下的八组边界）

海上仪表存在允许误差时，单次露点结论可能在真实值边界上翻转（Δ 未舍入值恰好贴近 ±2.00
时尤为明显）。大副在**评估详情页**可发起一次稳健性核查，只填写粮温、气温、湿度三个
**对称误差幅度**（±值）：

```json
{ "tg_eps": 0.01, "ta_eps": 0.01, "rh_eps": 0.5 }
```

- 原评估的 voyage/hatch 与 Tg/Ta/RH 一律取自被核查的那条记录，**请求体只含三个误差幅度**，
  不接受（出现即 400）其他字段；
- 服务端以原评估输入为中心，对三个量各取 **−ε / +ε**，按固定顺序生成 **2³ = 8 组**边界组合
  （角点）：`---、--+、-+-、-++、+--、+-+、++-、+++`；
- 每一组都调用**现有的 `decision.Evaluate` 未舍入露点判定**（与单条/批量录入同一套代码路径），
  不另写公式、不在判定前舍入；
- 保存内容：误差参数、原评估 DTO 的**不可变快照**、八组边界的输入与未舍入结果（γ/Td/Δ、
  展示值、结论）、以及八组结论按首次出现顺序去重得到的**结论集合** `verdicts`；
- 判定标记：八组结论**全部等于原结论**（集合仅含原结论）→ `"status":"stable"`（稳定）；
  只要出现不同结论（集合包含多种结论）→ `"status":"sensitive"`（敏感）。

核查写入**独立新表** `robustness_checks`（自包含、不可变），创建后不再重算或改写；
成功返回 **201** 并进入**独立核查详情**，可凭响应/页面中的**核查编号**随时重新打开。

```json
{
  "id": 1, "assessment_id": 12,
  "assessment": { "id": 12, "tg": 16.36, "td": 14.359183217771522, "delta": 2.000816782228478,
                  "verdict": "allowed", "formula": { }, },
  "tolerances": { "tg": 0.01, "ta": 0.01, "rh": 0.5 },
  "corners": [
    { "index": 1, "tg_sign": "-", "ta_sign": "-", "rh_sign": "-",
      "tg": 16.35, "ta": 19.99, "rh": 69.5,
      "td": 14.238724, "delta": 2.111276, "delta_display": 2.11,
      "verdict": "allowed", "matches_original": true },
    { "index": 2, "tg_sign": "-", "ta_sign": "-", "rh_sign": "+",
      "tg": 16.35, "ta": 19.99, "rh": 70.5,
      "td": 14.459796, "delta": 1.890204, "delta_display": 1.89,
      "verdict": "retest", "matches_original": false }
  ],
  "verdicts": ["allowed", "retest"], "status": "sensitive", "created_at": "2026-09-14T08:00:00Z"
}
```

页面（发起页 `/assessments/:id/robustness-checks/new`、独立核查详情 `/robustness-checks/:id`、
历史区“凭核查编号重新打开”）**只渲染服务端结果**：展示原评估快照、对称误差范围、八行服务端
边界结果（翻转行高亮）与稳定/敏感风险提示；**浏览器不生成任何边界组合、不做任何判定或减法**。
核查详情不存在（404）或读取失败（5xx）时，页面明确告警，且**只提供返回历史区的入口**，
不直接跳回发起核查的原评估（原评估需从历史区自行查找后重新发起）。

**输入校验（422 逐字段反馈，整次拒绝、不落库、不占用核查编号）：**

| 情形 | 字段 | code |
| --- | --- | --- |
| 原评估编号不存在 | `assessment` | `not_found` |
| 误差幅度缺失/为 null | `tg_eps`/`ta_eps`/`rh_eps` | `required` |
| 类型不是数值（如字符串、对象） | 同上 | `wrong_type` |
| 非有限（`NaN`、`±Infinity`、`1e999` 溢出字面量） | 同上 | `not_finite` |
| 零或负数 | 同上 | `not_positive` |
| 中心值 ± 幅度越出该量的合法区间 | 同上 | `out_of_range` |

合法区间与评估完全一致：Tg/Ta ∈ [−20, 60] ℃，RH ∈ [1, 100] %。边界**恰好**落在端点上是合法的
（闭区间，例如中心 20、幅度 40 → 边界恰为 −20 与 60）；越出则 `out_of_range`，反馈中给出中心值
与实际对称区间。文档形态错误（顶层非对象、未知字段、重复键、对象后多余内容）仍是 **400**，
与单条提交一致。核查不写入 `assessments`，因此单条/批量录入、前序对照、舱位概览与各端口变量
完全不受影响。

### SQLite 迁移

启动时自动建表并做**增量、无损**迁移：旧版数据库（无 `prev_id` 列）启动后通过
`ALTER TABLE assessments ADD COLUMN prev_id INTEGER` 增加关联字段并补建
`(voyage, hatch, id DESC)` 索引；历史行 `prev_id` 为 NULL（视作各舱首测），
历史详情、列表顺序（id 倒序）与新记录创建均保持可用。稳健性核查使用
`CREATE TABLE IF NOT EXISTS robustness_checks` **独立新表**承载（原评估快照、误差参数、
八组角点 JSON、结论集合、稳定/敏感标记），不改动 `assessments` 的任何列；旧库启动时同样
自动补建该表，历史评估与新的核查能力互不影响。
