/*
========================================
工具原作者：栢爅
Github：LSXIFU
哔哩哔哩UID：402603542
版本：1.0自用测试版 | 使用Trae IDE AI工具制作 | 2026/3/8 | 免费自用、不允许商用 | 使用请注明原作者
========================================
*/

// 全局变量和配置
const AppConfig = {
    maxPreviewSize: 400,
    maxCanvasSize: 400,
    defaultSize: 32,
    minSize: 16
};

// 模式状态管理
const modeStates = {
    image: {
        fileName: 'image',
        arrayName: 'image_bits',
        widthVar: 'WIDTH',
        heightVar: 'HEIGHT',
        resultCode: '',
        originalSize: { width: 0, height: 0 },
        previewScale: 1,
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
        previewScale: 1,
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

// 当前激活的模式
let activeMode = 'image';

// 视频导出相关变量
let isVideoExporting = false; // 视频导出是否正在进行
let cancelVideoExport = false; // 是否取消视频导出

// 批量处理相关变量
let batchImages = []; // 存储批量处理的图片
let currentBatchIndex = 0; // 当前处理的图片索引
let imageSettings = []; // 存储每张图片的设置

// 框选相关变量
let isSelecting = false;
let isResizing = false;
let isDragging = false;
let resizeHandle = null; // 当前正在使用的调整手柄
let dragOffset = { x: 0, y: 0 }; // 拖动偏移量

// 视频相关变量
let lastFrameTime = 0;
let currentVideoBlobUrl = null; // 存储当前视频的blob URL

// 手绘相关变量
let drawMode = true; // true: 绘制, false: 橡皮擦
let brushSize = 1;
let drawCanvas = document.getElementById('draw-canvas');
let drawCtx = drawCanvas.getContext('2d');
let isDrawing = false;

// 初始化
function init() {
    setupTabs();
    setupEventListeners();
    setupDrawCanvas();
}

// 工具函数
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

// 设置拖放区域功能
function setupDropArea(dropAreaId, inputId, handleUpload) {
    const dropArea = getElement(dropAreaId);
    const input = getElement(inputId);
    
    // 防止默认拖放行为
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, preventDefaults, false);
    });
    
    // 高亮拖放区域
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
    
    // 处理拖放文件
    dropArea.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        
        // 模拟文件输入框的change事件
        input.files = files;
        handleUpload({ target: input });
    }, false);
}

// 设置标签页切换
function setupTabs() {
    const tabBtns = getElements('.tab-btn');
    const tabContents = getElements('.tab-content');
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            
            // 保存当前模式的设置
            modeStates[activeMode].resultCode = getElement('result-code').textContent;
            modeStates[activeMode].fileName = getElement('file-name').value || modeStates[activeMode].fileName;
            modeStates[activeMode].arrayName = getElement('array-name').value || 'image_bits';
            modeStates[activeMode].widthVar = getElement('width-var').value || 'WIDTH';
            modeStates[activeMode].heightVar = getElement('height-var').value || 'HEIGHT';
            
            // 更新当前激活的模式
            activeMode = tab;
            
            // 移除所有活动状态
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            // 添加当前活动状态
            btn.classList.add('active');
            getElement(`${tab}-tab`).classList.add('active');
            
            // 恢复当前模式的设置
            getElement('result-code').textContent = modeStates[activeMode].resultCode;
            getElement('file-name').value = modeStates[activeMode].fileName;
            getElement('array-name').value = modeStates[activeMode].arrayName;
            getElement('width-var').value = modeStates[activeMode].widthVar;
            getElement('height-var').value = modeStates[activeMode].heightVar;
        });
    });
}

// 设置大小调整事件
function setupSizeAdjustment(widthInputId, heightInputId, lockRatioId, processFunc) {
    let aspectRatio = 1; // 初始比例
    let isUpdating = false; // 防止递归更新
    
    // 宽度输入变化
    getElement(widthInputId).addEventListener('input', function() {
        if (isUpdating) return;
        
        const width = parseInt(this.value) || 1;
        
        if (getElement(lockRatioId).checked) {
            isUpdating = true;
            const height = Math.round(width / aspectRatio);
            getElement(heightInputId).value = height;
            isUpdating = false;
        } else {
            // 更新比例
            const height = parseInt(getElement(heightInputId).value) || 1;
            aspectRatio = width / height;
        }
        
        processFunc();
    });
    
    // 高度输入变化
    getElement(heightInputId).addEventListener('input', function() {
        if (isUpdating) return;
        
        const height = parseInt(this.value) || 1;
        
        if (getElement(lockRatioId).checked) {
            isUpdating = true;
            const width = Math.round(height * aspectRatio);
            getElement(widthInputId).value = width;
            isUpdating = false;
        } else {
            // 更新比例
            const width = parseInt(getElement(widthInputId).value) || 1;
            aspectRatio = width / height;
        }
        
        processFunc();
    });
    
    return { aspectRatio, isUpdating };
}

// 设置常用大小按钮
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
                
                // 更新比例
                aspectRatioObj.aspectRatio = width / height;
            }
            
            processFunc();
        });
    });
}

// 设置原图比例按钮
function setupOriginalRatioButton(buttonId, widthInputId, heightInputId, aspectRatioObj, mode, processFunc) {
    getElement(buttonId).addEventListener('click', function() {
        const originalSize = modeStates[mode].originalSize;
        if (originalSize.width > 0 && originalSize.height > 0) {
            // 计算原图比例
            const originalRatio = originalSize.width / originalSize.height;
            
            // 使用当前输入框中的值作为基准大小
            const currentWidth = parseInt(getElement(widthInputId).value) || AppConfig.defaultSize;
            const currentHeight = parseInt(getElement(heightInputId).value) || AppConfig.defaultSize;
            
            // 计算当前输入框的平均大小作为基准
            const baseSize = Math.round((currentWidth + currentHeight) / 2);
            let newWidth, newHeight;
            
            if (originalRatio > 1) {
                // 宽屏，以宽度为基准
                newWidth = baseSize;
                newHeight = Math.round(baseSize / originalRatio);
            } else {
                // 竖屏，以高度为基准
                newHeight = baseSize;
                newWidth = Math.round(baseSize * originalRatio);
            }
            
            // 确保尺寸不小于16
            newWidth = Math.max(AppConfig.minSize, newWidth);
            newHeight = Math.max(AppConfig.minSize, newHeight);
            
            // 更新输入框
            aspectRatioObj.isUpdating = true;
            getElement(widthInputId).value = newWidth;
            getElement(heightInputId).value = newHeight;
            aspectRatioObj.isUpdating = false;
            
            // 更新比例
            aspectRatioObj.aspectRatio = originalRatio;
            
            processFunc();
        } else {
            alert('请先上传一个文件');
        }
    });
}

// 设置阈值类型按钮
function setupThresholdTypeButtons(selector, thresholdTypeInputId, rgbThresholdsId, singleThresholdId, processFunc) {
    getElements(selector).forEach(btn => {
        btn.addEventListener('click', function() {
            const thresholdType = this.dataset.type;
            
            // 更新按钮状态
            getElements(selector).forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            // 更新隐藏输入值
            getElement(thresholdTypeInputId).value = thresholdType;
            
            // 显示/隐藏相应的阈值控件
            const rgbThresholds = getElement(rgbThresholdsId);
            const singleThreshold = getElement(singleThresholdId);
            
            if (thresholdType === 'individual') {
                rgbThresholds.style.display = 'block';
                singleThreshold.style.display = 'none';
            } else {
                rgbThresholds.style.display = 'none';
                singleThreshold.style.display = 'block';
            }
            
            processFunc();
        });
    });
}

