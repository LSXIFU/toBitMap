/*
========================================
工具原作者：栢爅
Github：LSXIFU
哔哩哔哩UID：402603542
版本：1.6 | 使用Trae IDE AI工具制作 | 2026/3/8 | 免费自用、不允许商用 | 使用请注明原作者
优化内容：GPU加速、内存管理优化、Web Worker支持
========================================
*/

const AppConfig = {
    maxPreviewSize: 800,
    maxCanvasSize: 400,
    defaultSize: 32,
    canvasPoolSize: 4,
    // 小位图放大上限：16x16 原来只有 160px，看不清也画不准
    maxPreviewZoom: 24,
    maxBitmapSize: 1024,
    // WebGL 分支在小位图上是负优化（readPixels 同步回读 + 逐像素翻 Y），且与 CPU 语义长期分歧。
    // 保留实现供 A/B，默认关闭；抖动/自动阈值只能走 CPU。
    useWebGL: false
};

const modeStates = {
    image: {
        fileName: 'image',
        arrayName: 'image_bits',
        widthVar: 'WIDTH',
        heightVar: 'HEIGHT',
        resultCode: '',
        originalSize: { width: 0, height: 0 },
        isRatioLocked: false,
        isOriginalRatioLocked: false,
        selectionStart: { x: 0, y: 0 },
        selectionEnd: { x: 0, y: 0 }
    },
    video: {
        fileName: 'video',
        arrayName: 'image_bits',
        widthVar: 'WIDTH',
        heightVar: 'HEIGHT',
        resultCode: '',
        originalSize: { width: 0, height: 0 },
        isRatioLocked: false,
        isOriginalRatioLocked: false,
        selectionStart: { x: 0, y: 0 },
        selectionEnd: { x: 0, y: 0 }
    },
    text: {
        fileName: 'text',
        arrayName: 'text_bits',
        widthVar: 'WIDTH',
        heightVar: 'HEIGHT',
        resultCode: ''
    },
    draw: {
        fileName: 'drawing',
        arrayName: 'image_bits',
        widthVar: 'WIDTH',
        heightVar: 'HEIGHT',
        resultCode: ''
    }
};

let activeMode = 'image';
let isVideoExporting = false;
let cancelVideoExport = false;
let batchImages = [];
let currentBatchIndex = 0;
let imageSettings = [];
let isSelecting = false;
let isResizing = false;
let isDragging = false;
let resizeHandle = null;
let dragOffset = { x: 0, y: 0 };
let lastFrameTime = 0;
let currentVideoBlobUrl = null;
let drawMode = true;
let brushSize = 1;
let drawCanvas = null;
let drawCtx = null;
let isDrawing = false;
let imageAspectRatioObj = null;
let videoAspectRatioObj = null;
let isRawExporting = false;
let cancelRawExport = false;

// 阈值类型 → 着色器分支索引。UI 传 'brightness'，历史代码里写作 'luminance'，两者同义。
// 未知类型一律回落到亮度分支，与 CPU 路径（binarizeImageData 的 else）保持一致。
const THRESHOLD_TYPE_INDEX = { rgb: 0, brightness: 1, luminance: 1, individual: 2 };

// 批量导入时认定哪些压缩包条目是图片
const IMAGE_EXTENSION = /\.(jpe?g|png|gif|bmp|webp)$/i;

function thresholdTypeToIndex(thresholdType) {
    const index = THRESHOLD_TYPE_INDEX[thresholdType];
    return index === undefined ? 1 : index;
}

// 抖动矩阵：Bayer 由 1×1 递归生成（M2n = [[4Mn, 4Mn+2], [4Mn+3, 4Mn+1]]）
function buildBayerMatrix(order) {
    let matrix = [[0]];
    let size = 1;
    while (size < order) {
        const next = [];
        for (let y = 0; y < size * 2; y++) next.push(new Array(size * 2));
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const v = matrix[y][x] * 4;
                next[y][x] = v;
                next[y][x + size] = v + 2;
                next[y + size][x] = v + 3;
                next[y + size][x + size] = v + 1;
            }
        }
        matrix = next;
        size *= 2;
    }
    return matrix;
}

const BAYER_4 = buildBayerMatrix(4);
const BAYER_8 = buildBayerMatrix(8);

// 把三种阈值类型统一成「每像素一个 0~255 度量值」：
//   rgb        = (R+G+B)/3
//   brightness = 0.299R + 0.587G + 0.114B
//   individual = 三通道区间掩码的均值（0 / 85 / 170 / 255）
function buildMetricValues(imageData, thresholdType, rgbThresholds) {
    const data = imageData.data;
    const values = new Float32Array(data.length / 4);
    
    if (thresholdType === 'individual') {
        const redMin = parseInt(rgbThresholds.redMin);
        const redMax = parseInt(rgbThresholds.redMax);
        const greenMin = parseInt(rgbThresholds.greenMin);
        const greenMax = parseInt(rgbThresholds.greenMax);
        const blueMin = parseInt(rgbThresholds.blueMin);
        const blueMax = parseInt(rgbThresholds.blueMax);
        
        for (let p = 0, i = 0; i < data.length; i += 4, p++) {
            const r = (data[i] >= redMin && data[i] <= redMax) ? 1 : 0;
            const g = (data[i + 1] >= greenMin && data[i + 1] <= greenMax) ? 1 : 0;
            const b = (data[i + 2] >= blueMin && data[i + 2] <= blueMax) ? 1 : 0;
            values[p] = ((r + g + b) / 3) * 255;
        }
        return values;
    }
    
    const useLuminance = thresholdType !== 'rgb';
    for (let p = 0, i = 0; i < data.length; i += 4, p++) {
        values[p] = useLuminance
            ? 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
            : (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    return values;
}

// 二值化。CPU 是唯一权威实现（与 GPU 分支曾长期不一致，见笔记）。
// dither: 'none' | 'floyd' | 'bayer4' | 'bayer8'
// 有序抖动把阈值中心当作亮度偏置，滑杆依然有效（128 = 经典 Bayer 观感）。
function binarizeImageData(imageData, thresholdType, threshold, rgbThresholds, invert, dither) {
    const width = imageData.width;
    const height = imageData.height;
    const values = buildMetricValues(imageData, thresholdType, rgbThresholds);
    const out = new Uint8ClampedArray(values.length * 4);
    
    if (dither === 'bayer4' || dither === 'bayer8') {
        const matrix = dither === 'bayer4' ? BAYER_4 : BAYER_8;
        const n = matrix.length;
        const unit = 255 / (n * n);
        const bias = threshold - 128;
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = y * width + x;
                const limit = (matrix[y % n][x % n] + 0.5) * unit;
                let on = values[p] + bias > limit;
                if (invert) on = !on;
                const v = on ? 255 : 0;
                const o = p * 4;
                out[o] = v;
                out[o + 1] = v;
                out[o + 2] = v;
                out[o + 3] = 255;
            }
        }
        return new ImageData(out, width, height);
    }
    
    if (dither === 'floyd') {
        const buf = Float32Array.from(values);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = y * width + x;
                const oldValue = buf[p];
                const newValue = oldValue < threshold ? 0 : 255;
                const error = oldValue - newValue;
                buf[p] = newValue;
                
                if (x + 1 < width) buf[p + 1] += error * (7 / 16);
                if (y + 1 < height) {
                    if (x > 0) buf[p + width - 1] += error * (3 / 16);
                    buf[p + width] += error * (5 / 16);
                    if (x + 1 < width) buf[p + width + 1] += error * (1 / 16);
                }
            }
        }
        for (let p = 0; p < buf.length; p++) {
            let on = buf[p] >= 128;
            if (invert) on = !on;
            const v = on ? 255 : 0;
            const o = p * 4;
            out[o] = v;
            out[o + 1] = v;
            out[o + 2] = v;
            out[o + 3] = 255;
        }
        return new ImageData(out, width, height);
    }
    
    for (let p = 0, o = 0; p < values.length; p++, o += 4) {
        let on = values[p] >= threshold;
        if (invert) on = !on;
        const v = on ? 255 : 0;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
    }
    return new ImageData(out, width, height);
}

// Otsu 最大类间方差阈值：省掉手动试 128
function computeOtsuThreshold(imageData, thresholdType, rgbThresholds) {
    const values = buildMetricValues(imageData, thresholdType, rgbThresholds);
    const histogram = new Uint32Array(256);
    
    for (let i = 0; i < values.length; i++) {
        const bin = Math.max(0, Math.min(255, Math.round(values[i])));
        histogram[bin]++;
    }
    
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * histogram[i];
    
    let sumB = 0;
    let weightB = 0;
    let bestVariance = -1;
    let bestLow = 128;
    let bestHigh = 128;
    
    for (let t = 0; t < 256; t++) {
        weightB += histogram[t];
        if (weightB === 0) continue;
        
        const weightF = total - weightB;
        if (weightF === 0) break;
        
        sumB += t * histogram[t];
        const meanB = sumB / weightB;
        const meanF = (sum - sumB) / weightF;
        const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
        
        if (variance > bestVariance) {
            bestVariance = variance;
            bestLow = t;
            bestHigh = t;
        } else if (variance === bestVariance) {
            bestHigh = t;
        }
    }
    
    // 纯双峰图（如纯黑白 logo）所有 t 的类间方差完全相同，取并列区间中点；
    // 取第一项会得到 0，而二值化用 >= 比较，阈值 0 等于全白。
    return Math.round((bestLow + bestHigh) / 2);
}

class CanvasPool {
    constructor(size = 4) {
        this.pool = [];
        this.maxSize = size;
        for (let i = 0; i < size; i++) {
            this.pool.push({
                canvas: document.createElement('canvas'),
                ctx: null,
                inUse: false,
                width: 0,
                height: 0
            });
            this.pool[i].ctx = this.pool[i].canvas.getContext('2d', { willReadFrequently: true });
        }
    }
    
    acquire(width, height) {
        for (let item of this.pool) {
            if (!item.inUse) {
                item.inUse = true;
                if (item.width !== width || item.height !== height) {
                    item.canvas.width = width;
                    item.canvas.height = height;
                    item.width = width;
                    item.height = height;
                }
                item.ctx.imageSmoothingEnabled = false;
                return item;
            }
        }
        const newItem = {
            canvas: document.createElement('canvas'),
            ctx: null,
            inUse: true,
            width: width,
            height: height
        };
        newItem.canvas.width = width;
        newItem.canvas.height = height;
        newItem.ctx = newItem.canvas.getContext('2d', { willReadFrequently: true });
        newItem.ctx.imageSmoothingEnabled = false;
        this.pool.push(newItem);
        return newItem;
    }
    
    release(item) {
        if (item) {
            item.inUse = false;
        }
    }
    
    // 保证归还：中途抛异常也不会把 item 永久锁在 inUse 状态
    withCanvas(width, height, fn) {
        const item = this.acquire(width, height);
        try {
            return fn(item);
        } finally {
            this.release(item);
        }
    }
    
    // 清掉所有占用标记（导出被中断后残留的锁）
    releaseAll() {
        for (let item of this.pool) {
            item.inUse = false;
        }
    }
    
    clear() {
        for (let item of this.pool) {
            item.ctx.clearRect(0, 0, item.canvas.width, item.canvas.height);
        }
    }
}

class WebGLImageProcessor {
    constructor() {
        this.gl = null;
        this.programs = {};
        this.textures = new Map();
        this.framebuffers = new Map();
        this.initialized = false;
        this.init();
    }
    
    init() {
        const canvas = document.createElement('canvas');
        this.gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!this.gl) {
            console.warn('WebGL not supported, falling back to CPU');
            return;
        }
        this.initialized = true;
        this._initShaders();
    }
    
    _initShaders() {
        const gl = this.gl;
        
        const binaryVertexShader = `
            attribute vec2 a_position;
            attribute vec2 a_texCoord;
            varying vec2 v_texCoord;
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                v_texCoord = a_texCoord;
            }
        `;
        
        const binaryFragmentShader = `
            precision mediump float;
            uniform sampler2D u_image;
            uniform float u_threshold;
            uniform int u_thresholdType;
            uniform float u_redMin;
            uniform float u_redMax;
            uniform float u_greenMin;
            uniform float u_greenMax;
            uniform float u_blueMin;
            uniform float u_blueMax;
            uniform bool u_invert;
            varying vec2 v_texCoord;
            
            void main() {
                vec4 color = texture2D(u_image, v_texCoord);
                float value;
                
                if (u_thresholdType == 0) {
                    value = (color.r + color.g + color.b) / 3.0;
                } else if (u_thresholdType == 1) {
                    value = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
                } else {
                    float r = (color.r >= u_redMin && color.r <= u_redMax) ? 1.0 : 0.0;
                    float g = (color.g >= u_greenMin && color.g <= u_greenMax) ? 1.0 : 0.0;
                    float b = (color.b >= u_blueMin && color.b <= u_blueMax) ? 1.0 : 0.0;
                    value = (r + g + b) / 3.0;
                }
                
                float binary = value < u_threshold ? 0.0 : 1.0;
                if (u_invert) binary = 1.0 - binary;
                
                gl_FragColor = vec4(binary, binary, binary, 1.0);
            }
        `;
        
        this.programs.binary = this._createProgram(binaryVertexShader, binaryFragmentShader);
    }
    
    _createProgram(vertexSrc, fragmentSrc) {
        const gl = this.gl;
        
        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, vertexSrc);
        gl.compileShader(vertexShader);
        
        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, fragmentSrc);
        gl.compileShader(fragmentShader);
        
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        
        return program;
    }
    
    processBinary(imageData, thresholdType, threshold, rgbThresholds, invert) {
        if (!this.initialized) {
            return binarizeImageData(imageData, thresholdType, threshold, rgbThresholds, invert, 'none');
        }
        
        const gl = this.gl;
        const width = imageData.width;
        const height = imageData.height;
        
        if (gl.canvas.width !== width || gl.canvas.height !== height) {
            gl.canvas.width = width;
            gl.canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        
        const resources = this._ensureResources();
        const program = this.programs.binary;
        gl.useProgram(program);
        
        gl.bindTexture(gl.TEXTURE_2D, resources.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, resources.positionBuffer);
        gl.enableVertexAttribArray(resources.positionLoc);
        gl.vertexAttribPointer(resources.positionLoc, 2, gl.FLOAT, false, 0, 0);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, resources.texCoordBuffer);
        gl.enableVertexAttribArray(resources.texCoordLoc);
        gl.vertexAttribPointer(resources.texCoordLoc, 2, gl.FLOAT, false, 0, 0);
        
        const u = resources.uniforms;
        gl.uniform1i(u.image, 0);
        gl.uniform1f(u.threshold, threshold / 255);
        gl.uniform1i(u.thresholdType, thresholdTypeToIndex(thresholdType));
        gl.uniform1f(u.redMin, parseInt(rgbThresholds.redMin) / 255);
        gl.uniform1f(u.redMax, parseInt(rgbThresholds.redMax) / 255);
        gl.uniform1f(u.greenMin, parseInt(rgbThresholds.greenMin) / 255);
        gl.uniform1f(u.greenMax, parseInt(rgbThresholds.greenMax) / 255);
        gl.uniform1f(u.blueMin, parseInt(rgbThresholds.blueMin) / 255);
        gl.uniform1f(u.blueMax, parseInt(rgbThresholds.blueMax) / 255);
        gl.uniform1i(u.invert, invert ? 1 : 0);
        
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        
        // 纹理坐标与 clip 空间同向（v=0 在 y=-1），readPixels 第一行就是图像顶行，
        // 不需要再翻一次 —— 原来着色器翻一次、JS 再逐像素翻一次，白算 O(w*h)。
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        
        return new ImageData(new Uint8ClampedArray(pixels.buffer), width, height);
    }
    
    // 纹理、顶点缓冲、uniform 位置只在首次使用时创建，别每次调用都 new + delete
    _ensureResources() {
        if (this._resources) return this._resources;
        
        const gl = this.gl;
        const program = this.programs.binary;
        
        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 1, -1, -1, 1,
            -1, 1, 1, -1, 1, 1
        ]), gl.STATIC_DRAW);
        
        const texCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0, 0, 1, 0, 0, 1,
            0, 1, 1, 0, 1, 1
        ]), gl.STATIC_DRAW);
        
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        
        this._resources = {
            positionBuffer: positionBuffer,
            texCoordBuffer: texCoordBuffer,
            texture: texture,
            positionLoc: gl.getAttribLocation(program, 'a_position'),
            texCoordLoc: gl.getAttribLocation(program, 'a_texCoord'),
            uniforms: {
                image: gl.getUniformLocation(program, 'u_image'),
                threshold: gl.getUniformLocation(program, 'u_threshold'),
                thresholdType: gl.getUniformLocation(program, 'u_thresholdType'),
                redMin: gl.getUniformLocation(program, 'u_redMin'),
                redMax: gl.getUniformLocation(program, 'u_redMax'),
                greenMin: gl.getUniformLocation(program, 'u_greenMin'),
                greenMax: gl.getUniformLocation(program, 'u_greenMax'),
                blueMin: gl.getUniformLocation(program, 'u_blueMin'),
                blueMax: gl.getUniformLocation(program, 'u_blueMax'),
                invert: gl.getUniformLocation(program, 'u_invert')
            }
        };
        
        return this._resources;
    }
    
    isAvailable() {
        return this.initialized;
    }
}

let canvasPool = null;
let glProcessor = null;
let currentImage = null;
let currentVideo = null;
let rafId = null;
let pendingProcess = null;


