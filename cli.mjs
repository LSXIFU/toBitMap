#!/usr/bin/env node
// toBitMap 命令行：把 script.js 当纯计算核心加载（vm），不做第二份实现。
// 用法：
//   node cli.mjs --self-test
//   node cli.mjs --layouts
//   node cli.mjs --in a.raw --out b.raw --to page_lsb [--from row_msb] [--fps 10]
//   node cli.mjs --in a.raw --c-header out.h --array image_bits [--layout page_lsb] [--frame 0]
//
// 为什么用 vm 而不是把 core 抽成 ESM：页面要能双击 file:// 直接打开，
// ES module 在 file:// 下会被 CORS 拦。script.js 保持普通脚本，node 侧用 vm 加载同一份代码，
// 于是“页面能跑的”和“CLI 能跑的”永远是同一套实现。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'script.js');

function loadCore() {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const sandbox = {
        window: { addEventListener() {} },
        console,
        // node 没有 ImageData：给个最小实现，让自检里「ImageData -> 二值化 -> 布局」那条
        // 也能在同一份代码上跑（真的像素数组布局与浏览器一致：RGBA8 行优先）
        ImageData: class ImageDataStub {
            constructor(width, height) {
                this.width = width;
                this.height = height;
                this.data = new Uint8ClampedArray(width * height * 4);
            }
        },
        // 纯计算路径不该碰 DOM；真碰了就让它在加载阶段就报错，而不是静默拿到 null
    };
    sandbox.window.self = sandbox.window;
    const context = vm.createContext(sandbox);
    vm.runInContext(source, context, { filename: 'script.js' });
    const api = vm.runInContext('toBitMapApi', context);
    if (!api) throw new Error('script.js 里没有 toBitMapApi，检查是否被改坏');
    return api;
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

function readRaw(file) {
    return new Uint8Array(fs.readFileSync(file));
}

// 把 .raw 拆成“权威缓冲帧数组”：先按输入布局解码，之后想输出什么布局都在这层之上重编码
function splitFrames(api, bytes, options) {
    const parsed = api.parseRaw(bytes, { layout: options.from });
    if (parsed.frames < 1) {
        throw new Error(`数据不足：一帧需要 ${parsed.frameSize} 字节，实到 ${bytes.length - 12} 字节`);
    }
    const windows = [];
    for (let index = 0; index < parsed.frames; index++) {
        const start = index * parsed.frameSize;
        const slice = parsed.payload.subarray(start, start + parsed.frameSize);
        windows.push(api.decode(slice, { width: parsed.width, height: parsed.height, layout: parsed.layout }));
    }
    return { parsed, canonicals: windows };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const api = loadCore();

    if (args['self-test'] || args.selfTest) {
        const result = api.selfTest();
        console.log(JSON.stringify(result, null, 2));
        return result.pass ? 0 : 1;
    }

    if (args.layouts) {
        console.log(JSON.stringify(api.layouts(), null, 2));
        return 0;
    }

    if (!args.in) {
        console.error('缺少 --in（.raw 输入）。用 --help 看用法，或 --self-test 先验证核心。');
        return 2;
    }
    if (!fs.existsSync(args.in)) {
        console.error(`找不到输入文件：${args.in}`);
        return 2;
    }

    const inputBytes = readRaw(args.in);
    const { parsed, canonicals } = splitFrames(api, inputBytes, { from: args.from });

    if (args['c-header']) {
        const frameIndex = Math.max(0, Math.min(canonicals.length - 1, Number(args.frame) || 0));
        const layout = args.layout || parsed.layout;
        const bytes = api.encodeCanonical(canonicals[frameIndex], {
            width: parsed.width, height: parsed.height, layout: layout
        });
        const code = api.toCHeader(bytes, {
            width: parsed.width, height: parsed.height, layout: layout,
            arrayName: args.array || 'image_bits',
            widthVar: args.widthVar || 'WIDTH',
            heightVar: args.heightVar || 'HEIGHT'
        });
        fs.writeFileSync(args['c-header'], code + '\n');
        console.log(JSON.stringify({
            out: args['c-header'], layout: layout, width: parsed.width, height: parsed.height,
            bytes: bytes.length, frame: frameIndex, frames: canonicals.length
        }));
        return 0;
    }

    if (!args.out) {
        console.error('缺少 --out（目标 .raw）或 --c-header（目标头文件）');
        return 2;
    }

    const targetLayout = args.to || parsed.layout;
    const frames = canonicals.map(canonical => api.encodeCanonical(canonical, {
        width: parsed.width, height: parsed.height, layout: targetLayout
    }));
    const raw = api.packRaw(frames, {
        width: parsed.width, height: parsed.height,
        layout: targetLayout, fps: args.fps ? Number(args.fps) : parsed.fps
    });
    fs.writeFileSync(args.out, Buffer.from(raw));
    console.log(JSON.stringify({
        out: args.out, from: parsed.layout, to: targetLayout,
        width: parsed.width, height: parsed.height, frames: frames.length,
        frameSize: frames[0].length, bytes: raw.length
    }));
    return 0;
}

process.exitCode = main();