// 设置RGB区间调整
function setupRGBThresholds(redMinId, redMaxId, greenMinId, greenMaxId, blueMinId, blueMaxId, redMinValueId, redMaxValueId, greenMinValueId, greenMaxValueId, blueMinValueId, blueMaxValueId, processFunc) {
    getElement(redMinId).addEventListener('input', function() {
        getElement(redMinValueId).textContent = this.value;
        processFunc();
    });
    getElement(redMaxId).addEventListener('input', function() {
        getElement(redMaxValueId).textContent = this.value;
        processFunc();
    });
    getElement(greenMinId).addEventListener('input', function() {
        getElement(greenMinValueId).textContent = this.value;
        processFunc();
    });
    getElement(greenMaxId).addEventListener('input', function() {
        getElement(greenMaxValueId).textContent = this.value;
        processFunc();
    });
    getElement(blueMinId).addEventListener('input', function() {
        getElement(blueMinValueId).textContent = this.value;
        processFunc();
    });
    getElement(blueMaxId).addEventListener('input', function() {
        getElement(blueMaxValueId).textContent = this.value;
        processFunc();
    });
}

// 通用二值化处理
function processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert) {
    const data = imageData.data;
    
    if (thresholdType === 'individual') {
        const redMin = parseInt(rgbThresholds.redMin);
        const redMax = parseInt(rgbThresholds.redMax);
        const greenMin = parseInt(rgbThresholds.greenMin);
        const greenMax = parseInt(rgbThresholds.greenMax);
        const blueMin = parseInt(rgbThresholds.blueMin);
        const blueMax = parseInt(rgbThresholds.blueMax);
        
        for (let i = 0; i < data.length; i += 4) {
            const r = (data[i] >= redMin && data[i] <= redMax) ? 255 : 0;
            const g = (data[i+1] >= greenMin && data[i+1] <= greenMax) ? 255 : 0;
            const b = (data[i+2] >= blueMin && data[i+2] <= blueMax) ? 255 : 0;
            
            // 计算平均值作为最终二值化结果
            const avg = (r + g + b) / 3;
            let binaryValue = avg < 128 ? 0 : 255;
            
            // 检查是否需要反转
            if (invert) {
                binaryValue = binaryValue === 0 ? 255 : 0;
            }
            
            data[i] = binaryValue;
            data[i+1] = binaryValue;
            data[i+2] = binaryValue;
        }
    } else {
        for (let i = 0; i < data.length; i += 4) {
            let value;
            if (thresholdType === 'rgb') {
                value = (data[i] + data[i+1] + data[i+2]) / 3;
            } else {
                value = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
            }
            
            let binaryValue = value < threshold ? 0 : 255;
            
            // 检查是否需要反转
            if (invert) {
                binaryValue = binaryValue === 0 ? 255 : 0;
            }
            
            data[i] = binaryValue;
            data[i+1] = binaryValue;
            data[i+2] = binaryValue;
        }
    }
    
    return imageData;
}

// 计算预览尺寸
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

// 生成C语言代码
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
    
    // 获取导出设置
    const fileName = getElement('file-name').value || modeStates[activeMode].fileName;
    const arrayName = getElement('array-name').value || 'image_bits';
    const widthVar = getElement('width-var').value || 'WIDTH';
    const heightVar = getElement('height-var').value || 'HEIGHT';
    
    // 保存到当前模式的状态中
    modeStates[activeMode].fileName = fileName;
    modeStates[activeMode].arrayName = arrayName;
    modeStates[activeMode].widthVar = widthVar;
    modeStates[activeMode].heightVar = heightVar;
    
    // 生成代码
    let code = `#define ${widthVar.toUpperCase()} ${width}\n`;
    code += `#define ${heightVar.toUpperCase()} ${height}\n`;
    code += `static const unsigned char ${arrayName}[] PROGMEM = {\n`;
    
    for (let i = 0; i < bits.length; i += 8) {
        const row = bits.slice(i, i + 8).map(b => `0x${b}`).join(', ');
        code += `  ${row},\n`;
    }
    
    code += `};\n`;
    
    // 存储到当前模式的状态中
    modeStates[activeMode].resultCode = code;
    
    // 显示代码
    getElement('result-code').textContent = code;
}

// 处理图片上传
function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // 提取文件名（不含扩展名）
    modeStates.image.fileName = file.name.split('.').slice(0, -1).join('.');
    
    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            currentImage = img;
            modeStates.image.originalSize = { width: img.width, height: img.height };
            
            // 显示原图信息
            const imageInfo = getElement('image-info');
            const width = img.width;
            const height = img.height;
            const aspectRatio = (width / height).toFixed(2);
            
            imageInfo.innerHTML = `原图信息: ${width}x${height} (${aspectRatio}:1), 24位彩色`;
            
            processImage();
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
}

// 处理压缩包上传
function handleZipUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // 检查文件扩展名
    const fileName = file.name.toLowerCase();
    const supportedFormats = ['.zip'];
    const additionalFormats = ['.7z', '.rar', '.tar', '.tar.gz', '.tar.bz2', '.tgz', '.tbz2'];
    
    const fileExtension = fileName.substring(fileName.lastIndexOf('.'));
    
    // 检查是否为支持的格式
    if (!supportedFormats.includes(fileExtension) && !additionalFormats.includes(fileExtension)) {
        alert('不支持的文件格式，请上传ZIP、7Z、RAR或TAR格式的压缩包。');
        return;
    }
    
    // 检查是否为JSZip支持的格式
    if (!supportedFormats.includes(fileExtension)) {
        alert('当前版本仅支持ZIP格式的压缩包，其他格式将在后续版本中支持。');
        return;
    }
    
    const zip = new JSZip();
    zip.loadAsync(file).then(function(zip) {
        batchImages = [];
        imageSettings = [];
        currentBatchIndex = 0;
        
        // 遍历压缩包中的所有文件
        zip.forEach(function(relativePath, zipEntry) {
            // 检查文件是否为图片
            if (zipEntry.name.match(/\.(jpg|jpeg|png|gif|bmp)$/i)) {
                // 读取图片文件
                zipEntry.async('blob').then(function(blob) {
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        const img = new Image();
                        img.onload = function() {
                            batchImages.push({
                                image: img,
                                name: zipEntry.name.split('.').slice(0, -1).join('.'),
                                blob: blob
                            });
                            
                            // 为每张图片初始化默认设置
                            imageSettings.push({
                                width: 32,
                                height: 32,
                                threshold: 128,
                                thresholdType: 'rgb',
                                redMin: 0,
                                redMax: 255,
                                greenMin: 0,
                                greenMax: 255,
                                blueMin: 0,
                                blueMax: 255,
                                invert: false,
                                selection: null
                            });
                            
                            // 如果是第一张图片，显示它
                            if (batchImages.length === 1) {
                                showBatchImage(0);
                                getElement('batch-controls').style.display = 'block';
                            }
                            
                            // 更新图片计数器
                            getElement('image-counter').textContent = `${currentBatchIndex + 1} / ${batchImages.length}`;
                        };
                        img.src = e.target.result;
                    };
                    reader.readAsDataURL(blob);
                });
            }
        });
    }).catch(function(error) {
        alert('处理压缩包失败: ' + error.message);
    });
}

// 处理视频上传
function handleVideoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // revoke previous blob URL if it exists
    if (currentVideoBlobUrl) {
        URL.revokeObjectURL(currentVideoBlobUrl);
    }
    
    const video = getElement('video-preview');
    currentVideoBlobUrl = URL.createObjectURL(file);
    video.src = currentVideoBlobUrl;
    currentVideo = video;
    
    // 存储原始视频大小并显示视频信息
    video.addEventListener('loadedmetadata', function() {
        modeStates.video.originalSize = { width: video.videoWidth, height: video.videoHeight };
        
        // 显示视频信息
        const videoInfo = getElement('video-info');
        const width = video.videoWidth;
        const height = video.videoHeight;
        const aspectRatio = (width / height).toFixed(2);
        const duration = formatTime(video.duration);
        
        let infoText = `视频信息: ${width}x${height} (${aspectRatio}:1), 时长: ${duration}`;
        
        // 只有当帧率可用时才显示
        if (video.videoFrameRate) {
            infoText += `, 帧率: ${video.videoFrameRate.toFixed(1)}fps`;
        }
        
        videoInfo.innerHTML = infoText;
    });
}