// ===== 位图布局（同一张图的多种落位方式）=====
// 权威表示：逻辑位图 B[y][x]，1 = 置位（亮）。所有输出格式都只是它的不同落位，
// 用 (axis, bitOrder) 两个参数描述，不为每种格式写一份循环：
//   row  -> 每字节 8 个水平像素，外层按行：y*ceil(W/8) + (x>>3)
//   page -> 每字节 8 个垂直像素，外层按页：(y>>3)*W + x      （SSD1306 GDDRAM 页结构）
//   col  -> 每字节 8 个垂直像素，外层按列：x*ceil(H/8) + (y>>3)
// page 与 col 的字节内部构造完全相同（8 竖像素 + LSB 在顶），只差外层遍历顺序。
const BITMAP_LAYOUTS = {
    row_msb: { axis: 'row', bitOrder: 'msb', label: '行优先 MSB', hint: 'Adafruit_GFX / U8g2 drawXBMP' },
    row_lsb: { axis: 'row', bitOrder: 'lsb', label: '行优先 LSB', hint: '老控制器 / ST7920 类' },
    page_lsb: { axis: 'page', bitOrder: 'lsb', label: '页模式 LSB', hint: 'SSD1306 / SH1106 全屏缓冲' },
    col_lsb: { axis: 'col', bitOrder: 'lsb', label: '列优先 LSB', hint: '竖排缓冲 / 列字节点阵' }
};

const DEFAULT_LAYOUT = 'row_msb';

function getLayout(layoutId) {
    return BITMAP_LAYOUTS[layoutId] || BITMAP_LAYOUTS[DEFAULT_LAYOUT];
}

// 导出用：读到什么用什么，读到脏值回落默认布局，绝不静默落到别的格式
function getOutputLayout() {
    const select = document.getElementById('output-format');
    if (select && BITMAP_LAYOUTS[select.value]) return select.value;
    return DEFAULT_LAYOUT;
}

// 权威缓冲（行优先 MSB）的字节数
function canonicalBufferSize(width, height) {
    return Math.ceil(width / 8) * height;
}

// 指定布局的字节数：row -> H*ceil(W/8)；page -> ceil(H/8)*W；col -> W*ceil(H/8)
function layoutBufferSize(width, height, layoutId) {
    const axis = getLayout(layoutId).axis;
    const hBytes = Math.ceil(width / 8);
    const vBytes = Math.ceil(height / 8);
    if (axis === 'row') return hBytes * height;
    if (axis === 'page') return vBytes * width;
    return width * vBytes;
}

// 位搬运的唯一实现。srcIsCanonical = true 时把权威缓冲铺进目标布局（encode），
// false 时把目标布局解回权威缓冲（decode）。两个方向共用同一组位置公式，改布局只改这里。
// padding 位永远保持 0：只有「有意义的位」被搬运。
function transferBits(src, width, height, layoutId, srcIsCanonical) {
    const layout = getLayout(layoutId);
    const hBytes = Math.ceil(width / 8);
    const vBytes = Math.ceil(height / 8);
    const msb = layout.bitOrder === 'msb';
    const out = new Uint8Array(
        srcIsCanonical ? layoutBufferSize(width, height, layoutId) : hBytes * height
    );

    for (let y = 0; y < height; y++) {
        const rowBase = y * hBytes;
        const vPage = y >> 3;
        const vBit = msb ? 7 - (y & 7) : (y & 7);

        for (let x = 0; x < width; x++) {
            const cIndex = rowBase + (x >> 3);
            const cBit = 7 - (x & 7);
            let index = cIndex;
            let bit = msb ? 7 - (x & 7) : (x & 7);

            if (layout.axis === 'page') {
                index = vPage * width + x;
                bit = vBit;
            } else if (layout.axis === 'col') {
                index = x * vBytes + vPage;
                bit = vBit;
            }

            if (srcIsCanonical) {
                if (!((src[cIndex] >> cBit) & 1)) continue;
                out[index] |= 1 << bit;
            } else {
                if (!((src[index] >> bit) & 1)) continue;
                out[cIndex] |= 1 << cBit;
            }
        }
    }

    return out;
}

// 图像 -> 指定布局位流。二值化只发生在 packBitmapBytes（权威缓冲）里，一次。
function encodeBitmap(imageData, layoutId) {
    const canonical = packBitmapBytes(imageData);
    if (!layoutId || layoutId === DEFAULT_LAYOUT) return canonical;
    return transferBits(canonical, imageData.width, imageData.height, layoutId, true);
}

// 位流 -> 权威缓冲（反导入用）。长度不足按 0 补齐，超长部分忽略。
function decodeBitmap(bytes, width, height, layoutId) {
    const expected = layoutBufferSize(width, height, layoutId);
    let source = bytes;
    if (bytes.length !== expected) {
        source = new Uint8Array(expected);
        source.set(bytes.subarray(0, Math.min(bytes.length, expected)));
    }
    if (!layoutId || layoutId === DEFAULT_LAYOUT) {
        const out = new Uint8Array(canonicalBufferSize(width, height));
        out.set(source.subarray(0, Math.min(source.length, out.length)));
        return out;
    }
    return transferBits(source, width, height, layoutId, false);
}

// 权威缓冲 -> 可画的 ImageData（1 = 白 = 置位）
function canonicalToImageData(canonical, width, height) {
    const imageData = new ImageData(width, height);
    const data = imageData.data;
    const hBytes = Math.ceil(width / 8);

    for (let y = 0; y < height; y++) {
        const rowBase = y * hBytes;
        for (let x = 0; x < width; x++) {
            const on = (canonical[rowBase + (x >> 3)] >> (7 - (x & 7))) & 1;
            const value = on ? 255 : 0;
            const offset = (y * width + x) * 4;
            data[offset] = value;
            data[offset + 1] = value;
            data[offset + 2] = value;
            data[offset + 3] = 255;
        }
    }

    return imageData;
}

function reverseBits(byte) {
    let result = 0;
    for (let i = 0; i < 8; i++) {
        result = (result << 1) | ((byte >> i) & 1);
    }
    return result;
}

// 唯一的二值化实现：图像 -> 权威缓冲（行优先 MSB）。布局落位在 transferBits 里做。
// reverseBitOrder 是历史兼容参数（等价 row_lsb）；新代码走 encodeBitmap(imageData, layoutId)。
function packBitmapBytes(imageData, reverseBitOrder = false) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    const bytesPerRow = Math.ceil(width / 8);
    const bytes = new Uint8Array(bytesPerRow * height);
    let offset = 0;
    
    for (let y = 0; y < height; y++) {
        const rowBase = y * width;
        for (let rowByte = 0; rowByte < bytesPerRow; rowByte++) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit++) {
                const x = rowByte * 8 + bit;
                if (x >= width) break;
                if (data[(rowBase + x) * 4] > 128) {
                    byte |= 1 << (7 - bit);
                }
            }
            bytes[offset++] = reverseBitOrder ? reverseBits(byte) : byte;
        }
    }
    
    return bytes;
}

// 唯一的 C 源码格式化实现
function formatCHeader(bytes, options) {
    const { width, height, arrayName, widthVar, heightVar } = options;
    const lines = [];
    
    if (options.layoutId) {
        const layout = getLayout(options.layoutId);
        lines.push(`// layout: ${layout.label} (${layout.hint}) ${width}x${height} ${bytes.length}B`);
    }
    lines.push(`#define ${widthVar.toUpperCase()} ${width}`);
    lines.push(`#define ${heightVar.toUpperCase()} ${height}`);
    lines.push(`static const unsigned char ${arrayName}[] PROGMEM = {`);
    
    for (let i = 0; i < bytes.length; i += 8) {
        const chunk = [];
        for (let j = i; j < i + 8 && j < bytes.length; j++) {
            chunk.push('0x' + bytes[j].toString(16).padStart(2, '0'));
        }
        lines.push('  ' + chunk.join(', '));
    }
    
    lines.push('};');
    return lines.join('\n');
}

function generateRawFilename(baseName, width, height, fps, totalFrames) {
    return `${baseName}_${String(width).padStart(3, '0')}${String(height).padStart(3, '0')}_${fps}_${totalFrames}.raw`;
}

function packRawHeader(totalFrames, fps, width, height) {
    const buffer = new ArrayBuffer(12);
    const view = new DataView(buffer);
    view.setUint32(0, totalFrames, true);
    view.setUint32(4, fps, true);
    view.setUint16(8, width, true);
    view.setUint16(10, height, true);
    return new Uint8Array(buffer);
}

// 逐帧抓取靠 seeked 事件推进。目标时间与当前位置相同（首帧必然是 0）或越界被夹回原值时，
// 浏览器不会派发 seeked，整条导出链会原地挂死。这里统一包装成「一定回调一次」。
function seekFrame(video, time, onSeeked) {
    let settled = false;
    
    const handler = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener('seeked', handler);
        onSeeked();
    };
    
    video.addEventListener('seeked', handler);
    
    const before = video.currentTime;
    video.currentTime = time;
    
    if (!video.seeking && Math.abs(video.currentTime - before) < 1e-6) {
        // 位置没变 → 不会有 seeked，直接抓当前帧
        queueMicrotask(handler);
    }
}

function isExportingFrames() {
    return isVideoExporting || isRawExporting;
}

function init() {
    canvasPool = new CanvasPool(AppConfig.canvasPoolSize);
    glProcessor = new WebGLImageProcessor();
    
    drawCanvas = document.getElementById('draw-canvas');
    drawCtx = drawCanvas.getContext('2d', { willReadFrequently: true });
    
    setupTabs();
    setupEventListeners();
    setupDrawCanvas();
    setupTextLayer();
}

// 首屏给个默认样张，不然艺术字页是空的
function setupTextLayer() {
    if (!getElement('text-content')) return;
    processTextTab();
}

function getElement(id) {
    return document.getElementById(id);
}

function getElements(selector) {
    return document.querySelectorAll(selector);
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function setupDropArea(dropAreaId, inputId, handleUpload) {
    const dropArea = getElement(dropAreaId);
    const input = getElement(inputId);
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, preventDefaults, false);
    });
    
    ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => {
            dropArea.classList.add('drag-over');
        }, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => {
            dropArea.classList.remove('drag-over');
        }, false);
    });
    
    dropArea.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        input.files = files;
        handleUpload({ target: input });
    }, false);
}

function setupTabs() {
    const tabBtns = getElements('.tab-btn');
    const tabContents = getElements('.tab-content');
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            
            modeStates[activeMode].resultCode = getElement('result-code').textContent;
            modeStates[activeMode].fileName = getElement('file-name').value || modeStates[activeMode].fileName;
            modeStates[activeMode].arrayName = getElement('array-name').value || 'image_bits';
            modeStates[activeMode].widthVar = getElement('width-var').value || 'WIDTH';
            modeStates[activeMode].heightVar = getElement('height-var').value || 'HEIGHT';
            
            activeMode = tab;
            
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            getElement(`${tab}-tab`).classList.add('active');
            
            getElement('result-code').textContent = modeStates[activeMode].resultCode;
            getElement('result-stats').textContent = modeStates[activeMode].resultStats || '';
            getElement('file-name').value = modeStates[activeMode].fileName;
            getElement('array-name').value = modeStates[activeMode].arrayName;
            getElement('width-var').value = modeStates[activeMode].widthVar;
            getElement('height-var').value = modeStates[activeMode].heightVar;
        });
    });
}

function setupSizeAdjustment(widthInputId, heightInputId, lockRatioId, processFunc) {
    let aspectRatio = 1;
    let isUpdating = false;
    
    function initAspectRatio() {
        const width = parseInt(getElement(widthInputId).value) || 1;
        const height = parseInt(getElement(heightInputId).value) || 1;
        aspectRatio = width / height;
    }
    
    initAspectRatio();
    
    getElement(widthInputId).addEventListener('input', function() {
        if (isUpdating) return;
        
        const width = parseInt(this.value) || 1;
        
        if (getElement(lockRatioId).checked) {
            isUpdating = true;
            const height = Math.max(1, Math.round(width / aspectRatio));
            getElement(heightInputId).value = height;
            isUpdating = false;
        } else {
            const height = parseInt(getElement(heightInputId).value) || 1;
            aspectRatio = width / height;
        }
        
        scheduleProcess(processFunc);
    });
    
    getElement(heightInputId).addEventListener('input', function() {
        if (isUpdating) return;
        
        const height = parseInt(this.value) || 1;
        
        if (getElement(lockRatioId).checked) {
            isUpdating = true;
            const width = Math.max(1, Math.round(height * aspectRatio));
            getElement(widthInputId).value = width;
            isUpdating = false;
        } else {
            const width = parseInt(getElement(widthInputId).value) || 1;
            aspectRatio = width / height;
        }
        
        scheduleProcess(processFunc);
    });
    
    getElement(lockRatioId).addEventListener('change', function() {
        if (this.checked) {
            initAspectRatio();
        }
    });
    
    // 用访问器暴露内部状态：调用方写 aspectRatioObj.aspectRatio = w/h 必须真正落到闭包里，
    // 否则「锁定比例」一直按初始化时的 32×32 比例换算（上传新图后垂直边算错）。
    return {
        get aspectRatio() {
            return aspectRatio;
        },
        set aspectRatio(value) {
            if (isFinite(value) && value > 0) {
                aspectRatio = value;
            }
        },
        get isUpdating() {
            return isUpdating;
        },
        set isUpdating(value) {
            isUpdating = Boolean(value);
        },
        initAspectRatio
    };
}

// 源素材换新后，若勾着「锁定比例」，用新素材的长宽比校正短边（保持当前宽度）
function applyLockedRatio(mode, widthInputId, heightInputId, lockRatioId) {
    if (!getElement(lockRatioId).checked) return;
    
    const size = modeStates[mode].originalSize;
    if (!size.width || !size.height) return;
    
    const width = parseInt(getElement(widthInputId).value) || AppConfig.defaultSize;
    const height = Math.max(1, Math.round((width * size.height) / size.width));
    getElement(heightInputId).value = height;
}

function scheduleProcess(processFunc) {
    if (rafId) {
        cancelAnimationFrame(rafId);
    }
    rafId = requestAnimationFrame(() => {
        rafId = null;
        processFunc();
    });
}

function setupSizeButtons(selector, widthInputId, heightInputId, aspectRatioObj, processFunc) {
    getElements(selector).forEach(btn => {
        btn.addEventListener('click', function() {
            const width = parseInt(this.dataset.width);
            const height = parseInt(this.dataset.height);
            
            if (width && height) {
                aspectRatioObj.isUpdating = true;
                getElement(widthInputId).value = width;
                getElement(heightInputId).value = height;
                aspectRatioObj.isUpdating = false;
                aspectRatioObj.aspectRatio = width / height;
            }
            
            processFunc();
        });
    });
}

function setupOriginalRatioButton(buttonId, widthInputId, heightInputId, aspectRatioObj, mode, processFunc) {
    getElement(buttonId).addEventListener('click', function() {
        const originalSize = modeStates[mode].originalSize;
        if (originalSize.width > 0 && originalSize.height > 0) {
            const originalRatio = originalSize.width / originalSize.height;
            
            const currentWidth = parseInt(getElement(widthInputId).value) || AppConfig.defaultSize;
            const currentHeight = parseInt(getElement(heightInputId).value) || AppConfig.defaultSize;
            const baseSize = Math.max(currentWidth, currentHeight, AppConfig.defaultSize);
            let newWidth, newHeight;
            
            // 长边保持 baseSize，另一边按原图比例推导
            if (originalRatio >= 1) {
                newWidth = baseSize;
                newHeight = Math.round(baseSize / originalRatio);
            } else {
                newHeight = baseSize;
                newWidth = Math.round(baseSize * originalRatio);
            }
            
            newWidth = Math.max(1, newWidth);
            newHeight = Math.max(1, newHeight);
            
            aspectRatioObj.isUpdating = true;
            getElement(widthInputId).value = newWidth;
            getElement(heightInputId).value = newHeight;
            aspectRatioObj.isUpdating = false;
            aspectRatioObj.aspectRatio = originalRatio;
            
            processFunc();
        } else {
            alert('请先上传一个文件');
        }
    });
}

function setupThresholdTypeButtons(selector, thresholdTypeInputId, rgbThresholdsId, singleThresholdId, processFunc) {
    getElements(selector).forEach(btn => {
        btn.addEventListener('click', function() {
            const thresholdType = this.dataset.type;
            
            getElements(selector).forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            getElement(thresholdTypeInputId).value = thresholdType;
            
            const rgbThresholds = getElement(rgbThresholdsId);
            const singleThreshold = getElement(singleThresholdId);
            
            if (thresholdType === 'individual') {
                rgbThresholds.style.display = 'block';
                singleThreshold.style.display = 'none';
            } else {
                rgbThresholds.style.display = 'none';
                singleThreshold.style.display = 'block';
            }
            
            scheduleProcess(processFunc);
        });
    });
}

function setupRGBThresholds(redMinId, redMaxId, greenMinId, greenMaxId, blueMinId, blueMaxId, redMinValueId, redMaxValueId, greenMinValueId, greenMaxValueId, blueMinValueId, blueMaxValueId, processFunc) {
    const inputs = [
        { id: redMinId, valueId: redMinValueId },
        { id: redMaxId, valueId: redMaxValueId },
        { id: greenMinId, valueId: greenMinValueId },
        { id: greenMaxId, valueId: greenMaxValueId },
        { id: blueMinId, valueId: blueMinValueId },
        { id: blueMaxId, valueId: blueMaxValueId }
    ];
    
    inputs.forEach(({ id, valueId }) => {
        getElement(id).addEventListener('input', function() {
            getElement(valueId).textContent = this.value;
            scheduleProcess(processFunc);
        });
    });
}

function processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert, dither) {
    const canUseGL = AppConfig.useWebGL && glProcessor && glProcessor.isAvailable();
    const plainThreshold = !dither || dither === 'none';
    
    if (canUseGL && plainThreshold) {
        return glProcessor.processBinary(imageData, thresholdType, threshold, rgbThresholds, invert);
    }
    return binarizeImageData(imageData, thresholdType, threshold, rgbThresholds, invert, dither);
}

// 位图尺寸夹紧：输入框允许乱填，落到 canvas 前必须夹住（过大直接 OOM/卡死）
function readBitmapSize(elementId) {
    const value = parseInt(getElement(elementId).value);
    if (!isFinite(value) || value < 1) return AppConfig.defaultSize;
    return Math.min(AppConfig.maxBitmapSize, value);
}

