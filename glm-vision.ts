#!/usr/bin/env bun
/**
 * glm-vision.ts — 视觉之眼核心脚本（v1.0）
 *
 * 读取本地图片 → base64 编码 → 调用智谱 GLM-4.6V-Flash（免费视觉模型）
 * → 输出结构化文字识别结果。零依赖，仅需 bun 运行时。
 *
 * 用法:
 *   bun glm-vision.ts detail  图片1.png [图片2.jpg ...]     # 详细描述（默认模式）
 *   bun glm-vision.ts ocr     screenshot.png                # OCR 文字提取
 *   bun glm-vision.ts analyze chart.png                     # 图表/数据深度分析
 *   bun glm-vision.ts prompt  artwork.jpg                   # 反推 AI 绘画提示词
 *   bun glm-vision.ts detail  photo.png --question "图里有几辆车？"
 *
 * API Key 读取优先级（命中即止）:
 *   1. 命令行 --api-key 参数（不推荐，会留在 shell 历史）
 *   2. 环境变量 ZHIPU_API_KEY
 *   3. 环境变量 GLM_API_KEY
 *   4. 脚本同级目录 .glm-vision.json   内容: {"apiKey": "你的Key"}
 *
 * 模型切换: 设置环境变量 GLM_VISION_MODEL（如 glm-4.6v-flashx），
 * 或替换为任意 OpenAI 兼容视觉模型服务的 model 名。
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";

const API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = process.env.GLM_VISION_MODEL || "glm-4.6v-flash";
const MAX_IMAGES = 5;      // 单次最多处理图片数，防止误传整个文件夹
// 官方限制：单张图片 base64 后 ≤5M，故原始文件 >5MB 直接拒绝。
const REJECT_SIZE_MB = 5;
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

// ---------- 模式 Prompt 模板 ----------
const PROMPTS: Record<string, string> = {
  detail: `你是一名专业的图像分析专家。请对这张图片进行尽可能详细、完整的描述，供一个没有视觉能力的人理解图片。要求：
1. 先一句话判定图片类型（照片/截图/流程图/架构图/图表/表格/绘画/其他）。
2. 若是流程图、架构图、示意图等结构化图形：逐个节点描述，明确节点之间的连接关系、箭头方向、层级结构、数据流或控制流，不要遗漏任何文字标注。
3. 逐字提取图中出现的所有文字（含代码、命令、数字、标注），代码和命令必须原样保留。
4. 描述布局、颜色、风格等视觉特征。
5. 若存在你无法确定的内容，明确写"无法确定"，禁止编造。
请用中文回答。`,
  ocr: `请对这张图片执行 OCR 文字提取。要求：
1. 逐字提取图中所有文字，包括标题、正文、标注、水印、代码、数字。
2. 保持原始排版结构（段落、换行、列表、表格行列），代码块用代码格式原样输出。
3. 按阅读顺序（从上到下、从左到右）排列。
4. 识别不清晰的地方用 [不清晰] 标注，禁止猜测补全。
请只输出提取的文字内容本身。`,
  analyze: `你是一名专业的数据分析师。请对这张图片进行深度分析。要求：
1. 若包含图表/数据：提取全部可见数据点、坐标轴含义、单位、图例，并转写为 Markdown 表格。
2. 分析数据反映的趋势、异常点、关键结论。
3. 若包含公式：原样转写公式并解释各符号含义。
4. 提取图中所有文字，并说明图片的整体结构与布局。
5. 对无法确定的数值标注 [数值不确定]，禁止编造。
请用中文回答。`,
  prompt: `请对这张图片执行 Image2Prompt 分析：深度解读画面内容、主体、构图、光影、色彩、风格、质感，反向生成可直接用于 AI 绘画工具（如 Midjourney / Stable Diffusion）的高质量提示词。要求：
1. 先用中文详细描述画面内容与风格特征。
2. 输出一段英文提示词（主体+细节+风格+光照+镜头+画质词）。
3. 输出一段中文提示词。
4. 附风格关键词建议。`,
};

// ---------- 工具函数 ----------
function fail(msg: string, code = 1): never {
  console.error(`[glm-vision] 错误: ${msg}`);
  process.exit(code);
}

function printHelp(): void {
  console.log(`视觉之眼 · GLM-4.6V-Flash 图片识别脚本
用法: bun glm-vision.ts [模式] 图片路径... [--question "问题"] [--api-key KEY]

模式:
  detail   详细描述（默认）：图片类型、结构、逐节点连线、逐字文字提取
  ocr      文字提取：逐字 OCR，保留排版
  analyze  深度分析：图表数据转表格、趋势分析、公式解读
  prompt   反推提示词：Image2Prompt，输出中英文绘画提示词

输入: 图片 png/jpg/jpeg/webp/gif/bmp（单张原始文件 ≤5MB），单次最多 5 张
Key 优先级: --api-key > 环境变量 ZHIPU_API_KEY > GLM_API_KEY > .glm-vision.json
模型切换: 环境变量 GLM_VISION_MODEL（默认 glm-4.6v-flash）`);
}

function parseArgs(argv: string[]): {
  mode: string; paths: string[]; question: string; apiKey: string;
} {
  const out = { mode: "detail", paths: [] as string[], question: "", apiKey: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-key") { out.apiKey = argv[++i] ?? ""; continue; }
    if (a === "--question" || a === "-q") { out.question = argv[++i] ?? ""; continue; }
    if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    if (a.startsWith("--")) fail(`未知参数: ${a}`, 2);
    if (PROMPTS[a]) { out.mode = a; continue; }
    out.paths.push(a);
  }
  return out;
}

function resolveApiKey(cliKey: string): string {
  if (cliKey) return cliKey;
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY;
  if (process.env.GLM_API_KEY) return process.env.GLM_API_KEY;
  const cfgPath = join(dirname(import.meta.path), ".glm-vision.json");
  try {
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (typeof cfg?.apiKey === "string" && cfg.apiKey.trim())
        return cfg.apiKey.trim();
    }
  } catch {
    // 配置文件损坏则跳过，继续尝试下一来源
  }
  fail(
    "未找到 API Key。请通过以下任一方式提供：\n" +
    "  1) 环境变量 ZHIPU_API_KEY 或 GLM_API_KEY\n" +
    '  2) 脚本同目录 .glm-vision.json，内容 {"apiKey": "你的Key"}\n' +
    "  3) 命令行 --api-key 参数（不推荐，会留在 shell 历史）",
    2,
  );
}

/** 预检文件：存在性、扩展名白名单、大小阈值 */
function precheckFiles(paths: string[]): void {
  for (const p of paths) {
    if (!existsSync(p))
      fail(`文件不存在: ${p}。请检查路径拼写，确认文件已放入工作目录。`);
    if (!statSync(p).isFile())
      fail(`不是普通文件: ${p}。`);
    if (statSync(p).size === 0)
      fail(`文件为空 (0 字节): ${p}。文件可能损坏或未保存完成。`);
    const ext = extname(p).toLowerCase();
    if (!ALLOWED_EXT.has(ext))
      fail(`不支持的格式 "${ext}": ${p}。支持: ${[...ALLOWED_EXT].join(" / ")}`);
    const sizeMB = statSync(p).size / 1024 / 1024;
    if (sizeMB > REJECT_SIZE_MB)
      fail(
        `${p} 大小 ${sizeMB.toFixed(1)}MB，超过 ${REJECT_SIZE_MB}MB 上限（官方限制 base64 后 ≤5M）。` +
        "请压缩后再试（缩小分辨率、转为 JPEG/WebP）。",
      );
  }
}

