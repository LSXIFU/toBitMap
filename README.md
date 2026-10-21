# 位图转换器 · 图像 / 视频 / 手绘 / 文字 → 1bpp C 数组

把图片、视频、手绘图案或一行文字转成单色位图，直接导出 `unsigned char[] PROGMEM` 数组或 `.raw` 二进制，供 ESP32 / OLED / TFT 这类小屏使用。

纯前端、单页、离线可用：双击 `index.html` 即可，不需要构建、不需要联网。

## 功能

### 图片
- 单张 / 多选批量（多文件即进批量），ZIP 压缩包批量导入（按文件名排序，失败项跳过）
- 每张图独立保存自己的参数，翻页不丢
- 框选裁剪（1:1 / 原图比例锁定，可拖动、改边）
- 目标尺寸 1~1024，尺寸预设 + 原图比例一键

### 视频
- 逐帧抓取，可选 1/5/10/24/30 fps
- 框选裁剪局部（按实际显示尺寸换算，不会错位）
- 去重帧、按帧数分卷打包 ZIP
- 导出中可随时终止，不会卡死
- 抓帧方式二选一：**精确**（逐帧 seek，可复现）／**快速**（按播放呈现的帧取帧，1080p 实测 7×，但每次输出会有细微差异，不用于需要版本一致的资产）

### 手绘
- 逐格绘制、橡皮、清空、笔触大小；支持触屏（pointer 事件）
- 改画布尺寸保留已有内容

### 艺术字（文字层）
一行文字直接变成 1bpp 资产，专治"小尺寸汉字糊成一团"：

- **逐字渲染 → 量墨迹框 → 紧凑排布**：只留墨迹、丢掉字框留白，字距可自动
- **超采样后再二值化**：直接以目标字号 `fillText` 会被字体 hinting 扭形
  （16px「术」与 16× 参考的 IoU 只有 **0.36**，t±16 翻转率 14%）；超采样后面积平均
  把 IoU 拉到 **0.91~1.00**、翻转率降到 3~8%。倍率按尺寸自适应：≤32px 用 8×，更大的用 4×
- **按字框（em）归一化，不按墨迹高度**：按墨迹拉伸会让「口」被放大、「日」被缩小，
  同一串字里笔画粗细就不一致了
- **基线量化**：ascent / descent 先各自取整再定字形画布高度，混排时下沿严格落在基线上
  （注意「口」在雅黑里本身就比基线低 2px —— 那是字体设计，不是 bug）
- 宽度向上对齐到 8 的倍数，四种布局都能整字节落位；白字黑底（置位 = 亮），可反色
- 默认字号 24，范围 8~256；只支持浏览器（要系统字体），CLI 不提供文字层

### 二值化
- 阈值类型：RGB 平均 / 亮度（感知亮度）/ RGB 独立区间
- **自动阈值**：Otsu 按当前图的直方图取分割点
- **抖动**：Floyd–Steinberg 误差扩散、Bayer 4×4、Bayer 8×8（保色调，灰阶过渡不生硬）
- **降采样**：单次 `imageSmoothingQuality='high'`（Chromium 里就是面积平均，1px 棋盘缩 60:1 后 std=0）。
  曾经写过逐级 2:1 折半，实测与单次结果逐字节相同（非整数比只差 0.3~2.0/255），已删除；
  真正的坑是预览用的临时 canvas 关着平滑，退化成最近邻会把 2px 细线整根吃掉
- 反转黑白

### 输出格式（同一张图，四种落位）
| 格式 | 每字节含 | 索引公式 | 对应设备 |
|---|---|---|---|
| 行优先 MSB（默认） | 8 个水平像素 | `y*ceil(W/8) + (x>>3)`，bit = `7-(x&7)` | Adafruit_GFX `drawBitmap()`、U8g2 `drawXBMP()` |
| 行优先 LSB | 8 个水平像素 | 同上，bit = `x&7` | 老控制器 / ST7920 类 |
| 页模式 LSB | 8 个垂直像素 | `(y>>3)*W + x`，bit = `y&7` | SSD1306 / SH1106 全屏缓冲（按 8 行一页） |
| 列优先 LSB | 8 个垂直像素 | `x*ceil(H/8) + (y>>3)`，bit = `y&7` | 竖排缓冲 / 列字节点阵 |

宽高不是 8 的倍数时按整字节导出、末尾补 0；页模式高度不足 8 的倍数仍按 `ceil(H/8)` 整页输出。

