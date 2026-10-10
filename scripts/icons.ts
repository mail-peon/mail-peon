import type { Buffer } from 'node:buffer'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import sharp from 'sharp'
import { log, r } from './utils.mts'

/**
 * 从一张人像源图生成扩展用到的全部图标，直接覆盖现有文件。
 *
 * ```bash
 * pnpm icons                          # 用仓库里的 assets/icon-source.png
 * pnpm icons ./新的头像.png            # 换一张源图（不会覆盖仓库里的源图）
 * ```
 *
 * offer-hunter 的 `scripts/icons.ts` 是「按 alpha 包围盒 trim」，前提是源图**自带透明
 * 背景**。mail-peon 的头像是一张白底不透明图（而且文件后缀与实际格式不符），
 * 所以这里多了两步：**抠白底** 与 **构图裁剪**。
 *
 * 每个尺寸的流水线：
 *  1. `ensureAlpha` + 白底转透明 —— 以四角均值为背景色，按色差走一段软斜坡
 *     （见 `CUTOUT`）。硬阈值会让描边的抗锯齿像素变成一圈白刺，软斜坡保住它。
 *  2. `extract` —— 只留头部与一点肩膀。源图四周留白很多，全图缩到 16px 后
 *     五官会被挤成一团，所以按 `CROP` 裁一块正方形再缩。
 *  3. `resize` —— 等比缩进 `size × (1 - 2×PAD)` 的方框，非等比那边自动留白。
 *  4. `extend` —— 补透明边到 `size × size`，让图形不贴边（贴边的图标在工具栏里显得过大）。
 *
 * 产物：`extension/assets/icon-{16,32,48,128,512}.png`。这些是静态文件、不参与构建，
 * 所以改完图标不必重新 build，但 manifest 里的 `icons` 只有 manifest.ts 改了才生效。
 *
 * ⚠ 换源图时 `CROP` 基本一定要重调 —— 它是对着当前这张头像量出来的，不是通用参数。
 */

/** 需要的尺寸。16/32/48 是浏览器工具栏与扩展管理页，128 是商店详情页，512 是 README 与 action 图标 */
const SIZES = [16, 32, 48, 128, 512]

/** 四周留白比例（占单边尺寸） */
const PAD_RATIO = 0.06

/** 默认源图（人像原图，入库以方便重新生成） */
const DEFAULT_SOURCE = 'assets/icon-source.png'

/**
 * 裁剪框（源图像素坐标，正方形）。源图 1536×1536，内容在 x[154,1402] / y[249,1350]，
 * 其中 x>1273 那一块是搭在下巴上的手。这里裁到「整颗头 + 一只耳朵 + 一点肩膀」：
 * 再大就把手也框进来、小图里认不出脸；再小就把左耳的尖端切掉。
 */
const CROP = { left: 205, top: 239, size: 1140 }

/**
 * 抠白底的色差区间（相对四角背景色，取三通道最大差）。
 * `<= NEAR` 全透明，`>= FAR` 全保留，中间线性过渡。
 */
const CUTOUT = { near: 6, far: 40 }

/** 全透明，用于 resize / extend 的留白 */
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

/**
 * 把白底换成透明。判定只认「接近背景色」，所以图形内部的白色（眼白、獠牙）
 * 不会被误伤 —— 它们被黑色描边包着，色差远超 `FAR`。
 */
async function cutoutBackground(source: string): Promise<Buffer> {
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  const at = (x: number, y: number) => (y * width + x) * channels

  // 背景色 = 四角均值（人像图的角落一定是背景）
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
  let br = 0
  let bg = 0
  let bb = 0
  for (const [x, y] of corners) {
    const i = at(x, y)
    br += data[i]
    bg += data[i + 1]
    bb += data[i + 2]
  }
  br /= corners.length
  bg /= corners.length
  bb /= corners.length

  const span = CUTOUT.far - CUTOUT.near
  for (let i = 0; i < width * height; i++) {
    const o = i * channels
    const diff = Math.max(
      Math.abs(data[o] - br),
      Math.abs(data[o + 1] - bg),
      Math.abs(data[o + 2] - bb),
    )
    const alpha = diff <= CUTOUT.near
      ? 0
      : diff >= CUTOUT.far
        ? 255
        : Math.round(((diff - CUTOUT.near) / span) * 255)
    if (alpha < data[o + 3])
      data[o + 3] = alpha
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer()
}

async function renderIcon(cut: Buffer, size: number): Promise<Buffer> {
  const pad = Math.max(1, Math.round(size * PAD_RATIO))
  const inner = size - pad * 2

  return sharp(cut)
    .resize(inner, inner, {
      fit: 'contain',
      kernel: 'lanczos3',
      background: TRANSPARENT,
    })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: TRANSPARENT })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

async function main() {
  const input = process.argv[2] ?? DEFAULT_SOURCE
  const source = resolve(r(), input)
  try {
    await access(source)
  }
  catch {
    console.error(`找不到源图：${source}`)
    process.exit(1)
  }

  const meta = await sharp(source).metadata()
  log('ICON', `源图 ${relative(r(), source)} · ${meta.width}x${meta.height} · ${meta.format}`)

  const crop = { left: CROP.left, top: CROP.top, width: CROP.size, height: CROP.size }
  if (meta.width && meta.height && (crop.left + crop.width > meta.width || crop.top + crop.height > meta.height)) {
    console.error(`裁剪框超出源图：源图 ${meta.width}x${meta.height}，裁剪 ${JSON.stringify(crop)}`)
    process.exit(1)
  }
  if (!meta.hasAlpha)
    log('ICON', '源图没有 alpha 通道 → 按四角背景色抠底（纯色背景图适用）')

  // 抠底 + 裁剪只做一次，后面每个尺寸都在同一张中间图上缩
  const cut = await sharp(await cutoutBackground(source))
    .extract(crop)
    .png()
    .toBuffer()

  for (const size of SIZES) {
    const path = r(`extension/assets/icon-${size}.png`)
    const buffer = await renderIcon(cut, size)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, buffer)
    log('ICON', `${relative(r(), path)}  ${size}×${size}  ${(buffer.length / 1024).toFixed(1)} KB`)
  }

  log('ICON', '完成。图标是静态文件、不参与构建；manifest 的 icons 字段改动需重跑 build:prepare')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