// 处理图像
function processImage() {
    if (!currentImage) return;
    
    const width = parseInt(getElement('width-input').value) || 16;
    const height = parseInt(getElement('height-input').value) || 16;
    const threshold = parseInt(getElement('threshold-input').value);
    const thresholdType = getElement('threshold-type').value;
    const invert = getElement('invert-checkbox').checked;
    
    // 绘制原始图像预览（保持原图比例）
    const sourceCanvas = getElement('source-preview');
    const sourceCtx = sourceCanvas.getContext('2d');
    
    // 计算预览尺寸，保持原图比例
    const previewSize = calculatePreviewSize(
        modeStates.image.originalSize.width,
        modeStates.image.originalSize.height,
        AppConfig.maxPreviewSize
    );
    
    sourceCanvas.width = previewSize.width;
    sourceCanvas.height = previewSize.height;
    sourceCtx.imageSmoothingEnabled = true;
    sourceCtx.drawImage(currentImage, 0, 0, previewSize.width, previewSize.height);
    
    // 计算预览缩放比例
    modeStates.image.previewScale = modeStates.image.originalSize.width / previewSize.width;
    
    // 处理二值化
    const binaryCanvas = getElement('binary-preview');
    const binaryCtx = binaryCanvas.getContext('2d');
    
    // 计算最大画布尺寸，确保不超出屏幕
    const maxCanvasSize = Math.min(
        window.innerWidth * 0.8, // 80% of screen width
        window.innerHeight * 0.6  // 60% of screen height
    );
    
    // 计算缩放因子，确保画布大小适中
    const scaleFactor = Math.min(10, maxCanvasSize / Math.max(width, height));
    
    binaryCanvas.width = width * scaleFactor;
    binaryCanvas.height = height * scaleFactor;
    
    // 先绘制缩小的图像
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    tempCanvas.width = Math.max(1, Math.floor(width));
    tempCanvas.height = Math.max(1, Math.floor(height));
    tempCtx.imageSmoothingEnabled = false;
    
    // 检查是否有框选区域
    const selectionBox = getElement('selection-box');
    const selectionVisible = selectionBox.style.display !== 'none';
    if (selectionVisible) {
        // 计算框选区域在原始图像中的坐标
        const x = Math.min(modeStates.image.selectionStart.x, modeStates.image.selectionEnd.x) * modeStates.image.previewScale;
        const y = Math.min(modeStates.image.selectionStart.y, modeStates.image.selectionEnd.y) * modeStates.image.previewScale;
        const selectionWidth = Math.abs(modeStates.image.selectionEnd.x - modeStates.image.selectionStart.x) * modeStates.image.previewScale;
        const selectionHeight = Math.abs(modeStates.image.selectionEnd.y - modeStates.image.selectionStart.y) * modeStates.image.previewScale;
        
        // 从框选区域绘制到临时画布
        tempCtx.drawImage(
            currentImage, 
            x, y, selectionWidth, selectionHeight, 
            0, 0, width, height
        );
    } else {
        // 绘制整个图像
        tempCtx.drawImage(currentImage, 0, 0, width, height);
    }
    
    // 获取图像数据
    const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    
    // 二值化处理
    const rgbThresholds = {
        redMin: getElement('red-min').value,
        redMax: getElement('red-max').value,
        greenMin: getElement('green-min').value,
        greenMax: getElement('green-max').value,
        blueMin: getElement('blue-min').value,
        blueMax: getElement('blue-max').value
    };
    
    const processedImageData = processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert);
    
    // 绘制二值化图像
    tempCtx.putImageData(processedImageData, 0, 0);
    binaryCtx.imageSmoothingEnabled = false;
    binaryCtx.drawImage(tempCanvas, 0, 0, width * scaleFactor, height * scaleFactor);
    
    // 生成代码
    generateCode(processedImageData, width, height);
}

// 处理视频
function processVideo() {
    // 重置帧时间
    lastFrameTime = 0;
}

// 处理视频帧
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
    
    // 计算每帧之间的时间间隔
    const frameInterval = 1 / frameRate;
    
    // 强制处理帧的情况：
    // 1. lastFrameTime为0（表示需要强制更新）
    // 2. 时间间隔达到设定的帧率
    if (lastFrameTime === 0 || currentTime - lastFrameTime >= frameInterval) {
        lastFrameTime = currentTime;
        
        const canvas = getElement('video-frame-preview');
        const ctx = canvas.getContext('2d');
        
        // 计算最大画布尺寸，确保不超出屏幕
        const maxCanvasSize = Math.min(
            window.innerWidth * 0.8, // 80% of screen width
            window.innerHeight * 0.6  // 60% of screen height
        );
        
        // 计算缩放因子，确保画布大小适中
        const scaleFactor = Math.min(10, maxCanvasSize / Math.max(width, height));
        
        canvas.width = width * scaleFactor;
        canvas.height = height * scaleFactor;
        
        // 绘制缩小的视频帧
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = width;
        tempCanvas.height = height;
        
        // 检查是否有框选区域
        const videoSelectionBox = getElement('video-selection-box');
        const selectionVisible = videoSelectionBox.style.display !== 'none';
        if (selectionVisible) {
            // 计算框选区域在视频中的坐标
            const x = Math.min(modeStates.video.selectionStart.x, modeStates.video.selectionEnd.x);
            const y = Math.min(modeStates.video.selectionStart.y, modeStates.video.selectionEnd.y);
            const selectionWidth = Math.abs(modeStates.video.selectionEnd.x - modeStates.video.selectionStart.x);
            const selectionHeight = Math.abs(modeStates.video.selectionEnd.y - modeStates.video.selectionStart.y);
            
            // 从框选区域绘制到临时画布
            tempCtx.drawImage(
                video, 
                x, y, selectionWidth, selectionHeight, 
                0, 0, width, height
            );
        } else {
            // 绘制整个视频帧
            tempCtx.drawImage(video, 0, 0, width, height);
        }
        
        // 获取图像数据
        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        
        // 二值化处理
        const rgbThresholds = {
            redMin: getElement('video-red-min').value,
            redMax: getElement('video-red-max').value,
            greenMin: getElement('video-green-min').value,
            greenMax: getElement('video-green-max').value,
            blueMin: getElement('video-blue-min').value,
            blueMax: getElement('video-blue-max').value
        };
        
        const processedImageData = processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert);
        
        // 绘制二值化图像
        tempCtx.putImageData(processedImageData, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tempCanvas, 0, 0, width * scaleFactor, height * scaleFactor);
        
        // 生成代码
        generateCode(processedImageData, width, height);
    }
}

// 设置手绘画布
function setupDrawCanvas() {
    const width = parseInt(getElement('draw-width').value);
    const height = parseInt(getElement('draw-height').value);
    
    // 计算最大画布尺寸，确保不超出屏幕
    const maxCanvasSize = Math.min(
        window.innerWidth * 0.8, // 80% of screen width
        window.innerHeight * 0.6  // 60% of screen height
    );
    
    // 计算缩放因子，确保画布大小适中
    const scaleFactor = Math.min(10, maxCanvasSize / Math.max(width, height));
    
    drawCanvas.width = width * scaleFactor;
    drawCanvas.height = height * scaleFactor;
    
    // 填充白色背景
    drawCtx.fillStyle = 'white';
    drawCtx.fillRect(0, 0, width * scaleFactor, height * scaleFactor);
    
    // 绘制网格
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
    
    // 绘制事件
    drawCanvas.addEventListener('mousedown', startDrawing);
    drawCanvas.addEventListener('mousemove', draw);
    drawCanvas.addEventListener('mouseup', stopDrawing);
    drawCanvas.addEventListener('mouseout', stopDrawing);
}