// RGB 区间读盘（图片 prefix '' / 视频 prefix 'video-'），原来在 4 处各抄一份
function readRgbThresholds(prefix) {
    return {
        redMin: getElement(prefix + 'red-min').value,
        redMax: getElement(prefix + 'red-max').value,
        greenMin: getElement(prefix + 'green-min').value,
        greenMax: getElement(prefix + 'green-max').value,
        blueMin: getElement(prefix + 'blue-min').value,
        blueMax: getElement(prefix + 'blue-max').value
    };
}

function readDitherMode(prefix) {
    const element = getElement(prefix + 'dither-mode');
    return element ? element.value : 'none';
}

// 按当前设置把源素材渲染成目标尺寸的 ImageData（Otsu 与后续直方图预览共用）
function captureSourceImageData(mode, width, height) {
    return canvasPool.withCanvas(width, height, item => {
        if (mode === 'draw') {
            item.ctx.drawImage(drawCanvas, 0, 0, width, height);
        } else {
            drawSourceIntoCanvas(item.ctx, mode, width, height);
        }
        return item.ctx.getImageData(0, 0, width, height);
    });
}

// 自动阈值：用当前帧/当前图的 Otsu 阈值回填滑杆
function applyAutoThreshold(mode) {
    const isVideo = mode === 'video';
    const prefix = isVideo ? 'video-' : '';
    const width = readBitmapSize(isVideo ? 'video-width' : 'width-input');
    const height = readBitmapSize(isVideo ? 'video-height' : 'height-input');
    
    const imageData = captureSourceImageData(mode, width, height);
    const threshold = computeOtsuThreshold(
        imageData,
        getElement(prefix + 'threshold-type').value,
        readRgbThresholds(isVideo ? 'video-' : '')
    );
    
    const slider = getElement(isVideo ? 'video-threshold' : 'threshold-input');
    slider.value = threshold;
    getElement(isVideo ? 'video-threshold-value' : 'threshold-value').textContent = threshold;
    
    if (isVideo) {
        processVideoFrame();
    } else if (mode === 'draw') {
        processDrawCanvas();
    } else {
        processImage();
    }
}

function calculatePreviewSize(originalWidth, originalHeight, maxSize) {
    let previewWidth, previewHeight;
    if (originalWidth > originalHeight) {
        previewWidth = maxSize;
        previewHeight = (originalHeight / originalWidth) * maxSize;
    } else {
        previewHeight = maxSize;
        previewWidth = (originalWidth / originalHeight) * maxSize;
    }
    return { width: previewWidth, height: previewHeight };
}

// 把「框选框相对预览容器的 CSS 像素」换算成「源素材像素」。
// 预览元素经常被 CSS 缩放（.preview-canvas 的 max-width/max-height、#video-preview 的 max-width），
// 直接拿 CSS 像素当 drawImage 的源矩形，会让裁剪区域整体错位、尺寸按缩放比缩水。
function getSelectionSourceRect(mode) {
    const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
    if (!selectionBox || selectionBox.style.display === 'none') return null;
    
    const preview = mode === 'image' ? getElement('source-preview') : getElement('video-preview');
    if (!preview) return null;
    
    const previewRect = preview.getBoundingClientRect();
    const state = modeStates[mode];
    const sourceWidth = state.originalSize.width;
    const sourceHeight = state.originalSize.height;
    
    if (!previewRect.width || !previewRect.height || !sourceWidth || !sourceHeight) return null;
    
    const containerRect = preview.parentElement.getBoundingClientRect();
    const originX = previewRect.left - containerRect.left;
    const originY = previewRect.top - containerRect.top;
    
    let left = Math.min(state.selectionStart.x, state.selectionEnd.x) - originX;
    let top = Math.min(state.selectionStart.y, state.selectionEnd.y) - originY;
    let right = Math.max(state.selectionStart.x, state.selectionEnd.x) - originX;
    let bottom = Math.max(state.selectionStart.y, state.selectionEnd.y) - originY;
    
    left = Math.max(0, Math.min(left, previewRect.width));
    right = Math.max(0, Math.min(right, previewRect.width));
    top = Math.max(0, Math.min(top, previewRect.height));
    bottom = Math.max(0, Math.min(bottom, previewRect.height));
    
    if (right - left < 1 || bottom - top < 1) return null;
    
    const scaleX = sourceWidth / previewRect.width;
    const scaleY = sourceHeight / previewRect.height;
    
    return {
        x: left * scaleX,
        y: top * scaleY,
        width: (right - left) * scaleX,
        height: (bottom - top) * scaleY
    };
}

// 按当前框选把源素材画进目标 canvas（目标尺寸 = 位图尺寸）

// ===== 降采样 =====
// 唯一取源入口。一次到位用 high-quality 降采样：实测 Chromium 这条路径就是面积平均
// （1px 棋盘缩 60 倍后 std=0、均值 127），手工逐级折半没有收益 —— 整数比下两者逐字节相同，
// 非整数比下平均差 0.3~2.0/255（只是采样网格取整不同），而耗时是本实现的 15 倍。
// 真正的坑只有一个：canvasPool 的临时 canvas 为了预览关了平滑（imageSmoothingEnabled=false），
// 于是 drawImage 退化成最近邻，细线整根消失 —— 所以这里必须显式打开，别依赖池的状态。
function drawSourceDownscaled(ctx, source, crop, targetWidth, targetHeight) {
    const naturalWidth = source.naturalWidth || source.videoWidth || source.width || targetWidth;
    const naturalHeight = source.naturalHeight || source.videoHeight || source.height || targetHeight;
    const sx = crop ? crop.x : 0;
    const sy = crop ? crop.y : 0;
    const sw = crop ? crop.width : naturalWidth;
    const sh = crop ? crop.height : naturalHeight;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
}

function drawSourceIntoCanvas(ctx, mode, width, height) {
    const source = mode === 'image' ? currentImage : getElement('video-preview');
    const crop = getSelectionSourceRect(mode);
    
    ctx.clearRect(0, 0, width, height);
    if (!source) return;
    
    // 降采样统一走分步平均：一次缩太多会被最近邻吃掉细节
    drawSourceDownscaled(ctx, source, crop, width, height);
}

function generateCode(imageData, width, height) {
    const options = {
        width: width,
        height: height,
        arrayName: getElement('array-name').value || 'image_bits',
        widthVar: getElement('width-var').value || 'WIDTH',
        heightVar: getElement('height-var').value || 'HEIGHT'
    };
    
    const fileName = getElement('file-name').value || modeStates[activeMode].fileName;
    
    modeStates[activeMode].fileName = fileName;
    modeStates[activeMode].arrayName = options.arrayName;
    modeStates[activeMode].widthVar = options.widthVar;
    modeStates[activeMode].heightVar = options.heightVar;
    
    options.layoutId = getOutputLayout();
    const code = formatCHeader(encodeBitmap(imageData, options.layoutId), options);
    
    // 内容没变就不碰 DOM：滑杆拖动时每帧重写整段文本会强制重排
    if (code !== modeStates[activeMode].resultCode) {
        modeStates[activeMode].resultCode = code;
        getElement('result-code').textContent = code;
    }
    
    updateResultStats(width, height);
}

let pendingCodeTimer = null;
let lastRender = null;

// 预览是每帧刷新的，代码文本没必要跟着每帧重算：攒 60ms 再生成
function scheduleCodeGeneration(imageData, width, height) {
    lastRender = { imageData: imageData, width: width, height: height };
    
    if (pendingCodeTimer) clearTimeout(pendingCodeTimer);
    pendingCodeTimer = setTimeout(() => {
        pendingCodeTimer = null;
        generateCode(imageData, width, height);
    }, 60);
}

// 导出前必须先落盘，否则可能导出去抖期间的旧结果
function refreshCodeNow() {
    if (pendingCodeTimer) {
        clearTimeout(pendingCodeTimer);
        pendingCodeTimer = null;
    }
    if (lastRender) {
        generateCode(lastRender.imageData, lastRender.width, lastRender.height);
    }
}

function updateResultStats(width, height) {
    const stats = getElement('result-stats');
    if (!stats) return;
    
    const sourceKB = (modeStates[activeMode].resultCode.length / 1024).toFixed(1);
    const layoutId = getOutputLayout();
    const layout = getLayout(layoutId);
    const text = `${width}×${height} · ${layout.label} · 共 ${layoutBufferSize(width, height, layoutId)} B · 源码 ${sourceKB} KB`;
    
    // 统计跟模式走：切 Tab 后不能还挂着上一个模式的尺寸
    modeStates[activeMode].resultStats = text;
    stats.textContent = text;
    
    // 位图角标标出实际分辨率，两张预览才分得清哪张是哪张
    const caption = getElement(activeMode === 'video' ? 'video-frame-caption' : 'binary-caption');
    if (caption) {
        caption.textContent = `1bpp 位图 · ${width}×${height}`;
    }
}

function handleImageUpload(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    
    if (files.length > 1) {
        loadBatchFromFiles(files);
        return;
    }
    
    loadSingleImageFromFile(files[0]);
}

async function loadSingleImageFromFile(file) {
    modeStates.image.fileName = stripExtension(file.name);
    
    let img;
    try {
        img = await loadImageFromBlob(file);
    } catch (error) {
        alert('图片解码失败：' + file.name);
        return;
    }
    
    // 换图后旧框选对不上新图，直接收起来
    getElement('selection-box').style.display = 'none';
    
    currentImage = img;
    modeStates.image.originalSize = { width: img.width, height: img.height };
    
    const aspectRatio = (img.width / img.height).toFixed(2);
    getElement('image-info').innerHTML = `原图信息: ${img.width}x${img.height} (${aspectRatio}:1), 24位彩色`;
    
    if (imageAspectRatioObj) {
        imageAspectRatioObj.aspectRatio = img.width / img.height;
    }
    
    applyLockedRatio('image', 'width-input', 'height-input', 'lock-ratio');
    
    processImage();
}

function handleZipUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const fileName = file.name.toLowerCase();
    
    if (!fileName.endsWith('.zip')) {
        alert('当前版本仅支持ZIP格式的压缩包。');
        return;
    }
    
    loadBatchFromZip(file);
}

async function loadBatchFromZip(file) {
    if (typeof JSZip === 'undefined') {
        alert('JSZip 未加载（vendor/jszip.min.js 缺失），压缩包导入不可用；可直接多选图片代替。');
        return;
    }
    
    let zip;
    try {
        zip = await JSZip.loadAsync(file);
    } catch (error) {
        alert('处理压缩包失败: ' + (error && error.message ? error.message : error));
        return;
    }
    
    const entries = [];
    zip.forEach(function(relativePath, zipEntry) {
        if (!zipEntry.dir && IMAGE_EXTENSION.test(zipEntry.name)) {
            entries.push(zipEntry);
        }
    });
    
    // 稳定排序：zipEntry.async + FileReader 是两层异步，直接 push 会让顺序随机
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    
    if (entries.length === 0) {
        alert('压缩包内没有找到可用的图片文件');
        return;
    }
    
    await loadBatchItems(entries.map(zipEntry => ({
        name: zipEntry.name.split('.').slice(0, -1).join('.'),
        getBlob: () => zipEntry.async('blob')
    })));
}

function stripExtension(name) {
    return name.split('.').slice(0, -1).join('.');
}

// 多个文件直接拖入/选中时也走批量（input 上本来就有 multiple，之前只取了第一个）
async function loadBatchFromFiles(files) {
    const imageFiles = files
        .filter(file => /^image\//.test(file.type) || IMAGE_EXTENSION.test(file.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    
    if (imageFiles.length === 0) {
        alert('没有可用的图片文件');
        return;
    }
    
    await loadBatchItems(imageFiles.map(file => ({
        name: stripExtension(file.name),
        getBlob: () => Promise.resolve(file)
    })));
}

// 逐张串行加载：保序、失败跳过、期间刷新计数
async function loadBatchItems(items) {
    batchImages = [];
    imageSettings = [];
    currentBatchIndex = 0;
    
    for (let i = 0; i < items.length; i++) {
        try {
            const blob = await items[i].getBlob();
            const image = await loadImageFromBlob(blob);
            batchImages.push({ image: image, name: items[i].name, blob: blob });
            imageSettings.push(createDefaultImageSettings());
        } catch (error) {
            console.warn('跳过无法解码的图片:', items[i].name, error);
        }
        getElement('image-counter').textContent = `加载中 ${i + 1} / ${items.length}`;
    }
    
    if (batchImages.length === 0) {
        alert('没有图片能成功解码');
        return;
    }
    
    getElement('batch-controls').style.display = 'flex';
    showBatchImage(0);
}

function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('图片解码失败'));
        };
        img.src = url;
    });
}

function createDefaultImageSettings() {
    return {
        width: AppConfig.defaultSize,
        height: AppConfig.defaultSize,
        threshold: 128,
        thresholdType: 'rgb',
        redMin: 0,
        redMax: 255,
        greenMin: 0,
        greenMax: 255,
        blueMin: 0,
        blueMax: 255,
        invert: false,
        dither: 'none'
    };
}

function readImageSettingsFromUI() {
    return {
        width: parseInt(getElement('width-input').value) || AppConfig.defaultSize,
        height: parseInt(getElement('height-input').value) || AppConfig.defaultSize,
        threshold: parseInt(getElement('threshold-input').value),
        thresholdType: getElement('threshold-type').value,
        redMin: parseInt(getElement('red-min').value),
        redMax: parseInt(getElement('red-max').value),
        greenMin: parseInt(getElement('green-min').value),
        greenMax: parseInt(getElement('green-max').value),
        blueMin: parseInt(getElement('blue-min').value),
        blueMax: parseInt(getElement('blue-max').value),
        invert: getElement('invert-checkbox').checked,
        dither: readDitherMode('')
    };
}

function applyImageSettings(settings) {
    getElement('width-input').value = settings.width;
    getElement('height-input').value = settings.height;
    getElement('threshold-input').value = settings.threshold;
    getElement('threshold-value').textContent = settings.threshold;
    
    getElements('.threshold-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.type === settings.thresholdType) {
            btn.classList.add('active');
        }
    });
    getElement('threshold-type').value = settings.thresholdType;
    
    const rgbThresholds = getElement('rgb-thresholds');
    const singleThreshold = getElement('single-threshold');
    
    if (settings.thresholdType === 'individual') {
        rgbThresholds.style.display = 'block';
        singleThreshold.style.display = 'none';
    } else {
        rgbThresholds.style.display = 'none';
        singleThreshold.style.display = 'block';
    }
    
    getElement('red-min').value = settings.redMin;
    getElement('red-max').value = settings.redMax;
    getElement('green-min').value = settings.greenMin;
    getElement('green-max').value = settings.greenMax;
    getElement('blue-min').value = settings.blueMin;
    getElement('blue-max').value = settings.blueMax;
    
    getElement('red-min-value').textContent = settings.redMin;
    getElement('red-max-value').textContent = settings.redMax;
    getElement('green-min-value').textContent = settings.greenMin;
    getElement('green-max-value').textContent = settings.greenMax;
    getElement('blue-min-value').textContent = settings.blueMin;
    getElement('blue-max-value').textContent = settings.blueMax;
    
    getElement('invert-checkbox').checked = settings.invert;
    getElement('dither-mode').value = settings.dither || 'none';
}

function handleVideoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    if (currentVideoBlobUrl) {
        URL.revokeObjectURL(currentVideoBlobUrl);
    }
    
    const video = getElement('video-preview');
    currentVideoBlobUrl = URL.createObjectURL(file);
    video.src = currentVideoBlobUrl;
    currentVideo = video;
    
    video.addEventListener('loadedmetadata', function() {
        getElement('video-selection-box').style.display = 'none';
        modeStates.video.originalSize = { width: video.videoWidth, height: video.videoHeight };
        
        const videoInfo = getElement('video-info');
        const width = video.videoWidth;
        const height = video.videoHeight;
        const aspectRatio = (width / height).toFixed(2);
        const duration = formatTime(video.duration);
        
        let infoText = `视频信息: ${width}x${height} (${aspectRatio}:1), 时长: ${duration}`;
        
        if (video.videoFrameRate) {
            infoText += `, 帧率: ${video.videoFrameRate.toFixed(1)}fps`;
        }
        
        videoInfo.innerHTML = infoText;
        
        if (videoAspectRatioObj) {
            videoAspectRatioObj.aspectRatio = width / height;
        }
        
        applyLockedRatio('video', 'video-width', 'video-height', 'video-lock-ratio');
        processVideoFrame();
    }, { once: true });
}

function processImage() {
    if (!currentImage) return;
    
    const width = readBitmapSize('width-input');
    const height = readBitmapSize('height-input');
    const threshold = parseInt(getElement('threshold-input').value);
    const thresholdType = getElement('threshold-type').value;
    const invert = getElement('invert-checkbox').checked;
    
    const sourceCanvas = getElement('source-preview');
    const sourceCtx = sourceCanvas.getContext('2d');
    
    const previewSize = calculatePreviewSize(
        modeStates.image.originalSize.width,
        modeStates.image.originalSize.height,
        AppConfig.maxPreviewSize
    );
    
    sourceCanvas.width = previewSize.width;
    sourceCanvas.height = previewSize.height;
    sourceCtx.imageSmoothingEnabled = true;
    sourceCtx.drawImage(currentImage, 0, 0, previewSize.width, previewSize.height);
    
    const binaryCanvas = getElement('binary-preview');
    const binaryCtx = binaryCanvas.getContext('2d');
    
    const maxCanvasSize = Math.min(
        window.innerWidth * 0.8,
        window.innerHeight * 0.6
    );
    
    const scaleFactor = Math.min(AppConfig.maxPreviewZoom, maxCanvasSize / Math.max(width, height));
    
    binaryCanvas.width = width * scaleFactor;
    binaryCanvas.height = height * scaleFactor;
    
    const rgbThresholds = readRgbThresholds('');
    const dither = readDitherMode('');
    
    const processedImageData = canvasPool.withCanvas(width, height, tempCanvasItem => {
        const tempCtx = tempCanvasItem.ctx;
        drawSourceIntoCanvas(tempCtx, 'image', width, height);
        
        const imageData = tempCtx.getImageData(0, 0, width, height);
        const processed = processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert, dither);
        
        tempCtx.putImageData(processed, 0, 0);
        binaryCtx.imageSmoothingEnabled = false;
        binaryCtx.drawImage(tempCanvasItem.canvas, 0, 0, width * scaleFactor, height * scaleFactor);
        
        return processed;
    });
    
    scheduleCodeGeneration(processedImageData, width, height);
}