### 导出
- C 数组：自定义文件名 / 数组名 / 宽高变量名；源码顶部注释标出布局、尺寸与字节数
- `.raw`：12 字节小端头（帧数 / 帧率 / 宽 / 高）+ 所选格式的位图数据
- 一键复制源码

### 反导入校验
- 把 `.raw` 或粘贴的 `0xNN` 字节流读回来直接预览（多帧可翻页）
- `.raw` 自动读头；裸字节流填宽高 + 选格式
- 格式选错时长度不符会明确报错，长度恰好相同也会在预览里立刻错位——不靠猜

### 自检接口
控制台执行：

- `bitmapSelfTest()`：对 8 种尺寸（含 1×1、37×23、64×9）× 5 种图案 × 4 种布局做
  `encode → decode` 逐字节往返与跨格式等价断言，当前 **167 例**全过
- `textLayerSelfTest()`：文字层的排版不变量（宽度 8 对齐、字间空白列、基线一致、
  反色互补、阈值单调、四布局字节数、渲染确定性），当前 **13 例**全过。
  断言的是不变量而不是某个字形像素——字形随系统字体变，不变量不该变

## API 与命令行

页面里暴露 `window.toBitMap`（纯计算，不碰 DOM），命令行用同一份核心：

```js
const api = window.toBitMap;
api.layouts();                        // 四种布局的自描述元数据
api.encodeCanvas(canvas, { width: 128, height: 64, layout: 'page_lsb' }); // 取源+降采样+二值化+打包
api.encode(imageData, { layout: 'row_msb', threshold: 128, dither: 'bayer8' });
api.decode(bytes, { width: 128, height: 64, layout: 'page_lsb' });        // -> 权威缓冲
api.encodeCanonical(canonical, { width, height, layout });               // 布局互转，不重新二值化
api.toCHeader(bytes, { width, height, layout, arrayName: 'logo_bits' });
api.packRaw(frames, { width, height, layout, fps: 10 });                 // 12 字节头 + 帧
api.parseRaw(rawBytes, { layout: 'page_lsb' });
api.selfTest();                                                          // 167 例往返断言
```

```bash
node cli.mjs --self-test                       # 在 node 里跑同一套预言机
node cli.mjs --layouts
node cli.mjs --in logo.raw --out logo_page.raw --to page_lsb --from row_msb
node cli.mjs --in logo.raw --c-header logo.h --layout page_lsb --array logo_bits
```

`cli.mjs` 用 `node:vm` 加载 `script.js`，不复制实现。之所以不抽 ESM：ES module 在 `file://` 下会被 CORS 拦，
而「双击 index.html 就能用」是这个工具的硬约束。纯计算层不加 DOM 依赖，页面与命令行永远同步。

## 使用

直接打开 `index.html`。若浏览器限制本地文件，可起个静态服务器：

```bash
python -m http.server 8000
# 或
npx serve .
```

## 项目结构

| 文件 | 说明 |
|---|---|
| `index.html` | 页面结构 |
| `style.css` | 排版与状态样式 |
| `script.js` | 全部逻辑：位图管线 / 打包 / 导出 |
| `cli.mjs` | 命令行：vm 加载同一份核心，做 .raw 布局互转 / 出 C 头文件 / 跑自检 |
| `vendor/jszip.min.js` | 本地化的 JSZip 3.10.1（ZIP 导入导出用，离线不依赖 CDN） |

关键函数：`binarizeImageData()`（阈值 + 抖动）、`packBitmapBytes()`（唯一二值化 → 权威缓冲）、
`transferBits()`（唯一布局搬运，encode/decode 共用同一组位置公式）、`encodeBitmap()` / `decodeBitmap()`、
`formatCHeader()`（唯一 C 源码格式化）、`drawSourceDownscaled()`（唯一取源+降采样入口）、`runBitmapSelfTest()`（回归预言机）。

新增输出格式只需在 `BITMAP_LAYOUTS` 里加一项（`axis` + `bitOrder`），不要另写循环。

## 开源协议

自定义协议：

- ✅ 免费自用
- ❌ 禁止商用
- 📝 转载请注明原作者

## 作者信息

- **原作者**：栢爅
- **GitHub**：[LSXIFU](https://github.com/LSXIFU)
- **哔哩哔哩UID**：402603542
- **版本**：1.7
- **制作工具**：Trae IDE AI 工具
- **首版发布**：2026/3/8

## 致谢

感谢使用本工具，觉得有用欢迎 Star。