// 调整手绘画布大小
function resizeDrawCanvas() {
    setupDrawCanvas();
    processDrawCanvas();
}

// 开始绘制
function startDrawing(e) {
    isDrawing = true;
    draw(e);
}

// 绘制
function draw(e) {
    if (!isDrawing) return;
    
    const rect = drawCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const width = parseInt(getElement('draw-width').value);
    const height = parseInt(getElement('draw-height').value);
    
    // 计算最大画布尺寸，确保不超出屏幕
    const maxCanvasSize = Math.min(
        window.innerWidth * 0.8, // 80% of screen width
        window.innerHeight * 0.6  // 60% of screen height
    );
    
    // 计算缩放因子，确保画布大小适中
    const scaleFactor = Math.min(10, maxCanvasSize / Math.max(width, height));
    
    // 计算笔触半径（以像素为单位）
    const brushRadius = brushSize * (scaleFactor / 2); // 每个格子scaleFactor像素，半径为笔触大小的一半
    
    // 遍历可能被覆盖的格子
    const startX = Math.max(0, Math.floor((mouseX - brushRadius) / scaleFactor));
    const endX = Math.min(width - 1, Math.floor((mouseX + brushRadius) / scaleFactor));
    const startY = Math.max(0, Math.floor((mouseY - brushRadius) / scaleFactor));
    const endY = Math.min(height - 1, Math.floor((mouseY + brushRadius) / scaleFactor));
    
    for (let x = startX; x <= endX; x++) {
        for (let y = startY; y <= endY; y++) {
            // 计算格子中心点坐标
            const cellCenterX = x * scaleFactor + (scaleFactor / 2);
            const cellCenterY = y * scaleFactor + (scaleFactor / 2);
            
            // 计算鼠标到格子中心的距离
            const distance = Math.sqrt(
                Math.pow(mouseX - cellCenterX, 2) + 
                Math.pow(mouseY - cellCenterY, 2)
            );
            
            // 如果距离小于笔触半径，则填充该格子
            if (distance <= brushRadius) {
                // 填充格子内部，不覆盖网格线
                drawCtx.fillStyle = drawMode ? 'black' : 'white';
                drawCtx.fillRect(x * scaleFactor + 1, y * scaleFactor + 1, scaleFactor - 2, scaleFactor - 2);
            }
        }
    }
    
    processDrawCanvas();
}

// 停止绘制
function stopDrawing() {
    isDrawing = false;
}

// 清空画板
function clearCanvas() {
    const width = parseInt(getElement('draw-width').value);
    const height = parseInt(getElement('draw-height').value);
    
    // 计算最大画布尺寸，确保不超出屏幕
    const maxCanvasSize = Math.min(
        window.innerWidth * 0.8, // 80% of screen width
        window.innerHeight * 0.6  // 60% of screen height
    );
    
    // 计算缩放因子，确保画布大小适中
    const scaleFactor = Math.min(10, maxCanvasSize / Math.max(width, height));
    
    // 清空画布并填充白色背景
    drawCtx.fillStyle = 'white';
    drawCtx.fillRect(0, 0, width * scaleFactor, height * scaleFactor);
    
    // 重新绘制网格
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
    
    // 处理画布
    processDrawCanvas();
}

// 处理手绘画布
function processDrawCanvas() {
    const width = parseInt(getElement('draw-width').value);
    const height = parseInt(getElement('draw-height').value);
    const invert = getElement('draw-invert-checkbox').checked;
    
    // 计算最大画布尺寸，确保不超出屏幕
    const maxCanvasSize = Math.min(
        window.innerWidth * 0.8, // 80% of screen width
        window.innerHeight * 0.6  // 60% of screen height
    );
    
    // 计算缩放因子，确保画布大小适中
    const scaleFactor = Math.min(10, maxCanvasSize / Math.max(width, height));
    
    // 获取图像数据
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    tempCanvas.width = width;
    tempCanvas.height = height;
    tempCtx.drawImage(drawCanvas, 0, 0, width, height);
    
    const imageData = tempCtx.getImageData(0, 0, width, height);
    
    // 如果启用了反转黑白，则处理图像数据
    if (invert) {
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 255 - data[i];         // R
            data[i + 1] = 255 - data[i + 1]; // G
            data[i + 2] = 255 - data[i + 2]; // B
        }
    }
    
    // 绘制预览
    const previewCanvas = getElement('draw-preview');
    const previewCtx = previewCanvas.getContext('2d');
    previewCanvas.width = width * scaleFactor;
    previewCanvas.height = height * scaleFactor;
    
    // 先将处理后的图像绘制到临时画布
    tempCtx.putImageData(imageData, 0, 0);
    
    // 复制到预览画布
    previewCtx.imageSmoothingEnabled = false;
    previewCtx.drawImage(tempCanvas, 0, 0, width * scaleFactor, height * scaleFactor);
    
    // 生成代码
    generateCode(imageData, width, height);
}

// 显示批量处理中的图片
function showBatchImage(index) {
    if (index < 0 || index >= batchImages.length) return;
    
    currentBatchIndex = index;
    const batchImage = batchImages[index];
    currentImage = batchImage.image;
    modeStates.image.fileName = batchImage.name;
    modeStates.image.originalSize = { width: batchImage.image.width, height: batchImage.image.height };
    
    // 加载图片的设置
    const settings = imageSettings[index];
    getElement('width-input').value = settings.width;
    getElement('height-input').value = settings.height;
    getElement('threshold-input').value = settings.threshold;
    getElement('threshold-value').textContent = settings.threshold;
    
    // 设置阈值类型
    getElements('.threshold-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.type === settings.thresholdType) {
            btn.classList.add('active');
        }
    });
    getElement('threshold-type').value = settings.thresholdType;
    
    // 显示/隐藏相应的阈值控件
    const rgbThresholds = getElement('rgb-thresholds');
    const singleThreshold = getElement('single-threshold');
    
    if (settings.thresholdType === 'individual') {
        rgbThresholds.style.display = 'block';
        singleThreshold.style.display = 'none';
    } else {
        rgbThresholds.style.display = 'none';
        singleThreshold.style.display = 'block';
    }
    
    // 加载RGB阈值设置
    getElement('red-min').value = settings.redMin;
    getElement('red-max').value = settings.redMax;
    getElement('green-min').value = settings.greenMin;
    getElement('green-max').value = settings.greenMax;
    getElement('blue-min').value = settings.blueMin;
    getElement('blue-max').value = settings.blueMax;
    
    // 更新RGB阈值显示
    getElement('red-min-value').textContent = settings.redMin;
    getElement('red-max-value').textContent = settings.redMax;
    getElement('green-min-value').textContent = settings.greenMin;
    getElement('green-max-value').textContent = settings.greenMax;
    getElement('blue-min-value').textContent = settings.blueMin;
    getElement('blue-max-value').textContent = settings.blueMax;
    
    // 加载反转设置
    getElement('invert-checkbox').checked = settings.invert;
    
    // 处理图像
    processImage();
}