function processVideo() {
    lastFrameTime = 0;
}

function processVideoFrame() {
    if (!currentVideo) return;
    
    const width = readBitmapSize('video-width');
    const height = readBitmapSize('video-height');
    const threshold = parseInt(getElement('video-threshold').value);
    const frameRate = parseInt(getElement('frame-rate').value);
    const thresholdType = getElement('video-threshold-type').value;
    const invert = getElement('video-invert-checkbox').checked;
    
    const video = getElement('video-preview');
    const currentTime = video.currentTime;
    
    const frameInterval = 1 / frameRate;
    
    // 限频只在播放时才有意义：暂停状态下 lastFrameTime 等于 currentTime，
    // 用户刚改的框选/阈值会被闸门挡掉，预览一直停在旧画面
    const throttled = !video.paused && lastFrameTime !== 0;
    
    if (!throttled || currentTime - lastFrameTime >= frameInterval) {
        lastFrameTime = currentTime;
        
        const canvas = getElement('video-frame-preview');
        const ctx = canvas.getContext('2d');
        
        const maxCanvasSize = Math.min(
            window.innerWidth * 0.8,
            window.innerHeight * 0.6
        );
        
        const scaleFactor = Math.min(AppConfig.maxPreviewZoom, maxCanvasSize / Math.max(width, height));
        
        canvas.width = width * scaleFactor;
        canvas.height = height * scaleFactor;
        
        const rgbThresholds = readRgbThresholds('video-');
        const dither = readDitherMode('video-');
        
        const processedImageData = canvasPool.withCanvas(width, height, tempCanvasItem => {
            const tempCtx = tempCanvasItem.ctx;
            drawSourceIntoCanvas(tempCtx, 'video', width, height);
            
            const imageData = tempCtx.getImageData(0, 0, width, height);
            const processed = processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert, dither);
            
            tempCtx.putImageData(processed, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(tempCanvasItem.canvas, 0, 0, width * scaleFactor, height * scaleFactor);
            
            return processed;
        });
        
        scheduleCodeGeneration(processedImageData, width, height);
    }
}

function getDrawGridSize() {
    return {
        width: Math.max(1, parseInt(getElement('draw-width').value) || 16),
        height: Math.max(1, parseInt(getElement('draw-height').value) || 16)
    };
}

function getDrawScaleFactor(width, height) {
    const maxCanvasSize = Math.min(
        window.innerWidth * 0.8,
        window.innerHeight * 0.6
    );
    return Math.min(AppConfig.maxPreviewZoom, maxCanvasSize / Math.max(width, height));
}

// 改画布尺寸就把画作清空太粗暴：先把旧画面截下来，按比例铺回新画布
function renderDrawSurface(preserveContent) {
    const { width, height } = getDrawGridSize();
    const scaleFactor = getDrawScaleFactor(width, height);
    
    let snapshot = null;
    if (preserveContent && drawCanvas.width > 0 && drawCanvas.height > 0) {
        snapshot = document.createElement('canvas');
        snapshot.width = drawCanvas.width;
        snapshot.height = drawCanvas.height;
        snapshot.getContext('2d').drawImage(drawCanvas, 0, 0);
    }
    
    drawCanvas.width = width * scaleFactor;
    drawCanvas.height = height * scaleFactor;
    drawCtx = drawCanvas.getContext('2d', { willReadFrequently: true });
    
    drawCtx.fillStyle = 'white';
    drawCtx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
    
    if (snapshot) {
        drawCtx.imageSmoothingEnabled = false;
        drawCtx.drawImage(snapshot, 0, 0, drawCanvas.width, drawCanvas.height);
    }
    
    drawCtx.strokeStyle = '#ddd';
    for (let i = 0; i <= width; i++) {
        drawCtx.beginPath();
        drawCtx.moveTo(i * scaleFactor, 0);
        drawCtx.lineTo(i * scaleFactor, height * scaleFactor);
        drawCtx.stroke();
    }
    for (let i = 0; i <= height; i++) {
        drawCtx.beginPath();
        drawCtx.moveTo(0, i * scaleFactor);
        drawCtx.lineTo(width * scaleFactor, i * scaleFactor);
        drawCtx.stroke();
    }
    
    return { width, height, scaleFactor };
}

function setupDrawCanvas() {
    // 监听器只挂一次：以前每次改画布尺寸都重新 addEventListener，
    // 改几次尺寸就叠几层，单次 pointermove 会重复执行多遍 draw()
    drawCanvas.addEventListener('pointerdown', startDrawing);
    drawCanvas.addEventListener('pointermove', draw);
    drawCanvas.addEventListener('pointerup', stopDrawing);
    drawCanvas.addEventListener('pointercancel', stopDrawing);
    drawCanvas.addEventListener('pointerleave', stopDrawing);
    
    renderDrawSurface(false);
}

function resizeDrawCanvas() {
    renderDrawSurface(true);
    processDrawCanvas();
}

function startDrawing(e) {
    isDrawing = true;
    draw(e);
}

function draw(e) {
    if (!isDrawing) return;
    
    const rect = drawCanvas.getBoundingClientRect();
    // 画布被 CSS 缩放时用显示尺寸换算，否则笔触与网格错位
    const displayScale = rect.width ? drawCanvas.width / rect.width : 1;
    const mouseX = (e.clientX - rect.left) * displayScale;
    const mouseY = (e.clientY - rect.top) * displayScale;
    
    const { width, height } = getDrawGridSize();
    const scaleFactor = getDrawScaleFactor(width, height);
    
    const brushRadius = brushSize * (scaleFactor / 2);
    
    const startX = Math.max(0, Math.floor((mouseX - brushRadius) / scaleFactor));
    const endX = Math.min(width - 1, Math.floor((mouseX + brushRadius) / scaleFactor));
    const startY = Math.max(0, Math.floor((mouseY - brushRadius) / scaleFactor));
    const endY = Math.min(height - 1, Math.floor((mouseY + brushRadius) / scaleFactor));
    
    // 网格很密时 scaleFactor 可能小于 2，原来的 scaleFactor-2 会让格子画不出来
    const inset = scaleFactor >= 4 ? 1 : 0;
    const cellSize = Math.max(1, scaleFactor - inset * 2);
    
    for (let x = startX; x <= endX; x++) {
        for (let y = startY; y <= endY; y++) {
            const cellCenterX = x * scaleFactor + (scaleFactor / 2);
            const cellCenterY = y * scaleFactor + (scaleFactor / 2);
            
            const distance = Math.sqrt(
                Math.pow(mouseX - cellCenterX, 2) + 
                Math.pow(mouseY - cellCenterY, 2)
            );
            
            if (distance <= brushRadius) {
                drawCtx.fillStyle = drawMode ? 'black' : 'white';
                drawCtx.fillRect(x * scaleFactor + inset, y * scaleFactor + inset, cellSize, cellSize);
            }
        }
    }
    
    processDrawCanvas();
}

function stopDrawing() {
    isDrawing = false;
}

function clearCanvas() {
    renderDrawSurface(false);
    processDrawCanvas();
}

function processDrawCanvas() {
    const width = parseInt(getElement('draw-width').value);
    const height = parseInt(getElement('draw-height').value);
    const invert = getElement('draw-invert-checkbox').checked;
    
    const maxCanvasSize = Math.min(
        window.innerWidth * 0.8,
        window.innerHeight * 0.6
    );
    
    const scaleFactor = Math.min(AppConfig.maxPreviewZoom, maxCanvasSize / Math.max(width, height));
    
    const imageData = canvasPool.withCanvas(width, height, tempCanvasItem => {
        const tempCtx = tempCanvasItem.ctx;
        tempCtx.drawImage(drawCanvas, 0, 0, width, height);
        
        const pixels = tempCtx.getImageData(0, 0, width, height);
        
        if (invert) {
            const data = pixels.data;
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 255 - data[i];
                data[i + 1] = 255 - data[i + 1];
                data[i + 2] = 255 - data[i + 2];
            }
        }
        
        const previewCanvas = getElement('draw-preview');
        const previewCtx = previewCanvas.getContext('2d');
        previewCanvas.width = width * scaleFactor;
        previewCanvas.height = height * scaleFactor;
        
        tempCtx.putImageData(pixels, 0, 0);
        
        previewCtx.imageSmoothingEnabled = false;
        previewCtx.drawImage(tempCanvasItem.canvas, 0, 0, width * scaleFactor, height * scaleFactor);
        
        return pixels;
    });
    
    scheduleCodeGeneration(imageData, width, height);
}

function showBatchImage(index) {
    if (index < 0 || index >= batchImages.length) return;
    
    // 先把当前这张的调整结果存回去，翻回来时才不会丢
    if (batchImages.length > 0 && imageSettings[currentBatchIndex]) {
        imageSettings[currentBatchIndex] = readImageSettingsFromUI();
    }
    
    currentBatchIndex = index;
    const batchImage = batchImages[index];
    currentImage = batchImage.image;
    modeStates.image.fileName = batchImage.name;
    modeStates.image.originalSize = { width: batchImage.image.width, height: batchImage.image.height };
    
    if (imageAspectRatioObj) {
        imageAspectRatioObj.aspectRatio = batchImage.image.width / batchImage.image.height;
    }
    
    applyImageSettings(imageSettings[index] || createDefaultImageSettings());
    getElement('image-counter').textContent = `${currentBatchIndex + 1} / ${batchImages.length}`;
    
    processImage();
}

function setupSelectionEvents() {
    const sourceContainer = getElement('source-preview').parentElement;
    const selectionBox = getElement('selection-box');
    
    sourceContainer.addEventListener('mousedown', (e) => {
        if (e.target === selectionBox) {
            isDragging = true;
            const rect = selectionBox.getBoundingClientRect();
            dragOffset.x = e.clientX - rect.left;
            dragOffset.y = e.clientY - rect.top;
            return;
        }
        
        if (e.target.classList.contains('selection-handle')) {
            isResizing = true;
            resizeHandle = e.target.classList[1];
            const rect = sourceContainer.getBoundingClientRect();
            modeStates.image.selectionStart.x = e.clientX - rect.left;
            modeStates.image.selectionStart.y = e.clientY - rect.top;
            return;
        }
        
        if (e.target.classList.contains('selection-ratio')) {
            e.stopPropagation();
            toggleRatioLock('image');
            return;
        }
        
        if (e.target.classList.contains('selection-original-ratio')) {
            e.stopPropagation();
            toggleOriginalRatioLock('image');
            return;
        }
        
        const rect = getElement('source-preview').getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
            isSelecting = true;
            const containerRect = sourceContainer.getBoundingClientRect();
            modeStates.image.selectionStart.x = e.clientX - containerRect.left;
            modeStates.image.selectionStart.y = e.clientY - containerRect.top;
            modeStates.image.selectionEnd = { ...modeStates.image.selectionStart };
            updateSelectionBox('image');
        }
    });
    
    sourceContainer.addEventListener('mousemove', (e) => {
        const rect = sourceContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        if (isSelecting) {
            modeStates.image.selectionEnd.x = mouseX;
            modeStates.image.selectionEnd.y = mouseY;
            updateSelectionBox('image');
        } else if (isResizing) {
            resizeSelection('image', mouseX, mouseY);
        } else if (isDragging) {
            moveSelection('image', mouseX, mouseY);
        }
    });
    
    sourceContainer.addEventListener('mouseup', () => {
        if (isSelecting || isResizing || isDragging) {
            isSelecting = false;
            isResizing = false;
            isDragging = false;
            resizeHandle = null;
            processImage();
        }
    });
    
    sourceContainer.addEventListener('mouseleave', () => {
        isSelecting = false;
        isResizing = false;
        isDragging = false;
        resizeHandle = null;
    });
    
    selectionBox.querySelector('.selection-close').addEventListener('click', (e) => {
        e.stopPropagation();
        selectionBox.style.display = 'none';
        processImage();
    });
}

function setupVideoSelectionEvents() {
    const videoContainer = getElement('video-preview').parentElement;
    const videoSelectionBox = getElement('video-selection-box');
    
    videoContainer.addEventListener('mousedown', (e) => {
        if (e.target === videoSelectionBox) {
            isDragging = true;
            const rect = videoSelectionBox.getBoundingClientRect();
            dragOffset.x = e.clientX - rect.left;
            dragOffset.y = e.clientY - rect.top;
            return;
        }
        
        if (e.target.classList.contains('selection-handle')) {
            isResizing = true;
            resizeHandle = e.target.classList[1];
            const rect = videoContainer.getBoundingClientRect();
            modeStates.video.selectionStart.x = e.clientX - rect.left;
            modeStates.video.selectionStart.y = e.clientY - rect.top;
            return;
        }
        
        if (e.target.classList.contains('video-selection-ratio')) {
            e.stopPropagation();
            toggleRatioLock('video');
            return;
        }
        
        if (e.target.classList.contains('video-selection-original-ratio')) {
            e.stopPropagation();
            toggleOriginalRatioLock('video');
            return;
        }
        
        const rect = getElement('video-preview').getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
            isSelecting = true;
            const containerRect = videoContainer.getBoundingClientRect();
            modeStates.video.selectionStart.x = e.clientX - containerRect.left;
            modeStates.video.selectionStart.y = e.clientY - containerRect.top;
            modeStates.video.selectionEnd = { ...modeStates.video.selectionStart };
            updateSelectionBox('video');
        }
    });
    
    videoContainer.addEventListener('mousemove', (e) => {
        const rect = videoContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        if (isSelecting) {
            modeStates.video.selectionEnd.x = mouseX;
            modeStates.video.selectionEnd.y = mouseY;
            updateSelectionBox('video');
        } else if (isResizing) {
            resizeSelection('video', mouseX, mouseY);
        } else if (isDragging) {
            moveSelection('video', mouseX, mouseY);
        }
    });
    
    videoContainer.addEventListener('mouseup', () => {
        if (isSelecting || isResizing || isDragging) {
            isSelecting = false;
            isResizing = false;
            isDragging = false;
            resizeHandle = null;
            processVideoFrame();
        }
    });
    
    videoContainer.addEventListener('mouseleave', () => {
        isSelecting = false;
        isResizing = false;
        isDragging = false;
        resizeHandle = null;
    });
    
    videoSelectionBox.querySelector('.selection-close').addEventListener('click', (e) => {
        e.stopPropagation();
        videoSelectionBox.style.display = 'none';
        processVideoFrame();
    });
}

function setSelectionHandlesVisible(mode, visible, sideOnly) {
    const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
    if (!selectionBox) return;
    
    // 必须限定在本模式的框选盒内：用全文档选择器会把另一个模式的手柄一起改掉
    const selector = sideOnly
        ? '.selection-handle.left, .selection-handle.right, .selection-handle.top, .selection-handle.bottom'
        : '.selection-handle';
    
    selectionBox.querySelectorAll(selector).forEach(el => {
        el.style.display = visible ? 'block' : 'none';
    });
}

function toggleRatioLock(mode) {
    modeStates[mode].isRatioLocked = !modeStates[mode].isRatioLocked;
    modeStates[mode].isOriginalRatioLocked = false;
    
    const ratioBtn = mode === 'image' ? 
        getElement('selection-box').querySelector('.selection-ratio') : 
        getElement('video-selection-box').querySelector('.video-selection-ratio');
    const originalRatioBtn = mode === 'image' ? 
        getElement('selection-box').querySelector('.selection-original-ratio') : 
        getElement('video-selection-box').querySelector('.video-selection-original-ratio');
    
    if (modeStates[mode].isRatioLocked) {
        makeSelectionSquare(mode);
        ratioBtn.classList.add('locked');
        originalRatioBtn.classList.remove('locked');
        
        setSelectionHandlesVisible(mode, false, true);
    } else {
        ratioBtn.classList.remove('locked');
        setSelectionHandlesVisible(mode, true);
    }
}

function toggleOriginalRatioLock(mode) {
    modeStates[mode].isOriginalRatioLocked = !modeStates[mode].isOriginalRatioLocked;
    modeStates[mode].isRatioLocked = false;
    
    const originalRatioBtn = mode === 'image' ? 
        getElement('selection-box').querySelector('.selection-original-ratio') : 
        getElement('video-selection-box').querySelector('.video-selection-original-ratio');
    const ratioBtn = mode === 'image' ? 
        getElement('selection-box').querySelector('.selection-ratio') : 
        getElement('video-selection-box').querySelector('.video-selection-ratio');
    
    if (modeStates[mode].isOriginalRatioLocked) {
        if (modeStates[mode].originalSize.width > 0 && modeStates[mode].originalSize.height > 0) {
            const originalRatio = modeStates[mode].originalSize.width / modeStates[mode].originalSize.height;
            
            const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
            const sourceElement = mode === 'image' ? getElement('source-preview') : getElement('video-preview');
            
            const currentRect = selectionBox.getBoundingClientRect();
            const sourceRect = sourceElement.getBoundingClientRect();
            
            const boxLeft = currentRect.left - sourceRect.left;
            const boxTop = currentRect.top - sourceRect.top;
            const boxWidth = currentRect.width;
            const boxHeight = currentRect.height;
            
            let newWidth, newHeight;
            if (originalRatio > 1) {
                newWidth = boxWidth;
                newHeight = boxWidth / originalRatio;
            } else {
                newHeight = boxHeight;
                newWidth = boxHeight * originalRatio;
            }
            
            const newLeft = boxLeft + (boxWidth - newWidth) / 2;
            const newTop = boxTop + (boxHeight - newHeight) / 2;
            
            selectionBox.style.left = newLeft + 'px';
            selectionBox.style.top = newTop + 'px';
            selectionBox.style.width = newWidth + 'px';
            selectionBox.style.height = newHeight + 'px';
            
            modeStates[mode].selectionStart = { x: newLeft, y: newTop };
            modeStates[mode].selectionEnd = { x: newLeft + newWidth, y: newTop + newHeight };
            
            originalRatioBtn.classList.add('locked');
            ratioBtn.classList.remove('locked');
            
            setSelectionHandlesVisible(mode, false, true);
            
            if (mode === 'image') {
                processImage();
            } else {
                processVideoFrame();
            }
        } else {
            alert('请先上传一个文件');
            modeStates[mode].isOriginalRatioLocked = false;
        }
    } else {
        originalRatioBtn.classList.remove('locked');
        setSelectionHandlesVisible(mode, true);
    }
}

