interface QrVersionInfo {
  version: number
  totalCodewords: number
  eccCodewordsPerBlock: number
  blockCount: number
}

const VERSION_INFOS: QrVersionInfo[] = [
  { version: 1, totalCodewords: 26, eccCodewordsPerBlock: 7, blockCount: 1 },
  { version: 2, totalCodewords: 44, eccCodewordsPerBlock: 10, blockCount: 1 },
  { version: 3, totalCodewords: 70, eccCodewordsPerBlock: 15, blockCount: 1 },
  { version: 4, totalCodewords: 100, eccCodewordsPerBlock: 20, blockCount: 1 },
  { version: 5, totalCodewords: 134, eccCodewordsPerBlock: 26, blockCount: 1 },
  { version: 6, totalCodewords: 172, eccCodewordsPerBlock: 18, blockCount: 2 },
  { version: 7, totalCodewords: 196, eccCodewordsPerBlock: 20, blockCount: 2 },
  { version: 8, totalCodewords: 242, eccCodewordsPerBlock: 24, blockCount: 2 },
  { version: 9, totalCodewords: 292, eccCodewordsPerBlock: 30, blockCount: 2 },
  { version: 10, totalCodewords: 346, eccCodewordsPerBlock: 18, blockCount: 4 },
]

const ALIGNMENT_PATTERN_POSITIONS: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

const FORMAT_ECC_LOW_BITS = 1
const FORMAT_MASK = 0x5412
const FORMAT_POLY = 0x537
const VERSION_POLY = 0x1f25
const BYTE_MODE_BITS = 0x4
const QR_MASK_PATTERN = 0

const { gfExp, gfLog } = createGaloisTables()

export interface QrCodeMatrix {
  size: number
  modules: boolean[][]
}

export function createQrCodeMatrix(text: string): QrCodeMatrix {
  const data = new TextEncoder().encode(text)
  const versionInfo = chooseVersion(data.length)
  const size = versionInfo.version * 4 + 17
  const modules: (boolean | undefined)[][] = Array.from({ length: size }, () => Array.from({ length: size }))
  const functionModules = Array.from({ length: size }, () => Array.from({ length: size }, () => false))

  const setFunctionModule = (x: number, y: number, isDark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) {
      return
    }
    modules[y][x] = isDark
    functionModules[y][x] = true
  }

  drawFunctionPatterns(versionInfo.version, size, setFunctionModule)
  drawFormatBits(size, QR_MASK_PATTERN, setFunctionModule)
  if (versionInfo.version >= 7) {
    drawVersionBits(versionInfo.version, size, setFunctionModule)
  }

  const codewords = createCodewords(data, versionInfo)
  placeCodewords(codewords, modules, functionModules)
  applyMask(modules, functionModules)
  drawFormatBits(size, QR_MASK_PATTERN, setFunctionModule)

  return {
    size,
    modules: modules.map((row) => row.map((module) => module === true)),
  }
}

export function qrCodePath(matrix: QrCodeMatrix) {
  const commands: string[] = []
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.modules[y][x]) {
        commands.push(`M${x},${y}h1v1h-1z`)
      }
    }
  }
  return commands.join('')
}

function chooseVersion(byteLength: number) {
  for (const versionInfo of VERSION_INFOS) {
    const dataCodewordCount = getDataCodewordCount(versionInfo)
    const countBitLength = versionInfo.version < 10 ? 8 : 16
    const requiredBits = 4 + countBitLength + byteLength * 8
    if (requiredBits <= dataCodewordCount * 8) {
      return versionInfo
    }
  }
  throw new Error('QR data is too long')
}

function getDataCodewordCount(versionInfo: QrVersionInfo) {
  return versionInfo.totalCodewords - versionInfo.eccCodewordsPerBlock * versionInfo.blockCount
}