// 设置框选事件
function setupSelectionEvents() {
    const sourceContainer = getElement('source-preview').parentElement;
    const selectionBox = getElement('selection-box');
    
    // 开始框选
    sourceContainer.addEventListener('mousedown', (e) => {
        // 如果点击的是选择框内部（不是手柄），开始拖动
        if (e.target === selectionBox) {
            isDragging = true;
            const rect = selectionBox.getBoundingClientRect();
            dragOffset.x = e.clientX - rect.left;
            dragOffset.y = e.clientY - rect.top;
            return;
        }
        
        // 如果点击的是调整手柄，开始调整大小
        if (e.target.classList.contains('selection-handle')) {
            isResizing = true;
            resizeHandle = e.target.classList[1]; // 获取手柄类型
            const rect = sourceContainer.getBoundingClientRect();
            modeStates.image.selectionStart.x = e.clientX - rect.left;
            modeStates.image.selectionStart.y = e.clientY - rect.top;
            return;
        }
        
        // 如果点击的是1:1比例按钮
        if (e.target.classList.contains('selection-ratio')) {
            e.stopPropagation();
            toggleRatioLock('image');
            return;
        }
        
        // 如果点击的是原图比例按钮
        if (e.target.classList.contains('selection-original-ratio')) {
            e.stopPropagation();
            toggleOriginalRatioLock('image');
            return;
        }
        
        // 只有在图片区域内点击才能开始新的框选
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
    
    // 鼠标移动
    sourceContainer.addEventListener('mousemove', (e) => {
        const rect = sourceContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        if (isSelecting) {
            // 正在框选
            modeStates.image.selectionEnd.x = mouseX;
            modeStates.image.selectionEnd.y = mouseY;
            updateSelectionBox('image');
        } else if (isResizing) {
            // 正在调整大小
            resizeSelection('image', mouseX, mouseY);
        } else if (isDragging) {
            // 正在拖动
            moveSelection('image', mouseX, mouseY);
        }
    });
    
    // 鼠标释放
    sourceContainer.addEventListener('mouseup', () => {
        if (isSelecting || isResizing || isDragging) {
            isSelecting = false;
            isResizing = false;
            isDragging = false;
            resizeHandle = null;
            processImage();
        }
    });
    
    // 鼠标离开
    sourceContainer.addEventListener('mouseleave', () => {
        isSelecting = false;
        isResizing = false;
        isDragging = false;
        resizeHandle = null;
    });
    
    // 关闭按钮点击
    selectionBox.querySelector('.selection-close').addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止事件冒泡
        selectionBox.style.display = 'none';
        processImage();
    });
}

// 设置视频框选事件
function setupVideoSelectionEvents() {
    const videoContainer = getElement('video-preview').parentElement;
    const videoSelectionBox = getElement('video-selection-box');
    
    // 开始框选
    videoContainer.addEventListener('mousedown', (e) => {
        // 如果点击的是选择框内部（不是手柄），开始拖动
        if (e.target === videoSelectionBox) {
            isDragging = true;
            const rect = videoSelectionBox.getBoundingClientRect();
            dragOffset.x = e.clientX - rect.left;
            dragOffset.y = e.clientY - rect.top;
            return;
        }
        
        // 如果点击的是调整手柄，开始调整大小
        if (e.target.classList.contains('selection-handle')) {
            isResizing = true;
            resizeHandle = e.target.classList[1]; // 获取手柄类型
            const rect = videoContainer.getBoundingClientRect();
            modeStates.video.selectionStart.x = e.clientX - rect.left;
            modeStates.video.selectionStart.y = e.clientY - rect.top;
            return;
        }
        
        // 如果点击的是1:1比例按钮
        if (e.target.classList.contains('video-selection-ratio')) {
            e.stopPropagation();
            toggleRatioLock('video');
            return;
        }
        
        // 如果点击的是原图比例按钮
        if (e.target.classList.contains('video-selection-original-ratio')) {
            e.stopPropagation();
            toggleOriginalRatioLock('video');
            return;
        }
        
        // 只有在视频区域内点击才能开始新的框选
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
    
    // 鼠标移动
    videoContainer.addEventListener('mousemove', (e) => {
        const rect = videoContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        if (isSelecting) {
            // 正在框选
            modeStates.video.selectionEnd.x = mouseX;
            modeStates.video.selectionEnd.y = mouseY;
            updateSelectionBox('video');
        } else if (isResizing) {
            // 正在调整大小
            resizeSelection('video', mouseX, mouseY);
        } else if (isDragging) {
            // 正在拖动
            moveSelection('video', mouseX, mouseY);
        }
    });
    
    // 鼠标释放
    videoContainer.addEventListener('mouseup', () => {
        if (isSelecting || isResizing || isDragging) {
            isSelecting = false;
            isResizing = false;
            isDragging = false;
            resizeHandle = null;
            processVideoFrame();
        }
    });
    
    // 鼠标离开
    videoContainer.addEventListener('mouseleave', () => {
        isSelecting = false;
        isResizing = false;
        isDragging = false;
        resizeHandle = null;
    });
    
    // 关闭按钮点击
    videoSelectionBox.querySelector('.selection-close').addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止事件冒泡
        videoSelectionBox.style.display = 'none';
        processVideoFrame();
    });
}

// 切换1:1比例锁定/解锁
function toggleRatioLock(mode) {
    modeStates[mode].isRatioLocked = !modeStates[mode].isRatioLocked;
    modeStates[mode].isOriginalRatioLocked = false; // 解锁原图比例
    
    const ratioBtn = mode === 'image' ? 
        getElement('selection-box').querySelector('.selection-ratio') : 
        getElement('video-selection-box').querySelector('.video-selection-ratio');
    const originalRatioBtn = mode === 'image' ? 
        getElement('selection-box').querySelector('.selection-original-ratio') : 
        getElement('video-selection-box').querySelector('.video-selection-original-ratio');
    
    if (modeStates[mode].isRatioLocked) {
        // 锁定1:1比例，先将选择框设置为正方形
        makeSelectionSquare(mode);
        ratioBtn.classList.add('locked');
        originalRatioBtn.classList.remove('locked');
        
        // 隐藏边手柄，只保留四个角和关闭按钮
        if (mode === 'image') {
            getElements('.selection-handle.left').forEach(el => el.style.display = 'none');
            getElements('.selection-handle.right').forEach(el => el.style.display = 'none');
            getElements('.selection-handle.top').forEach(el => el.style.display = 'none');
            getElements('.selection-handle.bottom').forEach(el => el.style.display = 'none');
        } else {
            getElement('video-selection-box').querySelectorAll('.selection-handle.left').forEach(el => el.style.display = 'none');
            getElement('video-selection-box').querySelectorAll('.selection-handle.right').forEach(el => el.style.display = 'none');
            getElement('video-selection-box').querySelectorAll('.selection-handle.top').forEach(el => el.style.display = 'none');
            getElement('video-selection-box').querySelectorAll('.selection-handle.bottom').forEach(el => el.style.display = 'none');
        }
    } else {
        // 解锁比例
        ratioBtn.classList.remove('locked');
        
        // 显示所有手柄
        if (mode === 'image') {
            getElements('.selection-handle').forEach(el => el.style.display = 'block');
        } else {
            getElement('video-selection-box').querySelectorAll('.selection-handle').forEach(el => el.style.display = 'block');
        }
    }
}