function makeSelectionSquare(mode) {
    const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
    const sourceElement = mode === 'image' ? getElement('source-preview') : getElement('video-preview');
    
    const currentRect = selectionBox.getBoundingClientRect();
    const sourceRect = sourceElement.getBoundingClientRect();
    
    const boxLeft = currentRect.left - sourceRect.left;
    const boxTop = currentRect.top - sourceRect.top;
    const boxWidth = currentRect.width;
    const boxHeight = currentRect.height;
    
    const squareSize = Math.min(boxWidth, boxHeight);
    
    const newLeft = boxLeft + (boxWidth - squareSize) / 2;
    const newTop = boxTop + (boxHeight - squareSize) / 2;
    
    selectionBox.style.left = newLeft + 'px';
    selectionBox.style.top = newTop + 'px';
    selectionBox.style.width = squareSize + 'px';
    selectionBox.style.height = squareSize + 'px';
    
    modeStates[mode].selectionStart = { x: newLeft, y: newTop };
    modeStates[mode].selectionEnd = { x: newLeft + squareSize, y: newTop + squareSize };
    
    if (mode === 'image') {
        processImage();
    } else {
        processVideoFrame();
    }
}

function resizeSelection(mode, mouseX, mouseY) {
    const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
    const sourceElement = mode === 'image' ? getElement('source-preview') : getElement('video-preview');
    
    const currentRect = selectionBox.getBoundingClientRect();
    const sourceRect = sourceElement.getBoundingClientRect();
    
    const boxLeft = currentRect.left - sourceRect.left;
    const boxTop = currentRect.top - sourceRect.top;
    const boxWidth = currentRect.width;
    const boxHeight = currentRect.height;
    
    if (modeStates[mode].isRatioLocked) {
        resizeSelectionLocked(mode, mouseX, mouseY, boxLeft, boxTop, boxWidth, boxHeight);
    } else if (modeStates[mode].isOriginalRatioLocked) {
        resizeSelectionOriginalRatio(mode, mouseX, mouseY, boxLeft, boxTop, boxWidth, boxHeight);
    } else {
        let newLeft = boxLeft;
        let newTop = boxTop;
        let newWidth = boxWidth;
        let newHeight = boxHeight;
        
        switch (resizeHandle) {
            case 'top-left':
                newLeft = mouseX;
                newTop = mouseY;
                newWidth = boxLeft + boxWidth - mouseX;
                newHeight = boxTop + boxHeight - mouseY;
                break;
            case 'top-right':
                newTop = mouseY;
                newWidth = mouseX - boxLeft;
                newHeight = boxTop + boxHeight - mouseY;
                break;
            case 'bottom-left':
                newLeft = mouseX;
                newWidth = boxLeft + boxWidth - mouseX;
                newHeight = mouseY - boxTop;
                break;
            case 'bottom-right':
                newWidth = mouseX - boxLeft;
                newHeight = mouseY - boxTop;
                break;
            case 'left':
                newLeft = mouseX;
                newWidth = boxLeft + boxWidth - mouseX;
                break;
            case 'right':
                newWidth = mouseX - boxLeft;
                break;
            case 'top':
                newTop = mouseY;
                newHeight = boxTop + boxHeight - mouseY;
                break;
            case 'bottom':
                newHeight = mouseY - boxTop;
                break;
        }
        
        if (newWidth > 10 && newHeight > 10) {
            selectionBox.style.left = newLeft + 'px';
            selectionBox.style.top = newTop + 'px';
            selectionBox.style.width = newWidth + 'px';
            selectionBox.style.height = newHeight + 'px';
            
            modeStates[mode].selectionStart = { x: newLeft, y: newTop };
            modeStates[mode].selectionEnd = { x: newLeft + newWidth, y: newTop + newHeight };
        }
    }
}

function resizeSelectionOriginalRatio(mode, mouseX, mouseY, boxLeft, boxTop, boxWidth, boxHeight) {
    if (modeStates[mode].originalSize.width > 0 && modeStates[mode].originalSize.height > 0) {
        const originalRatio = modeStates[mode].originalSize.width / modeStates[mode].originalSize.height;
        let newLeft = boxLeft;
        let newTop = boxTop;
        let newWidth = boxWidth;
        let newHeight = boxHeight;
        
        switch (resizeHandle) {
            case 'top-left':
                const fixedBottomRightX = boxLeft + boxWidth;
                const fixedBottomRightY = boxTop + boxHeight;
                
                const dx = fixedBottomRightX - mouseX;
                const dy = fixedBottomRightY - mouseY;
                
                if (originalRatio > 1) {
                    newWidth = dx;
                    newHeight = dx / originalRatio;
                } else {
                    newHeight = dy;
                    newWidth = dy * originalRatio;
                }
                
                newLeft = fixedBottomRightX - newWidth;
                newTop = fixedBottomRightY - newHeight;
                break;
                
            case 'top-right':
                const fixedBottomLeftX = boxLeft;
                const fixedBottomLeftY = boxTop + boxHeight;
                
                const dx1 = mouseX - fixedBottomLeftX;
                const dy1 = fixedBottomLeftY - mouseY;
                
                if (originalRatio > 1) {
                    newWidth = dx1;
                    newHeight = dx1 / originalRatio;
                } else {
                    newHeight = dy1;
                    newWidth = dy1 * originalRatio;
                }
                
                newLeft = fixedBottomLeftX;
                newTop = fixedBottomLeftY - newHeight;
                break;
                
            case 'bottom-left':
                const fixedTopRightX = boxLeft + boxWidth;
                const fixedTopRightY = boxTop;
                
                const dx2 = fixedTopRightX - mouseX;
                const dy2 = mouseY - fixedTopRightY;
                
                if (originalRatio > 1) {
                    newWidth = dx2;
                    newHeight = dx2 / originalRatio;
                } else {
                    newHeight = dy2;
                    newWidth = dy2 * originalRatio;
                }
                
                newLeft = fixedTopRightX - newWidth;
                newTop = fixedTopRightY;
                break;
                
            case 'bottom-right':
                const fixedTopLeftX = boxLeft;
                const fixedTopLeftY = boxTop;
                
                const dx3 = mouseX - fixedTopLeftX;
                const dy3 = mouseY - fixedTopLeftY;
                
                if (originalRatio > 1) {
                    newWidth = dx3;
                    newHeight = dx3 / originalRatio;
                } else {
                    newHeight = dy3;
                    newWidth = dy3 * originalRatio;
                }
                
                newLeft = fixedTopLeftX;
                newTop = fixedTopLeftY;
                break;
        }
        
        if (newWidth > 10 && newHeight > 10) {
            const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
            selectionBox.style.left = newLeft + 'px';
            selectionBox.style.top = newTop + 'px';
            selectionBox.style.width = newWidth + 'px';
            selectionBox.style.height = newHeight + 'px';
            
            modeStates[mode].selectionStart = { x: newLeft, y: newTop };
            modeStates[mode].selectionEnd = { x: newLeft + newWidth, y: newTop + newHeight };
        }
    }
}

function resizeSelectionLocked(mode, mouseX, mouseY, boxLeft, boxTop, boxWidth, boxHeight) {
    let newLeft = boxLeft;
    let newTop = boxTop;
    let newSize = Math.max(boxWidth, boxHeight);
    
    switch (resizeHandle) {
        case 'top-left':
            const fixedBottomRightX = boxLeft + boxWidth;
            const fixedBottomRightY = boxTop + boxHeight;
            
            const dx = fixedBottomRightX - mouseX;
            const dy = fixedBottomRightY - mouseY;
            
            newSize = Math.max(Math.abs(dx), Math.abs(dy));
            
            newLeft = fixedBottomRightX - newSize;
            newTop = fixedBottomRightY - newSize;
            break;
            
        case 'top-right':
            const fixedBottomLeftX = boxLeft;
            const fixedBottomLeftY = boxTop + boxHeight;
            
            const dx1 = mouseX - fixedBottomLeftX;
            const dy1 = fixedBottomLeftY - mouseY;
            
            newSize = Math.max(Math.abs(dx1), Math.abs(dy1));
            
            newLeft = fixedBottomLeftX;
            newTop = fixedBottomLeftY - newSize;
            break;
            
        case 'bottom-left':
            const fixedTopRightX = boxLeft + boxWidth;
            const fixedTopRightY = boxTop;
            
            const dx2 = fixedTopRightX - mouseX;
            const dy2 = mouseY - fixedTopRightY;
            
            newSize = Math.max(Math.abs(dx2), Math.abs(dy2));
            
            newLeft = fixedTopRightX - newSize;
            newTop = fixedTopRightY;
            break;
            
        case 'bottom-right':
            const fixedTopLeftX = boxLeft;
            const fixedTopLeftY = boxTop;
            
            const dx3 = mouseX - fixedTopLeftX;
            const dy3 = mouseY - fixedTopLeftY;
            
            newSize = Math.max(Math.abs(dx3), Math.abs(dy3));
            
            newLeft = fixedTopLeftX;
            newTop = fixedTopLeftY;
            break;
    }
    
    if (newSize > 10) {
        const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
        selectionBox.style.left = newLeft + 'px';
        selectionBox.style.top = newTop + 'px';
        selectionBox.style.width = newSize + 'px';
        selectionBox.style.height = newSize + 'px';
        
        modeStates[mode].selectionStart = { x: newLeft, y: newTop };
        modeStates[mode].selectionEnd = { x: newLeft + newSize, y: newTop + newSize };
    }
}

function moveSelection(mode, mouseX, mouseY) {
    const sourceElement = mode === 'image' ? getElement('source-preview') : getElement('video-preview');
    const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
    const boxWidth = selectionBox.offsetWidth;
    const boxHeight = selectionBox.offsetHeight;
    
    let newLeft = mouseX - dragOffset.x;
    let newTop = mouseY - dragOffset.y;
    
    newLeft = Math.max(0, Math.min(newLeft, sourceElement.offsetWidth - boxWidth));
    newTop = Math.max(0, Math.min(newTop, sourceElement.offsetHeight - boxHeight));
    
    selectionBox.style.left = newLeft + 'px';
    selectionBox.style.top = newTop + 'px';
    
    modeStates[mode].selectionStart = { x: newLeft, y: newTop };
    modeStates[mode].selectionEnd = { x: newLeft + boxWidth, y: newTop + boxHeight };
}

function updateSelectionBox(mode) {
    const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
    const x = Math.min(modeStates[mode].selectionStart.x, modeStates[mode].selectionEnd.x);
    const y = Math.min(modeStates[mode].selectionStart.y, modeStates[mode].selectionEnd.y);
    const width = Math.abs(modeStates[mode].selectionEnd.x - modeStates[mode].selectionStart.x);
    const height = Math.abs(modeStates[mode].selectionEnd.y - modeStates[mode].selectionStart.y);
    
    if (width > 5 && height > 5) {
        selectionBox.style.display = 'block';
        selectionBox.style.left = x + 'px';
        selectionBox.style.top = y + 'px';
        selectionBox.style.width = width + 'px';
        selectionBox.style.height = height + 'px';
    } else {
        selectionBox.style.display = 'none';
    }
}


// ===== 艺术字（文字层）=====
// 采样方式的依据（实测，探针见 docs/DESIGN_quality.md 附录）：
// · 直接以目标字号 fillText 会被 hinting 扭形：16px「术」与 16× 参考的 IoU 只有 0.36，t±16 翻转率 14%；
// · 超采样后面积平均把 IoU 拉到 0.91~1.00、翻转率降到 3~8%；
// · 倍率按目标尺寸选：≤32px 用 8×（亚像素占比大），更大的用 4×（8× 只剩 <1% 收益，纯烧时间）；
// · 反锐化默认关：它能把翻转率再压到 1~4%，但 16px 汉字 IoU 从 0.94 掉到 0.82 —— 用保真换稳健，留给用户开。
const TEXT_LIMITS = { minHeight: 8, maxHeight: 256, maxChars: 24 };

function pickTextSupersample(height) {
    return height <= 32 ? 8 : 4;
}

