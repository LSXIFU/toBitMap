/*
========================================
工具原作者：栢爅
Github：LSXIFU
哔哩哔哩UID：402603542
版本：1.1优化版 | 使用Trae IDE AI工具制作 | 2026/3/8 | 免费自用、不允许商用 | 使用请注明原作者
优化内容：GPU加速、内存管理优化、Web Worker支持
========================================
*/

const AppConfig = {
    maxPreviewSize: 400,
    maxCanvasSize: 400,
    defaultSize: 32,
    canvasPoolSize: 4,
    workerEnabled: true
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

// CPU 二值化。与着色器同语义：'individual' 用三通道区间掩码求均，再与同一阈值比较
// （原来这里写死 128，导致该模式下「颜色阈值」滑杆在 CPU 路径完全无效）。
// 不就地改写传入的 ImageData，返回新的 ImageData。
function binarizeImageData(imageData, thresholdType, threshold, rgbThresholds, invert) {
    const source = imageData.data;
    const data = new Uint8ClampedArray(source);
    
    if (thresholdType === 'individual') {
        const redMin = parseInt(rgbThresholds.redMin);
        const redMax = parseInt(rgbThresholds.redMax);
        const greenMin = parseInt(rgbThresholds.greenMin);
        const greenMax = parseInt(rgbThresholds.greenMax);
        const blueMin = parseInt(rgbThresholds.blueMin);
        const blueMax = parseInt(rgbThresholds.blueMax);
        
        for (let i = 0; i < data.length; i += 4) {
            const r = (data[i] >= redMin && data[i] <= redMax) ? 255 : 0;
            const g = (data[i + 1] >= greenMin && data[i + 1] <= greenMax) ? 255 : 0;
            const b = (data[i + 2] >= blueMin && data[i + 2] <= blueMax) ? 255 : 0;
            
            const avg = (r + g + b) / 3;
            let binaryValue = avg < threshold ? 0 : 255;
            
            if (invert) {
                binaryValue = binaryValue === 0 ? 255 : 0;
            }
            
            data[i] = binaryValue;
            data[i + 1] = binaryValue;
            data[i + 2] = binaryValue;
        }
    } else {
        for (let i = 0; i < data.length; i += 4) {
            let value;
            if (thresholdType === 'rgb') {
                value = (data[i] + data[i + 1] + data[i + 2]) / 3;
            } else {
                value = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            }
            
            let binaryValue = value < threshold ? 0 : 255;
            
            if (invert) {
                binaryValue = binaryValue === 0 ? 255 : 0;
            }
            
            data[i] = binaryValue;
            data[i + 1] = binaryValue;
            data[i + 2] = binaryValue;
        }
    }
    
    return new ImageData(data, imageData.width, imageData.height);
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
            return binarizeImageData(imageData, thresholdType, threshold, rgbThresholds, invert);
        }
        
        const gl = this.gl;
        const width = imageData.width;
        const height = imageData.height;
        
        gl.canvas.width = width;
        gl.canvas.height = height;
        gl.viewport(0, 0, width, height);
        
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        
        const program = this.programs.binary;
        gl.useProgram(program);
        
        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 1, -1, -1, 1,
            -1, 1, 1, -1, 1, 1
        ]), gl.STATIC_DRAW);
        
        const positionLoc = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
        
        const texCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0, 1, 1, 1, 0, 0,
            0, 0, 1, 1, 1, 0
        ]), gl.STATIC_DRAW);
        
        const texCoordLoc = gl.getAttribLocation(program, 'a_texCoord');
        gl.enableVertexAttribArray(texCoordLoc);
        gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 0, 0);
        
        gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);
        gl.uniform1f(gl.getUniformLocation(program, 'u_threshold'), threshold / 255);
        gl.uniform1i(gl.getUniformLocation(program, 'u_thresholdType'), thresholdTypeToIndex(thresholdType));
        gl.uniform1f(gl.getUniformLocation(program, 'u_redMin'), parseInt(rgbThresholds.redMin) / 255);
        gl.uniform1f(gl.getUniformLocation(program, 'u_redMax'), parseInt(rgbThresholds.redMax) / 255);
        gl.uniform1f(gl.getUniformLocation(program, 'u_greenMin'), parseInt(rgbThresholds.greenMin) / 255);
        gl.uniform1f(gl.getUniformLocation(program, 'u_greenMax'), parseInt(rgbThresholds.greenMax) / 255);
        gl.uniform1f(gl.getUniformLocation(program, 'u_blueMin'), parseInt(rgbThresholds.blueMin) / 255);
        gl.uniform1f(gl.getUniformLocation(program, 'u_blueMax'), parseInt(rgbThresholds.blueMax) / 255);
        gl.uniform1i(gl.getUniformLocation(program, 'u_invert'), invert ? 1 : 0);
        
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        
        const outputData = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, outputData);
        
        gl.deleteTexture(texture);
        gl.deleteBuffer(positionBuffer);
        gl.deleteBuffer(texCoordBuffer);
        
        const resultData = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const srcIdx = ((height - 1 - y) * width + x) * 4;
                const dstIdx = (y * width + x) * 4;
                resultData[dstIdx] = outputData[srcIdx];
                resultData[dstIdx + 1] = outputData[srcIdx + 1];
                resultData[dstIdx + 2] = outputData[srcIdx + 2];
                resultData[dstIdx + 3] = 255;
            }
        }
        
        return new ImageData(resultData, width, height);
    }
    
    isAvailable() {
        return this.initialized;
    }
}

