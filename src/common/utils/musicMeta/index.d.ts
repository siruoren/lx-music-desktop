export interface MusicMeta {
  title: string
  artist: string | null
  album: string | null
  APIC: string | null
  lyrics: string | null
}
export function setMeta(filePath: string, meta: MusicMeta, proxy?: { host: string, port: number, type?: 'http' | 'socks5', username?: string, password?: string }): void