// 单字：S 倍渲染 → 量墨迹框 → 裁出 → 只按超采样倍率缩回（**不**做墨迹高度归一化）。
// 为什么不做归一化：按墨迹高度拉伸会让「口」这种矮字被放大、「日」被缩小，
// 同一串字里笔画粗细就不一致了。按字框（em）归一化 = 所有字共用同一设计尺度。
// 记录 ascent/descent 是为了按基线对齐（裁 bbox 之后各自的上边缘并不在同一条线上）。
function renderGlyphCanvas(char, height, fontStack) {
    const scale = pickTextSupersample(height);
    const srcSize = Math.max(8, height * scale);
    const pad = Math.ceil(srcSize * 0.4);
    const big = document.createElement('canvas');
    big.width = srcSize + pad * 2;
    big.height = srcSize + pad * 2;

    const bctx = big.getContext('2d', { willReadFrequently: true });
    bctx.fillStyle = '#000';
    bctx.fillRect(0, 0, big.width, big.height);
    bctx.fillStyle = '#fff';
    bctx.font = `400 ${srcSize}px ${fontStack}`;
    bctx.textBaseline = 'alphabetic';
    bctx.textAlign = 'left';
    const baselineY = big.height - pad;
    bctx.fillText(char, pad, baselineY);

    // bbox 判据用「亮于 40」：把抗锯齿边缘也算进墨迹，否则细笔画会被裁掉一列
    const data = bctx.getImageData(0, 0, big.width, big.height).data;
    let minX = big.width, minY = big.height, maxX = -1, maxY = -1;
    for (let y = 0; y < big.height; y++) {
        for (let x = 0; x < big.width; x++) {
            if (data[(y * big.width + x) * 4] > 40) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null;

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const width = Math.max(1, Math.round(boxWidth / scale));

    // 先把 ascent / descent 各自取整，再用它们之和定字形画布高度：
    // 这样墨迹上下沿都落在整数格线上，混排时下沿能严格对齐基线。
    // （若直接 round(boxHeight/scale)，每个字各自舍入会让下沿抖动 ±1px，
    //   一串「口A」就会出现一高一低。）
    const intAscent = Math.max(0, Math.round((baselineY - minY) / scale));
    const intDescent = Math.max(0, Math.round((maxY + 1 - baselineY) / scale));
    const glyphHeight = Math.max(1, intAscent + intDescent);

    const glyph = document.createElement('canvas');
    glyph.width = width;
    glyph.height = glyphHeight;
    const gctx = glyph.getContext('2d', { willReadFrequently: true });
    gctx.fillStyle = '#000';
    gctx.fillRect(0, 0, width, glyphHeight);
    gctx.imageSmoothingEnabled = true;
    gctx.imageSmoothingQuality = 'high';
    gctx.drawImage(big, minX, minY, boxWidth, boxHeight, 0, 0, width, glyphHeight);

    return {
        canvas: glyph,
        width: width,
        ascent: intAscent,
        descent: intDescent
    };
}

// 整串：按基线对齐 → 紧凑排布 → 整幅居中；宽度向上对齐到 8 的倍数（四种布局都能整字节落位）
function renderTextLayer(text, options) {
    const opts = options || {};
    const fontSize = Math.max(TEXT_LIMITS.minHeight, Math.min(TEXT_LIMITS.maxHeight, parseInt(opts.height, 10) || 24));
    const fontStack = opts.font || '"Microsoft YaHei", sans-serif';
    const chars = Array.from(String(text == null ? '' : text)).slice(0, TEXT_LIMITS.maxChars);
    if (chars.length === 0) return null;

    const gap = opts.gap > 0 ? Math.min(64, Math.floor(opts.gap)) : Math.max(1, Math.round(fontSize / 16));
    const glyphs = [];
    for (const ch of chars) {
        if (ch === ' ' || ch === '\u3000') {
            glyphs.push({ canvas: null, width: Math.max(2, Math.round(fontSize * 0.35)), ascent: 0, descent: 0 });
            continue;
        }
        const glyph = renderGlyphCanvas(ch, fontSize, fontStack);
        if (glyph) glyphs.push(glyph);
    }
    if (glyphs.length === 0) return null;

    // 基线对齐：整幅高度 = 最大上延 + 最大下延（结果通常略小于字号，因为墨迹不含字框留白）
    let ascentMax = 0, descentMax = 0;
    for (const glyph of glyphs) {
        if (glyph.canvas) {
            ascentMax = Math.max(ascentMax, glyph.ascent);
            descentMax = Math.max(descentMax, glyph.descent);
        }
    }
    const height = Math.max(1, ascentMax + descentMax);

    const contentWidth = glyphs.reduce((sum, glyph) => sum + glyph.width, 0) + gap * (glyphs.length - 1);
    const alignedWidth = Math.max(8, Math.ceil(contentWidth / 8) * 8);

    const canvas = document.createElement('canvas');
    canvas.width = alignedWidth;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, alignedWidth, height);

    let cursor = Math.floor((alignedWidth - contentWidth) / 2);
    for (const glyph of glyphs) {
        if (glyph.canvas) {
            const y = ascentMax - glyph.ascent;
            ctx.drawImage(glyph.canvas, cursor, y);
        }
        cursor += glyph.width + gap;
    }

    return {
        canvas: canvas,
        width: alignedWidth,
        height: height,
        contentWidth: contentWidth,
        fontSize: fontSize,
        gap: gap,
        glyphCount: glyphs.length
    };
}

function readTextConfig() {
    return {
        text: getElement('text-content').value,
        height: parseInt(getElement('text-height').value, 10) || 24,
        font: getElement('text-font').value,
        gap: parseInt(getElement('text-gap').value, 10) || 0,
        threshold: parseInt(getElement('text-threshold').value, 10),
        invert: getElement('text-invert').checked
    };
}

let lastTextRender = null;

// 文字层自己产出渲染源，再走与图片/手绘完全相同的二值化 -> 布局 -> 编码链路；
// 区别只在于 1:1 取源（不再重采样），否则超采样的成果会被第二次缩放抹掉。
function processTextTab() {
    const config = readTextConfig();
    const rendered = renderTextLayer(config.text, config);
    const empty = getElement('text-empty');

    if (!rendered) {
        if (empty) empty.style.display = 'inline';
        getElement('text-size-label').textContent = '';
        return;
    }
    if (empty) empty.style.display = 'none';
    lastTextRender = { config: config, rendered: rendered };

    const width = rendered.width;
    const height = rendered.height;
    getElement('text-size-label').textContent =
        `${width}×${height} · 字号 ${rendered.fontSize} · 内容宽 ${rendered.contentWidth} · 字距 ${rendered.gap} · ${rendered.glyphCount} 字`;

    const previewScale = Math.max(1, Math.min(AppConfig.maxPreviewZoom, Math.floor(480 / Math.max(width, height))));

    const sourceCanvas = getElement('text-source-preview');
    sourceCanvas.width = width * previewScale;
    sourceCanvas.height = height * previewScale;
    const srcCtx = sourceCanvas.getContext('2d');
    srcCtx.imageSmoothingEnabled = false;
    srcCtx.drawImage(rendered.canvas, 0, 0, width * previewScale, height * previewScale);

    const processed = canvasPool.withCanvas(width, height, tempCanvasItem => {
        const tempCtx = tempCanvasItem.ctx;
        tempCtx.clearRect(0, 0, width, height);
        tempCtx.drawImage(rendered.canvas, 0, 0);

        const imageData = tempCtx.getImageData(0, 0, width, height);
        const result = processBinaryImage(
            imageData, 'average', config.threshold, DEFAULT_RGB_THRESHOLDS, config.invert, 'none'
        );

        tempCtx.putImageData(result, 0, 0);
        const previewCanvas = getElement('text-preview');
        previewCanvas.width = width * previewScale;
        previewCanvas.height = height * previewScale;
        const previewCtx = previewCanvas.getContext('2d');
        previewCtx.imageSmoothingEnabled = false;
        previewCtx.drawImage(tempCanvasItem.canvas, 0, 0, width * previewScale, height * previewScale);

        return result;
    });

    scheduleCodeGeneration(processed, width, height);
}

function setupEventListeners() {
    getElement('image-upload').addEventListener('change', handleImageUpload);
    
    getElement('zip-upload').addEventListener('change', handleZipUpload);
    
    setupDropArea('image-drop-area', 'image-upload', handleImageUpload);
    setupDropArea('zip-drop-area', 'zip-upload', handleZipUpload);
    setupDropArea('video-drop-area', 'video-upload', handleVideoUpload);
    
    getElement('video-upload').addEventListener('change', handleVideoUpload);
    
    getElement('threshold-input').addEventListener('input', function(e) {
        getElement('threshold-value').textContent = e.target.value;
        scheduleProcess(processImage);
    });
    
    getElement('video-threshold').addEventListener('input', function(e) {
        getElement('video-threshold-value').textContent = e.target.value;
        scheduleProcess(processVideoFrame);
    });
    
    imageAspectRatioObj = setupSizeAdjustment('width-input', 'height-input', 'lock-ratio', processImage);
    setupSizeButtons('.size-btn', 'width-input', 'height-input', imageAspectRatioObj, processImage);
    setupOriginalRatioButton('original-ratio-btn', 'width-input', 'height-input', imageAspectRatioObj, 'image', processImage);
    
    videoAspectRatioObj = setupSizeAdjustment('video-width', 'video-height', 'video-lock-ratio', processVideoFrame);
    setupSizeButtons('.video-size-btn', 'video-width', 'video-height', videoAspectRatioObj, processVideoFrame);
    setupOriginalRatioButton('video-original-ratio-btn', 'video-width', 'video-height', videoAspectRatioObj, 'video', processVideoFrame);
    
    setupThresholdTypeButtons('.threshold-btn', 'threshold-type', 'rgb-thresholds', 'single-threshold', processImage);
    setupThresholdTypeButtons('.video-threshold-btn', 'video-threshold-type', 'video-rgb-thresholds', 'video-single-threshold', processVideoFrame);
    
    setupRGBThresholds('red-min', 'red-max', 'green-min', 'green-max', 'blue-min', 'blue-max', 'red-min-value', 'red-max-value', 'green-min-value', 'green-max-value', 'blue-min-value', 'blue-max-value', processImage);
    setupRGBThresholds('video-red-min', 'video-red-max', 'video-green-min', 'video-green-max', 'video-blue-min', 'video-blue-max', 'video-red-min-value', 'video-red-max-value', 'video-green-min-value', 'video-green-max-value', 'video-blue-min-value', 'video-blue-max-value', processVideoFrame);
    
    getElement('invert-checkbox').addEventListener('change', processImage);
    getElement('video-invert-checkbox').addEventListener('change', processVideoFrame);
    
    getElement('dither-mode').addEventListener('change', () => scheduleProcess(processImage));
    getElement('video-dither-mode').addEventListener('change', () => scheduleProcess(processVideoFrame));
    
    getElement('auto-threshold-btn').addEventListener('click', () => applyAutoThreshold('image'));
    getElement('video-auto-threshold-btn').addEventListener('click', () => applyAutoThreshold('video'));
    
    getElement('frame-rate').addEventListener('change', processVideo);
    
    getElement('output-format').addEventListener('change', function() {
        refreshCodeNow();
        if (lastRender) updateResultStats(lastRender.width, lastRender.height);
    });
    
    getElement('copy-code-btn').addEventListener('click', copyResultCode);
    
    getElement('export-btn').addEventListener('click', exportResult);
    
    getElement('export-raw-btn').addEventListener('click', exportRawResult);
    
    getElement('refresh-btn').addEventListener('click', refreshResult);
    
    getElement('cancel-export-btn').addEventListener('click', function() {
        cancelVideoExport = true;
        cancelRawExport = true;
        getElement('cancel-export-btn').style.display = 'none';
        getElement('export-progress').style.display = 'none';
        getElement('export-btn').disabled = false;
        getElement('export-raw-btn').disabled = false;
    });
    
    getElement('prev-image-btn').addEventListener('click', showPrevImage);
    getElement('next-image-btn').addEventListener('click', showNextImage);
    
    getElement('draw-btn').addEventListener('click', () => {
        drawMode = true;
        getElement('draw-btn').classList.add('active');
        getElement('erase-btn').classList.remove('active');
    });
    
    getElement('erase-btn').addEventListener('click', () => {
        drawMode = false;
        getElement('erase-btn').classList.add('active');
        getElement('draw-btn').classList.remove('active');
    });
    
    getElement('clear-btn').addEventListener('click', clearCanvas);
    
    getElement('brush-size').addEventListener('input', (e) => {
        brushSize = parseInt(e.target.value);
        getElement('brush-size-value').textContent = brushSize;
    });
    
    getElement('video-preview').addEventListener('timeupdate', function() {
        if (isExportingFrames()) return;
        processVideoFrame();
    });
    
    getElement('video-preview').addEventListener('seeked', function() {
        if (isExportingFrames()) return;
        lastFrameTime = 0;
        processVideoFrame();
    });
    
    getElement('video-preview').addEventListener('play', function() {
        if (isExportingFrames()) return;
        lastFrameTime = 0;
        processVideoFrame();
    });
    
    setupSelectionEvents();
    setupVideoSelectionEvents();
    
    getElement('draw-width').addEventListener('input', resizeDrawCanvas);
    getElement('draw-height').addEventListener('input', resizeDrawCanvas);
    
    getElement('draw-invert-checkbox').addEventListener('change', processDrawCanvas);

    // 文字层：输入即渲染（节流），参数变更立即重排
    let textTimer = null;
    const scheduleTextRender = () => {
        if (textTimer) clearTimeout(textTimer);
        textTimer = setTimeout(processTextTab, 120);
    };
    getElement('text-content').addEventListener('input', scheduleTextRender);
    getElement('text-height').addEventListener('input', scheduleTextRender);
    getElement('text-gap').addEventListener('input', scheduleTextRender);
    getElement('text-font').addEventListener('change', processTextTab);
    getElement('text-invert').addEventListener('change', processTextTab);
    getElement('text-threshold').addEventListener('input', function(e) {
        getElement('text-threshold-value').textContent = e.target.value;
        processTextTab();
    });
    
    setupImportPanel();
    setupCaptureMode();
}

// 浏览器不支持 requestVideoFrameCallback 时明确告知，而不是让它悄悄退回 seek
function setupCaptureMode() {
    const select = getElement('capture-mode');
    if (!select) return;
    if (supportsFrameCallback()) return;
    const option = select.querySelector('option[value="rvfc"]');
    if (option) {
        option.disabled = true;
        option.textContent = '快速（本浏览器不支持，已退回精确）';
    }
    select.value = 'seek';
}

function showPrevImage() {
    if (currentBatchIndex > 0) {
        showBatchImage(currentBatchIndex - 1);
    }
}

function showNextImage() {
    if (currentBatchIndex < batchImages.length - 1) {
        showBatchImage(currentBatchIndex + 1);
    }
}

function refreshResult() {
    if (activeMode === 'image') {
        processImage();
    } else if (activeMode === 'video') {
        processVideoFrame();
    } else if (activeMode === 'draw') {
        processDrawCanvas();
    } else if (activeMode === 'text') {
        processTextTab();
    }
}

async function copyResultCode() {
    refreshCodeNow();
    const code = modeStates[activeMode].resultCode || '';
    const button = getElement('copy-code-btn');
    
    try {
        await navigator.clipboard.writeText(code);
        button.textContent = '已复制';
    } catch (error) {
        button.textContent = '复制失败';
    }
    
    setTimeout(() => { button.textContent = '复制源码'; }, 1200);
}


// ===== 视频抓帧：两种方式同一个回调 =====
// seek：逐帧 seek 到目标时刻再抓。时间准，但每帧一次解码 seek，长视频慢到不能用。
// rvfc：静音播放 + requestVideoFrameCallback，按解码帧的 PTS 采样，快一个量级。
// 两种方式都只负责“给出帧”，二值化/编码/打包由调用方在 onFrame 里做。
const CAPTURE_PLAYBACK_RATE = 4;
const CAPTURE_STALL_MS = 4000;

function supportsFrameCallback() {
    const video = document.getElementById('video-preview');
    return !!(video && typeof video.requestVideoFrameCallback === 'function');
}

function getCaptureMode() {
    const select = document.getElementById('capture-mode');
    const wanted = select ? select.value : 'seek';
    if (wanted === 'rvfc' && !supportsFrameCallback()) return 'seek';
    return wanted === 'rvfc' ? 'rvfc' : 'seek';
}

function updateExportProgress(done, total) {
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    getElement('progress-bar').style.width = percent + '%';
    getElement('progress-text').textContent = `${done}/${total} 帧`;
}

function beginFrameExport(buttonId) {
    getElement(buttonId).disabled = true;
    getElement('cancel-export-btn').style.display = 'inline-flex';
    getElement('export-progress').style.display = 'block';
    updateExportProgress(0, 1);
}

function endFrameExport(buttonId) {
    getElement(buttonId).disabled = false;
    getElement('cancel-export-btn').style.display = 'none';
    getElement('export-progress').style.display = 'none';
}

// seek 到位后必须等“新帧真的呈现出来”再抓：pause 状态下 seeked 触发时，
// decoder 呈现到画布可能还晚一拍，getImageData 会读到上一帧（同参数两次导出哈希不同就是这么来的）。
// rVFC 是唯一可靠的“帧已呈现”信号；没有它就退回 seeked 事件。
function waitForFramePresented(video, targetTime) {
    const sameTime = !video.seeking && Math.abs(video.currentTime - targetTime) < 1e-6;

    if (typeof video.requestVideoFrameCallback !== 'function') {
        return new Promise(resolve => seekFrame(video, targetTime, resolve));
    }

    return new Promise(resolve => {
        let settled = false;
        let handle = null;
        let timer = null;

        const finish = () => {
            if (settled) return;
            settled = true;
            if (handle !== null && typeof video.cancelVideoFrameCallback === 'function') {
                video.cancelVideoFrameCallback(handle);
            }
            clearTimeout(timer);
            resolve();
        };

        handle = video.requestVideoFrameCallback(finish);
        // 同帧重复 seek 时不会再呈现新帧 → 两帧后放行；再兜一道 500ms，绝不挂死
        if (sameTime) requestAnimationFrame(() => requestAnimationFrame(finish));
        timer = setTimeout(finish, 500);
        video.currentTime = targetTime;
    });
}

// 逐帧 seek 抓取指定区间（rvfc 播放先结束时也用它补齐尾部，绝不静默少帧）
async function captureFramesBySeek(options, fromIndex, totalFrames) {
    const video = options.video;
    const frameRate = options.frameRate;
    const lastTime = Math.max(0, video.duration - 0.001);
    let done = fromIndex;
    video.pause();

    for (let index = fromIndex; index < totalFrames; index++) {
        if (options.isCancelled()) return { frames: done, cancelled: true };
        const targetTime = Math.min(index / frameRate, lastTime);
        await waitForFramePresented(video, targetTime);
        await options.onFrame(index, totalFrames);
        done = index + 1;
        if (options.onProgress) options.onProgress(done, totalFrames);
    }

    return { frames: done, cancelled: false };
}

async function captureVideoFrames(options) {
    const video = options.video;
    const frameRate = options.frameRate;
    const totalFrames = Math.max(1, Math.ceil(video.duration * frameRate));

    if (options.mode !== 'rvfc' || typeof video.requestVideoFrameCallback !== 'function') {
        return await captureFramesBySeek(options, 0, totalFrames);
    }

    const wasMuted = video.muted;
    const wasRate = video.playbackRate;
    video.pause();
    video.muted = true;
    try {
        video.currentTime = 0;
    } catch (error) {
        // 元数据未就绪时个别浏览器会抛，直接 play() 会从头开始
    }
    video.playbackRate = CAPTURE_PLAYBACK_RATE;

    let onEnded = null;

    const outcome = await new Promise(resolve => {
        let nextIndex = 0;
        let handle = null;
        let settled = false;
        let stalledTimer = null;

        const stopPlayback = () => {
            if (handle !== null && typeof video.cancelVideoFrameCallback === 'function') {
                video.cancelVideoFrameCallback(handle);
                handle = null;
            }
            video.pause();
            video.muted = wasMuted;
            video.playbackRate = wasRate;
        };

        const settle = (reason) => {
            if (settled) return;
            settled = true;
            clearTimeout(stalledTimer);
            stopPlayback();
            resolve({ reason: reason, nextIndex: nextIndex });
        };

        const armStallGuard = () => {
            clearTimeout(stalledTimer);
            stalledTimer = setTimeout(() => settle('stalled'), CAPTURE_STALL_MS);
        };

        const onVideoFrame = async (now, metadata) => {
            if (settled) return;
            if (options.isCancelled()) { settle('cancelled'); return; }

            const mediaTime = metadata && typeof metadata.mediaTime === 'number'
                ? metadata.mediaTime
                : video.currentTime;

            // 同一个解码帧覆盖所有已到点的目标时刻（源帧率低于导出帧率时就是重复帧）
            while (nextIndex < totalFrames && mediaTime + 1e-4 >= nextIndex / frameRate) {
                const index = nextIndex++;
                await options.onFrame(index, totalFrames);
                if (options.onProgress) options.onProgress(nextIndex, totalFrames);
                if (options.isCancelled()) { settle('cancelled'); return; }
            }

            if (nextIndex >= totalFrames) { settle('done'); return; }
            if (video.ended || mediaTime >= video.duration - 1e-3) { settle('ended'); return; }

            armStallGuard();
            handle = video.requestVideoFrameCallback(onVideoFrame);
        };

        onEnded = () => settle('ended');
        video.addEventListener('ended', onEnded, { once: true });

        armStallGuard();
        handle = video.requestVideoFrameCallback(onVideoFrame);

        const playing = video.play();
        if (playing && typeof playing.catch === 'function') {
            playing.catch(() => settle('playblocked'));
        }
    });

    if (onEnded) video.removeEventListener('ended', onEnded);

    if (outcome.reason === 'cancelled') return { frames: outcome.nextIndex, cancelled: true };
    if (outcome.nextIndex >= totalFrames) return { frames: totalFrames, cancelled: false };

    // 播放先结束 / 解码跟不上 / 自动播放被拦：剩下的帧退回 seek 补齐
    const tail = await captureFramesBySeek(options, outcome.nextIndex, totalFrames);
    return { frames: tail.frames, cancelled: tail.cancelled, filledBySeek: true };
}

function exportResult() {
    if (activeMode === 'video') {
        exportVideo();
    } else {
        exportImage();
    }
}

function exportImage() {
    refreshCodeNow();
    const code = modeStates[activeMode].resultCode;
    if (!code) {
        alert('没有可导出的内容');
        return;
    }
    
    const fileName = getElement('file-name').value || modeStates[activeMode].fileName;
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName}.h`;
    a.click();
    URL.revokeObjectURL(url);
}

async function exportVideo() {
    if (!currentVideo) {
        alert('请先上传一个视频');
        return;
    }

    const video = getElement('video-preview');
    const width = readBitmapSize('video-width');
    const height = readBitmapSize('video-height');
    const frameRate = parseInt(getElement('frame-rate').value);
    const threshold = parseInt(getElement('video-threshold').value);
    const thresholdType = getElement('video-threshold-type').value;
    const invert = getElement('video-invert-checkbox').checked;
    const removeDuplicates = getElement('remove-duplicates').checked;
    const framesPerZip = Math.max(1, parseInt(getElement('frames-per-zip').value) || 300);
    const layoutId = getOutputLayout();

    if (!isFinite(video.duration) || video.duration <= 0) {
        alert('视频时长无效，请等视频加载完成后再导出');
        return;
    }

    isVideoExporting = true;
    cancelVideoExport = false;
    beginFrameExport('export-btn');

    const fileName = getElement('file-name').value || modeStates.video.fileName;
    let frameNumber = 1;
    let zipNumber = 1;
    let currentZipFrames = [];
    let allZipBlobs = [];
    let previousFrameData = null;

    // 上一次导出被中断可能留下占用标记，先清干净
    canvasPool.releaseAll();
    const tempCanvasItem = canvasPool.acquire(width, height);

    async function packageCurrentZip() {
        if (currentZipFrames.length === 0) return;
        const zip = new JSZip();
        currentZipFrames.forEach((frameData) => {
            zip.file(`${fileName}_${frameData.frame}.h`, frameData.code);
        });
        const blob = await zip.generateAsync({ type: 'blob' });
        allZipBlobs.push({ name: `${fileName}_frames_${zipNumber}.zip`, blob: blob });
        currentZipFrames = [];
        zipNumber++;
    }

    async function packageTotalZip() {
        if (allZipBlobs.length === 0) {
            alert('视频导出完成（无帧数据）');
            return;
        }
        const totalZip = new JSZip();
        // JSZip 直接接受 Blob，原来 FileReader 转 ArrayBuffer 等于再复制一整份
        allZipBlobs.forEach((zipData) => totalZip.file(zipData.name, zipData.blob));
        const totalBlob = await totalZip.generateAsync({ type: 'blob' });

        const url = URL.createObjectURL(totalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${fileName}_frames.zip`;
        a.click();
        URL.revokeObjectURL(url);

        allZipBlobs = [];
        alert('视频导出完成');
    }

    try {
        const result = await captureVideoFrames({
            video: video,
            frameRate: frameRate,
            mode: getCaptureMode(),
            isCancelled: () => cancelVideoExport,
            onProgress: updateExportProgress,
            onFrame: async function() {
                const tempCtx = tempCanvasItem.ctx;
                drawSourceIntoCanvas(tempCtx, 'video', width, height);

                const imageData = tempCtx.getImageData(0, 0, width, height);
                const processedImageData = processBinaryImage(
                    imageData, thresholdType, threshold, readRgbThresholds('video-'), invert, readDitherMode('video-')
                );

                let shouldAddFrame = true;
                if (removeDuplicates && previousFrameData) {
                    const currentData = processedImageData.data;
                    const prevData = previousFrameData.data;
                    shouldAddFrame = false;
                    for (let i = 0; i < currentData.length; i++) {
                        if (currentData[i] !== prevData[i]) {
                            shouldAddFrame = true;
                            break;
                        }
                    }
                }

                if (shouldAddFrame) {
                    const code = formatCHeader(encodeBitmap(processedImageData, layoutId), {
                        layoutId: layoutId,
                        width: width,
                        height: height,
                        arrayName: getElement('array-name').value || 'image_bits',
                        widthVar: getElement('width-var').value || 'WIDTH',
                        heightVar: getElement('height-var').value || 'HEIGHT'
                    });
                    currentZipFrames.push({ frame: frameNumber, code: code });
                    frameNumber++;
                    previousFrameData = processedImageData;
                }

                if (currentZipFrames.length >= framesPerZip) await packageCurrentZip();
            }
        });

        if (result.cancelled) return;
        await packageCurrentZip();
        await packageTotalZip();
    } finally {
        canvasPool.release(tempCanvasItem);
        isVideoExporting = false;
        endFrameExport('export-btn');
    }
}