class ImageProcessingWorker {
    constructor() {
        this.worker = null;
        this.pendingCallbacks = new Map();
        this.callbackId = 0;
        this.enabled = AppConfig.workerEnabled;
        this.init();
    }
    
    init() {
        if (!this.enabled || typeof Worker === 'undefined') {
            return;
        }
        
        const workerCode = `
            self.onmessage = function(e) {
                const { id, type, data } = e.data;
                
                switch (type) {
                    case 'generateCode':
                        const result = generateCodeFromData(data);
                        self.postMessage({ id, result });
                        break;
                    case 'imageDataToBytes':
                        const bytes = imageDataToBytesWorker(data);
                        self.postMessage({ id, result: bytes }, [bytes.buffer]);
                        break;
                }
            };
            
            function generateCodeFromData(data) {
                const { imageData, width, height, fileName, arrayName, widthVar, heightVar } = data;
                const pixelData = imageData.data;
                const bits = [];
                
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x += 8) {
                        let byte = 0;
                        for (let i = 0; i < 8 && x + i < width; i++) {
                            const index = (y * width + x + i) * 4;
                            const value = pixelData[index] > 128 ? 1 : 0;
                            byte |= value << (7 - i);
                        }
                        bits.push(byte.toString(16).padStart(2, '0'));
                    }
                }
                
                let code = '#define ' + widthVar.toUpperCase() + ' ' + width + '\\n';
                code += '#define ' + heightVar.toUpperCase() + ' ' + height + '\\n';
                code += 'static const unsigned char ' + arrayName + '[] PROGMEM = {\\n';
                
                for (let i = 0; i < bits.length; i += 8) {
                    const row = bits.slice(i, i + 8).map(b => '0x' + b).join(', ');
                    code += '  ' + row + ',\\n';
                }
                
                code += '};\\n';
                return code;
            }
            
            function imageDataToBytesWorker(data) {
                const { imageData, reverseBitOrder, width, height } = data;
                const pixels = imageData.data;
                const bytes = [];
                const bytesPerRow = Math.ceil(width / 8);
                
                function reverseBits(byte) {
                    let result = 0;
                    for (let i = 0; i < 8; i++) {
                        result = (result << 1) | ((byte >> i) & 1);
                    }
                    return result;
                }
                
                for (let y = 0; y < height; y++) {
                    for (let rowByte = 0; rowByte < bytesPerRow; rowByte++) {
                        let byte = 0;
                        for (let bit = 0; bit < 8; bit++) {
                            const x = rowByte * 8 + bit;
                            if (x < width) {
                                const index = (y * width + x) * 4;
                                const value = pixels[index] > 128 ? 1 : 0;
                                byte |= value << (7 - bit);
                            }
                        }
                        if (reverseBitOrder) {
                            bytes.push(reverseBits(byte));
                        } else {
                            bytes.push(byte);
                        }
                    }
                }
                return new Uint8Array(bytes);
            }
        `;
        
        try {
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            this.worker = new Worker(URL.createObjectURL(blob));
            
            this.worker.onmessage = (e) => {
                const { id, result } = e.data;
                const callback = this.pendingCallbacks.get(id);
                if (callback) {
                    callback(result);
                    this.pendingCallbacks.delete(id);
                }
            };
        } catch (e) {
            console.warn('Web Worker initialization failed:', e);
            this.worker = null;
        }
    }
    