// 切换原图比例锁定/解锁
function toggleOriginalRatioLock(mode) {
    modeStates[mode].isOriginalRatioLocked = !modeStates[mode].isOriginalRatioLocked;
    modeStates[mode].isRatioLocked = false; // 解锁1:1比例
    
    const originalRatioBtn = mode === 'image' ? 
        getElement('selection-box').querySelector('.selection-original-ratio') : 
        getElement('video-selection-box').querySelector('.video-selection-original-ratio');
    const ratioBtn = mode === 'image' ? 
        getElement('selection-box').querySelector('.selection-ratio') : 
        getElement('video-selection-box').querySelector('.video-selection-ratio');
    
    if (modeStates[mode].isOriginalRatioLocked) {
        // 锁定原图比例
        if (modeStates[mode].originalSize.width > 0 && modeStates[mode].originalSize.height > 0) {
            // 计算原图比例
            const originalRatio = modeStates[mode].originalSize.width / modeStates[mode].originalSize.height;
            
            // 调整选择框为原图比例
            const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
            const sourceElement = mode === 'image' ? getElement('source-preview') : getElement('video-preview');
            
            const currentRect = selectionBox.getBoundingClientRect();
            const sourceRect = sourceElement.getBoundingClientRect();
            
            const boxLeft = currentRect.left - sourceRect.left;
            const boxTop = currentRect.top - sourceRect.top;
            const boxWidth = currentRect.width;
            const boxHeight = currentRect.height;
            
            // 计算新的尺寸
            let newWidth, newHeight;
            if (originalRatio > 1) {
                // 宽屏
                newWidth = boxWidth;
                newHeight = boxWidth / originalRatio;
            } else {
                // 竖屏
                newHeight = boxHeight;
                newWidth = boxHeight * originalRatio;
            }
            
            // 计算新的位置（保持中心不变）
            const newLeft = boxLeft + (boxWidth - newWidth) / 2;
            const newTop = boxTop + (boxHeight - newHeight) / 2;
            
            // 更新选择框
            selectionBox.style.left = newLeft + 'px';
            selectionBox.style.top = newTop + 'px';
            selectionBox.style.width = newWidth + 'px';
            selectionBox.style.height = newHeight + 'px';
            
            // 更新选择坐标
            modeStates[mode].selectionStart = { x: newLeft, y: newTop };
            modeStates[mode].selectionEnd = { x: newLeft + newWidth, y: newTop + newHeight };
            
            // 更新按钮状态
            originalRatioBtn.classList.add('locked');
            ratioBtn.classList.remove('locked');
            
            // 隐藏边手柄，只保留四个角和关闭按钮
            if (mode === 'image') {
                getElements('.selection-handle.left').forEach(el => el.style.display = 'none');
                getElements('.selection-handle.right').forEach(el => el.style.display = 'none');
                getElements('.selection-handle.top').forEach(el => el.style.display = 'none');
                getElements('.selection-handle.bottom').forEach(el => el.style.display = 'none');
            } else {
                getElement('video-selection-box').querySelectorAll('.selection-handle.left').forEach(el => el.style.display = 'none');
                getElement('video-selection-box').querySelectorAll('.selection-handle.right').forEach(el => el.style.display = 'none');
                getElement('video-selection-box').querySelectorAll('.selection-handle.top').forEach(el => el.style.display = 'none');
                getElement('video-selection-box').querySelectorAll('.selection-handle.bottom').forEach(el => el.style.display = 'none');
            }
            
            // 重新处理图像或视频帧
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
        // 解锁原图比例
        originalRatioBtn.classList.remove('locked');
        
        // 显示所有手柄
        if (mode === 'image') {
            getElements('.selection-handle').forEach(el => el.style.display = 'block');
        } else {
            getElement('video-selection-box').querySelectorAll('.selection-handle').forEach(el => el.style.display = 'block');
        }
    }
}

// 将选择框设置为正方形（1:1比例）
function makeSelectionSquare(mode) {
    const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
    const sourceElement = mode === 'image' ? getElement('source-preview') : getElement('video-preview');
    
    const currentRect = selectionBox.getBoundingClientRect();
    const sourceRect = sourceElement.getBoundingClientRect();
    
    // 计算当前选择框在容器中的位置
    const boxLeft = currentRect.left - sourceRect.left;
    const boxTop = currentRect.top - sourceRect.top;
    const boxWidth = currentRect.width;
    const boxHeight = currentRect.height;
    
    // 计算正方形的边长（取当前宽高中的较小值）
    const squareSize = Math.min(boxWidth, boxHeight);
    
    // 计算新的位置，使正方形居中
    const newLeft = boxLeft + (boxWidth - squareSize) / 2;
    const newTop = boxTop + (boxHeight - squareSize) / 2;
    
    // 更新选择框位置和大小
    selectionBox.style.left = newLeft + 'px';
    selectionBox.style.top = newTop + 'px';
    selectionBox.style.width = squareSize + 'px';
    selectionBox.style.height = squareSize + 'px';
    
    // 更新选择坐标
    modeStates[mode].selectionStart = { x: newLeft, y: newTop };
    modeStates[mode].selectionEnd = { x: newLeft + squareSize, y: newTop + squareSize };
    
    // 重新处理图像或视频帧
    if (mode === 'image') {
        processImage();
    } else {
        processVideoFrame();
    }
}

// 调整选择框大小
function resizeSelection(mode, mouseX, mouseY) {
    const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
    const sourceElement = mode === 'image' ? getElement('source-preview') : getElement('video-preview');
    
    const currentRect = selectionBox.getBoundingClientRect();
    const sourceRect = sourceElement.getBoundingClientRect();
    
    // 计算当前选择框在容器中的位置
    const boxLeft = currentRect.left - sourceRect.left;
    const boxTop = currentRect.top - sourceRect.top;
    const boxWidth = currentRect.width;
    const boxHeight = currentRect.height;
    
    if (modeStates[mode].isRatioLocked) {
        // 锁定1:1比例时的调整逻辑
        resizeSelectionLocked(mode, mouseX, mouseY, boxLeft, boxTop, boxWidth, boxHeight);
    } else if (modeStates[mode].isOriginalRatioLocked) {
        // 锁定原图比例时的调整逻辑
        resizeSelectionOriginalRatio(mode, mouseX, mouseY, boxLeft, boxTop, boxWidth, boxHeight);
    } else {
        // 未锁定比例时的普通调整逻辑
        let newLeft = boxLeft;
        let newTop = boxTop;
        let newWidth = boxWidth;
        let newHeight = boxHeight;
        
        // 根据手柄类型调整大小
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
        
        // 确保选择框大小合理
        if (newWidth > 10 && newHeight > 10) {
            // 更新选择框位置和大小
            selectionBox.style.left = newLeft + 'px';
            selectionBox.style.top = newTop + 'px';
            selectionBox.style.width = newWidth + 'px';
            selectionBox.style.height = newHeight + 'px';
            
            // 更新选择坐标
            modeStates[mode].selectionStart = { x: newLeft, y: newTop };
            modeStates[mode].selectionEnd = { x: newLeft + newWidth, y: newTop + newHeight };
        }
    }
}

// 锁定原图比例时的调整逻辑
function resizeSelectionOriginalRatio(mode, mouseX, mouseY, boxLeft, boxTop, boxWidth, boxHeight) {
    if (modeStates[mode].originalSize.width > 0 && modeStates[mode].originalSize.height > 0) {
        const originalRatio = modeStates[mode].originalSize.width / modeStates[mode].originalSize.height;
        let newLeft = boxLeft;
        let newTop = boxTop;
        let newWidth = boxWidth;
        let newHeight = boxHeight;
        
        // 根据手柄类型调整，固定对角点位置
        switch (resizeHandle) {
            case 'top-left':
                // 固定右下角，调整左上角
                const fixedBottomRightX = boxLeft + boxWidth;
                const fixedBottomRightY = boxTop + boxHeight;
                
                // 计算鼠标到固定对角点的距离
                const dx = fixedBottomRightX - mouseX;
                const dy = fixedBottomRightY - mouseY;
                
                // 根据原图比例计算新的尺寸
                if (originalRatio > 1) {
                    // 宽屏，以宽度为准
                    newWidth = dx;
                    newHeight = dx / originalRatio;
                } else {
                    // 竖屏，以高度为准
                    newHeight = dy;
                    newWidth = dy * originalRatio;
                }
                
                // 新位置
                newLeft = fixedBottomRightX - newWidth;
                newTop = fixedBottomRightY - newHeight;
                break;
                
            case 'top-right':
                // 固定左下角，调整右上角
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
                // 固定右上角，调整左下角
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
                // 固定左上角，调整右下角
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
        
        // 确保选择框大小合理
        if (newWidth > 10 && newHeight > 10) {
            // 更新选择框位置和大小
            const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
            selectionBox.style.left = newLeft + 'px';
            selectionBox.style.top = newTop + 'px';
            selectionBox.style.width = newWidth + 'px';
            selectionBox.style.height = newHeight + 'px';
            
            // 更新选择坐标
            modeStates[mode].selectionStart = { x: newLeft, y: newTop };
            modeStates[mode].selectionEnd = { x: newLeft + newWidth, y: newTop + newHeight };
        }
    }
}

// 锁定1:1比例时的调整逻辑
function resizeSelectionLocked(mode, mouseX, mouseY, boxLeft, boxTop, boxWidth, boxHeight) {
    let newLeft = boxLeft;
    let newTop = boxTop;
    let newSize = Math.max(boxWidth, boxHeight);
    
    // 根据手柄类型调整，固定对角点位置
    switch (resizeHandle) {
        case 'top-left':
            // 固定右下角，调整左上角
            const fixedBottomRightX = boxLeft + boxWidth;
            const fixedBottomRightY = boxTop + boxHeight;
            
            // 计算鼠标到固定对角点的距离向量
            const dx = fixedBottomRightX - mouseX;
            const dy = fixedBottomRightY - mouseY;
            
            // 取较大的绝对值作为边长
            newSize = Math.max(Math.abs(dx), Math.abs(dy));
            
            // 新位置
            newLeft = fixedBottomRightX - newSize;
            newTop = fixedBottomRightY - newSize;
            break;
            
        case 'top-right':
            // 固定左下角，调整右上角
            const fixedBottomLeftX = boxLeft;
            const fixedBottomLeftY = boxTop + boxHeight;
            
            const dx1 = mouseX - fixedBottomLeftX;
            const dy1 = fixedBottomLeftY - mouseY;
            
            newSize = Math.max(Math.abs(dx1), Math.abs(dy1));
            
            newLeft = fixedBottomLeftX;
            newTop = fixedBottomLeftY - newSize;
            break;
            
        case 'bottom-left':
            // 固定右上角，调整左下角
            const fixedTopRightX = boxLeft + boxWidth;
            const fixedTopRightY = boxTop;
            
            const dx2 = fixedTopRightX - mouseX;
            const dy2 = mouseY - fixedTopRightY;
            
            newSize = Math.max(Math.abs(dx2), Math.abs(dy2));
            
            newLeft = fixedTopRightX - newSize;
            newTop = fixedTopRightY;
            break;
            
        case 'bottom-right':
            // 固定左上角，调整右下角
            const fixedTopLeftX = boxLeft;
            const fixedTopLeftY = boxTop;
            
            const dx3 = mouseX - fixedTopLeftX;
            const dy3 = mouseY - fixedTopLeftY;
            
            newSize = Math.max(Math.abs(dx3), Math.abs(dy3));
            
            newLeft = fixedTopLeftX;
            newTop = fixedTopLeftY;
            break;
    }
    
    // 确保选择框大小合理
    if (newSize > 10) {
        // 更新选择框位置和大小
        const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
        selectionBox.style.left = newLeft + 'px';
        selectionBox.style.top = newTop + 'px';
        selectionBox.style.width = newSize + 'px';
        selectionBox.style.height = newSize + 'px';
        
        // 更新选择坐标
        modeStates[mode].selectionStart = { x: newLeft, y: newTop };
        modeStates[mode].selectionEnd = { x: newLeft + newSize, y: newTop + newSize };
    }
}

// 移动选择框
function moveSelection(mode, mouseX, mouseY) {
    const sourceElement = mode === 'image' ? getElement('source-preview') : getElement('video-preview');
    const selectionBox = mode === 'image' ? getElement('selection-box') : getElement('video-selection-box');
    const boxWidth = selectionBox.offsetWidth;
    const boxHeight = selectionBox.offsetHeight;
    
    // 计算新位置
    let newLeft = mouseX - dragOffset.x;
    let newTop = mouseY - dragOffset.y;
    
    // 确保选择框在容器内
    newLeft = Math.max(0, Math.min(newLeft, sourceElement.offsetWidth - boxWidth));
    newTop = Math.max(0, Math.min(newTop, sourceElement.offsetHeight - boxHeight));
    
    // 更新选择框位置
    selectionBox.style.left = newLeft + 'px';
    selectionBox.style.top = newTop + 'px';
    
    // 更新选择坐标
    modeStates[mode].selectionStart = { x: newLeft, y: newTop };
    modeStates[mode].selectionEnd = { x: newLeft + boxWidth, y: newTop + boxHeight };
}

// 更新框选框
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

// 设置事件监听器
function setupEventListeners() {
    // 图片上传
    getElement('image-upload').addEventListener('change', handleImageUpload);
    
    // 压缩包上传
    getElement('zip-upload').addEventListener('change', handleZipUpload);
    
    // 拖放上传功能
    setupDropArea('image-drop-area', 'image-upload', handleImageUpload);
    setupDropArea('zip-drop-area', 'zip-upload', handleZipUpload);
    setupDropArea('video-drop-area', 'video-upload', handleVideoUpload);
    
    // 视频上传
    getElement('video-upload').addEventListener('change', handleVideoUpload);
    
    // 阈值调整
    getElement('threshold-input').addEventListener('input', function(e) {
        getElement('threshold-value').textContent = e.target.value;
        processImage();
    });
    
    getElement('video-threshold').addEventListener('input', function(e) {
        getElement('video-threshold-value').textContent = e.target.value;
        processVideoFrame();
    });
    
    // 图片大小调整
    const imageAspectRatioObj = setupSizeAdjustment('width-input', 'height-input', 'lock-ratio', processImage);
    setupSizeButtons('.size-btn', 'width-input', 'height-input', imageAspectRatioObj, processImage);
    setupOriginalRatioButton('original-ratio-btn', 'width-input', 'height-input', imageAspectRatioObj, 'image', processImage);
    
    // 视频大小调整
    const videoAspectRatioObj = setupSizeAdjustment('video-width', 'video-height', 'video-lock-ratio', processVideoFrame);
    setupSizeButtons('.video-size-btn', 'video-width', 'video-height', videoAspectRatioObj, processVideoFrame);
    setupOriginalRatioButton('video-original-ratio-btn', 'video-width', 'video-height', videoAspectRatioObj, 'video', processVideoFrame);
    
    // 阈值类型按钮
    setupThresholdTypeButtons('.threshold-btn', 'threshold-type', 'rgb-thresholds', 'single-threshold', processImage);
    setupThresholdTypeButtons('.video-threshold-btn', 'video-threshold-type', 'video-rgb-thresholds', 'video-single-threshold', processVideoFrame);
    
    // RGB区间调整
    setupRGBThresholds('red-min', 'red-max', 'green-min', 'green-max', 'blue-min', 'blue-max', 'red-min-value', 'red-max-value', 'green-min-value', 'green-max-value', 'blue-min-value', 'blue-max-value', processImage);
    setupRGBThresholds('video-red-min', 'video-red-max', 'video-green-min', 'video-green-max', 'video-blue-min', 'video-blue-max', 'video-red-min-value', 'video-red-max-value', 'video-green-min-value', 'video-green-max-value', 'video-blue-min-value', 'video-blue-max-value', processVideoFrame);
    
    // 反转功能
    getElement('invert-checkbox').addEventListener('change', processImage);
    getElement('video-invert-checkbox').addEventListener('change', processVideoFrame);
    
    // 帧率选择
    getElement('frame-rate').addEventListener('change', processVideo);
    
    // 导出按钮
    getElement('export-btn').addEventListener('click', exportResult);
    
    // 刷新按钮
    getElement('refresh-btn').addEventListener('click', refreshResult);
    
    // 取消导出按钮
    getElement('cancel-export-btn').addEventListener('click', function() {
        cancelVideoExport = true;
        getElement('cancel-export-btn').style.display = 'none';
        getElement('export-progress').style.display = 'none';
        getElement('export-btn').disabled = false;
    });
    
    // 批量处理控制按钮
    getElement('prev-image-btn').addEventListener('click', showPrevImage);
    getElement('next-image-btn').addEventListener('click', showNextImage);
    
    // 手绘控制
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
    
    // 视频帧处理
    getElement('video-preview').addEventListener('timeupdate', processVideoFrame);
    
    // 视频跳转时处理
    getElement('video-preview').addEventListener('seeked', function() {
        lastFrameTime = 0; // 重置lastFrameTime
        processVideoFrame(); // 强制处理当前帧
    });
    
    // 视频播放时处理
    getElement('video-preview').addEventListener('play', function() {
        lastFrameTime = 0; // 重置lastFrameTime
        processVideoFrame(); // 强制处理当前帧
    });
    
    // 框选事件监听
    setupSelectionEvents();
    setupVideoSelectionEvents();
    
    // 手绘大小调整
    getElement('draw-width').addEventListener('input', resizeDrawCanvas);
    getElement('draw-height').addEventListener('input', resizeDrawCanvas);
    
    // 手绘反转黑白
    getElement('draw-invert-checkbox').addEventListener('change', processDrawCanvas);
}

// 显示上一张图片
function showPrevImage() {
    if (currentBatchIndex > 0) {
        showBatchImage(currentBatchIndex - 1);
        getElement('image-counter').textContent = `${currentBatchIndex + 1} / ${batchImages.length}`;
    }
}

// 显示下一张图片
function showNextImage() {
    if (currentBatchIndex < batchImages.length - 1) {
        showBatchImage(currentBatchIndex + 1);
        getElement('image-counter').textContent = `${currentBatchIndex + 1} / ${batchImages.length}`;
    }
}

// 刷新结果
function refreshResult() {
    if (activeMode === 'image') {
        processImage();
    } else if (activeMode === 'video') {
        processVideoFrame();
    } else if (activeMode === 'draw') {
        processDrawCanvas();
    }
}

// 导出结果
function exportResult() {
    if (activeMode === 'video') {
        exportVideo();
    } else {
        exportImage();
    }
}

// 导出图片
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

// 导出视频
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
    const framesPerZip = parseInt(getElement('frames-per-zip').value);
    
    const totalFrames = Math.ceil(video.duration * frameRate);
    let processedFrames = 0;
    let currentFrame = 0;
    let frameNumber = 1;
    let zipNumber = 1;
    let currentZipFrames = [];
    let allZipBlobs = [];
    let previousFrameData = null;
    
    function processNextFrame() {
        if (cancelVideoExport) {
            isVideoExporting = false;
            getElement('export-btn').disabled = false;
            getElement('cancel-export-btn').style.display = 'none';
            getElement('export-progress').style.display = 'none';
            return;
        }
        
        if (currentFrame >= totalFrames) {
            // 处理最后一个压缩包
            if (currentZipFrames.length > 0) {
                packageCurrentZip(() => {
                    // 所有压缩包处理完成，打包成总压缩包
                    packageTotalZip();
                });
            } else {
                packageTotalZip();
            }
            return;
        }
        
        // 计算当前帧的时间
        const currentTime = currentFrame / frameRate;
        video.currentTime = currentTime;
        
        video.addEventListener('seeked', function onSeeked() {
            video.removeEventListener('seeked', onSeeked);
            
            // 绘制视频帧
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            tempCanvas.width = width;
            tempCanvas.height = height;
            
            // 检查是否有框选区域
            const videoSelectionBox = getElement('video-selection-box');
            const selectionVisible = videoSelectionBox.style.display !== 'none';
            if (selectionVisible) {
                // 计算框选区域在视频中的坐标
                const x = Math.min(modeStates.video.selectionStart.x, modeStates.video.selectionEnd.x);
                const y = Math.min(modeStates.video.selectionStart.y, modeStates.video.selectionEnd.y);
                const selectionWidth = Math.abs(modeStates.video.selectionEnd.x - modeStates.video.selectionStart.x);
                const selectionHeight = Math.abs(modeStates.video.selectionEnd.y - modeStates.video.selectionStart.y);
                
                // 从框选区域绘制到临时画布
                tempCtx.drawImage(
                    video, 
                    x, y, selectionWidth, selectionHeight, 
                    0, 0, width, height
                );
            } else {
                // 绘制整个视频帧
                tempCtx.drawImage(video, 0, 0, width, height);
            }
            
            // 获取图像数据
            const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
            
            // 二值化处理
            const rgbThresholds = {
                redMin: getElement('video-red-min').value,
                redMax: getElement('video-red-max').value,
                greenMin: getElement('video-green-min').value,
                greenMax: getElement('video-green-max').value,
                blueMin: getElement('video-blue-min').value,
                blueMax: getElement('video-blue-max').value
            };
            
            const processedImageData = processBinaryImage(imageData, thresholdType, threshold, rgbThresholds, invert);
            
            // 检查是否需要去重
            let shouldAddFrame = true;
            if (removeDuplicates && previousFrameData) {
                const currentData = processedImageData.data;
                const prevData = previousFrameData.data;
                
                // 比较两帧数据是否相同
                for (let i = 0; i < currentData.length; i++) {
                    if (currentData[i] !== prevData[i]) {
                        shouldAddFrame = true;
                        break;
                    }
                    shouldAddFrame = false;
                }
            }
            
            if (shouldAddFrame) {
                // 生成代码
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
                
                // 获取导出设置
                const fileName = getElement('file-name').value || modeStates.video.fileName;
                const arrayName = getElement('array-name').value || 'image_bits';
                const widthVar = getElement('width-var').value || 'WIDTH';
                const heightVar = getElement('height-var').value || 'HEIGHT';
                
                // 生成代码
                let code = `#define ${widthVar.toUpperCase()} ${width}\n`;
                code += `#define ${heightVar.toUpperCase()} ${height}\n`;
                code += `static const unsigned char ${arrayName}[] PROGMEM = {\n`;
                
                for (let i = 0; i < bits.length; i += 8) {
                    const row = bits.slice(i, i + 8).map(b => `0x${b}`).join(', ');
                    code += `  ${row},\n`;
                }
                
                code += `};\n`;
                
                // 添加到当前压缩包帧数组，帧序号从1开始
                currentZipFrames.push({ frame: frameNumber, code: code });
                frameNumber++;
                
                // 更新上一帧数据
                previousFrameData = processedImageData;
            }
            
            // 更新进度
            processedFrames++;
            const progress = Math.round((processedFrames / totalFrames) * 100);
            getElement('progress-bar').style.width = `${progress}%`;
            getElement('progress-text').textContent = `${processedFrames}/${totalFrames} 帧`;
            
            // 检查是否需要打包当前压缩包
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
        // 获取用户设置的文件名
        const fileName = getElement('file-name').value || modeStates.video.fileName;
        const zip = new JSZip();
        
        currentZipFrames.forEach((frameData) => {
            zip.file(`${fileName}_${frameData.frame}.h`, frameData.code);
        });
        
        zip.generateAsync({ type: 'blob' }).then(function(blob) {
            // 将blob添加到allZipBlobs数组，zip序号从1开始
            allZipBlobs.push({ name: `${fileName}_frames_${zipNumber}.zip`, blob: blob });
            callback();
        });
    }
    
    function packageTotalZip() {
        // 获取用户设置的文件名
        const fileName = getElement('file-name').value || modeStates.video.fileName;
        const totalZip = new JSZip();
        let processedZips = 0;
        
        allZipBlobs.forEach((zipData) => {
            // 将blob转换为ArrayBuffer
            const reader = new FileReader();
            reader.onload = function(e) {
                totalZip.file(zipData.name, e.target.result);
                processedZips++;
                
                if (processedZips === allZipBlobs.length) {
                    // 生成总压缩包
                    totalZip.generateAsync({ type: 'blob' }).then(function(totalBlob) {
                        const url = URL.createObjectURL(totalBlob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${fileName}_frames.zip`;
                        a.click();
                        URL.revokeObjectURL(url);
                        
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

// 初始化应用
window.addEventListener('DOMContentLoaded', init);
