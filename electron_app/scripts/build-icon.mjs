import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const source = resolve('build/icon.svg')
const destination = resolve('build/icon.ico')
const svg = await readFile(source)
const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = await Promise.all(sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()))
await mkdir(dirname(destination), { recursive: true })
await writeFile(destination, await pngToIco(pngs))
await writeFile(resolve('build/icon.png'), await sharp(svg).resize(512, 512).png().toBuffer())