    generateCodeAsync(imageData, width, height, fileName, arrayName, widthVar, heightVar) {
        return new Promise((resolve) => {
            if (!this.worker) {
                resolve(this._generateCodeSync(imageData, width, height, fileName, arrayName, widthVar, heightVar));
                return;
            }
            
            const id = this.callbackId++;
            this.pendingCallbacks.set(id, resolve);
            
            const transferable = {
                id,
                type: 'generateCode',
                data: {
                    imageData: { data: imageData.data, width: imageData.width, height: imageData.height },
                    width,
                    height,
                    fileName,
                    arrayName,
                    widthVar,
                    heightVar
                }
            };
            
            this.worker.postMessage(transferable, [imageData.data.buffer]);
        });
    }
    
    imageDataToBytesAsync(imageData, reverseBitOrder, width, height) {
        return new Promise((resolve) => {
            if (!this.worker) {
                resolve(this._imageDataToBytesSync(imageData, reverseBitOrder, width, height));
                return;
            }
            
            const id = this.callbackId++;
            this.pendingCallbacks.set(id, resolve);
            
            this.worker.postMessage({
                id,
                type: 'imageDataToBytes',
                data: {
                    imageData: { data: imageData.data, width: imageData.width, height: imageData.height },
                    reverseBitOrder,
                    width,
                    height
                }
            }, [imageData.data.buffer]);
        });
    }
    
    _generateCodeSync(imageData, width, height, fileName, arrayName, widthVar, heightVar) {
        const data = imageData.data;
        const bits = [];
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x += 8) {
                let byte = 0;
                for (let i = 0; i < 8 && x + i < width; i++) {
                    const index = (y * width + x + i) * 4;
                    const value = data[index] > 128 ? 1 : 0;
                    byte |= value << (7 - i);
                }
                bits.push(byte.toString(16).padStart(2, '0'));
            }
        }
        
        let code = `#define ${widthVar.toUpperCase()} ${width}\n`;
        code += `#define ${heightVar.toUpperCase()} ${height}\n`;
        code += `static const unsigned char ${arrayName}[] PROGMEM = {\n`;
        
        for (let i = 0; i < bits.length; i += 8) {
            const row = bits.slice(i, i + 8).map(b => `0x${b}`).join(', ');
            code += `  ${row},\n`;
        }
        
        code += `};\n`;
        return code;
    }
    
    _imageDataToBytesSync(imageData, reverseBitOrder, width, height) {
        const data = imageData.data;
        const bytes = [];
        const bytesPerRow = Math.ceil(width / 8);
        
        const reverseBits = (byte) => {
            let result = 0;
            for (let i = 0; i < 8; i++) {
                result = (result << 1) | ((byte >> i) & 1);
            }
            return result;
        };
        
        for (let y = 0; y < height; y++) {
            for (let rowByte = 0; rowByte < bytesPerRow; rowByte++) {
                let byte = 0;
                for (let bit = 0; bit < 8; bit++) {
                    const x = rowByte * 8 + bit;
                    if (x < width) {
                        const index = (y * width + x) * 4;
                        const value = data[index] > 128 ? 1 : 0;
                        byte |= value << (7 - bit);
                    }
                }
                if (reverseBitOrder) {
                    bytes.push(reverseBits(byte));
                } else {
                    bytes.push(byte);
                }
            }
        }
        return new Uint8Array(bytes);
    }
    
    isAvailable() {
        return this.worker !== null;
    }
}

