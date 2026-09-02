import { sha256 as jsSha256 } from 'js-sha256'

const hasSubtle = typeof crypto !== 'undefined' && crypto.subtle

export async function sha256Hex(input) {
  if (hasSubtle) {
    const buf = input instanceof ArrayBuffer ? input : await input.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }
  const buf = input instanceof ArrayBuffer ? input : await input.arrayBuffer()
  return jsSha256(new Uint8Array(buf))
}