function createCodewords(data: Uint8Array, versionInfo: QrVersionInfo) {
  const dataCodewordCount = getDataCodewordCount(versionInfo)
  const bits: number[] = []
  appendBits(bits, BYTE_MODE_BITS, 4)
  appendBits(bits, data.length, versionInfo.version < 10 ? 8 : 16)
  for (const byte of data) {
    appendBits(bits, byte, 8)
  }

  const capacityBits = dataCodewordCount * 8
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length))
  while (bits.length % 8 !== 0) {
    bits.push(0)
  }

  const dataCodewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    dataCodewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0))
  }

  for (let padByte = 0xec; dataCodewords.length < dataCodewordCount; padByte ^= 0xec ^ 0x11) {
    dataCodewords.push(padByte)
  }

  return addErrorCorrectionAndInterleave(dataCodewords, versionInfo)
}

function appendBits(bits: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1)
  }
}

function addErrorCorrectionAndInterleave(dataCodewords: number[], versionInfo: QrVersionInfo) {
  const blocks = splitIntoBlocks(dataCodewords, versionInfo.blockCount).map((dataBlock) => ({
    data: dataBlock,
    ecc: reedSolomonRemainder(dataBlock, versionInfo.eccCodewordsPerBlock),
  }))

  const result: number[] = []
  const maxDataLength = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < maxDataLength; i++) {
    for (const block of blocks) {
      if (i < block.data.length) {
        result.push(block.data[i])
      }
    }
  }

  for (let i = 0; i < versionInfo.eccCodewordsPerBlock; i++) {
    for (const block of blocks) {
      result.push(block.ecc[i])
    }
  }
  return result
}

function splitIntoBlocks(dataCodewords: number[], blockCount: number) {
  const shortBlockLength = Math.floor(dataCodewords.length / blockCount)
  const longerBlockCount = dataCodewords.length % blockCount
  const shorterBlockCount = blockCount - longerBlockCount
  const blocks: number[][] = []
  let offset = 0

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const blockLength = shortBlockLength + (blockIndex >= shorterBlockCount ? 1 : 0)
    blocks.push(dataCodewords.slice(offset, offset + blockLength))
    offset += blockLength
  }
  return blocks
}

function createGaloisTables() {
  const exp = Array.from({ length: 512 }, () => 0)
  const log = Array.from({ length: 256 }, () => 0)
  let value = 1
  for (let i = 0; i < 255; i++) {
    exp[i] = value
    log[value] = i
    value <<= 1
    if (value & 0x100) {
      value ^= 0x11d
    }
  }
  for (let i = 255; i < exp.length; i++) {
    exp[i] = exp[i - 255]
  }
  return { gfExp: exp, gfLog: log }
}

function gfMultiply(left: number, right: number) {
  return left === 0 || right === 0 ? 0 : gfExp[gfLog[left] + gfLog[right]]
}

function reedSolomonGenerator(degree: number) {
  let coefficients = [1]
  for (let i = 0; i < degree; i++) {
    const next = Array.from({ length: coefficients.length + 1 }, () => 0)
    for (let j = 0; j < coefficients.length; j++) {
      next[j] ^= coefficients[j]
      next[j + 1] ^= gfMultiply(coefficients[j], gfExp[i])
    }
    coefficients = next
  }
  return coefficients
}

function reedSolomonRemainder(data: number[], degree: number) {
  const generator = reedSolomonGenerator(degree)
  const result = Array.from({ length: degree }, () => 0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    for (let i = 0; i < degree; i++) {
      result[i] ^= gfMultiply(generator[i + 1], factor)
    }
  }
  return result
}