let canvasPool = null;
let glProcessor = null;
let imageWorker = null;
let currentImage = null;
let currentVideo = null;
let rafId = null;
let pendingProcess = null;

function reverse_bits(byte) {
    let result = 0;
    for (let i = 0; i < 8; i++) {
        result = (result << 1) | ((byte >> i) & 1);
    }
    return result;
}

function imageDataToBytes(imageData, reverseBitOrder = false) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    const bytes = [];
    const bytesPerRow = Math.ceil(width / 8);
    
    for (let y = 0; y < height; y++) {
        for (let rowByte = 0; rowByte < bytesPerRow; rowByte++) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit++) {
                const x = rowByte * 8 + bit;
                if (x < width) {
                    const index = (y * width + x) * 4;
                    const value = data[index] > 128 ? 1 : 0;
                    byte |= value << (7 - bit);
                }
            }
            if (reverseBitOrder) {
                bytes.push(reverse_bits(byte));
            } else {
                bytes.push(byte);
            }
        }
    }
    return new Uint8Array(bytes);
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
    imageWorker = new ImageProcessingWorker();
    
    drawCanvas = document.getElementById('draw-canvas');
    drawCtx = drawCanvas.getContext('2d', { willReadFrequently: true });
    
    setupTabs();
    setupEventListeners();
    setupDrawCanvas();
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

function processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert) {
    if (glProcessor && glProcessor.isAvailable()) {
        return glProcessor.processBinary(imageData, thresholdType, threshold, rgbThresholds, invert);
    }
    return binarizeImageData(imageData, thresholdType, threshold, rgbThresholds, invert);
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
function drawSourceIntoCanvas(ctx, mode, width, height) {
    const source = mode === 'image' ? currentImage : getElement('video-preview');
    const crop = getSelectionSourceRect(mode);
    
    ctx.clearRect(0, 0, width, height);
    if (!source) return;
    
    if (crop) {
        ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    } else {
        ctx.drawImage(source, 0, 0, width, height);
    }
}

function generateCode(imageData, width, height) {
    const data = imageData.data;
    const bits = [];
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x += 8) {
            let byte = 0;
            for (let i = 0; i < 8 && x + i < width; i++) {
                const index = (y * width + x + i) * 4;
                const value = data[index] > 128 ? 1 : 0;
                byte |= value << (7 - i);
            }
            bits.push(byte.toString(16).padStart(2, '0'));
        }
    }
    
    const fileName = getElement('file-name').value || modeStates[activeMode].fileName;
    const arrayName = getElement('array-name').value || 'image_bits';
    const widthVar = getElement('width-var').value || 'WIDTH';
    const heightVar = getElement('height-var').value || 'HEIGHT';
    
    modeStates[activeMode].fileName = fileName;
    modeStates[activeMode].arrayName = arrayName;
    modeStates[activeMode].widthVar = widthVar;
    modeStates[activeMode].heightVar = heightVar;
    
    let code = `#define ${widthVar.toUpperCase()} ${width}\n`;
    code += `#define ${heightVar.toUpperCase()} ${height}\n`;
    code += `static const unsigned char ${arrayName}[] PROGMEM = {\n`;
    
    for (let i = 0; i < bits.length; i += 8) {
        const row = bits.slice(i, i + 8).map(b => `0x${b}`).join(', ');
        code += `  ${row},\n`;
    }
    
    code += `};\n`;
    
    modeStates[activeMode].resultCode = code;
    getElement('result-code').textContent = code;
}