function exportRawResult() {
    if (activeMode === 'video') {
        exportRawVideo();
    } else {
        exportRawImage();
    }
}

function exportRawImage() {
    let imageData, width, height;
    
    if (activeMode === 'image') {
        if (!currentImage) {
            alert('请先上传一张图片');
            return;
        }
        width = readBitmapSize('width-input');
        height = readBitmapSize('height-input');
        const threshold = parseInt(getElement('threshold-input').value);
        const thresholdType = getElement('threshold-type').value;
        const invert = getElement('invert-checkbox').checked;
        
        imageData = canvasPool.withCanvas(width, height, tempCanvasItem => {
            const tempCtx = tempCanvasItem.ctx;
            drawSourceIntoCanvas(tempCtx, 'image', width, height);
            
            const raw = tempCtx.getImageData(0, 0, width, height);
            return processBinaryImage(
                raw, thresholdType, threshold, readRgbThresholds(''), invert, readDitherMode('')
            );
        });
    } else if (activeMode === 'text') {
        const config = readTextConfig();
        const rendered = renderTextLayer(config.text, config);
        if (!rendered) {
            alert('先输入文字');
            return;
        }
        width = rendered.width;
        height = rendered.height;

        imageData = canvasPool.withCanvas(width, height, tempCanvasItem => {
            const tempCtx = tempCanvasItem.ctx;
            tempCtx.clearRect(0, 0, width, height);
            tempCtx.drawImage(rendered.canvas, 0, 0);

            const raw = tempCtx.getImageData(0, 0, width, height);
            return processBinaryImage(
                raw, 'average', config.threshold, DEFAULT_RGB_THRESHOLDS, config.invert, 'none'
            );
        });
    } else if (activeMode === 'draw') {
        width = readBitmapSize('draw-width');
        height = readBitmapSize('draw-height');
        const invert = getElement('draw-invert-checkbox').checked;
        
        imageData = canvasPool.withCanvas(width, height, tempCanvasItem => {
            const tempCtx = tempCanvasItem.ctx;
            tempCtx.drawImage(drawCanvas, 0, 0, width, height);
            
            const pixels = tempCtx.getImageData(0, 0, width, height);
            
            if (invert) {
                const data = pixels.data;
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = 255 - data[i];
                    data[i + 1] = 255 - data[i + 1];
                    data[i + 2] = 255 - data[i + 2];
                }
            }
            
            return pixels;
        });
    }
    
    const layoutId = getOutputLayout();
    
    const bytes = encodeBitmap(imageData, layoutId);
    
    const totalFrames = 1;
    const fps = 10;
    const header = packRawHeader(totalFrames, fps, width, height);
    
    const totalLength = header.length + bytes.length;
    const rawData = new Uint8Array(totalLength);
    rawData.set(header, 0);
    rawData.set(bytes, header.length);
    
    const baseName = getElement('file-name').value || modeStates[activeMode].fileName;
    const filename = generateRawFilename(baseName, width, height, fps, totalFrames);
    
    const blob = new Blob([rawData], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    
    alert(`Raw文件导出完成\n文件名：\n- 分辨率：${width}x${height}\n- 帧数：${totalFrames}\n- 帧率：${fps}fps\n- 输出格式：${getLayout(layoutId).label}`);
}

async function exportRawVideo() {
    if (!currentVideo) {
        alert('请先上传一个视频');
        return;
    }

    const video = getElement('video-preview');
    const width = readBitmapSize('video-width');
    const height = readBitmapSize('video-height');
    const frameRate = parseInt(getElement('frame-rate').value);
    const threshold = parseInt(getElement('video-threshold').value);
    const thresholdType = getElement('video-threshold-type').value;
    const invert = getElement('video-invert-checkbox').checked;
    const removeDuplicates = getElement('remove-duplicates').checked;
    const layoutId = getOutputLayout();

    if (!isFinite(video.duration) || video.duration <= 0) {
        alert('视频时长无效，请等视频加载完成后再导出');
        return;
    }

    isRawExporting = true;
    cancelRawExport = false;
    beginFrameExport('export-raw-btn');

    let allFrameData = [];
    let previousFrameBytes = null;
    let releasedByFinish = false;

    canvasPool.releaseAll();
    const tempCanvasItem = canvasPool.acquire(width, height);

    try {
        const result = await captureVideoFrames({
            video: video,
            frameRate: frameRate,
            mode: getCaptureMode(),
            isCancelled: () => cancelRawExport,
            onProgress: updateExportProgress,
            onFrame: async function() {
                const tempCtx = tempCanvasItem.ctx;
                drawSourceIntoCanvas(tempCtx, 'video', width, height);

                const imageData = tempCtx.getImageData(0, 0, width, height);
                const processedImageData = processBinaryImage(
                    imageData, thresholdType, threshold, readRgbThresholds('video-'), invert, readDitherMode('video-')
                );
                const frameBytes = encodeBitmap(processedImageData, layoutId);

                let shouldAddFrame = true;
                if (removeDuplicates && previousFrameBytes) {
                    shouldAddFrame = false;
                    for (let i = 0; i < frameBytes.length; i++) {
                        if (frameBytes[i] !== previousFrameBytes[i]) {
                            shouldAddFrame = true;
                            break;
                        }
                    }
                }

                if (shouldAddFrame) {
                    allFrameData.push(frameBytes);
                    previousFrameBytes = frameBytes;
                }
            }
        });

        if (result.cancelled) return;
        releasedByFinish = true;
        finishRawExport(width, height, frameRate, allFrameData, layoutId, tempCanvasItem);
    } finally {
        if (!releasedByFinish) canvasPool.release(tempCanvasItem);
        isRawExporting = false;
        endFrameExport('export-raw-btn');
    }
}

function finishRawExport(width, height, fps, allFrameData, layoutId, tempCanvasItem) {
    if (tempCanvasItem) {
        canvasPool.release(tempCanvasItem);
    }

    const totalFrames = allFrameData.length;

    const header = packRawHeader(totalFrames, fps, width, height);

    let totalDataSize = 0;
    for (const frameData of allFrameData) {
        totalDataSize += frameData.length;
    }

    const rawData = new Uint8Array(header.length + totalDataSize);
    rawData.set(header, 0);
    let offset = header.length;
    for (const frameData of allFrameData) {
        rawData.set(frameData, offset);
        offset += frameData.length;
    }

    const baseName = getElement('file-name').value || modeStates.video.fileName;
    const filename = generateRawFilename(baseName, width, height, fps, totalFrames);

    const blob = new Blob([rawData], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    alert(`Raw视频导出完成！\n\n- 分辨率：${width}x${height}\n- 帧数：${totalFrames}\n- 帧率：${fps}fps\n- 输出格式：${getLayout(layoutId).label}`);
}

// ===== 反导入：位流 -> 预览（自检闭环）=====
// 判据不是「字节好看」，而是能不能解回来看到图：格式选错时预览立刻错位/成雪花。
const importState = {
    bytes: null,
    payload: null,
    width: 0,
    height: 0,
    frames: 0,
    fps: 0,
    frame: 0,
    frameSize: 0,
    layoutId: DEFAULT_LAYOUT,
    note: ''
};

function getImportLayout() {
    const select = document.getElementById('import-format');
    if (select && BITMAP_LAYOUTS[select.value]) return select.value;
    return DEFAULT_LAYOUT;
}

// 接受 0xNN 形式，或去掉分隔符后成对的十六进制
function parseHexByteStream(text) {
    const bytes = [];
    const prefixed = text.match(/0x[0-9a-fA-F]{1,2}/g);
    if (prefixed) {
        prefixed.forEach(token => bytes.push(parseInt(token.slice(2), 16)));
        return new Uint8Array(bytes);
    }
    const cleaned = text.replace(/[^0-9a-fA-F]/g, '');
    for (let i = 0; i + 1 < cleaned.length; i += 2) {
        bytes.push(parseInt(cleaned.substr(i, 2), 16));
    }
    return new Uint8Array(bytes);
}

function readRawHeader(bytes) {
    if (bytes.length < 12) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames = view.getUint32(0, true);
    const fps = view.getUint32(4, true);
    const width = view.getUint16(8, true);
    const height = view.getUint16(10, true);
    if (!width || !height) return null;
    if (width > AppConfig.maxBitmapSize || height > AppConfig.maxBitmapSize) return null;
    return { frames: frames, fps: fps, width: width, height: height };
}

function updateImportPreview() {
    const canvas = getElement('import-canvas');
    const empty = getElement('import-empty');
    const stats = getElement('import-stats');
    const state = importState;

    if (!state.bytes || !state.frames) {
        canvas.style.display = 'none';
        empty.style.display = 'inline';
        stats.textContent = '';
        return;
    }

    const offset = state.frame * state.frameSize;
    const slice = state.payload.subarray(offset, offset + state.frameSize);
    const canonical = decodeBitmap(slice, state.width, state.height, state.layoutId);
    const imageData = canonicalToImageData(canonical, state.width, state.height);

    canvas.width = state.width;
    canvas.height = state.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);

    // 整数倍放大，保持像素锐利
    const scale = Math.max(1, Math.min(8, Math.floor(480 / Math.max(state.width, state.height))));
    canvas.style.width = state.width * scale + 'px';
    canvas.style.height = state.height * scale + 'px';
    canvas.style.display = 'block';
    empty.style.display = 'none';

    let setBits = 0;
    for (let i = 0; i < canonical.length; i++) {
        let byte = canonical[i];
        while (byte) {
            setBits += byte & 1;
            byte >>= 1;
        }
    }

    const layout = getLayout(state.layoutId);
    stats.textContent = `${state.width}×${state.height} · ${layout.label} · 每帧 ${state.frameSize} B`
        + ` · 第 ${state.frame + 1}/${state.frames} 帧`
        + ` · 有效位 ${state.width * state.height} / 位流 ${state.frameSize * 8}`
        + ` · 置位 ${setBits}`
        + (state.note ? ` · ${state.note}` : '');
}

// 会被文件、粘贴、切格式、改宽高四条路径复用，所以统一收在这里
function loadImportedData(bytes, layoutId, forcedWidth, forcedHeight) {
    if (!bytes || !bytes.length) {
        alert('没有可解析的数据');
        return;
    }

    const header = readRawHeader(bytes);
    const state = importState;
    let payload = bytes;
    let width = 0;
    let height = 0;
    let fps = 0;
    let note = '';

    if (header) {
        payload = bytes.subarray(12);
        width = header.width;
        height = header.height;
        fps = header.fps;
        if (header.frames && header.frames !== Math.floor(payload.length / layoutBufferSize(width, height, layoutId))) {
            note = `头声明 ${header.frames} 帧`;
        }
    } else {
        width = forcedWidth || parseInt(getElement('import-width').value) || 0;
        height = forcedHeight || parseInt(getElement('import-height').value) || 0;
        if (!width || !height) {
            alert('没读到 .raw 头（12 字节：帧数/帧率/宽/高）。\n请填宽高，或确认导入的是本工具导出的 .raw。');
            return;
        }
    }

    width = Math.max(1, Math.min(AppConfig.maxBitmapSize, width));
    height = Math.max(1, Math.min(AppConfig.maxBitmapSize, height));

    const frameSize = layoutBufferSize(width, height, layoutId);
    const frames = Math.floor(payload.length / frameSize);
    const layout = getLayout(layoutId);

    if (frames < 1) {
        alert(`数据不足：一个 ${width}×${height} 的「${layout.label}」帧需要 ${frameSize} 字节，`
            + `实际只有 ${payload.length} 字节。\n多半是格式选错了，或宽高填错了。`);
        return;
    }

    state.bytes = bytes;
    state.payload = payload;
    state.width = width;
    state.height = height;
    state.frames = frames;
    state.fps = fps;
    state.frame = 0;
    state.frameSize = frameSize;
    state.layoutId = layoutId;
    state.note = note;

    getElement('import-width').value = width;
    getElement('import-height').value = height;
    updateImportPreview();
}

function stepImportFrame(delta) {
    if (!importState.frames) return;
    importState.frame = (importState.frame + delta + importState.frames) % importState.frames;
    updateImportPreview();
}

function readImportFile(file) {
    const name = (file.name || '').toLowerCase();
    if (/\.(h|c|txt|hex)$/.test(name)) {
        const reader = new FileReader();
        reader.onload = function() {
            const bytes = parseHexByteStream(String(reader.result || ''));
            if (!bytes.length) {
                alert('文件里没有找到十六进制字节（需要 0xNN）');
                return;
            }
            loadImportedData(bytes, getImportLayout(), 0, 0);
        };
        reader.readAsText(file);
        return;
    }

    const reader = new FileReader();
    reader.onload = function() {
        loadImportedData(new Uint8Array(reader.result), getImportLayout(), 0, 0);
    };
    reader.readAsArrayBuffer(file);
}

function setupImportPanel() {
    getElement('import-file').addEventListener('change', function(e) {
        const file = e.target.files && e.target.files[0];
        if (file) readImportFile(file);
    });

    getElement('import-btn').addEventListener('click', function() {
        const hex = getElement('import-hex').value;
        if (hex.trim()) {
            const bytes = parseHexByteStream(hex);
            if (!bytes.length) {
                alert('没有解析出字节：需要 0xNN 或成对的十六进制');
                return;
            }
            loadImportedData(bytes, getImportLayout(), 0, 0);
            return;
        }

        const file = getElement('import-file').files && getElement('import-file').files[0];
        if (!file) {
            alert('先选择文件，或粘贴字节流');
            return;
        }
        readImportFile(file);
    });

    // 切格式 / 改宽高都重新解一遍：格式选错时预览会立刻变样，这就是判据
    getElement('import-format').addEventListener('change', function() {
        if (importState.bytes) loadImportedData(importState.bytes, getImportLayout(), 0, 0);
    });

    ['import-width', 'import-height'].forEach(function(id) {
        getElement(id).addEventListener('change', function() {
            if (importState.bytes && !readRawHeader(importState.bytes)) {
                loadImportedData(importState.bytes, getImportLayout(), 0, 0);
            }
        });
    });

    getElement('import-prev-btn').addEventListener('click', function() { stepImportFrame(-1); });
    getElement('import-next-btn').addEventListener('click', function() { stepImportFrame(1); });
}