function drawFunctionPatterns(version: number, size: number, setFunctionModule: (x: number, y: number, isDark: boolean) => void) {
  drawFinderPattern(3, 3, setFunctionModule)
  drawFinderPattern(size - 4, 3, setFunctionModule)
  drawFinderPattern(3, size - 4, setFunctionModule)

  const alignmentPositions = ALIGNMENT_PATTERN_POSITIONS[version]
  for (const centerY of alignmentPositions) {
    for (const centerX of alignmentPositions) {
      const overlapsFinder =
        (centerX === 6 && centerY === 6) ||
        (centerX === 6 && centerY === size - 7) ||
        (centerX === size - 7 && centerY === 6)
      if (!overlapsFinder) {
        drawAlignmentPattern(centerX, centerY, setFunctionModule)
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    const isDark = i % 2 === 0
    setFunctionModule(i, 6, isDark)
    setFunctionModule(6, i, isDark)
  }
  setFunctionModule(8, size - 8, true)
}

function drawFinderPattern(centerX: number, centerY: number, setFunctionModule: (x: number, y: number, isDark: boolean) => void) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      const isDark = distance !== 2 && distance !== 4
      setFunctionModule(centerX + dx, centerY + dy, isDark)
    }
  }
}

function drawAlignmentPattern(centerX: number, centerY: number, setFunctionModule: (x: number, y: number, isDark: boolean) => void) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      setFunctionModule(centerX + dx, centerY + dy, distance !== 1)
    }
  }
}

function drawFormatBits(size: number, mask: number, setFunctionModule: (x: number, y: number, isDark: boolean) => void) {
  const bits = getFormatBits(mask)
  for (let i = 0; i <= 5; i++) {
    setFunctionModule(8, i, getBit(bits, i))
  }
  setFunctionModule(8, 7, getBit(bits, 6))
  setFunctionModule(8, 8, getBit(bits, 7))
  setFunctionModule(7, 8, getBit(bits, 8))
  for (let i = 9; i < 15; i++) {
    setFunctionModule(14 - i, 8, getBit(bits, i))
  }

  for (let i = 0; i < 8; i++) {
    setFunctionModule(size - 1 - i, 8, getBit(bits, i))
  }
  for (let i = 8; i < 15; i++) {
    setFunctionModule(8, size - 15 + i, getBit(bits, i))
  }
}

function drawVersionBits(version: number, size: number, setFunctionModule: (x: number, y: number, isDark: boolean) => void) {
  const bits = getVersionBits(version)
  for (let i = 0; i < 18; i++) {
    const isDark = getBit(bits, i)
    const x = size - 11 + (i % 3)
    const y = Math.floor(i / 3)
    setFunctionModule(x, y, isDark)
    setFunctionModule(y, x, isDark)
  }
}

function getFormatBits(mask: number) {
  const data = (FORMAT_ECC_LOW_BITS << 3) | mask
  let remainder = data << 10
  for (let i = 14; i >= 10; i--) {
    if (getBit(remainder, i)) {
      remainder ^= FORMAT_POLY << (i - 10)
    }
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ FORMAT_MASK
}

function getVersionBits(version: number) {
  let remainder = version << 12
  for (let i = 17; i >= 12; i--) {
    if (getBit(remainder, i)) {
      remainder ^= VERSION_POLY << (i - 12)
    }
  }
  return (version << 12) | (remainder & 0xfff)
}

function getBit(value: number, index: number) {
  return ((value >>> index) & 1) !== 0
}

function placeCodewords(codewords: number[], modules: (boolean | undefined)[][], functionModules: boolean[][]) {
  const size = modules.length
  let bitIndex = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right--
    }
    for (let vertical = 0; vertical < size; vertical++) {
      const y = upward ? size - 1 - vertical : vertical
      for (let dx = 0; dx < 2; dx++) {
        const x = right - dx
        if (!functionModules[y][x]) {
          const byte = codewords[bitIndex >>> 3]
          modules[y][x] = byte === undefined ? false : getBit(byte, 7 - (bitIndex & 7))
          bitIndex++
        }
      }
    }
    upward = !upward
  }
}

function applyMask(modules: (boolean | undefined)[][], functionModules: boolean[][]) {
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules.length; x++) {
      if (!functionModules[y][x] && modules[y][x] !== undefined && (x + y) % 2 === 0) {
        modules[y][x] = !modules[y][x]
      }
    }
  }
}