function handleImageUpload(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    
    if (files.length > 1) {
        loadBatchFromFiles(files);
        return;
    }
    
    const file = files[0];
    modeStates.image.fileName = file.name.split('.').slice(0, -1).join('.');
    
    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            if (currentImage && currentImage.src) {
                URL.revokeObjectURL(currentImage.src);
            }
            currentImage = img;
            modeStates.image.originalSize = { width: img.width, height: img.height };
            
            const imageInfo = getElement('image-info');
            const width = img.width;
            const height = img.height;
            const aspectRatio = (width / height).toFixed(2);
            
            imageInfo.innerHTML = `原图信息: ${width}x${height} (${aspectRatio}:1), 24位彩色`;
            
            if (imageAspectRatioObj) {
                imageAspectRatioObj.aspectRatio = width / height;
            }
            
            applyLockedRatio('image', 'width-input', 'height-input', 'lock-ratio');
            
            processImage();
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
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
    
    getElement('batch-controls').style.display = 'block';
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
        invert: false
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
        invert: getElement('invert-checkbox').checked
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
    
    const width = parseInt(getElement('width-input').value) || 16;
    const height = parseInt(getElement('height-input').value) || 16;
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
    
    const scaleFactor = Math.min(10, maxCanvasSize / Math.max(width, height));
    
    binaryCanvas.width = width * scaleFactor;
    binaryCanvas.height = height * scaleFactor;
    
    const rgbThresholds = {
        redMin: getElement('red-min').value,
        redMax: getElement('red-max').value,
        greenMin: getElement('green-min').value,
        greenMax: getElement('green-max').value,
        blueMin: getElement('blue-min').value,
        blueMax: getElement('blue-max').value
    };
    
    const processedImageData = canvasPool.withCanvas(width, height, tempCanvasItem => {
        const tempCtx = tempCanvasItem.ctx;
        drawSourceIntoCanvas(tempCtx, 'image', width, height);
        
        const imageData = tempCtx.getImageData(0, 0, width, height);
        const processed = processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert);
        
        tempCtx.putImageData(processed, 0, 0);
        binaryCtx.imageSmoothingEnabled = false;
        binaryCtx.drawImage(tempCanvasItem.canvas, 0, 0, width * scaleFactor, height * scaleFactor);
        
        return processed;
    });
    
    generateCode(processedImageData, width, height);
}

function processVideo() {
    lastFrameTime = 0;
}

function processVideoFrame() {
    if (!currentVideo) return;
    
    const width = parseInt(getElement('video-width').value);
    const height = parseInt(getElement('video-height').value);
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
        
        const scaleFactor = Math.min(10, maxCanvasSize / Math.max(width, height));
        
        canvas.width = width * scaleFactor;
        canvas.height = height * scaleFactor;
        
        const rgbThresholds = {
            redMin: getElement('video-red-min').value,
            redMax: getElement('video-red-max').value,
            greenMin: getElement('video-green-min').value,
            greenMax: getElement('video-green-max').value,
            blueMin: getElement('video-blue-min').value,
            blueMax: getElement('video-blue-max').value
        };
        
        const processedImageData = canvasPool.withCanvas(width, height, tempCanvasItem => {
            const tempCtx = tempCanvasItem.ctx;
            drawSourceIntoCanvas(tempCtx, 'video', width, height);
            
            const imageData = tempCtx.getImageData(0, 0, width, height);
            const processed = processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert);
            
            tempCtx.putImageData(processed, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(tempCanvasItem.canvas, 0, 0, width * scaleFactor, height * scaleFactor);
            
            return processed;
        });
        
        generateCode(processedImageData, width, height);
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
    return Math.min(10, maxCanvasSize / Math.max(width, height));
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
    
    const scaleFactor = Math.min(10, maxCanvasSize / Math.max(width, height));
    
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
    
    generateCode(imageData, width, height);
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
    
    getElement('frame-rate').addEventListener('change', processVideo);
    
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
    }
}

function exportResult() {
    if (activeMode === 'video') {
        exportVideo();
    } else {
        exportImage();
    }
}