// ===== 回归预言机：布局自洽 + 跨格式等价 =====
// 判据不是「字节相同」（不同布局字节本来就不同），而是「解码回权威缓冲后逐字节相同」。
function makeTestCanonical(width, height, pattern) {
    const canonical = new Uint8Array(canonicalBufferSize(width, height));
    const hBytes = Math.ceil(width / 8);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let on = false;
            if (pattern === 'leftBlack') on = x >= width / 2;
            else if (pattern === 'topBlack') on = y >= height / 2;
            else if (pattern === 'checker1') on = ((x + y) & 1) === 0;
            else if (pattern === 'checker3') on = ((Math.floor(x / 3) + Math.floor(y / 3)) % 2) === 0;
            else if (pattern === 'allOn') on = true;
            if (!on) continue;
            canonical[y * hBytes + (x >> 3)] |= 1 << (7 - (x & 7));
        }
    }

    return canonical;
}

function runBitmapSelfTest() {
    const layouts = Object.keys(BITMAP_LAYOUTS);
    const shapes = [[64, 64], [128, 64], [37, 23], [9, 9], [1, 1], [64, 9], [8, 8], [1, 37]];
    const patterns = ['leftBlack', 'topBlack', 'checker1', 'checker3', 'allOn'];
    const failures = [];
    let cases = 0;

    for (const shape of shapes) {
        const width = shape[0];
        const height = shape[1];

        for (const pattern of patterns) {
            const canonical = makeTestCanonical(width, height, pattern);

            for (const layoutId of layouts) {
                cases++;
                const expectedSize = layoutBufferSize(width, height, layoutId);
                const encoded = transferBits(canonical, width, height, layoutId, true);

                if (encoded.length !== expectedSize) {
                    failures.push(`${layoutId} ${width}x${height} ${pattern}: 长度 ${encoded.length} != ${expectedSize}`);
                    continue;
                }

                const decoded = transferBits(encoded, width, height, layoutId, false);
                for (let i = 0; i < canonical.length; i++) {
                    if (decoded[i] !== canonical[i]) {
                        failures.push(`${layoutId} ${width}x${height} ${pattern}: 往返第 ${i} 字节不等`);
                        break;
                    }
                }

                // 跨格式：所有布局解回来必须是同一张图
                const reference = transferBits(canonical, width, height, DEFAULT_LAYOUT, true);
                if (reference.length !== canonical.length) {
                    failures.push(`${DEFAULT_LAYOUT} ${width}x${height} ${pattern}: 权威长度不等`);
                    break;
                }
                for (let i = 0; i < reference.length; i++) {
                    if (decoded[i] !== reference[i]) {
                        failures.push(`跨格式 ${layoutId} ${width}x${height} ${pattern}: 第 ${i} 字节不等`);
                        break;
                    }
                }
            }
        }
    }

    // 位序黄金值：8x8 只点亮 (0,0)，row_msb 首位 0x80，row_lsb 首位 0x01
    cases += 2;
    const dot = new Uint8Array(canonicalBufferSize(8, 8));
    dot[0] = 0x80;
    const dotMsb = transferBits(dot, 8, 8, 'row_msb', true);
    const dotLsb = transferBits(dot, 8, 8, 'row_lsb', true);
    if (dotMsb[0] !== 0x80) failures.push(`row_msb (0,0) 应为 0x80，实际 0x${dotMsb[0].toString(16)}`);
    if (dotLsb[0] !== 0x01) failures.push(`row_lsb (0,0) 应为 0x01，实际 0x${dotLsb[0].toString(16)}`);

    // 页模式黄金值：128x64 单点 (5,11) -> 索引 (11>>3)*128+5 = 133，位 11&7 = 3
    cases += 3;
    const single = new Uint8Array(canonicalBufferSize(128, 64));
    single[11 * 16 + (5 >> 3)] |= 1 << (7 - (5 & 7));
    const pageBytes = transferBits(single, 128, 64, 'page_lsb', true);
    if (pageBytes.length !== 1024) failures.push(`page_lsb 128x64 应为 1024 字节，实际 ${pageBytes.length}`);
    if (pageBytes[133] !== 0x08) failures.push(`page_lsb (5,11) 应在字节 133 的 bit3，实际 0x${pageBytes[133].toString(16)}`);
    let setBytes = 0;
    for (let i = 0; i < pageBytes.length; i++) if (pageBytes[i]) setBytes++;
    if (setBytes !== 1) failures.push(`page_lsb 单点应只占 1 个非零字节，实际 ${setBytes}`);

    // 真实管线：ImageData -> 二值化 -> 页模式 -> 解回，与权威缓冲逐字节相等
    cases += 2;
    const pipelineWidth = 37;
    const pipelineHeight = 23;
    const image = new ImageData(pipelineWidth, pipelineHeight);
    for (let y = 0; y < pipelineHeight; y++) {
        for (let x = 0; x < pipelineWidth; x++) {
            const value = x >= pipelineWidth / 2 ? 255 : 0;
            const offset = (y * pipelineWidth + x) * 4;
            image.data[offset] = value;
            image.data[offset + 1] = value;
            image.data[offset + 2] = value;
            image.data[offset + 3] = 255;
        }
    }
    const pipelineBytes = encodeBitmap(image, 'page_lsb');
    const pipelineBack = decodeBitmap(pipelineBytes, pipelineWidth, pipelineHeight, 'page_lsb');
    const pipelineRef = packBitmapBytes(image);
    if (pipelineBytes.length !== layoutBufferSize(pipelineWidth, pipelineHeight, 'page_lsb')) {
        failures.push('管线：页模式字节数不符');
    }
    for (let i = 0; i < pipelineRef.length; i++) {
        if (pipelineBack[i] !== pipelineRef[i]) {
            failures.push(`管线：第 ${i} 字节与权威缓冲不等`);
            break;
        }
    }

    return {
        pass: failures.length === 0,
        cases: cases,
        layouts: layouts.length,
        shapes: shapes.length,
        patterns: patterns.length,
        failures: failures
    };
}

// 控制台里跑一次：window.bitmapSelfTest()

// 文字层自检（浏览器限定：需要 canvas + 字体，Node 侧没有 font 引擎）
// 对照物是「排版不变量」而不是某个具体字形的像素——字形随系统字体变，不变量不该变。
function runTextLayerSelfTest() {
    const cases = [];
    const failures = [];
    const record = (name, ok, detail) => {
        cases.push(name);
        if (!ok) failures.push(detail === undefined ? name : name + ' :: ' + JSON.stringify(detail));
    };

    const renderBinary = (text, options, threshold, invert) => {
        const rendered = renderTextLayer(text, options);
        if (!rendered) return null;
        const result = canvasPool.withCanvas(rendered.width, rendered.height, item => {
            const ctx = item.ctx;
            ctx.clearRect(0, 0, rendered.width, rendered.height);
            ctx.drawImage(rendered.canvas, 0, 0);
            const raw = ctx.getImageData(0, 0, rendered.width, rendered.height);
            return processBinaryImage(raw, 'average', threshold, DEFAULT_RGB_THRESHOLDS, invert, 'none');
        });
        let ink = 0;
        const columnInk = new Array(rendered.width).fill(0);
        for (let y = 0; y < rendered.height; y++) {
            for (let x = 0; x < rendered.width; x++) {
                if (result.data[(y * rendered.width + x) * 4] > 128) {
                    ink++;
                    columnInk[x]++;
                }
            }
        }
        return { rendered, result, ink, columnInk, width: rendered.width, height: rendered.height };
    };

    const base = renderBinary('艺术字', { height: 24 }, 128, false);
    record('文字层：能渲染出墨迹', !!base && base.ink > 0, base && base.ink);
    if (!base) return { pass: false, cases, failures };

    record('文字层：宽度对齐到 8', base.width % 8 === 0, base.width);
    record('文字层：高度不超过字号', base.height <= base.rendered.fontSize + 1,
           [base.height, base.rendered.fontSize]);
    record('文字层：字号即渲染字号', renderTextLayer('字', { height: 32 }).fontSize === 32);

    // 字间至少一列全零：数全零列游程
    let runs = 0, run = 0;
    for (let x = 0; x < base.width; x++) {
        if (base.columnInk[x] === 0) run++;
        else { if (run > 0) runs++; run = 0; }
    }
    if (run > 0) runs++;
    record('文字层：字间有空白列', runs >= 2, { runs, gap: base.rendered.gap });

    // 基线对齐：墨迹下沿之差必须等于两个字 descent 之差。
    // 不能断言"下沿齐平"——雅黑里「口」本身就比基线低 2px（字体设计如此），
    // 齐平才是错的。真正要保证的是：同一个基线被所有字一致地引用。
    const mixed = renderBinary('口A', { height: 24 }, 128, false);
    const bottomRuns = (() => {
        const cols = [];
        for (let x = 0; x < mixed.width; x++) {
            let has = false;
            for (let y = 0; y < mixed.height; y++) {
                if (mixed.result.data[(y * mixed.width + x) * 4] > 128) { has = true; break; }
            }
            cols.push(has);
        }
        const runs = [];
        let start = -1;
        for (let x = 0; x < cols.length; x++) {
            if (cols[x] && start < 0) start = x;
            if (!cols[x] && start >= 0) { runs.push([start, x - 1]); start = -1; }
        }
        if (start >= 0) runs.push([start, cols.length - 1]);
        return runs.map(pair => {
            let bottom = -1;
            for (let y = 0; y < mixed.height; y++) {
                for (let x = pair[0]; x <= pair[1]; x++) {
                    if (mixed.result.data[(y * mixed.width + x) * 4] > 128) bottom = Math.max(bottom, y);
                }
            }
            return { x0: pair[0], x1: pair[1], bottom: bottom };
        });
    })();

    if (bottomRuns.length === 2) {
        const kou = renderGlyphCanvas('口', 24, '"Microsoft YaHei", "PingFang SC", sans-serif');
        const capA = renderGlyphCanvas('A', 24, '"Microsoft YaHei", "PingFang SC", sans-serif');
        const expected = kou.descent - capA.descent;
        const actual = bottomRuns[0].bottom - bottomRuns[1].bottom;
        record('文字层：基线一致（下沿差 = descent 差）', actual === expected,
               { actual: actual, expected: expected, 口: bottomRuns[0], A: bottomRuns[1] });
    } else {
        record('文字层：基线一致（下沿差 = descent 差）', false, { runs: bottomRuns.length });
    }

    // 反色是互补
    const inverted = renderBinary('艺术字', { height: 24 }, 128, true);
    record('文字层：反色互补', Math.abs(base.ink + inverted.ink - base.width * base.height) <= 2,
           { ink: base.ink, inkInverted: inverted.ink, total: base.width * base.height });

    // 阈值单调：白字黑底下抬高阈值只会少墨
    const tight = renderBinary('艺术字', { height: 24 }, 200, false);
    const loose = renderBinary('艺术字', { height: 24 }, 80, false);
    record('文字层：阈值单调（高阈值墨量更少）', tight.ink < base.ink && base.ink < loose.ink,
           { at200: tight.ink, at128: base.ink, at80: loose.ink });

    // 四种布局都能整字节落位
    for (const layoutId of Object.keys(BITMAP_LAYOUTS)) {
        const bytes = encodeBitmap(base.result, layoutId);
        record('文字层：' + layoutId + ' 字节数', bytes.length === layoutBufferSize(base.width, base.height, layoutId),
               { got: bytes.length, want: layoutBufferSize(base.width, base.height, layoutId) });
    }

    // 渲染确定性：同输入两次必须同一字节流（否则导出的资产不可复现）
    const again = renderBinary('艺术字', { height: 24 }, 128, false);
    const a = encodeBitmap(base.result, 'row_msb');
    const b = encodeBitmap(again.result, 'row_msb');
    let identical = a.length === b.length;
    if (identical) {
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { identical = false; break; }
    }
    record('文字层：渲染确定性', identical, { bytes: a.length });

    return { pass: failures.length === 0, cases: cases.length, failures: failures, cases_list: cases };
}

window.textLayerSelfTest = runTextLayerSelfTest;



// ===== 对外 API（页面 / node / agent 共用同一份实现）=====
// 只暴露纯计算入口：不读 DOM、不改 UI 状态，因此能被 cli.mjs 用 vm 直接加载。
// 加新输出格式时先让这里能调到，再谈 UI。
const DEFAULT_RGB_THRESHOLDS = {
    redMin: 0, redMax: 255,
    greenMin: 0, greenMax: 255,
    blueMin: 0, blueMax: 255
};

function requireBitmapSize(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
        throw new Error(`宽高必须是正数，收到 ${width}x${height}`);
    }
    if (w > AppConfig.maxBitmapSize || h > AppConfig.maxBitmapSize) {
        throw new Error(`宽高上限 ${AppConfig.maxBitmapSize}，收到 ${w}x${h}`);
    }
    return { width: Math.floor(w), height: Math.floor(h) };
}

function requireLayoutId(layoutId) {
    const id = layoutId || DEFAULT_LAYOUT;
    if (!BITMAP_LAYOUTS[id]) {
        throw new Error(`未知布局 ${id}；可用：${Object.keys(BITMAP_LAYOUTS).join(', ')}`);
    }
    return id;
}

const toBitMapApi = {
    version: '1.7',

    // 可用布局（给 agent 自描述用）
    layouts() {
        return Object.keys(BITMAP_LAYOUTS).map(function(id) {
            const layout = BITMAP_LAYOUTS[id];
            return { id: id, axis: layout.axis, bitOrder: layout.bitOrder, label: layout.label, hint: layout.hint };
        });
    },

    // 指定布局的字节数
    bufferSize(width, height, layoutId) {
        const size = requireBitmapSize(width, height);
        return layoutBufferSize(size.width, size.height, requireLayoutId(layoutId));
    },

    // ImageData -> 二值化后的 ImageData（阈值 / 抖动都在这里，DOM 无关）
    binarize(imageData, options) {
        const opts = options || {};
        if (!imageData || !imageData.width || !imageData.height) {
            throw new Error('binarize 需要一个 ImageData 对象');
        }
        return processBinaryImage(
            imageData,
            opts.thresholdType || 'average',
            opts.threshold === undefined ? 128 : Number(opts.threshold),
            opts.rgbThresholds || DEFAULT_RGB_THRESHOLDS,
            !!opts.invert,
            opts.dither || 'none'
        );
    },

    // ImageData -> 位流
    encode(imageData, options) {
        const opts = options || {};
        const layoutId = requireLayoutId(opts.layout);
        const data = opts.binarize === false ? imageData : this.binarize(imageData, opts);
        return encodeBitmap(data, layoutId);
    },

    // 任意可绘制源（canvas / img / video）-> 位流，内部走同一套分步降采样
    encodeCanvas(source, options) {
        const opts = options || {};
        const size = requireBitmapSize(opts.width, opts.height);
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        drawSourceDownscaled(ctx, source, opts.crop || null, size.width, size.height);
        const imageData = ctx.getImageData(0, 0, size.width, size.height);
        return this.encode(imageData, opts);
    },

    // 位流 -> 权威缓冲（行优先 MSB）
    decode(bytes, options) {
        const opts = options || {};
        const size = requireBitmapSize(opts.width, opts.height);
        const layoutId = requireLayoutId(opts.layout);
        if (!bytes || typeof bytes.length !== 'number') {
            throw new Error('decode 需要一个 Uint8Array / 字节数组');
        }
        return decodeBitmap(Uint8Array.from(bytes), size.width, size.height, layoutId);
    },

    // 权威缓冲（行优先 MSB）-> 位流：布局互转用，不重新二值化
    encodeCanonical(canonical, options) {
        const opts = options || {};
        const size = requireBitmapSize(opts.width, opts.height);
        const layoutId = requireLayoutId(opts.layout);
        const source = Uint8Array.from(canonical || []);
        const expected = canonicalBufferSize(size.width, size.height);
        if (source.length !== expected) {
            throw new Error(`权威缓冲应为 ${expected} 字节，收到 ${source.length}`);
        }
        if (layoutId === DEFAULT_LAYOUT) return source;
        return transferBits(source, size.width, size.height, layoutId, true);
    },

    // 位流 -> C 源码
    toCHeader(bytes, options) {
        const opts = options || {};
        const size = requireBitmapSize(opts.width, opts.height);
        const layoutId = requireLayoutId(opts.layout);
        return formatCHeader(Uint8Array.from(bytes), {
            width: size.width,
            height: size.height,
            arrayName: opts.arrayName || 'image_bits',
            widthVar: opts.widthVar || 'WIDTH',
            heightVar: opts.heightVar || 'HEIGHT',
            layoutId: layoutId
        });
    },

    // 多帧 + 12 字节头 -> .raw
    packRaw(frames, options) {
        const opts = options || {};
        const size = requireBitmapSize(opts.width, opts.height);
        const layoutId = requireLayoutId(opts.layout);
        const frameSize = layoutBufferSize(size.width, size.height, layoutId);
        const list = Array.from(frames || []);
        if (list.length === 0) throw new Error('packRaw 至少需要一帧');
        for (const frame of list) {
            if (frame.length !== frameSize) {
                throw new Error(`帧长 ${frame.length} 与布局 ${layoutId} 要求的 ${frameSize} 不符`);
            }
        }
        const header = packRawHeader(list.length, Number(opts.fps) || 10, size.width, size.height);
        const total = header.length + frameSize * list.length;
        const out = new Uint8Array(total);
        out.set(header, 0);
        list.forEach(function(frame, index) {
            out.set(frame, header.length + index * frameSize);
        });
        return out;
    },

    // .raw -> { width, height, fps, frames, frameSize, layoutHint }
    parseRaw(buffer, options) {
        const opts = options || {};
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const header = readRawHeader(bytes);
        if (!header) throw new Error('没有合法的 12 字节 .raw 头（帧数/帧率/宽/高）');
        const layoutId = requireLayoutId(opts.layout);
        const frameSize = layoutBufferSize(header.width, header.height, layoutId);
        return {
            width: header.width,
            height: header.height,
            fps: header.fps,
            frames: Math.floor((bytes.length - 12) / frameSize),
            frameSize: frameSize,
            layout: layoutId,
            payload: bytes.subarray(12)
        };
    },

    selfTest: runBitmapSelfTest
};

window.toBitMap = toBitMapApi;

window.bitmapSelfTest = runBitmapSelfTest;

window.addEventListener('DOMContentLoaded', init);