function classifyError(status: number, body: string): string {
  if (status === 401 || status === 403)
    return `API Key 无效或未授权 (HTTP ${status})。请检查 Key 是否拼写正确、所属项目是否开通了模型权限。`;
  if (status === 429 || /1302|1305|rate.?limit|限流|速率限制/i.test(body))
    return "请求被限流（智谱按账户动态并发限流，免费版高峰时段更严格）。请稍后重试，或减少单次数量。";
  if (status === 413 || /size|too large|图片.{0,6}(大小|过大|超限)/i.test(body))
    return `图片超过 API 大小限制 (HTTP ${status})。请压缩图片（长边缩至 2000px 内或转 JPEG/WebP）后重试。`;
  return `API 错误 (HTTP ${status}): ${body.slice(0, 300)}`;
}

async function callApi(
  apiKey: string,
  imageB64: string,
  promptText: string,
): Promise<string> {
  const content: Array<Record<string, unknown>> = [
    { type: "image_url", image_url: { url: imageB64 } },
    { type: "text", text: promptText },
  ];
  const body = {
    model: MODEL,
    messages: [{ role: "user", content }],
    max_tokens: 8192, // 显式放大，防止"尽可能详细"的输出被默认值截断
  };
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000), // 防止网络挂起导致永久等待
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return data.choices?.[0]?.message?.content ?? "(模型返回了空内容)";
      }
      const errText = await resp.text().catch(() => "");
      lastErr = classifyError(resp.status, errText);
      if (resp.status !== 429) break; // 仅限流时自动重试
    } catch (e) {
      lastErr = `网络错误: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(lastErr || "未知错误");
}

// ---------- 主流程 ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.paths.length === 0)
    fail("未提供图片路径。用法: bun glm-vision.ts [模式] 图片路径...（--help 查看帮助）", 2);
  if (args.paths.length > MAX_IMAGES)
    fail(`单次最多处理 ${MAX_IMAGES} 张图片（当前 ${args.paths.length} 张）。请分批处理。`);

  const apiKey = resolveApiKey(args.apiKey);
  precheckFiles(args.paths);

  console.log(`━━━ 视觉之眼 · ${MODEL} ━━━`);
  let okUnits = 0;
  for (let i = 0; i < args.paths.length; i++) {
    const p = args.paths[i];
    console.log(`\n[文件 ${i + 1}/${args.paths.length}] ${p} · 模式: ${args.mode}`);
    try {
      const buf = readFileSync(p);
      const b64 = buf.toString("base64");
      const result = await callApi(apiKey, b64, args.question || PROMPTS[args.mode]);
      console.log(result);
      okUnits++;
    } catch (e) {
      console.error(`  识别失败: ${e instanceof Error ? e.message : String(e)}`);
      console.error("  已跳过该文件，继续处理其余文件（如有）。");
    }
  }
  console.log(`\n━━━ 完成: ${okUnits} 个图片识别成功 ━━━`);
  if (okUnits === 0) process.exit(1);
}

main();