function exportImage() {
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

function exportVideo() {
    if (!currentVideo) {
        alert('请先上传一个视频');
        return;
    }
    
    isVideoExporting = true;
    cancelVideoExport = false;
    getElement('export-btn').disabled = true;
    getElement('cancel-export-btn').style.display = 'inline-block';
    getElement('export-progress').style.display = 'block';
    
    const video = getElement('video-preview');
    const width = parseInt(getElement('video-width').value);
    const height = parseInt(getElement('video-height').value);
    const frameRate = parseInt(getElement('frame-rate').value);
    const threshold = parseInt(getElement('video-threshold').value);
    const thresholdType = getElement('video-threshold-type').value;
    const invert = getElement('video-invert-checkbox').checked;
    const removeDuplicates = getElement('remove-duplicates').checked;
    const framesPerZip = Math.max(1, parseInt(getElement('frames-per-zip').value) || 300);
    
    if (!isFinite(video.duration) || video.duration <= 0) {
        alert('视频时长无效，请等视频加载完成后再导出');
        return;
    }
    
    // 导出期间暂停播放：timeupdate/seeked 的预览处理会与逐帧抓取抢同一块临时 canvas
    video.pause();
    
    const totalFrames = Math.max(1, Math.ceil(video.duration * frameRate));
    let processedFrames = 0;
    let currentFrame = 0;
    let frameNumber = 1;
    let zipNumber = 1;
    let currentZipFrames = [];
    let allZipBlobs = [];
    let previousFrameData = null;
    
    // 上一次导出被中断可能留下占用标记，先清干净
    canvasPool.releaseAll();
    const tempCanvasItem = canvasPool.acquire(width, height);
    
    function processNextFrame() {
        if (cancelVideoExport) {
            isVideoExporting = false;
            canvasPool.release(tempCanvasItem);
            getElement('export-btn').disabled = false;
            getElement('cancel-export-btn').style.display = 'none';
            getElement('export-progress').style.display = 'none';
            return;
        }
        
        if (currentFrame >= totalFrames) {
            if (currentZipFrames.length > 0) {
                packageCurrentZip(() => {
                    packageTotalZip();
                });
            } else {
                packageTotalZip();
            }
            return;
        }
        
        const currentTime = currentFrame / frameRate;
        
        seekFrame(video, currentTime, function() {
            
            const tempCtx = tempCanvasItem.ctx;
            drawSourceIntoCanvas(tempCtx, 'video', width, height);
            
            const imageData = tempCtx.getImageData(0, 0, width, height);
            
            const rgbThresholds = {
                redMin: getElement('video-red-min').value,
                redMax: getElement('video-red-max').value,
                greenMin: getElement('video-green-min').value,
                greenMax: getElement('video-green-max').value,
                blueMin: getElement('video-blue-min').value,
                blueMax: getElement('video-blue-max').value
            };
            
            const processedImageData = processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert);
            
            let shouldAddFrame = true;
            if (removeDuplicates && previousFrameData) {
                const currentData = processedImageData.data;
                const prevData = previousFrameData.data;
                
                for (let i = 0; i < currentData.length; i++) {
                    if (currentData[i] !== prevData[i]) {
                        shouldAddFrame = true;
                        break;
                    }
                    shouldAddFrame = false;
                }
            }
            
            if (shouldAddFrame) {
                const data = processedImageData.data;
                const bits = [];
                
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x += 8) {
                        let byte = 0;
                        for (let i = 0; i < 8 && x + i < width; i++) {
                            const index = (y * width + x + i) * 4;
                            const value = data[index] > 128 ? 1 : 0;
                            byte |= value << (7 - i);
                        }
                        bits.push(byte.toString(16).padStart(2, '0'));
                    }
                }
                
                const fileName = getElement('file-name').value || modeStates.video.fileName;
                const arrayName = getElement('array-name').value || 'image_bits';
                const widthVar = getElement('width-var').value || 'WIDTH';
                const heightVar = getElement('height-var').value || 'HEIGHT';
                
                let code = `#define ${widthVar.toUpperCase()} ${width}\n`;
                code += `#define ${heightVar.toUpperCase()} ${height}\n`;
                code += `static const unsigned char ${arrayName}[] PROGMEM = {\n`;
                
                for (let i = 0; i < bits.length; i += 8) {
                    const row = bits.slice(i, i + 8).map(b => `0x${b}`).join(', ');
                    code += `  ${row},\n`;
                }
                
                code += `};\n`;
                
                currentZipFrames.push({ frame: frameNumber, code: code });
                frameNumber++;
                
                previousFrameData = processedImageData;
            }
            
            processedFrames++;
            const progress = Math.round((processedFrames / totalFrames) * 100);
            getElement('progress-bar').style.width = `${progress}%`;
            getElement('progress-text').textContent = `${processedFrames}/${totalFrames} 帧`;
            
            if (currentZipFrames.length >= framesPerZip) {
                packageCurrentZip(() => {
                    currentZipFrames = [];
                    zipNumber++;
                    currentFrame++;
                    processNextFrame();
                });
            } else {
                currentFrame++;
                processNextFrame();
            }
        });
    }
    
    function packageCurrentZip(callback) {
        const fileName = getElement('file-name').value || modeStates.video.fileName;
        const zip = new JSZip();
        
        currentZipFrames.forEach((frameData) => {
            zip.file(`${fileName}_${frameData.frame}.h`, frameData.code);
        });
        
        zip.generateAsync({ type: 'blob' }).then(function(blob) {
            allZipBlobs.push({ name: `${fileName}_frames_${zipNumber}.zip`, blob: blob });
            callback();
        });
    }
    
    function packageTotalZip() {
        canvasPool.release(tempCanvasItem);
        
        const fileName = getElement('file-name').value || modeStates.video.fileName;
        const totalZip = new JSZip();
        let processedZips = 0;
        
        if (allZipBlobs.length === 0) {
            isVideoExporting = false;
            getElement('export-btn').disabled = false;
            getElement('cancel-export-btn').style.display = 'none';
            getElement('export-progress').style.display = 'none';
            alert('视频导出完成（无帧数据）');
            return;
        }
        
        allZipBlobs.forEach((zipData) => {
            const reader = new FileReader();
            reader.onload = function(e) {
                totalZip.file(zipData.name, e.target.result);
                processedZips++;
                
                if (processedZips === allZipBlobs.length) {
                    totalZip.generateAsync({ type: 'blob' }).then(function(totalBlob) {
                        const url = URL.createObjectURL(totalBlob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${fileName}_frames.zip`;
                        a.click();
                        URL.revokeObjectURL(url);
                        
                        allZipBlobs = [];
                        isVideoExporting = false;
                        getElement('export-btn').disabled = false;
                        getElement('cancel-export-btn').style.display = 'none';
                        getElement('export-progress').style.display = 'none';
                        alert('视频导出完成');
                    });
                }
            };
            reader.readAsArrayBuffer(zipData.blob);
        });
    }
    
    processNextFrame();
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
        width = parseInt(getElement('width-input').value) || 16;
        height = parseInt(getElement('height-input').value) || 16;
        const threshold = parseInt(getElement('threshold-input').value);
        const thresholdType = getElement('threshold-type').value;
        const invert = getElement('invert-checkbox').checked;
        
        const rgbThresholds = {
            redMin: getElement('red-min').value,
            redMax: getElement('red-max').value,
            greenMin: getElement('green-min').value,
            greenMax: getElement('green-max').value,
            blueMin: getElement('blue-min').value,
            blueMax: getElement('blue-max').value
        };
        
        imageData = canvasPool.withCanvas(width, height, tempCanvasItem => {
            const tempCtx = tempCanvasItem.ctx;
            drawSourceIntoCanvas(tempCtx, 'image', width, height);
            
            const raw = tempCtx.getImageData(0, 0, width, height);
            return processBinaryImage(raw, thresholdType, threshold, rgbThresholds, invert);
        });
    } else if (activeMode === 'draw') {
        width = parseInt(getElement('draw-width').value) || 16;
        height = parseInt(getElement('draw-height').value) || 16;
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
    
    const reverseBits = getElement('reverse-bits').checked;
    
    const bytes = imageDataToBytes(imageData, reverseBits);
    
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
    
    alert(`Raw文件导出完成\n文件名：\n- 分辨率：${width}x${height}\n- 帧数：${totalFrames}\n- 帧率：${fps}fps\n- 位序反转：${reverseBits ? '是' : '否'}`);
}

function exportRawVideo() {
    if (!currentVideo) {
        alert('请先上传一个视频');
        return;
    }
    
    isRawExporting = true;
    cancelRawExport = false;
    getElement('export-raw-btn').disabled = true;
    getElement('cancel-export-btn').style.display = 'inline-block';
    getElement('export-progress').style.display = 'block';
    
    const video = getElement('video-preview');
    const width = parseInt(getElement('video-width').value);
    const height = parseInt(getElement('video-height').value);
    const frameRate = parseInt(getElement('frame-rate').value);
    const threshold = parseInt(getElement('video-threshold').value);
    const thresholdType = getElement('video-threshold-type').value;
    const invert = getElement('video-invert-checkbox').checked;
    const removeDuplicates = getElement('remove-duplicates').checked;
    
    if (!isFinite(video.duration) || video.duration <= 0) {
        alert('视频时长无效，请等视频加载完成后再导出');
        return;
    }
    
    video.pause();
    
    const totalFrames = Math.max(1, Math.ceil(video.duration * frameRate));
    let processedFrames = 0;
    let currentFrame = 0;
    let allFrameData = [];
    let previousFrameBytes = null;
    
    const reverseBits = getElement('reverse-bits').checked;
    
    canvasPool.releaseAll();
    const tempCanvasItem = canvasPool.acquire(width, height);
    
    function processNextRawFrame() {
        if (cancelRawExport) {
            isRawExporting = false;
            canvasPool.release(tempCanvasItem);
            getElement('export-raw-btn').disabled = false;
            getElement('cancel-export-btn').style.display = 'none';
            getElement('export-progress').style.display = 'none';
            return;
        }
        
        if (currentFrame >= totalFrames) {
            finishRawExport(width, height, frameRate, allFrameData, reverseBits, tempCanvasItem);
            return;
        }
        
        const currentTime = currentFrame / frameRate;
        
        seekFrame(video, currentTime, function() {
            
            const tempCtx = tempCanvasItem.ctx;
            drawSourceIntoCanvas(tempCtx, 'video', width, height);
            
            const imageData = tempCtx.getImageData(0, 0, width, height);
            const rgbThresholds = {
                redMin: getElement('video-red-min').value,
                redMax: getElement('video-red-max').value,
                greenMin: getElement('video-green-min').value,
                greenMax: getElement('video-green-max').value,
                blueMin: getElement('video-blue-min').value,
                blueMax: getElement('video-blue-max').value
            };
            const processedImageData = processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert);
            const frameBytes = imageDataToBytes(processedImageData, reverseBits);
            
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
            
            processedFrames++;
            const progress = Math.round((processedFrames / totalFrames) * 100);
            getElement('progress-bar').style.width = `${progress}%`;
            getElement('progress-text').textContent = `${processedFrames}/${totalFrames} 帧`;
            
            currentFrame++;
            processNextRawFrame();
        });
    }
    
    processNextRawFrame();
}

function finishRawExport(width, height, fps, allFrameData, reverseBits, tempCanvasItem) {
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
    
    allFrameData = [];
    
    isRawExporting = false;
    getElement('export-raw-btn').disabled = false;
    getElement('cancel-export-btn').style.display = 'none';
    getElement('export-progress').style.display = 'none';
    
    alert(`Raw视频导出完成！\n\n- 分辨率：${width}x${height}\n- 帧数：${totalFrames}\n- 帧率：${fps}fps\n- 位序反转：${reverseBits ? '是' : '否'}`);
}

window.addEventListener('DOMContentLoaded', init);
